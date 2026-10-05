import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BmadCommandClient,
  BmadCommandFile,
  BmadCommandInventory,
  BmadProvenance,
  BmadSkillManifestEntry,
  BmadSourceInstallation,
  BmadSourceModule,
} from "./bmad-types.js";
import { fail } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { isSkillName } from "./manifest.js";
import { ExitCode } from "./result.js";

/** Per-client command layouts discovered on a BMAD-enabled project. Not exhaustive. */
export const BMAD_COMMAND_CLIENTS: ReadonlyArray<{ client: string; layout: string }> = [
  { client: "claude-code", layout: ".claude/commands" },
  { client: "codex", layout: ".codex/prompts" },
  { client: "opencode-agent", layout: ".opencode/command" },
  { client: "opencode-skill", layout: ".opencode/commands" },
  { client: "crush", layout: ".crush/commands" },
  { client: "gemini", layout: ".gemini/commands" },
  { client: "qwen", layout: ".qwen/commands" },
  { client: "augment", layout: ".augment/commands" },
];

export const BMAD_PACK_NAME = "bmad";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}

/** Expand `~` exactly like other skillex path options; the result must be a real directory. */
export async function resolveBmadSource(
  source: string,
  options: { cwd?: string },
): Promise<string> {
  if (typeof source !== "string" || !source.trim() || source.includes("\0")) {
    fail("E_BMAD_SOURCE", "A BMAD freeze requires a nonempty local source path.", {
      fix: "Pass the BMAD-enabled project root, for example `skillex bmad freeze path/to/repo`.",
    });
  }
  const home = homedir();
  const expanded =
    source === "~" ? home : source.startsWith("~/") ? join(home, source.slice(2)) : source;
  const path = resolve(options.cwd ?? process.cwd(), expanded);
  const info = await inspectPath(path);
  if (!info?.isDirectory()) {
    fail(
      "E_BMAD_SOURCE",
      `The BMAD source must be a real local directory: ${path}`,
      {
        path,
        fix: "Point at the project root containing _bmad/ and .agents/skills/; remote URLs are never fetched.",
      },
      ExitCode.REFUSED,
    );
  }
  let root: string;
  try {
    root = await realpath(path);
  } catch (error) {
    fail(
      "E_BMAD_SOURCE",
      `The BMAD source cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      { path, fix: "Choose a readable project checkout." },
      ExitCode.REFUSED,
    );
  }
  const config = await inspectPath(join(root, "_bmad", "_config"));
  const skills = await inspectPath(join(root, ".agents", "skills"));
  if (!config?.isDirectory() || !skills?.isDirectory()) {
    fail(
      "E_BMAD_SOURCE_LAYOUT",
      "The source does not look like a BMAD-enabled project (missing _bmad/_config or .agents/skills).",
      {
        path: root,
        fix: "Freeze from the BMAD-enabled project root; freeze never imports from bare skill directories or remote URLs.",
      },
      ExitCode.REFUSED,
    );
  }
  return root;
}

function parseInstallation(raw: unknown, path: string): BmadSourceInstallation {
  const header = isRecord(raw) ? raw.installation : undefined;
  if (!isRecord(header)) {
    fail(
      "E_BMAD_MANIFEST",
      "The BMAD installation manifest has no [installation] table.",
      { path, fix: "Freeze from a project whose _bmad/_config/manifest.yaml is intact." },
      ExitCode.REFUSED,
    );
  }
  const version = text(header.version);
  if (!version) {
    fail(
      "E_BMAD_MANIFEST",
      "The BMAD installation manifest has no installation.version.",
      { path, fix: "Record the installed BMAD version in _bmad/_config/manifest.yaml first." },
      ExitCode.REFUSED,
    );
  }
  return {
    version: version as string,
    installDate: text(header.installDate),
    lastUpdated: text(header.lastUpdated),
  };
}

function parseModules(raw: unknown): BmadSourceModule[] {
  if (!isRecord(raw) || !Array.isArray(raw.modules)) return [];
  const modules: BmadSourceModule[] = [];
  for (const entry of raw.modules) {
    if (!isRecord(entry)) continue;
    const name = text(entry.name);
    if (!name) continue;
    modules.push({
      name,
      version: text(entry.version) ?? "unknown",
      source: text(entry.source),
      repoUrl: text(entry.repoUrl),
      sha: text(entry.sha),
    });
  }
  return modules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Read the source's own manifests. Entirely offline; nothing is fetched. */
export async function inspectBmadSource(sourceRoot: string): Promise<BmadProvenance> {
  const config = join(sourceRoot, "_bmad", "_config");
  const manifestPath = join(config, "manifest.yaml");
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(
      "E_BMAD_MANIFEST",
      `Cannot read the BMAD installation manifest: ${error instanceof Error ? error.message : String(error)}`,
      { path: manifestPath, fix: "Restore _bmad/_config/manifest.yaml from the source install." },
      ExitCode.REFUSED,
    );
  }
  const installation = parseInstallation(raw, manifestPath);
  const modules = parseModules(raw);
  let skillManifestSha256: string | null = null;
  try {
    skillManifestSha256 = await sha256File(join(config, "skill-manifest.csv"));
  } catch {
    /* The skill manifest is advisory; absence is reported through membership reconciliation. */
  }
  let filesManifestSha256: string | null = null;
  let filesManifestDeclared = 0;
  let filesManifestMissing = 0;
  try {
    const filesManifest = join(config, "files-manifest.csv");
    filesManifestSha256 = await sha256File(filesManifest);
    const lines = (await readFile(filesManifest, "utf8")).split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      filesManifestDeclared += 1;
      const record = parseCsvLine(line);
      const declaredPath = record[3];
      if (typeof declaredPath !== "string" || !declaredPath) continue;
      const absolute = join(sourceRoot, "_bmad", declaredPath);
      const info = await inspectPath(absolute);
      if (!info?.isFile()) filesManifestMissing += 1;
    }
  } catch {
    /* A pruned or absent files manifest is source evidence, not a freeze failure. */
  }
  return {
    sourceRoot,
    installation,
    modules,
    skillManifestSha256,
    filesManifestSha256,
    filesManifestDeclared,
    filesManifestMissing,
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quoted) {
      if (character === '"' && line.charAt(index + 1) === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Membership source of truth: the source's skill-manifest.csv, reconciled against the
 * rendered .agents/skills tree. Rendered bmad-* directories absent from the manifest are
 * inventoried as foreign (installer-owned), never imported silently.
 */
export async function readBmadSkillManifest(
  sourceRoot: string,
): Promise<{ entries: BmadSkillManifestEntry[]; path: string }> {
  const path = join(sourceRoot, "_bmad", "_config", "skill-manifest.csv");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    fail(
      "E_BMAD_MANIFEST",
      `Cannot read the BMAD skill manifest: ${error instanceof Error ? error.message : String(error)}`,
      { path, fix: "Restore _bmad/_config/skill-manifest.csv from the source install." },
      ExitCode.REFUSED,
    );
  }
  const lines = content.split(/\r?\n/);
  const header = lines[0] ?? "";
  if (!/^canonicalId,name,description,module,path/.test(header)) {
    fail(
      "E_BMAD_MANIFEST",
      "The BMAD skill manifest header is not the expected canonicalId,name,description,module,path shape.",
      { path, fix: "Freeze from a source install whose skill manifest the BMAD installer wrote." },
      ExitCode.REFUSED,
    );
  }
  const entries: BmadSkillManifestEntry[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const record = parseCsvLine(line);
    const canonicalId = record[0] ?? "";
    const name = record[1] ?? canonicalId;
    const description = record[2] ?? "";
    const module = record[3] ?? null;
    const declaredPath = record[4] ?? null;
    if (!isSkillName(name)) continue;
    entries.push({
      canonicalId,
      name,
      description: description || null,
      module,
      path: declaredPath || null,
    });
  }
  return { entries, path };
}

export interface BmadCommandScan {
  readonly inventory: BmadCommandInventory;
  readonly totalFiles: number;
  readonly danglingFiles: number;
}

const BMAD_REFERENCE_PATTERN = /\{project-root\}\/(_bmad\/[A-Za-z0-9_./-]+)/g;

export function bmadCommandRefs(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(BMAD_REFERENCE_PATTERN)) refs.add(match[1] as string);
  return [...refs].sort();
}

/**
 * Copy each client's command layout byte-for-byte. Original assets are preserved; files
 * whose `_bmad/...` references are dangling in the source install are imported but
 * reported, never silently rewritten into shims.
 */
export async function scanBmadCommands(
  sourceRoot: string,
  packVersionPath: string,
): Promise<BmadCommandScan> {
  const clients: BmadCommandClient[] = [];
  const files: BmadCommandFile[] = [];
  for (const { client, layout } of BMAD_COMMAND_CLIENTS) {
    const directory = join(sourceRoot, ...layout.split("/"));
    const info = await inspectPath(directory);
    if (!info?.isDirectory()) continue;
    let imported = 0;
    let dangling = 0;
    const names: string[] = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!name.startsWith("bmad-") || name.endsWith("~")) continue;
      names.push(name);
    }
    for (const name of names) {
      const sourcePath = join(directory, name);
      const stat = await lstat(sourcePath);
      if (!stat.isFile()) continue;
      const bytes = await readFile(sourcePath);
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const refs = bmadCommandRefs(content);
      const danglingRefs: string[] = [];
      for (const ref of refs) {
        const target = join(sourceRoot, ref);
        const targetInfo = await inspectPath(target);
        if (!targetInfo?.isFile()) danglingRefs.push(ref);
      }
      if (danglingRefs.length) dangling += 1;
      imported += 1;
      const path = join(packVersionPath, "commands", client, name);
      files.push({
        name,
        client,
        layout,
        path,
        sourcePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        bmadRefs: refs,
        danglingRefs,
      });
    }
    clients.push({ client, layout, directory, imported, dangling });
  }
  return {
    inventory: { clients, files },
    totalFiles: files.length,
    danglingFiles: files.filter((file) => file.danglingRefs.length > 0).length,
  };
}

/** Absolute, safe version directory; refuses any traversal outside the pack family. */
export function bmadPackPath(registryRoot: string, version: string): string {
  if (typeof version !== "string" || !version.trim() || version.includes("\0")) {
    fail("E_BMAD_VERSION", "A BMAD freeze requires a nonempty version.", {
      fix: "Let the version default to the source installation.version or pass --version explicitly.",
    });
  }
  if (
    version.split("/").some((part) => !part || part === "." || part === "..") ||
    version.includes(sep)
  ) {
    fail("E_BMAD_VERSION", `Unsafe BMAD pack version: ${version}`, {
      fix: "Use the installation version as recorded in _bmad/_config/manifest.yaml.",
    });
  }
  const family = join(registryRoot, "packs", BMAD_PACK_NAME);
  const path = join(family, version);
  if (dirname(path) !== family) {
    fail("E_BMAD_VERSION", `Unsafe BMAD pack version: ${version}`, {
      fix: "Use a safe single path component.",
    });
  }
  return path;
}

/** The rendered skill bytes are the only complete source: the source's own tree is pruned. */
export function renderedSkillDir(sourceRoot: string, name: string): string {
  return join(sourceRoot, ".agents", "skills", name);
}

export async function requireRenderedSkill(sourceRoot: string, name: string): Promise<string> {
  const path = renderedSkillDir(sourceRoot, name);
  const info = await inspectPath(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(
      "E_BMAD_SKILL_MISSING",
      `Skill ${name} is declared in the BMAD skill manifest but has no rendered definition in .agents/skills.`,
      {
        path,
        name,
        fix: "Re-run the BMAD installer in the source project so the rendered skills exist, then freeze again.",
      },
      ExitCode.REFUSED,
    );
  }
  const skill = await inspectPath(join(path, "SKILL.md"));
  if (!skill?.isFile()) {
    fail(
      "E_BMAD_SKILL_MISSING",
      `Rendered skill ${name} has no real SKILL.md.`,
      {
        path: join(path, "SKILL.md"),
        name,
        fix: "Restore the rendered skill from the source install before freezing.",
      },
      ExitCode.REFUSED,
    );
  }
  return path;
}
