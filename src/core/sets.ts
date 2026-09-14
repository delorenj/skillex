import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setMembers, setMemberTarget } from "./composition.js";
import {
  collectedError,
  compositionError,
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
import { parseManifest } from "./manifest.js";
import { makeResult, type ResultEnvelope } from "./result.js";

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

async function prepareSet(
  name: string,
  names: readonly string[],
  operation: "create" | "add" | "remove",
  options: CompositionOptions,
) {
  validateName(name);
  const registry = await discoverRegistry(options);
  const path = join(registry.root, "sets", name);
  const exists = await inspectPath(path);
  const previous =
    operation === "create" && !exists
      ? { kind: "set" as const, name, path, skills: [] }
      : await readSet(registry.root, name);
  const requested = await requestedSkills(registry.root, names, path);
  const desired = new Map(previous.skills.map((skill) => [skill.name, skill.path]));
  for (const [member, target] of requested) {
    if (operation === "add") desired.set(member, target);
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
  for (const skill of previous.skills)
    await inspectCanonicalLink(plan, join(path, skill.name), skill.path);
  for (const [member, target] of requested) {
    if (operation === "add") await planLink(plan, join(path, member), target);
    else if (operation === "remove") await planUnlink(plan, join(path, member), target);
  }
  return plan;
}

export async function createSet(
  name: string,
  options: CompositionOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  return mutateComposition("set create", options, () => prepareSet(name, [], "create", options));
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
