import type { Command } from "commander";
import { fail } from "../core/error.js";
import { migrationFailure, parseMigrationMapping } from "../core/migration-common.js";
import { readVendorText } from "../core/vendor-sources.js";
import {
  type MigrationMapping,
  type MigrationOptions,
  type MigrationResult,
  migrate,
  type ResultEnvelope,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
}
interface Options {
  registryRoot?: string;
  apply?: boolean;
  project?: string;
  scope?: "global" | "project";
  profile?: string;
  hermesRoot?: string;
  mapping?: string;
  sourcesFile?: string;
}

function render(data: MigrationResult): string {
  return [
    `${data.apply ? "Migration" : "Migration preview"}: ${data.targets.join(", ")}`,
    ...data.items.map(
      (item) =>
        `${item.state}: ${item.action} ${item.path}${item.target ? ` -> ${item.target}` : ""}${item.details.length ? `\n  ${item.details.join("\n  ")}` : ""}`,
    ),
    `Applied items: ${data.applied.length}`,
    ...data.receipts.map((path) => `Receipt: ${path}`),
    ...(data.apply
      ? []
      : ["No changes applied. Use --apply to execute ready items; blocked items remain intact."]),
    "",
  ].join("\n");
}

export function registerMigrationCommand(program: Command, output: Output): void {
  program
    .command("migrate")
    .description(
      "Preview legacy catalog conversion; select --scope global or --project PATH for activation migration.",
    )
    .option(
      "--apply",
      "Apply ready migration items and record verification; preview is the default.",
    )
    .option(
      "--scope <scope>",
      "Migrate an explicit global or project scope; no ambient scope is selected.",
    )
    .option("--project <path>", "Migrate this project's manifest and activation roots.")
    .option(
      "--profile <name>",
      "Migrate this Hermes skills root, with --project PATH for its explicit association.",
    )
    .option("--hermes-root <path>", "Select the Hermes installation for a named profile.")
    .option(
      "--mapping <path>",
      "Read explicit version 1 name, reference, pack, wrapper, and manifest choices.",
    )
    .option(
      "--sources-file <path>",
      "Onboard this prepared upstream declaration when the catalog has none.",
    )
    .action(async (_local, command: Command) => {
      const options = command.optsWithGlobals<Options>();
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        let mapping: MigrationMapping | undefined;
        if (options.mapping !== undefined) {
          const text = await readVendorText(options.mapping, "E_MIGRATION_MAPPING");
          if (text === null)
            fail("E_MIGRATION_MAPPING", "The explicitly selected mapping file does not exist.", {
              path: options.mapping,
              fix: "Select an existing version 1 JSON mapping file.",
            });
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            fail("E_MIGRATION_MAPPING", "The migration mapping must contain valid JSON.", {
              path: options.mapping,
              fix: "Correct the JSON mapping and retry the preview.",
            });
          }
          mapping = parseMigrationMapping(raw);
        }
        const { mapping: _mappingPath, ...flags } = options;
        const selected: MigrationOptions = {
          ...flags,
          ...(mapping === undefined ? {} : { mapping }),
          signal: controller.signal,
        };
        const result = await migrate(selected);
        output.emit(result, result.data ? render(result.data) : "");
      } catch (error) {
        output.emit(migrationFailure("migrate", error, null));
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
    });
}
