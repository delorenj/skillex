import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { type ContentEntry, captureContent, digestContent, isWithin } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import { isSkillName } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions, RegistrySelection } from "./selection.js";

export interface CatalogChange {
  readonly action: string;
  readonly path: string;
  readonly source?: string;
}

export interface CatalogWriteResult {
  readonly registry: RegistrySelection;
  readonly name: string;
  readonly path: string;
  readonly dryRun: boolean;
  readonly changes: readonly CatalogChange[];
}

export interface CatalogWriteOptions extends RegistryOptions {
  readonly dryRun?: boolean;
}

export interface CreateSkillOptions extends CatalogWriteOptions {
  readonly description?: string;
}

function ioResult(command: string, error: unknown): ResultEnvelope<null> {
  if (error instanceof SkillexError) {
    return makeResult(command, null, { exit: error.exit, findings: error.findings });
  }
  return makeResult(command, null, {
    exit: ExitCode.FAILURE,
    findings: [
      {
        code: "E_IO",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        fix: "Check the source and destination paths and their permissions, then retry.",
      },
    ],
  });
}

function collision(path: string): never {
  fail(
    "E_SKILL_EXISTS",
    `The canonical destination already exists: ${path}`,
    { path, fix: "Choose a new canonical name; create and import never replace existing content." },
    ExitCode.REFUSED,
  );
}

async function target(name: string, options: RegistryOptions) {
  if (!isSkillName(name)) {
    fail("E_SKILL_NAME", `Invalid canonical skill name: ${name}`, {
      name,
      fix: "Use a lowercase single-component canonical name with letters, digits, dots, dashes, or underscores.",
    });
  }
  const registry = await discoverRegistry(options);
  const catalog = await requireDirectory(join(registry.root, "all-skills"), "E_NO_REGISTRY");
  const path = join(catalog, name);
  if (await inspectPath(path)) collision(path);
  return { registry, catalog, path, catalogIdentity: await lstat(catalog) };
}

async function assertOwnedDirectory(path: string, identity: Stats): Promise<void> {
  const current = await inspectPath(path);
  if (!current?.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
    fail(
      "E_IMPORT_TARGET_CHANGED",
      `A destination directory changed during the operation: ${path}`,
      { path, fix: "Inspect the directory and retry after other writers have finished." },
      ExitCode.REFUSED,
    );
  }
}

async function publish(
  command: string,
  result: CatalogWriteResult,
  entries: readonly ContentEntry[],
  rootMode: number,
  catalogIdentity: Stats,
): Promise<ResultEnvelope<CatalogWriteResult | null>> {
  if (result.dryRun) return makeResult(command, result);
  const catalog = dirname(result.path);
  await assertOwnedDirectory(catalog, catalogIdentity);
  try {
    await mkdir(result.path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") collision(result.path);
    throw error;
  }
  const directories = new Map<string, Stats>([[catalog, catalogIdentity]]);
  try {
    directories.set(result.path, await lstat(result.path));
    const checkParents = async (path: string): Promise<void> => {
      let parent = dirname(path);
      while (isWithin(catalog, parent)) {
        const identity = directories.get(parent);
        if (!identity) {
          fail("E_IMPORT_TARGET_CHANGED", `Destination parent is not owned: ${parent}`, {
            path: parent,
            fix: "Inspect the partial destination before retrying with a new name.",
          });
        }
        await assertOwnedDirectory(parent, identity);
        if (parent === catalog) break;
        parent = dirname(parent);
      }
    };
    for (const entry of entries) {
      const path = join(result.path, entry.path);
      await checkParents(path);
      if (entry.kind === "directory") {
        await mkdir(path, { mode: 0o700 });
        directories.set(path, await lstat(path));
      } else if (entry.kind === "link") {
        await symlink(entry.target, path);
      } else {
        const file = await open(path, "wx", entry.mode);
        try {
          await file.writeFile(entry.bytes);
          await file.chmod(entry.mode);
        } finally {
          await file.close();
        }
      }
    }
    for (const entry of [...entries].reverse()) {
      if (entry.kind !== "directory") continue;
      const path = join(result.path, entry.path);
      const identity = directories.get(path);
      if (identity) await assertOwnedDirectory(path, identity);
      await chmod(path, entry.mode);
    }
    const rootIdentity = directories.get(result.path);
    if (rootIdentity) await assertOwnedDirectory(result.path, rootIdentity);
    await chmod(result.path, rootMode);
    return makeResult(command, result);
  } catch (error) {
    return makeResult(command, result, {
      exit: ExitCode.PARTIAL,
      findings: [
        {
          code: "E_IMPORT_PARTIAL",
          severity: "error",
          message: `The destination was created but writing did not finish: ${error instanceof Error ? error.message : String(error)}`,
          path: result.path,
          fix: "Inspect the partial destination before retrying with a new name. Existing content has been preserved; no rollback was attempted.",
        },
      ],
    });
  }
}

function receipt(record: Record<string, unknown>): ContentEntry {
  return {
    kind: "file",
    path: ".source.yaml",
    mode: 0o644,
    bytes: Buffer.from(`# Provenance recorded by skillex.\n${stringify(record)}`),
  };
}

/** Scaffold one canonical skill without touching any activation roots. */
export async function createSkill(
  name: string,
  options: CreateSkillOptions = {},
): Promise<ResultEnvelope<CatalogWriteResult | null>> {
  const command = "skill create";
  try {
    const destination = await target(name, options);
    const description =
      options.description ?? `Use ${name} for its documented workflow and supporting resources.`;
    if (typeof description !== "string" || !description.trim()) {
      fail("E_SKILL_METADATA_INVALID", "A skill description must be a nonempty string.", {
        fix: "Supply a concise description of when the skill should be used.",
      });
    }
    const entries: ContentEntry[] = [
      {
        kind: "file",
        path: "SKILL.md",
        mode: 0o644,
        bytes: Buffer.from(
          `---\n${stringify({ name, description })}---\n\n# ${name}\n\nDescribe the workflow, required inputs, and expected output here. Keep supporting files in this skill directory.\n`,
        ),
      },
    ];
    entries.push(
      receipt({
        origin: {
          type: "local",
          authored_in: destination.path,
          extracted_at: new Date().toISOString(),
          digest: digestContent(entries),
        },
        modified_locally: false,
      }),
    );
    const result: CatalogWriteResult = {
      registry: destination.registry,
      name,
      path: destination.path,
      dryRun: options.dryRun ?? false,
      changes: [
        { action: "create-directory", path: destination.path },
        ...entries.map((entry) => ({
          action: "create-file",
          path: join(destination.path, entry.path),
        })),
      ],
    };
    return await publish(command, result, entries, 0o755, destination.catalogIdentity);
  } catch (error) {
    return ioResult(command, error);
  }
}

/** Import a fully inspected local tree, retaining the source and its provenance evidence. */
export async function importSkill(
  source: string,
  name: string,
  options: CatalogWriteOptions = {},
): Promise<ResultEnvelope<CatalogWriteResult | null>> {
  const command = "skill import";
  try {
    const destination = await target(name, options);
    if (typeof source !== "string" || !source.trim() || source.includes("\0")) {
      fail("E_IMPORT_SOURCE", "Import requires a nonempty local source path.", {
        fix: "Pass a directory containing a real SKILL.md file.",
      });
    }
    const home = options.home ?? homedir();
    const expanded =
      source === "~" ? home : source.startsWith("~/") ? join(home, source.slice(2)) : source;
    const path = resolve(options.cwd ?? process.cwd(), expanded);
    const sourceInfo = await inspectPath(path);
    if (!sourceInfo?.isDirectory()) {
      fail(
        "E_IMPORT_SOURCE",
        `Import requires a real source directory: ${path}`,
        { path, fix: "Choose the owning directory, not a symlink or a single file." },
        ExitCode.REFUSED,
      );
    }
    const sourceRoot = await realpath(path);
    if (isWithin(sourceRoot, destination.path) || isWithin(destination.path, sourceRoot)) {
      fail(
        "E_IMPORT_RECURSIVE",
        "Import source and canonical destination must not contain one another.",
        {
          path: sourceRoot,
          fix: "Import from a separate skill directory outside the destination tree.",
        },
        ExitCode.REFUSED,
      );
    }
    const content = await captureContent(sourceRoot);
    const metadata = await readSkillMetadata(sourceRoot);
    for (const name of ["SKILL.md", ".source.yaml"]) {
      const captured = content.entries.find((entry) => entry.path === name);
      if (
        captured?.kind === "file" &&
        !captured.bytes.equals(await readFile(join(sourceRoot, name)))
      ) {
        fail("E_IMPORT_SOURCE_CHANGED", "Skill metadata changed while import was being planned.", {
          path: join(sourceRoot, name),
          fix: "Retry after the source writer has finished.",
        });
      }
    }
    const entries = content.entries.filter((entry) => entry.path !== ".source.yaml");
    const digest = digestContent(entries);
    entries.push(
      receipt({
        origin: {
          type: "adhoc",
          imported_from: sourceRoot,
          extracted_at: new Date().toISOString(),
          digest,
          ...(entries.some((entry) => entry.kind === "link")
            ? { digest_format: "skillex-tree-v1+symlinks" }
            : {}),
        },
        modified_locally: false,
        ...(metadata.provenance ? { previous_provenance: metadata.provenance } : {}),
      }),
    );
    const result: CatalogWriteResult = {
      registry: destination.registry,
      name,
      path: destination.path,
      dryRun: options.dryRun ?? false,
      changes: [
        { action: "create-directory", path: destination.path, source: sourceRoot },
        ...entries.map((entry) => ({
          action:
            entry.path === ".source.yaml"
              ? "record-provenance"
              : entry.kind === "directory"
                ? "create-directory"
                : entry.kind === "link"
                  ? entry.target === entry.originalTarget
                    ? "create-link"
                    : "relocate-link"
                  : "copy-file",
          path: join(destination.path, entry.path),
          ...(entry.path !== ".source.yaml" ? { source: join(sourceRoot, entry.path) } : {}),
        })),
        ...content.excluded.map((entry) => ({
          action: "exclude-runtime",
          path: join(sourceRoot, entry),
        })),
      ],
    };
    return await publish(
      command,
      result,
      entries,
      sourceInfo.mode & 0o777,
      destination.catalogIdentity,
    );
  } catch (error) {
    return ioResult(command, error);
  }
}
