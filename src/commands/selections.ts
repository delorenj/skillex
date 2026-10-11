import { Argument, type Command, Option } from "commander";
import {
  disableSelection,
  ExitCode,
  enableSelection,
  initScope,
  makeResult,
  type NormalizeOptions,
  normalizeScope,
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
  global?: boolean;
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
    .option("-g, --global", "Select the global scope (~/.agents/skills.json).")
    .option("--project <path>", "Select this project explicitly.")
    .option("--dry-run", "Preview manifest and activation changes without writing.");
}

export function registerSelectionCommands(program: Command, output: Output): void {
  async function run(
    command: Command,
    action: (options: SelectionOptions) => Promise<ResultEnvelope<SelectionResult | null>>,
  ): Promise<void> {
    const {
      registryRoot,
      project,
      scope,
      global: globalScope,
      dryRun,
    } = command.optsWithGlobals<Options>();
    if (globalScope && (scope !== undefined || project !== undefined)) {
      output.emit(
        makeResult(command.name(), null, {
          exit: ExitCode.CONFIG,
          findings: [
            {
              code: "E_SCOPE",
              severity: "error",
              message: "--global conflicts with another explicit scope selector.",
              fix: "Use -g/--global alone, or --scope/--project without --global.",
            },
          ],
        }),
      );
      return;
    }
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    try {
      const result = await action({
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(project === undefined ? {} : { project }),
        ...(scope === undefined ? {} : { scope }),
        ...(globalScope ? { scope: "global" as const } : {}),
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
          `${name === "enable" ? "Enable" : "Disable"} a selection and immediately reconcile one scope. A set replaces the scope root; packs and skills add member links (deriving a scope-owned set when a shared set is already selected). Default: nearest project manifest, otherwise global.`,
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

  scopeOptions(
    program
      .command("normalize")
      .description(
        "Inventory one scope's selection (even in legacy states ordinary sync refuses), fold it into deterministic exact-membership set/pack references, and preview or apply the repair. Default target: nearest project manifest, otherwise global.",
      )
      .option(
        "--base-set <name>",
        "Choose an explicit base for legacy sets or exact captured-set decomposition.",
      )
      .option("--apply", "Apply the planned repair (default is a write-free preview)."),
  ).action(async (_local, command: Command) => {
    const {
      registryRoot,
      project,
      scope,
      global: globalScope,
      dryRun,
      apply,
      baseSet,
    } = command.optsWithGlobals<Options & { apply?: boolean; baseSet?: string }>();
    if (globalScope && (scope !== undefined || project !== undefined)) {
      output.emit(
        makeResult("normalize", null, {
          exit: ExitCode.CONFIG,
          findings: [
            {
              code: "E_SCOPE",
              severity: "error",
              message: "--global conflicts with another explicit scope selector.",
              fix: "Use -g/--global alone, or --scope/--project without --global.",
            },
          ],
        }),
      );
      return;
    }
    if (dryRun && apply) {
      output.emit(
        makeResult("normalize", null, {
          exit: ExitCode.CONFIG,
          findings: [
            {
              code: "E_OPTIONS",
              severity: "error",
              message: "--dry-run and --apply are mutually exclusive.",
              fix: "Preview with --dry-run (the default), or apply with --apply.",
            },
          ],
        }),
      );
      return;
    }
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    try {
      const options: NormalizeOptions = {
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(project === undefined ? {} : { project }),
        ...(scope === undefined ? {} : { scope }),
        ...(globalScope ? { scope: "global" as const } : {}),
        ...(apply ? { apply: true } : {}),
        ...(baseSet === undefined ? {} : { baseSet }),
        ...(dryRun === undefined ? {} : { dryRun }),
        signal: cancellation.signal,
      };
      const result = await normalizeScope(options);
      output.emit(result, normalizeText(result));
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  });
}

function normalizeText(result: ResultEnvelope<SelectionResult | null>): string {
  const data = result.data;
  if (!data) return "";
  const heading = data.dryRun
    ? data.changes.length
      ? "Planned normalization"
      : "Selection is already normalized"
    : result.ok
      ? data.applied.length
        ? "Normalization applied"
        : "Selection is already normalized"
      : "Normalization is incomplete";
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
