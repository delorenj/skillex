import { type Command, Option } from "commander";
import { type ResultEnvelope, type SyncOptions, type SyncResult, sync } from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
}

interface Options {
  registryRoot?: string;
  scope?: SyncOptions["scope"];
  project?: string;
  dryRun?: boolean;
  exitCode?: boolean;
}

function syncText(data: SyncResult | null, ok: boolean): string {
  if (!data) return "";
  const heading = data.dryRun
    ? data.changes.length
      ? "Planned activation changes"
      : "Activation is up to date"
    : ok
      ? data.applied.length
        ? "Activation updated"
        : "Activation is up to date"
      : "Activation is incomplete";
  return [
    heading,
    ...data.scopes.map(
      (scope) =>
        `  ${scope.scope}: ${scope.activationRoot} (${scope.mode}, ${scope.skills.length} skills)`,
    ),
    ...(data.dryRun ? data.changes : data.applied).map(
      (change) =>
        `  ${change.scope} ${change.action}: ${change.path}${change.target ? ` -> ${change.target}` : ""}`,
    ),
    "",
  ].join("\n");
}

export function registerSyncCommand(program: Command, output: Output): void {
  program
    .command("sync")
    .description(
      "Reconcile .agents/skills and supported CLI aliases from .agents/skills.json. By default, update global and the nearest project scope.",
    )
    .addOption(
      new Option("--scope <scope>", "Choose activation roots to update.").choices([
        "auto",
        "global",
        "project",
        "both",
      ]),
    )
    .option("--project <path>", "Use this project's existing manifest instead of discovery.")
    .option("--dry-run", "Show the complete link, alias, and receipt plan without writing.")
    .option("--exit-code", "With --dry-run, return exit 6 when changes are needed.")
    .action(async (_local, command: Command) => {
      const { registryRoot, scope, project, dryRun, exitCode } = command.optsWithGlobals<Options>();
      const cancellation = new AbortController();
      const interrupt = () => cancellation.abort();
      // The first interrupt stops at a journal-safe boundary. Removing this
      // one-shot listener leaves a second SIGINT free to terminate the process.
      process.once("SIGINT", interrupt);
      try {
        const result = await sync({
          ...(registryRoot === undefined ? {} : { registryRoot }),
          ...(scope === undefined ? {} : { scope }),
          ...(project === undefined ? {} : { project }),
          ...(dryRun === undefined ? {} : { dryRun }),
          ...(exitCode === undefined ? {} : { exitCode }),
          signal: cancellation.signal,
        });
        output.emit(result, syncText(result.data, result.ok));
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
    });
}
