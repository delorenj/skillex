import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSkill, packInventory, setMembers } from "./composition.js";
import { isWithin } from "./content.js";
import { derivedState } from "./derivation.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { parseManifest } from "./manifest.js";
import { listPacks } from "./packs.js";
import { resolveSelection } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { SelectionOptions, SelectionResult } from "./selection-command-types.js";
import {
  runSelectionEdit,
  type ScopeTarget,
  type SelectionEdit,
  selectScopeTarget,
} from "./selection-commands.js";
import { readSelectionManifest, type SelectionManifestSnapshot } from "./selection-manifest.js";
import { derivedSetName, parseDerivedName } from "./set-origin.js";

export interface NormalizeOptions extends SelectionOptions {
  /** Apply the planned repair. Without it, normalize is a write-free preview. */
  readonly apply?: boolean;
  /** Explicit base for a legacy multi-set selection; never guessed from array order. */
  readonly baseSet?: string;
}

interface InventoryOutcome {
  readonly candidate: Record<string, unknown>;
  readonly findings: Diagnostic[];
}

const manifestFields = [
  "$schema",
  "scope",
  "inherit_global",
  "registry",
  "sets",
  "packs",
  "skills",
  "exclude",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure<T>(command: string, error: unknown): ResultEnvelope<T | null> {
  return makeResult(command, null, {
    exit: error instanceof SkillexError ? error.exit : ExitCode.FAILURE,
    findings:
      error instanceof SkillexError
        ? error.findings
        : [
            {
              code: "E_IO",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              fix: "Check the selected scope, its manifest, and the registry before retrying.",
            },
          ],
  });
}

function refused(path: string, message: string, fix: string, detail?: readonly string[]): never {
  return fail(
    "E_NORMALIZE_REFUSED",
    message,
    { path, ...(detail ? { detail } : {}), fix },
    ExitCode.REFUSED,
  );
}

function entryName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (record(value) && typeof value.name === "string") return value.name;
  return undefined;
}

/** Keep only identity fields; the corrected candidate owns the selection arrays. */
function passthrough(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of ["$schema", "scope", "inherit_global", "registry"])
    if (raw[field] !== undefined) next[field] = raw[field];
  return next;
}

interface LegacySet {
  readonly name: string;
  readonly optional: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/**
 * Extract legacy set entries, refusing anything with semantics normalization
 * cannot preserve (runtime source fields belong to an authored migrate mapping).
 */
function legacySets(raw: Readonly<Record<string, unknown>>, path: string): LegacySet[] | never {
  if (raw.sets === undefined) return [];
  if (!Array.isArray(raw.sets))
    refused(
      path,
      "The sets selection must be an array.",
      "Correct the declaration using skills.schema.json.",
    );
  const sets: LegacySet[] = [];
  for (const entry of raw.sets) {
    if (typeof entry === "string") {
      sets.push({ name: entry, optional: false });
      continue;
    }
    if (!record(entry) || typeof entry.name !== "string")
      refused(
        path,
        "A legacy set entry has no unambiguous name.",
        "Correct the entry using skills.schema.json, or supply an authored replacement with skillex migrate.",
      );
    const foreign = Object.keys(entry).filter(
      (key) => !["name", "optional", "include", "exclude"].includes(key),
    );
    if (foreign.length)
      refused(
        path,
        `Legacy set ${entry.name} carries runtime fields (${foreign.join(", ")}) that normalization cannot preserve.`,
        "Translate this declaration with skillex migrate and an explicitly authored mapping; normalize never guesses source semantics.",
        [`set ${entry.name}`, ...foreign],
      );
    if (entry.optional !== undefined && typeof entry.optional !== "boolean")
      refused(
        path,
        "Legacy set optional must be boolean.",
        "Correct the declaration before normalization.",
      );
    for (const filter of ["include", "exclude"] as const)
      if (
        entry[filter] !== undefined &&
        (!Array.isArray(entry[filter]) ||
          (entry[filter] as unknown[]).some((name) => typeof name !== "string"))
      )
        refused(
          path,
          `Legacy set ${entry.name} filter ${filter} must be an array of names.`,
          "Correct the filter using skills.schema.json.",
        );
    sets.push({
      name: entry.name,
      optional: entry.optional === true,
      ...(Array.isArray(entry.include) ? { include: entry.include as readonly string[] } : {}),
      ...(Array.isArray(entry.exclude) ? { exclude: entry.exclude as readonly string[] } : {}),
    });
  }
  return sets;
}

function legacyArrays(
  raw: Readonly<Record<string, unknown>>,
  path: string,
): { packs: readonly unknown[]; skills: readonly string[]; exclude: readonly string[] } | never {
  for (const field of ["packs", "skills", "exclude"] as const)
    if (raw[field] !== undefined && !Array.isArray(raw[field]))
      refused(
        path,
        `The ${field} selection must be an array.`,
        "Correct the declaration using skills.schema.json.",
      );
  const packs = [...((raw.packs as readonly unknown[]) ?? [])];
  for (const entry of packs)
    if (typeof entry !== "string") {
      if (!record(entry) || typeof entry.name !== "string")
        refused(
          path,
          "A legacy pack entry has no unambiguous name.",
          "Correct the entry using skills.schema.json, or supply an authored replacement with skillex migrate.",
        );
      const foreign = Object.keys(entry).filter(
        (key) => !["name", "version", "optional"].includes(key),
      );
      if (foreign.length)
        refused(
          path,
          `Legacy pack ${entry.name} carries runtime fields (${foreign.join(", ")}) that normalization cannot preserve.`,
          "Translate this declaration with skillex migrate and an explicitly authored mapping; normalize never guesses source semantics.",
          [`pack ${entry.name}`, ...foreign],
        );
    }
  const skillEntries = [...((raw.skills as readonly unknown[] | undefined) ?? [])];
  const skills: string[] = [];
  for (const entry of skillEntries) {
    const name = entryName(entry);
    if (name === undefined || (record(entry) && Object.keys(entry).some((key) => key !== "name")))
      refused(
        path,
        "A legacy skill entry carries options normalization cannot preserve.",
        "Translate this declaration with skillex migrate and an explicitly authored mapping.",
      );
    skills.push(name as string);
  }
  const exclude = [...((raw.exclude as readonly unknown[] | undefined) ?? [])];
  if (exclude.some((name) => typeof name !== "string"))
    refused(
      path,
      "The exclude selection must be names.",
      "Correct the declaration using skills.schema.json.",
    );
  return { packs, skills, exclude: exclude as readonly string[] };
}

async function membersOf(registry: string, name: string, path: string): Promise<readonly string[]> {
  try {
    return (await setMembers(registry, name)).names;
  } catch (error) {
    const finding = error instanceof SkillexError ? error.findings[0] : undefined;
    refused(
      path,
      `Normalization needs the members of set ${name}, but it cannot be read.`,
      "Create the set (skillex set create / set add), or remove its selection with an explicit decision; normalize never guesses membership.",
      finding ? [finding.message] : undefined,
    );
  }
}

/** Fold a legacy additive/filter set selection into one exact-membership declaration. */
async function foldLegacySets(
  registry: string,
  sets: readonly LegacySet[],
  skills: readonly string[],
  exclude: readonly string[],
  path: string,
  findings: Diagnostic[],
  baseSet?: string,
): Promise<{ base: string; skillsExtras: readonly string[]; removed: readonly string[] }> {
  if (sets.length > 1 && !baseSet)
    refused(
      path,
      "Multiple legacy sets require an explicit base selection.",
      "Preview skillex normalize --base-set NAME; choose the intended base, not the first array entry.",
    );
  if (baseSet && !sets.some((set) => set.name === baseSet))
    refused(
      path,
      "The chosen base is not among this manifest's legacy sets.",
      "Choose a declared set with --base-set NAME.",
    );
  for (const set of sets) parseManifest({ sets: [set.name] }, path);
  for (const name of skills) await canonicalSkill(registry, name);
  const memberLists: (readonly string[])[] = [];
  for (const set of sets) memberLists.push(await membersOf(registry, set.name, path));
  // Node manifests treat an explicit empty include as no members.
  const filtered = sets.map((set, index) => {
    const members = memberLists[index] as readonly string[];
    if (set.include?.some((name) => !members.includes(name)))
      refused(
        path,
        `Set ${set.name} includes a missing member.`,
        "Repair the include list explicitly; normalization never drops missing required references.",
      );
    const included =
      set.include !== undefined ? members.filter((name) => set.include?.includes(name)) : members;
    return set.exclude ? included.filter((name) => !set.exclude?.includes(name)) : included;
  });
  for (const selected of sets) {
    if (selected.optional)
      refused(
        path,
        "Optional legacy sets cannot be flattened without losing their optional-selection contract.",
        "Choose an explicit required replacement before normalization.",
      );
    if (selected.include !== undefined && selected.include.length === 0) {
      // Old Python and Node readers disagreed here; this command targets Node JSON semantics.
      findings.push({
        code: "I_NORMALIZE_EMPTY_INCLUDE",
        severity: "info",
        path,
        message: `Set ${selected.name} has an explicit empty include: preserve zero Node-selected members.`,
        fix: "If this manifest came from the Python runtime, supply an authored migration mapping instead.",
      });
    }
  }
  const effective = new Set<string>(skills);
  for (const names of filtered) for (const name of names) effective.add(name);
  const baseIndex = baseSet ? sets.findIndex((set) => set.name === baseSet) : 0;
  const base = sets[baseIndex] as LegacySet;
  // Unfiltered base membership: the derived set materializes base ∪ extras −
  // removed, so the base's own filters must land in `removed`, not vanish here.
  const baseMembers = memberLists[baseIndex] as readonly string[];
  const extras = [...effective].filter((name) => !baseMembers.includes(name)).sort();
  const removed = [
    ...new Set([...baseMembers.filter((name) => !effective.has(name)), ...exclude]),
  ].sort();
  if (sets.length > 1)
    findings.push({
      code: "I_NORMALIZE_FOLD_SETS",
      severity: "info",
      message: `Legacy additive sets (${sets.map((set) => set.name).join(", ")}) fold into one exact-membership selection (base ${base.name}).`,
      path,
      fix: "Apply with skillex normalize --apply; effective membership is preserved exactly.",
    });
  if (sets.some((set) => set.include?.length || set.exclude?.length))
    findings.push({
      code: "I_NORMALIZE_FOLD_FILTERS",
      severity: "info",
      message: `Legacy set filters fold into derived-set removals (${removed.join(", ") || "none"}).`,
      path,
      fix: "Apply with skillex normalize --apply; excluded members stay excluded through the derived set.",
    });
  return { base: base.name, skillsExtras: extras, removed };
}

/** Find sets whose membership exactly equals the given composed selection. */
async function exactMatchSets(
  registry: string,
  skills: readonly string[],
  findings: Diagnostic[],
): Promise<string[]> {
  const expected = [...new Set(skills)].sort();
  let entries: Dirent[];
  try {
    entries = await readdir(join(registry, "sets"), { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const members = [...new Set((await setMembers(registry, entry.name)).names)].sort();
      if (
        members.length === expected.length &&
        members.every((name, index) => name === expected[index])
      )
        matches.push(entry.name);
    } catch (error) {
      const finding = error instanceof SkillexError ? error.findings[0] : undefined;
      findings.push({
        code: "W_NORMALIZE_SET_UNREADABLE",
        severity: "warning",
        message: `Set ${entry.name} could not be read while searching for exact membership matches.`,
        path: join(registry, "sets", entry.name),
        ...(finding ? { detail: [finding.message] } : {}),
        fix: "Repair or remove the unreadable set; it is preserved untouched.",
      });
    }
  }
  return matches;
}

async function simplifyMembers(
  snapshot: SelectionManifestSnapshot,
  target: ScopeTarget,
  registry: string,
  options: NormalizeOptions,
  findings: Diagnostic[],
): Promise<Record<string, unknown>> {
  const manifest = snapshot.manifest;
  if (!manifest) return { ...snapshot.raw };
  const raw: Record<string, unknown> = { ...snapshot.raw };
  const remaining = new Set(manifest.skills.map((skill) => skill.name));
  for (const name of remaining) await canonicalSkill(registry, name);
  const selectedPacks = new Map<string, unknown>();
  for (const pack of manifest.packs) {
    const inventory = await packInventory(registry, pack);
    const ref = `${inventory.name}@${inventory.version}`;
    const earlier = selectedPacks.get(inventory.name);
    const value = pack.optional
      ? { name: pack.name, version: inventory.version, optional: true }
      : ref;
    if (earlier !== undefined && JSON.stringify(earlier) !== JSON.stringify(value))
      refused(
        snapshot.path,
        `Pack ${inventory.name} has conflicting versions or optionality.`,
        "Choose one version/option explicitly before normalization; no contribution is discarded.",
      );
    selectedPacks.set(
      inventory.name,
      pack.optional ? { name: pack.name, version: inventory.version, optional: true } : ref,
    );
    for (const name of inventory.names) remaining.delete(name);
  }
  if (target.scope === "project" && manifest.inheritGlobal && !manifest.sets.length) {
    const { project: _project, ...globalOptions } = options;
    const global = await resolveSelection({
      ...globalOptions,
      home: target.home,
      scope: "global",
      registryRoot: registry,
    });
    if (!global.ok || !global.data) throw new SkillexError(global.exit, global.findings);
    const inherited = global.data.scopes.find((scope) => scope.scope === "global");
    const globalSet = inherited?.manifest.sets[0]?.name;
    const inheritedNames = inherited?.bindings.map((binding) => binding.name) ?? [];
    const allExplicit = new Set(manifest.skills.map((skill) => skill.name));
    if (
      globalSet &&
      inheritedNames.length > 0 &&
      inheritedNames.every((name) => allExplicit.has(name))
    ) {
      raw.sets = [globalSet];
      findings.push({
        code: "I_NORMALIZE_GLOBAL_SET",
        severity: "info",
        path: snapshot.path,
        message: `Replace the individually repeated global skills with set ${globalSet}.`,
        fix: "Apply the preview; scope-local extras derive their own set.",
      });
    }
    for (const binding of inherited?.bindings ?? []) remaining.delete(binding.name);
  }
  if (remaining.size >= 2) {
    const available = await listPacks({ ...options, registryRoot: registry });
    for (const finding of available.findings)
      findings.push({
        ...finding,
        severity: "warning",
        code: "W_NORMALIZE_PACK_UNREADABLE",
        fix: "Unreadable packs were not used for grouping. Repair their membership before requiring a complete grouping audit.",
      });
    const candidates = (available.data?.packs ?? []).filter(
      (pack) =>
        !selectedPacks.has(pack.name) &&
        pack.skills.length >= 2 &&
        pack.skills.every((skill) => remaining.has(skill.name)),
    );
    candidates.sort(
      (a, b) =>
        b.skills.length - a.skills.length ||
        `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
    );
    const alternatives = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const variants = alternatives.get(candidate.name) ?? new Set<string>();
      variants.add(
        candidate.skills
          .map((skill) => skill.name)
          .sort()
          .join("\0"),
      );
      alternatives.set(candidate.name, variants);
    }
    for (const [name, variants] of alternatives)
      if (variants.size > 1)
        refused(
          snapshot.path,
          `Pack ${name} has several applicable versions with different membership.`,
          "Select a pinned pack explicitly before normalization.",
        );
    for (const pack of candidates) {
      if (selectedPacks.has(pack.name) || !pack.skills.every((skill) => remaining.has(skill.name)))
        continue;
      selectedPacks.set(pack.name, `${pack.name}@${pack.version}`);
      for (const skill of pack.skills) remaining.delete(skill.name);
      findings.push({
        code: "I_NORMALIZE_GROUP_PACK",
        severity: "info",
        path: snapshot.path,
        message: `Replace ${pack.skills.length} explicit members with pack ${pack.name}@${pack.version}.`,
        fix: "Apply the exact-membership normalization preview.",
      });
    }
  }
  const skills = [...remaining].sort();
  const packs = [...selectedPacks].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  if (skills.length) raw.skills = skills;
  else delete raw.skills;
  if (packs.length) raw.packs = packs;
  else delete raw.packs;
  if (Array.isArray(raw.exclude)) {
    const excluded = [...new Set(raw.exclude)].sort();
    if (excluded.length) raw.exclude = excluded;
    else delete raw.exclude;
  }
  if (Array.isArray(raw.sets) && raw.sets.length === 0) delete raw.sets;
  if (
    JSON.stringify(raw.skills) !== JSON.stringify(snapshot.raw?.skills) ||
    JSON.stringify(raw.packs) !== JSON.stringify(snapshot.raw?.packs)
  )
    findings.push({
      code: "I_NORMALIZE_DEDUP",
      severity: "info",
      path: snapshot.path,
      message:
        "Remove duplicate and inherited member declarations; retain only residual skills and pack references.",
      fix: "Apply the preview; canonical membership remains unchanged.",
    });
  return raw;
}

async function inventory(
  snapshot: SelectionManifestSnapshot,
  target: ScopeTarget,
  registry: string,
  options: NormalizeOptions,
): Promise<InventoryOutcome> {
  const raw = snapshot.raw as Readonly<Record<string, unknown>>;
  const path = snapshot.path;
  const findings: Diagnostic[] = [];
  if (snapshot.manifest) {
    // The declaration parses: normalization only repairs representation conflicts
    // the resolver refuses (extras on a shared set, stale derivations, collapse).
    const manifest = snapshot.manifest;
    const selected = manifest.sets[0];
    const extrasEmpty =
      manifest.packs.length === 0 && manifest.skills.length === 0 && manifest.exclude.length === 0;
    const owner = { scope: target.scope, root: target.root };
    const state = selected ? await derivedState(registry, selected.name) : undefined;
    const owned =
      state &&
      state.origin.derived.owner.scope === owner.scope &&
      state.origin.derived.owner.root === owner.root;
    if (
      selected &&
      options.baseSet &&
      selected.name !== options.baseSet &&
      (!owned || state?.origin.derived.base !== options.baseSet)
    ) {
      const current = await resolveSelection({
        ...options,
        home: target.home,
        scope: target.scope,
        registryRoot: registry,
      });
      if (!current.ok || !current.data) throw new SkillexError(current.exit, current.findings);
      const names = new Set(
        current.data.scopes
          .find((scope) => scope.scope === target.scope)
          ?.bindings.map((binding) => binding.name) ?? [],
      );
      const baseMembers = await membersOf(registry, options.baseSet, path);
      if (baseMembers.some((name) => !names.has(name)))
        refused(
          path,
          "The requested base contains skills not in the current effective selection.",
          "Select a membership-preserving base; normalization never widens the loadout.",
        );
      const extras = [...names].filter((name) => !baseMembers.includes(name)).sort();
      const candidate: Record<string, unknown> = {
        ...passthrough(raw),
        sets: [extras.length ? derivedSetName(options.baseSet, target.root) : options.baseSet],
        ...(extras.length ? { skills: extras } : {}),
      };
      findings.push({
        code: "I_NORMALIZE_REBASE_SET",
        severity: "info",
        path,
        message: `Express this exact selection as base ${options.baseSet} plus ${extras.length} additional members.`,
        fix: "Review the base-and-pack decomposition before apply; the old shared set remains intact.",
      });
      const grouped = await simplifyMembers(
        { ...snapshot, raw: candidate, manifest: parseManifest(candidate, path) },
        target,
        registry,
        options,
        findings,
      );
      return { candidate: grouped, findings };
    }
    if (selected && !extrasEmpty && !owned) {
      // Extras on a shared (or not-yet-derived) set converge to this scope's
      // derived name; an already correctly-shaped name needs no rewrite.
      if (parseDerivedName(selected.name, target.root) === undefined) {
        findings.push({
          code: "I_NORMALIZE_DERIVE_EXTRAS",
          severity: "info",
          message: `Set ${selected.name} exclusively replaces this scope; its extra selections derive scope-owned set ${derivedSetName(selected.name, target.root)}.`,
          path,
          fix: "Apply with skillex normalize --apply; the shared set and other consumers stay unchanged.",
        });
        const simplified = await simplifyMembers(snapshot, target, registry, options, findings);
        return {
          candidate: { ...simplified, sets: [derivedSetName(selected.name, target.root)] },
          findings,
        };
      }
      return { candidate: { ...raw }, findings };
    }
    if (selected && extrasEmpty && owned && state) {
      const base = state.origin.derived.base;
      findings.push({
        code: "I_NORMALIZE_COLLAPSE_BASE",
        severity: "info",
        message: `Derived set ${selected.name} no longer carries extras; the selection collapses back to ${base ?? "an empty composed scope"}.`,
        path,
        fix: "Apply with skillex normalize --apply; the retired derived set disappears and the shared base stays untouched.",
      });
      return {
        candidate: { ...raw, ...(base === null ? { sets: [] } : { sets: [base] }) },
        findings,
      };
    }
    if (!selected) {
      // Exact-membership grouping: replace repeated individual selections with
      // a set reference only when exactly one set matches (never a silent pick).
      const groupable =
        manifest.skills.length > 0 &&
        manifest.packs.length === 0 &&
        manifest.exclude.length === 0 &&
        (target.scope === "global" || manifest.inheritGlobal === false);
      if (groupable) {
        const matches = await exactMatchSets(
          registry,
          manifest.skills.map((s) => s.name),
          findings,
        );
        const name = matches[0];
        if (matches.length === 1 && name !== undefined) {
          findings.push({
            code: "I_NORMALIZE_GROUP_EXACT",
            severity: "info",
            message: `This scope's individual skills exactly match set ${name}; the selection becomes that set reference.`,
            path,
            fix: "Apply with skillex normalize --apply; effective membership is preserved exactly.",
          });
          const next = passthrough(raw);
          next.sets = [name];
          return { candidate: next, findings };
        }
        if (matches.length > 1)
          findings.push({
            code: "W_NORMALIZE_GROUP_AMBIGUOUS",
            severity: "warning",
            message: `Multiple sets exactly match this selection (${matches.join(", ")}); the individual selection is preserved.`,
            path,
            fix: "Choose one set explicitly with skillex enable set NAME; normalize never picks among ambiguous identities.",
          });
      }
    }
    const simplified = await simplifyMembers(snapshot, target, registry, options, findings);
    const base = Array.isArray(simplified.sets) ? entryName(simplified.sets[0]) : undefined;
    if (
      base &&
      base !== selected?.name &&
      ((Array.isArray(simplified.skills) && simplified.skills.length) ||
        (Array.isArray(simplified.packs) && simplified.packs.length) ||
        (Array.isArray(simplified.exclude) && simplified.exclude.length))
    )
      simplified.sets = [derivedSetName(base, target.root)];
    return { candidate: simplified, findings };
  }

  // Legacy declaration: ordinary sync refuses to read it. Normalize inventories
  // it, explains every legacy meaning, and plans the exact-membership repair.
  const parseFindings = snapshot.parseFindings ?? [];
  const unknown = Object.keys(raw).filter((key) => !manifestFields.includes(key));
  if (unknown.length)
    refused(
      path,
      `The declaration carries unknown fields (${unknown.join(", ")}) that normalization cannot interpret.`,
      "Correct the fields using skills.schema.json, or supply an explicitly authored replacement with skillex migrate.",
      unknown,
    );
  for (const finding of parseFindings)
    findings.push({
      code: "I_NORMALIZE_LEGACY_STATE",
      severity: "info",
      message: finding.message,
      path: finding.path ?? path,
      fix: "Apply with skillex normalize --apply to replace this legacy state with the corrected contract.",
    });
  const sets = legacySets(raw, path);
  const { packs, skills, exclude } = legacyArrays(raw, path);
  if (sets.length === 0)
    refused(
      path,
      "This legacy declaration has no foldable set selection for normalize to repair.",
      "Correct the declaration using skills.schema.json, or translate it with skillex migrate and an authored mapping.",
    );
  if (packs.length)
    refused(
      path,
      "Legacy sets plus packs have ambiguous formerly dormant selections.",
      "Supply an explicit replacement with skillex migrate; normalization cannot infer which dormant members to activate.",
    );
  const inheritedNames: string[] = [];
  if (target.scope === "project" && raw.inherit_global !== false) {
    const { project: _project, ...globalOptions } = options;
    const inherited = await resolveSelection({
      ...globalOptions,
      home: target.home,
      scope: "global",
      registryRoot: registry,
    });
    if (!inherited.ok || !inherited.data)
      throw new SkillexError(inherited.exit, inherited.findings);
    for (const binding of inherited.data.scopes.find((scope) => scope.scope === "global")
      ?.bindings ?? [])
      inheritedNames.push(binding.name);
    if (inheritedNames.length)
      findings.push({
        code: "I_NORMALIZE_PRESERVE_INHERITED",
        severity: "info",
        path,
        message: `Preserve ${inheritedNames.length} inherited members when replacing legacy additive sets.`,
        fix: "Review the derived set's exact membership before applying.",
      });
  }
  const folded = await foldLegacySets(
    registry,
    sets,
    [...skills, ...inheritedNames],
    exclude,
    path,
    findings,
    options.baseSet,
  );
  const extrasEmpty =
    packs.length === 0 && folded.skillsExtras.length === 0 && folded.removed.length === 0;
  const next = passthrough(raw);
  next.sets = extrasEmpty ? [folded.base] : [derivedSetName(folded.base, target.root)];
  if (packs.length) next.packs = packs;
  if (folded.skillsExtras.length) next.skills = [...folded.skillsExtras];
  if (folded.removed.length) next.exclude = [...folded.removed];
  const grouped = await simplifyMembers(
    { ...snapshot, raw: next, manifest: parseManifest(next, path) },
    target,
    registry,
    options,
    findings,
  );
  return { candidate: grouped, findings };
}

/**
 * Normalize one scope's selection declaration to the corrected set/pack
 * contract: inventory legacy or conflicted state, fold it into deterministic
 * exact-membership references, and preview (default) or apply the repair
 * through the shared selection transaction.
 */
export async function normalizeScope(
  options: NormalizeOptions = {},
): Promise<ResultEnvelope<SelectionResult | null>> {
  const command = "normalize";
  try {
    const edit: SelectionEdit = { operation: "normalize" };
    const target = await selectScopeTarget(options, edit);
    const snapshot = await readSelectionManifest(target.root, { tolerant: true });
    if (!snapshot.exists || !snapshot.raw)
      fail("E_MANIFEST_MISSING", "This scope has no selection declaration to normalize.", {
        path: snapshot.path,
        scope: target.scope,
        fix: `Run skillex init --scope ${target.scope}${target.scope === "project" ? " --project PATH" : ""} first; normalize only reshapes existing declarations.`,
      });
    const raw = snapshot.raw as Record<string, unknown>;
    const registry = await discoverRegistry({
      ...options,
      home: target.home,
      ...(typeof raw.registry === "string" ? { registry: raw.registry } : {}),
    });
    if (options.apply && options.dryRun)
      fail("E_OPTIONS", "Choose --dry-run or --apply, not both.", {
        fix: "Preview first, then apply.",
      });
    const root = join(target.root, ".agents", "skills");
    if ((await inspectPath(root))?.isSymbolicLink()) {
      const oldTarget = await realpath(root).catch(() => undefined);
      if (oldTarget && isWithin(join(registry.root, "packs"), oldTarget))
        refused(
          root,
          "This root still uses legacy exclusive-pack activation; other declarations may be dormant.",
          "Choose and map the intended post-migration membership explicitly before normalization. No dormant selections were activated.",
        );
    }
    const inventoryOutcome = await inventory(snapshot, target, registry.root, options);
    // The candidate must be a valid corrected declaration before anything runs.
    parseManifest(inventoryOutcome.candidate, snapshot.path);
    const outcome = await runSelectionEdit(
      edit,
      { ...options, dryRun: options.apply !== true },
      { expected: snapshot.raw as Record<string, unknown>, candidate: inventoryOutcome.candidate },
      true,
    );
    return makeResult(command, outcome.data, {
      exit: outcome.exit,
      findings: [...inventoryOutcome.findings, ...outcome.findings],
    });
  } catch (error) {
    return failure(command, error);
  }
}
