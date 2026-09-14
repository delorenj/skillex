import type { Command } from "commander";
import {
  addPackSkills,
  addSetSkills,
  type CompositionDetails,
  createPack,
  createSet,
  listPacks,
  listSets,
  type RegistryOptions,
  type ResultEnvelope,
  removePackSkills,
  removeSetSkills,
  showPack,
  showSet,
  verifyPack,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

interface Options {
  registryRoot?: string;
  dryRun?: boolean;
  description?: string;
  version?: string;
}

function registryOptions(command: Command): RegistryOptions {
  const { registryRoot } = command.optsWithGlobals<Options>();
  return registryRoot === undefined ? {} : { registryRoot };
}

function mutationOptions(command: Command) {
  const { dryRun, description } = command.optsWithGlobals<Options>();
  return {
    ...registryOptions(command),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(description === undefined ? {} : { description }),
  };
}

function identity(composition: CompositionDetails): string {
  return `${composition.name}${composition.version ? `@${composition.version}` : ""}`;
}

function listText(items: readonly CompositionDetails[], kind: string): string {
  return items.length
    ? items
        .map((item) => `${identity(item)}\t${item.skills.length} skills\t${item.path}\n`)
        .join("")
    : `No ${kind}.\n`;
}

function showText(item: CompositionDetails): string {
  return [
    identity(item),
    `Path: ${item.path}`,
    ...(item.description ? [`Description: ${item.description}`] : []),
    `Skills: ${item.skills.length}`,
    ...item.skills.map((skill) => `  ${skill.name}\t${skill.path}`),
    "",
  ].join("\n");
}

function mutationText(
  data: {
    readonly composition: CompositionDetails;
    readonly dryRun: boolean;
    readonly changes: readonly {
      readonly action: string;
      readonly path: string;
      readonly target?: string;
    }[];
  } | null,
  complete: boolean,
): string {
  if (!data) return "";
  if (complete && data.changes.length === 0)
    return `${identity(data.composition)} is up to date.\n`;
  const outcome = data.dryRun ? "Planned changes for" : complete ? "Updated" : "Partially updated";
  const summary = `${outcome} ${identity(data.composition)} at ${data.composition.path}\n`;
  return data.dryRun
    ? summary +
        data.changes
          .map(
            (change) =>
              `  ${change.action}: ${change.path}${change.target ? ` -> ${change.target}` : ""}\n`,
          )
          .join("")
    : summary;
}

/** Register reference composition operations; shared core functions own all IO. */
export function registerCompositionCommands(program: Command, output: Output): void {
  const set = program
    .command("set")
    .description("Manage composable canonical references under the registry's sets/ directory.")
    .action(() => output.help(set));
  set
    .command("list")
    .description("List available sets and their canonical members.")
    .action(async (_options, command: Command) => {
      const result = await listSets(registryOptions(command));
      output.emit(result, result.data ? listText(result.data.sets, "sets") : "");
    });
  set
    .command("show <name>")
    .description("Inspect a set and the canonical definitions it references.")
    .action(async (name: string, _options, command: Command) => {
      const result = await showSet(name, registryOptions(command));
      output.emit(result, result.data ? showText(result.data.set) : "");
    });
  set
    .command("create <name>")
    .description("Create a reference-only set in the selected registry.")
    .option("--dry-run", "Validate and show the intended source changes.")
    .action(async (name: string, _options, command: Command) => {
      const result = await createSet(name, mutationOptions(command));
      output.emit(result, mutationText(result.data, result.ok));
    });
  for (const action of ["add", "remove"] as const) {
    set
      .command(`${action} <name> <skills...>`)
      .description(
        `${action === "add" ? "Add canonical references to" : "Remove canonical references from"} a set.`,
      )
      .option("--dry-run", "Validate and show the complete membership plan.")
      .action(async (name: string, skills: string[], _options, command: Command) => {
        const operation = action === "add" ? addSetSkills : removeSetSkills;
        const result = await operation(name, skills, mutationOptions(command));
        output.emit(result, mutationText(result.data, result.ok));
      });
  }

  const pack = program
    .command("pack")
    .description("Manage versioned exclusive loadouts under the registry's packs/ directory.")
    .action(() => output.help(pack));
  pack
    .command("list")
    .description("List available pack versions and their canonical members.")
    .action(async (_options, command: Command) => {
      const result = await listPacks(registryOptions(command));
      output.emit(result, result.data ? listText(result.data.packs, "packs") : "");
    });
  pack
    .command("show <ref>")
    .description("Inspect NAME or NAME@VERSION; an unpinned name selects its latest local version.")
    .action(async (ref: string, _options, command: Command) => {
      const result = await showPack(ref, registryOptions(command));
      output.emit(result, result.data ? showText(result.data.pack) : "");
    });
  pack
    .command("create <name>")
    .description("Create a reference-only pack version with an authoritative membership manifest.")
    .requiredOption("--version <version>", "Composition version to create.")
    .option("--description <text>", "Describe this complete skill loadout.")
    .option("--dry-run", "Validate and show the intended source changes.")
    .action(async (name: string, _options, command: Command) => {
      const { version } = command.optsWithGlobals<Options>();
      const result = await createPack(name, version ?? "", mutationOptions(command));
      output.emit(result, mutationText(result.data, result.ok));
    });
  for (const action of ["add", "remove"] as const) {
    pack
      .command(`${action} <ref> <skills...>`)
      .description(
        `${action === "add" ? "Add" : "Remove"} canonical members and update this pack's reference links.`,
      )
      .option("--dry-run", "Validate and show the complete manifest and link plan.")
      .action(async (ref: string, skills: string[], _options, command: Command) => {
        const operation = action === "add" ? addPackSkills : removePackSkills;
        const result = await operation(ref, skills, mutationOptions(command));
        output.emit(result, mutationText(result.data, result.ok));
      });
  }
  pack
    .command("verify <ref>")
    .description(
      "Check canonical ownership and agreement between the manifest and generated links.",
    )
    .action(async (ref: string, _options, command: Command) => {
      const result = await verifyPack(ref, registryOptions(command));
      output.emit(
        result,
        result.data ? `${result.ok ? "Verified " : ""}${showText(result.data.pack)}` : "",
      );
    });
}
