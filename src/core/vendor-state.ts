import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { validateActivationStateLocation } from "./activation-state.js";
import { isWithin } from "./content.js";
import { fail } from "./error.js";
import type { LockOptions } from "./lock.js";
import { isSkillName } from "./manifest.js";
import { ExitCode } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import type { VendorChange } from "./vendor-types.js";

export interface VendorIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: number;
  readonly kind: "file" | "directory";
}

export interface VendorTreeEvidence {
  readonly root: VendorIdentity;
  readonly entries: readonly {
    readonly path: string;
    readonly identity: VendorIdentity;
    readonly hash: string | null;
  }[];
}

export interface VendorOperation {
  readonly change: VendorChange;
  readonly stage: string | null;
  readonly parked: string | null;
  readonly before: VendorTreeEvidence | null;
  readonly after: VendorTreeEvidence | null;
}

export interface VendorJournal {
  readonly schema: 1;
  readonly catalog: string;
  readonly host: string;
  readonly uid: string;
  readonly phase: "preparing" | "ready";
  readonly operations: readonly VendorOperation[];
}

export interface VendorJournalSnapshot {
  readonly path: string;
  readonly catalog: string;
  readonly document: VendorJournal | null;
}

interface JournalEvidence {
  readonly registry: RegistrySelection;
  readonly options: LockOptions;
  readonly catalogIdentity: VendorIdentity;
  readonly parents: Map<string, VendorIdentity>;
  readonly bytes: Buffer | null;
  readonly file: VendorIdentity | null;
}

const snapshots = new WeakMap<VendorJournalSnapshot, JournalEvidence>();
const stagePattern =
  /^\.skillex-tmp-vendor-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-(?:new|old)$/;
const hashPattern = /^[a-f0-9]{64}$/;
const journalLimit = 16 * 1024 * 1024;

function stateFailure(path: string, message: string): never {
  fail(
    "E_VENDOR_JOURNAL",
    message,
    {
      path,
      fix: "Preserve the journal and recovery directories. Inspect their ownership/content before retrying vendor sync; ordinary catalog writes remain blocked.",
    },
    ExitCode.REFUSED,
  );
}

export async function vendorLstat(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function vendorIdentity(info: BigIntStats): VendorIdentity {
  if (!info.isFile() && !info.isDirectory())
    throw new TypeError("Vendor evidence requires a real regular file or directory.");
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    uid: String(info.uid),
    mode: Number(info.mode & 0o777n),
    kind: info.isDirectory() ? "directory" : "file",
  };
}

function matches(info: BigIntStats | null, expected: VendorIdentity): boolean {
  return (
    !!info &&
    (expected.kind === "directory" ? info.isDirectory() : info.isFile()) &&
    String(info.dev) === expected.dev &&
    String(info.ino) === expected.ino &&
    String(info.uid) === expected.uid &&
    Number(info.mode & 0o777n) === expected.mode
  );
}

export async function assertVendorIdentity(path: string, expected: VendorIdentity): Promise<void> {
  if (!matches(await vendorLstat(path), expected)) {
    stateFailure(path, "A catalog or recovery entry changed identity after inspection.");
  }
}

function fileHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stable(before: BigIntStats, after: BigIntStats): boolean {
  return (
    matches(after, vendorIdentity(before)) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/** Bounded reads never follow a replaced leaf or wait for a growing file to reach EOF. */
async function readRegular(
  path: string,
  before: BigIntStats,
  consume: (bytes: Buffer) => void,
): Promise<void> {
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    stateFailure(path, "Evidence requires a regular file of supported size.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!stable(before, await handle.stat({ bigint: true })))
      stateFailure(path, "Content was replaced before evidence could be read.");
    const chunk = Buffer.alloc(64 * 1024);
    const size = Number(before.size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - offset),
        offset,
      );
      if (!bytesRead) stateFailure(path, "Content shrank while evidence was read.");
      consume(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (
      !stable(before, await handle.stat({ bigint: true })) ||
      !stable(before, await lstat(path, { bigint: true }))
    )
      stateFailure(path, "Content changed while evidence was read.");
  } finally {
    await handle.close();
  }
}

async function regularHash(path: string, before?: BigIntStats): Promise<string> {
  const digest = createHash("sha256");
  await readRegular(path, before ?? (await lstat(path, { bigint: true })), (bytes) => {
    digest.update(bytes);
  });
  return digest.digest("hex");
}

async function journalBytes(path: string, before: BigIntStats): Promise<Buffer> {
  if (before.size > BigInt(journalLimit)) stateFailure(path, "The vendor journal exceeds 16 MB.");
  const chunks: Buffer[] = [];
  await readRegular(path, before, (bytes) => chunks.push(Buffer.from(bytes)));
  return Buffer.concat(chunks);
}

/** Exact evidence includes every authored file, including the provenance receipt. */
export async function captureVendorTree(root: string): Promise<VendorTreeEvidence> {
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory()) stateFailure(root, "Catalog content must be a real directory.");
  const rootIdentity = vendorIdentity(rootInfo);
  const entries: { path: string; identity: VendorIdentity; hash: string | null }[] = [];
  const visit = async (directory: string): Promise<void> => {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory())
      stateFailure(directory, "A content parent became a symlink or non-directory.");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() && !info.isDirectory())
        stateFailure(path, "Catalog snapshots refuse symlinks and special content.");
      const identity = vendorIdentity(info);
      const hash = info.isFile() ? await regularHash(path, info) : null;
      const after = await lstat(path, { bigint: true });
      if (!stable(info, after)) stateFailure(path, "Content changed while it was being inspected.");
      entries.push({ path: relative(root, path), identity, hash });
      if (info.isDirectory()) await visit(path);
    }
    const after = await lstat(directory, { bigint: true });
    if (!stable(before, after))
      stateFailure(directory, "A directory changed while it was being inspected.");
  };
  await visit(root);
  await assertVendorIdentity(root, rootIdentity);
  return { root: rootIdentity, entries };
}

/** Missing entries are allowed only while cleaning exact parked/prepared recovery trees. */
export async function assertVendorTree(
  root: string,
  expected: VendorTreeEvidence,
  allowMissing = false,
): Promise<void> {
  if (allowMissing && !(await vendorLstat(root))) return;
  await assertVendorIdentity(root, expected.root);
  const expectedEntries = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const found = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const before = await lstat(directory, { bigint: true });
    const identity =
      directory === root ? expected.root : expectedEntries.get(relative(root, directory))?.identity;
    if (identity?.kind !== "directory")
      stateFailure(directory, "A recovery parent has no directory ownership evidence.");
    await assertVendorIdentity(directory, identity);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const item = relative(root, path);
      const entry = expectedEntries.get(item);
      if (!entry) stateFailure(path, "Unexpected content appeared in an owned recovery directory.");
      await assertVendorIdentity(path, entry.identity);
      found.add(item);
      if (entry.identity.kind === "directory") await visit(path);
      else if ((await regularHash(path)) !== entry.hash)
        stateFailure(path, "Owned content was edited after inspection.");
    }
    if (!stable(before, await lstat(directory, { bigint: true })))
      stateFailure(directory, "Recovery membership changed while it was inspected.");
  };
  await visit(root);
  if (!allowMissing && expected.entries.some((entry) => !found.has(entry.path)))
    stateFailure(root, "Owned content disappeared after inspection.");
  await assertVendorIdentity(root, expected.root);
}

export async function removeVendorTree(root: string, expected: VendorTreeEvidence): Promise<void> {
  await assertVendorTree(root, expected, true);
  if (!(await vendorLstat(root))) return;
  const entries = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const assertParents = async (path: string) => {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const identity =
        parent === root ? expected.root : entries.get(relative(root, parent))?.identity;
      if (identity?.kind !== "directory" || !isWithin(root, parent))
        stateFailure(parent, "A recovery ancestor has no directory ownership evidence.");
      await assertVendorIdentity(parent, identity);
      if (parent === root) break;
    }
  };
  for (const entry of [...expected.entries].sort(
    (a, b) => b.path.split("/").length - a.path.split("/").length || b.path.localeCompare(a.path),
  )) {
    const path = join(root, entry.path);
    if (!(await vendorLstat(path))) continue;
    await assertParents(path);
    await assertVendorIdentity(path, entry.identity);
    if (entry.identity.kind === "directory") await rmdir(path);
    else {
      if ((await regularHash(path)) !== entry.hash)
        stateFailure(path, "A recovery file was edited before cleanup.");
      await assertParents(path);
      await assertVendorIdentity(path, entry.identity);
      await unlink(path);
    }
  }
  await assertVendorIdentity(root, expected.root);
  await rmdir(root);
}

function parentPaths(path: string): string[] {
  const paths: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) return paths.reverse();
  }
}

async function context(
  registry: RegistrySelection,
  options: LockOptions,
): Promise<{ path: string; catalog: string; stateHome: string }> {
  await validateActivationStateLocation(registry.root, {
    ...options,
    forbiddenRoots: [registry.root],
  });
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const value = options.stateHome ?? env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const stateHome = resolve(
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
  const catalog = await realpath(join(registry.root, "all-skills"));
  return {
    path: join(stateHome, "skillex", "vendor", "v1", `${fileHash(Buffer.from(catalog))}.json`),
    catalog,
    stateHome,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validIdentity(value: unknown): value is VendorIdentity {
  return (
    object(value) &&
    ["dev", "ino", "uid"].every(
      (key) => typeof value[key] === "string" && /^[0-9]+$/.test(value[key] as string),
    ) &&
    Number.isInteger(value.mode) &&
    Number(value.mode) >= 0 &&
    Number(value.mode) <= 0o777 &&
    ["file", "directory"].includes(String(value.kind))
  );
}
function safeRelative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    !value.includes("\\") &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    value.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}
function validTree(value: unknown): value is VendorTreeEvidence {
  return (
    object(value) &&
    validIdentity(value.root) &&
    value.root.kind === "directory" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        object(entry) &&
        safeRelative(entry.path) &&
        validIdentity(entry.identity) &&
        (entry.identity.kind === "directory"
          ? entry.hash === null
          : typeof entry.hash === "string" && hashPattern.test(entry.hash)),
    ) &&
    new Set(value.entries.map((entry) => (entry as { path: string }).path)).size ===
      value.entries.length
  );
}

function validateJournal(value: unknown, catalog: string, path: string): VendorJournal {
  if (
    !object(value) ||
    value.schema !== 1 ||
    value.catalog !== catalog ||
    value.host !== hostname() ||
    value.uid !== String(process.getuid?.() ?? 0) ||
    !["preparing", "ready"].includes(String(value.phase)) ||
    !Array.isArray(value.operations)
  )
    stateFailure(
      path,
      "The vendor journal is malformed or belongs to another catalog, host, or user.",
    );
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const operation of value.operations) {
    if (
      !object(operation) ||
      !object(operation.change) ||
      !isSkillName(operation.change.name) ||
      typeof operation.change.source !== "string" ||
      !["create", "update", "adopt", "prune"].includes(String(operation.change.action)) ||
      operation.change.path !== join(catalog, operation.change.name) ||
      names.has(operation.change.name)
    )
      stateFailure(path, "The vendor journal contains an invalid or duplicate destination.");
    names.add(operation.change.name);
    for (const location of [operation.stage, operation.parked]) {
      if (location === null) continue;
      if (
        typeof location !== "string" ||
        dirname(location) !== catalog ||
        !stagePattern.test(relative(catalog, location)) ||
        paths.has(location)
      )
        stateFailure(path, "The vendor journal contains an unsafe recovery path.");
      paths.add(location);
    }
    if (
      (operation.stage !== null && !String(operation.stage).endsWith("-new")) ||
      (operation.parked !== null && !String(operation.parked).endsWith("-old")) ||
      (operation.change.action === "create"
        ? operation.before !== null
        : operation.before === null) ||
      (operation.change.action === "prune" && operation.after !== null)
    )
      stateFailure(
        path,
        "The vendor journal action does not match its staged and parked ownership evidence.",
      );
    if (
      (operation.before !== null && !validTree(operation.before)) ||
      (operation.after !== null && !validTree(operation.after)) ||
      (operation.change.action === "prune"
        ? operation.stage !== null || operation.before === null || operation.parked === null
        : operation.stage === null) ||
      (value.phase === "ready" &&
        operation.change.action !== "prune" &&
        operation.after === null) ||
      (operation.before === null ? operation.parked !== null : operation.parked === null)
    )
      stateFailure(path, "The vendor journal contains incomplete ownership evidence.");
  }
  return value as unknown as VendorJournal;
}

export async function readVendorJournal(
  registry: RegistrySelection,
  options: LockOptions = {},
): Promise<VendorJournalSnapshot> {
  const location = await context(registry, options);
  const parents = new Map<string, VendorIdentity>();
  for (const path of parentPaths(location.path)) {
    const info = await vendorLstat(path);
    if (!info) break;
    if (
      !info.isDirectory() ||
      (process.getuid &&
        (isWithin(location.stateHome, path)
          ? info.uid !== BigInt(process.getuid())
          : info.uid !== 0n && info.uid !== BigInt(process.getuid()))) ||
      (await vendorLstat(join(path, ".git")))
    )
      stateFailure(
        path,
        "Vendor state parents must be real owned directories outside repositories.",
      );
    parents.set(path, vendorIdentity(info));
  }
  const info = await vendorLstat(location.path);
  if (
    info &&
    (!info.isFile() ||
      (process.getuid && info.uid !== BigInt(process.getuid())) ||
      info.size > 16n * 1024n * 1024n)
  )
    stateFailure(
      location.path,
      "The vendor journal must be a bounded real file owned by this user.",
    );
  const bytes = info ? await journalBytes(location.path, info) : null;
  let document: VendorJournal | null = null;
  if (bytes) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      stateFailure(location.path, "The vendor journal is not valid UTF-8 JSON.");
    }
    document = validateJournal(value, location.catalog, location.path);
    await assertVendorIdentity(location.path, vendorIdentity(info as BigIntStats));
  }
  for (const [path, identity] of parents) await assertVendorIdentity(path, identity);
  const snapshot: VendorJournalSnapshot = {
    path: location.path,
    catalog: location.catalog,
    document,
  };
  snapshots.set(snapshot, {
    registry,
    options,
    parents,
    bytes,
    file: info ? vendorIdentity(info) : null,
    catalogIdentity: vendorIdentity(await lstat(location.catalog, { bigint: true })),
  });
  return snapshot;
}

async function assertSnapshot(snapshot: VendorJournalSnapshot): Promise<JournalEvidence> {
  const evidence = snapshots.get(snapshot);
  if (!evidence)
    stateFailure(snapshot.path, "The vendor journal snapshot is not an inspected snapshot.");
  await context(evidence.registry, evidence.options);
  await assertVendorIdentity(snapshot.catalog, evidence.catalogIdentity);
  for (const [path, identity] of evidence.parents) await assertVendorIdentity(path, identity);
  const info = await vendorLstat(snapshot.path);
  if (
    evidence.file
      ? !matches(info, evidence.file) ||
        !(await journalBytes(snapshot.path, info as BigIntStats)).equals(evidence.bytes as Buffer)
      : info !== null
  )
    stateFailure(snapshot.path, "The vendor journal changed since it was read.");
  return evidence;
}

/** Caller holds the shared catalog lock. Journal publication is atomic and compare-before-write. */
export async function writeVendorJournal(
  previous: VendorJournalSnapshot,
  document: VendorJournal,
): Promise<VendorJournalSnapshot> {
  validateJournal(document, previous.catalog, previous.path);
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  if (bytes.length > journalLimit)
    stateFailure(
      previous.path,
      "The planned vendor journal exceeds 16 MB; select fewer sources or members per invocation.",
    );
  const evidence = await assertSnapshot(previous);
  for (const path of parentPaths(previous.path)) {
    if (evidence.parents.has(path)) continue;
    const info = await vendorLstat(path);
    if (info) stateFailure(path, "A vendor state parent appeared after inspection.");
    const parent = evidence.parents.get(dirname(path));
    if (parent) await assertVendorIdentity(dirname(path), parent);
    await mkdir(path, { mode: 0o700 });
    evidence.parents.set(path, vendorIdentity(await lstat(path, { bigint: true })));
  }
  const temporary = join(dirname(previous.path), `.skillex-tmp-vendor-${randomUUID()}.json`);
  const handle = await open(temporary, "wx", 0o600);
  const identity = vendorIdentity(await handle.stat({ bigint: true }));
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSnapshot(previous);
    if (evidence.file) await rename(temporary, previous.path);
    else await link(temporary, previous.path);
    const directory = await open(dirname(previous.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return await readVendorJournal(evidence.registry, evidence.options);
  } finally {
    for (const [path, expected] of evidence.parents) await assertVendorIdentity(path, expected);
    const remaining = await vendorLstat(temporary);
    if (remaining) {
      await assertVendorIdentity(temporary, identity);
      await unlink(temporary);
    }
  }
}

export async function clearVendorJournal(previous: VendorJournalSnapshot): Promise<void> {
  await assertSnapshot(previous);
  if (previous.document) {
    await unlink(previous.path);
    const directory = await open(dirname(previous.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export function newVendorJournal(
  catalog: string,
  operations: readonly VendorOperation[],
  phase: VendorJournal["phase"] = "preparing",
): VendorJournal {
  return {
    schema: 1,
    catalog,
    host: hostname(),
    uid: String(process.getuid?.() ?? 0),
    phase,
    operations,
  };
}

/** Read-only guard shared by create/import; sync alone can recover under the catalog lock. */
export async function assertNoVendorJournal(
  registry: RegistrySelection,
  options: LockOptions = {},
): Promise<void> {
  const snapshot = await readVendorJournal(registry, options);
  if (snapshot.document)
    fail(
      "E_VENDOR_RECOVERY_PENDING",
      "An interrupted vendor update needs recovery before other catalog writes.",
      {
        path: snapshot.path,
        fix: "Run vendor sync against this catalog with the same state location to inspect and recover the pending update.",
      },
      ExitCode.REFUSED,
    );
}
