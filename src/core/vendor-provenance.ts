import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { type ContentEntry, captureContent, digestContent } from "./content.js";
import { fail } from "./error.js";
import { requireDirectory } from "./filesystem.js";
import { parseProvenanceMetadata } from "./metadata.js";
import { ExitCode } from "./result.js";
import { readVendorText } from "./vendor-sources.js";
import type { VendorProvenance, VendorProvenanceInput } from "./vendor-types.js";

const fields = [
  "type",
  "source",
  "upstream",
  "upstream_version",
  "upstream_commit",
  "upstream_tree",
  "upstream_path",
  "extracted_at",
  "digest",
  "digest_format",
] as const;
const administration = new Set([".git", ".hg", ".svn"]);

function invalid(path: string, message: string): never {
  fail("E_SKILL_PROVENANCE_INVALID", message, {
    path,
    fix: "Correct the known provenance field while preserving the original recorded evidence.",
  });
}

/** Parse known fields without treating absence, a local flag, or unknown metadata as ownership. */
export function parseVendorProvenance(
  raw: Readonly<Record<string, unknown>>,
  path: string,
): VendorProvenance {
  const value = raw.origin;
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
    invalid(path, "Provenance origin must be a mapping.");
  if (raw.modified_locally !== undefined && typeof raw.modified_locally !== "boolean")
    invalid(path, "Provenance modified_locally must be boolean.");
  const origin = (value ?? {}) as Record<string, unknown>;
  for (const field of fields)
    if (origin[field] !== undefined && typeof origin[field] !== "string")
      invalid(path, `Provenance origin.${field} must be text when supplied.`);
  if (
    origin.digest !== undefined &&
    (typeof origin.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(origin.digest))
  )
    invalid(path, "Recorded digest must be sha256 followed by 64 lowercase hexadecimal digits.");
  for (const field of ["upstream_commit", "upstream_tree"] as const)
    if (
      origin[field] !== undefined &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(origin[field] as string)
    )
      invalid(path, `Provenance origin.${field} must be a full SHA-1 or SHA-256 Git object ID.`);
  if (typeof origin.upstream_path === "string") {
    const value = origin.upstream_path;
    if (
      value.includes("\\") ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      (value !== "" && value.split("/").some((part) => !part || part === "." || part === ".."))
    )
      invalid(path, "Provenance origin.upstream_path must be a safe repository-relative path.");
  }
  const text = (field: (typeof fields)[number]) =>
    typeof origin[field] === "string" ? origin[field] : null;
  return {
    path,
    type: text("type") ?? "local",
    source: text("source"),
    upstream: text("upstream"),
    upstreamVersion: text("upstream_version"),
    upstreamCommit: text("upstream_commit"),
    upstreamTree: text("upstream_tree"),
    upstreamPath: text("upstream_path"),
    extractedAt: text("extracted_at"),
    digest: text("digest"),
    digestFormat: text("digest_format"),
    modifiedLocally: raw.modified_locally === true,
    raw,
  };
}

export async function readVendorProvenance(skillPath: string): Promise<VendorProvenance | null> {
  const root = await requireDirectory(skillPath, "E_SKILL_MISSING");
  const path = join(root, ".source.yaml");
  const text = await readVendorText(path, "E_SKILL_PROVENANCE_INVALID");
  return text === null ? null : parseVendorProvenance(parseProvenanceMetadata(text, path), path);
}

export function serializeVendorProvenance(input: VendorProvenanceInput): string {
  const raw = {
    origin: {
      type: "vendored",
      source: input.source.name,
      upstream: input.source.repo,
      upstream_version: input.source.version,
      upstream_commit: input.commit,
      upstream_tree: input.tree,
      upstream_path: input.upstreamPath,
      extracted_at: input.extractedAt,
      digest: input.digest,
    },
    modified_locally: false,
    ...(input.previousProvenance ? { previous_provenance: input.previousProvenance } : {}),
  };
  const text = stringify(raw, { lineWidth: 0 });
  parseVendorProvenance(parseProvenanceMetadata(text, ".source.yaml"), ".source.yaml");
  return text;
}

function unsafe(path: string, message: string): never {
  fail(
    "E_PROVENANCE_CONTENT_UNSAFE",
    message,
    {
      path,
      fix: "Restore stable real skill content before checking or updating the recorded provenance.",
    },
    ExitCode.REFUSED,
  );
}

function same(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readRegular(
  path: string,
  before: Stats,
  consume: (bytes: Buffer) => void,
): Promise<void> {
  if (!before.isFile())
    unsafe(path, "Vendored skill content must contain regular files and real directories only.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, await handle.stat()))
      unsafe(path, "Skill content changed before it could be observed.");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset <= before.size) {
      const read = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size + 1 - offset),
        offset,
      );
      if (!read.bytesRead) break;
      consume(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if (
      offset !== before.size ||
      !same(before, await handle.stat()) ||
      !same(before, await lstat(path))
    )
      unsafe(path, "Skill content changed during observation.");
  } finally {
    await handle.close();
  }
}

/** Python tree wire format: all authored files, root .source.yaml excluded, executable mode included. */
export async function digestVendorTree(skillPath: string): Promise<string> {
  const root = await requireDirectory(skillPath, "E_SKILL_MISSING");
  const records: { path: string; line: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    const before = await lstat(directory);
    if (!before.isDirectory())
      unsafe(directory, "Vendored skill directories must be real directories.");
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === ".source.yaml") continue;
      const path = join(directory, name);
      if (administration.has(name))
        unsafe(path, "Repository administration is not vendored skill content.");
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else {
        const digest = createHash("sha256");
        await readRegular(path, info, (bytes) => digest.update(bytes));
        const relpath = relative(root, path).split(sep).join("/");
        records.push({
          path: relpath,
          line: `${info.mode & 0o100 ? "100755" : "100644"} ${digest.digest("hex")}  ${relpath}`,
        });
      }
    }
    if (!same(before, await lstat(directory)))
      unsafe(directory, "Skill membership changed during observation.");
  };
  await visit(root);
  records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return `sha256:${createHash("sha256")
    .update(records.length ? `${records.map((record) => record.line).join("\n")}\n` : "")
    .digest("hex")}`;
}

/** Preserve C03 imported-link and C07 doctor digest semantics while sharing regular vendored checks. */
export async function digestRecordedSkill(
  skillPath: string,
  provenance: Pick<VendorProvenance, "type" | "digestFormat">,
): Promise<string> {
  if (provenance.type === "vendored" && provenance.digestFormat !== "skillex-tree-v1+symlinks")
    return digestVendorTree(skillPath);
  const content = await captureContent(skillPath);
  const entries: ContentEntry[] = content.entries.map((entry) =>
    entry.kind === "link" ? { ...entry, target: entry.originalTarget } : entry,
  );
  if (provenance.type === "vendored") {
    for (const excluded of content.excluded) {
      if (excluded.split(sep).some((name) => administration.has(name)))
        unsafe(
          join(skillPath, excluded),
          "Repository administration is not vendored skill content.",
        );
      await appendRegularContent(skillPath, join(skillPath, excluded), entries);
    }
  }
  if (
    entries.some((entry) => entry.kind === "link") &&
    provenance.digestFormat !== "skillex-tree-v1+symlinks"
  )
    unsafe(
      join(skillPath, ".source.yaml"),
      "This recorded digest format does not support symbolic links.",
    );
  return digestContent(entries);
}

async function appendRegularContent(
  root: string,
  path: string,
  entries: ContentEntry[],
): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) {
      if (administration.has(name))
        unsafe(join(path, name), "Repository administration is not vendored skill content.");
      await appendRegularContent(root, join(path, name), entries);
    }
    if (!same(info, await lstat(path)))
      unsafe(path, "Skill membership changed during observation.");
  } else {
    const chunks: Buffer[] = [];
    await readRegular(path, info, (chunk) => chunks.push(Buffer.from(chunk)));
    entries.push({
      path: relative(root, path),
      kind: "file",
      mode: info.mode & 0o777,
      bytes: Buffer.concat(chunks),
    });
  }
}
