import { type Command, Option } from "commander";
import {
  listReceipts,
  type ReceiptNamespace,
  type ReceiptState,
  retireReceipts,
} from "../core/receipt-retire.js";
import type { ResultEnvelope } from "../core/result.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

export function registerReceiptCommands(program: Command, output: Output): void {
  const receipt = program
    .command("receipt")
    .description("Inspect and retire inert activation and profile receipts.")
    .action(() => output.help(receipt));

  receipt
    .command("list")
    .description(
      "List activation and profile receipts and whether each is valid, stale (root recreated), or orphan (root gone).",
    )
    .addOption(
      new Option("--state <state>", "Show only receipts in this state.").choices([
        "valid",
        "stale",
        "orphan",
        "invalid",
        "foreign-host",
      ]),
    )
    .addOption(
      new Option("--namespace <namespace>", "Show only activation or profile receipts.").choices([
        "activations",
        "profiles",
      ]),
    )
    .action(async (_local, command: Command) => {
      const options = command.optsWithGlobals<{
        state?: ReceiptState;
        namespace?: ReceiptNamespace;
      }>();
      const result = await listReceipts({
        ...(options.state ? { state: options.state } : {}),
        ...(options.namespace ? { namespace: options.namespace } : {}),
      });
      const data = result.data;
      output.emit(
        result,
        data
          ? [
              `Receipts under ${data.stateHome}/skillex`,
              ...data.receipts.map(
                (item) =>
                  `  ${item.state.padEnd(12)} ${item.id.slice(0, 12)} ${item.namespace} ${item.activationRoot ?? "(unreadable)"}${item.pending ? " [pending journal]" : ""}\n      ${item.reason}`,
              ),
              `${data.counts.valid} valid, ${data.counts.stale} stale, ${data.counts.orphan} orphan, ${data.counts.invalid} invalid, ${data.counts["foreign-host"]} foreign-host`,
              "",
            ].join("\n")
          : "",
      );
    });

  receipt
    .command("retire")
    .description(
      "Retire stale or orphan receipts: back the JSON up, then remove it. Skill roots are never touched. Preview by default.",
    )
    .argument("[targets...]", "Receipt ids (8+ hex), project or scope paths, or skill root paths.")
    .option("--all-stale", "Select every stale and orphan receipt.")
    .option("--dry-run", "Preview without writing (default).")
    .option("--apply", "Back up and remove the selected receipts.")
    .option("--force", "Also retire a named receipt that is valid, pending, or unreadable.")
    .option(
      "--backup-dir <path>",
      "Write backups here (default: <state>/skillex/retired-receipts/<UTC ts>-receipt-retire).",
    )
    .action(async (targets: string[], _local, command: Command) => {
      const options = command.optsWithGlobals<{
        allStale?: boolean;
        dryRun?: boolean;
        apply?: boolean;
        force?: boolean;
        backupDir?: string;
      }>();
      const result = await retireReceipts({
        targets,
        ...(options.allStale ? { allStale: true } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.apply ? { apply: true } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.backupDir ? { backupDir: options.backupDir } : {}),
      });
      const data = result.data;
      output.emit(
        result,
        data
          ? [
              data.dryRun ? "Receipt retirement preview" : "Receipt retirement",
              ...data.entries.map(
                (item) =>
                  `  ${item.action === "retire" ? "retire" : "keep  "} ${item.state.padEnd(12)} ${item.id.slice(0, 12)} ${item.activationRoot ?? "(unreadable)"}\n      ${item.why}`,
              ),
              ...(data.entries.length ? [] : ["No receipts selected."]),
              ...(data.backupDir
                ? [`Backed up to ${data.backupDir}`, `Retired ${data.retired.length} receipt(s).`]
                : data.dryRun && data.entries.some((item) => item.action === "retire")
                  ? ["Nothing written. Re-run with --apply to back up and retire."]
                  : []),
              "Skill roots were not touched.",
              "",
            ].join("\n")
          : "",
      );
    });
}
