import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { canonicalSkill } from "./composition.js";
import type {
  CompositionChange,
  CompositionDetails,
  CompositionMutationData,
  CompositionOptions,
} from "./composition-types.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { parseManifest } from "./manifest.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";

interface LinkIdentity {
  readonly info: Stats;
  readonly raw: string;
  readonly target: string;
}

export interface CompositionPlan {
  readonly registry: RegistrySelection;
  readonly composition: CompositionDetails;
  readonly dryRun: boolean;
  readonly changes: CompositionChange[];
  readonly directories: Map<string, Stats>;
  readonly links: Map<string, LinkIdentity>;
  manifest?: { path: string; bytes: Buffer; before?: { bytes: Buffer; info: Stats } };
}

export function compositionError<T>(command: string, error: unknown): ResultEnvelope<T | null> {
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
              fix: "Check the composition paths and filesystem permissions, then retry.",
            },
          ],
  });
}

export function conflict(
  path: string,
  message = "Composition content conflicts with the canonical reference.",
): never {
  fail(
    "E_COMPOSITION_CONFLICT",
    message,
    {
      path,
      fix: "Inspect and migrate the conflicting content; ordinary composition commands do not replace foreign entries.",
    },
    ExitCode.REFUSED,
  );
}

export async function requestedSkills(
  registry: string,
  names: readonly string[],
  path: string,
): Promise<Map<string, string>> {
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    fail("E_SKILL_NAME", "Requested skills must be an array of canonical names.", {
      path,
      fix: "Pass canonical lowercase names from all-skills.",
    });
  }
  const selected = parseManifest({ skills: names }, path).skills;
  const targets = new Map<string, string>();
  for (const { name } of selected) targets.set(name, await canonicalSkill(registry, name));
  return targets;
}

export async function newPlan(
  registry: RegistrySelection,
  composition: CompositionDetails,
  dryRun: boolean,
): Promise<CompositionPlan> {
  const info = await lstat(registry.root);
  if (!info.isDirectory()) conflict(registry.root);
  return {
    registry,
    composition,
    dryRun,
    changes: [],
    directories: new Map([[registry.root, info]]),
    links: new Map(),
  };
}

export async function planDirectory(plan: CompositionPlan, path: string): Promise<void> {
  if (
    plan.directories.has(path) ||
    plan.changes.some((change) => change.action === "create-directory" && change.path === path)
  )
    return;
  const parent = dirname(path);
  if (parent === path) conflict(path, "Composition path escaped its selected registry.");
  await planDirectory(plan, parent);
  const info = await inspectPath(path);
  if (info) {
    if (!info.isDirectory()) conflict(path, "Composition directories must be real directories.");
    plan.directories.set(path, info);
  } else {
    plan.changes.push({ action: "create-directory", path });
  }
}

export async function inspectCanonicalLink(
  plan: CompositionPlan,
  path: string,
  target: string,
): Promise<boolean> {
  const info = await inspectPath(path);
  if (!info) return false;
  if (!info.isSymbolicLink()) conflict(path);
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    conflict(path, "Composition link is dangling or cannot be resolved.");
  }
  if (resolved !== target) conflict(path);
  plan.links.set(path, { info, raw: await readlink(path), target });
  return true;
}

export async function planLink(plan: CompositionPlan, path: string, target: string): Promise<void> {
  if (!(await inspectCanonicalLink(plan, path, target)))
    plan.changes.push({ action: "create-link", path, target });
}

export async function planUnlink(
  plan: CompositionPlan,
  path: string,
  target: string,
): Promise<void> {
  if (await inspectCanonicalLink(plan, path, target))
    plan.changes.push({ action: "remove-link", path, target });
}

async function sameDirectory(path: string, expected: Stats): Promise<void> {
  const actual = await inspectPath(path);
  if (!actual?.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino)
    conflict(path, "A composition directory changed during the operation.");
}

async function sameLink(path: string, expected: LinkIdentity): Promise<void> {
  const actual = await inspectPath(path);
  if (
    !actual?.isSymbolicLink() ||
    actual.dev !== expected.info.dev ||
    actual.ino !== expected.info.ino ||
    (await readlink(path)) !== expected.raw
  )
    conflict(path, "A composition link changed during the operation.");
}

async function parents(plan: CompositionPlan, path: string): Promise<void> {
  let current = dirname(path);
  while (true) {
    const info = plan.directories.get(current);
    if (!info)
      conflict(current, "The composition parent directory is not owned by this operation.");
    await sameDirectory(current, info);
    if (current === plan.registry.root) return;
    current = dirname(current);
  }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function saveManifest(plan: CompositionPlan, changed: () => void): Promise<void> {
  const manifest = plan.manifest;
  if (!manifest) return;
  const verify = async () => {
    await parents(plan, manifest.path);
    const info = await inspectPath(manifest.path);
    if (manifest.before) {
      if (
        !info?.isFile() ||
        info.dev !== manifest.before.info.dev ||
        info.ino !== manifest.before.info.ino ||
        !(await readFile(manifest.path)).equals(manifest.before.bytes)
      )
        conflict(manifest.path, "The pack declaration changed while writing was being planned.");
    } else if (info) conflict(manifest.path, "A pack manifest appeared during creation.");
  };
  await verify();
  const temporary = join(dirname(manifest.path), `.pack.toml.${randomUUID()}.tmp`);
  let madeTemporary = false;
  try {
    const file = await open(
      temporary,
      "wx",
      manifest.before ? manifest.before.info.mode & 0o777 : 0o644,
    );
    madeTemporary = true;
    changed();
    try {
      await file.writeFile(manifest.bytes);
      await file.chmod(manifest.before ? manifest.before.info.mode & 0o777 : 0o644);
      await file.sync();
    } finally {
      await file.close();
    }
    await verify();
    if (manifest.before) await rename(temporary, manifest.path);
    else await link(temporary, manifest.path);
  } finally {
    if (madeTemporary) await removeTemporary(temporary);
  }
}

function data(plan: CompositionPlan): CompositionMutationData {
  return {
    registry: plan.registry,
    composition: plan.composition,
    dryRun: plan.dryRun,
    changes: plan.changes,
  };
}

async function apply(
  command: string,
  plan: CompositionPlan,
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  let wrote = false;
  try {
    for (const [path, info] of plan.directories) await sameDirectory(path, info);
    for (const [path, info] of plan.links) await sameLink(path, info);
    for (const change of plan.changes.filter((change) => change.action === "create-directory")) {
      await parents(plan, change.path);
      await mkdir(change.path, { mode: 0o755 });
      wrote = true;
      plan.directories.set(change.path, await lstat(change.path));
    }
    // Persist the desired membership first. Missing links then remain repairable
    // from the declaration, and explicit removals can safely finish on retry.
    await saveManifest(plan, () => {
      wrote = true;
    });
    for (const change of plan.changes.filter((change) => change.action === "create-link")) {
      await parents(plan, change.path);
      if (await inspectPath(change.path)) conflict(change.path);
      const target = await canonicalSkill(plan.registry.root, basename(change.path));
      if (target !== change.target)
        conflict(change.path, "The canonical source changed during the operation.");
      await symlink(relative(dirname(change.path), target), change.path);
      wrote = true;
    }
    for (const change of plan.changes.filter((change) => change.action === "remove-link")) {
      await parents(plan, change.path);
      const expected = plan.links.get(change.path);
      if (!expected) conflict(change.path);
      await sameLink(change.path, expected);
      await unlink(change.path);
      wrote = true;
    }
    return makeResult(command, data(plan));
  } catch (error) {
    if (!wrote) return compositionError(command, error);
    return makeResult(command, data(plan), {
      exit: ExitCode.PARTIAL,
      findings: [
        {
          code: "E_COMPOSITION_PARTIAL",
          severity: "error",
          message: `Composition changes started but did not finish: ${error instanceof Error ? error.message : String(error)}`,
          path: plan.composition.path,
          fix:
            plan.composition.kind === "pack"
              ? "Inspect the partial state; no rollback was attempted. If pack.toml exists, repeat this command to repair missing links or finish explicit removals. If creation stopped before pack.toml was published, inspect and remove only empty partial directories before retrying create. Migrate conflicting foreign content explicitly."
              : "Inspect the partial state and repeat this command to finish the requested links; no rollback was attempted. Migrate conflicting foreign content explicitly.",
        },
      ],
    });
  }
}

export async function mutateComposition(
  command: string,
  options: CompositionOptions,
  prepare: () => Promise<CompositionPlan>,
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  try {
    const initial = await prepare();
    if (initial.dryRun || initial.changes.length === 0) return makeResult(command, data(initial));
    let outcome: ResultEnvelope<CompositionMutationData | null> | undefined;
    try {
      return await withLock(
        `${initial.registry.root}#compositions`,
        async () => {
          const current = await prepare();
          if (current.registry.root !== initial.registry.root)
            conflict(
              current.registry.root,
              "Registry discovery changed after the composition lock was selected.",
            );
          outcome = await apply(command, current);
          return outcome;
        },
        options,
      );
    } catch (error) {
      if (!outcome?.data) throw error;
      const cleanup = compositionError(command, error);
      return makeResult(command, outcome.data, {
        exit: ExitCode.PARTIAL,
        findings: [...outcome.findings, ...cleanup.findings],
      });
    }
  } catch (error) {
    return compositionError(command, error);
  }
}

export function listOutcome<T>(
  command: string,
  value: T,
  failures: readonly SkillexError[],
  count: number,
): ResultEnvelope<T> {
  const findings: Diagnostic[] = failures.flatMap((error) => [...error.findings]);
  return makeResult(command, value, {
    exit: failures.length
      ? count
        ? ExitCode.PARTIAL
        : (failures[0]?.exit ?? ExitCode.FAILURE)
      : ExitCode.SUCCESS,
    findings,
  });
}

export function collectedError(error: unknown, path: string): SkillexError {
  if (error instanceof SkillexError) return error;
  return new SkillexError(ExitCode.FAILURE, [
    {
      code: "E_IO",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      path,
      fix: "Inspect the composition and its filesystem permissions.",
    },
  ]);
}
