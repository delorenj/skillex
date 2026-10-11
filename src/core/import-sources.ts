import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { importSkill } from "./catalog-write.js";
import { canonicalSkill } from "./composition.js";
import type { CompositionOptions } from "./composition-types.js";
import { captureContent, digestContent, generatedName } from "./content.js";
import { fail } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { isSkillName, parseManifest } from "./manifest.js";
import { type Diagnostic, ExitCode } from "./result.js";

const run = promisify(execFile);

export interface SourceEntry {
  readonly name: string;
  readonly path: string;
  readonly disposition: "mapped" | "unmapped" | "divergent" | "broken" | "foreign";
  readonly canonical?: string;
  /** Real directory an explicit import would copy from (links resolve first). */
  readonly importPath?: string;
  readonly reason?: string;
}

export interface SourceProvenance {
  readonly type: "path" | "git";
  readonly label: string;
  readonly commit?: string;
}

export interface SourceInventory {
  readonly label: string;
  readonly kind: "path" | "git";
  readonly root: string | undefined;
  readonly entries: readonly SourceEntry[];
  readonly provenance: SourceProvenance;
  readonly temporary: string | undefined;
  readonly findings: readonly Diagnostic[];
}

export interface SourceOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly signal?: { readonly aborted: boolean };
}

/** One source skill that has no canonical definition yet. */
export interface PendingImport {
  readonly name: string;
  readonly path: string;
  /** Stable provenance label: sanitized URL (plus commit for Git), never a clone temp path. */
  readonly label: string;
}

export interface MembershipOptions {
  /** Collect unmapped entries for explicit import instead of refusing on them. */
  readonly importMissing?: boolean;
}

export interface SourceMembership {
  readonly names: string[];
  readonly findings: Diagnostic[];
  readonly imports: PendingImport[];
}

/** Options shared by source-backed set/pack creation. */
export interface SourceCreationOptions extends CompositionOptions {
  readonly fromRoot?: string;
  readonly from?: readonly string[];
  readonly import?: boolean;
}

/** The membership slice of {@link PlannedSources} that composition planning consumes. */
export interface SourceMembershipPlan {
  readonly members: readonly string[];
  readonly pending: ReadonlyMap<string, string>;
  readonly provenance: Record<string, unknown> | undefined;
}

function looksLikeRemote(source: string): boolean {
  return /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(source);
}

/**
 * Remove URL credentials anywhere they appear — labels, provenance, findings,
 * and Git transport errors all pass through here — so a token or password
 * embedded for transport is never echoed back.
 */
export function sanitizeSourceLabel(source: string): string {
  return source
    .replace(/([a-zA-Z][\w+.-]*):\/\/[^/@\s'"]+@/g, "$1://[redacted]@")
    .replace(/(^|[^\w.-])([\w.-]+):([^@/\s'"]+)@/g, "$1$2:[redacted]@");
}

/**
 * Deny every Git transport by default and explicitly allow only the one the
 * URL names, so an explicitly requested clone cannot be widened by redirects.
 */
function transportConfig(url: string): string[] {
  const scheme = /^(https?|git|ssh|file):\/\//i.exec(url)?.[1]?.toLowerCase();
  return [
    "protocol.allow=never",
    `protocol.${scheme ?? "ssh"}.allow=always`,
    // Nothing inside an acquired source is ever executed; neutralize hooks
    // in the ephemeral checkout for every later git command run against it.
    "core.hooksPath=/dev/null",
  ];
}

async function hasSkillMarker(directory: string): Promise<boolean> {
  return (await inspectPath(join(directory, "SKILL.md"))) !== undefined;
}

async function contentDigest(path: string): Promise<string> {
  const content = await captureContent(path);
  return digestContent(content.entries);
}

/**
 * A real directory that carries SKILL.md is a skill. When a canonical with
 * the same name exists its bytes must agree: matching digests become a plain
 * reference, divergent bytes are a named refusal — never a silent selection
 * or overwrite.
 */
async function classifySkillDirectory(
  registry: string,
  path: string,
  name: string,
): Promise<SourceEntry> {
  if (!isSkillName(name)) {
    return {
      name,
      path,
      disposition: "unmapped",
      reason: "The skill directory name is not a valid canonical skill name.",
    };
  }
  let canonical: string | undefined;
  try {
    canonical = await canonicalSkill(registry, name);
  } catch {
    return {
      name,
      path,
      importPath: path,
      disposition: "unmapped",
      reason: "No canonical definition with this name exists in all-skills.",
    };
  }
  const [source, existing] = await Promise.all([contentDigest(path), contentDigest(canonical)]);
  if (source === existing) return { name, path, disposition: "mapped", canonical };
  return {
    name,
    path,
    disposition: "divergent",
    canonical,
    reason: `Source digest ${source} differs from canonical digest ${existing}.`,
  };
}

/** A member link is mapped only when it resolves to this registry's canonical and that canonical still carries its SKILL.md marker. */
async function classifyLink(registry: string, path: string, name: string): Promise<SourceEntry> {
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    return {
      name,
      path,
      disposition: "broken",
      reason: "The link is dangling or cannot be resolved.",
    };
  }
  const expected = join(registry, "all-skills", name);
  if (target === expected) {
    if (await hasSkillMarker(target))
      return { name, path, disposition: "mapped", canonical: target };
    return {
      name,
      path,
      disposition: "broken",
      reason: `The link resolves to ${target}, which has no SKILL.md marker.`,
    };
  }
  if (relative(join(registry, "all-skills"), target).startsWith(".."))
    return {
      name,
      path,
      importPath: target,
      disposition: "unmapped",
      reason: `The link resolves outside this registry's catalog: ${target}.`,
    };
  return {
    name,
    path,
    disposition: "broken",
    reason: `The link resolves to ${target}, not the canonical definition named ${name}.`,
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function skipped(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_") || generatedName(name);
}

/**
 * Walk a skill root: descend through group directories that have no SKILL.md,
 * stop at any directory that has one (its references/ and scripts/ stay inside
 * the skill), and classify links and files where they sit.
 */
async function collectEntries(
  registry: string,
  directory: string,
  entries: SourceEntry[],
): Promise<void> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(byName)) {
    if (skipped(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Discovery stops at SKILL.md: a directory carrying the marker is a
      // skill and is never descended into.
      if (await hasSkillMarker(path))
        entries.push(await classifySkillDirectory(registry, path, entry.name));
      else await collectEntries(registry, path, entries);
      continue;
    }
    if (entry.isSymbolicLink()) {
      entries.push(await classifyLink(registry, path, entry.name));
      continue;
    }
    entries.push({
      name: entry.name,
      path,
      disposition: "foreign",
      reason: "Only member links and skill directories belong to a skill root.",
    });
  }
}

/** Choose the scan root: a skills/ child when present, the directory itself otherwise. */
async function scanRoot(path: string): Promise<string> {
  const skills = join(path, "skills");
  const child = await inspectPath(skills);
  if (child?.isDirectory()) return skills;
  return path;
}

async function inventoryPath(
  registry: string,
  label: string,
  path: string,
): Promise<SourceInventory> {
  const root = await scanRoot(path);
  const entries: SourceEntry[] = [];
  // An individual skill directory is a valid source: it contributes itself.
  if (await hasSkillMarker(root))
    entries.push(await classifySkillDirectory(registry, root, basename(root)));
  else await collectEntries(registry, root, entries);
  return {
    label,
    kind: "path",
    root,
    entries,
    provenance: { type: "path", label },
    temporary: undefined,
    findings: [],
  };
}

async function acquireRemote(
  registry: string,
  url: string,
  options: SourceOptions,
  pinnedCommit?: string,
): Promise<SourceInventory> {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Source acquisition was interrupted.",
      { fix: "Retry the composition command; nothing was imported." },
      ExitCode.INTERRUPTED,
    );
  const label = sanitizeSourceLabel(url);
  const temporary = await mkdtemp(join(tmpdir(), "skillex-source-"));
  let commit: string;
  try {
    const config = transportConfig(url).flatMap((value) => ["--config", value]);
    await run("git", ["clone", "--quiet", "--depth", "1", ...config, url, temporary], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    ({ stdout: commit } = await run("git", ["-C", temporary, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 15_000,
    }));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    const raw = error instanceof Error ? error.message : String(error);
    fail(
      "E_SOURCE_ACQUIRE",
      `Cannot acquire the requested Git source: ${label}`,
      {
        // Git echoes the full URL (credentials included) on transport errors.
        detail: [sanitizeSourceLabel(raw)],
        fix: "Check the URL, your network access, and Git credentials; acquisition only happens for explicitly passed Git sources.",
      },
      ExitCode.REFUSED,
    );
  }
  commit = commit.trim();
  if (pinnedCommit && pinnedCommit !== commit) {
    await rm(temporary, { recursive: true, force: true });
    fail(
      "E_SOURCE_CHANGED",
      `Git source ${label} moved to ${commit} after planning pinned ${pinnedCommit}.`,
      {
        fix: "Retry the command to plan against the new commit.",
      },
      ExitCode.REFUSED,
    );
  }
  const inventory = await inventoryPath(registry, label, temporary);
  return {
    ...inventory,
    kind: "git",
    provenance: { type: "git", label, commit },
    temporary,
  };
}

export async function releaseInventory(inventory: SourceInventory): Promise<void> {
  if (inventory.temporary) await rm(inventory.temporary, { recursive: true, force: true });
}

export async function inventorySkillRoot(
  registry: string,
  path: string,
  options: SourceOptions = {},
): Promise<SourceInventory> {
  const expanded = resolve(options.cwd ?? process.cwd(), path);
  const info = await inspectPath(expanded);
  const resolved = await realpath(expanded).catch(() => undefined);
  const targetInfo = resolved ? await inspectPath(resolved) : undefined;
  if (!info || !targetInfo?.isDirectory())
    fail("E_SOURCE_NOT_FOUND", `The --from-root path is not an existing directory: ${path}`, {
      path: expanded,
      fix: "Pass an existing skill root directory.",
    });
  return inventoryPath(registry, path, await realpath(expanded));
}

/**
 * Inventory one explicitly requested source: an existing local path is read in
 * place; a Git remote is acquired (clone --depth 1) because it was explicitly
 * requested, with its commit pinned into provenance. Nothing is executed from
 * the acquired tree and nothing is imported implicitly.
 */
export async function inventorySource(
  registry: string,
  source: string,
  options: SourceOptions = {},
  pinned?: SourceProvenance,
): Promise<SourceInventory> {
  if (looksLikeRemote(source))
    return acquireRemote(
      registry,
      source,
      options,
      pinned?.type === "git" ? pinned.commit : undefined,
    );
  const expanded = resolve(options.cwd ?? process.cwd(), source);
  const info = await inspectPath(expanded);
  if (info?.isDirectory() || info?.isSymbolicLink()) {
    const target = await realpath(expanded);
    if ((await inspectPath(target))?.isDirectory()) return inventoryPath(registry, source, target);
  }
  fail(
    "E_SOURCE_NOT_FOUND",
    `The --from source is neither an existing path nor a Git remote: ${source}`,
    {
      path: expanded,
      fix: "Pass an existing local directory or an explicit Git remote URL.",
    },
  );
}

function conflictFinding(
  inventory: SourceInventory,
  entry: SourceEntry,
  earlier: string,
): Diagnostic {
  return {
    code: "E_SOURCE_CONFLICT",
    severity: "error",
    message: `Source ${inventory.label} claims ${entry.name} with different content than an earlier source (${earlier}).`,
    path: entry.path,
    fix: "Import or map the conflicting entry explicitly; composition creation never guesses.",
  };
}

/**
 * Merge inventories into canonical member names. Mapped entries become
 * members; divergent and broken entries are errors; foreign entries are
 * preserved and reported. Unmapped entries are errors unless importMissing
 * collected them for explicit import — a requested entry is never skipped
 * silently.
 */
export async function membersFromInventories(
  registry: string,
  inventories: readonly SourceInventory[],
  options: MembershipOptions = {},
): Promise<SourceMembership> {
  const claims = new Map<
    string,
    { canonical?: string; importPath?: string; from: string; inventory: SourceInventory }
  >();
  const imports: PendingImport[] = [];
  const findings: Diagnostic[] = [];
  for (const inventory of inventories) {
    for (const entry of inventory.entries) {
      if (entry.disposition === "mapped" && entry.canonical) {
        const earlier = claims.get(entry.name);
        if (earlier) {
          if (earlier.canonical && earlier.canonical !== entry.canonical)
            findings.push(conflictFinding(inventory, entry, earlier.canonical));
          else if (!earlier.canonical)
            findings.push(conflictFinding(inventory, entry, earlier.from));
          else continue;
        }
        claims.set(entry.name, {
          canonical: entry.canonical,
          from: entry.canonical,
          inventory,
        });
        continue;
      }
      if (entry.disposition === "unmapped") {
        const importPath = entry.importPath ?? entry.path;
        const earlier = claims.get(entry.name);
        if (earlier) {
          if (earlier.canonical || earlier.importPath !== importPath)
            findings.push(conflictFinding(inventory, entry, earlier.from));
          continue;
        }
        claims.set(entry.name, { importPath, from: importPath, inventory });
        if (options.importMissing) {
          imports.push({
            name: entry.name,
            path: importPath,
            label: inventory.provenance.commit
              ? `${inventory.provenance.label}#${inventory.provenance.commit}`
              : inventory.provenance.label,
          });
          findings.push({
            code: "I_SOURCE_IMPORT",
            severity: "info",
            message: `${inventory.label}: ${entry.name} has no canonical definition and will be imported.`,
            path: entry.path,
            fix: `Run skillex skill import ${JSON.stringify(importPath)} --name ${entry.name} yourself to review the import before composing.`,
          });
        } else {
          findings.push({
            code: "E_SOURCE_UNMAPPED",
            severity: "error",
            message: `${inventory.label}: ${entry.name} is unmapped (${entry.reason ?? "no canonical definition"}).`,
            path: entry.path,
            fix: `Re-run with --import, or run skillex skill import ${JSON.stringify(importPath)} --name ${entry.name} first; requested entries are never skipped silently.`,
          });
        }
        continue;
      }
      if (entry.disposition === "divergent") {
        findings.push({
          code: "E_SOURCE_DIVERGENT",
          severity: "error",
          message: `${inventory.label}: ${entry.name} differs from the canonical definition of the same name (${entry.reason}).`,
          path: entry.path,
          fix: "Update the canonical definition explicitly or import the source under a new name; composition creation never picks a side.",
        });
        continue;
      }
      if (entry.disposition === "broken") {
        findings.push({
          code: "E_SOURCE_BROKEN",
          severity: "error",
          message: `${inventory.label}: ${entry.name} is broken (${entry.reason ?? "unusable member entry"}).`,
          path: entry.path,
          fix: "Repair or remove the broken entry in its source, or import its definition explicitly.",
        });
        continue;
      }
      findings.push({
        code: "I_SOURCE_FOREIGN",
        severity: "info",
        message: `${inventory.label}: ${entry.name} is not a skill member and is preserved. (${entry.reason ?? ""})`,
        path: entry.path,
        fix: "Only canonical member links and skill directories become composition members.",
      });
    }
  }
  void registry;
  return {
    names: [...claims.keys()].sort(),
    findings,
    imports,
  };
}

function importOptions(options: SourceCreationOptions) {
  return {
    ...(options.registryRoot === undefined ? {} : { registryRoot: options.registryRoot }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

/**
 * Acquire every declared source. When a later source fails, every inventory
 * acquired so far — including its ephemeral clone — is released before the
 * error propagates, so a failed acquisition never strands a temp tree.
 */
export async function acquireInventories(
  registryRoot: string,
  options: SourceCreationOptions,
): Promise<SourceInventory[]> {
  const inventories: SourceInventory[] = [];
  try {
    if (options.fromRoot !== undefined)
      inventories.push(await inventorySkillRoot(registryRoot, options.fromRoot, options));
    for (const source of options.from ?? [])
      inventories.push(await inventorySource(registryRoot, source, options));
    return inventories;
  } catch (error) {
    for (const inventory of inventories) await releaseInventory(inventory).catch(() => undefined);
    throw error;
  }
}

/** Sources fully planned: membership merged, every import validated write-free. */
export interface PlannedSources {
  readonly inventories: readonly SourceInventory[];
  readonly names: readonly string[];
  /** Canonical destinations the planned imports will occupy (dry-run results). */
  readonly pending: ReadonlyMap<string, string>;
  readonly imports: readonly PendingImport[];
  readonly findings: readonly Diagnostic[];
}

/**
 * Acquire all sources and plan membership without a single write: every
 * would-be import is validated through the standing `skill import` machinery
 * in dry-run first, so an invalid name or unreadable source refuses before
 * any catalog byte moves. Import failures surface as error findings.
 */
export async function planSourceMembers(
  registryRoot: string,
  options: SourceCreationOptions,
): Promise<PlannedSources> {
  const inventories = await acquireInventories(registryRoot, options);
  try {
    const merged = await membersFromInventories(registryRoot, inventories, {
      importMissing: options.import === true,
    });
    const findings = [...merged.findings];
    const pending = new Map<string, string>();
    if (!findings.some((finding) => finding.severity === "error")) {
      for (const pendingImport of merged.imports) {
        // Validation pass only: dry-run importSkill writes nothing.
        const result = await importSkill(pendingImport.path, pendingImport.name, {
          ...importOptions(options),
          dryRun: true,
          // Receipts must outlive the ephemeral clone: record the stable label.
          importedFrom: pendingImport.label,
        });
        if (result.ok && result.data) pending.set(pendingImport.name, result.data.path);
        else findings.push(...result.findings);
      }
    }
    return {
      inventories,
      names: merged.names,
      pending,
      imports: merged.imports,
      findings,
    };
  } catch (error) {
    // On success the caller owns release; a throw must not strand a clone.
    for (const inventory of inventories) await releaseInventory(inventory).catch(() => undefined);
    throw error;
  }
}

/** An import that actually landed in the catalog. */
export interface ExecutedImport {
  readonly name: string;
  readonly path: string;
}

/** Result of executing planned imports for real. */
export interface ImportExecution {
  readonly executed: readonly ExecutedImport[];
  readonly findings: readonly Diagnostic[];
}

/**
 * Execute planned imports for real, reusing the standing `skill import`
 * machinery. A failing import never invents a rollback or deletes the
 * definitions earlier imports already wrote — they are standalone
 * receipt-bearing units — but their survival is disclosed truthfully so the
 * refusal is never a silent partial state.
 */
export async function executeImports(
  imports: readonly PendingImport[],
  options: SourceCreationOptions,
): Promise<ImportExecution> {
  const executed: ExecutedImport[] = [];
  const findings: Diagnostic[] = [];
  for (const pendingImport of imports) {
    const result = await importSkill(pendingImport.path, pendingImport.name, {
      ...importOptions(options),
      importedFrom: pendingImport.label,
    });
    if (result.ok && result.data) {
      executed.push({ name: pendingImport.name, path: result.data.path });
      continue;
    }
    findings.push(...result.findings);
  }
  const [first] = executed;
  if (findings.length > 0 && first)
    findings.push({
      code: "E_SOURCE_IMPORT_PARTIAL",
      severity: "error",
      message: `${executed.length} earlier import${executed.length === 1 ? "" : "s"} already landed in the catalog and remain: ${executed
        .map((item) => item.name)
        .sort()
        .join(", ")}.`,
      path: first.path,
      fix: "No rollback was attempted: imported definitions are standalone receipt-bearing units. Fix the failing source and re-run; already-imported names match by digest and will not import twice.",
    });
  return { executed, findings };
}

export async function provenanceFrom(
  inventories: readonly SourceInventory[],
  imported?: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const sources = inventories.map((inventory) => {
    const value: Record<string, unknown> = { type: inventory.kind, label: inventory.label };
    if (inventory.provenance.commit) value.commit = inventory.provenance.commit;
    return value;
  });
  if (!sources.length) return undefined;
  const provenance: Record<string, unknown> = { sources };
  if (imported?.length) provenance.imported = [...imported].sort();
  return provenance;
}

/**
 * Validate member names with the shared manifest authority and resolve each
 * to its canonical target. `pending` carries dry-run import destinations for
 * names whose canonical does not exist yet; every other name must resolve for
 * real or the operation refuses.
 */
export async function resolveMemberTargets(
  registry: string,
  names: readonly string[],
  label: string,
  pending?: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const selected = parseManifest({ skills: [...names] }, label).skills;
  const targets = new Map<string, string>();
  for (const { name } of selected)
    targets.set(name, pending?.get(name) ?? (await canonicalSkill(registry, name)));
  return targets;
}
