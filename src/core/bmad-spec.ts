/**
 * BmadSpecification construction: `skillex bmad spec build` (SKRILL-27).
 *
 * Builds a validated offline pinned specification from explicit sources: a frozen
 * bmad pack in a registry (content-addressed over actual bytes, never VCS state)
 * plus an explicit local runtime support root. The spec binds content identity
 * (aggregate digests) separate from the BMAD version label, so the same label with
 * different pinned inputs is a distinguishable specification.
 *
 * Per ADR-0001 (canonical, reference-only): membership is pinned as NAMES ONLY.
 * The spec never duplicates canonical SKILL.md payloads — the sealed per-skill
 * checksum inventory the ADR rejected is not rebuilt here. Identity is carried by
 * the composition pin (pack version + exact pack.toml bytes) plus the per-client
 * command byte hashes, all reverified against the registry at plan/apply time.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  BmadClientSelection,
  BmadProjectConfig,
  BmadRuntimeDependency,
  BmadRuntimeSupportSource,
  BmadSpecBuildData,
  BmadSpecBuildOptions,
  BmadSpecification,
  BmadSpecificationSources,
} from "./bmad-materialize-types.js";
import { BMAD_COMMAND_CLIENTS, inspectBmadSource } from "./bmad-source.js";
import { canonicalSkill, packInventory } from "./composition.js";
import { type ContentEntry, captureContent, digestContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { isSkillName } from "./manifest.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic canonical JSON: sorted object keys, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Expand `~` like other skillex path options; must be a real local directory. */
export async function resolveRuntimeRoot(path: string, cwd?: string): Promise<string> {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
    fail("E_BMAD_SPEC_SOURCE", "A runtime support root requires a nonempty local path.", {
      fix: "Pass the BMAD-enabled source project root whose _bmad/ tree is the pinned runtime.",
    });
  }
  const home = homedir();
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const absolute = resolve(cwd ?? process.cwd(), expanded);
  const info = await inspectPath(absolute);
  if (!info?.isDirectory()) {
    fail(
      "E_BMAD_SPEC_SOURCE",
      `The runtime support root must be a real local directory: ${absolute}`,
      {
        path: absolute,
        fix: "Point at a local BMAD-enabled project root; nothing is fetched.",
      },
      ExitCode.REFUSED,
    );
  }
  const runtime = join(absolute, "_bmad");
  const runtimeInfo = await inspectPath(runtime);
  if (!runtimeInfo?.isDirectory()) {
    fail(
      "E_BMAD_SPEC_SOURCE",
      `The runtime support root has no _bmad directory: ${runtime}`,
      {
        path: runtime,
        fix: "Freeze runtime support from a project with a real _bmad/ tree.",
      },
      ExitCode.REFUSED,
    );
  }
  return absolute;
}

/** Validate requested client ids against the known BMAD client table. */
export function normalizeClients(requested: readonly string[]): readonly BmadClientSelection[] {
  if (!requested.length)
    fail("E_BMAD_SPEC_SOURCE", "A specification requires at least one native client.", {
      fix: "Pass --client for each requested adapter, e.g. --client claude-code --client codex.",
    });
  const seen = new Set<string>();
  const out: BmadClientSelection[] = [];
  for (const id of requested) {
    const entry = BMAD_COMMAND_CLIENTS.find((row) => row.client === id);
    if (!entry)
      fail("E_BMAD_SPEC_SOURCE", `Unknown BMAD client: ${id}`, {
        fix: `Use one of: ${BMAD_COMMAND_CLIENTS.map((row) => row.client).join(", ")}.`,
      });
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ client: entry.client, layout: entry.layout });
  }
  out.sort((a, b) => (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));
  return out;
}

/** Split `name@version`; both halves required for a pin. */
export function parsePackRef(ref: string): { name: string; version: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1)
    fail("E_BMAD_SPEC_PIN", `A pinned pack reference requires NAME@VERSION: ${ref}`, {
      fix: "Reference the exact frozen version, e.g. bmad@6.12.1-next.0.",
    });
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

/** Whole runtime support tree digest — files, links, AND directory entries
 * (including each directory's mode), so directory-mode tamper also invalidates
 * the pin. */
export async function captureRuntimeSupport(
  runtimeRoot: string,
): Promise<BmadRuntimeSupportSource> {
  const captured = await captureContent(join(runtimeRoot, "_bmad"));
  return { path: runtimeRoot, digest: digestContent(captured.entries) };
}

/**
 * Runtime closure derived from the SOURCE installation's own manifests —
 * `_config/files-manifest.csv` (the installer's record of what the runtime
 * SHOULD contain) reconciled against `_config/skill-manifest.csv` (the installer's
 * record of which paths hold canonical skill bodies) and against what is actually
 * present under `_bmad/`.
 *
 * Separation of concerns:
 *  - A declared path identified by the skill manifest as a canonical skill body
 *    (EXACT path match) becomes a canonical REFERENCE: role `canonical-support`,
 *    `canonical` = the exact skill name, `reference` = true when the name is a
 *    member of the pinned pack AND resolves in the catalog. Canonical bodies are
 *    NEVER copied into the runtime (ADR-0001) and the caller is NEVER told to
 *    "prune the authoritative manifest" — the manifest is evidence, not input to
 *    mutilate.
 *  - A declared path NOT identified as canonical is a genuine runtime support
 *    asset: scripts, module assets, workflows, templates, configs. Its ACTUAL
 *    filesystem kind, bytes digest and mode are captured. A declared support path
 *    that is absent is reported `missing: true` — the materializer turns that
 *    into an actionable dependency failure BEFORE any write.
 *  - A path present under `_bmad/` but not declared is recorded origin `observed`;
 *    it is only materialized under the explicit `runtimeExtraPolicy: "include"`.
 *    Observed canonical bodies are refused regardless of policy.
 *
 * Safety: a malformed manifest (bad header, short rows, duplicate declared paths,
 * absolute/traversing/null-containing paths) is an actionable refusal, never
 * silently skipped — an ambiguous closure is never guessed.
 */
export async function deriveRuntimeDependencies(
  runtimeRoot: string,
  packMembers: readonly string[],
  registryRoot?: string,
): Promise<readonly BmadRuntimeDependency[]> {
  const bmad = join(runtimeRoot, "_bmad");
  const configDir = join(bmad, "_config");
  const manifestRefuse = (message: string, detail: string, fix: string): never =>
    fail(
      "E_BMAD_SPEC_MANIFEST",
      message,
      { path: configDir, detail: [detail], fix },
      ExitCode.REFUSED,
    );

  // --- The skill manifest: the ONLY accepted proof a path is a canonical body.
  // Keyed by the EXACT declared `path` column; names keyed separately to detect
  // ambiguous/duplicate path claims (a path claimed by two skills is unknown,
  // never guessed).
  const canonicalByPath = new Map<string, string>();
  const skillManifestPath = join(configDir, "skill-manifest.csv");
  const skillManifestInfo = await inspectPath(skillManifestPath);
  if (skillManifestInfo?.isFile()) {
    const lines = (await readFile(skillManifestPath, "utf8")).split(/\r?\n/);
    if (!/^canonicalId,name,description,module,path/.test(lines[0] ?? ""))
      manifestRefuse(
        "The BMAD skill manifest header is not the expected canonicalId,name,description,module,path shape.",
        `header: ${JSON.stringify(lines[0] ?? "")}`,
        "Freeze from a source install whose manifests the BMAD installer wrote; an ambiguous manifest is never guessed.",
      );
    for (const [index, line] of lines.slice(1).entries()) {
      if (!line.trim()) continue;
      const record = parseCsvLine(line);
      const rawPath = record[4];
      const name = record[1] ?? record[0] ?? "";
      if (typeof rawPath !== "string" || !rawPath || !isSkillName(name)) continue;
      // The skill manifest records paths from the PROJECT root (`_bmad/...`);
      // the files manifest records paths from the `_bmad/` root. Normalize to
      // the `_bmad/`-relative form before the EXACT match.
      const declaredPath = rawPath.startsWith("_bmad/") ? rawPath.slice("_bmad/".length) : rawPath;
      if (!isSafeRelPath(declaredPath))
        manifestRefuse(
          "The BMAD skill manifest declares an unsafe canonical path.",
          `line ${index + 2}: ${JSON.stringify(rawPath)}`,
          "Restore a sound skill manifest; absolute or traversing canonical paths are refused, never followed.",
        );
      const existing = canonicalByPath.get(declaredPath);
      if (existing !== undefined && existing !== name)
        manifestRefuse(
          "The BMAD skill manifest maps one path to two different canonical skills.",
          `path ${declaredPath}: ${existing} vs ${name}`,
          "Restore a sound skill manifest; an ambiguous canonical mapping is never guessed.",
        );
      canonicalByPath.set(declaredPath, name);
    }
  }

  // --- The files manifest: the installer's declared runtime closure.
  const declaredPaths = new Set<string>();
  const declaredOrder: string[] = [];
  const missingDeclared: string[] = [];
  const filesManifest = join(configDir, "files-manifest.csv");
  const manifestInfo = await inspectPath(filesManifest);
  if (manifestInfo?.isFile()) {
    const lines = (await readFile(filesManifest, "utf8")).split(/\r?\n/);
    if (!/^type,name,module,path,hash/.test(lines[0] ?? ""))
      manifestRefuse(
        "The BMAD files manifest header is not the expected type,name,module,path,hash shape.",
        `header: ${JSON.stringify(lines[0] ?? "")}`,
        "Freeze from a source install whose manifests the BMAD installer wrote; an ambiguous manifest is never guessed.",
      );
    for (const [index, line] of lines.slice(1).entries()) {
      if (!line.trim()) continue;
      const record = parseCsvLine(line);
      if (record.length < 5)
        manifestRefuse(
          "The BMAD files manifest carries a malformed row.",
          `line ${index + 2} has ${record.length} field(s), expected 5: ${JSON.stringify(line)}`,
          "Restore a sound files manifest; a malformed closure declaration is never silently skipped.",
        );
      const declaredPath = record[3];
      if (typeof declaredPath !== "string" || !declaredPath) continue;
      if (!isSafeRelPath(declaredPath))
        manifestRefuse(
          "The BMAD files manifest declares an unsafe runtime path.",
          `line ${index + 2}: ${JSON.stringify(declaredPath)}`,
          "Restore a sound files manifest; absolute, traversing, or null-containing paths are refused, never followed.",
        );
      // The files manifest of a real install may declare the installer-managed
      // `_bmad/config.toml`/`config.user.toml`: those are GENERATED project
      // output carrying the source identity, never support assets — they are
      // never copied (generated config comes from explicit C) and never missing
      // dependency failures.
      if (declaredPath === "config.toml" || declaredPath === "config.user.toml") continue;
      if (declaredPaths.has(declaredPath))
        manifestRefuse(
          "The BMAD files manifest declares the same runtime path twice.",
          `duplicate: ${declaredPath}`,
          "Restore a sound files manifest; a conflicting closure declaration is never silently deduplicated.",
        );
      declaredPaths.add(declaredPath);
      declaredOrder.push(declaredPath);
      const info = await inspectPath(join(bmad, declaredPath));
      if (!info) missingDeclared.push(declaredPath);
    }
  }

  // --- Reconcile declared paths against the actual tree.
  const memberSet = new Set(packMembers);
  const captured = await captureContent(bmad);
  const byPath = new Map(captured.entries.map((entry) => [entry.path, entry]));
  const deps: BmadRuntimeDependency[] = [];
  const canonicalUnmapped: string[] = [];
  for (const declaredPath of declaredOrder) {
    const canonical = canonicalByPath.get(declaredPath);
    if (canonical !== undefined) {
      // Canonical body location per the source manifests. It is mapped to a
      // catalog REFERENCE, never copied. Ambiguity/unmapped is an honest refusal
      // listing the offending entries — the user is never told to prune an
      // authoritative manifest.
      if (!memberSet.has(canonical)) canonicalUnmapped.push(`${declaredPath} (${canonical})`);
      else if (registryRoot) await canonicalSkill(registryRoot, canonical);
      deps.push({
        path: declaredPath,
        kind: "file",
        digest: "",
        origin: "declared",
        role: "canonical-support",
        canonical,
        reference: memberSet.has(canonical),
      });
      continue;
    }
    const entry = byPath.get(declaredPath);
    if (!entry) {
      deps.push({
        path: declaredPath,
        kind: "file",
        digest: "",
        origin: "declared",
        role: "support",
        missing: true,
      });
      continue;
    }
    deps.push(captureDep(declaredPath, entry, "declared", "support"));
    byPath.delete(declaredPath);
  }
  if (canonicalUnmapped.length)
    fail(
      "E_BMAD_SPEC_RUNTIME_REFUSE",
      `The runtime source declares canonical skill path(s) that do not map to the pinned pack membership: ${canonicalUnmapped.join(", ")}.`,
      {
        path: skillManifestPath,
        detail: canonicalUnmapped,
        fix: "Pin a pack whose membership covers the source install's skill manifest, or freeze from the matching source; a canonical mapping that is unknown or ambiguous is never guessed and the authoritative manifests are never rewritten for it.",
      },
      ExitCode.REFUSED,
    );
  // Missing genuine support assets are an explicit, countable dependency failure.
  const missingSupport = deps.filter((dep) => dep.missing === true && dep.role === "support");
  if (missingSupport.length)
    fail(
      "E_BMAD_SPEC_RUNTIME_MISSING",
      `The runtime support tree is incomplete: ${missingSupport.length} declared support path(s) are missing (first: ${missingSupport[0]?.path}).`,
      {
        path: join(bmad, missingSupport[0]?.path ?? ""),
        detail: missingSupport.slice(0, 10).map((dep) => `missing ${dep.path}`),
        fix: "Restore the declared runtime support files in the pinned source, or freeze from a complete installation; materialization never guesses or silently skips a declared dependency.",
      },
      ExitCode.REFUSED,
    );
  // Present-but-undeclared entries: recorded with origin `observed`. A present
  // path the skill manifest identifies as a canonical body is mapped as a
  // canonical REFERENCE (origin observed — the files manifest did not declare
  // it), never copied and never refused merely for being present: the real
  // installer records canonical bodies in the skill manifest and may or may not
  // list them in the files manifest. Genuine extras are governed by
  // runtimeExtraPolicy at materialization.
  for (const [path, entry] of [...byPath.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (path.endsWith(".pyc") || path.includes("__pycache__")) continue;
    // Installer-authored project config under `_bmad/` is GENERATED project
    // output (it carries the source project identity), never a support asset:
    // it is never declared support, never an observed extra, and never copied
    // — the materializer generates config.toml from explicit C instead.
    if (path === "config.toml" || path === "config.user.toml") continue;
    const canonical = canonicalByPath.get(path);
    if (canonical !== undefined) {
      if (!memberSet.has(canonical))
        fail(
          "E_BMAD_SPEC_RUNTIME_REFUSE",
          `The runtime source holds a canonical skill body at _bmad/${path} (${canonical}) that does not map to the pinned pack membership.`,
          {
            path: join(bmad, path),
            detail: [`${path} (${canonical})`],
            fix: "Pin a pack whose membership covers the source install's skill manifest, or freeze from the matching source; a canonical mapping that is unknown or ambiguous is never guessed and the authoritative manifests are never rewritten for it.",
          },
          ExitCode.REFUSED,
        );
      deps.push({
        path,
        kind: "file",
        digest: "",
        origin: "observed",
        role: "canonical-support",
        canonical,
        reference: true,
      });
      continue;
    }
    deps.push(captureDep(path, entry, "observed", "support"));
  }
  return deps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function captureDep(
  path: string,
  entry: ContentEntry,
  origin: "declared" | "observed",
  role: "support" | "canonical-support",
): BmadRuntimeDependency {
  if (entry.kind === "directory") {
    return { path, kind: "dir", digest: "", origin, role, mode: entry.mode & 0o777 };
  }
  if (entry.kind === "link") {
    return {
      path,
      kind: "symlink",
      digest: `sha256:${createHash("sha256").update(entry.originalTarget).digest("hex")}`,
      origin,
      role,
      target: entry.originalTarget,
    };
  }
  return {
    path,
    kind: "file",
    digest: `sha256:${createHash("sha256").update(entry.bytes).digest("hex")}`,
    origin,
    role,
    mode: entry.mode & 0o777,
  };
}

/** A manifest-declared relative path must stay inside `_bmad/`. */
function isSafeRelPath(path: string): boolean {
  if (!path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
    return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quoted) {
      if (character === '"' && line.charAt(index + 1) === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Build the validated specification. All digests are over actual current bytes —
 * never VCS state — so a dirty registry is pinned exactly as it stands.
 */
/**
 * ONE aggregate catalog-closure digest (ADR-0001-compliant: no per-skill sealed
 * inventory — a single hash over the whole pinned membership namespace).
 *
 * Binds, in order, for the SORTED member list:
 *   1. the exact frozen pack.toml bytes,
 *   2. the sorted member names themselves,
 *   3. per member — the member's name label AND a namespaced digest of its
 *      captured canonical content (entry paths, types, bytes, modes, link
 *      targets via the ground captureContent/digestContent APIs) plus the
 *      canonical root directory's own mode, so neither byte tamper, mode
 *      tamper, type swaps, nor root-mode dirt can hide.
 *
 * Member names label their content digests adjacently, so entries can never be
 * re-attributed across members. The pin covers exactly the spec's members and
 * the pack bytes — nothing about unlisted catalog skills.
 */
export async function aggregateMembersDigest(
  registryRoot: string,
  // Structurally typed so the emitted public declaration does not reference the
  // Node-only `Buffer` global (keeps the package usable by isolated TS consumers
  // without @types/node); every current caller passes a real Buffer.
  packTomlBytes: { readonly length: number; readonly [index: number]: number } & Iterable<number>,
  members: readonly string[],
): Promise<string> {
  const sorted = [...members].sort();
  const hash = createHash("sha256");
  hash.update(
    createHash("sha256")
      .update(packTomlBytes as Buffer)
      .digest(),
  );
  hash.update(
    createHash("sha256")
      .update(`${sorted.join("\n")}\n`)
      .digest(),
  );
  for (const member of sorted) {
    const canonical = await canonicalSkill(registryRoot, member);
    // Root directory mode is bound explicitly (captureContent starts at children).
    const rootMode = (await lstat(canonical)).mode & 0o777;
    const captured = await captureContent(canonical);
    hash.update(
      createHash("sha256")
        .update(`member:${member}:${rootMode.toString(8)}`)
        .digest(),
    );
    hash.update(createHash("sha256").update(digestContent(captured.entries)).digest());
  }
  return hash.digest("hex");
}

export async function buildBmadSpecification(
  options: BmadSpecBuildOptions,
): Promise<ResultEnvelope<BmadSpecBuildData | null>> {
  const command = "bmad spec build";
  try {
    const registry: RegistrySelection = await discoverRegistry(options);
    const { name, version } = parsePackRef(options.packRef);
    const packPath = join(registry.root, "packs", name, version);
    const packDir = await inspectPath(packPath);
    if (!packDir?.isDirectory())
      fail(
        "E_BMAD_SPEC_PIN",
        `No frozen pack at ${packPath}`,
        {
          path: packPath,
          fix: `Freeze the version first (skillex bmad freeze <source> --version ${version}) or pin an existing version.`,
        },
        ExitCode.REFUSED,
      );
    const inventory = await packInventory(registry.root, { name, version, optional: false });
    const declared = [...new Set(inventory.names)].filter(isSkillName).sort();
    if (!declared.length)
      fail("E_BMAD_SPEC_PIN", `Pack ${name}@${version} declares no skills.`, {
        path: packPath,
        fix: "Re-freeze; a pinned pack must declare canonical membership.",
      });
    // Membership is pinned as NAMES ONLY (ADR-0001): every member must resolve in
    // the canonical catalog now, but no payload digest is sealed into the spec.
    for (const member of declared) await canonicalSkill(registry.root, member);

    // Composition pin: the exact pack.toml bytes + the resolved pack version +
    // ONE aggregate membership digest — pack.toml bytes + sorted member names +
    // each member's captured canonical content (paths/types/bytes/modes/targets).
    // Names-only membership per ADR-0001, but the pin now BINDS the actual
    // canonical content those names resolve to, so byte/mode tampering a member
    // under the same version label can no longer slide through verification.
    const packTomlPath = join(packPath, "pack.toml");
    const packTomlBytes = await readFile(packTomlPath);
    const membersSha256 = await aggregateMembersDigest(registry.root, packTomlBytes, declared);
    const composition = {
      packVersion: version,
      packTomlSha256: createHash("sha256").update(packTomlBytes).digest("hex"),
      membersSha256,
    };

    // Per-client command inventories from the frozen pack bytes (REQUESTED clients
    // only — a spec must not silently bind command payloads for adapters it does
    // not ask for).
    const requested = normalizeClients(options.clients);
    const commands: BmadSpecificationSources["commands"][number][] = [];
    for (const { client, layout } of requested) {
      const dir = join(packPath, "commands", client);
      const info = await inspectPath(dir);
      const files: { name: string; sha256: string }[] = [];
      if (info?.isDirectory()) {
        const names = (await readdir(dir)).sort();
        for (const fileName of names) {
          const bytes = await readFile(join(dir, fileName));
          files.push({ name: fileName, sha256: createHash("sha256").update(bytes).digest("hex") });
        }
      }
      commands.push({ client, layout, commandsPath: `commands/${client}`, files });
    }

    // Runtime support: explicit local root; digest whole _bmad tree. The source
    // installation version must MATCH the pinned pack version — a spec that binds
    // one version label to another version's runtime is refused, never written.
    const runtimeRoot = await resolveRuntimeRoot(options.runtimeRoot, options.cwd);
    const sourceProvenance = await inspectBmadSource(runtimeRoot);
    if (sourceProvenance.installation.version !== version)
      fail(
        "E_BMAD_SPEC_VERSION",
        `The runtime source installation version (${sourceProvenance.installation.version}) does not match the pinned pack version (${version}).`,
        {
          path: runtimeRoot,
          fix: "Pin the pack to the same version the runtime source is installed at, or freeze the matching source; a spec never binds a version label to a different version's runtime.",
        },
        ExitCode.REFUSED,
      );
    const runtime = await captureRuntimeSupport(runtimeRoot);
    // The validated declared closure: canonical references mapped exactly against
    // the pinned membership + catalog, genuine support assets captured with their
    // actual kind/bytes/mode, missing genuine support an actionable refusal.
    const runtimeDeps = await deriveRuntimeDependencies(runtimeRoot, declared, registry.root);
    const runtimeExtraPolicy: "declared" | "include" =
      options.includeObservedRuntime === true ? "include" : "declared";
    const projectConfig: BmadProjectConfig = {
      projectName: options.projectName ?? null,
      core: options.core ? { ...options.core } : {},
    };
    const sourcesBody = {
      pack: { name, version },
      members: declared,
      composition,
      commands,
      runtime: { path: "__runtime_relocated__", digest: runtime.digest },
      runtimeDeps,
      runtimeExtraPolicy,
    };
    const digest = sha256Text(
      canonicalJson({
        schema: "skillex.bmad-spec/v1",
        bmadVersion: version,
        clients: requested,
        projectConfig,
        sources: sourcesBody,
      }),
    );
    const spec: BmadSpecification = {
      schema: "skillex.bmad-spec/v1",
      bmadVersion: version,
      clients: requested,
      projectConfig,
      sources: {
        ...sourcesBody,
        inputsDigest: sha256Text(canonicalJson(sourcesBody)),
        provenanceLabel: `bmad-freeze ${name}@${version} + runtime ${runtime.digest.slice(0, 19)}`,
        // Relocation-neutral: the spec digest binds content, not the machine path.
        // Relocation-neutral IDENTITY: the digest binds content. The READ path is
        // the explicit build-time source root — persisted so `bmad plan`/`apply`
        // (which take no runtime override) can find the pinned bytes; the digest
        // verifier below revalidates them against the pin.
        runtime: { path: runtimeRoot, digest: runtime.digest },
      },
      digest,
    };
    let specPath: string | null = null;
    let written = false;
    if (options.specPath) {
      specPath = resolve(options.cwd ?? process.cwd(), options.specPath);
      const parent = dirname(specPath);
      const parentInfo = await inspectPath(parent);
      if (!parentInfo?.isDirectory())
        fail("E_BMAD_SPEC_SOURCE", `Specification parent directory missing: ${parent}`, {
          path: parent,
          fix: "Create the destination directory or choose an existing one.",
        });
      await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
      written = true;
    }
    return makeResult(command, { spec, specPath, written, dryRun: false, findings: [] });
  } catch (error) {
    const envelope =
      error instanceof SkillexError
        ? { exit: error.exit, findings: error.findings }
        : {
            exit: ExitCode.FAILURE,
            findings: [
              {
                code: "E_IO" as const,
                severity: "error" as const,
                message: error instanceof Error ? error.message : String(error),
                fix: "Check the pack, runtime root, and client arguments.",
              },
            ],
          };
    return makeResult(command, null, envelope);
  }
}

export type { BmadSpecBuildData };
