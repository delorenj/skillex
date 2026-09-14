import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { isSkillName } from "./manifest.js";
import { type Diagnostic, ExitCode } from "./result.js";
import type {
  VendorCheckout,
  VendorOptions,
  VendorSource,
  VendorSourceSkill,
  VendorSourcesManifest,
} from "./vendor-types.js";

const component = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const version = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;
const sourceFields = new Set([
  "name",
  "repo",
  "version",
  "checkout",
  "subdir",
  "skills",
  "include",
  "exclude",
  "optional",
]);
const legacyFields = new Set(["clone", "fetch", "auto_fetch", "url", "ref", "path"]);

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(path: string, message: string): never {
  fail("E_SOURCES_MANIFEST_INVALID", message, {
    path,
    fix: "Correct the version 1 source declaration; use logical checkout IDs and canonical skill names.",
  });
}

function safeComponent(value: unknown): value is string {
  return typeof value === "string" && component.test(value) && ![".", ".."].includes(value);
}

function safeRelative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    (value === "" || value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

function names(value: unknown, field: string, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isSkillName) || new Set(value).size !== value.length)
    invalid(path, `${field} must contain unique canonical skill names.`);
  return value;
}

function parseSource(value: unknown, path: string): VendorSource {
  if (!mapping(value)) invalid(path, "Each [[source]] entry must be a table.");
  for (const field of Object.keys(value)) {
    if (legacyFields.has(field))
      fail("E_LEGACY_FIELD", `Unsupported source field: ${field}`, {
        path,
        fix: "Use repo/version/subdir and a logical checkout ID. Vendoring never clones or fetches.",
      });
    if (!sourceFields.has(field)) invalid(path, `Unknown source field: ${field}`);
  }
  if (!safeComponent(value.name))
    invalid(path, "Source name must be one safe alphanumeric component.");
  if (
    typeof value.repo !== "string" ||
    !/^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@|file:\/\/).+/.test(value.repo) ||
    /[\s\0]/.test(value.repo)
  )
    invalid(path, `Source ${value.name} needs a repository URL or SSH identity.`);
  if (
    typeof value.version !== "string" ||
    !version.test(value.version) ||
    value.version.includes("..")
  )
    invalid(path, `Source ${value.name} needs a safe Git tag, branch, or commit.`);
  const checkout = value.checkout ?? value.name;
  if (!safeComponent(checkout))
    invalid(path, `Source ${value.name} checkout must be a logical ID, not a machine path.`);
  const subdir = value.subdir ?? "skills";
  if (!safeRelative(subdir))
    invalid(path, `Source ${value.name} subdir must be a safe repository-relative path.`);
  if (value.optional !== undefined && typeof value.optional !== "boolean")
    invalid(path, `Source ${value.name} optional must be boolean.`);
  const include = names(value.include, "include", path);
  const exclude = names(value.exclude, "exclude", path);
  if (value.skills !== undefined && !Array.isArray(value.skills))
    invalid(path, "Source skills must be an array of names or {name, dir} tables.");
  if (value.skills !== undefined && (value.include !== undefined || value.exclude !== undefined))
    invalid(
      path,
      "Explicit source skills and discovery include/exclude selectors are mutually exclusive.",
    );
  const skills: VendorSourceSkill[] = [];
  for (const item of (value.skills ?? []) as unknown[]) {
    const member = typeof item === "string" ? { name: item } : item;
    if (
      !mapping(member) ||
      Object.keys(member).some((key) => !["name", "dir"].includes(key)) ||
      !isSkillName(member.name)
    )
      invalid(
        path,
        "Each explicit source skill needs a canonical name and optional directory component.",
      );
    const dir = member.dir ?? member.name;
    if (!safeComponent(dir))
      invalid(path, `Source skill ${member.name} dir must be one safe path component.`);
    if (skills.some((skill) => skill.name === member.name))
      invalid(path, `Duplicate source skill name: ${member.name}`);
    skills.push({ name: member.name, dir });
  }
  return {
    name: value.name,
    repo: value.repo,
    version: value.version,
    checkout,
    subdir,
    membership: value.skills !== undefined ? "explicit" : "discovery",
    skills,
    include,
    exclude,
    optional: value.optional ?? false,
  };
}

export function checkVendorSignal(options: Pick<VendorOptions, "signal">): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Vendor inspection was interrupted.",
      {
        fix: "Rerun the command to obtain a complete source observation.",
      },
      ExitCode.INTERRUPTED,
    );
}

/** Load the owning catalog's declaration only; prepared migration files are never fallback input. */
export async function readVendorSources(
  options: VendorOptions = {},
): Promise<VendorSourcesManifest> {
  checkVendorSignal(options);
  const registry = await discoverRegistry(options);
  const path = join(registry.root, "all-skills", "sources.toml");
  const text = await readVendorText(path, "E_SOURCES_MANIFEST_INVALID");
  if (text === null)
    fail("E_SOURCES_MANIFEST_MISSING", "The catalog has no all-skills/sources.toml declaration.", {
      path,
      fix: "Declare the upstream sources in all-skills/sources.toml; onboard prepared declarations through skillex migrate.",
    });
  const sources = parseVendorSourcesText(text, path);
  for (const id of Object.keys(options.checkouts ?? {})) {
    if (!sources.some((source) => source.checkout === id))
      fail("E_SOURCE_CHECKOUT_UNKNOWN", `No declared source uses checkout ID ${id}.`, {
        path,
        fix: "Use a declared logical checkout ID with --checkout ID=PATH.",
      });
  }
  checkVendorSignal(options);
  return { path, registry, version: 1, sources };
}

/** Internal parser shared with explicit migration of a prepared declaration. */
export function parseVendorSourcesText(text: string, path: string): readonly VendorSource[] {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text);
  } catch {
    invalid(path, "Source declarations must contain valid TOML.");
  }
  if (
    Object.keys(raw).some((field) => !["version", "source"].includes(field)) ||
    (raw.version !== undefined && raw.version !== 1) ||
    (raw.source !== undefined && !Array.isArray(raw.source))
  )
    invalid(path, "Use version = 1 and [[source]] tables only.");
  const sources = ((raw.source ?? []) as unknown[]).map((source) => parseSource(source, path));
  if (new Set(sources.map((source) => source.name)).size !== sources.length)
    invalid(path, "Source names must be unique.");
  return sources;
}

export function selectVendorSources(
  manifest: VendorSourcesManifest,
  selected: readonly string[] = [],
): readonly VendorSource[] {
  if (!Array.isArray(selected) || selected.some((name) => typeof name !== "string"))
    invalid(manifest.path, "Source selection must be an array of source names.");
  const names = selected.length
    ? [...new Set(selected)]
    : manifest.sources.map((source) => source.name);
  return names.map((name) => {
    const source = manifest.sources.find((source) => source.name === name);
    if (!source)
      fail("E_SOURCE_UNKNOWN", `No source named ${name} is declared.`, {
        path: manifest.path,
        name,
        detail: manifest.sources.map((entry) => entry.name),
        fix: "Select a source from vendor list or add the missing source declaration.",
      });
    return source;
  });
}

export function vendorCheckoutEnvironmentKey(id: string): string {
  return `SKILLEX_SOURCE_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

export function normalizeVendorRepo(repo: string): string {
  return repo
    .trim()
    .replace(/\/+$/, "")
    .replace(/^(?:https?:\/\/|ssh:\/\/(?:git@)?|git:\/\/)/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function machinePath(value: unknown, cwd: string, home: string, path?: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail("E_SOURCE_CHECKOUT_INVALID", "Checkout paths must be nonempty filesystem paths.", {
      ...(path ? { path } : {}),
      fix: "Choose an existing local checkout path; explicit overrides never fall through.",
    });
  return resolve(
    cwd,
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}

/** Directory discovery is separate from Git observation, so list/show remain useful before checkout. */
export async function resolveVendorCheckout(
  source: VendorSource,
  options: VendorOptions = {},
): Promise<VendorCheckout> {
  checkVendorSignal(options);
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const key = vendorCheckoutEnvironmentKey(source.checkout);
  const candidates: { path: string; source: VendorCheckout["source"] }[] = [];
  if (Object.hasOwn(options.checkouts ?? {}, source.checkout))
    candidates.push({
      path: machinePath(options.checkouts?.[source.checkout], cwd, home),
      source: "argument",
    });
  else if (env[key] !== undefined)
    candidates.push({ path: machinePath(env[key], cwd, home), source: "environment" });
  else {
    const configHome =
      env.XDG_CONFIG_HOME === undefined
        ? join(home, ".config")
        : machinePath(env.XDG_CONFIG_HOME, cwd, home);
    const path = join(configHome, "skillex", "sources.local.toml");
    const text = await readVendorText(path, "E_SOURCE_CHECKOUTS_INVALID", true);
    if (text !== null) {
      let raw: Record<string, unknown>;
      try {
        raw = parseToml(text);
      } catch {
        fail("E_SOURCE_CHECKOUTS_INVALID", "Machine-local checkout mappings are not valid TOML.", {
          path,
          fix: "Correct the [checkouts] table before using its fallback paths.",
        });
      }
      if (
        Object.keys(raw).some((field) => field !== "checkouts") ||
        (raw.checkouts !== undefined && !mapping(raw.checkouts))
      )
        fail("E_SOURCE_CHECKOUTS_INVALID", "Local mappings must contain a [checkouts] table.", {
          path,
          fix: "Map logical checkout IDs to nonempty filesystem path strings.",
        });
      for (const [id, value] of Object.entries((raw.checkouts ?? {}) as Record<string, unknown>)) {
        if (
          !safeComponent(id) ||
          typeof value !== "string" ||
          !value.trim() ||
          value.includes("\0")
        )
          fail(
            "E_SOURCE_CHECKOUTS_INVALID",
            "A local checkout mapping has an invalid ID or path.",
            { path, fix: "Use logical checkout IDs and nonempty filesystem path strings." },
          );
        if (id === source.checkout)
          candidates.push({ path: machinePath(value, cwd, home, path), source: "mapping" });
      }
    }
    const root =
      env.SKILLEX_SOURCE_ROOT === undefined
        ? join(home, "code")
        : machinePath(env.SKILLEX_SOURCE_ROOT, cwd, home);
    candidates.push({ path: join(root, source.checkout), source: "default" });
  }
  const searched: string[] = [];
  for (const candidate of candidates) {
    if (searched.includes(candidate.path)) continue;
    searched.push(candidate.path);
    let info: Stats;
    try {
      info = await stat(candidate.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(candidate.path);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw missing;
        }
      }
      fail("E_SOURCE_CHECKOUT_INVALID", "The selected checkout cannot be inspected.", {
        path: candidate.path,
        fix: "Repair the selected local checkout path; inspection never fetches or clones.",
      });
    }
    if (!info.isDirectory())
      fail("E_SOURCE_CHECKOUT_INVALID", "The selected checkout is not a directory.", {
        path: candidate.path,
        fix: "Point this checkout ID at a local Git working tree.",
      });
    return {
      id: source.checkout,
      root: await realpath(candidate.path),
      source: candidate.source,
      searched,
    };
  }
  return {
    id: source.checkout,
    root: null,
    source: candidates.at(-1)?.source ?? "default",
    searched,
  };
}

/** Stable, bounded text observation; declaration/receipt entries must be real files. */
export async function readVendorText(
  path: string,
  code: Diagnostic["code"],
  allowLink = false,
): Promise<string | null> {
  let target = path;
  let before: Stats;
  let found = false;
  try {
    before = await lstat(path);
    found = true;
    if (before.isSymbolicLink() && allowLink) {
      target = await realpath(path);
      before = await lstat(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !found) return null;
    fail(
      "E_IO",
      "Cannot inspect vendor metadata.",
      { path, fix: "Check metadata paths and read permissions." },
      ExitCode.FAILURE,
    );
  }
  if (before.isSymbolicLink())
    fail(
      "E_NONCANONICAL_REFERENCE",
      "Vendor metadata must not be a symbolic link.",
      {
        path,
        fix: "Restore the metadata as a real file owned by this catalog entry.",
      },
      ExitCode.REFUSED,
    );
  if (!before.isFile())
    fail(code, "Vendor metadata must be a real regular file.", {
      path,
      fix: "Restore a regular metadata file before inspecting or updating this source.",
    });
  if (before.size > 2_000_000)
    fail(code, "Vendor metadata exceeds its supported size.", {
      path,
      fix: "Keep declarations and provenance metadata below 2 MB.",
    });
  let bytes: Buffer;
  try {
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
        fail(
          "E_VENDOR_SOURCE_CHANGED",
          "Vendor metadata was replaced during observation.",
          {
            path,
            fix: "Retry after the other source writer has finished.",
          },
          ExitCode.REFUSED,
        );
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      bytes = buffer.subarray(0, offset);
      if (bytes.length !== before.size)
        fail(
          "E_VENDOR_SOURCE_CHANGED",
          "Vendor metadata changed size during observation.",
          {
            path,
            fix: "Retry after the other source writer has finished.",
          },
          ExitCode.REFUSED,
        );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SkillexError) throw error;
    fail(
      "E_IO",
      "Cannot read vendor metadata.",
      { path, fix: "Check that metadata is readable and retry." },
      ExitCode.FAILURE,
    );
  }
  const after = await lstat(target);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    fail(
      "E_VENDOR_SOURCE_CHANGED",
      "Vendor metadata changed during observation.",
      { path, fix: "Retry after the other source writer has finished." },
      ExitCode.REFUSED,
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code, "Vendor metadata must be valid UTF-8 text.", {
      path,
      fix: "Save this metadata file as UTF-8 and retry.",
    });
  }
}
