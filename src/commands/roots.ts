import type { Command } from "commander";
import type { ResultEnvelope } from "../core/result.js";
import { adoptRoot, type RootAdoptOptions } from "../core/root-cutover.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

export function registerRootCommands(program: Command, output: Output): void {
  const root = program
    .command("root")
    .description("Bounded project-root ownership and explicit canonical mapping remedies.")
    .action(() => output.help(root));
  root
    .command("adopt")
    .description(
      "Adopt verified canonical links; explicit mappings or paired pinned-pack replacement preserve the entire original root outside discovery. No manifests, project runtime, or client aliases change.",
    )
    .requiredOption(
      "--project <path>",
      "Adopt only this project's existing real .agents/skills root.",
    )
    .option(
      "--map <old=new>",
      "Explicit canonical identity mapping; repeat for each broken/foreign entry. Real content must be byte-equivalent.",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--replace-pack <name@version>",
      "Explicit pinned family replacement, ONLY with --replace-prefix NAME-. Replaces matching real skills; retires nonmembers into whole-root quarantine and adds missing pack links.",
    )
    .option(
      "--replace-prefix <name->",
      "Exact pack family plus '-' (at least three family characters). Only real directories with matching SKILL.md frontmatter name qualify; symlinks still need ordinary verification/mapping.",
    )
    .option("--dry-run", "Inventory and preflight without writing any state (default).")
    .option("--apply", "Apply a fully verified plan, or recover this project's recorded cutover.")
    .action(async (_local, command: Command) => {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        const options = command.optsWithGlobals<RootAdoptOptions>();
        const result = await adoptRoot({ ...options, signal: controller.signal });
        const data = result.data;
        output.emit(
          result,
          data
            ? [
                data.dryRun ? "Root adoption preview" : "Root adoption",
                `Root: ${data.root}`,
                ...(data.replacement
                  ? [
                      `Explicit replacement: ${data.replacement.pack} / ${data.replacement.prefix} (real skills only; whole-root archive required; project _bmad untouched)`,
                    ]
                  : []),
                ...(data.archiveStatus === "missing"
                  ? [
                      "Historical completed inventory (not a new plan; original archive is missing):",
                    ]
                  : []),
                ...data.inventory.map(
                  (item) =>
                    `${item.action}: ${item.name}${item.target ? ` -> ${item.canonical} (${item.target})` : ""}${item.reason && data.archiveStatus !== "missing" ? `\n  ${item.reason}` : ""}`,
                ),
                ...(data.quarantine
                  ? [
                      data.archiveStatus === "missing"
                        ? `WARNING: original archive MISSING at recorded location: ${data.quarantine}. Current ownership is verified, but original preservation is NOT verified.`
                        : data.archiveStatus === "verified"
                          ? `Original root verified at durable archive: ${data.quarantine}`
                          : `Original root archive location (cutover pending): ${data.quarantine}`,
                    ]
                  : data.changes.includes("quarantine-original-root")
                    ? [
                        "The entire original root will be retained beside the external cutover journal.",
                      ]
                    : []),
                ...(data.archiveStatus !== "none"
                  ? [
                      "Quarantine holds authored originals, not disposable state. Keep the archive, journal, and ownership receipt together and backed up; no archive deletion is authorized.",
                    ]
                  : []),
                ...data.preservedStages.map((path) => `Unverified stage preserved: ${path}`),
                `Changes: ${data.changes.join(", ") || "none"}`,
                `Receipt: ${data.receipt}`,
                `Journal: ${data.journal}`,
                "Manifests, canonical definitions, global roots, and client aliases are unchanged.",
                ...(data.dryRun
                  ? ["No writes. Review the inventory, then repeat with --apply."]
                  : []),
                "",
              ].join("\n")
            : "",
        );
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
    });
}
