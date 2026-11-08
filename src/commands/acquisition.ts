import type { Command } from "commander";
import {
  type AcquisitionSourceInfo,
  addSkillFromSource,
  importSkillFromSource,
  type SkillAddData,
  type SkillImportData,
} from "../core/skill-acquisition.js";
import { ExitCode, makeResult, type ResultEnvelope } from "../index.js";

interface Output {
  emit(result: ResultEnvelope<unknown>, text?: string): void;
}

interface Options {
  registryRoot?: string;
  name?: string;
  ref?: string;
  project?: string;
  global?: boolean;
  dryRun?: boolean;
}

function sourceLine(source: AcquisitionSourceInfo | undefined): string {
  if (!source) return "";
  const where = [
    source.repo,
    ...(source.subtree ? [source.subtree] : []),
    source.ref ? `ref ${source.ref}` : undefined,
    source.commit ? `commit ${source.commit}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  return `  Source: ${source.label}${where ? ` (${where})` : ""}\n`;
}

function changesText(data: SkillImportData): string {
  return data.changes.map((change) => `    ${change.action}: ${change.path}\n`).join("");
}

function importText(data: SkillImportData | null, complete: boolean): string {
  if (!data) return "";
  if (data.reused)
    return `${data.name} already matches the source; nothing was imported.\n${sourceLine(data.source)}`;
  const outcome = data.dryRun
    ? `Would import ${data.name}`
    : complete
      ? `Imported ${data.name}`
      : `Import of ${data.name} did not finish`;
  return [
    `${outcome} into ${data.path}\n`,
    sourceLine(data.source),
    ...(data.dryRun ? [changesText(data)] : []),
  ].join("");
}

function activationText(data: SkillAddData): string {
  const activation = data.activation;
  const heading = `  Activation (${data.scope}): ${activation.status}\n`;
  const reason =
    activation.reason === "canonical-not-imported"
      ? "    deferred: the skill is imported only after this dry-run\n"
      : activation.reason === "manifest-missing"
        ? "    deferred: the scope manifest is initialized only after this dry-run\n"
        : "";
  const changes = [...(data.dryRun ? activation.changes : activation.applied)]
    .map(
      (change) =>
        `    ${change.action}: ${change.path}${change.target ? ` -> ${change.target}` : ""}\n`,
    )
    .join("");
  return heading + reason + changes;
}

function addText(data: SkillAddData | null, complete: boolean): string {
  if (!data) return "";
  const importPart = data.reused
    ? `${data.name} is already canonical; it was reused without fetching.\n`
    : data.dryRun
      ? `Would import ${data.name} into ${data.path}\n`
      : complete || data.imported
        ? `Imported ${data.name} into ${data.path}\n`
        : `Import of ${data.name} did not finish\n`;
  return [
    importPart,
    sourceLine(data.source),
    ...(data.dryRun && !data.reused ? [changesText(data)] : []),
    `  Manifest: ${data.manifestPath}\n`,
    activationText(data),
  ].join("");
}

/** Register top-level skill acquisition: import into the catalog, add = import + enable. */
export function registerAcquisitionCommands(program: Command, output: Output): void {
  program
    .command("import <source>")
    .description(
      "Copy a skill subtree (SKILL.md plus support files) from a GitHub tree URL, a Git remote, or a local directory into all-skills/ as one canonical definition. Never overwrites an existing name.",
    )
    .option("--name <name>", "Canonical name to import under (default: derived from the source).")
    .option("--ref <ref>", "Resolve this exact branch or tag for a remote source.")
    .option("--dry-run", "Plan the catalog copy without writing anything.")
    .action(async (source: string, _local, command: Command) => {
      const { name, ref, dryRun, registryRoot } = command.optsWithGlobals<Options>();
      const result = await importSkillFromSource(source, {
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(name === undefined ? {} : { name }),
        ...(ref === undefined ? {} : { ref }),
        ...(dryRun === undefined ? {} : { dryRun }),
      });
      output.emit(result, importText(result.data, result.ok));
    });

  program
    .command("add <source>")
    .description(
      "Import a skill if it has no canonical definition yet, then enable it in one scope: the current project by default (initialized from its checkout root when needed), -p/--project PATH to choose one, -g/--global for the global scope.",
    )
    .option("-p, --project <path>", "Select this project scope explicitly.")
    .option("-g, --global", "Select the global scope instead of a project.")
    .option("--name <name>", "Canonical name to import under (default: derived from the source).")
    .option("--ref <ref>", "Resolve this exact branch or tag for a remote source.")
    .option("--dry-run", "Plan the import and activation without writing anything.")
    .action(async (source: string, _local, command: Command) => {
      const {
        name,
        ref,
        dryRun,
        registryRoot,
        project,
        global: globalScope,
      } = command.optsWithGlobals<Options>();
      // Refuse the impossible scope combination before anything is fetched.
      if (project !== undefined && globalScope === true) {
        output.emit(
          makeResult("add", null, {
            exit: ExitCode.CONFIG,
            findings: [
              {
                code: "E_SCOPE",
                severity: "error",
                message: "--global conflicts with an explicit project selector.",
                fix: "Use -g/--global alone, or -p/--project without --global.",
              },
            ],
          }),
        );
        return;
      }
      const result = await addSkillFromSource(source, {
        ...(registryRoot === undefined ? {} : { registryRoot }),
        ...(name === undefined ? {} : { name }),
        ...(ref === undefined ? {} : { ref }),
        ...(project === undefined ? {} : { project }),
        ...(globalScope === undefined ? {} : { global: globalScope }),
        ...(dryRun === undefined ? {} : { dryRun }),
      });
      output.emit(result, addText(result.data, result.ok));
    });
}
