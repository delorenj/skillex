import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ActivationData, EntryIdentity, OwnedNode } from "./activation-types.js";
import { fail } from "./error.js";
import { isSkillName } from "./manifest.js";
import { ExitCode } from "./result.js";
import { volumeUuid } from "./volume-identity.js";

export interface Entry {
  readonly path: string;
  readonly info: BigIntStats;
  readonly raw?: string;
}

export function refuse(
  path: string,
  message: string,
  code:
    | "E_ACTIVATION_CONFLICT"
    | "E_OWNERSHIP_CHANGED"
    | "E_ACTIVATION_RECURSIVE"
    | "E_ACTIVATION_RECEIPT" = "E_ACTIVATION_CONFLICT",
): never {
  fail(
    code,
    message,
    {
      path,
      fix: "Inspect the named content and receipt. Preserve foreign entries; migrate ownership explicitly or restore the recorded object before retrying sync.",
    },
    ExitCode.REFUSED,
  );
}

export function within(path: string, root: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      part !== ".." &&
      !isAbsolute(part))
  );
}

export async function entry(path: string): Promise<Entry | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    return { path, info, ...(info.isSymbolicLink() ? { raw: await readlink(path) } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function identity(item: Entry): EntryIdentity {
  if (item.info.isSymbolicLink())
    return {
      kind: "link",
      dev: String(item.info.dev),
      ino: String(item.info.ino),
      raw: item.raw ?? "",
    };
  if (item.info.isDirectory())
    return { kind: "directory", dev: String(item.info.dev), ino: String(item.info.ino) };
  refuse(item.path, "Only recorded directories and symbolic links can be managed.");
}

/**
 * The identity written into a receipt: `identity()` plus the durable volume id.
 * Journals and transient guards keep the plain `identity()` shape.
 */
export function recordIdentity(item: Entry): EntryIdentity {
  const base = identity(item);
  const uuid = volumeUuid(item.path, item.info.dev, item.info.isSymbolicLink());
  return uuid === undefined ? base : { ...base, volumeUuid: uuid };
}

/**
 * Is `item` on the volume the receipt recorded?
 *
 * With a recorded volume id the id decides: the same id under a different
 * device number is a renumbering of the same volume (ok), a different id is a
 * genuine ownership change (refused) even if the device number happens to be
 * reused. A legacy identity (`dev` only) cannot name its volume, so a device
 * number that differs is accepted as a renumbering provided `ino`, kind and
 * link target still match; the next apply upgrades the receipt.
 */
function sameVolume(item: Entry, expected: EntryIdentity): boolean {
  const devSame = String(item.info.dev) === expected.dev;
  if (expected.volumeUuid === undefined) return true;
  const current = volumeUuid(item.path, item.info.dev, item.info.isSymbolicLink());
  return current === undefined ? devSame : current === expected.volumeUuid;
}

export function matches(item: Entry | undefined, expected: EntryIdentity): boolean {
  return (
    !!item &&
    String(item.info.ino) === expected.ino &&
    (expected.kind === "directory"
      ? item.info.isDirectory()
      : item.info.isSymbolicLink() && item.raw === expected.raw) &&
    sameVolume(item, expected)
  );
}

function stripKeys<T>(value: T, keys: ReadonlySet<string>): T {
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, keys)) as T;
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !keys.has(key))
        .map(([key, item]) => [key, stripKeys(item, keys)]),
    ) as T;
  return value;
}
const VOLUME_KEYS: ReadonlySet<string> = new Set(["volumeUuid"]);
const DEVICE_KEYS: ReadonlySet<string> = new Set(["volumeUuid", "dev"]);

/**
 * Structural copy of receipt data without `volumeUuid`. Migration and cutover compare receipt
 * ownership against identities captured without a volume id; the id is a refinement of `dev`,
 * not a different claim, so those comparisons ignore it.
 */
export function sansVolume<T>(value: T): T {
  return stripKeys(value, VOLUME_KEYS);
}

/**
 * Structural copy of receipt data without `volumeUuid` and `dev`: the device hints that a
 * renumbering or a legacy record makes stale. Plans compare with this so a stale hint alone is
 * not drift (read-only commands stay clean); when a write happens for any real reason it carries
 * the refreshed identities, which is how a legacy receipt is upgraded.
 */
export function sansDevice<T>(value: T): T {
  return stripKeys(value, DEVICE_KEYS);
}

/** True when a matching entry's receipt record is stale (renumbered device or no volume id yet). */
export function needsUpgrade(item: Entry, expected: EntryIdentity): boolean {
  const fresh = recordIdentity(item);
  return fresh.dev !== expected.dev || fresh.volumeUuid !== expected.volumeUuid;
}

function equalIdentity(left: unknown, right: EntryIdentity): boolean {
  return (
    validIdentity(left) &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.raw === right.raw &&
    left.volumeUuid === right.volumeUuid
  );
}

export async function requireIdentity(
  path: string,
  expected: EntryIdentity,
  missingOkay = false,
): Promise<Entry | undefined> {
  const actual = await entry(path);
  if (!actual && missingOkay) return undefined;
  if (!matches(actual, expected))
    refuse(
      path,
      "Recorded ownership no longer matches the filesystem object.",
      "E_OWNERSHIP_CHANGED",
    );
  return actual;
}

export async function inspectOwnedNode(
  path: string,
  node: OwnedNode,
  missingOkay = false,
): Promise<boolean> {
  const actual = await requireIdentity(path, node.identity, missingOkay);
  if (!actual) return false;
  if (node.identity.kind === "directory") {
    for (const name of await readdir(path)) {
      const expected = node.children?.[name];
      if (!expected)
        refuse(
          join(path, name),
          "The owned root contains an unrecorded entry; whole-root replacement is refused.",
        );
      await requireIdentity(join(path, name), expected);
    }
  }
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function validIdentity(value: unknown): value is EntryIdentity {
  return (
    record(value) &&
    exact(value, ["kind", "dev", "ino", "raw", "volumeUuid"]) &&
    (value.volumeUuid === undefined ||
      (typeof value.volumeUuid === "string" && /^[0-9A-Za-z-]{4,64}$/.test(value.volumeUuid))) &&
    ["directory", "link"].includes(String(value.kind)) &&
    typeof value.dev === "string" &&
    /^\d+$/.test(value.dev) &&
    typeof value.ino === "string" &&
    /^\d+$/.test(value.ino) &&
    (value.kind === "link"
      ? typeof value.raw === "string" && value.raw.length > 0 && !value.raw.includes("\0")
      : value.raw === undefined)
  );
}
function validNode(value: unknown): value is OwnedNode {
  return (
    record(value) &&
    exact(value, ["identity", "children"]) &&
    validIdentity(value.identity) &&
    (value.identity.kind === "link"
      ? value.children === undefined
      : record(value.children) &&
        Object.entries(value.children).every(
          ([name, child]) => isSkillName(name) && validIdentity(child) && child.kind === "link",
        ))
  );
}

export function validateData(
  raw: unknown,
  root: string,
  aliases: readonly string[],
  receipt: string,
): ActivationData {
  const invalid = () =>
    refuse(
      receipt,
      "Activation receipt payload is malformed or claims paths outside this scope.",
      "E_ACTIVATION_RECEIPT",
    );
  if (
    !record(raw) ||
    !exact(raw, ["version", "links", "directories", "sources", "pending"]) ||
    raw.version !== 1 ||
    !record(raw.links) ||
    !record(raw.directories) ||
    !Array.isArray(raw.sources)
  )
    return invalid();
  const allowedLink = (path: string) =>
    path === root ||
    aliases.includes(path) ||
    (dirname(path) === root && isSkillName(path.slice(root.length + 1)));
  for (const [path, value] of Object.entries(raw.links))
    if (!allowedLink(path) || !validIdentity(value) || value.kind !== "link") return invalid();
  for (const [path, value] of Object.entries(raw.directories))
    if (path !== root || !validIdentity(value) || value.kind !== "directory") return invalid();
  if (raw.links[root] && raw.directories[root]) return invalid();
  for (const source of raw.sources) {
    if (
      !record(source) ||
      !exact(source, ["kind", "path", "commit", "reason"]) ||
      !["catalog", "pack", "set"].includes(String(source.kind)) ||
      typeof source.path !== "string" ||
      !isAbsolute(source.path) ||
      (source.commit !== null &&
        (typeof source.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(source.commit))) ||
      (source.reason !== null && typeof source.reason !== "string")
    )
      return invalid();
  }
  const pending = raw.pending;
  if (pending !== undefined) {
    if (
      !record(pending) ||
      !exact(pending, ["id", "intent", "path", "stage", "parked", "previous", "next"]) ||
      typeof pending.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pending.id) ||
      typeof pending.intent !== "string" ||
      !/^[a-f0-9]{64}$/.test(pending.intent) ||
      typeof pending.path !== "string" ||
      !allowedLink(pending.path) ||
      pending.stage !== join(dirname(root), `.skillex-tmp-${pending.id}-new`) ||
      pending.parked !== join(dirname(root), `.skillex-tmp-${pending.id}-old`) ||
      (pending.previous !== undefined && !validNode(pending.previous)) ||
      (pending.next !== undefined && !validNode(pending.next)) ||
      (!pending.previous && !pending.next)
    )
      return invalid();
    for (const node of [pending.previous, pending.next])
      if (node && (node as OwnedNode).identity.kind === "directory" && pending.path !== root)
        return invalid();
    if (pending.previous) {
      const previous = pending.previous as OwnedNode;
      const owned =
        previous.identity.kind === "link" ? raw.links[pending.path] : raw.directories[pending.path];
      if (!equalIdentity(owned, previous.identity)) return invalid();
      for (const [name, child] of Object.entries(previous.children ?? {}))
        if (!equalIdentity(raw.links[join(pending.path, name)], child)) return invalid();
    }
  }
  return raw as unknown as ActivationData;
}

export function emptyData(): ActivationData {
  return { version: 1, links: {}, directories: {}, sources: [] };
}

export function replaceOwnership(
  data: ActivationData,
  path: string,
  node?: OwnedNode,
): ActivationData {
  const links = { ...data.links };
  const directories = { ...data.directories };
  delete links[path];
  delete directories[path];
  // Root transitions retire only the exact direct children recorded for this root.
  for (const child of Object.keys(links)) if (dirname(child) === path) delete links[child];
  if (node?.identity.kind === "directory") {
    directories[path] = node.identity;
    for (const [name, child] of Object.entries(node.children ?? {}))
      links[join(path, name)] = child;
  } else if (node) links[path] = node.identity;
  return { version: 1, links, directories, sources: data.sources };
}

export function lexicalTarget(path: string, raw: string): string {
  return resolve(dirname(path), raw);
}
