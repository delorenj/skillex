import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { entry } from "./activation-ownership.js";
import { fail } from "./error.js";
import type { ProfileLocalEntry, ProfileLocation, ProfileOptions } from "./profile-types.js";
import { ExitCode } from "./result.js";

// Hermes-owned bookkeeping that may live inside a strict skills root. None of it is
// discoverable as a skill: usage counters, curator scheduler/suppression state, the
// org sync manifest, the bundled-skill sync manifest, the skill-mutation audit ledger,
// the curator's pre-run tarball store, and the skill manager's per-skill lock files
// (tools/skill_manager_tool.py).
// Agent-written skills are tolerated separately (learnedSkills below).
// .archive stays refused: curator archival moved content out. .hub is tolerated only while it
// records no install (hermes_cli/skills_hub.py: an empty lock, an empty quarantine, browse
// caches); any installed or quarantined payload is still refused.
const metadataFiles = new Set([
  ".usage.json",
  ".usage.json.lock",
  ".curator_state",
  ".curator_suppressed",
  ".sync_state",
  ".bundled_manifest",
  ".curator_ledger.jsonl",
]);
const metadataDirectories = new Set([".curator_backups", ".locks"]);
const hubFiles = new Set(["audit.log", "taps.json", "lock.json"]);

async function children(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * A bundled category stub: a directory holding exactly one regular DESCRIPTION.md and nothing
 * else. Hermes before bf21d8d seeded these into strict profiles; with no SKILL.md in or below it,
 * Hermes discovery never lists it as a skill (hermes_cli/profile_distribution.py treats it as a
 * category).
 */
async function categoryStub(item: ProfileLocalEntry): Promise<boolean> {
  if (item.kind !== "directory" || item.shadows) return false;
  const entries = await children(item.path);
  return entries?.length === 1 && entries[0]?.name === "DESCRIPTION.md" && entries[0].isFile();
}

async function idleHub(item: ProfileLocalEntry): Promise<boolean> {
  if (item.kind !== "directory" || item.name !== ".hub") return false;
  const entries = await children(item.path);
  if (!entries) return false;
  for (const child of entries) {
    const path = join(item.path, child.name);
    if (child.isFile() && hubFiles.has(child.name)) {
      if (child.name !== "lock.json") continue;
      try {
        const lock: unknown = JSON.parse(await readFile(path, "utf8"));
        const installed = (lock as { installed?: unknown } | null)?.installed;
        if (!installed || typeof installed !== "object" || Object.keys(installed).length)
          return false;
      } catch {
        return false;
      }
    } else if (child.isDirectory() && child.name === "quarantine") {
      if ((await children(path))?.length !== 0) return false;
    } else if (child.isDirectory() && child.name === "index-cache") {
      const cached = await children(path);
      if (!cached || cached.some((entry) => !entry.isFile())) return false;
    } else return false;
  }
  return true;
}

async function hermesMetadata(item: ProfileLocalEntry): Promise<boolean> {
  if (item.kind === "file") return metadataFiles.has(item.name);
  if (item.kind === "directory")
    return (
      metadataDirectories.has(item.name) || (await idleHub(item)) || (await categoryStub(item))
    );
  return false;
}

function refuse(path: string, message: string): never {
  return fail(
    "E_PROFILE_SKILLEX_ONLY",
    message,
    {
      path,
      fix: "Preserve foreign content outside discovery roots; clear skills.external_dirs (and point skills.create_dir inside the profile or unset it) through the locked config renderer, then preview skillex profile sync NAME --project PATH --skillex-only. Never delete or adopt local payloads implicitly.",
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

const learnedScanLimit = 20_000;

/**
 * Skills a desk's agent wrote for itself (Hermes skill_manage), or a category of them: a real,
 * non-dot directory whose whole tree holds only real directories and regular files. Returns the
 * names of every skill directory inside it (a directory holding SKILL.md), or null when the tree
 * holds a link or special file, which could pull content in from outside the desk.
 */
async function learnedSkills(item: ProfileLocalEntry): Promise<string[] | null> {
  if (item.kind !== "directory" || item.name.startsWith(".")) return null;
  const skills: string[] = [];
  const pending = [item.path];
  let seen = 0;
  while (pending.length) {
    const directory = pending.pop() as string;
    const entries = await children(directory);
    if (!entries) return null;
    for (const child of entries) {
      if (++seen > learnedScanLimit) return null;
      if (child.isDirectory()) pending.push(join(directory, child.name));
      else if (!child.isFile()) return null;
      else if (child.name === "SKILL.md") skills.push(basename(directory));
    }
  }
  return skills;
}

/**
 * Hermes writes agent-made skills to skills.create_dir, a discovery tier below the
 * profile's own skills/ (agent/skill_utils.py get_skill_create_dir: relative values are
 * HERMES_HOME-relative; one equal to the skills dir counts as unset). A desk-private
 * create_dir such as `learned-skills` keeps agent-written skills out of the projection and
 * cannot shadow a selected link, so it is tolerated (operator decision 2026-11-06,
 * SKRILL-35). One that resolves outside the profile is a second, shared discovery route,
 * as nonempty external_dirs are, and stays refused.
 */
async function privateCreateDir(
  value: unknown,
  profile: ProfileLocation,
  options: ProfileOptions,
): Promise<boolean> {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string" || !value.trim() || value.includes("$")) return false;
  const home = options.home ?? homedir();
  const raw = value.trim();
  const expanded = raw === "~" ? home : raw.replace(/^~(?=\/)/, home);
  const lexical = resolve(profile.root, expanded);
  // Resolve through the deepest existing ancestor, so a create_dir Hermes has not made yet
  // still cannot reach outside the profile through a symlinked parent.
  const real = async (path: string): Promise<string> => {
    const parent = resolve(path, "..");
    try {
      return await realpath(path);
    } catch {
      return parent === path ? path : join(await real(parent), basename(path));
    }
  };
  const root = await real(profile.root);
  const target = await real(lexical);
  const inside = relative(root, target);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/**
 * Strict (Skillex-only) policy: Skillex owns every link it projects. Hermes bookkeeping and the
 * skills a desk's own agent wrote may sit beside those links (operator decision 2026-11-06,
 * SKRILL-35); a learned skill named like a selected one, a foreign link, a stray file, an
 * archive or a hub install is still refused. `desired` names the skills Skillex will project.
 */
export async function assertStrictProfile(
  profile: ProfileLocation,
  options: ProfileOptions,
  local: readonly ProfileLocalEntry[],
  desired: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  if (!(await strictProfile(profile, options))) return false;
  for (const item of local) {
    if (await hermesMetadata(item)) continue;
    const learned = await learnedSkills(item);
    if (!learned) refuse(item.path, `Skillex-only profile contains unowned entry ${item.name}.`);
    const clash = [item.name, ...learned].find((name) => desired.has(name));
    if (clash !== undefined)
      refuse(
        item.path,
        `Agent-written skill ${clash} in ${item.name} shares its name with a selected skill.`,
      );
  }
  const path = join(profile.root, "config.yaml");
  const config = await entry(path);
  if (config) {
    if (!config.info.isFile())
      refuse(path, "Strict profile config must be a regular generated file.");
    const document = parseDocument(await readFile(path, "utf8"), { uniqueKeys: true });
    if (document.errors.length) refuse(path, "Cannot validate strict skills configuration.");
    const dirs: unknown = document.toJS()?.skills?.external_dirs;
    const create: unknown = document.toJS()?.skills?.create_dir;
    if (dirs !== undefined && (!Array.isArray(dirs) || dirs.length))
      refuse(path, "Skillex-only profiles require skills.external_dirs: [].");
    if (!(await privateCreateDir(create, profile, options)))
      refuse(
        path,
        "Skillex-only profiles require skills.create_dir to be unset or inside the profile.",
      );
  }
  const optOut = await entry(join(profile.root, ".no-bundled-skills"));
  if (optOut && !optOut.info.isFile())
    refuse(optOut.path, "Bundled opt-out marker must be a regular file.");
  if (!optOut && (await entry(join(profile.root, ".skillex-only"))))
    refuse(
      join(profile.root, ".no-bundled-skills"),
      "Strict profile is missing its bundled opt-out marker.",
    );
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
