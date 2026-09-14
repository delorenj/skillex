import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ActivationData, EntryIdentity, OwnedNode } from "./activation-types.js";
import { fail } from "./error.js";
import { isSkillName } from "./manifest.js";
import { ExitCode } from "./result.js";

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

export function matches(item: Entry | undefined, expected: EntryIdentity): boolean {
  return (
    !!item &&
    String(item.info.dev) === expected.dev &&
    String(item.info.ino) === expected.ino &&
    (expected.kind === "directory"
      ? item.info.isDirectory()
      : item.info.isSymbolicLink() && item.raw === expected.raw)
  );
}

function equalIdentity(left: unknown, right: EntryIdentity): boolean {
  return (
    validIdentity(left) &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.raw === right.raw
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
    exact(value, ["kind", "dev", "ino", "raw"]) &&
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
      !["catalog", "pack"].includes(String(source.kind)) ||
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
