import type { Command } from "commander";
import {
  type ClientIsolationOptions,
  isolateClient,
  unisolateClient,
  verifyClientIsolation,
} from "../core/client-isolation.js";
import type { ResultEnvelope } from "../core/result.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

export function registerClientCommands(program: Command, output: Output): void {
  const clients = program
    .command("clients")
    .description("Project-local client visibility controls; currently OpenCode V2 only.")
    .action(() => output.help(clients));
  const target = (command: Command) =>
    command
      .requiredOption("--client <client>", "Client adapter: opencode.")
      .requiredOption("--project <path>", "Project whose selected set is authoritative.");
  for (const [name, action] of [
    ["isolate", isolateClient],
    ["unisolate", unisolateClient],
  ] as const) {
    target(
      clients
        .command(name)
        .description(
          name === "isolate"
            ? "Plan/apply selected-set skill permissions without changing any global config or root."
            : "Remove only receipt-owned isolation rules, including after unsetting a project set.",
        ),
    )
      .option(
        "--override-permissions",
        "Explicitly authorize overriding shared skill permissions locally; never agent overrides.",
      )
      .option("--dry-run", "Preview without writing (default).")
      .option("--apply", "Atomically apply the reviewed project-local change.")
      .action(async (_local, command: Command) => {
        const result = await action(command.optsWithGlobals<ClientIsolationOptions>());
        const data = result.data;
        output.emit(
          result,
          data
            ? [
                `${data.client} ${name}${data.dryRun ? " preview" : ""}: ${data.project}`,
                `  Config: ${data.config}`,
                `  Receipt: ${data.receipt}`,
                `  Set: ${data.set ?? "none"}; selected members: ${data.members.length}`,
                ...data.changes.map((change) => `  ${change.action}: ${change.path}`),
                ...data.overrides.map(
                  (entry) => `  Authorized override: ${entry.path} permissions[${entry.rule}]`,
                ),
                ...(data.changes.length ? [] : ["  No config changes."]),
                ...(data.recovery
                  ? ["  Interrupted-write receipt will be reconciled on apply."]
                  : []),
                ...(name === "isolate"
                  ? ["Runtime not certified; use clients verify with an existing probe session."]
                  : []),
                "",
              ].join("\n")
            : "",
        );
      });
  }
  target(
    clients
      .command("verify")
      .description(
        "Evaluate registered skills using an existing probe session's actual permission service; no inference or session creation. Ask results may create pending permission requests.",
      ),
  )
    .requiredOption(
      "--session <id>",
      "Existing dedicated probe session at this project's exact location.",
    )
    .option("--agent <id>", "Agent whose effective permissions are evaluated.", "build")
    .action(async (_local, command: Command) => {
      const result = await verifyClientIsolation(command.optsWithGlobals());
      const data = result.data;
      output.emit(
        result,
        data
          ? [
              `OpenCode V2 permission verification: ${data.project}`,
              `  Agent: ${data.agent}; probe session: ${data.session}`,
              `  Registered: ${data.registryCount}; evaluated: ${data.checked.length}`,
              `  Permitted selected advertisement: ${data.advertised.join(", ") || "none"}`,
              ...data.checked
                .filter((entry) => entry.effect !== entry.expected)
                .map((entry) => `  ${entry.id}: ${entry.effect} (expected ${entry.expected})`),
              "No inference, session creation, global writes, or service reload was performed.",
              "",
            ].join("\n")
          : "",
      );
    });
}
