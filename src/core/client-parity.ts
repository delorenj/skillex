import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { diagnosticExit, inspectStatus } from "./diagnostics.js";
import { type EffectiveBinding, resolveEffectiveSelection } from "./effective-selection.js";
import { SkillexError } from "./error.js";
import { parseSkillMetadata } from "./metadata.js";
import { discoverProfile } from "./profile-discovery.js";
import type { ProfileOptions } from "./profile-types.js";
import { showProfile } from "./profiles.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";

export type ClientName = "claude" | "codex" | "kimi" | "hermes";
export type KimiDialect = "code-2.1" | "python-1.47";
export interface ClientParityOptions extends ProfileOptions {
  readonly project: string;
  readonly profile: string;
  /** Explicit evidence model, not an auto-detected installed binary version. */
  readonly kimiDialect?: KimiDialect;
}
export interface ClientParityCandidate {
  readonly directoryName: string;
  readonly advertisedName: string | null;
  readonly lookupNames: readonly string[];
  readonly path: string;
  readonly target: string;
}
export interface ClientParityObservation {
  readonly client: ClientName;
  readonly filesystem: "matched" | "drift" | "blocked";
  readonly quarantine: "unknown" | "not-applicable";
  readonly roots: readonly string[];
  readonly missing: readonly string[];
  readonly unreachable: readonly string[];
  readonly foreign: readonly { name: string; path: string }[];
  /** Conservative canonical-path conflicts, NOT a native winner/refusal verdict. */
  readonly canonicalConflicts: readonly string[];
  readonly metadataIssues: readonly { path: string; reason: string }[];
  /** Hermes catalog can disagree with lookup for identical per-skill symlinks. */
  readonly indexLookupDisagreements: readonly string[];
  readonly candidates: readonly ClientParityCandidate[];
  readonly limitations: readonly string[];
}
export interface ClientParityResult {
  readonly project: string;
  readonly profile: string;
  readonly runtime: "unverified";
  readonly expected: readonly EffectiveBinding[];
  readonly consumers: readonly ClientParityObservation[];
}

type RootScan = {
  readonly root: string;
  readonly project: boolean;
  readonly candidates: ClientParityCandidate[];
  readonly unreachable: string[];
  readonly foreign: { name: string; path: string }[];
  readonly metadataIssues: { path: string; reason: string }[];
};

function failure(error: unknown): ResultEnvelope<null> {
  return error instanceof SkillexError
    ? makeResult("clients.parity", null, { exit: error.exit, findings: error.findings })
    : makeResult("clients.parity", null, {
        exit: ExitCode.FAILURE,
        findings: [
          {
            code: "E_IO",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
            fix: "Check the named project, profile and client roots, then retry read-only inspection.",
          },
        ],
      });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return false;
    throw error;
  }
}

/** Read only direct directory-form definitions. This is not a native recursive resolver. */
async function scanRoot(
  root: string,
  client: ClientName,
  kimiDialect: KimiDialect,
  project = false,
): Promise<RootScan> {
  const scan: RootScan = {
    root,
    project,
    candidates: [],
    unreachable: [],
    foreign: [],
    metadataIssues: [],
  };
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return scan;
    throw error;
  }
  for (const directoryName of entries.sort()) {
    const path = join(root, directoryName);
    if (directoryName.startsWith(".") && directoryName !== ".system") continue;
    let target: string;
    try {
      target = await realpath(path);
    } catch (error) {
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        scan.unreachable.push(path);
        continue;
      }
      throw error;
    }
    if (!(await lstat(target)).isDirectory()) {
      scan.foreign.push({ name: directoryName, path });
      continue;
    }
    let text: string;
    try {
      text = await readFile(join(target, "SKILL.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        scan.foreign.push({ name: directoryName, path });
        continue;
      }
      throw error;
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = parseSkillMetadata(text, join(target, "SKILL.md"));
    } catch {
      // Native malformed-YAML fallbacks differ. Do not certify any of them here.
      scan.unreachable.push(join(target, "SKILL.md"));
      scan.metadataIssues.push({
        path,
        reason: "Metadata is outside the audit's supported YAML subset.",
      });
      continue;
    }
    const declared = typeof metadata.name === "string" ? metadata.name : undefined;
    let advertisedName: string | null;
    // These are metadata rules only, not a shared precedence/winner algorithm.
    switch (client) {
      case "claude":
        advertisedName = declared || directoryName;
        break;
      case "hermes":
        advertisedName = declared ?? directoryName;
        break;
      case "kimi":
        advertisedName =
          kimiDialect === "python-1.47" ? declared || directoryName : declared?.trim() || null;
        break;
      case "codex":
        advertisedName = declared?.trim() || null;
        break;
    }
    const requiresMetadata =
      client === "codex" || (client === "kimi" && kimiDialect === "code-2.1");
    const hasDescription =
      typeof metadata.description === "string" && !!metadata.description.trim();
    const accepted = !requiresMetadata || (!!advertisedName && hasDescription);
    if (!accepted)
      scan.metadataIssues.push({
        path,
        reason:
          "Directory-form skills require explicit nonempty name and description in this client model.",
      });
    if (advertisedName !== null && advertisedName !== directoryName)
      scan.metadataIssues.push({
        path,
        reason: `Directory name ${directoryName} differs from advertised name ${advertisedName}.`,
      });
    const lookupNames =
      accepted && advertisedName
        ? [...new Set(client === "hermes" ? [directoryName, advertisedName] : [advertisedName])]
        : [];
    scan.candidates.push({ directoryName, advertisedName, lookupNames, path, target });
  }
  return scan;
}

async function scanRoots(
  roots: readonly string[],
  client: ClientName,
  dialect: KimiDialect,
): Promise<RootScan[]> {
  return Promise.all(roots.map((root) => scanRoot(root, client, dialect)));
}

/** Compare canonical evidence only; intentionally do not simulate native name winners. */
function observe(
  client: ClientName,
  scans: readonly RootScan[],
  expected: ReadonlyMap<string, string>,
  limitations: string[] = [],
): ClientParityObservation {
  const missing: string[] = [];
  const unreachable = scans.flatMap((scan) => scan.unreachable);
  const foreign = scans.flatMap((scan) => scan.foreign);
  const metadataIssues = scans.flatMap((scan) => scan.metadataIssues);
  const candidates = scans.flatMap((scan) => scan.candidates);
  const canonicalConflicts: string[] = [];
  const indexLookupDisagreements: string[] = [];
  for (const [name, target] of expected) {
    const entries = candidates.filter((candidate) => candidate.lookupNames.includes(name));
    // Membership is the canonical directory/target, not equality with a
    // frontmatter alias. A valid alias can advertise and look up under another
    // name; metadataIssues records the naming drift independently.
    if (
      !candidates.some(
        (candidate) =>
          candidate.directoryName === name &&
          candidate.target === target &&
          candidate.lookupNames.length > 0,
      )
    )
      missing.push(name);
    if (
      entries.some((candidate) => candidate.target !== target) ||
      foreign.some((entry) => entry.name === name)
    )
      canonicalConflicts.push(name);
    if (client === "hermes") {
      const projectEntries = scans
        .filter((scan) => scan.project)
        .flatMap((scan) =>
          scan.candidates.filter((candidate) => candidate.lookupNames.includes(name)),
        );
      // Root aliases have already been deduplicated. Different roots containing
      // links to the same file are still distinct in resolve_skill_catalog, but
      // _collect_skill_candidates deduplicates that resolved SKILL.md on lookup.
      if (
        projectEntries.length > 1 &&
        new Set(projectEntries.map((candidate) => candidate.target)).size === 1
      )
        indexLookupDisagreements.push(name);
    }
  }
  for (const candidate of candidates)
    if (expected.get(candidate.directoryName) !== candidate.target)
      foreign.push({ name: candidate.directoryName, path: candidate.path });
  if (indexLookupDisagreements.length)
    limitations.push(
      "Hermes index-vs-lookup inconsistency: distinct project roots link to the same SKILL.md. Catalog can label ambiguous while lookup deduplicates; no native refusal is asserted.",
    );
  const blocked =
    client === "hermes" &&
    limitations.some(
      (text) =>
        text.includes("not converged") ||
        text.includes("not a real directory") ||
        text.includes("unverified configuration"),
    );
  return {
    client,
    quarantine: client === "hermes" ? "unknown" : "not-applicable",
    filesystem: blocked
      ? "blocked"
      : missing.length ||
          unreachable.length ||
          canonicalConflicts.length ||
          metadataIssues.length ||
          foreign.length ||
          indexLookupDisagreements.length
        ? "drift"
        : "matched",
    roots: scans.map(({ root }) => root),
    missing,
    unreachable,
    foreign,
    canonicalConflicts,
    metadataIssues,
    indexLookupDisagreements,
    candidates,
    limitations,
  };
}

async function trustedProjects(
  config: string,
  project: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ trusted: boolean; limitations: string[] }> {
  if (!config) return { trusted: false, limitations: [] };
  try {
    const doc = parseDocument(config, { uniqueKeys: true });
    if (doc.errors.length) throw new Error("Malformed Hermes profile config");
    const skills: unknown = doc.toJS()?.skills;
    if (
      skills !== undefined &&
      (typeof skills !== "object" || skills === null || Array.isArray(skills))
    )
      throw new Error("Malformed skills config");
    const fields = skills as Record<string, unknown> | undefined;
    const trust = fields?.trusted_project_dirs;
    if (
      trust !== undefined &&
      (!Array.isArray(trust) || trust.some((item) => typeof item !== "string"))
    )
      throw new Error("Malformed trusted_project_dirs");
    const projectIdentity = await realpath(project);
    const identities = await Promise.all(
      ((trust as string[] | undefined) ?? []).map(async (path) => {
        // Hermes uses expandvars before expanduser. Unknown variables remain
        // literal there; they cannot be trusted accidentally in this audit.
        const withVars = path.replace(
          /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g,
          (match, key: string) => {
            const name = key.startsWith("{") ? key.slice(1, -1) : key;
            return Object.hasOwn(env, name) ? (env[name] ?? match) : match;
          },
        );
        const expanded = withVars === "~" ? home : withVars.replace(/^~(?=\/)/, home);
        return realpath(resolve(expanded)).catch(() => null);
      }),
    );
    const trusted = fields?.project_discovery !== false && identities.includes(projectIdentity);
    const limitations: string[] = [];
    if (fields?.create_dir || (Array.isArray(fields?.external_dirs) && fields.external_dirs.length))
      limitations.push(
        "Additional Hermes discovery routes are configured; no runtime match can be inferred.",
      );
    if (fields?.disabled) limitations.push("Hermes skills.disabled can suppress selected names.");
    return { trusted, limitations };
  } catch {
    return {
      trusted: false,
      limitations: [
        "Hermes has unverified configuration; project trust and extra roots cannot be established.",
      ],
    };
  }
}

/** Hermes resolves project roots before whole-root dedup; the local root remains real. */
async function hermesProjectRoots(project: string, profileRoot: string): Promise<string[]> {
  const local = await realpath(profileRoot).catch(() => profileRoot);
  const roots = new Set<string>();
  for (const segment of [".hermes/skills", ".agents/skills"]) {
    const path = join(project, segment);
    if (!(await isDirectory(path))) continue;
    const canonical = await realpath(path);
    if (canonical !== local) roots.add(canonical);
  }
  return [...roots];
}

/** Version-bounded root evidence, never an installed-client/config probe. */
async function kimiRoots(project: string, home: string, dialect: KimiDialect): Promise<string[]> {
  const roots: string[] = [];
  if (dialect === "code-2.1") {
    const seen = new Set<string>();
    for (const base of [project, home])
      for (const segment of [".kimi-code/skills", ".agents/skills"]) {
        const root = join(base, segment);
        if (!(await isDirectory(root))) continue;
        const identity = await realpath(root);
        if (!seen.has(identity)) {
          roots.push(identity);
          seen.add(identity);
        }
      }
  } else {
    for (const base of [project, home]) {
      for (const segment of [".kimi/skills", ".claude/skills", ".codex/skills"])
        if (await isDirectory(join(base, segment))) roots.push(join(base, segment));
      // The preferred .config root is a USER-only rule. A file or dangling
      // symlink is not an existing directory and must not hide .agents.
      const preferred = join(base, ".config/agents/skills");
      roots.push(
        base === home && (await isDirectory(preferred)) ? preferred : join(base, ".agents/skills"),
      );
    }
  }
  return roots;
}

/** Read-only projection audit. A filesystem match is not a runtime security-scan or session result. */
export async function inspectClientParity(
  options: ClientParityOptions,
): Promise<ResultEnvelope<ClientParityResult | null>> {
  try {
    if (!options.project || !options.profile)
      return makeResult("clients.parity", null, {
        exit: ExitCode.CONFIG,
        findings: [
          {
            code: "E_CLIENT_PARITY_OPTIONS",
            severity: "error",
            message: "Specify --project and --profile for a bounded parity audit.",
          },
        ],
      });
    const dialect = options.kimiDialect ?? "code-2.1";
    if (!["code-2.1", "python-1.47"].includes(dialect)) {
      return makeResult("clients.parity", null, {
        exit: ExitCode.CONFIG,
        findings: [
          {
            code: "E_CLIENT_PARITY_OPTIONS",
            severity: "error",
            message:
              "Choose --kimi-dialect code-2.1 or python-1.47; this audit does not auto-detect an installed binary.",
          },
        ],
      });
    }
    const selection = await resolveEffectiveSelection(options);
    if (!selection.data || !selection.ok) return makeResult("clients.parity", null, selection);
    const status = await inspectStatus({ ...options, scope: "both" });
    const profile = await discoverProfile(options.profile, options);
    const shown = await showProfile(options.profile, options);
    const global = selection.data.scopes.find((scope) => scope.scope === "global");
    const project = selection.data.scopes.find((scope) => scope.scope === "project");
    if (!global || !project) throw new Error("Effective scope discovery lost a scope.");
    const home = global.root;
    const expected = new Map(
      selection.data.bindings.map((binding) => [binding.name, binding.path]),
    );
    const findings: Diagnostic[] = [...selection.findings];
    const consumers: ClientParityObservation[] = [];
    const add = (consumer: ClientParityObservation) => {
      consumers.push(consumer);
      if (
        consumer.filesystem !== "matched" ||
        consumer.foreign.length ||
        consumer.limitations.some((text) => text.includes("unverified"))
      )
        findings.push({
          code: "W_CLIENT_PARITY",
          severity: "warning",
          message: `${consumer.client} has incomplete filesystem parity evidence.`,
          detail: [
            `missing: ${consumer.missing.length}`,
            `unreachable: ${consumer.unreachable.length}`,
            `foreign: ${consumer.foreign.length}`,
            `canonical conflicts: ${consumer.canonicalConflicts.length}`,
          ],
        });
    };
    // Claude documents enterprise > personal > project. No winner is inferred here.
    add(
      observe(
        "claude",
        await scanRoots(
          [join(home, ".claude/skills"), join(project.root, ".claude/skills")],
          "claude",
          dialect,
        ),
        expected,
        [
          "Plugin, synced, system and parent-directory skills may add names outside the two inspected roots.",
        ],
      ),
    );
    add(
      observe(
        "codex",
        await scanRoots(
          [join(project.root, ".agents/skills"), join(home, ".agents/skills")],
          "codex",
          dialect,
        ),
        expected,
        [
          "Codex can list both same-name skills; canonical conflicts here do not mean native ambiguity. Nested .agents, admin, system and disabled-skill config were not evaluated.",
        ],
      ),
    );
    const roots = await kimiRoots(project.root, home, dialect);
    add(
      observe("kimi", await scanRoots(roots, "kimi", dialect), expected, [
        `Kimi evidence model: ${dialect}; not an installed binary or native winner verification.`,
        "KIMI_CODE_HOME, merge_all_available_skills, extra_skill_dirs, --skills-dir, built-ins and config were not evaluated.",
      ]),
    );
    const configPath = join(profile.root, "config.yaml");
    const config = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const trust = await trustedProjects(config, project.root, home, options.env ?? process.env);
    const projectRoots = trust.trusted
      ? await hermesProjectRoots(project.root, profile.skillsRoot)
      : [];
    const hermesScans = await Promise.all([
      ...projectRoots.map((root) => scanRoot(root, "hermes", dialect, true)),
      scanRoot(profile.skillsRoot, "hermes", dialect),
    ]);
    const hermesLimitations = [
      ...trust.limitations,
      "Hermes trusted-project precedence, disabled names and dangerous-skill quarantine require a fresh-session skill_view; a prompt index alone is not proof.",
    ];
    if (!config && !(await exists(configPath)))
      hermesLimitations.push(
        "Hermes profile config is absent; trust and extra discovery policy is unverified.",
      );
    if (shown.exit !== 0 || !shown.data || shown.data.changes.length)
      hermesLimitations.push(
        "Strict receipt, ownership or selection is not converged; inspect profile show.",
      );
    for (const marker of [".skillex-only", ".no-bundled-skills"]) {
      const path = join(profile.root, marker);
      const found = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!found?.isFile())
        hermesLimitations.push(
          `Strict policy marker ${marker} is absent or not a regular file; strict ownership is not converged.`,
        );
    }
    if (shown.data?.profile.skills?.kind !== "directory")
      hermesLimitations.push("Hermes profile skills root is not a real directory.");
    if (shown.data?.preserved.some((entry) => !entry.name.startsWith(".")))
      hermesLimitations.push("Unowned profile entries are preserved, not adopted.");
    if (shown.data?.preserved.some((entry) => entry.name === ".hub"))
      hermesLimitations.push("Unowned .hub content blocks strict activation.");
    add(observe("hermes", hermesScans, expected, hermesLimitations));
    if (status.exit !== 0)
      findings.push(...status.findings, {
        code: "W_CLIENT_ACTIVATION",
        severity: "warning",
        message:
          "Canonical activation status is not converged; inspect skillex status --scope both.",
      });
    findings.push({
      code: "W_CLIENT_RUNTIME_UNVERIFIED",
      severity: "warning",
      message:
        "Filesystem inspection cannot prove a fresh client session advertised or loaded these skills. Security quarantine, trust and client settings need runtime proof.",
    });
    const drift = consumers.some(
      (consumer) =>
        consumer.filesystem !== "matched" ||
        consumer.foreign.length > 0 ||
        consumer.limitations.some((text) => text.includes("unverified")),
    );
    const exit = diagnosticExit([status.exit, shown.exit], drift);
    return makeResult(
      "clients.parity",
      {
        project: selection.data.project,
        profile: profile.name,
        runtime: "unverified",
        expected: selection.data.bindings,
        consumers,
      },
      { findings, exit: exit === ExitCode.SUCCESS ? ExitCode.PARTIAL : exit },
    );
  } catch (error) {
    return failure(error);
  }
}
