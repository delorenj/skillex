import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { type ReceiptSnapshot, readBoundReceipt, writeBoundReceipt } from "./activation-state.js";
import { isWithin } from "./content.js";
import { fail } from "./error.js";
import type { MigrationItem, MigrationOptions } from "./migration-types.js";
import { ExitCode } from "./result.js";

export interface MigrationIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: number;
  readonly kind: "directory" | "file" | "link";
}

export interface MigrationEntry {
  readonly path: string;
  readonly kind: MigrationIdentity["kind"];
  readonly mode: number;
  readonly bytes?: Buffer;
  readonly target?: string;
}

export interface MigrationTreeEvidence {
  readonly root: MigrationIdentity;
  readonly entries: readonly {
    readonly path: string;
    readonly identity: MigrationIdentity;
    readonly hash: string | null;
    readonly target: string | null;
  }[];
  readonly digest: string;
}

export interface MigrationTree {
  readonly evidence: MigrationTreeEvidence;
  readonly entries: readonly MigrationEntry[];
}

export interface MigrationOperation {
  readonly item: MigrationItem;
  readonly path: string;
  readonly stage: string | null;
  readonly parked: string | null;
  readonly parent: MigrationIdentity;
  readonly ancestors: readonly { readonly path: string; readonly identity: MigrationIdentity }[];
  readonly before: MigrationTreeEvidence | null;
  readonly after: MigrationTreeEvidence | null;
}

export interface RegistryMigrationReceipt {
  readonly version: 1;
  readonly registry: string;
  readonly phase: "preparing" | "ready" | "complete";
  readonly operations: readonly MigrationOperation[];
  readonly verified: readonly MigrationItem[];
  readonly nameMap: Readonly<Record<string, string>>;
  readonly provenance: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly externalRoots?: readonly string[];
}

const binding = { namespace: "migrations", targetParts: ["all-skills"] } as const;
const hex = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const stagePattern = /^\.skillex-tmp-migrate-[a-f0-9-]{36}-(?:new|old)$/;

export function migrationFailure(
  path: string,
  message: string,
  code = "E_MIGRATION_CHANGED" as `E_${string}`,
): never {
  fail(
    code,
    message,
    {
      path,
      fix: "Preserve the affected paths and migration receipt, inspect the conflict, then rerun the preview.",
    },
    ExitCode.REFUSED,
  );
}

export async function migrationLstat(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function identity(info: BigIntStats): MigrationIdentity {
  const kind = info.isDirectory()
    ? "directory"
    : info.isFile()
      ? "file"
      : info.isSymbolicLink()
        ? "link"
        : null;
  if (!kind)
    migrationFailure("", "Migration refuses special filesystem entries.", "E_MIGRATION_CONTENT");
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    uid: String(info.uid),
    mode: Number(info.mode & 0o777n),
    kind,
  };
}

function equalIdentity(actual: BigIntStats | null, expected: MigrationIdentity): boolean {
  if (!actual) return false;
  const kind = actual.isDirectory()
    ? "directory"
    : actual.isFile()
      ? "file"
      : actual.isSymbolicLink()
        ? "link"
        : "other";
  return (
    kind === expected.kind &&
    String(actual.dev) === expected.dev &&
    String(actual.ino) === expected.ino &&
    String(actual.uid) === expected.uid &&
    Number(actual.mode & 0o777n) === expected.mode
  );
}

function stable(before: BigIntStats, after: BigIntStats): boolean {
  return (
    equalIdentity(after, identity(before)) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function migrationTreeDigest(entries: readonly MigrationEntry[]): string {
  const lines = [...entries]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((entry) => {
      const content =
        entry.kind === "file"
          ? hash(entry.bytes as Buffer)
          : entry.kind === "link"
            ? hash(Buffer.from(entry.target as string))
            : "-";
      return `${entry.kind} ${entry.mode & 0o100 ? "x" : "-"} ${content} ${JSON.stringify(entry.path.split(sep).join("/"))}`;
    });
  return `sha256:${hash(Buffer.from(lines.join("\n")))}`;
}

async function regularBytes(path: string, before: BigIntStats): Promise<Buffer> {
  if (!before.isFile() || before.size > 128n * 1024n * 1024n)
    migrationFailure(
      path,
      "Migration requires a regular file no larger than 128 MiB.",
      "E_MIGRATION_CONTENT",
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!stable(before, await handle.stat({ bigint: true })))
      migrationFailure(path, "File changed before it could be read.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset,
      );
      if (!result.bytesRead) migrationFailure(path, "File shrank while it was read.");
      offset += result.bytesRead;
    }
    if (
      !stable(before, await handle.stat({ bigint: true })) ||
      !stable(before, await lstat(path, { bigint: true }))
    )
      migrationFailure(path, "File changed while it was read.");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Capture every entry, including hidden support assets and provenance, without following links. */
export async function captureMigrationTree(root: string): Promise<MigrationTree | null> {
  const initial = await migrationLstat(root);
  if (!initial) return null;
  const entries: MigrationEntry[] = [];
  const evidence: {
    path: string;
    identity: MigrationIdentity;
    hash: string | null;
    target: string | null;
  }[] = [];
  const visit = async (path: string, relpath: string): Promise<void> => {
    const before = await lstat(path, { bigint: true });
    const id = identity(before);
    const bytes = id.kind === "file" ? await regularBytes(path, before) : undefined;
    const target = id.kind === "link" ? await readlink(path) : undefined;
    if (target?.includes("\0"))
      migrationFailure(path, "Link contains an invalid target.", "E_MIGRATION_CONTENT");
    entries.push({
      path: relpath,
      kind: id.kind,
      mode: id.mode,
      ...(bytes ? { bytes } : {}),
      ...(target !== undefined ? { target } : {}),
    });
    evidence.push({
      path: relpath,
      identity: id,
      hash: bytes ? hash(bytes) : null,
      target: target ?? null,
    });
    if (id.kind === "directory") {
      for (const name of (await readdir(path)).sort()) {
        if ([".git", ".hg", ".svn"].includes(name))
          migrationFailure(
            join(path, name),
            "A definition or composition contains repository administration; map its authored content explicitly.",
            "E_MIGRATION_CONTENT",
          );
        await visit(join(path, name), relpath ? join(relpath, name) : name);
      }
    }
    if (!stable(before, await lstat(path, { bigint: true })))
      migrationFailure(path, "Source membership changed while it was inspected.");
  };
  await visit(root, "");
  if (!equalIdentity(await migrationLstat(root), identity(initial)))
    migrationFailure(root, "Source root was replaced while it was inspected.");
  return {
    entries,
    evidence: { root: identity(initial), entries: evidence, digest: migrationTreeDigest(entries) },
  };
}

export async function assertMigrationIdentity(
  path: string,
  expected: MigrationIdentity,
): Promise<void> {
  if (!equalIdentity(await migrationLstat(path), expected))
    migrationFailure(path, "A migration entry changed identity.");
}

export async function assertMigrationTree(
  path: string,
  expected: MigrationTreeEvidence | null,
): Promise<void> {
  const actual = await captureMigrationTree(path);
  if (!expected) {
    if (actual)
      migrationFailure(path, "Foreign content appeared at a destination that was absent.");
    return;
  }
  if (!actual || JSON.stringify(actual.evidence) !== JSON.stringify(expected))
    migrationFailure(path, "A migration tree changed after inspection.");
}

export async function migrationParent(path: string): Promise<MigrationIdentity> {
  const info = await lstat(dirname(path), { bigint: true });
  if (!info.isDirectory())
    migrationFailure(dirname(path), "Migration parents must be real directories.");
  return identity(info);
}

export async function migrationAncestors(
  registry: string,
  path: string,
): Promise<MigrationOperation["ancestors"]> {
  const result: { path: string; identity: MigrationIdentity }[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (!isWithin(registry, parent))
      migrationFailure(
        parent,
        "Migration parent is outside the selected registry.",
        "E_MIGRATION_COMPOSITION",
      );
    const info = await lstat(parent, { bigint: true });
    if (!info.isDirectory())
      migrationFailure(
        parent,
        "Migration never writes through a symlinked or non-directory ancestor.",
        "E_MIGRATION_COMPOSITION",
      );
    result.push({ path: parent, identity: identity(info) });
    if (parent === registry) break;
  }
  return result;
}

export async function assertMigrationAncestors(
  ancestors: MigrationOperation["ancestors"],
): Promise<void> {
  for (const entry of ancestors) await assertMigrationIdentity(entry.path, entry.identity);
}

export function migrationStage(path: string, suffix: "new" | "old"): string {
  return join(dirname(path), `.skillex-tmp-migrate-${randomUUID()}-${suffix}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The unique staged root is complete and fsynced before any visible source entry is replaced. */
export async function stageMigrationTree(
  path: string,
  entries: readonly MigrationEntry[],
  parent: MigrationIdentity,
  ancestors: MigrationOperation["ancestors"] = [],
): Promise<MigrationTreeEvidence> {
  await assertMigrationAncestors(ancestors);
  await assertMigrationIdentity(dirname(path), parent);
  await assertMigrationTree(path, null);
  const root = entries.find((entry) => entry.path === "");
  if (!root) throw new Error("Staged migration content lacks its root.");
  const directories = new Map<string, MigrationIdentity>();
  for (const entry of [...entries].sort(
    (a, b) => a.path.split(sep).length - b.path.split(sep).length || a.path.localeCompare(b.path),
  )) {
    const target = entry.path ? join(path, entry.path) : path;
    await assertMigrationAncestors(ancestors);
    await assertMigrationIdentity(dirname(path), parent);
    for (
      let directory = dirname(target);
      isWithin(path, directory);
      directory = dirname(directory)
    ) {
      const known = directories.get(directory);
      if (!known) migrationFailure(directory, "Staging parent has no ownership evidence.");
      await assertMigrationIdentity(directory, known);
      if (directory === path) break;
    }
    if (entry.kind === "directory") {
      await mkdir(target, { mode: 0o700 });
      directories.set(target, identity(await lstat(target, { bigint: true })));
    } else if (entry.kind === "link") await symlink(entry.target as string, target);
    else {
      const handle = await open(target, "wx", entry.mode);
      try {
        await handle.writeFile(entry.bytes as Buffer);
        await handle.chmod(entry.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  for (const entry of [...entries].sort((a, b) => b.path.length - a.path.length)) {
    if (entry.kind !== "directory") continue;
    const target = entry.path ? join(path, entry.path) : path;
    await assertMigrationIdentity(target, directories.get(target) as MigrationIdentity);
    await chmod(target, entry.mode);
    await syncDirectory(target);
  }
  await syncDirectory(dirname(path));
  const captured = await captureMigrationTree(path);
  if (!captured || captured.evidence.digest !== migrationTreeDigest(entries))
    migrationFailure(path, "Staging did not preserve all bytes, modes, and links.");
  return captured.evidence;
}

export async function removeMigrationTree(
  path: string,
  expected: MigrationTreeEvidence,
): Promise<void> {
  const currentTree = await captureMigrationTree(path);
  if (!currentTree) return;
  await assertMigrationIdentity(path, expected.root);
  for (const current of currentTree.evidence.entries) {
    const known = expected.entries.find((entry) => entry.path === current.path);
    if (!known || JSON.stringify(known) !== JSON.stringify(current))
      migrationFailure(
        join(path, current.path),
        "Unknown or changed content appeared in migration recovery storage.",
      );
  }
  for (const entry of [...currentTree.evidence.entries].sort(
    (a, b) => b.path.split(sep).length - a.path.split(sep).length || b.path.localeCompare(a.path),
  )) {
    const target = entry.path ? join(path, entry.path) : path;
    await assertMigrationIdentity(target, entry.identity);
    for (let parent = dirname(target); isWithin(path, parent); parent = dirname(parent)) {
      const parentEntry = expected.entries.find((item) => item.path === relative(path, parent));
      if (!parentEntry) migrationFailure(parent, "Recovery parent has no ownership evidence.");
      await assertMigrationIdentity(parent, parentEntry.identity);
      if (parent === path) break;
    }
    if (entry.identity.kind === "directory") await rmdir(target);
    else {
      const current = await captureMigrationTree(target);
      const record = current?.evidence.entries[0];
      if (!record || record.hash !== entry.hash || record.target !== entry.target)
        migrationFailure(target, "Recovery content changed before cleanup.");
      await unlink(target);
    }
  }
  await syncDirectory(dirname(path));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeRelative(value: string): boolean {
  return (
    value === "" ||
    (!value.includes("\\") &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."))
  );
}
function validIdentity(value: unknown): value is MigrationIdentity {
  return (
    record(value) &&
    ["dev", "ino", "uid"].every(
      (key) => typeof value[key] === "string" && /^\d+$/.test(value[key] as string),
    ) &&
    Number.isInteger(value.mode) &&
    (value.mode as number) >= 0 &&
    (value.mode as number) <= 0o777 &&
    ["directory", "file", "link"].includes(value.kind as string)
  );
}
function validTree(value: unknown): value is MigrationTreeEvidence {
  if (
    !record(value) ||
    !validIdentity(value.root) ||
    typeof value.digest !== "string" ||
    !digestPattern.test(value.digest) ||
    !Array.isArray(value.entries)
  )
    return false;
  const paths = new Set<string>();
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      typeof entry.path !== "string" ||
      !safeRelative(entry.path) ||
      paths.has(entry.path) ||
      !validIdentity(entry.identity) ||
      !(entry.hash === null || (typeof entry.hash === "string" && hex.test(entry.hash))) ||
      !(entry.target === null || (typeof entry.target === "string" && !entry.target.includes("\0")))
    )
      return false;
    paths.add(entry.path);
  }
  return paths.has("") && JSON.stringify(value.entries[0]?.identity) === JSON.stringify(value.root);
}

function validateReceipt(
  value: unknown,
  registry: string,
  path: string,
): asserts value is RegistryMigrationReceipt {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.registry !== registry ||
    !["preparing", "ready", "complete"].includes(value.phase as string) ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.verified) ||
    !record(value.nameMap) ||
    !record(value.provenance) ||
    Object.values(value.provenance).some((entry) => !record(entry)) ||
    (value.externalRoots !== undefined &&
      (!Array.isArray(value.externalRoots) ||
        value.externalRoots.some(
          (root) => typeof root !== "string" || !root.startsWith("/") || root.includes("\0"),
        ))) ||
    Object.values(value.nameMap).some((name) => typeof name !== "string")
  )
    migrationFailure(path, "Malformed registry migration receipt.", "E_MIGRATION_RECEIPT");
  for (const operation of value.operations) {
    if (
      !record(operation) ||
      typeof operation.path !== "string" ||
      !isWithin(registry, operation.path) ||
      !/^(?:(?:all-skills|sets)\/[^/]+|packs\/[^/]+(?:\/[^/]+)?)$/.test(
        relative(registry, operation.path).split(sep).join("/"),
      ) ||
      !validIdentity(operation.parent) ||
      !Array.isArray(operation.ancestors) ||
      !operation.ancestors.length ||
      operation.ancestors.some(
        (entry) =>
          !record(entry) ||
          typeof entry.path !== "string" ||
          !isWithin(registry, entry.path) ||
          !validIdentity(entry.identity) ||
          entry.identity.kind !== "directory",
      ) ||
      operation.ancestors[0]?.path !== dirname(operation.path) ||
      operation.ancestors.at(-1)?.path !== registry ||
      !record(operation.item) ||
      typeof operation.item.id !== "string" ||
      operation.item.path !== operation.path ||
      !(operation.before === null || validTree(operation.before)) ||
      !(operation.after === null || validTree(operation.after))
    )
      migrationFailure(
        path,
        "Migration receipt contains an unsafe operation.",
        "E_MIGRATION_RECEIPT",
      );
    for (const field of ["stage", "parked"] as const) {
      const entry = operation[field];
      if (
        entry !== null &&
        (typeof entry !== "string" ||
          dirname(entry) !== dirname(operation.path) ||
          !stagePattern.test(relative(dirname(entry), entry)))
      )
        migrationFailure(path, "Migration staging path is invalid.", "E_MIGRATION_RECEIPT");
    }
  }
  for (const item of value.verified)
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.path !== "string" ||
      !Array.isArray(item.details) ||
      !Array.isArray(item.dependsOn)
    )
      migrationFailure(path, "Malformed migration verification evidence.", "E_MIGRATION_RECEIPT");
}

export async function readRegistryMigrationReceipt(
  registry: string,
  options: MigrationOptions,
  externalRoots: readonly string[] = [],
): Promise<ReceiptSnapshot<RegistryMigrationReceipt>> {
  const snapshot = await readBoundReceipt<RegistryMigrationReceipt>(registry, binding, {
    ...options,
    forbiddenRoots: [registry, ...externalRoots],
  });
  if (snapshot.document) validateReceipt(snapshot.document.data, registry, snapshot.path);
  return snapshot;
}

export async function writeRegistryMigrationReceipt(
  previous: ReceiptSnapshot<RegistryMigrationReceipt>,
  value: RegistryMigrationReceipt,
  options: MigrationOptions,
): Promise<ReceiptSnapshot<RegistryMigrationReceipt>> {
  validateReceipt(value, previous.scopeRoot, previous.path);
  return writeBoundReceipt(previous, value, {
    ...options,
    forbiddenRoots: [previous.scopeRoot, ...(value.externalRoots ?? [])],
  });
}

/** Recover only the exact prepared objects, never a tree inferred from target containment. */
export async function publishMigrationOperation(operation: MigrationOperation): Promise<void> {
  await assertMigrationAncestors(operation.ancestors);
  await assertMigrationIdentity(dirname(operation.path), operation.parent);
  const destination = await captureMigrationTree(operation.path);
  const staged = operation.stage ? await captureMigrationTree(operation.stage) : null;
  const parked = operation.parked ? await captureMigrationTree(operation.parked) : null;
  if (
    destination &&
    operation.after &&
    JSON.stringify(destination.evidence) === JSON.stringify(operation.after)
  ) {
    if (staged) migrationFailure(operation.path, "Both staged and published content exist.");
  } else {
    if (destination) {
      await assertMigrationTree(operation.path, operation.before);
      if (!operation.parked || parked)
        migrationFailure(operation.path, "Cannot park the original migration entry safely.");
      await assertMigrationTree(operation.parked, null);
      await rename(operation.path, operation.parked);
    } else if (operation.before && !parked && operation.after)
      migrationFailure(
        operation.path,
        "Original migration content and its recovery path are both missing.",
      );
    if (operation.parked && (await migrationLstat(operation.parked)))
      await assertMigrationTree(operation.parked, operation.before);
    if (operation.after) {
      if (!operation.stage || !staged)
        migrationFailure(operation.path, "Prepared migration content is missing.");
      await assertMigrationTree(operation.stage, operation.after);
      await assertMigrationTree(operation.path, null);
      await assertMigrationIdentity(dirname(operation.path), operation.parent);
      await rename(operation.stage, operation.path);
      await assertMigrationTree(operation.path, operation.after);
    }
    await syncDirectory(dirname(operation.path));
  }
}
