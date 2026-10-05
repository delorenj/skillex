import type { Command } from "commander";
import {
  type BmadExplainData,
  type BmadFreezeData,
  type BmadStatusData,
  explainBmadSkill,
  freezeBmadPack,
  inspectBmadStatus,
  type RegistryOptions,
  type ResultEnvelope,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

interface Options {
  registryRoot?: string;
  version?: string;
  dryRun?: boolean;
  replace?: boolean;
  /** Commander's --no-commands negation surfaces as opts.commands === false. */
  commands?: boolean;
  stateHome?: string;
  timeoutMs?: string;
}

function registryOptions(command: Command): RegistryOptions {
  const { registryRoot } = command.optsWithGlobals<Options>();
  return registryRoot === undefined ? {} : { registryRoot };
}

function freezeOptions(command: Command): import("../index.js").BmadFreezeOptions {
  const { version, dryRun, replace, commands, stateHome, timeoutMs } =
    command.optsWithGlobals<Options>();
  const timeout = timeoutMs === undefined ? undefined : Number(timeoutMs);
  return {
    ...registryOptions(command),
    ...(version === undefined ? {} : { version }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(replace === undefined ? {} : { replace }),
    ...(commands === undefined ? {} : { commands }),
    ...(stateHome === undefined ? {} : { stateHome }),
    ...(timeoutMs === undefined || timeout === undefined || !Number.isFinite(timeout)
      ? {}
      : { timeoutMs: timeout }),
  };
}

function freezeText(data: BmadFreezeData): string {
  const lines = [
    `BMAD freeze ${data.pack.name}@${data.pack.version}`,
    `Registry: ${data.registry.root}`,
    `Source: ${data.sourceRoot} (installation.version ${data.provenance.installation.version})`,
    `Skills: ${data.skillsDeclared} declared; ${data.skillsImported} imported; ${data.skillsUnchanged} unchanged; ${data.skillsSkipped} skipped`,
    `Commands: ${data.commandFiles} files across ${data.commands.clients.length} client layouts; ${data.danglingCommands} with dangling _bmad references`,
    `Pack: ${data.pack.path}`,
  ];
  for (const skill of data.skills) {
    lines.push(
      `  ${skill.name}: ${skill.status}${skill.recordedDigest ? ` (recorded ${skill.recordedDigest.slice(0, 19)})` : ""}`,
    );
  }
  for (const foreign of data.foreignSkills) {
    lines.push(`  foreign ${foreign.name}: rendered in source but undeclared; not imported`);
  }
  for (const client of data.commands.clients) {
    lines.push(
      `  commands ${client.client} (${client.layout}): ${client.imported} files, ${client.dangling} dangling`,
    );
  }
  if (data.dryRun) {
    lines.push("Planned changes:");
    for (const change of data.changes) lines.push(`  ${change.action}: ${change.path}`);
  }
  return `${lines.join("\n")}\n`;
}

function statusText(data: BmadStatusData): string {
  const lines = [
    `BMAD canonical skills: ${data.skills.length} frozen; ${data.traced} traced to baseline`,
    `Registry: ${data.registry.root}`,
  ];
  if (data.pack) {
    lines.push(
      `Pack: ${data.pack}; verify ${data.packVerified === null ? "unavailable" : data.packVerified ? "green" : "red"}; ${data.packMembers.length} declared members`,
    );
  }
  for (const skill of data.skills) {
    lines.push(
      `  ${skill.name}: ${skill.state}${skill.digest ? ` (${skill.digest.slice(0, 19)})` : ""}`,
    );
  }
  if (data.drifted.length) lines.push(`Drifted: ${data.drifted.join(", ")}`);
  if (data.untraced.length) lines.push(`Untraced pack members: ${data.untraced.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function explainText(data: BmadExplainData): string {
  const { skill } = data;
  const lines = [
    skill.name,
    `Canonical: ${skill.canonicalPath ?? "unresolved"}`,
    `BMAD version: ${skill.bmadVersion ?? "not a BMAD freeze import"}`,
    `Digest: ${skill.digest ?? "unavailable"}${skill.recordedDigest ? ` (recorded ${skill.recordedDigest})` : ""}`,
    `References: ${skill.references.length ? skill.references.map((ref) => `${ref.kind} ${ref.name}${ref.version ? `@${ref.version}` : ""}`).join(", ") : "none"}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Register BMAD freeze/status/explain; activation stays an explicit, separate step. */
export function registerBmadCommands(program: Command, output: Output): void {
  const bmad = program
    .command("bmad")
    .description(
      "Freeze legacy BMAD skills/commands into a versioned reference-only registry pack and inspect their traceability.",
    )
    .action(() => output.help(bmad));

  bmad
    .command("freeze <source>")
    .description(
      "Import the BMAD-enabled project's rendered skills into all-skills/ and publish packs/bmad/<version> with per-client command copies. Offline, idempotent, guarded.",
    )
    .option(
      "--version <version>",
      "Pack version to create (default: the source installation.version).",
    )
    .option("--dry-run", "Plan and validate without writing.")
    .option(
      "--replace",
      "Explicitly switch previously frozen canonical skills to this source version; differing foreign bodies are still refused.",
    )
    .option("--no-commands", "Skip per-client command copies.")
    .option("--state-home <path>", "State directory for the shared catalog lock.")
    .option("--timeout-ms <ms>", "Lock acquisition timeout in milliseconds.")
    .action(async (source: string, _local, command: Command) => {
      const result = await freezeBmadPack(source, freezeOptions(command));
      output.emit(result, result.data ? freezeText(result.data) : "");
    });

  bmad
    .command("status")
    .description(
      "Read-only BMAD traceability: canonical baselines, drift, pack membership, and undeclared pack children.",
    )
    .action(async (_local, command: Command) => {
      const result = await inspectBmadStatus(registryOptions(command));
      output.emit(result, result.data ? statusText(result.data) : "");
    });

  bmad
    .command("explain <name>")
    .description("Explain one canonical BMAD skill's provenance, baseline digest, and references.")
    .action(async (name: string, _local, command: Command) => {
      const result = await explainBmadSkill(name, registryOptions(command));
      output.emit(result, result.data ? explainText(result.data) : "");
    });
}
