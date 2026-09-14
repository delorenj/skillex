import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail, SkillexError } from "./error.js";
import type { LockOptions } from "./lock.js";
import { ExitCode } from "./result.js";

export interface ReceiptOptions extends LockOptions {
  readonly forbiddenRoots?: readonly string[];
}

export interface ReceiptDocument<T> {
  readonly schema: 2;
  readonly scopeRoot: string;
  readonly activationRoot: string;
  readonly host: string;
  readonly uid: number | null;
  readonly data: T;
}

/** An IO snapshot, not an ownership claim over any activation filesystem object. */
export interface ReceiptSnapshot<T> {
  readonly path: string;
  readonly scopeRoot: string;
  readonly activationRoot: string;
  readonly document?: ReceiptDocument<T>;
}

interface Context {
  readonly scopeRoot: string;
  readonly scopeIdentity: BigIntStats;
  readonly activationRoot: string;
  readonly stateHome: string;
  readonly path: string;
  readonly home: string;
  readonly forbiddenRoots: readonly string[];
}

interface StoredFile {
  readonly identity: BigIntStats;
  readonly bytes: Buffer;
}

interface Evidence {
  readonly context: Context;
  readonly parents: ReadonlyMap<string, BigIntStats>;
  readonly file?: StoredFile;
}

// A deserialized or reconstructed snapshot cannot authorize a replacement. No Node
// filesystem types or mutable file bytes escape through the public declarations.
const evidence = new WeakMap<object, Evidence>();

function refused(
  code: "E_RECEIPT_UNSAFE_PATH" | "E_RECEIPT_INVALID" | "E_RECEIPT_CHANGED",
  path: string,
  message: string,
): never {
  fail(
    code,
    message,
    {
      path,
      fix: "Inspect the receipt location and its ownership, then reread it under the activation lock. Use explicit migration for legacy state.",
    },
    ExitCode.REFUSED,
  );
}

function ioFailure(error: unknown, path: string): never {
  if (error instanceof SkillexError) throw error;
  fail(
    "E_IO",
    `Cannot access activation receipt: ${error instanceof Error ? error.message : String(error)}`,
    {
      path,
      fix: "Check the selected state directory and filesystem permissions, then retry.",
    },
    ExitCode.FAILURE,
  );
}

function pathOption(value: string, home: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    fail("E_RECEIPT_CONFIG", `${label} requires a nonempty directory path.`, {
      fix: "Supply a real scope directory and an XDG state directory outside source repositories.",
    });
  }
  return resolve(
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}

function within(parent: string, path: string): boolean {
  const remainder = relative(parent, path);
  return (
    remainder === "" ||
    (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))
  );
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

function realOwned(path: string, info: BigIntStats, directory: boolean, checkUser = true): void {
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (checkUser && process.getuid && info.uid !== BigInt(process.getuid()))
  ) {
    refused(
      "E_RECEIPT_UNSAFE_PATH",
      path,
      `Receipt state must be a real ${directory ? "directory" : "file"} owned by the current user: ${path}`,
    );
  }
}

async function canonicalEvenIfMissing(path: string): Promise<string> {
  const remaining: string[] = [];
  let candidate = path;
  while (true) {
    try {
      return join(await realpath(candidate), ...remaining.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (await inspect(candidate)) {
        refused(
          "E_RECEIPT_UNSAFE_PATH",
          candidate,
          "A forbidden source root cannot be resolved. Restore dangling links before selecting receipt state.",
        );
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      remaining.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function contextFor(scopeRoot: string, options: ReceiptOptions): Promise<Context> {
  const home = pathOption(options.home ?? homedir(), homedir(), "home");
  const env = options.env ?? process.env;
  const stateHome = pathOption(
    options.stateHome ?? env.XDG_STATE_HOME ?? join(home, ".local", "state"),
    home,
    "stateHome",
  );
  const canonicalScope = await realpath(pathOption(scopeRoot, home, "scopeRoot"));
  const scopeIdentity = await lstat(canonicalScope, { bigint: true });
  realOwned(canonicalScope, scopeIdentity, true, false);
  const activationRoot = join(canonicalScope, ".agents", "skills");
  const key = createHash("sha256").update(activationRoot).digest("hex");
  const forbiddenRoots: string[] = [];
  for (const root of options.forbiddenRoots ?? []) {
    forbiddenRoots.push(await canonicalEvenIfMissing(pathOption(root, home, "forbiddenRoots")));
  }
  return {
    scopeRoot: canonicalScope,
    scopeIdentity,
    activationRoot,
    home,
    stateHome,
    path: join(stateHome, "skillex", "activations", "v2", `${key}.json`),
    forbiddenRoots,
  };
}

function directoryPaths(path: string): string[] {
  const result: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    result.push(current);
    if (dirname(current) === current) return result.reverse();
  }
}

async function inspectParents(context: Context): Promise<Map<string, BigIntStats>> {
  for (const root of context.forbiddenRoots) {
    if (within(root, context.path)) {
      refused(
        "E_RECEIPT_UNSAFE_PATH",
        context.path,
        `Activation receipts must stay outside the forbidden source root: ${root}`,
      );
    }
  }
  const parents = new Map<string, BigIntStats>();
  for (const path of directoryPaths(dirname(context.path))) {
    const info = await inspect(path);
    if (!info) break;
    realOwned(path, info, true, within(context.stateHome, path));
    if (process.getuid && info.uid !== 0n && info.uid !== BigInt(process.getuid())) {
      refused(
        "E_RECEIPT_UNSAFE_PATH",
        path,
        "A receipt ancestor belongs to another filesystem user.",
      );
    }
    if (await inspect(join(path, ".git"))) {
      refused(
        "E_RECEIPT_UNSAFE_PATH",
        context.path,
        `Activation receipts must stay outside source repositories: ${path}`,
      );
    }
    parents.set(path, info);
  }
  return parents;
}

async function assertParents(
  context: Context,
  expected: ReadonlyMap<string, BigIntStats>,
): Promise<Map<string, BigIntStats>> {
  const current = await inspectParents(context);
  for (const [path, identity] of expected) {
    const found = current.get(path);
    if (!found || !sameObject(identity, found)) {
      refused(
        "E_RECEIPT_CHANGED",
        path,
        `A receipt parent directory was replaced or removed: ${path}`,
      );
    }
  }
  return current;
}

async function readStored(path: string): Promise<StoredFile | undefined> {
  const initial = await inspect(path);
  if (!initial) return undefined;
  realOwned(path, initial, false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    realOwned(path, before, false);
    if (!sameObject(initial, before))
      refused("E_RECEIPT_CHANGED", path, "Receipt was replaced while being opened.");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await inspect(path);
    if (
      !current ||
      !sameObject(after, current) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs
    ) {
      refused("E_RECEIPT_CHANGED", path, "Receipt changed while being read.");
    }
    return { identity: after, bytes };
  } finally {
    await handle.close();
  }
}

function documentFrom<T>(context: Context, bytes: Buffer): ReceiptDocument<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refused("E_RECEIPT_INVALID", context.path, "Receipt must contain complete UTF-8 JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    refused("E_RECEIPT_INVALID", context.path, "Receipt must be a version 2 document object.");
  }
  const document = raw as Record<string, unknown>;
  const fields = ["schema", "scopeRoot", "activationRoot", "host", "uid", "data"];
  if (
    Object.keys(document).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(document, field)) ||
    document.schema !== 2 ||
    document.scopeRoot !== context.scopeRoot ||
    document.activationRoot !== context.activationRoot ||
    document.host !== hostname() ||
    document.uid !== (process.getuid?.() ?? null)
  ) {
    refused(
      "E_RECEIPT_INVALID",
      context.path,
      "Receipt schema, scope, path, host, or user does not match this activation. Legacy receipts require explicit migration.",
    );
  }
  return Object.freeze(document) as unknown as ReceiptDocument<T>;
}

function snapshot<T>(
  context: Context,
  parents: ReadonlyMap<string, BigIntStats>,
  file?: StoredFile,
): ReceiptSnapshot<T> {
  const value: ReceiptSnapshot<T> = Object.freeze({
    path: context.path,
    scopeRoot: context.scopeRoot,
    activationRoot: context.activationRoot,
    ...(file ? { document: documentFrom<T>(context, file.bytes) } : {}),
  });
  evidence.set(value, { context, parents, ...(file ? { file } : {}) });
  return value;
}

/** Validate state placement without creating anything or inspecting activation receipt contents. */
export async function validateActivationStateLocation(
  scopeRoot: string,
  options: ReceiptOptions = {},
): Promise<void> {
  let path = scopeRoot;
  try {
    const context = await contextFor(scopeRoot, options);
    path = context.path;
    await inspectParents(context);
  } catch (error) {
    ioFailure(error, path);
  }
}

/** Read and validate local v2 state without creating directories or adopting legacy receipts. */
export async function readActivationReceipt<T = unknown>(
  scopeRoot: string,
  options: ReceiptOptions = {},
): Promise<ReceiptSnapshot<T>> {
  let path = scopeRoot;
  try {
    const context = await contextFor(scopeRoot, options);
    path = context.path;
    const parents = await inspectParents(context);
    const file = await readStored(path);
    await assertParents(context, parents);
    return snapshot<T>(context, parents, file);
  } catch (error) {
    return ioFailure(error, path);
  }
}

async function assertPrevious(context: Context, previous: Evidence): Promise<void> {
  const current = await readStored(context.path);
  if (
    previous.file
      ? !current ||
        !sameObject(previous.file.identity, current.identity) ||
        !previous.file.bytes.equals(current.bytes)
      : current !== undefined
  ) {
    refused(
      "E_RECEIPT_CHANGED",
      context.path,
      "Receipt changed since the supplied snapshot; no replacement was authorized.",
    );
  }
}

async function ensureParents(
  context: Context,
  previous: ReadonlyMap<string, BigIntStats>,
): Promise<Map<string, BigIntStats>> {
  const parents = await assertParents(context, previous);
  for (const path of directoryPaths(dirname(context.path))) {
    if (parents.has(path)) continue;
    await assertParents(context, parents);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(path, { bigint: true });
    realOwned(path, info, true);
    const parentIdentity = parents.get(dirname(path));
    if (!parentIdentity)
      refused("E_RECEIPT_CHANGED", path, "Receipt ancestor disappeared during directory creation.");
    await flushDirectory(dirname(path), parentIdentity);
    parents.set(path, info);
  }
  await assertParents(context, parents);
  return parents;
}

async function flushDirectory(path: string, identity: BigIntStats): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!sameObject(identity, await handle.stat({ bigint: true }))) {
      refused(
        "E_RECEIPT_CHANGED",
        path,
        "Receipt directory changed before its publication could be synced.",
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Persist a complete document while the caller holds the activation ownership lock.
 * The previous snapshot authorizes only its exact bytes/inode (or continued absence).
 */
export async function writeActivationReceipt<T>(
  previous: ReceiptSnapshot<T>,
  data: T,
  options: ReceiptOptions = {},
): Promise<ReceiptSnapshot<T>> {
  const prior = evidence.get(previous);
  if (!prior)
    refused(
      "E_RECEIPT_CHANGED",
      previous.path,
      "Receipt writes require an original snapshot returned by this module.",
    );
  let temporary:
    | { path: string; identity: BigIntStats; directory: string; parent: BigIntStats }
    | undefined;
  let failed = false;
  try {
    const hasLocation =
      options.stateHome !== undefined || options.env !== undefined || options.home !== undefined;
    const selected = hasLocation
      ? options
      : { ...options, home: prior.context.home, stateHome: prior.context.stateHome, env: {} };
    const context = await contextFor(previous.scopeRoot, {
      ...selected,
      forbiddenRoots: [...prior.context.forbiddenRoots, ...(options.forbiddenRoots ?? [])],
    });
    if (
      context.path !== prior.context.path ||
      context.scopeRoot !== prior.context.scopeRoot ||
      !sameObject(context.scopeIdentity, prior.context.scopeIdentity)
    ) {
      refused(
        "E_RECEIPT_CHANGED",
        previous.path,
        "Snapshot scope or state location changed; read a fresh receipt before writing.",
      );
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(
        `${JSON.stringify({ schema: 2, scopeRoot: context.scopeRoot, activationRoot: context.activationRoot, host: hostname(), uid: process.getuid?.() ?? null, data })}\n`,
      );
    } catch {
      refused("E_RECEIPT_INVALID", context.path, "Receipt data must be serializable JSON.");
    }
    documentFrom<T>(context, bytes);
    await assertParents(context, prior.parents);
    await assertPrevious(context, prior);
    const parents = await ensureParents(context, prior.parents);
    const directory = dirname(context.path);
    const directoryIdentity = parents.get(directory);
    if (!directoryIdentity)
      refused("E_RECEIPT_CHANGED", directory, "Receipt directory disappeared.");
    const preparedPath = join(directory, `.${basename(context.path)}.${randomUUID()}.tmp`);
    const prepared = await open(
      preparedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      temporary = {
        path: preparedPath,
        identity: await prepared.stat({ bigint: true }),
        directory,
        parent: directoryIdentity,
      };
      await prepared.writeFile(bytes);
      await prepared.chmod(0o600);
      await prepared.sync();
    } finally {
      await prepared.close();
    }
    await assertParents(context, parents);
    await assertPrevious(context, prior);
    const staged = await readStored(preparedPath);
    if (
      !staged ||
      !sameObject(staged.identity, temporary.identity) ||
      !staged.bytes.equals(bytes)
    ) {
      refused(
        "E_RECEIPT_CHANGED",
        preparedPath,
        "Prepared receipt was replaced or altered before publication.",
      );
    }
    if (prior.file) {
      // Cooperating replacements are serialized by the caller's ownership lock.
      await rename(preparedPath, context.path);
      temporary = undefined;
    } else {
      try {
        // Unlike rename, first publication cannot overwrite a newly appeared file.
        await link(preparedPath, context.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          refused(
            "E_RECEIPT_CHANGED",
            context.path,
            "A receipt appeared before first publication; it was preserved.",
          );
        throw error;
      }
      const remaining = await inspect(preparedPath);
      if (!remaining || !sameObject(remaining, staged.identity)) {
        refused(
          "E_RECEIPT_CHANGED",
          preparedPath,
          "Temporary receipt changed after publication; cleanup refused.",
        );
      }
      await unlink(preparedPath);
      temporary = undefined;
    }
    await assertParents(context, parents);
    await flushDirectory(directory, directoryIdentity);
    const stored = await readStored(context.path);
    if (!stored || !sameObject(stored.identity, staged.identity) || !stored.bytes.equals(bytes))
      refused(
        "E_RECEIPT_CHANGED",
        context.path,
        "Published receipt changed before it could be confirmed.",
      );
    await assertParents(context, parents);
    return snapshot<T>(context, parents, stored);
  } catch (error) {
    failed = true;
    return ioFailure(error, previous.path);
  } finally {
    if (temporary) {
      try {
        const parent = await inspect(temporary.directory);
        if (!parent || !sameObject(parent, temporary.parent)) {
          refused(
            "E_RECEIPT_CHANGED",
            temporary.directory,
            "Temporary receipt directory changed; cleanup refused.",
          );
        }
        const current = await inspect(temporary.path);
        if (current && sameObject(current, temporary.identity)) await unlink(temporary.path);
        else if (current)
          refused(
            "E_RECEIPT_CHANGED",
            temporary.path,
            "Temporary receipt was replaced; unrelated content was preserved.",
          );
      } catch (error) {
        if (!failed) ioFailure(error, temporary.path);
      }
    }
  }
}
