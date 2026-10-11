import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setMembers, setMemberTarget } from "./composition.js";
import {
  collectedError,
  compositionError,
  conflict,
  inspectCanonicalLink,
  listOutcome,
  mutateComposition,
  newPlan,
  planDirectory,
  planLink,
  planUnlink,
  requestedSkills,
} from "./composition-mutation.js";
import type {
  CompositionDetails,
  CompositionMutationData,
  CompositionOptions,
  SetListData,
  SetShowData,
} from "./composition-types.js";
import { discoverRegistry } from "./discovery.js";
import type { SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import {
  executeImports,
  planSourceMembers,
  provenanceFrom,
  releaseInventory,
  resolveMemberTargets,
  type SourceMembershipPlan,
} from "./import-sources.js";
import { parseManifest } from "./manifest.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import { readSetOrigin, SET_ORIGIN_FILE, setOriginDocument } from "./set-origin.js";

export interface CreateSetOptions extends CompositionOptions {
  /** Existing local skill root whose entries become member references. */
  readonly fromRoot?: string;
  /** Repeatable explicit sources: existing paths or Git remotes. */
  readonly from?: readonly string[];
  /** Import source skills that have no canonical definition instead of refusing. */
  readonly import?: boolean;
}

function validateName(name: string): void {
  parseManifest({ sets: [{ name }] }, "set name");
}

async function readSet(registry: string, name: string): Promise<CompositionDetails> {
  validateName(name);
  const inventory = await setMembers(registry, name);
  const skills = [];
  for (const member of inventory.names) {
    skills.push({ name: member, path: await setMemberTarget(registry, inventory.path, member) });
  }
  return { kind: "set", name, path: inventory.path, skills };
}

export async function listSets(
  options: CompositionOptions = {},
): Promise<ResultEnvelope<SetListData | null>> {
  const command = "set list";
  try {
    const registry = await discoverRegistry(options);
    const path = join(registry.root, "sets");
    const sets: CompositionDetails[] = [];
    const failures: SkillexError[] = [];
    if (await inspectPath(path)) {
      await requireDirectory(path, "E_SET_MISSING");
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (
          entry.name.startsWith(".") ||
          entry.name.startsWith("_") ||
          (!entry.isDirectory() && !entry.isSymbolicLink())
        )
          continue;
        try {
          sets.push(await readSet(registry.root, entry.name));
        } catch (error) {
          failures.push(collectedError(error, join(path, entry.name)));
        }
      }
    }
    return listOutcome(command, { registry, sets }, failures, sets.length);
  } catch (error) {
    return compositionError(command, error);
  }
}

export async function showSet(
  name: string,
  options: CompositionOptions = {},
): Promise<ResultEnvelope<SetShowData | null>> {
  const command = "set show";
  try {
    validateName(name);
    const registry = await discoverRegistry(options);
    return makeResult(command, { registry, set: await readSet(registry.root, name) });
  } catch (error) {
    return compositionError(command, error);
  }
}

/**
 * Destination admission for source-backed creation: the requested name must
 * be valid, and an existing set must be fully explained by the sources —
 * every member claimed, recorded provenance agreeing. Runs unlocked as a
 * preflight before any catalog write, and again inside composition planning
 * under the lock.
 */
async function setAdmission(
  registry: string,
  name: string,
  source: SourceMembershipPlan,
): Promise<void> {
  validateName(name);
  const path = join(registry, "sets", name);
  if (!(await inspectPath(path))) return;
  // A repeated source-backed create must be a write-free no-op (or finish
  // links an interrupted run left missing); members the sources do not
  // explain are a named refusal, never a silent membership edit.
  const current = await readSet(registry, name);
  const wanted = new Set(source.members);
  const unexpected = current.skills.filter((skill) => !wanted.has(skill.name));
  if (unexpected.length)
    conflict(
      path,
      `Source-backed creation found existing members outside the sources (${unexpected
        .map((skill) => skill.name)
        .join(", ")}); use set remove or a new name.`,
    );
  if (source.provenance !== undefined) {
    const originPath = join(path, SET_ORIGIN_FILE);
    if (await inspectPath(originPath)) {
      // Identity is the source list; the historical `imported` outcome of the
      // first run is not part of it, so a repeat that imports nothing matches.
      const existing = await readSetOrigin(path);
      if (
        JSON.stringify(existing?.provenance?.sources ?? null) !==
        JSON.stringify(source.provenance.sources ?? null)
      )
        conflict(originPath, "Set origin metadata already exists with different sources.");
    }
  }
}

async function prepareSet(
  name: string,
  names: readonly string[],
  operation: "create" | "add" | "remove",
  options: CompositionOptions,
  source?: SourceMembershipPlan,
) {
  validateName(name);
  const registry = await discoverRegistry(options);
  const path = join(registry.root, "sets", name);
  if (source !== undefined) await setAdmission(registry.root, name, source);
  const exists = await inspectPath(path);
  const previous =
    operation === "create" && !exists
      ? { kind: "set" as const, name, path, skills: [] }
      : await readSet(registry.root, name);
  const requested =
    source !== undefined
      ? await resolveMemberTargets(registry.root, source.members, path, source.pending)
      : await requestedSkills(registry.root, names, path);
  const desired = new Map(previous.skills.map((skill) => [skill.name, skill.path]));
  for (const [member, target] of requested) {
    if (operation === "add" || source !== undefined) desired.set(member, target);
    else if (operation === "remove") desired.delete(member);
  }
  const composition: CompositionDetails = {
    ...previous,
    skills: [...desired]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([member, target]) => ({ name: member, path: target })),
  };
  const plan = await newPlan(registry, composition, options.dryRun === true);
  await planDirectory(plan, path);
  if (source?.provenance !== undefined) {
    // Record how this set was derived; a differing existing story was already
    // refused by admission, so only an absent sidecar gets planned here.
    const originPath = join(path, SET_ORIGIN_FILE);
    if (!(await inspectPath(originPath))) {
      plan.origin = {
        path: originPath,
        bytes: Buffer.from(setOriginDocument({ schema: 1, provenance: source.provenance })),
      };
      plan.changes.push({ action: "write-origin", path: originPath });
    }
  }
  for (const skill of previous.skills)
    await inspectCanonicalLink(plan, join(path, skill.name), skill.path);
  for (const [member, target] of requested) {
    if (operation === "add" || source !== undefined)
      await planLink(plan, join(path, member), target);
    else if (operation === "remove") await planUnlink(plan, join(path, member), target);
  }
  return plan;
}

export async function createSet(
  name: string,
  options: CreateSetOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  const command = "set create";
  if (options.fromRoot === undefined && (options.from?.length ?? 0) === 0)
    return mutateComposition(command, options, () => prepareSet(name, [], "create", options));
  try {
    const registry = await discoverRegistry(options);
    // Phase 1 — acquire everything and validate every import write-free.
    const planned = await planSourceMembers(registry.root, options);
    try {
      if (planned.findings.some((finding) => finding.severity === "error"))
        return makeResult(command, null, { exit: ExitCode.REFUSED, findings: planned.findings });
      // Phase 2 — preflight the destination before any catalog write: the
      // creation name and any existing membership/provenance must admit this
      // composition, or we refuse without having imported anything.
      const provisional: SourceMembershipPlan = {
        members: planned.names,
        pending: planned.pending,
        provenance: await provenanceFrom(planned.inventories, [...planned.pending.keys()].sort()),
      };
      await setAdmission(registry.root, name, provisional);
      // Phase 3 — execute the imports for real, disclosing partial survival
      // truthfully instead of rolling back or hiding it.
      const executed: string[] = [];
      if (options.dryRun !== true && planned.imports.length > 0) {
        const outcome = await executeImports(planned.imports, options);
        if (outcome.findings.length > 0)
          return makeResult(command, null, {
            exit: ExitCode.REFUSED,
            findings: [...planned.findings, ...outcome.findings],
          });
        executed.push(...outcome.executed.map((item) => item.name));
      }
      // Phase 4 — compose. Dry-run keeps planned destinations; a real run
      // resolves every member against the catalog it just wrote.
      const source: SourceMembershipPlan = {
        members: planned.names,
        pending: options.dryRun === true ? planned.pending : new Map(),
        provenance: await provenanceFrom(
          planned.inventories,
          options.dryRun === true ? [...planned.pending.keys()].sort() : executed,
        ),
      };
      return await mutateComposition(command, options, () =>
        prepareSet(name, [], "create", options, source),
      ).then((result) =>
        result.ok ? makeResult(command, result.data, { findings: planned.findings }) : result,
      );
    } finally {
      for (const inventory of planned.inventories) await releaseInventory(inventory);
    }
  } catch (error) {
    return compositionError(command, error);
  }
}

export async function addSetSkills(
  name: string,
  names: readonly string[],
  options: CompositionOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  return mutateComposition("set add", options, () => prepareSet(name, names, "add", options));
}

export async function removeSetSkills(
  name: string,
  names: readonly string[],
  options: CompositionOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  return mutateComposition("set remove", options, () => prepareSet(name, names, "remove", options));
}
