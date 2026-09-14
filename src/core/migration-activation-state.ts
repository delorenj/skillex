import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir, readlink, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import {
  type ReceiptOptions,
  type ReceiptSnapshot,
  readBoundReceipt,
  writeBoundReceipt,
} from "./activation-state.js";
import { fail } from "./error.js";
import { ExitCode } from "./result.js";

export interface MigrationIdentity {
  readonly kind: "directory" | "link" | "file" | "other";
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly raw?: string;
}
export interface MigrationNode {
  readonly identity: MigrationIdentity;
  readonly hash: string | null;
  readonly children: Readonly<Record<string, MigrationNode>>;
}
export interface MigrationPending {
  readonly id: string;
  readonly item: string;
  readonly path: string;
  readonly stage: string;
  readonly parked: string;
  readonly previous?: MigrationNode;
  readonly next: MigrationNode;
  readonly claimRoot: boolean;
  readonly claimNames: readonly string[];
}
export interface MigrationActivationData {
  readonly version: 1;
  readonly root: string;
  readonly verified: Readonly<Record<string, { readonly path: string; readonly digest: string }>>;
  readonly pending?: MigrationPending;
}
export interface MigrationActivationState {
  readonly snapshot: ReceiptSnapshot<MigrationActivationData>;
  readonly data: MigrationActivationData;
}

export function migrationRefusal(path: string, message: string): never {
  fail(
    "E_MIGRATION_ACTIVATION",
    message,
    {
      path,
      fix: "Preserve this entry and its migration receipt; resolve the named mapping or filesystem conflict before applying migration again.",
    },
    ExitCode.REFUSED,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function safeName(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[\0/\\]/.test(name);
}
function kind(info: Awaited<ReturnType<typeof lstat>>): MigrationIdentity["kind"] {
  return info.isDirectory()
    ? "directory"
    : info.isSymbolicLink()
      ? "link"
      : info.isFile()
        ? "file"
        : "other";
}

/** Inspect without following any child link; regular files are read through bounded no-follow descriptors. */
export async function captureMigrationNode(path: string): Promise<MigrationNode | undefined> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const identity: MigrationIdentity = {
    kind: kind(before),
    dev: String(before.dev),
    ino: String(before.ino),
    mode: Number(before.mode & 0o7777n),
    ...(before.isSymbolicLink() ? { raw: await readlink(path) } : {}),
  };
  const children: Record<string, MigrationNode> = {};
  let hash: string | null = null;
  if (before.isDirectory()) {
    const names = await readdir(path, { encoding: "buffer" });
    if (names.length > 10_000)
      migrationRefusal(path, "A migration directory exceeds the bounded inventory limit.");
    for (const bytes of names.sort(Buffer.compare)) {
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        migrationRefusal(path, "A migration entry has a non-UTF-8 filename.");
      }
      if (!safeName(name)) migrationRefusal(path, "A migration entry has an unsafe filename.");
      const child = await captureMigrationNode(join(path, name));
      if (!child)
        migrationRefusal(join(path, name), "Content disappeared during migration inventory.");
      Object.defineProperty(children, name, { value: child, enumerable: true });
    }
  } else if (before.isFile()) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        migrationRefusal(path, "A migration file changed while being opened.");
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      const length = Number(before.size);
      if (!Number.isSafeInteger(length) || length > 512 * 1024 * 1024)
        migrationRefusal(path, "A migration file exceeds the bounded inventory limit.");
      while (position < length) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, length - position),
          position,
        );
        if (!bytesRead) migrationRefusal(path, "A migration file was truncated during inventory.");
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        migrationRefusal(path, "A migration file changed during inventory.");
      hash = digest.digest("hex");
    } finally {
      await handle.close();
    }
  }
  const after = await lstat(path, { bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  )
    migrationRefusal(path, "Content changed while its migration inventory was being captured.");
  return { identity, hash, children };
}

export function migrationDigest(node: MigrationNode): string {
  const project = (item: MigrationNode): unknown => ({
    kind: item.identity.kind,
    mode: item.identity.mode,
    raw: item.identity.raw ?? null,
    hash: item.hash,
    children: Object.fromEntries(
      Object.entries(item.children)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => [name, project(child)]),
    ),
  });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(project(node)))
    .digest("hex")}`;
}
export async function assertMigrationNode(path: string, expected: MigrationNode): Promise<void> {
  if (!isDeepStrictEqual(await captureMigrationNode(path), expected))
    migrationRefusal(path, "The exact inventoried migration object changed; it was preserved.");
}
export async function assertMigrationRemainder(
  path: string,
  expected: MigrationNode,
): Promise<MigrationNode | undefined> {
  const actual = await captureMigrationNode(path);
  if (!actual) return undefined;
  if (
    !isDeepStrictEqual(actual.identity, expected.identity) ||
    actual.hash !== expected.hash ||
    Object.entries(actual.children).some(
      ([name, child]) =>
        !Object.hasOwn(expected.children, name) ||
        !isDeepStrictEqual(child, expected.children[name]),
    )
  )
    migrationRefusal(path, "A migration cleanup object contains changed or unexpected content.");
  return actual;
}
export async function removeMigrationNode(path: string, expected: MigrationNode): Promise<void> {
  const actual = await assertMigrationRemainder(path, expected);
  if (!actual) return;
  const remove = async (current: string, node: MigrationNode): Promise<void> => {
    await assertMigrationNode(current, node);
    if (node.identity.kind === "link") await unlink(current);
    else if (node.identity.kind === "directory") {
      for (const [name, child] of Object.entries(node.children)) {
        if (child.identity.kind !== "link")
          migrationRefusal(
            join(current, name),
            "Migration cleanup never deletes a real local file or definition.",
          );
        const parent = await lstat(current, { bigint: true });
        if (
          !parent.isDirectory() ||
          String(parent.dev) !== node.identity.dev ||
          String(parent.ino) !== node.identity.ino
        )
          migrationRefusal(current, "A migration cleanup parent changed.");
        await assertMigrationNode(join(current, name), child);
        await unlink(join(current, name));
      }
      const parent = await lstat(current, { bigint: true });
      if (
        !parent.isDirectory() ||
        String(parent.dev) !== node.identity.dev ||
        String(parent.ino) !== node.identity.ino
      )
        migrationRefusal(current, "A migration cleanup directory changed.");
      await rmdir(current);
    } else migrationRefusal(current, "Migration cleanup never deletes real local content.");
  };
  await remove(path, actual);
}

function validNode(value: unknown, depth = 0): value is MigrationNode {
  if (depth > 64 || !record(value) || !record(value.identity) || !record(value.children))
    return false;
  const item = value.identity;
  return (
    Object.keys(value).every((key) => ["identity", "hash", "children"].includes(key)) &&
    Object.keys(item).every((key) => ["kind", "dev", "ino", "mode", "raw"].includes(key)) &&
    ["directory", "link", "file", "other"].includes(String(item.kind)) &&
    typeof item.dev === "string" &&
    /^\d+$/.test(item.dev) &&
    typeof item.ino === "string" &&
    /^\d+$/.test(item.ino) &&
    typeof item.mode === "number" &&
    Number.isInteger(item.mode) &&
    item.mode >= 0 &&
    item.mode <= 0o7777 &&
    (item.kind === "link"
      ? typeof item.raw === "string" && !!item.raw && !item.raw.includes("\0")
      : item.raw === undefined) &&
    (item.kind === "file"
      ? typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash)
      : value.hash === null) &&
    (item.kind === "directory" || !Object.keys(value.children).length) &&
    Object.entries(value.children).every(
      ([name, child]) => safeName(name) && validNode(child, depth + 1),
    )
  );
}
function allowedPath(path: string, root: string, aliases: readonly string[]): boolean {
  return (
    path === root ||
    aliases.includes(path) ||
    (dirname(path) === root && safeName(relative(root, path)))
  );
}
function validate(
  raw: unknown,
  root: string,
  aliases: readonly string[],
  path: string,
): MigrationActivationData {
  if (
    !record(raw) ||
    Object.keys(raw).some((key) => !["version", "root", "verified", "pending"].includes(key)) ||
    raw.version !== 1 ||
    raw.root !== root ||
    !record(raw.verified)
  )
    migrationRefusal(
      path,
      "The activation migration receipt is malformed or belongs to another target.",
    );
  for (const value of Object.values(raw.verified)) {
    if (
      !record(value) ||
      Object.keys(value).some((key) => !["path", "digest"].includes(key)) ||
      typeof value.path !== "string" ||
      !allowedPath(value.path, root, aliases) ||
      typeof value.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value.digest)
    )
      migrationRefusal(path, "A migration verification item is malformed.");
  }
  if (raw.pending !== undefined) {
    const pending = raw.pending;
    if (
      !record(pending) ||
      Object.keys(pending).some(
        (key) =>
          ![
            "id",
            "item",
            "path",
            "stage",
            "parked",
            "previous",
            "next",
            "claimRoot",
            "claimNames",
          ].includes(key),
      ) ||
      typeof pending.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pending.id) ||
      typeof pending.item !== "string" ||
      typeof pending.path !== "string" ||
      !allowedPath(pending.path, root, aliases) ||
      pending.stage !== join(dirname(pending.path), `.skillex-tmp-migration-${pending.id}-new`) ||
      pending.parked !== join(dirname(pending.path), `.skillex-tmp-migration-${pending.id}-old`) ||
      (pending.previous !== undefined && !validNode(pending.previous)) ||
      !validNode(pending.next) ||
      typeof pending.claimRoot !== "boolean" ||
      !Array.isArray(pending.claimNames) ||
      !pending.claimNames.every((name) => typeof name === "string" && safeName(name))
    )
      migrationRefusal(
        path,
        "The pending migration operation has invalid paths or exact object evidence.",
      );
  }
  return raw as unknown as MigrationActivationData;
}

export async function readMigrationActivationState(
  base: string,
  root: string,
  aliases: readonly string[],
  profile: boolean,
  options: ReceiptOptions,
): Promise<MigrationActivationState> {
  const snapshot = await readBoundReceipt<MigrationActivationData>(
    base,
    { namespace: "migrations", targetParts: profile ? ["skills"] : [".agents", "skills"] },
    options,
  );
  const data = snapshot.document
    ? validate(snapshot.document.data, root, aliases, snapshot.path)
    : { version: 1 as const, root, verified: {} };
  return { snapshot, data };
}
export async function writeMigrationActivationState(
  previous: MigrationActivationState,
  data: MigrationActivationData,
): Promise<MigrationActivationState> {
  const snapshot = await writeBoundReceipt(previous.snapshot, data);
  return { snapshot, data };
}

/** Strict bounded UTF-8 JSON input with stable regular-file evidence. */
export async function readLegacyJson(
  path: string,
): Promise<{ raw: unknown; node: MigrationNode } | undefined> {
  let initial: BigIntStats;
  try {
    initial = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!initial.isFile() || initial.size > 1024n * 1024n)
    migrationRefusal(path, "A legacy ownership receipt must be a bounded real regular file.");
  const node = await captureMigrationNode(path);
  if (!node) return undefined;
  if (node.identity.kind !== "file")
    migrationRefusal(path, "A legacy ownership receipt must be a real regular file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > 1024n * 1024n)
      migrationRefusal(path, "A legacy ownership receipt exceeds its size limit or changed type.");
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead)
        migrationRefusal(path, "A legacy ownership receipt was truncated while being read.");
      offset += bytesRead;
    }
    let raw: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      raw = JSON.parse(text);
      if (parseDocument(text, { uniqueKeys: true }).errors.length)
        migrationRefusal(
          path,
          "A legacy ownership receipt contains duplicate or ambiguous JSON keys.",
        );
    } catch {
      migrationRefusal(path, "A legacy ownership receipt must contain complete UTF-8 JSON.");
    }
    await assertMigrationNode(path, node);
    return { raw, node };
  } finally {
    await handle.close();
  }
}

export function migrationAbsolute(value: string, home: string, cwd: string): string {
  if (!value || value.includes("\0"))
    migrationRefusal(value, "Migration requires an explicit valid path.");
  const expanded =
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
