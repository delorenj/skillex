import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { entry } from "./activation-ownership.js";
import { fail } from "./error.js";
import type { ProfileLocalEntry, ProfileLocation, ProfileOptions } from "./profile-types.js";
import { ExitCode } from "./result.js";

// Hermes-owned bookkeeping that may live inside a strict skills root. None of it is
// discoverable as a skill: usage counters, curator scheduler/suppression state, the
// org sync manifest, and the curator's pre-run tarball store. .hub and .archive stay
// refused: they mean hub installs or curator archival moved content in or out.
const metadataFiles = new Set([
  ".usage.json",
  ".usage.json.lock",
  ".curator_state",
  ".curator_suppressed",
  ".sync_state",
]);
const metadataDirectories = new Set([".curator_backups"]);

function hermesMetadata(item: ProfileLocalEntry): boolean {
  if (item.kind === "file") return metadataFiles.has(item.name);
  if (item.kind === "directory") return metadataDirectories.has(item.name);
  return false;
}

function refuse(path: string, message: string): never {
  return fail(
    "E_PROFILE_SKILLEX_ONLY",
    message,
    {
      path,
      fix: "Preserve foreign content outside discovery roots; clear skills.external_dirs through the locked config renderer, then preview skillex profile sync NAME --project PATH --skillex-only. Never delete or adopt local payloads implicitly.",
    },
    ExitCode.REFUSED,
  );
}

export async function strictProfile(
  profile: ProfileLocation,
  options: ProfileOptions,
): Promise<boolean> {
  if (options.skillexOnly !== undefined && typeof options.skillexOnly !== "boolean")
    refuse(profile.root, "skillexOnly must be boolean.");
  const marker = await entry(join(profile.root, ".skillex-only"));
  if (marker && !marker.info.isFile())
    refuse(marker.path, "The strict policy marker must be a regular file.");
  return options.skillexOnly === true || marker !== undefined;
}

/** Persist a profile's selection boundary independently of the caller's HOME. */
export async function profileInheritsGlobal(profile: ProfileLocation): Promise<boolean> {
  const path = join(profile.root, "config.yaml");
  const config = await entry(path);
  if (!config) return true;
  // Ordinary Hermes profiles can link their config. Strict callers still require
  // a generated regular file through assertStrictProfile before projection.
  if (!config.info.isFile() && !(config.info.isSymbolicLink() && (await stat(path)).isFile()))
    refuse(path, "Profile config must resolve to a regular file.");
  const document = parseDocument(await readFile(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length) refuse(path, "Cannot validate profile skill inheritance.");
  const inherit: unknown = document.toJS()?.skills?.inherit_global;
  if (inherit !== undefined && typeof inherit !== "boolean")
    refuse(path, "Profile skills.inherit_global must be boolean.");
  return inherit !== false;
}

export async function assertStrictProfile(
  profile: ProfileLocation,
  options: ProfileOptions,
  local: readonly ProfileLocalEntry[],
): Promise<boolean> {
  if (!(await strictProfile(profile, options))) return false;
  for (const item of local)
    if (!hermesMetadata(item))
      refuse(item.path, `Skillex-only profile contains unowned entry ${item.name}.`);
  const path = join(profile.root, "config.yaml");
  const config = await entry(path);
  if (config) {
    if (!config.info.isFile())
      refuse(path, "Strict profile config must be a regular generated file.");
    const document = parseDocument(await readFile(path, "utf8"), { uniqueKeys: true });
    if (document.errors.length) refuse(path, "Cannot validate strict skills configuration.");
    const dirs: unknown = document.toJS()?.skills?.external_dirs;
    if (dirs !== undefined && (!Array.isArray(dirs) || dirs.length))
      refuse(path, "Skillex-only profiles require skills.external_dirs: [].");
  }
  const optOut = await entry(join(profile.root, ".no-bundled-skills"));
  if (optOut && !optOut.info.isFile())
    refuse(optOut.path, "Bundled opt-out marker must be a regular file.");
  return true;
}

export async function publishStrictPolicy(profile: ProfileLocation): Promise<void> {
  // Publish opt-out first: interrupted policy publication must never enable seeding.
  for (const name of [".no-bundled-skills", ".skillex-only"]) {
    const path = join(profile.root, name);
    const existing = await entry(path);
    if (existing) {
      if (!existing.info.isFile()) refuse(path, "Policy markers must be regular files.");
      continue;
    }
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        "Skillex owns this PM skill projection. Use skillex profile sync; no local installs.\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
