import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fail, SkillexError } from "./error.js";
import type {
  HermesRootSelection,
  ProfileDiscovery,
  ProfileLocation,
  ProfileOptions,
} from "./profile-types.js";
import { type Diagnostic, ExitCode } from "./result.js";

const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Identity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly link: string | null;
}

interface Evidence {
  readonly profilePath: string;
  readonly profileRoot: string;
  readonly parents: ReadonlyMap<string, Identity>;
}

const identities = new WeakMap<ProfileLocation, Evidence>();
const rootIdentities = new WeakMap<HermesRootSelection, ReadonlyMap<string, Identity>>();

export function validateProfileName(name: string): void {
  if (typeof name !== "string" || !namePattern.test(name))
    fail(
      "E_PROFILE_NAME",
      "Profile names must be 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.",
      {
        name: typeof name === "string" ? name : String(name),
        fix: "Choose default or a named Hermes profile shown by skillex profile list.",
      },
    );
}

export function checkProfileSignal(options: Pick<ProfileOptions, "signal">): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Profile observation was interrupted.",
      {
        fix: "Retry the explicit profile command to obtain a complete observation.",
      },
      ExitCode.INTERRUPTED,
    );
}

function rootPath(value: unknown, cwd: string, home: string, setting = "Hermes root"): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    fail("E_HERMES_ROOT", `The ${setting} must be a nonempty filesystem path.`, {
      fix:
        setting === "Hermes root"
          ? "Pass --hermes-root PATH or set HERMES_HOME to the intended Hermes installation root."
          : `Set the profile ${setting} option to its intended local directory.`,
    });
  return resolve(
    cwd,
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}

/** Keep discovery, selection and receipt context on the same expanded home/cwd. */
export function normalizeProfileOptions(
  options: ProfileOptions = {},
): ProfileOptions & { readonly home: string; readonly cwd: string } {
  const actualHome = homedir();
  const home = rootPath(options.home ?? actualHome, process.cwd(), actualHome, "home");
  const cwd = rootPath(options.cwd ?? process.cwd(), process.cwd(), home, "cwd");
  return { ...options, home, cwd };
}

function io(error: unknown, path: string): never {
  if (error instanceof SkillexError) throw error;
  fail(
    "E_IO",
    "The profile path could not be inspected.",
    {
      path,
      detail: [error instanceof Error ? error.message : String(error)],
      fix: "Check the selected profile path and its read permissions, then retry.",
    },
    ExitCode.FAILURE,
  );
}

async function inspect(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    io(error, path);
  }
}

function changed(path: string): never {
  fail(
    "E_PROFILE_CHANGED",
    "The selected Hermes profile or one of its root paths changed identity.",
    {
      path,
      fix: "Retry after the other profile writer has finished; existing profile content is preserved.",
    },
    ExitCode.REFUSED,
  );
}

async function identity(path: string): Promise<Identity> {
  const info = await inspect(path);
  if (!info || (!info.isDirectory() && !info.isSymbolicLink())) changed(path);
  let link: string | null = null;
  if (info.isSymbolicLink()) {
    try {
      link = await readlink(path);
    } catch (error) {
      io(error, path);
    }
  }
  return { path, dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, link };
}

function same(before: Identity, after: Identity): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.link === after.link
  );
}

async function captureParents(path: string, parents: Map<string, Identity>): Promise<void> {
  const paths: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    paths.push(current);
    if (current === dirname(current)) break;
  }
  for (const entry of paths.reverse()) {
    const current = await identity(entry);
    const prior = parents.get(entry);
    if (prior && !same(prior, current)) changed(entry);
    parents.set(entry, current);
  }
}

async function assertParents(parents: ReadonlyMap<string, Identity>): Promise<void> {
  for (const [path, before] of parents) if (!same(before, await identity(path))) changed(path);
}

async function canonicalDirectory(path: string, root: boolean): Promise<string> {
  try {
    const target = await realpath(path);
    if (!(await lstat(target)).isDirectory()) {
      fail(
        root ? "E_HERMES_ROOT" : "E_PROFILE_ROOT",
        "The selected profile root is not a directory.",
        {
          path,
          fix: "Restore a Hermes profile directory or select its valid root; profile roots may be directory symlinks.",
        },
        root ? ExitCode.CONFIG : ExitCode.REFUSED,
      );
    }
    return target;
  } catch (error) {
    if (error instanceof SkillexError) throw error;
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      fail(
        root ? "E_HERMES_ROOT" : "E_PROFILE_ROOT",
        "The selected profile root does not resolve to a real directory.",
        {
          path,
          fix: "Repair the dangling, cyclic or non-directory root before selecting this profile.",
        },
        root ? ExitCode.CONFIG : ExitCode.REFUSED,
      );
    io(error, path);
  }
}

/** Hermes treats HERMES_HOME beneath profiles/NAME as a profile, before resolving its symlink. */
export async function discoverProfileRoot(
  options: ProfileOptions = {},
): Promise<HermesRootSelection> {
  checkProfileSignal(options);
  const { home, cwd } = normalizeProfileOptions(options);
  const env = options.env ?? process.env;
  const explicit = options.hermesRoot !== undefined;
  const fromEnvironment = !explicit && !!env.HERMES_HOME;
  let path = rootPath(
    explicit ? options.hermesRoot : fromEnvironment ? env.HERMES_HOME : join(home, ".hermes"),
    cwd,
    home,
  );
  if (fromEnvironment && basename(dirname(path)) === "profiles") path = dirname(dirname(path));
  const selection: HermesRootSelection = {
    path,
    root: null,
    source: explicit ? "argument" : fromEnvironment ? "environment" : "default",
  };
  const info = await inspect(path);
  if (!info) {
    if (selection.source !== "default")
      fail("E_HERMES_ROOT", "The selected Hermes root does not exist.", {
        path,
        fix: "Choose an existing Hermes root; explicit and environment roots never fall through to another installation.",
      });
    return selection;
  }
  const root = await canonicalDirectory(path, true);
  const parents = new Map<string, Identity>();
  await captureParents(path, parents);
  await captureParents(root, parents);
  await assertParents(parents);
  if ((await canonicalDirectory(path, true)) !== root) changed(path);
  const selected: HermesRootSelection = { ...selection, root };
  rootIdentities.set(selected, parents);
  checkProfileSignal(options);
  return selected;
}

async function observeSkills(path: string): Promise<ProfileLocation["skills"]> {
  const info = await inspect(path);
  if (!info) return { kind: "missing", rawTarget: null, target: null };
  if (!info.isSymbolicLink())
    return {
      kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      rawTarget: null,
      target: null,
    };
  let rawTarget: string;
  try {
    rawTarget = await readlink(path);
  } catch (error) {
    io(error, path);
  }
  let target: string | null = null;
  try {
    target = await realpath(path);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      io(error, path);
  }
  return { kind: "symlink", rawTarget, target };
}

async function locateProfile(
  name: string,
  hermesRoot: HermesRootSelection,
): Promise<ProfileLocation> {
  const path = name === "default" ? hermesRoot.path : join(hermesRoot.path, "profiles", name);
  const info = await inspect(path);
  if (!info)
    fail("E_PROFILE_NOT_FOUND", `No Hermes profile named ${name} exists at the selected root.`, {
      path,
      name,
      fix: "Create the profile through Hermes or select an existing name from skillex profile list.",
    });
  const root = await canonicalDirectory(path, false);
  const parents = new Map(rootIdentities.get(hermesRoot));
  await captureParents(path, parents);
  await captureParents(root, parents);
  const skillsRoot = join(root, "skills");
  const location: ProfileLocation = {
    name,
    path,
    root,
    skillsRoot,
    rootSymlink: info.isSymbolicLink(),
    skills: await observeSkills(skillsRoot),
  };
  identities.set(location, { profilePath: path, profileRoot: root, parents });
  await assertProfileIdentity(location);
  return location;
}

export async function discoverProfile(
  name: string,
  options: ProfileOptions = {},
): Promise<ProfileLocation> {
  validateProfileName(name);
  const root = await discoverProfileRoot(options);
  const profile = await locateProfile(name, root);
  checkProfileSignal(options);
  return profile;
}

/** Discovery reads no profile configuration, skill content, sticky selection or project manifest. */
export async function discoverProfiles(options: ProfileOptions = {}): Promise<ProfileDiscovery> {
  const hermesRoot = await discoverProfileRoot(options);
  const findings: Diagnostic[] = [];
  if (hermesRoot.root === null) return { hermesRoot, profiles: [], findings };
  const profiles = [await locateProfile("default", hermesRoot)];
  const directory = join(hermesRoot.path, "profiles");
  const info = await inspect(directory);
  if (!info) return { hermesRoot, profiles, findings };
  await canonicalDirectory(directory, false);
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.name !== "default" &&
          namePattern.test(entry.name) &&
          (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    io(error, directory);
  }
  for (const name of names) {
    checkProfileSignal(options);
    try {
      profiles.push(await locateProfile(name, hermesRoot));
    } catch (error) {
      if (
        !(error instanceof SkillexError) ||
        error.findings.some(
          (finding) => !["E_PROFILE_ROOT", "E_PROFILE_NOT_FOUND"].includes(finding.code),
        )
      )
        throw error;
      findings.push(...error.findings);
    }
  }
  for (const profile of profiles) await assertProfileIdentity(profile);
  return { hermesRoot, profiles, findings };
}

/** Guard root identity across planning and mutation; child changes are guarded by the applicator. */
export async function assertProfileIdentity(profile: ProfileLocation): Promise<void> {
  const evidence = identities.get(profile);
  if (!evidence) changed(profile.path);
  await assertParents(evidence.parents);
  if ((await canonicalDirectory(evidence.profilePath, false)) !== evidence.profileRoot)
    changed(evidence.profilePath);
}
