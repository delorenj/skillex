import type { Command } from "commander";
import type { ResultEnvelope } from "../core/result.js";
import { retireMiseSkillTasks } from "../core/retired-mise.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

export function registerIntegrationCommands(program: Command, output: Output): void {
  const integrations = program
    .command("integrations")
    .description("Inspect and remediate retired skill integration writers.")
    .action(() => output.help(integrations));
  integrations
    .command("retire-mise")
    .description(
      "Remove obsolete skill-operation mise tasks and their call edges. Preview by default; use skillex directly.",
    )
    .option(
      "--project <path>",
      "Inspect only this project's mise config files; default: current directory.",
    )
    .option("-g, --global", "Inspect the user's global mise config files, not any project.")
    .option("--file <path>", "Inspect one explicit mise TOML source file.")
    .option("--dry-run", "Preview task removals without writing (default).")
    .option("--apply", "Apply the reviewed task removals; preserve unrelated configuration.")
    .action(async (_local, command: Command) => {
      const options = command.optsWithGlobals<{
        project?: string;
        global?: boolean;
        file?: string;
        dryRun?: boolean;
        apply?: boolean;
      }>();
      const result = await retireMiseSkillTasks(options);
      const data = result.data;
      output.emit(
        result,
        data
          ? [
              data.dryRun ? "Skill mise task retirement preview" : "Skill mise task retirement",
              ...data.changes.map(
                (change) =>
                  `  ${change.path}: ${change.tasks.join(", ")} (${change.references} call edges)`,
              ),
              ...(data.changes.length
                ? []
                : ["No retired skill tasks found in inspected configs."]),
              "Use skillex directly, not mise skill tasks.",
              "",
            ].join("\n")
          : "",
      );
    });
}
