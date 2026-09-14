import { type Command, Option } from "commander";
import {
  type DiagnosticOptions,
  type DoctorResult,
  doctor,
  type ExplainResult,
  explainSkill,
  inspectStatus,
  type ResultEnvelope,
  type StatusResult,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
}

interface Options {
  registryRoot?: string;
  project?: string;
  scope?: "auto" | "global" | "project" | "both";
  sourcesOnly?: boolean;
}

function count(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function statusText(data: StatusResult): string {
  const lines: string[] = [];
  for (const scope of data.scopes) {
    lines.push(
      `${scope.scope}: ${scope.mode ?? "unresolved"}`,
      `  Manifest: ${scope.manifestPath}`,
      `  Root: ${scope.actual.root.path} (${scope.actual.root.kind}, ${scope.actual.root.ownership})`,
      `  Desired: ${count(scope.counts.desired)}; observed entries: ${scope.counts.actual}; missing: ${count(scope.counts.missing)}`,
      `  Ownership: ${scope.counts.owned} owned; ${scope.counts.foreign} foreign; ${scope.counts.pack} pack members`,
      `  Receipt: ${scope.receipt.state}${scope.receipt.path ? ` (${scope.receipt.path})` : ""}`,
      ...scope.actual.entries.map(
        (entry) =>
          `    ${entry.name}: ${entry.kind}, ${entry.ownership}${entry.target ? ` -> ${entry.target}` : ""}${entry.kind === "link" && !entry.reachable ? " (unreachable)" : ""}`,
      ),
      `  CLI aliases: ${scope.aliases.filter((alias) => alias.reachesRoot && alias.reachable).length}/${scope.aliases.length} reachable through this root`,
      ...scope.aliases.map(
        (alias) =>
          `    ${alias.path}: ${alias.reachesRoot && alias.reachable ? "ready" : alias.kind === "missing" ? "missing" : !alias.reachable ? "unreachable" : alias.target === scope.actual.root.target ? "reachable, bypasses scope root" : "wrong target"}`,
      ),
    );
  }
  if (data.changes.length) {
    lines.push(
      `Pending changes: ${data.changes.length}`,
      ...data.changes.map((change) => `  ${change.scope} ${change.action}: ${change.path}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function explanationText(data: ExplainResult): string {
  const lines = [data.name, `Canonical: ${data.canonical ?? "unresolved"}`];
  for (const scope of data.scopes) {
    lines.push(
      `${scope.scope}: ${scope.state}`,
      `  Manifest: ${scope.manifestPath}`,
      ...scope.origins.map(
        (origin) =>
          `  From ${origin.scope} ${origin.kind} ${origin.reference} (${origin.manifest})`,
      ),
      ...scope.exclusions.map((excluded) => `  Excluded by ${excluded.by}: ${excluded.reference}`),
      ...scope.dormant.map(
        (origin) =>
          `  Dormant ${origin.scope} ${origin.kind} ${origin.reference} (${origin.manifest})`,
      ),
      `  Activation: ${scope.actual.path} (${scope.actual.kind}, ${scope.actual.ownership})`,
      `  CLI reachability: ${scope.aliases.filter((alias) => alias.reachable).length}/${scope.aliases.length}`,
      ...scope.blockers.map((finding) => `  Blocked: ${finding.message}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function doctorText(data: DoctorResult): string {
  const lines = [data.sourcesOnly ? "Source diagnostics" : "Source and activation diagnostics"];
  for (const source of data.sources) {
    lines.push(
      `Registry: ${source.registry.root}`,
      `  Sources: ${source.canonicalSkills} canonical skills; ${source.sets} sets; ${source.packs} packs`,
      `  Provenance: ${source.provenance} receipts; ${source.digestsChecked} digests checked`,
    );
  }
  if (data.status) lines.push(statusText(data.status).trimEnd());
  if (data.writers) {
    lines.push(
      `Legacy writers: ${data.writers.configured.length} configured references; ${data.writers.running.length} observed running`,
      `Process observation: ${data.writers.processObservation}`,
      ...data.writers.configured.map(
        (writer) =>
          `  Configured ${writer.kind}: ${writer.path}:${writer.line} (${writer.command})`,
      ),
      ...data.writers.running.map(
        (writer) => `  Running PID ${writer.pid}: ${writer.entrypoint} (${writer.command})`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function scopeOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        "--scope <scope>",
        "Inspect auto, global, project, or both scopes (default: auto).",
      ).choices(["auto", "global", "project", "both"]),
    )
    .option("--project <path>", "Inspect this project explicitly.");
}

export function registerDiagnosticCommands(program: Command, output: Output): void {
  async function run<T>(
    command: Command,
    action: (options: DiagnosticOptions) => Promise<ResultEnvelope<T | null>>,
    render: (data: T) => string,
  ): Promise<void> {
    const { registryRoot, project, scope } = command.optsWithGlobals<Options>();
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    try {
      const result = await action({
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(project === undefined ? {} : { project }),
        ...(scope === undefined ? {} : { scope }),
        signal: cancellation.signal,
      });
      output.emit(result, result.data === null ? "" : render(result.data));
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  }

  scopeOptions(
    program
      .command("status")
      .description(
        "Inspect desired skills, actual activation, ownership, and CLI reachability without writing. Auto inspects global and the nearest project; drift exits 6.",
      ),
  ).action(async (_local, command: Command) => run(command, inspectStatus, statusText));

  scopeOptions(
    program
      .command("explain <name>")
      .description(
        "Explain a canonical skill's declarations, exclusions, pack dormancy, blockers, and CLI reachability without writing.",
      ),
  ).action(async (name: string, _local, command: Command) =>
    run(command, (options) => explainSkill(name, options), explanationText),
  );

  scopeOptions(
    program
      .command("doctor")
      .description(
        "Inspect source topology, provenance, activation, and legacy writer evidence without repairing or writing files.",
      ),
  )
    .option(
      "--sources-only",
      "Check source declarations and topology; omit activation and runtime checks.",
    )
    .action(async (_local, command: Command) => {
      const { sourcesOnly } = command.optsWithGlobals<Options>();
      await run(
        command,
        (options) => doctor({ ...options, ...(sourcesOnly === undefined ? {} : { sourcesOnly }) }),
        doctorText,
      );
    });
}
