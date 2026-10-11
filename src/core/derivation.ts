import type { Stats } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalSkill, packInventory, setMembers, setMemberTarget } from "./composition.js";
import {
  type CompositionPlan,
  compositionError,
  conflict,
  inspectCanonicalLink,
  mutateComposition,
  newPlan,
  planDirectory,
  planLink,
  planUnlink,
} from "./composition-mutation.js";
import type {
  CompositionChange,
  CompositionDetails,
  CompositionMutationData,
  CompositionOptions,
} from "./composition-types.js";
import { discoverRegistry } from "./discovery.js";
import { fail } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { parseManifest } from "./manifest.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection, ScopeName } from "./selection.js";
import {
  type DerivedSetDeclaration,
  derivedSetName,
  readSetOrigin,
  SET_ORIGIN_FILE,
  type SetOrigin,
  setOriginDocument,
} from "./set-origin.js";

export interface DerivationOwner {
  readonly scope: ScopeName;
  readonly root: string;
}

export interface DerivationInputs {
  readonly base: string | null;
  readonly packs: readonly string[];
  readonly skills: readonly string[];
  readonly removed: readonly string[];
}

export interface DerivationPreview {
  readonly registry: RegistrySelection;
  readonly owner: DerivationOwner;
  readonly name: string;
  readonly path: string;
  readonly inputs: DerivationInputs;
  readonly members: readonly { readonly name: string; readonly path: string }[];
  readonly creates: boolean;
  readonly changes: readonly CompositionChange[];
}

function parsePackRef(reference: string): { name: string; version?: string } {
  const selected = parseManifest({ packs: [reference] }, "derived pack reference").packs[0];
  if (!selected)
    fail("E_PACK_NAME", "A pack reference is required.", { fix: "Pass NAME or NAME@VERSION." });
  return {
    name: selected.name,
    ...(selected.version === undefined ? {} : { version: selected.version }),
  };
}

/** Membership a derived set must materialize: base ∪ packs ∪ skills − removed. */
export async function desiredDerivedMembers(
  registry: string,
  inputs: DerivationInputs,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  parseManifest(
    {
      sets: inputs.base === null ? [] : [inputs.base],
      packs: inputs.packs,
      skills: inputs.skills,
      exclude: inputs.removed,
    },
    "derived set inputs",
  );
  const members = new Map<string, string>();
  const add = async (name: string, target: string) => {
    const existing = members.get(name);
    if (existing && existing !== target)
      fail(
        "E_DIVERGENT_CANONICAL_NAME",
        `Canonical name ${name} resolves to different definitions across the derived selection.`,
        {
          name,
          path: target,
          detail: [`earlier ${existing}`, `later ${target}`],
          fix: "Select one canonical definition for this name in the base set, packs, and skills.",
        },
        ExitCode.REFUSED,
      );
    members.set(name, target);
  };
  if (inputs.base) {
    if (ancestors.has(inputs.base))
      fail(
        "E_SET_DRIFT",
        `Derived-set bases contain a cycle at ${inputs.base}.`,
        {
          path: join(registry, "sets", inputs.base),
          fix: "Correct the derivation's base selection before resolving or repairing it.",
        },
        ExitCode.REFUSED,
      );
    const inventory = await setMembers(registry, inputs.base);
    const origin = await readSetOrigin(inventory.path);
    if (origin?.derived) await verifyDerivedMembers(registry, inventory, origin.derived, ancestors);
    for (const name of inventory.names)
      await add(name, await setMemberTarget(registry, inventory.path, name));
  }
  for (const reference of inputs.packs) {
    const selected = parsePackRef(reference);
    const inventory = await packInventory(registry, { ...selected, optional: false });
    for (const name of inventory.names) await add(name, await canonicalSkill(registry, name));
  }
  for (const name of inputs.skills) await add(name, await canonicalSkill(registry, name));
  for (const name of inputs.removed) members.delete(name);
  return members;
}

/** Validate the complete derived projection, not just the links that survived. */
export async function verifyDerivedMembers(
  registry: string,
  inventory: { readonly path: string; readonly names: readonly string[] },
  derived: DerivedSetDeclaration,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  const name = basename(inventory.path);
  const expected = await desiredDerivedMembers(registry, derived, new Set([...ancestors, name]));
  const actual = new Set(inventory.names);
  const missing = [...expected.keys()].filter((member) => !actual.has(member)).sort();
  const unexpected = [...actual].filter((member) => !expected.has(member)).sort();
  if (missing.length || unexpected.length)
    fail(
      "E_SET_DRIFT",
      `Derived set ${name} does not match its base, packs, skills and exclusions.`,
      {
        path: inventory.path,
        detail: [
          ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
          ...(unexpected.length ? [`unexpected: ${unexpected.join(", ")}`] : []),
        ],
        fix: "Re-run the owning scope's skillex enable/disable command, or preview skillex normalize to repair the saved derivation. Base changes and unversioned pack advances require explicit repair.",
      },
      ExitCode.REFUSED,
    );
  for (const member of actual) await setMemberTarget(registry, inventory.path, member);
}

function declarationFor(owner: DerivationOwner, inputs: DerivationInputs): DerivedSetDeclaration {
  return {
    owner: { scope: owner.scope, root: owner.root },
    base: inputs.base,
    packs: [...inputs.packs],
    skills: [...inputs.skills],
    removed: [...inputs.removed],
  };
}

/** Read the current derivation state of a set, if it is a derived set at all. */
export async function derivedState(
  registry: string,
  name: string,
): Promise<
  | { path: string; origin: SetOrigin & { derived: DerivedSetDeclaration }; members: string[] }
  | undefined
> {
  const info = await inspectPath(join(registry, "sets", name));
  if (!info) return undefined;
  const inventory = await setMembers(registry, name);
  const origin = await readSetOrigin(inventory.path);
  const derived = origin?.derived;
  if (!origin || !derived) return undefined;
  const narrowed: SetOrigin & { derived: DerivedSetDeclaration } = { ...origin, derived };
  return { path: inventory.path, origin: narrowed, members: inventory.names };
}

/** The name of the derived set this scope owns for the given base. */
export function ownedDerivedName(base: string | null, ownerRoot: string): string {
  return derivedSetName(base, ownerRoot);
}

/**
 * Plan the derived set a scope owns. Never writes; refuses when the target name
 * holds anything other than this owner's own derived set.
 */
async function buildDerivedPlan(
  options: CompositionOptions & { owner: DerivationOwner; inputs: DerivationInputs },
): Promise<{ preview: DerivationPreview; plan: CompositionPlan }> {
  const registry = await discoverRegistry(options);
  const { owner, inputs } = options;
  const name = derivedSetName(inputs.base, owner.root);
  const path = join(registry.root, "sets", name);
  const desired = await desiredDerivedMembers(registry.root, inputs);
  const members = [...desired]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([member, target]) => ({ name: member, path: target }));
  const composition: CompositionDetails = { kind: "set", name, path, skills: members };
  const plan: CompositionPlan = await newPlan(registry, composition, options.dryRun === true);
  await planDirectory(plan, path);
  const existing = await derivedState(registry.root, name);
  const occupied = await inspectPath(path);
  if (occupied && !existing)
    conflict(path, `Set ${name} already exists and is not a derived set owned by this scope.`);
  if (existing) {
    const declared = existing.origin.derived;
    if (declared.owner.scope !== owner.scope || declared.owner.root !== owner.root)
      conflict(path, `Derived set ${name} belongs to a different scope.`);
    for (const member of existing.members) {
      const current = desired.has(member)
        ? (desired.get(member) as string)
        : await setMemberTarget(registry.root, path, member);
      await inspectCanonicalLink(plan, join(path, member), current);
      if (desired.has(member)) await planLink(plan, join(path, member), current);
      else await planUnlink(plan, join(path, member), current);
    }
  }
  for (const [member, target] of desired)
    if (!existing?.members.includes(member)) await planLink(plan, join(path, member), target);
  const nextOrigin: SetOrigin = {
    schema: 1,
    derived: declarationFor(owner, inputs),
    ...(existing?.origin.provenance === undefined
      ? {}
      : { provenance: existing.origin.provenance }),
  };
  const originPath = join(path, SET_ORIGIN_FILE);
  const bytes = Buffer.from(setOriginDocument(nextOrigin));
  const before = await inspectPath(originPath);
  const previous = before?.isFile()
    ? { bytes: Buffer.from(await readFile(originPath)), info: await lstat(originPath) }
    : undefined;
  // Attach the sidecar write only when its bytes actually differ (or it is
  // new): drifted metadata is repaired even when membership already matches,
  // and identical metadata keeps its inode even when member links are repaired.
  if (!before || !previous?.bytes.equals(bytes)) {
    plan.origin = {
      path: originPath,
      bytes,
      ...(previous === undefined ? {} : { before: previous }),
    };
    plan.changes.push({ action: "write-origin", path: originPath });
  }
  const preview: DerivationPreview = {
    registry,
    owner,
    name,
    path,
    inputs,
    members,
    creates: !existing,
    changes: plan.changes,
  };
  return { preview, plan };
}

/** Read-only derivation preview for command planning and dry runs. */
export async function planDerivedSet(
  options: CompositionOptions & { owner: DerivationOwner; inputs: DerivationInputs },
): Promise<DerivationPreview> {
  return (await buildDerivedPlan(options)).preview;
}

/** Materialize (or update) the scope-owned derived set. Registry-only write. */
export async function materializeDerivedSet(
  options: CompositionOptions & { owner: DerivationOwner; inputs: DerivationInputs },
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  const command = "derive set";
  try {
    return await mutateComposition(command, options, () =>
      buildDerivedPlan(options).then((r) => r.plan),
    );
  } catch (error) {
    return compositionError(command, error);
  }
}

interface RetirementSnapshot {
  readonly path: string;
  readonly directories: ReadonlyMap<string, Stats>;
  readonly origin: { readonly info: Stats; readonly bytes: Buffer };
  readonly members: ReadonlyMap<
    string,
    { readonly info: Stats; readonly raw: string; readonly target: string }
  >;
}

async function unchangedDirectory(path: string, expected: Stats): Promise<void> {
  const actual = await inspectPath(path);
  if (!actual?.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino)
    conflict(path, "A derived-set directory changed during retirement.");
}

async function verifyRetirement(
  snapshot: RetirementSnapshot,
  remaining: readonly string[],
): Promise<void> {
  for (const [path, info] of snapshot.directories) await unchangedDirectory(path, info);
  const originPath = join(snapshot.path, SET_ORIGIN_FILE);
  const origin = await inspectPath(originPath);
  if (
    !origin?.isFile() ||
    origin.dev !== snapshot.origin.info.dev ||
    origin.ino !== snapshot.origin.info.ino ||
    !(await readFile(originPath)).equals(snapshot.origin.bytes)
  )
    conflict(originPath, "The derivation owner metadata changed during retirement.");
  if (
    JSON.stringify((await readdir(snapshot.path)).sort()) !==
    JSON.stringify([SET_ORIGIN_FILE, ...remaining].sort())
  )
    conflict(
      snapshot.path,
      "Derived-set entries changed during retirement; foreign content is preserved.",
    );
  for (const member of remaining) await verifyRetirementMember(snapshot, member);
}

async function verifyRetirementMember(snapshot: RetirementSnapshot, member: string): Promise<void> {
  const path = join(snapshot.path, member);
  const expected = snapshot.members.get(member);
  const actual = await inspectPath(path);
  if (
    !expected ||
    !actual?.isSymbolicLink() ||
    actual.dev !== expected.info.dev ||
    actual.ino !== expected.info.ino ||
    (await readlink(path)) !== expected.raw ||
    (await realpath(path)) !== expected.target
  )
    conflict(path, "A derived-set member changed during retirement.");
}

async function prepareRetirement(
  registry: RegistrySelection,
  owner: DerivationOwner,
  name: string,
): Promise<RetirementSnapshot | undefined> {
  parseManifest({ sets: [name] }, "derived set retirement");
  const path = join(registry.root, "sets", name);
  const directories = new Map<string, Stats>();
  for (const directory of [registry.root, join(registry.root, "sets"), path]) {
    const info = await inspectPath(directory);
    if (!info) return undefined;
    if (!info.isDirectory())
      conflict(directory, "Derived-set retirement requires real directories.");
    directories.set(directory, info);
  }
  const originPath = join(path, SET_ORIGIN_FILE);
  const info = await inspectPath(originPath);
  if (!info?.isFile())
    conflict(originPath, "Shared or unowned sets cannot be retired as derived sets.");
  const bytes = await readFile(originPath);
  const state = await derivedState(registry.root, name);
  if (!state) conflict(path, `Set ${name} is not a derived set; it is preserved.`);
  const declared = state.origin.derived;
  if (declared.owner.scope !== owner.scope || declared.owner.root !== owner.root)
    conflict(path, `Derived set ${name} belongs to a different scope; it is preserved.`);
  const members = new Map<string, { info: Stats; raw: string; target: string }>();
  for (const member of (await readdir(path)).sort()) {
    if (member === SET_ORIGIN_FILE) continue;
    const memberPath = join(path, member);
    const entry = await inspectPath(memberPath);
    if (!entry?.isSymbolicLink()) conflict(memberPath, "Derived set contains foreign content.");
    const raw = await readlink(memberPath);
    const target = await setMemberTarget(registry.root, path, member);
    members.set(member, { info: entry, raw, target });
  }
  const snapshot = { path, directories, origin: { info, bytes }, members };
  await verifyRetirement(snapshot, [...members.keys()]);
  return snapshot;
}

/** Remove only an owned derived set, serialized with every composition writer. */
export async function retireDerivedSet(
  options: CompositionOptions,
  owner: DerivationOwner,
  name: string,
): Promise<ResultEnvelope<{ retired: string | null; removed: readonly string[] } | null>> {
  const command = "retire derived set";
  const removed: string[] = [];
  let attempted: string | undefined;
  let retired = false;
  try {
    const registry = await discoverRegistry(options);
    const initial = await prepareRetirement(registry, owner, name);
    if (!initial) return makeResult(command, { retired: name, removed });
    if (options.dryRun === true)
      return makeResult(
        command,
        { retired: null, removed },
        {
          findings: [
            {
              code: "W_RETIRE_PLANNED",
              severity: "warning",
              message: `Derived set ${name} is valid for retirement; dry-run made no changes.`,
              path: initial.path,
              fix: "Re-run without --dry-run to retire this scope-owned derived set.",
            },
          ],
        },
      );
    return await withLock(
      `${registry.root}#compositions`,
      async () => {
        // Never reuse pre-lock ownership. A writer may have changed the sidecar,
        // members or parent directories while this invocation waited its turn.
        const current = await prepareRetirement(registry, owner, name);
        if (!current) return makeResult(command, { retired: name, removed });
        const remaining = [...current.members.keys()];
        const remove = async (path: string, directory = false) => {
          attempted = path;
          try {
            if (directory) await rmdir(path);
            else await unlink(path);
          } catch (error) {
            if (!(await inspectPath(path))) removed.push(path);
            throw error;
          }
          removed.push(path);
        };
        while (remaining.length) {
          // Recheck parents, owner bytes, complete inventory and link identities
          // immediately before deletion. Like composition mutation, this guards
          // cooperating writers, not arbitrary writes in the final syscall gap.
          await verifyRetirement(current, remaining);
          const member = remaining[0] as string;
          for (const [path, info] of current.directories) await unchangedDirectory(path, info);
          await verifyRetirementMember(current, member);
          await remove(join(current.path, member));
          remaining.shift();
        }
        await verifyRetirement(current, remaining);
        await remove(join(current.path, SET_ORIGIN_FILE));
        for (const [path, info] of current.directories) await unchangedDirectory(path, info);
        if ((await readdir(current.path)).length)
          conflict(current.path, "Foreign content appeared before removing the empty derived set.");
        await remove(current.path, true);
        retired = true;
        return makeResult(command, { retired: name, removed });
      },
      options,
    );
  } catch (error) {
    const issue = compositionError<{ retired: string | null; removed: readonly string[] }>(
      command,
      error,
    );
    if (!attempted) return issue;
    return makeResult(
      command,
      { retired: retired ? name : null, removed },
      {
        exit: ExitCode.PARTIAL,
        findings: [
          ...issue.findings,
          {
            code: "E_COMPOSITION_PARTIAL",
            severity: "error",
            message:
              "Derived-set retirement started but did not finish cleanly; no rollback was attempted.",
            path: attempted,
            detail: removed.map((path) => `removed ${path}`),
            fix: "Preserve the remaining content and inspect the reported identities. Retry only after resolving the conflict; a missing owner sidecar requires explicit recovery.",
          },
        ],
      },
    );
  }
}
