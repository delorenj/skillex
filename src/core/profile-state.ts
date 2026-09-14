import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { entry, matches } from "./activation-ownership.js";
import {
  type ReceiptOptions,
  type ReceiptSnapshot,
  readBoundReceipt,
  writeBoundReceipt,
} from "./activation-state.js";
import type { EntryIdentity, SourceRevision } from "./activation-types.js";
import { fail } from "./error.js";
import { isSkillName } from "./manifest.js";
import type { ProfileLocation } from "./profile-types.js";
import { ExitCode } from "./result.js";

export interface ProfileJournal {
  readonly id: string;
  readonly name: string;
  readonly stage: string;
  readonly parked: string;
  readonly previous?: EntryIdentity;
  readonly next?: EntryIdentity;
}

export interface ProfileData {
  readonly version: 1;
  readonly root: EntryIdentity | null;
  readonly project: string | null;
  readonly sources: readonly SourceRevision[];
  readonly links: Readonly<Record<string, EntryIdentity>>;
  readonly pending?: ProfileJournal;
}

export interface ProfileState {
  readonly snapshot: ReceiptSnapshot<ProfileData>;
  readonly data: ProfileData;
}

function invalid(path: string, message: string): never {
  fail(
    "E_PROFILE_RECEIPT",
    message,
    {
      path,
      fix: "Preserve this profile and its receipt; inspect the recorded identities before retrying. Legacy ownership requires explicit migration.",
    },
    ExitCode.REFUSED,
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}
function validIdentity(value: unknown, kind: EntryIdentity["kind"]): value is EntryIdentity {
  return (
    record(value) &&
    exact(value, ["kind", "dev", "ino", "raw"]) &&
    value.kind === kind &&
    typeof value.dev === "string" &&
    /^\d+$/.test(value.dev) &&
    typeof value.ino === "string" &&
    /^\d+$/.test(value.ino) &&
    (kind === "link"
      ? typeof value.raw === "string" && !!value.raw && !value.raw.includes("\0")
      : value.raw === undefined)
  );
}
function same(left: EntryIdentity | undefined, right: EntryIdentity): boolean {
  return (
    !!left &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.raw === right.raw
  );
}

export function emptyProfileData(): ProfileData {
  return { version: 1, root: null, project: null, sources: [], links: {} };
}

function validate(raw: unknown, root: string, path: string): ProfileData {
  if (
    !record(raw) ||
    !exact(raw, ["version", "root", "project", "sources", "links", "pending"]) ||
    raw.version !== 1 ||
    (raw.root !== null && !validIdentity(raw.root, "directory")) ||
    (raw.project !== null &&
      (typeof raw.project !== "string" ||
        !isAbsolute(raw.project) ||
        raw.project.includes("\0"))) ||
    !Array.isArray(raw.sources) ||
    !record(raw.links)
  )
    invalid(path, "The profile receipt payload is malformed.");
  for (const [name, value] of Object.entries(raw.links))
    if (!isSkillName(name) || !validIdentity(value, "link"))
      invalid(path, "A profile receipt claims an invalid child name or identity.");
  if (raw.root === null && (Object.keys(raw.links).length || raw.pending !== undefined))
    invalid(path, "Managed children require a recorded real skills directory.");
  for (const source of raw.sources) {
    if (
      !record(source) ||
      !exact(source, ["kind", "path", "commit", "reason"]) ||
      !["catalog", "pack"].includes(String(source.kind)) ||
      typeof source.path !== "string" ||
      !isAbsolute(source.path) ||
      source.path.includes("\0") ||
      (source.commit !== null &&
        (typeof source.commit !== "string" ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit))) ||
      (source.reason !== null && typeof source.reason !== "string")
    )
      invalid(path, "Profile source revision evidence is malformed.");
  }
  if (raw.pending !== undefined) {
    const pending = raw.pending;
    if (
      !record(pending) ||
      !exact(pending, ["id", "name", "stage", "parked", "previous", "next"]) ||
      typeof pending.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pending.id) ||
      !isSkillName(pending.name) ||
      pending.stage !== join(root, `.skillex-tmp-profile-${pending.id}-new`) ||
      pending.parked !== join(root, `.skillex-tmp-profile-${pending.id}-old`) ||
      (pending.previous !== undefined && !validIdentity(pending.previous, "link")) ||
      (pending.next !== undefined && !validIdentity(pending.next, "link")) ||
      (!pending.previous && !pending.next)
    )
      invalid(path, "The pending profile operation claims invalid recovery paths or identities.");
    if (
      pending.previous &&
      (!Object.hasOwn(raw.links, pending.name) ||
        !same(
          raw.links[pending.name] as EntryIdentity | undefined,
          pending.previous as EntryIdentity,
        ))
    )
      invalid(path, "The pending profile operation does not match its recorded previous claim.");
    if (!pending.previous && Object.hasOwn(raw.links, pending.name))
      invalid(path, "A pending new child conflicts with an existing claim.");
  }
  return raw as unknown as ProfileData;
}

/** Profiles share atomic state IO, while their namespace, payload, and ownership rules remain separate. */
export async function readProfileState(
  profile: ProfileLocation,
  options: ReceiptOptions = {},
): Promise<ProfileState> {
  let snapshot = await readBoundReceipt<ProfileData>(
    profile.root,
    { namespace: "profiles", targetParts: ["skills"] },
    options,
  );
  const data = snapshot.document
    ? validate(snapshot.document.data, profile.skillsRoot, snapshot.path)
    : emptyProfileData();
  if (snapshot.document) {
    const guarded = await readBoundReceipt<ProfileData>(
      profile.root,
      { namespace: "profiles", targetParts: ["skills"] },
      {
        ...options,
        forbiddenRoots: [
          ...(options.forbiddenRoots ?? []),
          ...(data.project ? [data.project] : []),
          ...data.sources.map((source) =>
            source.kind === "catalog" ? dirname(source.path) : source.path,
          ),
        ],
      },
    );
    if (!isDeepStrictEqual(guarded.document, snapshot.document))
      invalid(
        snapshot.path,
        "The profile receipt changed while its recorded source paths were being validated.",
      );
    snapshot = guarded;
  }
  if (data.root && !matches(await entry(profile.skillsRoot), data.root)) {
    fail(
      "E_PROFILE_ROOT_CHANGED",
      "The recorded real profile skills directory was replaced or removed.",
      {
        path: profile.skillsRoot,
        fix: "Restore the recorded directory or explicitly migrate this profile's ownership. Sync never replaces the skills root.",
      },
      ExitCode.REFUSED,
    );
  }
  return { snapshot, data };
}

export async function writeProfileState(
  previous: ProfileState,
  data: ProfileData,
): Promise<ProfileState> {
  validate(data, previous.snapshot.activationRoot, previous.snapshot.path);
  const snapshot = await writeBoundReceipt(previous.snapshot, data);
  return { snapshot, data };
}
