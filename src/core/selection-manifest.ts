import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fail, SkillexError } from "./error.js";
import { requireDirectory } from "./filesystem.js";
import { parseManifest } from "./manifest.js";
import { ExitCode } from "./result.js";
import type { SkillsManifest } from "./selection.js";

export interface SelectionManifestSnapshot {
  readonly root: string;
  readonly path: string;
  readonly exists: boolean;
  readonly raw: Readonly<Record<string, unknown>> | null;
  readonly manifest: SkillsManifest | null;
}

/** The declaration may already be saved even when later durability checks fail. */
export class SelectionManifestWriteError extends SkillexError {
  constructor(
    error: SkillexError,
    readonly published: boolean,
  ) {
    super(error.exit, error.findings);
    this.name = "SelectionManifestWriteError";
    this.cause = error;
  }
}

interface Context {
  readonly root: string;
  readonly path: string;
  readonly agents: string;
  readonly parents: Map<string, BigIntStats>;
}

interface StoredFile {
  readonly bytes: Buffer;
  readonly identity: BigIntStats;
}

interface Evidence {
  readonly context: Context;
  readonly file?: StoredFile;
}

const snapshots = new WeakMap<object, Evidence>();

function conflict(path: string, message: string): never {
  fail(
    "E_MANIFEST_CHANGED",
    message,
    {
      path,
      fix: "Preserve the changed content and reread this scope under the activation lock before retrying.",
    },
    ExitCode.REFUSED,
  );
}

function unsafe(path: string, message: string): never {
  fail(
    "E_MANIFEST_UNSAFE_PATH",
    message,
    {
      path,
      fix: "Restore a real .agents directory and a regular skills.json declaration before retrying. Foreign entries are never replaced.",
    },
    ExitCode.REFUSED,
  );
}

function failure(error: unknown, path: string): SkillexError {
  return error instanceof SkillexError
    ? error
    : new SkillexError(ExitCode.FAILURE, [
        {
          code: "E_IO",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          path,
          fix: "Check the scope directory and manifest filesystem permissions, then reread before retrying.",
        },
      ]);
}

async function inspect(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function contextFor(root: string): Promise<Context> {
  if (typeof root !== "string" || !root.trim() || root.includes("\0")) {
    fail("E_MANIFEST_ROOT", "A selection manifest requires an existing scope directory.", {
      fix: "Select an existing project directory or home directory.",
    });
  }
  let canonical: string;
  try {
    canonical = await realpath(resolve(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(
        "E_MANIFEST_ROOT",
        "The selected scope directory does not exist.",
        {
          path: resolve(root),
          fix: "Create or select the scope directory before initializing its manifest.",
        },
        ExitCode.REFUSED,
      );
    }
    throw error;
  }
  canonical = await requireDirectory(canonical, "E_MANIFEST_ROOT");
  const paths: string[] = [];
  for (let path = canonical; ; path = dirname(path)) {
    paths.push(path);
    if (dirname(path) === path) break;
  }
  const parents = new Map<string, BigIntStats>();
  for (const path of paths.reverse()) {
    const info = await inspect(path);
    if (!info?.isDirectory())
      unsafe(path, "A scope ancestor is missing or is not a real directory.");
    parents.set(path, info);
  }
  const agents = join(canonical, ".agents");
  const info = await inspect(agents);
  if (info) {
    if (!info.isDirectory()) unsafe(agents, "The scope .agents path must be a real directory.");
    parents.set(agents, info);
  }
  return { root: canonical, agents, path: join(agents, "skills.json"), parents };
}

async function assertParents(context: Context): Promise<void> {
  for (const [path, expected] of context.parents) {
    const current = await inspect(path);
    if (!current?.isDirectory() || !sameObject(expected, current)) {
      conflict(path, "A manifest parent was replaced, removed, or redirected.");
    }
  }
  if (!context.parents.has(context.agents) && (await inspect(context.agents))) {
    conflict(context.agents, "A .agents entry appeared after this scope was read.");
  }
}

async function readStored(path: string): Promise<StoredFile | undefined> {
  const first = await inspect(path);
  if (!first) return undefined;
  if (!first.isFile()) unsafe(path, "The selection declaration must be a real regular file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameObject(first, before))
      conflict(path, "The manifest changed while it was opened.");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await inspect(path);
    if (
      !current?.isFile() ||
      !sameObject(after, current) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs
    ) {
      conflict(path, "The manifest changed while it was being read.");
    }
    return { bytes, identity: after };
  } finally {
    await handle.close();
  }
}

function parseBytes(
  bytes: Buffer,
  path: string,
): { raw: Readonly<Record<string, unknown>>; manifest: SkillsManifest } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("E_INVALID_UTF8", "The selection declaration is not valid UTF-8.", {
      path,
      fix: "Save skills.json as UTF-8 before editing its selection.",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("E_MANIFEST_PARSE", "The selection declaration is not valid JSON.", {
      path,
      fix: "Correct the JSON syntax; comments and trailing commas are not supported.",
    });
  }
  const manifest = parseManifest(raw, path);
  return { raw: raw as Readonly<Record<string, unknown>>, manifest };
}

function snapshot(context: Context, file?: StoredFile): SelectionManifestSnapshot {
  const parsed = file ? parseBytes(file.bytes, context.path) : null;
  const value: SelectionManifestSnapshot = Object.freeze({
    root: context.root,
    path: context.path,
    exists: file !== undefined,
    raw: parsed?.raw ?? null,
    manifest: parsed?.manifest ?? null,
  });
  snapshots.set(value, { context, ...(file ? { file } : {}) });
  return value;
}

/** Inspect one source declaration. Missing .agents/skills.json never creates anything. */
export async function readSelectionManifest(root: string): Promise<SelectionManifestSnapshot> {
  let path = root;
  try {
    const context = await contextFor(root);
    path = context.path;
    const file = context.parents.has(context.agents) ? await readStored(path) : undefined;
    await assertParents(context);
    return snapshot(context, file);
  } catch (error) {
    throw failure(error, path);
  }
}

async function assertPrevious(
  context: Context,
  previous: Evidence,
): Promise<StoredFile | undefined> {
  await assertParents(context);
  const current = context.parents.has(context.agents) ? await readStored(context.path) : undefined;
  if (
    previous.file
      ? !current ||
        !sameObject(previous.file.identity, current.identity) ||
        previous.file.identity.mode !== current.identity.mode ||
        previous.file.identity.uid !== current.identity.uid ||
        previous.file.identity.gid !== current.identity.gid ||
        !previous.file.bytes.equals(current.bytes)
      : current !== undefined
  ) {
    conflict(context.path, "The manifest no longer matches the exact file that was read.");
  }
  await assertParents(context);
  return current;
}

async function flushDirectory(path: string, identity: BigIntStats): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!sameObject(identity, await handle.stat({ bigint: true })))
      conflict(path, "The manifest directory changed before it could be synced.");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeTemporary(
  context: Context,
  path: string,
  expected: BigIntStats,
): Promise<void> {
  await assertParents(context);
  const current = await inspect(path);
  if (!current) return;
  if (!current.isFile() || !sameObject(expected, current))
    conflict(path, "The temporary manifest was replaced; unrelated content was preserved.");
  await unlink(path);
}

/** Validate and atomically publish while the caller holds the shared activation lock. */
export async function writeSelectionManifest(
  previous: SelectionManifestSnapshot,
  raw: Readonly<Record<string, unknown>>,
): Promise<SelectionManifestSnapshot> {
  let published = false;
  let temporary: { path: string; identity: BigIntStats } | undefined;
  let madeAgents: BigIntStats | undefined;
  let context: Context | undefined;
  let problem: SkillexError | undefined;
  let result: SelectionManifestSnapshot | undefined;
  try {
    const prior = snapshots.get(previous);
    if (!prior)
      conflict(
        previous.path,
        "Manifest writes require an original snapshot returned by this module.",
      );
    context = { ...prior.context, parents: new Map(prior.context.parents) };
    parseManifest(raw, context.path);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
    } catch {
      fail("E_MANIFEST_INVALID", "The proposed declaration must be serializable JSON.", {
        path: context.path,
        fix: "Use only values supported by skills.schema.json.",
      });
    }
    const proposed = parseBytes(bytes, context.path);
    const current = await assertPrevious(context, prior);
    if (
      current &&
      isDeepStrictEqual(parseBytes(current.bytes, context.path).manifest, proposed.manifest)
    ) {
      return snapshot(context, current);
    }
    if (!context.parents.has(context.agents)) {
      await assertParents(context);
      try {
        await mkdir(context.agents, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          conflict(context.agents, "A foreign .agents entry appeared before creation.");
        throw error;
      }
      const created = await inspect(context.agents);
      if (!created?.isDirectory())
        conflict(context.agents, "The newly created .agents directory was replaced.");
      madeAgents = created;
      context.parents.set(context.agents, created);
      const rootIdentity = context.parents.get(context.root);
      if (!rootIdentity) conflict(context.root, "The scope root disappeared.");
      await flushDirectory(context.root, rootIdentity);
    }
    await assertPrevious(context, prior);
    const path = join(context.agents, `.skillex-tmp-${randomUUID()}`);
    const mode = prior.file ? Number(prior.file.identity.mode & 0o7777n) : 0o644;
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      temporary = { path, identity: await file.stat({ bigint: true }) };
      await file.writeFile(bytes);
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    const prepared = await readStored(path);
    if (
      !prepared ||
      !sameObject(prepared.identity, temporary.identity) ||
      !prepared.bytes.equals(bytes)
    )
      conflict(path, "The staged declaration changed before publication.");
    await assertPrevious(context, prior);
    if (prior.file) {
      await rename(path, context.path);
      published = true;
      temporary = undefined;
    } else {
      try {
        await link(path, context.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          conflict(
            context.path,
            "A foreign declaration appeared before publication; it was preserved.",
          );
        throw error;
      }
      published = true;
      await removeTemporary(context, path, prepared.identity);
      temporary = undefined;
    }
    await assertParents(context);
    const parent = context.parents.get(context.agents);
    if (!parent) conflict(context.agents, "The manifest directory disappeared.");
    await flushDirectory(context.agents, parent);
    const saved = await readStored(context.path);
    if (!saved || !sameObject(saved.identity, prepared.identity) || !saved.bytes.equals(bytes))
      conflict(context.path, "The published declaration changed before it could be confirmed.");
    await assertParents(context);
    result = snapshot(context, saved);
  } catch (error) {
    problem = failure(error, previous.path);
  } finally {
    if (temporary && context) {
      try {
        await removeTemporary(context, temporary.path, temporary.identity);
      } catch (error) {
        problem ??= failure(error, temporary.path);
      }
    }
    if (problem && !published && madeAgents && context) {
      try {
        await assertParents(context);
        const current = await inspect(context.agents);
        if (current?.isDirectory() && sameObject(current, madeAgents)) await rmdir(context.agents);
      } catch {
        // Never remove new foreign children or obscure the original write failure.
      }
    }
  }
  if (problem) throw new SelectionManifestWriteError(problem, published);
  if (!result)
    throw new SelectionManifestWriteError(
      failure(new Error("Manifest publication did not produce a snapshot."), previous.path),
      published,
    );
  return result;
}
