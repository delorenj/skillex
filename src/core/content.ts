import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fail } from "./error.js";
import { ExitCode } from "./result.js";

export type ContentEntry =
  | { readonly path: string; readonly kind: "directory"; readonly mode: number }
  | { readonly path: string; readonly kind: "file"; readonly mode: number; readonly bytes: Buffer }
  | {
      readonly path: string;
      readonly kind: "link";
      readonly target: string;
      readonly originalTarget: string;
      readonly targetPath: string;
    };

export interface CapturedContent {
  readonly entries: readonly ContentEntry[];
  readonly excluded: readonly string[];
}

export function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

const repositoryNames = new Set([".git", ".hg", ".svn"]);

const generatedNames = new Set([
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".codegraph",
  ".venv",
  "node_modules",
]);

/**
 * Build, cache, and runtime artifacts that a tool writes and can write again: dependency trees,
 * bytecode, virtualenvs, caches, pid/socket/WAL files. Never authored skill content. This is the
 * only set migration may skip: it carries every other entry, because a migration that drops an
 * authored file (an `.env.<variant>.example`, a `*.log` fixture, a `*.bak`) destroys it.
 */
export function generatedName(name: string): boolean {
  return generatedNames.has(name) || /\.(?:pyc|pyo|pid|sock|db-wal|db-shm)$/.test(name);
}

/**
 * Import-time exclusions: generated artifacts plus repository administration, logs, backups, and
 * secrets. A fresh import is a deliberate curation step that may leave these behind; migration
 * of existing content is not, and uses generatedName instead.
 */
function excludedName(name: string): boolean {
  return (
    repositoryNames.has(name) ||
    generatedName(name) ||
    /(?:\.(?:log|bak|orig)|~)$/.test(name) ||
    /(?:\.bak-|-backup\.)/.test(name) ||
    (/^\.env(?:\.|$)/.test(name) &&
      ![".env.op", ".env.example", ".env.sample", ".env.template"].includes(name))
  );
}

function contentFailure(path: string, message: string): never {
  fail(
    "E_IMPORT_CONTENT",
    message,
    { path, fix: "Keep regular support files and portable internal links, then retry the import." },
    ExitCode.REFUSED,
  );
}

/** Capture bytes before mutation and retain every authored support entry. */
export async function captureContent(root: string): Promise<CapturedContent> {
  const entries: ContentEntry[] = [];
  const excluded: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const source = join(path, name);
      const item = relative(root, source);
      if (excludedName(name)) {
        excluded.push(item);
        continue;
      }
      const metadata = await lstat(source);
      if (metadata.isDirectory()) {
        entries.push({ path: item, kind: "directory", mode: metadata.mode & 0o777 });
        await visit(source);
      } else if (metadata.isFile()) {
        const bytes = await readFile(source);
        const after = await lstat(source);
        if (
          metadata.dev !== after.dev ||
          metadata.ino !== after.ino ||
          metadata.mode !== after.mode ||
          metadata.size !== after.size ||
          metadata.mtimeMs !== after.mtimeMs
        ) {
          contentFailure(source, `Source changed while being inspected: ${source}`);
        }
        entries.push({ path: item, kind: "file", mode: metadata.mode & 0o777, bytes });
      } else if (metadata.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(source);
        } catch (error) {
          if (
            !["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
          ) {
            throw error;
          }
          contentFailure(source, `Import refuses a dangling or cyclic support link: ${source}`);
        }
        if (!isWithin(root, target)) {
          contentFailure(source, `Support link points outside the imported skill: ${source}`);
        }
        const originalTarget = await readlink(source);
        entries.push({
          path: item,
          kind: "link",
          target: relative(dirname(source), target) || ".",
          originalTarget,
          targetPath: relative(root, target),
        });
      } else {
        contentFailure(source, `Import refuses a special filesystem entry: ${source}`);
      }
    }
  };
  await visit(root);
  const indexed = new Map(entries.map((entry) => [entry.path, entry]));
  const edges = new Map<string, string[]>([["", []]]);
  for (const entry of entries) {
    if (entry.kind === "directory") edges.set(entry.path, []);
  }
  for (const entry of entries) {
    const parent = dirname(entry.path) === "." ? "" : dirname(entry.path);
    if (entry.kind === "directory") edges.get(parent)?.push(entry.path);
    if (entry.kind !== "link") continue;
    const target = entry.targetPath === "" ? { kind: "directory" } : indexed.get(entry.targetPath);
    if (!target) {
      contentFailure(
        join(root, entry.path),
        `Support link depends on excluded content: ${join(root, entry.path)}`,
      );
    }
    if (target.kind === "directory") edges.get(parent)?.push(entry.targetPath);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const checkCycles = (directory: string): void => {
    if (visiting.has(directory)) {
      contentFailure(join(root, directory), "Support directory links form a cycle.");
    }
    if (visited.has(directory)) return;
    visiting.add(directory);
    for (const child of edges.get(directory) ?? []) checkCycles(child);
    visiting.delete(directory);
    visited.add(directory);
  };
  checkCycles("");
  return { entries, excluded };
}

/** Existing Python vendor digest wire format, extended with Git's symlink mode. */
export function digestContent(entries: readonly ContentEntry[]): string {
  const lines = entries
    .filter((entry) => entry.kind !== "directory" && entry.path !== ".source.yaml")
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((entry) => {
      if (entry.kind === "directory") return "";
      const mode = entry.kind === "link" ? "120000" : entry.mode & 0o100 ? "100755" : "100644";
      const bytes = entry.kind === "link" ? Buffer.from(entry.target) : entry.bytes;
      const digest = createHash("sha256").update(bytes).digest("hex");
      return `${mode} ${digest}  ${entry.path.split(sep).join("/")}`;
    });
  return `sha256:${createHash("sha256")
    .update(lines.length ? `${lines.join("\n")}\n` : "")
    .digest("hex")}`;
}
