import type { Command } from "commander";
import {
  listProfiles,
  type ProfileListResult,
  type ProfileOptions,
  type ProfileShowResult,
  type ProfileSyncResult,
  type ResultEnvelope,
  showProfile,
  syncProfile,
} from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
  help(command: Command): void;
}

interface Options {
  registryRoot?: string;
  hermesRoot?: string;
  project?: string;
  dryRun?: boolean;
}

function rootOption(command: Command): Command {
  return command.option("--hermes-root <path>", "Use this Hermes installation's profile root.");
}

function selectedRoot(command: Command): string | undefined {
  // Positional parsing means a child option occurs after its parent's option.
  for (let level: Command | null = command; level; level = level.parent) {
    const value = level.opts<Options>().hermesRoot;
    if (value !== undefined) return value;
  }
  return undefined;
}

function listText(data: ProfileListResult): string {
  return [
    `Hermes root: ${data.hermesRoot.path} (${data.hermesRoot.source})`,
    ...data.profiles.map(
      ({ profile, project, projection, counts }) =>
        `${profile.name}: ${projection}; skills ${profile.skills.kind}; ${counts.managed ?? "unknown"} managed, ${counts.local} local${project ? `; project ${project}` : ""}\n  ${profile.skillsRoot}`,
    ),
    ...(data.profiles.length ? [] : ["No profiles found."]),
    "",
  ].join("\n");
}

function showText(data: ProfileShowResult): string {
  return [
    `Profile: ${data.profile.name}`,
    `Skills: ${data.profile.skillsRoot} (${data.profile.skills.kind})`,
    `Project: ${data.project ?? "not selected"}`,
    `Receipt: ${data.receiptPath ?? "unavailable"}`,
    ...(data.pending ? ["Recovery is pending; profile sync can resume recorded work."] : []),
    ...(data.managed === null
      ? ["Desired selection is unresolved; use --project PATH to select a project explicitly."]
      : data.managed.map(
          (candidate) =>
            `  ${candidate.name}: ${candidate.winner} wins; ${candidate.state} -> ${candidate.target}`,
        )),
    ...data.preserved.map(
      (entry) =>
        `  Preserve local ${entry.name}: ${entry.kind}${entry.shadows ? "; overrides a selected skill" : ""}`,
    ),
    `Planned changes: ${data.changes.length}`,
    ...data.changes.map((change) => `  ${change.action}: ${change.path}`),
    "",
  ].join("\n");
}

function syncText(data: ProfileSyncResult): string {
  return `${showText(data)}${data.dryRun ? "Dry run; no changes applied." : `Applied changes: ${data.applied.length}`}\n`;
}

export function registerProfileCommands(program: Command, output: Output): void {
  const profile = rootOption(
    program
      .command("profile")
      .description(
        "Inspect and sync Hermes profiles while preserving their real skills directories.",
      ),
  ).action(() => output.help(profile));

  async function run<T>(
    command: Command,
    action: (options: ProfileOptions) => Promise<ResultEnvelope<T | null>>,
    render: (data: T) => string,
  ): Promise<void> {
    const { registryRoot, project } = command.optsWithGlobals<Options>();
    const hermesRoot = selectedRoot(command);
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    try {
      const result = await action({
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(hermesRoot === undefined ? {} : { hermesRoot }),
        ...(project === undefined ? {} : { project }),
        signal: cancellation.signal,
      });
      output.emit(result, result.data === null ? "" : render(result.data));
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  }

  rootOption(
    profile
      .command("list")
      .description("List Hermes profiles and observed projection state without writing."),
  ).action(async (_local, command: Command) => run(command, listProfiles, listText));

  rootOption(
    profile
      .command("show <name>")
      .description(
        "Inspect a named profile; use an explicit or previously recorded project, never CWD.",
      ),
  )
    .option("--project <path>", "Preview this project's selection with global skills.")
    .action(async (name: string, _local, command: Command) =>
      run(command, (options) => showProfile(name, options), showText),
    );

  rootOption(
    profile
      .command("sync <name>")
      .description(
        "Link global and project selections into a named profile; profile-owned entries win.",
      ),
  )
    .requiredOption(
      "--project <path>",
      "Select the project whose skills join the global selection.",
    )
    .option(
      "--dry-run",
      "Preview links, preserved entries, and receipts without writing or recovering.",
    )
    .action(async (name: string, _local, command: Command) => {
      const { project, dryRun } = command.opts<Options & { project: string }>();
      await run(
        command,
        (options) =>
          syncProfile(name, {
            ...options,
            project,
            ...(dryRun === undefined ? {} : { dryRun }),
          }),
        syncText,
      );
    });
}
