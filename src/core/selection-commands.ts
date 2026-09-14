import { realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { validateActivationStateLocation } from "./activation-state.js";
import { discoverScopes } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { parseManifest } from "./manifest.js";
import { prepareSyncUnlocked, reconcileUnlocked } from "./reconciliation.js";
import type { SyncOptions } from "./reconciliation-types.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { ScopeName, SkillsManifest } from "./selection.js";
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
    };

interface PreparedSelection {
  readonly target: Target;
  readonly snapshot: SelectionManifestSnapshot;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly changed: boolean;
  readonly changes: readonly SelectionChange[];
  readonly syncOptions: SyncOptions;
  readonly findings: readonly Diagnostic[];
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
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  )
    return value.name;
  return undefined;
}

function activePackRef(manifest: SkillsManifest): string | undefined {
  const pack = manifest.packs[0];
  return pack ? `${pack.name}${pack.version === undefined ? "" : `@${pack.version}`}` : undefined;
}

function propose(
  raw: Readonly<Record<string, unknown>>,
  manifest: SkillsManifest,
  edit: Edit,
): Readonly<Record<string, unknown>> {
  if (edit.operation === "init") return raw;
  const next: Record<string, unknown> = { ...raw };
  const active = activePackRef(manifest);
  if (active && (edit.operation === "inherit" || edit.kind !== "pack"))
    fail(
      "E_PACK_ACTIVE",
      "Ordinary selection and inheritance edits are dormant while a pack is active.",
      {
        path: manifest.path,
        fix: `Run skillex disable pack ${active} for this scope before changing skills, sets, or inheritance.`,
      },
      ExitCode.REFUSED,
    );
  if (edit.operation === "inherit") {
    if (typeof edit.enabled !== "boolean")
      fail("E_INHERITANCE", "Inheritance must be on or off.", {
        path: manifest.path,
        fix: "Pass true/on or false/off for project inheritance.",
      });
    next.inherit_global = edit.enabled;
    return next;
  }
  if (!["skill", "set", "pack"].includes(edit.kind))
    fail("E_SELECTION_KIND", "Unknown selection kind.", {
      path: manifest.path,
      fix: "Choose skill, set, or pack.",
    });
  const reference = parseManifest(
    edit.kind === "skill"
      ? { skills: [edit.reference] }
      : edit.kind === "set"
        ? { sets: [edit.reference] }
        : { packs: [edit.reference] },
    manifest.path,
  );
  if (edit.kind === "skill") {
    const name = reference.skills[0]?.name;
    if (!name)
      fail("E_SELECTION_REFERENCE", "A canonical skill name is required.", {
        path: manifest.path,
        fix: "Pass a canonical skill name.",
      });
    const skills = Array.isArray(raw.skills) ? raw.skills : [];
    const excluded = Array.isArray(raw.exclude) ? raw.exclude : [];
    if (edit.operation === "enable") {
      if (!manifest.skills.some((skill) => skill.name === name)) next.skills = [...skills, name];
      if (manifest.exclude.includes(name))
        next.exclude = excluded.filter((value) => value !== name);
    } else {
      if (manifest.skills.some((skill) => skill.name === name))
        next.skills = skills.filter((value) => entryName(value) !== name);
      if (!manifest.exclude.includes(name)) next.exclude = [...excluded, name];
    }
  } else if (edit.kind === "set") {
    const name = reference.sets[0]?.name;
    if (!name)
      fail("E_SELECTION_REFERENCE", "A set name is required.", {
        path: manifest.path,
        fix: "Pass the name of a set.",
      });
    const sets = Array.isArray(raw.sets) ? raw.sets : [];
    if (edit.operation === "enable" && !manifest.sets.some((set) => set.name === name))
      next.sets = [...sets, name];
    if (edit.operation === "disable" && manifest.sets.some((set) => set.name === name))
      next.sets = sets.filter((value) => entryName(value) !== name);
  } else {
    const pack = reference.packs[0];
    if (!pack)
      fail("E_SELECTION_REFERENCE", "A pack name is required.", {
        path: manifest.path,
        fix: "Pass NAME or NAME@VERSION.",
      });
    const selected = manifest.packs[0];
    if (edit.operation === "enable") {
      if (!selected || selected.name !== pack.name || selected.version !== pack.version)
        next.packs = [edit.reference];
    } else if (selected) {
      if (
        selected.name !== pack.name ||
        (pack.version !== undefined && selected.version !== pack.version)
      )
        fail(
          "E_PACK_SELECTION_MISMATCH",
          "The requested pack/version does not match the selected declaration.",
          {
            path: manifest.path,
            fix: `Disable ${active} explicitly, or use its unversioned name to remove the selected pin without resolving its source.`,
          },
          ExitCode.REFUSED,
        );
      next.packs = [];
    }
  }
  return next;
}

async function prepare(options: SelectionOptions, edit: Edit): Promise<PreparedSelection> {
  checkCancelled(options);
  const target = await selectTarget(options, edit);
  const snapshot = await readSelectionManifest(target.root);
  if (!snapshot.exists && edit.operation !== "init")
    fail("E_MANIFEST_MISSING", "This scope has no selection manifest.", {
      path: snapshot.path,
      scope: target.scope,
      fix: `Run skillex init --scope ${target.scope}${target.scope === "project" ? " --project PATH" : ""} before changing selections.`,
    });
  const candidate =
    snapshot.raw && snapshot.manifest
      ? propose(snapshot.raw, snapshot.manifest, edit)
      : { inherit_global: target.scope === "project" };
  const proposed = parseManifest(candidate, snapshot.path);
  const changed =
    !snapshot.exists || JSON.stringify(proposed) !== JSON.stringify(snapshot.manifest);
  const raw = changed ? candidate : (snapshot.raw ?? candidate);
  const syncOptions: SyncOptions = {
    ...options,
    home: target.home,
    scope: target.scope,
    ...(target.scope === "project" ? { project: target.root } : {}),
  };
  const changes: SelectionChange[] = changed
    ? [{ scope: target.scope, action: "write-manifest", path: snapshot.path }]
    : [];
  let findings: readonly Diagnostic[] = [];
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
    try {
      const activation = await prepareSyncUnlocked(syncOptions, new Map([[snapshot.path, raw]]));
      changes.push(...activation.plan.changes);
      findings = activation.findings;
    } catch (error) {
      if (edit.operation === "disable" && edit.kind === "skill" && error instanceof SkillexError) {
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
  checkCancelled(options, snapshot.path);
  return { target, snapshot, raw, changed, changes, syncOptions, findings };
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
  return makeResult(command, resultData(prepared, options, saved, applied), {
    exit:
      issue.exit === ExitCode.INTERRUPTED
        ? ExitCode.INTERRUPTED
        : saved
          ? ExitCode.PARTIAL
          : issue.exit,
    findings: [
      ...issue.findings,
      ...(saved
        ? [
            {
              code: "E_SELECTION_PARTIAL" as const,
              severity: "error" as const,
              message: "Selection intent was saved, but the command did not finish applying it.",
              path: prepared.snapshot.path,
              fix:
                command === "init"
                  ? "Retry init to verify the saved declaration; run sync when ready to activate it."
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
): Promise<ResultEnvelope<SelectionResult | null>> {
  const command = edit.operation;
  try {
    const initial = await prepare(options, edit);
    if (options.dryRun || !initial.changes.length)
      return makeResult(command, resultData(initial, options, false, []), {
        findings: initial.findings,
      });
    let outcome: ResultEnvelope<SelectionResult | null> | undefined;
    try {
      return await withLock(
        "skillex:activation:v2",
        async () => {
          const current = await prepare(options, edit);
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
