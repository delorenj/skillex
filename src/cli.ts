#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { registerCompositionCommands } from "./commands/compositions.js";
import { registerSelectionCommands } from "./commands/selections.js";
import { registerSyncCommand } from "./commands/sync.js";
import {
  createSkill,
  ExitCode,
  importSkill,
  listSkills,
  makeResult,
  type RegistryOptions,
  type ResultEnvelope,
  type SkillDetails,
  SkillexError,
  showSkill,
  VERSION,
} from "./index.js";

const args = process.argv.slice(2);
const terminator = args.indexOf("--");
const flags = terminator === -1 ? args : args.slice(0, terminator);
// Commander may stop parsing at help/version or an error before seeing --json.
// Recognize this output flag first so either flag order has the same contract.
const jsonOutput = flags.includes("--json");
let output = "";
let handled = false;

const program = new Command()
  .name("skillex")
  .description("Manage the canonical skill catalog and agent activation roots.")
  .version(VERSION, "-V, --version", "Show the installed package version.")
  .option("--json", "Emit a structured result on stdout.")
  .option("--registry-root <path>", "Use this local registry checkout for catalog operations.")
  .enablePositionalOptions()
  .allowExcessArguments(false)
  .configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: () => {},
  })
  .exitOverride()
  .action(() => help(program));

function emit(result: ResultEnvelope<unknown>, text = ""): void {
  handled = true;
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    if (text) process.stdout.write(text);
    for (const finding of result.findings) {
      process.stderr.write(`${finding.code}: ${finding.message}\n`);
      if (finding.fix) process.stderr.write(`  ${finding.fix}\n`);
    }
  }
  process.exitCode = result.exit;
}

interface CliOptions {
  registryRoot?: string;
  query?: string;
  dryRun?: boolean;
  description?: string;
  name?: string;
}

function registryOptions(command: Command): RegistryOptions {
  const { registryRoot } = command.optsWithGlobals<CliOptions>();
  return registryRoot === undefined ? {} : { registryRoot };
}

function help(command: Command): void {
  const text = command.helpInformation();
  emit(makeResult("help", { help: text }), text);
}

function referenceText(skill: SkillDetails): string {
  return skill.references
    .map((ref) => `${ref.kind} ${ref.name}${ref.version ? `@${ref.version}` : ""}`)
    .join(", ");
}

function originText(skill: SkillDetails): string {
  const origin = skill.provenance?.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return "Unrecorded";
  const fields = origin as Record<string, unknown>;
  return (
    [
      fields.type,
      fields.source ??
        fields.upstream ??
        fields.imported_from ??
        fields.authored_in ??
        fields.rescued_from,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(": ") || "Unrecorded"
  );
}

function skillText(skill: SkillDetails): string {
  return [
    skill.name,
    `Path: ${skill.path}`,
    `Description: ${skill.description ?? "No description"}`,
    `References: ${referenceText(skill) || "None"}`,
    ...(skill.provenance ? [`Provenance:\n${JSON.stringify(skill.provenance, null, 2)}`] : []),
    "",
  ].join("\n");
}

const skill = program
  .command("skill")
  .description("Browse and author canonical definitions in the registry's all-skills/ catalog.")
  .action(() => help(skill));

skill
  .command("list")
  .description("List canonical names, descriptions, provenance, and composition references.")
  .option("--query <text>", "Filter canonical names and descriptions.")
  .action(async (_local, command: Command) => {
    const { query } = command.optsWithGlobals<CliOptions>();
    const result = await listSkills({
      ...registryOptions(command),
      ...(query === undefined ? {} : { query }),
    });
    const text = result.data
      ? result.data.skills
          .map(
            (entry) =>
              `${[
                entry.name,
                entry.description ?? "",
                originText(entry),
                referenceText(entry) || "None",
              ]
                .map((field) => field.replace(/\s+/g, " "))
                .join("\t")}\n`,
          )
          .join("") || "No matching skills.\n"
      : "";
    emit(result, text);
  });

skill
  .command("show <name>")
  .description(
    "Inspect a canonical definition, its provenance, and sets or packs that reference it.",
  )
  .action(async (name: string, _local, command: Command) => {
    const result = await showSkill(name, registryOptions(command));
    emit(result, result.data ? skillText(result.data.skill) : "");
  });

skill
  .command("create <name>")
  .description("Create a new canonical skill in the selected registry's all-skills/ catalog.")
  .option("--description <text>", "Describe when an agent should use this skill.")
  .option("--dry-run", "Validate and show the intended catalog changes.")
  .action(async (name: string, _local, command: Command) => {
    const { dryRun, description } = command.optsWithGlobals<CliOptions>();
    const result = await createSkill(name, {
      ...registryOptions(command),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(description === undefined ? {} : { description }),
    });
    emit(result, mutationText(result.data, result.ok));
  });

skill
  .command("import <path>")
  .description("Copy a local skill and its support files into a new canonical catalog name.")
  .requiredOption("--name <name>", "Name of the new canonical definition.")
  .option("--dry-run", "Validate and show the complete import plan.")
  .action(async (path: string, _local, command: Command) => {
    const { name, dryRun } = command.optsWithGlobals<CliOptions>();
    // Commander enforces --name before dispatching this action.
    const result = await importSkill(path, name ?? "", {
      ...registryOptions(command),
      ...(dryRun === undefined ? {} : { dryRun }),
    });
    emit(result, mutationText(result.data, result.ok));
  });

function mutationText(
  data: {
    readonly name: string;
    readonly path: string;
    readonly dryRun: boolean;
    readonly changes: readonly { readonly action: string; readonly path: string }[];
  } | null,
  complete: boolean,
): string {
  if (!data) return "";
  const outcome = data.dryRun ? "Would create" : complete ? "Created" : "Incomplete creation of";
  const summary = `${outcome} ${data.name} at ${data.path}\n`;
  return data.dryRun
    ? summary + data.changes.map((change) => `  ${change.action}: ${change.path}\n`).join("")
    : summary;
}

registerCompositionCommands(program, { emit, help });
registerSelectionCommands(program, { emit });
registerSyncCommand(program, { emit });

// Stop each parser at its subcommand so a parent cannot consume a local flag
// such as pack create --version. Repeat shared flags at each level to retain
// their supported placement before or after the command and its arguments.
function registerSharedOptions(parent: Command): void {
  for (const command of parent.commands) {
    command
      .enablePositionalOptions()
      .option("--json", "Emit a structured result on stdout.")
      .option("--registry-root <path>", "Use this local registry checkout.")
      .version(
        VERSION,
        command.options.some((option) => option.long === "--version") ? "-V" : "-V, --version",
        "Show the installed package version.",
      );
    registerSharedOptions(command);
  }
}

registerSharedOptions(program);

function parseSharedOptions(): string[] {
  // Parse shared flags once across command levels. Besides preserving their
  // last-occurrence precedence, this prevents a missing local option value
  // (for example --query --json) from consuming an output or registry flag.
  const shared = new Command()
    .option("--json")
    .option("--registry-root <path>")
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .exitOverride();
  const parsed = shared.parseOptions(flags);
  const { registryRoot } = shared.opts<CliOptions>();
  if (registryRoot !== undefined) program.setOptionValue("registryRoot", registryRoot);
  return [
    ...parsed.operands,
    ...parsed.unknown,
    ...(terminator === -1 ? [] : args.slice(terminator)),
  ];
}

try {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    emit(
      makeResult("cli", null, {
        exit: ExitCode.CONFIG,
        findings: [
          {
            code: "E_NODE_VERSION",
            severity: "error",
            message: `Node 24 or newer is required; running ${process.versions.node}.`,
            fix: "Run skillex with Node 24 or newer.",
          },
        ],
      }),
    );
  } else {
    await program.parseAsync(parseSharedOptions(), { from: "user" });
    if (!handled) help(program);
  }
} catch (error) {
  if (error instanceof CommanderError && error.code === "commander.version") {
    emit(makeResult("version", { version: VERSION }), output);
  } else if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
    emit(makeResult("help", { help: output }), output);
  } else if (error instanceof SkillexError) {
    emit(makeResult("cli", null, { exit: error.exit, findings: error.findings }));
  } else {
    const usage = error instanceof CommanderError;
    emit(
      makeResult("cli", null, {
        exit: usage ? ExitCode.CONFIG : ExitCode.FAILURE,
        findings: [
          {
            code: usage ? "E_USAGE" : "E_RUNTIME",
            severity: "error",
            message: error instanceof Error ? error.message.replace(/^error: /, "") : String(error),
            fix: usage
              ? "Run skillex --help for available arguments."
              : "Report the failing command.",
          },
        ],
      }),
    );
  }
}
