import type { Command } from "commander";
import {
  ExitCode,
  inspectVendorStatus,
  listVendorSources,
  makeResult,
  type ResultEnvelope,
  SkillexError,
  showVendorSource,
  syncVendorSources,
  type VendorOptions,
  type VendorSkillStatus,
  type VendorSourceListResult,
  type VendorSourceShowResult,
  type VendorStatusResult,
  type VendorSyncOptions,
  type VendorSyncResult,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

interface Options {
  registryRoot?: string;
  source?: string[];
  checkout?: string[];
  upstream?: boolean;
  dryRun?: boolean;
  adopt?: boolean;
  discardLocalEdits?: boolean;
  prune?: boolean;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function checkouts(values: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const value of values) {
    const separator = value.indexOf("=");
    const id = value.slice(0, separator);
    const path = value.slice(separator + 1);
    if (separator < 1 || !path.trim() || Object.hasOwn(result, id)) {
      throw new SkillexError(ExitCode.CONFIG, [
        {
          code: "E_VENDOR_CHECKOUT",
          severity: "error",
          message: `Invalid or duplicate checkout mapping: ${value}`,
          fix: "Pass each checkout ID once as --checkout ID=PATH.",
        },
      ]);
    }
    result[id] = path;
  }
  return result;
}

function sourceOptions(command: Command): Command {
  return command
    .option("--source <name>", "Select a declared source (repeat for multiple sources).", collect)
    .option(
      "--checkout <id=path>",
      "Use this local checkout for an ID (repeat for distinct IDs).",
      collect,
    );
}

function values(command: Command, key: "source" | "checkout"): string[] {
  const levels: Command[] = [];
  for (let level: Command | null = command; level; level = level.parent) levels.unshift(level);
  return levels.flatMap((level) => level.opts<Options>()[key] ?? []);
}

function skillText(skills: readonly VendorSkillStatus[]): string[] {
  return skills.map(
    (skill) =>
      `  ${skill.name}: ${skill.state}${skill.recordedCommit ? ` (${skill.recordedCommit})` : ""}`,
  );
}

function listText(data: VendorSourceListResult): string {
  return [
    `Sources: ${data.manifest}`,
    ...data.sources.map(
      ({ source, checkout }) =>
        `${source.name}\t${source.version}\t${source.repo}\t${checkout.root ?? "checkout unavailable"}`,
    ),
    ...(data.sources.length ? [] : ["No declared sources."]),
    "",
  ].join("\n");
}

function showText(data: VendorSourceShowResult): string {
  const { source, checkout } = data;
  return [
    source.name,
    `Repository: ${source.repo}`,
    `Pin: ${source.version}`,
    `Source directory: ${source.subdir}`,
    `Checkout ID: ${checkout.id}`,
    `Local checkout: ${checkout.root ?? "unavailable"} (${checkout.source})`,
    ...checkout.searched.map((path) => `  Searched: ${path}`),
    `Membership: ${data.membership === "explicit" ? "explicit declaration" : "recorded catalog members; upstream inventory has not been enumerated"}`,
    ...skillText(data.skills),
    "",
  ].join("\n");
}

function statusText(data: VendorStatusResult): string {
  return [
    `Catalog provenance: ${data.registry.root}`,
    ...data.sources.map(
      (source) =>
        `${source.name}: ${source.membership === "explicit" ? "declared membership" : "recorded membership only"}${source.upstreamCommit ? `; upstream ${source.upstreamCommit}` : ""}`,
    ),
    ...skillText(data.skills),
    ...(data.skills.length ? [] : ["No catalog members to verify."]),
    "",
  ].join("\n");
}

function syncText(data: VendorSyncResult): string {
  const changes = data.changes.filter((change) => change.action !== "unchanged");
  return [
    `${data.dryRun ? "Planned" : "Applied"} catalog changes: ${data.dryRun ? changes.length : data.applied.length}`,
    ...data.sources.map(
      (source) =>
        `  ${source.name}: ${source.skipped ? "skipped" : (source.commit ?? "unresolved")}`,
    ),
    ...data.changes.map((change) => `  ${change.action}: ${change.path}`),
    "",
  ].join("\n");
}

export function registerVendorCommands(program: Command, output: Output): void {
  const vendor = sourceOptions(
    program
      .command("vendor")
      .description(
        "Inspect and import pinned upstream skills using available local Git checkouts.",
      ),
  ).action(() => output.help(vendor));

  async function run<T>(
    command: Command,
    action: (options: VendorSyncOptions) => Promise<ResultEnvelope<T | null>>,
    render: (data: T) => string,
  ): Promise<void> {
    const options = command.optsWithGlobals<Options>();
    const sources = values(command, "source");
    const mappings = values(command, "checkout");
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    try {
      const common: VendorOptions = {
        ...(options.registryRoot === undefined ? {} : { registryRoot: options.registryRoot }),
        ...(sources.length ? { sources } : {}),
        ...(mappings.length ? { checkouts: checkouts(mappings) } : {}),
        ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
        signal: cancellation.signal,
      };
      const result = await action({
        ...common,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
        ...(options.discardLocalEdits === undefined
          ? {}
          : { discardLocalEdits: options.discardLocalEdits }),
        ...(options.prune === undefined ? {} : { prune: options.prune }),
      });
      output.emit(result, result.data === null ? "" : render(result.data));
    } catch (error) {
      if (!(error instanceof SkillexError)) throw error;
      output.emit(
        makeResult(`vendor ${command.name()}`, null, {
          exit: error.exit,
          findings: error.findings,
        }),
      );
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  }

  sourceOptions(
    vendor
      .command("list")
      .description("List source declarations and local checkout locations without fetching."),
  ).action(async (_local, command: Command) => run(command, listVendorSources, listText));
  sourceOptions(
    vendor
      .command("show <source>")
      .description("Inspect a source declaration and its recorded catalog members."),
  ).action(async (source: string, _local, command: Command) =>
    run(command, (options) => showVendorSource(source, options), showText),
  );
  sourceOptions(
    vendor
      .command("status")
      .description(
        "Verify catalog bytes and modes against provenance receipts without requiring upstream checkouts.",
      ),
  )
    .option(
      "--upstream",
      "Also compare recorded commits with pins available in local Git checkouts.",
    )
    .action(async (_local, command: Command) => run(command, inspectVendorStatus, statusText));
  sourceOptions(
    vendor
      .command("sync")
      .description(
        "Stage and import pinned committed skill trees offline; ordinary sync preserves unmanaged and locally edited content.",
      ),
  )
    .option(
      "--dry-run",
      "Plan and validate all changes without writing or recovering pending operations.",
    )
    .option(
      "--adopt",
      "Adopt unmanaged real catalog directories; differing content also requires --discard-local-edits.",
    )
    .option(
      "--discard-local-edits",
      "Explicitly replace local content that differs from its baseline or adopted upstream tree.",
    )
    .option(
      "--prune",
      "Remove unedited recorded members absent from successfully inspected selected sources.",
    )
    .action(async (_local, command: Command) => run(command, syncVendorSources, syncText));
}
