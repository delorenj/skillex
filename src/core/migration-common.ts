import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fail, SkillexError } from "./error.js";
import { isSkillName, isVersionComponent, parseManifest } from "./manifest.js";
import type {
  MigrationMapping,
  MigrationOptions,
  MigrationSectionResult,
} from "./migration-types.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";

export function checkMigrationSignal(options: Pick<MigrationOptions, "signal">): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Migration was interrupted.",
      {
        fix: "Inspect the applied items and retry the explicit migration to verify or resume them.",
      },
      ExitCode.INTERRUPTED,
    );
}

function invalid(message: string): never {
  fail("E_MIGRATION_CONFIG", message, {
    fix: "Use an explicit target and a version 1 mapping file; preview before applying.",
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathKey(value: string): boolean {
  return (
    !!value.trim() &&
    !value.includes("\\") &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    (isAbsolute(value) || value.split("/").every((part) => part && part !== "." && part !== ".."))
  );
}

/** Validate authored choices and capture a private, immutable copy before asynchronous work. */
export function parseMigrationMapping(input: unknown): MigrationMapping {
  if (
    !record(input) ||
    input.version !== 1 ||
    Object.keys(input).some(
      (key) =>
        !["version", "names", "references", "digests", "packs", "wrappers", "manifests"].includes(
          key,
        ),
    )
  )
    invalid("Migration mappings require version 1 and known mapping sections.");
  const result: Record<string, unknown> = { version: 1 };
  for (const section of [
    "names",
    "references",
    "digests",
    "packs",
    "wrappers",
    "manifests",
  ] as const) {
    const values = input[section];
    if (values === undefined) continue;
    if (!record(values)) invalid(`Mapping ${section} must be a path-keyed object.`);
    const mapped: Record<string, unknown> = Object.create(null);
    for (const [path, value] of Object.entries(values)) {
      if (!pathKey(path)) invalid(`Mapping ${section} has an invalid source path.`);
      if (section === "names" || section === "references") {
        if (!(section === "references" && value === null) && !isSkillName(value))
          invalid(
            `Mapping ${section} needs canonical names${section === "references" ? " or an explicit null reference retirement" : ""}.`,
          );
        mapped[path] = value;
      } else if (section === "digests") {
        if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
          invalid("Expected content digests must use sha256 and 64 hexadecimal digits.");
        mapped[path] = value;
      } else if (section === "packs") {
        if (
          !record(value) ||
          !isSkillName(value.name) ||
          !isVersionComponent(value.version) ||
          Object.keys(value).some((key) => !["name", "version"].includes(key))
        )
          invalid("Pack mappings need a canonical name and explicit version.");
        mapped[path] = Object.freeze({ name: value.name, version: value.version });
      } else if (section === "wrappers") {
        if (
          !record(value) ||
          !isSkillName(value.name) ||
          !Array.isArray(value.ownedPaths) ||
          !value.ownedPaths.includes("SKILL.md") ||
          new Set(value.ownedPaths).size !== value.ownedPaths.length ||
          !value.ownedPaths.every(
            (part) => typeof part === "string" && pathKey(part) && !isAbsolute(part),
          ) ||
          Object.keys(value).some((key) => !["name", "ownedPaths"].includes(key))
        )
          invalid(
            "Wrapper mappings need a canonical name and explicit relative ownedPaths including SKILL.md.",
          );
        mapped[path] = Object.freeze({
          name: value.name,
          ownedPaths: Object.freeze([...value.ownedPaths]),
        });
      } else {
        if (!record(value))
          invalid("Manifest replacements must be complete current-schema objects.");
        parseManifest(value, path);
        let copy: Record<string, unknown>;
        try {
          copy = structuredClone(value);
        } catch {
          invalid("Manifest replacements must be plain serializable data.");
        }
        const freeze = (v: unknown): unknown => {
          if (v && typeof v === "object") {
            for (const child of Object.values(v)) freeze(child);
            Object.freeze(v);
          }
          return v;
        };
        mapped[path] = freeze(copy);
      }
    }
    result[section] = Object.freeze(mapped);
  }
  return Object.freeze(result) as unknown as MigrationMapping;
}

export function normalizeMigrationOptions(options: MigrationOptions = {}): MigrationOptions {
  if (!options || typeof options !== "object") invalid("Migration options must be an object.");
  const expand = (value: string, home: string, cwd: string): string => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0"))
      invalid("Migration paths must be nonempty.");
    return resolve(
      cwd,
      value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
    );
  };
  const home = expand(options.home ?? homedir(), homedir(), process.cwd());
  const cwd = expand(options.cwd ?? process.cwd(), home, process.cwd());
  if (options.apply !== undefined && typeof options.apply !== "boolean")
    invalid("apply must be boolean.");
  if (options.scope !== undefined && !["global", "project"].includes(options.scope))
    invalid("Select global or project scope explicitly.");
  if (
    options.scope === "global" &&
    (options.project !== undefined || options.profile !== undefined)
  )
    invalid("Global migration cannot also select a project or profile.");
  if (
    (options.scope === "project" || options.profile !== undefined) &&
    options.project === undefined
  )
    invalid("Project and profile migration require --project PATH.");
  const paths: Record<string, string> = {};
  for (const field of [
    "project",
    "registryRoot",
    "sourcesFile",
    "stateHome",
    "hermesRoot",
  ] as const) {
    const value = options[field];
    if (value !== undefined) paths[field] = expand(value, home, cwd);
  }
  return {
    ...options,
    ...paths,
    home,
    cwd,
    ...(options.project !== undefined ? { scope: "project" as const } : {}),
    ...(options.mapping === undefined ? {} : { mapping: parseMigrationMapping(options.mapping) }),
  };
}

export function migrationFailure<T>(command: string, error: unknown, data: T): ResultEnvelope<T> {
  return makeResult(
    command,
    data,
    error instanceof SkillexError
      ? { exit: error.exit, findings: error.findings }
      : {
          exit: ExitCode.FAILURE,
          findings: [
            {
              code: "E_IO",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              fix: "Inspect the migration item and retry after resolving the filesystem error.",
            },
          ],
        },
  );
}

export function emptyMigrationSection(): MigrationSectionResult {
  return { items: [], applied: [], receipts: [] };
}
