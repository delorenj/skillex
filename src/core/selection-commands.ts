import { realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateActivationStateLocation } from "./activation-state.js";
import {
  type DerivationInputs,
  type DerivationOwner,
  type DerivationPreview,
  derivedState,
  desiredDerivedMembers,
  materializeDerivedSet,
  planDerivedSet,
  retireDerivedSet,
} from "./derivation.js";
import { discoverRegistry, discoverScopes } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { parseManifest } from "./manifest.js";
import {
  preflightDerivedActivation,
  prepareSyncUnlocked,
  reconcileUnlocked,
} from "./reconciliation.js";
import type { SyncOptions } from "./reconciliation-types.js";
import { resolveSelectionWithManifests } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection, ScopeName, SkillsManifest } from "./selection.js";
import type {
  SelectionChange,
  SelectionKind,
  SelectionOptions,
  SelectionResult,
} from "./selection-command-types.js";
import {
  readSelectionManifest,
  type SelectionManifestSnapshot,
  SelectionManifestWriteError,
  writeSelectionManifest,
} from "./selection-manifest.js";
import { derivedSetName, parseDerivedName } from "./set-origin.js";

interface Target {
  readonly scope: ScopeName;
  readonly root: string;
  readonly home: string;
}

type Edit =
  | { readonly operation: "init" }
  | { readonly operation: "inherit"; readonly enabled: boolean }
  | {
      readonly operation: "enable" | "disable";
      readonly kind: SelectionKind;
      readonly reference: string;
    }
  | { readonly operation: "normalize" };

/** An externally computed candidate with the exact raw it was inventoried from. */
export interface SelectionOverride {
  readonly expected: Readonly<Record<string, unknown>>;
  readonly candidate: Readonly<Record<string, unknown>>;
}

/** Registry-backed facts about the scope's currently selected set. */
interface SetContext {
  readonly owner: DerivationOwner;
  readonly selected: string | undefined;
  readonly ownedDerived: boolean;
  readonly base: string | null;
}

interface DerivationWork {
  readonly preview: DerivationPreview | undefined;
  readonly retire: readonly { readonly name: string; readonly registry: RegistrySelection }[];
}

interface PreparedSelection {
  readonly target: Target;
  readonly snapshot: SelectionManifestSnapshot;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly changed: boolean;
  readonly changes: readonly SelectionChange[];
  readonly syncOptions: SyncOptions;
  readonly findings: readonly Diagnostic[];
  readonly derivation: DerivationWork | undefined;
}

function checkCancelled(options: SelectionOptions, path?: string): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Selection update was interrupted.",
      {
        ...(path === undefined ? {} : { path }),
        fix: "Rerun the selection command, or sync any declaration that was already saved.",
      },
      ExitCode.INTERRUPTED,
    );
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
              fix: "Check the manifest, selected scope, and filesystem permissions before retrying.",
            },
          ],
  });
}

function validateOptions(options: SelectionOptions): void {
  if (options.scope !== undefined && !["global", "project"].includes(options.scope))
    fail("E_SCOPE", "Selection commands write exactly one global or project scope.", {
      fix: "Choose --scope global or --scope project.",
    });
  if (options.scope === "global" && options.project !== undefined)
    fail("E_SCOPE", "--scope global conflicts with an explicit project selector.", {
      fix: "Remove --project for a global update, or select --scope project.",
    });
}

async function directory(value: string, cwd: string, home: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail("E_PROJECT_ROOT", "A project or working directory must be a nonempty path.", {
      fix: "Pass an existing directory as --project or cwd.",
    });
  const expanded =
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  const path = resolve(cwd, expanded);
  const info = await inspectPath(path);
  if (!info || !(await stat(path)).isDirectory())
    fail("E_PROJECT_ROOT", "The selected project or working directory does not exist.", {
      path,
      fix: "Pass an existing directory or run from the intended checkout.",
    });
  return realpath(path);
}

async function nearestGitRoot(cwd: string, home: string): Promise<string | undefined> {
  let current = cwd;
  while (current !== home && current !== parse(current).root) {
    if (await inspectPath(join(current, ".git"))) return current;
    current = dirname(current);
  }
  return undefined;
}

async function selectTarget(options: SelectionOptions, edit: Edit): Promise<Target> {
  validateOptions(options);
  const locations = await discoverScopes({ ...options, scope: "global" });
  const home = locations.global.root;
  if (edit.operation === "inherit" && options.scope === "global")
    fail("E_SCOPE", "Inheritance can be changed only for a project.", {
      path: locations.global.path,
      fix: "Select the intended project with --scope project or --project PATH.",
    });
  if (options.scope === "global") return { scope: "global", root: home, home };
  const cwd = await directory(options.cwd ?? process.cwd(), process.cwd(), home);
  if (options.project !== undefined) {
    const root = await directory(options.project, cwd, home);
    if (root === home || root === parse(root).root)
      fail(
        "E_PROJECT_ROOT",
        "This path is the global home or filesystem root, not a distinct project scope.",
        { path: root, fix: "Use --scope global for home, or select a distinct project directory." },
      );
    return { scope: "project", root, home };
  }
  const globalSkills = join(home, ".agents", "skills");
  const lexicalCwd = resolve(options.cwd ?? process.cwd());
  const resolvedGlobalSkills = await realpath(globalSkills).catch(() => undefined);
  // A set-backed global root resolves inside the registry. Do not mistake an
  // invocation from that root for the registry project's manifest.
  if (
    edit.operation !== "inherit" &&
    options.scope !== "project" &&
    (lexicalCwd === globalSkills ||
      lexicalCwd.startsWith(`${globalSkills}/`) ||
      (resolvedGlobalSkills !== undefined &&
        (cwd === resolvedGlobalSkills || cwd.startsWith(`${resolvedGlobalSkills}/`))))
  ) {
    return { scope: "global", root: home, home };
  }
  const discovered = await discoverScopes({ ...options, cwd, home, scope: "auto" });
  if (discovered.project) return { scope: "project", root: discovered.project.root, home };
  const needsProject = options.scope === "project" || edit.operation === "inherit";
  if (edit.operation === "init" || needsProject) {
    const root = await nearestGitRoot(cwd, home);
    if (root) return { scope: "project", root, home };
  }
  if (needsProject)
    fail("E_PROJECT_ROOT", "No project manifest or checkout root was found.", {
      path: cwd,
      fix: "Run skillex init in the intended checkout, or pass --project PATH.",
    });
  return { scope: "global", root: home, home };
}

function entryName(value: unknown): string | undefined {
  if (typeof value === "string") {
    const separator = value.indexOf("@");
    return separator === -1 ? value : value.slice(0, separator);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  )
    return value.name;
  return undefined;
}

function packRef(entry: { name: string; version?: string }): string {
  return entry.version === undefined ? entry.name : `${entry.name}@${entry.version}`;
}

function extrasOf(manifest: SkillsManifest): {
  packs: string[];
  skills: string[];
  removed: string[];
} {
  return {
    packs: manifest.packs.map(packRef),
    skills: manifest.skills.map((skill) => skill.name),
    removed: [...manifest.exclude],
  };
}

function extrasEmpty(manifest: SkillsManifest): boolean {
  return (
    manifest.packs.length === 0 && manifest.skills.length === 0 && manifest.exclude.length === 0
  );
}

/** Edits whose candidate is computed from the saved declaration itself. */
type IntentEdit = Extract<Edit, { operation: "init" | "inherit" | "enable" | "disable" }>;

/**
 * Compute the candidate declaration. A set stays plain only while this scope
 * selects nothing besides it; any pack, skill, or exclusion switches the scope
 * to its deterministic scope-owned derived set instead.
 */
async function propose(
  raw: Readonly<Record<string, unknown>>,
  manifest: SkillsManifest | null,
  edit: IntentEdit,
  context: SetContext,
  remainingContributes: (
    name: string,
    candidate: Readonly<Record<string, unknown>>,
    base: string | null,
  ) => Promise<boolean>,
): Promise<Readonly<Record<string, unknown>>> {
  if (edit.operation === "init") return raw;
  const next: Record<string, unknown> = { ...raw };
  if (edit.operation === "inherit") {
    if (manifest?.sets.length)
      fail(
        "E_SCOPE",
        "Inheritance is replaced while a set exclusively selects this scope's root.",
        {
          path: manifest.path,
          fix: "Disable the set before changing inheritance, or keep the set and leave inheritance unused.",
        },
        ExitCode.REFUSED,
      );
    if (typeof edit.enabled !== "boolean")
      fail("E_INHERITANCE", "Inheritance must be on or off.", {
        ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
        fix: "Pass true/on or false/off for project inheritance.",
      });
    next.inherit_global = edit.enabled;
    return next;
  }
  if (!["skill", "set", "pack"].includes(edit.kind))
    fail("E_SELECTION_KIND", "Unknown selection kind.", {
      ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
      fix: "Choose skill, set, or pack.",
    });
  const reference = parseManifest(
    edit.kind === "skill"
      ? { skills: [edit.reference] }
      : edit.kind === "set"
        ? { sets: [edit.reference] }
        : { packs: [edit.reference] },
    manifest?.path ?? "selection",
  );
  // The name the scope's selection converges to once extras exist.
  const derivedFor = (base: string): string => derivedSetName(base, context.owner.root);
  const currentBase = (): string | null =>
    context.ownedDerived ? context.base : (context.selected ?? null);
  if (edit.kind === "skill") {
    const name = reference.skills[0]?.name;
    if (!name)
      fail("E_SELECTION_REFERENCE", "A canonical skill name is required.", {
        ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
        fix: "Pass a canonical skill name.",
      });
    const skills = Array.isArray(raw.skills) ? raw.skills : [];
    const excluded = Array.isArray(raw.exclude) ? raw.exclude : [];
    if (edit.operation === "enable") {
      if (excluded.includes(name)) next.exclude = excluded.filter((value) => value !== name);
      else if (!manifest?.skills.some((skill) => skill.name === name))
        next.skills = [...skills, name];
    } else {
      const direct = manifest?.skills.some((skill) => skill.name === name);
      if (direct) next.skills = skills.filter((value) => entryName(value) !== name);
      // Removing a direct declaration must not expose a still-selected base,
      // pack or inherited contribution under the same name.
      const base = currentBase();
      if (!excluded.includes(name) && (await remainingContributes(name, next, base)))
        next.exclude = [...excluded, name];
    }
  } else if (edit.kind === "set") {
    const name = reference.sets[0]?.name;
    if (!name)
      fail("E_SELECTION_REFERENCE", "A set name is required.", {
        ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
        fix: "Pass the name of a set.",
      });
    if (edit.operation === "enable") {
      if (manifest?.sets.some((set) => set.name === name)) return next;
      next.sets = [name];
    } else {
      const selected = manifest?.sets[0];
      if (!selected) return next;
      if (selected.name !== name && !context.ownedDerived)
        fail(
          "E_SET_SELECTION_MISMATCH",
          "The requested set does not match the selected declaration.",
          {
            ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
            fix: `Disable ${selected.name} explicitly to remove the selection.`,
          },
          ExitCode.REFUSED,
        );
      next.sets = [];
    }
  } else {
    const pack = reference.packs[0];
    if (!pack)
      fail("E_SELECTION_REFERENCE", "A pack reference is required.", {
        ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
        fix: "Pass NAME or NAME@VERSION.",
      });
    const packs = Array.isArray(raw.packs) ? raw.packs : [];
    const selected = manifest?.packs ?? [];
    if (edit.operation === "enable") {
      const existing = selected.find((entry) => entry.name === pack.name);
      if (!existing) next.packs = [...packs, edit.reference];
      else if (existing.version !== pack.version)
        next.packs = packs.map((value: unknown) =>
          entryName(value) === pack.name ? edit.reference : value,
        );
    } else {
      const existing = selected.find((entry) => entry.name === pack.name);
      if (existing) {
        if (pack.version !== undefined && existing.version !== pack.version)
          fail(
            "E_PACK_SELECTION_MISMATCH",
            "The requested pack version does not match the selected declaration.",
            {
              ...(manifest === null || manifest.path === undefined ? {} : { path: manifest.path }),
              fix: `Disable ${packRef(existing)} explicitly, or use its unversioned name to remove the selected pin without resolving its source.`,
            },
            ExitCode.REFUSED,
          );
        next.packs = packs.filter((value: unknown) => entryName(value) !== pack.name);
      }
    }
  }
  // Converge the set selection with whatever extras remain: extras force this
  // scope's derived set; empty extras on a derived selection collapse back to
  // the plain shared base.
  const candidate = parseManifest(next, manifest?.path ?? "selection");
  const previousBase = currentBase();
  const base =
    edit.operation === "enable" && edit.kind === "set"
      ? (candidate.sets[0]?.name ?? previousBase)
      : previousBase;
  if (candidate.sets[0] && !extrasEmpty(candidate) && base) {
    next.sets = [derivedFor(base)];
  } else if (
    candidate.sets[0] &&
    extrasEmpty(candidate) &&
    context.ownedDerived &&
    base &&
    candidate.sets[0].name === derivedFor(base)
  ) {
    next.sets = [base];
  }
  return next;
}

async function setContextFor(
  manifest: SkillsManifest | null,
  target: Target,
  registry: RegistrySelection | undefined,
): Promise<SetContext> {
  const owner: DerivationOwner = { scope: target.scope, root: target.root };
  const selected = manifest?.sets[0]?.name;
  if (!selected || !registry)
    return { owner, selected, ownedDerived: false, base: selected ?? null };
  const state = await derivedState(registry.root, selected);
  if (
    state?.origin.derived &&
    state.origin.derived.owner.scope === owner.scope &&
    state.origin.derived.owner.root === owner.root
  )
    return { owner, selected, ownedDerived: true, base: state.origin.derived.base };
  const pendingBase = parseDerivedName(selected, owner.root);
  if (
    !state &&
    !(await inspectPath(join(registry.root, "sets", selected))) &&
    pendingBase !== undefined &&
    manifest &&
    !extrasEmpty(manifest)
  )
    // Intent can be durably saved before its derived set exists. Reuse that
    // exact derivation on retry instead of deriving a second name from it.
    return { owner, selected, ownedDerived: true, base: pendingBase };
  return { owner, selected, ownedDerived: false, base: selected };
}

async function prepare(
  options: SelectionOptions,
  edit: Edit,
  override?: SelectionOverride,
  tolerant = false,
): Promise<PreparedSelection> {
  checkCancelled(options);
  const target = await selectTarget(options, edit);
  const snapshot = await readSelectionManifest(target.root, { tolerant });
  if (!snapshot.exists && edit.operation !== "init")
    fail("E_MANIFEST_MISSING", "This scope has no selection manifest.", {
      path: snapshot.path,
      scope: target.scope,
      fix: `Run skillex init --scope ${target.scope}${target.scope === "project" ? " --project PATH" : ""} before changing selections.`,
    });
  const syncOptions: SyncOptions = {
    ...options,
    home: target.home,
    scope: target.scope,
    ...(target.scope === "project" ? { project: target.root } : {}),
  };
  // One registry selection backs set-ownership reads and derivation planning.
  const registry = snapshot.manifest?.sets.length
    ? await discoverRegistry({
        ...options,
        home: target.home,
        ...(snapshot.manifest.registry === undefined
          ? {}
          : { registry: snapshot.manifest.registry }),
      })
    : await discoverRegistry({ ...options, home: target.home }).catch(() => undefined);
  const context = await setContextFor(snapshot.manifest, target, registry);
  if (override && !isDeepStrictEqual(snapshot.raw, override.expected))
    // A candidate planned from a tolerant inventory is only valid against the
    // exact declaration it read; anything else needs a fresh inventory.
    fail(
      "E_MANIFEST_CHANGED",
      "The declaration changed while the normalization plan was being prepared.",
      {
        path: snapshot.path,
        fix: "Re-run skillex normalize to inventory the current declaration.",
      },
      ExitCode.REFUSED,
    );
  let candidate: Readonly<Record<string, unknown>>;
  if (override) {
    candidate = override.candidate;
  } else if (edit.operation === "normalize") {
    // Normalization always supplies its inventoried candidate.
    fail(
      "E_INTERNAL",
      "Normalization reached intent planning without an inventoried candidate.",
      { fix: "Report this internal error; no state was changed." },
      ExitCode.FAILURE,
    );
  } else if (snapshot.raw && snapshot.manifest) {
    candidate = await propose(
      snapshot.raw,
      snapshot.manifest,
      edit,
      context,
      async (name, next, base) => {
        try {
          const candidate = parseManifest(next, snapshot.path);
          if (candidate.sets.length && registry) {
            const members = await desiredDerivedMembers(registry.root, {
              base,
              ...extrasOf(candidate),
            });
            return members.has(name);
          }
          const result = await resolveSelectionWithManifests(
            syncOptions,
            new Map([[snapshot.path, next]]),
          );
          if (!result.ok || !result.data) throw new SkillexError(result.exit, result.findings);
          return (
            result.data.scopes
              .find((scope) => scope.scope === target.scope)
              ?.bindings.some((binding) => binding.name === name) ?? false
          );
        } catch (error) {
          if (error instanceof SkillexError)
            throw new SkillexError(
              error.exit,
              error.findings.map((finding) => ({
                ...finding,
                fix: `${finding.fix ?? "Restore the missing source."} Retained set or inherited selections still require this reference; restore it or remove the retained declaration in its owning scope.`,
              })),
            );
          throw error;
        }
      },
    );
  } else {
    candidate = { inherit_global: target.scope === "project" };
  }
  const proposed = parseManifest(candidate, snapshot.path);
  const changed =
    !snapshot.exists || JSON.stringify(proposed) !== JSON.stringify(snapshot.manifest);
  const raw = changed ? candidate : (snapshot.raw ?? candidate);
  const changes: SelectionChange[] = changed
    ? [{ scope: target.scope, action: "write-manifest", path: snapshot.path }]
    : [];
  let findings: readonly Diagnostic[] = [];
  let derivation: DerivationWork | undefined;
  if (edit.operation === "init") {
    if (changed)
      await validateActivationStateLocation(target.root, {
        ...options,
        home: target.home,
        forbiddenRoots: [
          join(target.root, ".agents"),
          ...(target.scope === "project" ? [target.root] : []),
        ],
      });
  } else {
    // Derivation: a set with extras must be the scope's own derived set.
    const owner: DerivationOwner = { scope: target.scope, root: target.root };
    const retire: { name: string; registry: RegistrySelection }[] = [];
    if (
      registry &&
      context.ownedDerived &&
      context.selected &&
      proposed.sets[0]?.name !== context.selected
    )
      retire.push({ name: context.selected, registry });
    const selectedSet = proposed.sets[0];
    let preview: DerivationPreview | undefined;
    if (selectedSet && !extrasEmpty(proposed)) {
      const selectedRegistry = await discoverRegistry({
        ...options,
        home: target.home,
        ...(proposed.registry === undefined ? {} : { registry: proposed.registry }),
      });
      const state = await derivedState(selectedRegistry.root, selectedSet.name);
      const owned =
        state?.origin.derived &&
        state.origin.derived.owner.scope === owner.scope &&
        state.origin.derived.owner.root === owner.root;
      // An existing derived set states its base in the sidecar; a not-yet
      // materialized derived name must invert to this owner's base (enable
      // pack/skill on a shared set converges the name before it exists).
      const base = owned
        ? (state.origin.derived.base as string | null)
        : parseDerivedName(selectedSet.name, owner.root);
      if (base === undefined || selectedSet.name !== derivedSetName(base, owner.root))
        fail(
          "E_SET_CONFLICT",
          `Set extras require this scope's derived set, not ${selectedSet.name}.`,
          {
            path: snapshot.path,
            fix: `Re-run the skillex enable/disable command for this scope, or run skillex normalize --dry-run to plan the repair.`,
          },
          ExitCode.REFUSED,
        );
      const inputs: DerivationInputs = { base, ...extrasOf(proposed) };
      preview = await planDerivedSet({
        ...syncOptions,
        registryRoot: selectedRegistry.root,
        owner,
        inputs,
      });
      changes.push(
        ...preview.changes.map(
          (change): SelectionChange => ({
            scope: target.scope,
            action: change.action === "write-origin" ? "derive-set" : change.action,
            path: change.path,
            ...(change.target === undefined ? {} : { target: change.target }),
          }),
        ),
      );
    }
    for (const retired of retire) {
      const retirement = await retireDerivedSet(
        { ...syncOptions, registryRoot: retired.registry.root, dryRun: true },
        owner,
        retired.name,
      );
      if (!retirement.ok) throw new SkillexError(retirement.exit, retirement.findings);
      changes.push({
        scope: target.scope,
        action: "retire-set",
        path: join(retired.registry.root, "sets", retired.name),
        target: retired.name,
      });
    }
    derivation = { preview, retire };
    if (preview) {
      const activation = await preflightDerivedActivation(syncOptions, proposed, preview);
      changes.push(...activation.changes);
    } else {
      try {
        const activation = await prepareSyncUnlocked(syncOptions, new Map([[snapshot.path, raw]]));
        changes.push(...activation.plan.changes);
        findings = activation.findings;
      } catch (error) {
        if (
          edit.operation === "disable" &&
          edit.kind === "skill" &&
          error instanceof SkillexError
        ) {
          throw new SkillexError(
            error.exit,
            error.findings.map((finding) =>
              ["E_SKILL_MISSING", "E_SET_MISSING", "E_SET_MEMBER_MISSING"].includes(finding.code)
                ? {
                    ...finding,
                    fix: `${finding.fix ?? "Restore the missing source."} Retained set or inherited selections still require this reference; restore it or remove the retained declaration in its owning scope.`,
                  }
                : finding,
            ),
          );
        }
        throw error;
      }
    }
  }
  checkCancelled(options, snapshot.path);
  return { target, snapshot, raw, changed, changes, syncOptions, findings, derivation };
}

function resultData(
  prepared: PreparedSelection,
  options: SelectionOptions,
  saved: boolean,
  applied: readonly SelectionChange[],
): SelectionResult {
  return {
    scope: prepared.target.scope,
    root: prepared.target.root,
    manifestPath: prepared.snapshot.path,
    manifest: prepared.raw,
    dryRun: options.dryRun === true,
    changed: prepared.changed,
    saved,
    changes: prepared.changes,
    applied,
  };
}

function savedFailure(
  command: string,
  prepared: PreparedSelection,
  options: SelectionOptions,
  saved: boolean,
  applied: readonly SelectionChange[],
  error: unknown,
): ResultEnvelope<SelectionResult> {
  const issue = failure(command, error);
  const partial =
    saved ||
    applied.length > 0 ||
    (prepared.derivation?.preview !== undefined && issue.exit === ExitCode.PARTIAL);
  return makeResult(command, resultData(prepared, options, saved, applied), {
    exit:
      issue.exit === ExitCode.INTERRUPTED
        ? ExitCode.INTERRUPTED
        : partial
          ? ExitCode.PARTIAL
          : issue.exit,
    findings: [
      ...issue.findings,
      ...(partial
        ? [
            {
              code: "E_SELECTION_PARTIAL" as const,
              severity: "error" as const,
              message: saved
                ? "Selection intent was saved, but the command did not finish applying it."
                : "Applying the saved selection started but did not finish; no rollback was attempted.",
              path: prepared.snapshot.path,
              fix:
                command === "init"
                  ? "Retry init to verify the saved declaration; run sync when ready to activate it."
                  : prepared.derivation?.preview
                    ? "Correct the reported failure and retry the same enable/disable command, or run skillex normalize --dry-run then --apply to materialize the saved derivation. Sync refuses incomplete derived membership; no rollback was attempted."
                    : "Correct the reported failure and run sync for this scope to apply the saved declaration; no rollback was attempted.",
            },
          ]
        : []),
    ],
  });
}

async function run(
  edit: Edit,
  options: SelectionOptions,
  override?: SelectionOverride,
  tolerant = false,
): Promise<ResultEnvelope<SelectionResult | null>> {
  const command = edit.operation;
  try {
    const initial = await prepare(options, edit, override, tolerant);
    if (options.dryRun || !initial.changes.length)
      return makeResult(command, resultData(initial, options, false, []), {
        findings: initial.findings,
      });
    let outcome: ResultEnvelope<SelectionResult | null> | undefined;
    try {
      return await withLock(
        "skillex:activation:v2",
        async () => {
          const current = await prepare(options, edit, override, tolerant);
          if (
            current.target.root !== initial.target.root ||
            current.target.scope !== initial.target.scope
          )
            fail(
              "E_SELECTION_SCOPE_CHANGED",
              "The selected scope changed while waiting for the ownership lock.",
              {
                path: current.snapshot.path,
                fix: "Retry with an explicit --scope and --project to select the intended manifest.",
              },
              ExitCode.REFUSED,
            );
          let saved = false;
          const applied: SelectionChange[] = [];
          try {
            checkCancelled(options, current.snapshot.path);
            if (current.changed) {
              try {
                await writeSelectionManifest(current.snapshot, current.raw);
                saved = true;
              } catch (error) {
                if (error instanceof SelectionManifestWriteError) saved = error.published;
                throw error;
              }
              applied.push({
                scope: current.target.scope,
                action: "write-manifest",
                path: current.snapshot.path,
              });
            }
            checkCancelled(options, current.snapshot.path);
            if (current.derivation?.preview) {
              // The root may already expose this set. Publish recoverable intent
              // before altering any of its links or owner metadata.
              const intent = await readSelectionManifest(current.target.root);
              if (!isDeepStrictEqual(intent.raw, current.raw))
                fail(
                  "E_MANIFEST_CHANGED",
                  "Selection intent changed before derivation could apply it.",
                  {
                    path: current.snapshot.path,
                    fix: "Preserve the intervening declaration; re-run its owning selection command or normalize to apply it.",
                  },
                  ExitCode.REFUSED,
                );
              const derived = await materializeDerivedSet({
                ...current.syncOptions,
                registryRoot: current.derivation.preview.registry.root,
                owner: current.derivation.preview.owner,
                inputs: current.derivation.preview.inputs,
              });
              if (!derived.ok || !derived.data)
                throw new SkillexError(derived.exit, derived.findings);
              if (derived.data.changes.length)
                applied.push({
                  scope: current.target.scope,
                  action: "derive-set",
                  path: current.derivation.preview.path,
                });
            }
            checkCancelled(options, current.snapshot.path);
            if (edit.operation !== "init") {
              const activation = await reconcileUnlocked(
                current.syncOptions,
                new Map([[current.snapshot.path, current.raw]]),
              );
              if (activation.data) applied.push(...activation.data.applied);
              if (!activation.ok) throw new SkillexError(activation.exit, activation.findings);
              outcome = makeResult(command, resultData(current, options, saved, applied), {
                findings: activation.findings,
              });
            } else outcome = makeResult(command, resultData(current, options, saved, applied));
            for (const retirement of current.derivation?.retire ?? []) {
              const retired = await retireDerivedSet(
                { ...current.syncOptions, registryRoot: retirement.registry.root },
                { scope: current.target.scope, root: current.target.root },
                retirement.name,
              );
              if (!retired.ok) throw new SkillexError(retired.exit, retired.findings);
              applied.push({
                scope: current.target.scope,
                action: "retire-set",
                path: join(retirement.registry.root, "sets", retirement.name),
              });
            }
            return outcome;
          } catch (error) {
            if (saved && !applied.some((change) => change.action === "write-manifest"))
              applied.unshift({
                scope: current.target.scope,
                action: "write-manifest",
                path: current.snapshot.path,
              });
            outcome = savedFailure(command, current, options, saved, applied, error);
            return outcome;
          }
        },
        options,
      );
    } catch (error) {
      if (error instanceof SkillexError && error.exit === ExitCode.LOCK_BUSY)
        checkCancelled(options);
      if (!outcome?.data) throw error;
      const issue = failure(command, error);
      return makeResult(command, outcome.data, {
        exit: outcome.exit === ExitCode.INTERRUPTED ? ExitCode.INTERRUPTED : ExitCode.PARTIAL,
        findings: [...outcome.findings, ...issue.findings],
      });
    }
  } catch (error) {
    return failure(command, error);
  }
}

export async function initScope(
  options: SelectionOptions = {},
): Promise<ResultEnvelope<SelectionResult | null>> {
  return run({ operation: "init" }, options);
}
export async function enableSelection(
  kind: SelectionKind,
  reference: string,
  options: SelectionOptions = {},
): Promise<ResultEnvelope<SelectionResult | null>> {
  return run({ operation: "enable", kind, reference }, options);
}
export async function disableSelection(
  kind: SelectionKind,
  reference: string,
  options: SelectionOptions = {},
): Promise<ResultEnvelope<SelectionResult | null>> {
  return run({ operation: "disable", kind, reference }, options);
}
export async function setInheritance(
  enabled: boolean,
  options: SelectionOptions = {},
): Promise<ResultEnvelope<SelectionResult | null>> {
  return run({ operation: "inherit", enabled }, options);
}

/** Scope selection shared by the selection commands and normalization. */
export function selectScopeTarget(options: SelectionOptions, edit: Edit): Promise<Target> {
  return selectTarget(options, edit);
}

export type { Target as ScopeTarget };

/**
 * Run one prepared edit against the shared manifest/activation transaction.
 * Normalization passes an explicit candidate (inventoried from an exact raw
 * declaration, re-verified under the lock) plus tolerant legacy reads.
 */
export function runSelectionEdit(
  edit: Edit,
  options: SelectionOptions,
  override?: SelectionOverride,
  tolerant = false,
): Promise<ResultEnvelope<SelectionResult | null>> {
  return run(edit, options, override, tolerant);
}

export type { Edit as SelectionEdit };
