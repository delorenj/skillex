import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { type Entry, entry, matches, validateData } from "./activation-ownership.js";
import { readActivationReceipt } from "./activation-state.js";
import type { ActivationData, EntryIdentity } from "./activation-types.js";
import { aliasPaths } from "./aliases.js";
import { canonicalSkill, setMembers } from "./composition.js";
import type {
  AliasObservation,
  DiagnosticOptions,
  ExplainResult,
  PathObservation,
  ReceiptObservation,
  SkillExplanation,
  SkillObservation,
  StatusResult,
  StatusScope,
} from "./diagnostics-types.js";
import { discoverRegistry, discoverScopes } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { parseManifest, readManifest } from "./manifest.js";
import { planSync } from "./reconciliation.js";
import { resolveSelection } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type {
  RegistrySelection,
  ResolvedScope,
  ScopeLocation,
  ScopeName,
  SkillOrigin,
  SkillsManifest,
} from "./selection.js";

/** Internal shared exit precedence for read-only diagnostics. */
export function diagnosticExit(exits: readonly ExitCode[], drift = false): ExitCode {
  for (const code of [
    ExitCode.INTERRUPTED,
    ExitCode.FAILURE,
    ExitCode.CONFIG,
    ExitCode.REFUSED,
    ExitCode.PARTIAL,
    ExitCode.LOCK_BUSY,
  ])
    if (exits.includes(code)) return code;
  return drift || exits.includes(ExitCode.DRIFT) ? ExitCode.DRIFT : ExitCode.SUCCESS;
}

interface Report {
  readonly findings: Diagnostic[];
  readonly exits: ExitCode[];
}
interface ScopeContext {
  readonly location: ScopeLocation;
  readonly resolved: ResolvedScope | undefined;
  readonly manifest: SkillsManifest | null;
  readonly registry: RegistrySelection | null;
  readonly status: StatusScope;
}
interface Inspection {
  readonly data: StatusResult;
  readonly contexts: readonly ScopeContext[];
  readonly report: Report;
}

function cancelled(options: DiagnosticOptions): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Diagnostic inspection was interrupted.",
      {
        fix: "Rerun the read-only command when ready; no changes were made.",
      },
      ExitCode.INTERRUPTED,
    );
}

function collect(
  report: Report,
  result: { exit: ExitCode; findings: readonly Diagnostic[] },
): void {
  report.exits.push(result.exit);
  report.findings.push(...result.findings);
}

function collectError(report: Report, error: unknown, path?: string, scope?: ScopeName): void {
  const findings: readonly Diagnostic[] =
    error instanceof SkillexError
      ? error.findings
      : [
          {
            code: "E_IO",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
            fix: "Check the named path and filesystem permissions, then retry this read-only inspection.",
          },
        ];
  collect(report, {
    exit: error instanceof SkillexError ? error.exit : ExitCode.FAILURE,
    findings: findings.map((finding) => ({
      ...finding,
      ...(path === undefined ? {} : { path: finding.path ?? path }),
      ...(scope === undefined ? {} : { scope: finding.scope ?? scope }),
    })),
  });
}

function uniqueFindings(findings: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify([finding.code, finding.path, finding.scope, finding.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failed<T>(command: string, error: unknown): ResultEnvelope<T | null> {
  const report: Report = { findings: [], exits: [] };
  collectError(report, error);
  return makeResult(command, null, {
    exit: diagnosticExit(report.exits),
    findings: report.findings,
  });
}

function expand(value: string, cwd: string, home: string): string {
  return resolve(
    cwd,
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}

/** Failed discovery still permits observation of identifiable roots, never resolution of new intent. */
async function locationsForInspection(
  options: DiagnosticOptions,
  report: Report,
): Promise<ScopeLocation[]> {
  try {
    const found = await discoverScopes(options);
    return [found.global, ...(found.project ? [found.project] : [])].filter((location) =>
      found.writeScopes.includes(location.scope),
    );
  } catch (error) {
    collectError(report, error);
  }
  if (options.scope !== undefined && !["auto", "global", "project", "both"].includes(options.scope))
    return [];
  const found: ScopeLocation[] = [];
  let home: string;
  try {
    const global = (await discoverScopes({ ...options, scope: "global" })).global;
    home = global.root;
    if (options.scope !== "project") found.push(global);
  } catch {
    return found;
  }
  if (options.scope === "global") return found;
  try {
    let current = await realpath(expand(options.cwd ?? process.cwd(), process.cwd(), home));
    if (options.project !== undefined)
      current = await realpath(expand(options.project, current, home));
    while (current !== home && current !== parse(current).root) {
      const path = join(current, ".agents", "skills.json");
      const manifest = await entry(path);
      const boundary = options.project !== undefined || (await entry(join(current, ".git")));
      if (
        manifest ||
        (boundary &&
          (options.project !== undefined ||
            options.scope === "project" ||
            options.scope === "both"))
      ) {
        found.push({ scope: "project", root: current, path, exists: manifest !== undefined });
        break;
      }
      if (boundary) break;
      current = dirname(current);
    }
  } catch (error) {
    collectError(report, error, options.project ?? options.cwd, "project");
  }
  return found;
}

async function readObserved(
  path: string,
  report: Report,
  scope: ScopeName,
  expected: readonly EntryIdentity[] = [],
): Promise<{ observation: PathObservation; found?: Entry }> {
  let found: Entry | undefined;
  try {
    found = await entry(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR")
      return {
        observation: {
          path,
          kind: "missing",
          rawTarget: null,
          target: null,
          reachable: false,
          ownership: "none",
        },
      };
    const issue =
      code === "ELOOP"
        ? new SkillexError(ExitCode.REFUSED, [
            {
              code: "E_ACTIVATION_RECURSIVE",
              severity: "error",
              path,
              scope,
              message: "This activation path traverses a symbolic-link cycle.",
              fix: "Inspect and repair the recursive link before syncing; preserve unrelated entries.",
            },
          ])
        : error;
    collectError(report, issue, path, scope);
    return {
      observation: {
        path,
        kind: "unreadable",
        rawTarget: null,
        target: null,
        reachable: false,
        ownership: "none",
      },
    };
  }
  if (!found)
    return {
      observation: {
        path,
        kind: "missing",
        rawTarget: null,
        target: null,
        reachable: false,
        ownership: "none",
      },
    };
  const kind = found.info.isSymbolicLink()
    ? "link"
    : found.info.isDirectory()
      ? "directory"
      : found.info.isFile()
        ? "file"
        : "other";
  let target: string | null = null;
  try {
    target = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP")
      collectError(
        report,
        new SkillexError(ExitCode.REFUSED, [
          {
            code: "E_ACTIVATION_RECURSIVE",
            severity: "error",
            message: "This activation path contains a symbolic-link cycle.",
            path,
            scope,
            fix: "Inspect and repair the recursive link before syncing; preserve unrelated entries.",
          },
        ]),
      );
    else if (code !== "ENOENT" && code !== "ENOTDIR") collectError(report, error, path, scope);
  }
  const ownership = expected.some((identity) => matches(found, identity))
    ? "owned"
    : expected.length
      ? "changed"
      : "foreign";
  if (ownership === "changed")
    collectError(
      report,
      new SkillexError(ExitCode.REFUSED, [
        {
          code: "E_OWNERSHIP_CHANGED",
          severity: "error",
          message: "The current entry differs from its recorded ownership identity.",
          path,
          scope,
          fix: "Preserve the current content and inspect the receipt; restore the exact recorded entry or migrate ownership explicitly before syncing.",
        },
      ]),
    );
  return {
    found,
    observation: {
      path,
      kind,
      rawTarget: found.raw ?? null,
      target,
      reachable: target !== null,
      ownership,
    },
  };
}

function identities(
  data: ActivationData | null,
  path: string,
  root: string,
  rootEntry?: Entry,
): EntryIdentity[] {
  if (!data) return [];
  const pending = data.pending;
  if (pending?.path === root && pending.next && matches(rootEntry, pending.next.identity)) {
    if (path === root) return [pending.next.identity];
    if (dirname(path) === root) {
      const child = pending.next.children?.[path.slice(root.length + 1)];
      return child ? [child] : [];
    }
  }
  // Ownership of a root symlink never grants ownership of its target's children.
  if (dirname(path) === root && rootEntry?.info.isSymbolicLink()) return [];
  const identity = data.links[path] ?? data.directories[path];
  const next = pending?.path === path ? pending.next?.identity : undefined;
  return [...(identity ? [identity] : []), ...(next ? [next] : [])];
}

/** Follow every alias path component, stopping at the stable activation root itself. */
async function anchoredAlias(path: string, root: string): Promise<boolean> {
  let target = resolve(path);
  const seen = new Set<string>();
  for (let hop = 0; hop < 40; hop += 1) {
    if (target === root) return true;
    if (seen.has(target)) break;
    seen.add(target);
    let current = parse(target).root;
    const parts = target.slice(current.length).split(sep).filter(Boolean);
    let followed = false;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index] ?? "");
      if (current === root) return index === parts.length - 1;
      const found = await entry(current);
      if (!found) return false;
      if (found.info.isSymbolicLink()) {
        target = resolve(dirname(current), found.raw ?? "", ...parts.slice(index + 1));
        followed = true;
        break;
      }
    }
    if (!followed) return false;
  }
  fail(
    "E_ACTIVATION_RECURSIVE",
    "The CLI alias contains a cycle or exceeds the link traversal limit.",
    {
      path,
      fix: "Repair the alias chain so it ends at this scope's .agents/skills root before syncing.",
    },
    ExitCode.REFUSED,
  );
}

async function observeScope(
  location: ScopeLocation,
  resolved: ResolvedScope | undefined,
  manifest: SkillsManifest | null,
  options: DiagnosticOptions,
  forbiddenRoots: readonly string[],
  report: Report,
): Promise<StatusScope> {
  const root = join(location.root, ".agents", "skills");
  const aliases = aliasPaths(location.root, location.scope);
  let data: ActivationData | null = null;
  let receipt: ReceiptObservation = { path: null, state: "invalid", pending: null };
  try {
    const snapshot = await readActivationReceipt(location.root, { ...options, forbiddenRoots });
    receipt = {
      path: snapshot.path,
      state: snapshot.document ? "valid" : "missing",
      pending: null,
    };
    if (snapshot.document) {
      data = validateData(snapshot.document.data, root, aliases, snapshot.path);
      if (data.pending) {
        const { path, stage, parked } = data.pending;
        receipt = { path: snapshot.path, state: "pending", pending: { path, stage, parked } };
        report.findings.push({
          code: "W_RECOVERY_PENDING",
          severity: "warning",
          scope: location.scope,
          path: snapshot.path,
          message: "An interrupted activation has a pending ownership journal.",
          fix: "Run sync for this scope to verify the recorded identities, recover safely, and reread current intent.",
        });
      }
    }
  } catch (error) {
    receipt = { ...receipt, state: "invalid" };
    collectError(report, error, receipt.path ?? location.root, location.scope);
  }
  const first = await readObserved(root, report, location.scope);
  const rootClaims = identities(data, root, root, first.found);
  const observedRoot = rootClaims.length
    ? await readObserved(root, report, location.scope, rootClaims)
    : first;
  const rootConflict = () =>
    collectError(
      report,
      new SkillexError(ExitCode.REFUSED, [
        {
          code: "E_ACTIVATION_CONFLICT",
          severity: "error",
          scope: location.scope,
          path: root,
          message:
            "The activation root must be a skills directory or a link to one; it collides with other content.",
          fix: "Inspect and preserve the named content, then restore a directory-compatible activation root before syncing.",
        },
      ]),
    );
  if (["file", "other"].includes(observedRoot.observation.kind)) rootConflict();
  const entries: SkillObservation[] = [];
  if (
    observedRoot.observation.reachable &&
    ["directory", "link"].includes(observedRoot.observation.kind)
  ) {
    try {
      const names = (await readdir(root)).sort();
      for (const name of names) {
        cancelled(options);
        const path = join(root, name);
        const observed = (
          await readObserved(
            path,
            report,
            location.scope,
            identities(data, path, root, observedRoot.found),
          )
        ).observation;
        const binding = resolved?.bindings.find((binding) => binding.name === name);
        const packMember =
          resolved?.mode === "pack" &&
          resolved.pack?.skillsRoot === observedRoot.observation.target &&
          binding?.path === observed.target;
        entries.push({ ...observed, name, ...(packMember ? { ownership: "pack" as const } : {}) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") rootConflict();
      else collectError(report, error, root, location.scope);
    }
  }
  const observedAliases: AliasObservation[] = [];
  for (const path of aliases) {
    cancelled(options);
    const observed = (
      await readObserved(
        path,
        report,
        location.scope,
        identities(data, path, root, observedRoot.found),
      )
    ).observation;
    let reachesRoot = false;
    if (
      observed.reachable &&
      observed.target === observedRoot.observation.target &&
      ["directory", "link"].includes(observedRoot.observation.kind)
    ) {
      try {
        reachesRoot = await anchoredAlias(path, root);
      } catch (error) {
        collectError(report, error, path, location.scope);
      }
      if (!reachesRoot)
        collect(report, {
          exit: ExitCode.DRIFT,
          findings: [
            {
              code: "W_ALIAS_BYPASS_ROOT",
              severity: "warning",
              path,
              scope: location.scope,
              message:
                "This CLI alias reaches the current skills but bypasses the stable scope root.",
              fix: `Inspect and preserve this foreign alias, then explicitly retarget it to ${root} during migration. Plain sync may preserve a working direct-pack alias.`,
            },
          ],
        });
    }
    observedAliases.push({ ...observed, reachesRoot });
  }
  return {
    scope: location.scope,
    root: location.root,
    manifestPath: location.path,
    mode: resolved?.mode ?? (manifest ? (manifest.packs.length ? "pack" : "composed") : null),
    desired: resolved ? resolved.bindings.map((binding) => binding.name).sort() : null,
    actual: { root: observedRoot.observation, entries },
    counts: {
      desired: resolved?.bindings.length ?? null,
      actual: entries.length,
      owned: entries.filter((item) => item.ownership === "owned").length,
      foreign: entries.filter(
        (item) => item.ownership === "foreign" || item.ownership === "changed",
      ).length,
      pack: entries.filter((item) => item.ownership === "pack").length,
      missing: resolved
        ? resolved.bindings.filter(
            (binding) =>
              !entries.some((item) => item.name === binding.name && item.target === binding.path),
          ).length
        : null,
    },
    aliases: observedAliases,
    receipt,
  };
}

async function inspect(options: DiagnosticOptions): Promise<Inspection> {
  cancelled(options);
  const report: Report = { findings: [], exits: [] };
  const locations = await locationsForInspection(options, report);
  const resolution = await resolveSelection(options);
  collect(report, resolution);
  const planned = await planSync(options);
  collect(report, planned);
  cancelled(options);
  const home =
    resolution.data?.scopes.find((scope) => scope.scope === "global")?.root ??
    locations.find((scope) => scope.scope === "global")?.root ??
    options.home ??
    homedir();
  const contextOptions = { ...options, home };
  const sources: {
    location: ScopeLocation;
    resolved: ResolvedScope | undefined;
    manifest: SkillsManifest | null;
    registry: RegistrySelection | null;
  }[] = [];
  for (const location of locations) {
    const resolved = resolution.data?.scopes.find((scope) => scope.scope === location.scope);
    let manifest = resolved?.manifest ?? null;
    if (!manifest) {
      try {
        manifest = location.exists
          ? await readManifest(location.path)
          : location.scope === "global"
            ? parseManifest({}, location.path)
            : null;
      } catch (error) {
        collectError(report, error, location.path, location.scope);
      }
    }
    let registry = resolved?.registry ?? null;
    if (!registry) {
      try {
        registry = await discoverRegistry({
          ...contextOptions,
          ...(manifest?.registry ? { registry: manifest.registry } : {}),
        });
      } catch (error) {
        collectError(report, error, location.path, location.scope);
      }
    }
    sources.push({ location, resolved, manifest, registry });
  }
  const forbiddenRoots = [
    ...new Set([
      ...sources.flatMap((source) => (source.registry ? [source.registry.root] : [])),
      ...(resolution.data?.scopes.map((scope) => scope.registry.root) ?? []),
      ...locations.flatMap((location) => [
        join(location.root, ".agents"),
        ...(location.scope === "project" ? [location.root] : []),
        ...aliasPaths(location.root, location.scope).map(dirname),
      ]),
    ]),
  ];
  const contexts: ScopeContext[] = [];
  for (const source of sources) {
    cancelled(options);
    contexts.push({
      ...source,
      status: await observeScope(
        source.location,
        source.resolved,
        source.manifest,
        contextOptions,
        forbiddenRoots,
        report,
      ),
    });
  }
  return {
    data: {
      resolution: resolution.data,
      writeScopes: locations.map((location) => location.scope),
      scopes: contexts.map((context) => context.status),
      changes: planned.data?.changes ?? [],
    },
    contexts,
    report,
  };
}

function drift(data: StatusResult): boolean {
  return data.changes.length > 0 || data.scopes.some((scope) => scope.receipt.state === "pending");
}

export async function inspectStatus(
  options: DiagnosticOptions = {},
): Promise<ResultEnvelope<StatusResult | null>> {
  try {
    const inspection = await inspect(options);
    return makeResult("status", inspection.data, {
      exit: diagnosticExit(inspection.report.exits, drift(inspection.data)),
      findings: uniqueFindings(inspection.report.findings),
    });
  } catch (error) {
    return failed("status", error);
  }
}

function uniqueOrigins(origins: readonly SkillOrigin[]): SkillOrigin[] {
  const found = new Set<string>();
  return origins.filter((origin) => {
    const key = JSON.stringify(origin);
    if (found.has(key)) return false;
    found.add(key);
    return true;
  });
}

async function dormantDetails(
  context: ScopeContext,
  name: string,
  report: Report,
  options: DiagnosticOptions,
): Promise<{ origins: SkillOrigin[]; inheritedPath: string | null }> {
  const { manifest, registry, location } = context;
  if (!manifest?.packs.length) return { origins: [], inheritedPath: null };
  const origins: SkillOrigin[] = [];
  let inheritedPath: string | null = null;
  const origin = (kind: SkillOrigin["kind"], reference: string): SkillOrigin => ({
    scope: location.scope,
    manifest: location.path,
    kind,
    reference,
  });
  if (manifest.skills.some((skill) => skill.name === name)) origins.push(origin("skill", name));
  if (location.scope === "project" && manifest.inheritGlobal) {
    const inherited = await resolveSelection({ ...options, scope: "global" });
    const binding = inherited.data?.scopes
      .find((scope) => scope.scope === "global")
      ?.bindings.find((binding) => binding.name === name);
    if (inherited.ok && binding) {
      origins.push(...binding.origins, origin("inherit", "global"));
      inheritedPath = binding.path;
    } else if (!inherited.ok) {
      report.findings.push({
        code: "I_DORMANT_UNRESOLVED",
        severity: "info",
        scope: location.scope,
        path: location.path,
        message:
          "Dormant global inheritance could not be resolved while the project pack is active.",
        fix: "Restore the global declaration before disabling the pack if inherited skills are still wanted.",
        detail: inherited.findings.map((finding) => finding.message),
      });
    }
  }
  if (registry) {
    for (const set of manifest.sets) {
      try {
        const members = await setMembers(registry.root, set.name);
        if (members.names.includes(name)) origins.push(origin("set", set.name));
      } catch (error) {
        report.findings.push({
          code: "I_DORMANT_UNRESOLVED",
          severity: "info",
          scope: location.scope,
          path: location.path,
          message: `Dormant set ${set.name} could not be inspected while the pack is active.`,
          fix: "Restore the dormant set before disabling the pack if that ordinary selection is still wanted.",
          detail:
            error instanceof SkillexError
              ? error.findings.map((finding) => finding.message)
              : [String(error)],
        });
      }
    }
  }
  return { origins, inheritedPath };
}

export async function explainSkill(
  name: string,
  options: DiagnosticOptions = {},
): Promise<ResultEnvelope<ExplainResult | null>> {
  try {
    parseManifest({ skills: [name] }, "explain skill name");
    const inspection = await inspect(options);
    const { report } = inspection;
    const canonicalByRoot = new Map<string, string>();
    const dormantByRoot = new Map<string, SkillOrigin[]>();
    const missing: { error: unknown; context: ScopeContext }[] = [];
    for (const context of inspection.contexts) {
      cancelled(options);
      const dormant = await dormantDetails(context, name, report, options);
      dormantByRoot.set(context.location.root, dormant.origins);
      if (dormant.inheritedPath) canonicalByRoot.set(context.location.root, dormant.inheritedPath);
      const effective = context.resolved?.bindings.find((binding) => binding.name === name);
      const inheritedExclusion = context.resolved?.excluded.some(
        (excluded) =>
          excluded.name === name && excluded.origins.some((origin) => origin.kind === "inherit"),
      );
      const inherited = inheritedExclusion
        ? inspection.data.resolution?.scopes
            .find((scope) => scope.scope === "global")
            ?.bindings.find((binding) => binding.name === name)
        : undefined;
      const contributed = effective ?? inherited;
      if (contributed) {
        // Resolution already chose canonical contributors. An unrelated local
        // catalog definition cannot override an inherited binding or exclusion.
        canonicalByRoot.set(context.location.root, contributed.path);
        continue;
      }
      if (!context.registry) continue;
      try {
        canonicalByRoot.set(
          context.location.root,
          await canonicalSkill(context.registry.root, name),
        );
      } catch (error) {
        if (
          error instanceof SkillexError &&
          error.findings.every((finding) => finding.code === "E_SKILL_MISSING")
        )
          missing.push({ error, context });
        else
          collectError(
            report,
            error,
            join(context.registry.root, "all-skills", name),
            context.location.scope,
          );
      }
    }
    const targets = [...new Set(canonicalByRoot.values())];
    if (!targets.length)
      for (const { error, context } of missing)
        collectError(
          report,
          error,
          join(context.registry?.root ?? context.location.root, "all-skills", name),
          context.location.scope,
        );
    if (targets.length > 1)
      collectError(
        report,
        new SkillexError(ExitCode.REFUSED, [
          {
            code: "E_DIVERGENT_CANONICAL_NAME",
            severity: "error",
            name,
            message: `Canonical name ${name} refers to different definitions across the inspected scopes.`,
            fix: "Use one canonical definition or rename the distinct skills; no target is selected as a shadow winner.",
            detail: targets,
          },
        ]),
      );
    const divergent = report.findings.some(
      (finding) =>
        finding.code === "E_DIVERGENT_CANONICAL_NAME" &&
        (finding.name === undefined || finding.name === name),
    );
    const canonical = targets.length === 1 && !divergent ? (targets[0] ?? null) : null;
    const scopes: SkillExplanation[] = [];
    for (const context of inspection.contexts) {
      cancelled(options);
      const { location, resolved, manifest, status } = context;
      const binding = resolved?.bindings.find((binding) => binding.name === name);
      const exclusions = resolved?.excluded.filter((excluded) => excluded.name === name) ?? [];
      const direct: SkillOrigin[] = manifest?.skills.some((skill) => skill.name === name)
        ? [{ scope: location.scope, manifest: location.path, kind: "skill", reference: name }]
        : [];
      const dormant = dormantByRoot.get(location.root) ?? [];
      const origins = uniqueOrigins([
        ...(binding?.origins ?? []),
        ...exclusions.flatMap((excluded) => excluded.origins),
        ...direct,
        ...dormant,
      ]);
      const scopeCanonical = canonicalByRoot.get(location.root) ?? null;
      const actual =
        status.actual.entries.find((item) => item.name === name) ??
        (await readObserved(join(location.root, ".agents", "skills", name), report, location.scope))
          .observation;
      const aliases: { path: string; reachable: boolean }[] = [];
      for (const alias of status.aliases) {
        const observed = await readObserved(join(alias.path, name), report, location.scope);
        aliases.push({
          path: alias.path,
          reachable:
            observed.observation.reachable &&
            observed.observation.target === (scopeCanonical ?? canonical),
        });
      }
      const blockers = uniqueFindings(
        report.findings.filter(
          (finding) =>
            finding.severity === "error" &&
            (finding.scope === undefined ||
              finding.scope === location.scope ||
              (manifest?.inheritGlobal && !manifest.packs.length && finding.scope === "global")),
        ),
      );
      const state: SkillExplanation["state"] =
        blockers.length || !resolved
          ? "blocked"
          : binding
            ? "effective"
            : exclusions.length
              ? "excluded"
              : dormant.length
                ? "dormant"
                : "unselected";
      scopes.push({
        scope: location.scope,
        root: location.root,
        manifestPath: location.path,
        state,
        canonical: scopeCanonical,
        origins,
        exclusions,
        dormant,
        actual,
        aliases,
        blockers,
      });
    }
    return makeResult(
      "explain",
      { name, canonical, scopes },
      {
        exit: diagnosticExit(report.exits, drift(inspection.data)),
        findings: uniqueFindings(report.findings),
      },
    );
  } catch (error) {
    return failed("explain", error);
  }
}
