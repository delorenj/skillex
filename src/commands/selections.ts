import { Argument, type Command, Option } from "commander";
import {
  disableSelection,
  enableSelection,
  initScope,
  type ResultEnvelope,
  type SelectionKind,
  type SelectionOptions,
  type SelectionResult,
  setInheritance,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
}

interface Options {
  registryRoot?: string;
  project?: string;
  scope?: "global" | "project";
  dryRun?: boolean;
}

function selectionText(result: ResultEnvelope<SelectionResult | null>): string {
  const data = result.data;
  if (!data) return "";
  const heading = data.dryRun
    ? data.changes.length
      ? "Planned selection changes"
      : "Selection is up to date"
    : !result.ok
      ? "Selection is incomplete"
      : result.command === "init"
        ? data.saved
          ? "Created scope manifest"
          : "Scope manifest already exists"
        : data.applied.length
          ? "Selection applied"
          : "Selection is up to date";
  return [
    heading,
    `  ${data.scope}: ${data.manifestPath}`,
    ...(data.dryRun ? data.changes : data.applied).map(
      (change) =>
        `  ${change.action}: ${change.path}${change.target ? ` -> ${change.target}` : ""}`,
    ),
    "",
  ].join("\n");
}

function scopeOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--scope <scope>", "Choose the single scope to change.").choices([
        "global",
        "project",
      ]),
    )
    .option("--project <path>", "Select this project explicitly.")
    .option("--dry-run", "Preview manifest and activation changes without writing.");
}

export function registerSelectionCommands(program: Command, output: Output): void {
  async function run(
    command: Command,
    action: (options: SelectionOptions) => Promise<ResultEnvelope<SelectionResult | null>>,
  ): Promise<void> {
    const { registryRoot, project, scope, dryRun } = command.optsWithGlobals<Options>();
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    try {
      const result = await action({
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(project === undefined ? {} : { project }),
        ...(scope === undefined ? {} : { scope }),
        ...(dryRun === undefined ? {} : { dryRun }),
        signal: cancellation.signal,
      });
      output.emit(result, selectionText(result));
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  }

  scopeOptions(
    program
      .command("init")
      .description(
        "Create .agents/skills.json without replacing an existing selection. New projects inherit global skills; init creates only the manifest.",
      ),
  ).action(async (_local, command: Command) => run(command, initScope));

  for (const [name, action] of [
    ["enable", enableSelection],
    ["disable", disableSelection],
  ] as const) {
    scopeOptions(
      program
        .command(name)
        .description(
          `${name === "enable" ? "Enable" : "Disable"} a selection and immediately reconcile one scope. Default: nearest project manifest, otherwise global.`,
        )
        .addArgument(new Argument("<kind>", "Selection kind.").choices(["skill", "set", "pack"]))
        .argument(
          "<reference>",
          "Canonical name, set name, or pack name with an optional @version.",
        ),
    ).action(async (kind: SelectionKind, reference: string, _local, command: Command) =>
      run(command, (options) => action(kind, reference, options)),
    );
  }

  program
    .command("inherit")
    .description("Change global-skill inheritance and immediately reconcile the selected project.")
    .addArgument(
      new Argument("<mode>", "Whether the project inherits global skills.").choices(["on", "off"]),
    )
    .option("--project <path>", "Select this project instead of the nearest manifest.")
    .option("--dry-run", "Preview manifest and activation changes without writing.")
    .action(async (mode: "on" | "off", _local, command: Command) =>
      run(command, (options) => setInheritance(mode === "on", options)),
    );
}
