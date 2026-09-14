import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { listProfiles, showProfile } from "@delorenj/skillex";

const execute = promisify(execFile);

async function file(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-profile-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const hermes = join(home, ".hermes");
  const stateHome = join(root, "state");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  return {
    root,
    home,
    cwd,
    hermes,
    stateHome,
    options: { home, cwd, stateHome, env: {} },
  };
}

async function profile(f, name = "default", skills = true, hermes = f.hermes) {
  const path = name === "default" ? hermes : join(hermes, "profiles", name);
  await mkdir(skills ? join(path, "skills") : path, { recursive: true });
  return path;
}

function resultIs(result, exit, command, code) {
  assert.equal(result.schema, 2);
  assert.equal(result.command, command);
  assert.equal(result.exit, exit, JSON.stringify(result));
  if (code) {
    const finding = result.findings.find((item) => item.code === code);
    assert.ok(finding, `${code}: ${JSON.stringify(result)}`);
    assert.ok(finding.fix);
  }
  return result.data;
}

async function snapshot(root) {
  const result = [];
  const visit = async (path) => {
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
    result.push([
      relative(root, path),
      kind,
      info.ino,
      info.mode,
      info.mtimeMs,
      kind === "symlink"
        ? await readlink(path)
        : kind === "file"
          ? (await readFile(path)).toString("hex")
          : "",
    ]);
    if (kind === "directory")
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root);
  return result;
}

test("missing default Hermes installation lists no profiles and creates no state", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const data = resultIs(await listProfiles(f.options), 0, "profile list");
  assert.deepEqual(data.hermesRoot, { path: f.hermes, root: null, source: "default" });
  assert.deepEqual(data.profiles, []);
  resultIs(await showProfile("default", f.options), 2, "profile show", "E_PROFILE_NOT_FOUND");
  assert.deepEqual(await snapshot(f.root), before);
});

test("list exposes the default and valid named profile directories in stable order", async (t) => {
  const f = await fixture(t);
  await profile(f, "zeta");
  await profile(f, "alpha");
  await profile(f, "default");
  await profile(f, "BadName");
  await profile(f, ".hidden");
  await profile(f, "-invalid");
  await mkdir(join(f.hermes, "profiles", "default"));
  await file(join(f.hermes, "profiles", "notes"), "This is a file, not a profile.\n");
  const before = await snapshot(f.root);
  const data = resultIs(await listProfiles(f.options), 0, "profile list");
  assert.deepEqual(
    data.profiles.map(({ profile }) => profile.name),
    ["default", "alpha", "zeta"],
  );
  assert.equal(data.hermesRoot.root, f.hermes);
  for (const row of data.profiles) {
    assert.equal(row.projection, "unmanaged");
    assert.equal(row.project, null);
    assert.equal(row.counts.managed, 0);
    assert.equal(row.profile.skills.kind, "directory");
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("a real profile with missing skills is visible without creating the directory", async (t) => {
  const f = await fixture(t);
  const path = await profile(f, "empty", false);
  const before = await snapshot(f.root);
  const data = resultIs(await showProfile("empty", f.options), 0, "profile show");
  assert.deepEqual(data.profile, {
    name: "empty",
    path,
    root: path,
    skillsRoot: join(path, "skills"),
    rootSymlink: false,
    skills: { kind: "missing", rawTarget: null, target: null },
  });
  assert.equal(data.project, null);
  assert.equal(data.managed, null);
  assert.deepEqual(data.changes, []);
  assert.deepEqual(await snapshot(f.root), before);
});

test("list and show ignore ambient project, sticky selection and profile configuration content", async (t) => {
  const f = await fixture(t);
  await profile(f, "alpha");
  await profile(f, "beta");
  await file(join(f.cwd, ".agents", "skills.json"), "{invalid manifest\n");
  await file(join(f.home, ".agents", "skills.json"), "{also invalid\n");
  await file(join(f.hermes, "active_profile"), Buffer.from([0xff, 0xfe]));
  await file(join(f.hermes, "config.yaml"), "not: [valid\n");
  await file(join(f.hermes, "profiles", "alpha", "config.yaml"), "not: [valid\n");
  const options = {
    ...f.options,
    registryRoot: join(f.root, "missing-catalog"),
    env: {
      HERMES_PROFILE: "beta",
      HERMES_ACTIVE_PROFILE: "beta",
      HERMES_PROFILES_DIR: join(f.root, "invented"),
    },
  };
  const before = await snapshot(f.root);
  const data = resultIs(await showProfile("alpha", options), 0, "profile show");
  assert.equal(data.profile.name, "alpha");
  assert.equal(data.project, null);
  assert.equal(data.managed, null);
  assert.deepEqual(data.changes, []);
  const listed = resultIs(await listProfiles(options), 0, "profile list");
  assert.deepEqual(
    listed.profiles.map(({ profile }) => profile.name),
    ["default", "alpha", "beta"],
  );
  assert.deepEqual(await snapshot(f.root), before);
});

test("explicit Hermes root wins over HERMES_HOME without activating the ambient profile", async (t) => {
  const f = await fixture(t);
  await profile(f, "wrong");
  const alternate = join(f.root, "alternate");
  const expected = await profile(f, "chosen", true, alternate);
  const options = {
    ...f.options,
    hermesRoot: alternate,
    env: { HERMES_HOME: join(f.hermes, "profiles", "wrong") },
  };
  const listed = resultIs(await listProfiles(options), 0, "profile list");
  assert.deepEqual(listed.hermesRoot, { path: alternate, root: alternate, source: "argument" });
  const shown = resultIs(await showProfile("chosen", options), 0, "profile show");
  assert.equal(shown.profile.path, expected);
  resultIs(await showProfile("wrong", options), 2, "profile show", "E_PROFILE_NOT_FOUND");
});

test("Hermes root overrides expand home and cwd-relative paths", async (t) => {
  const f = await fixture(t);
  const relativeRoot = join(f.cwd, "hermes-root");
  await profile(f, "relative", true, relativeRoot);
  const data = resultIs(
    await listProfiles({ ...f.options, hermesRoot: "hermes-root" }),
    0,
    "profile list",
  );
  assert.equal(data.hermesRoot.path, relativeRoot);
  await profile(f, "expanded");
  const expanded = resultIs(
    await listProfiles({ ...f.options, hermesRoot: "~/.hermes" }),
    0,
    "profile list",
  );
  assert.equal(expanded.hermesRoot.root, f.hermes);
});

test("programmatic home and cwd expand tilde consistently in an isolated child environment", async (t) => {
  const f = await fixture(t);
  const selectedHome = join(f.root, "selected-home");
  const actualRoot = join(f.home, "workspace", "hermes");
  const selectedRoot = join(selectedHome, "workspace", "hermes");
  await profile(f, "actual", true, actualRoot);
  await profile(f, "selected", true, selectedRoot);
  const before = await snapshot(f.root);
  const script = `import {listProfiles} from '@delorenj/skillex';
const roots=JSON.parse(process.argv[1]);
const results=[];
for(const home of roots) results.push(await listProfiles({home,cwd:'~/workspace/project',hermesRoot:'../hermes',env:{}}));
process.stdout.write(JSON.stringify(results));`;
  const child = await execute(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(["~", selectedHome])],
    {
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(child.stderr, "");
  const results = JSON.parse(child.stdout);
  for (const [index, expectedHome, expectedRoot, name] of [
    [0, f.home, actualRoot, "actual"],
    [1, selectedHome, selectedRoot, "selected"],
  ]) {
    const data = resultIs(results[index], 0, "profile list");
    assert.equal(data.hermesRoot.path, expectedRoot);
    const summary = data.profiles.find(({ profile }) => profile.name === name);
    assert.ok(summary);
    assert.ok(summary.receiptPath.startsWith(`${join(expectedHome, ".local", "state")}/`));
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("HERMES_HOME profile suffix is stripped lexically before resolving a profile symlink", async (t) => {
  const f = await fixture(t);
  const profileTarget = join(f.root, "independent-agent");
  await mkdir(join(profileTarget, "skills"), { recursive: true });
  await mkdir(join(f.hermes, "profiles"), { recursive: true });
  const lexical = join(f.hermes, "profiles", "alpha");
  await symlink(profileTarget, lexical);
  const beta = await profile(f, "beta");
  const options = { ...f.options, env: { HERMES_HOME: `${lexical}/` } };
  const listed = resultIs(await listProfiles(options), 0, "profile list");
  assert.deepEqual(listed.hermesRoot, { path: f.hermes, root: f.hermes, source: "environment" });
  const data = resultIs(await showProfile("beta", options), 0, "profile show");
  assert.equal(data.profile.root, beta);
  const linked = resultIs(await showProfile("alpha", options), 0, "profile show");
  assert.equal(linked.profile.path, lexical);
  assert.equal(linked.profile.root, profileTarget);
  assert.equal(linked.profile.skillsRoot, join(profileTarget, "skills"));
  assert.equal(linked.profile.rootSymlink, true);
});

test("HERMES_HOME can name the installation root and empty HERMES_HOME uses the default", async (t) => {
  const f = await fixture(t);
  await profile(f);
  const alternate = join(f.root, "alternate");
  await profile(f, "alternate", true, alternate);
  const environment = resultIs(
    await listProfiles({ ...f.options, env: { HERMES_HOME: alternate } }),
    0,
    "profile list",
  );
  assert.equal(environment.hermesRoot.root, alternate);
  assert.equal(environment.hermesRoot.source, "environment");
  const empty = resultIs(
    await listProfiles({ ...f.options, env: { HERMES_HOME: "" } }),
    0,
    "profile list",
  );
  assert.equal(empty.hermesRoot.root, f.hermes);
  assert.equal(empty.hermesRoot.source, "default");
});

test("explicit empty, missing and non-directory Hermes roots refuse instead of falling through", async (t) => {
  const f = await fixture(t);
  await profile(f);
  const nonDirectory = join(f.root, "file");
  await file(nonDirectory, "not a root\n");
  const before = await snapshot(f.root);
  for (const hermesRoot of ["", join(f.root, "missing"), nonDirectory]) {
    resultIs(
      await listProfiles({ ...f.options, hermesRoot, env: { HERMES_HOME: f.hermes } }),
      2,
      "profile list",
      "E_HERMES_ROOT",
    );
  }
  resultIs(
    await listProfiles({ ...f.options, env: { HERMES_HOME: join(f.root, "missing") } }),
    2,
    "profile list",
    "E_HERMES_ROOT",
  );
  assert.deepEqual(await snapshot(f.root), before);
});

test("Hermes installation aliases retain their lexical selector and canonical target", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "actual-hermes");
  const named = await profile(f, "alpha", true, target);
  await symlink(target, f.hermes);
  const before = await snapshot(f.root);
  const listed = resultIs(await listProfiles(f.options), 0, "profile list");
  assert.deepEqual(listed.hermesRoot, { path: f.hermes, root: target, source: "default" });
  const defaultProfile = listed.profiles.find(({ profile }) => profile.name === "default").profile;
  assert.equal(defaultProfile.rootSymlink, true);
  assert.equal(defaultProfile.path, f.hermes);
  assert.equal(defaultProfile.root, target);
  const shown = resultIs(await showProfile("alpha", f.options), 0, "profile show");
  assert.equal(shown.profile.path, join(f.hermes, "profiles", "alpha"));
  assert.equal(shown.profile.root, named);
  assert.deepEqual(await snapshot(f.root), before);
});

for (const name of [
  "",
  "../outside",
  "/absolute",
  "UPPER",
  "_prefix",
  "-prefix",
  "dot.name",
  "space name",
  "a".repeat(65),
])
  test(`profile name ${JSON.stringify(name)} is rejected before filesystem selection`, async (t) => {
    const f = await fixture(t);
    const before = await snapshot(f.root);
    resultIs(
      await showProfile(name, { ...f.options, hermesRoot: "" }),
      2,
      "profile show",
      "E_PROFILE_NAME",
    );
    assert.deepEqual(await snapshot(f.root), before);
  });

test("maximum-length and digit-starting profile names are accepted", async (t) => {
  const f = await fixture(t);
  for (const name of ["a".repeat(64), "1", "a_b-c"]) {
    const path = await profile(f, name);
    const data = resultIs(await showProfile(name, f.options), 0, "profile show");
    assert.equal(data.profile.root, path);
  }
});

test("an explicit missing named profile never falls back to the default", async (t) => {
  const f = await fixture(t);
  await profile(f);
  const before = await snapshot(f.root);
  resultIs(await showProfile("missing", f.options), 2, "profile show", "E_PROFILE_NOT_FOUND");
  assert.deepEqual(await snapshot(f.root), before);
});

test("one broken named profile does not hide healthy profiles from the list", async (t) => {
  const f = await fixture(t);
  await profile(f, "healthy");
  const broken = join(f.hermes, "profiles", "broken");
  await symlink(join(f.root, "missing-profile-target"), broken);
  const before = await snapshot(f.root);
  const result = await listProfiles(f.options);
  const data = resultIs(result, 3, "profile list", "E_PROFILE_ROOT");
  assert.deepEqual(
    data.profiles.map(({ profile }) => profile.name),
    ["default", "healthy"],
  );
  assert.equal(result.findings.find(({ code }) => code === "E_PROFILE_ROOT").path, broken);
  assert.deepEqual(await snapshot(f.root), before);
});

test("profile-root files and dangling or cyclic aliases produce actionable invariant errors", async (t) => {
  const f = await fixture(t);
  await profile(f);
  const path = join(f.hermes, "profiles", "invalid");
  await file(path, "not a profile\n");
  resultIs(await showProfile("invalid", f.options), 3, "profile show", "E_PROFILE_ROOT");
  await rm(path);
  await symlink(join(f.root, "missing-target"), path);
  resultIs(await showProfile("invalid", f.options), 3, "profile show", "E_PROFILE_ROOT");
  await rm(path);
  await symlink("invalid", path);
  resultIs(await showProfile("invalid", f.options), 3, "profile show", "E_PROFILE_ROOT");
});

test("a whole-skills alias remains visible for migration and its content is not traversed", async (t) => {
  const f = await fixture(t);
  const path = await profile(f, "legacy", false);
  const target = join(f.root, "legacy-root");
  await file(join(target, "alpha", "SKILL.md"), Buffer.from([0xff, 0xfe]));
  await symlink(target, join(path, "skills"));
  const before = await snapshot(f.root);
  const data = resultIs(
    await showProfile("legacy", f.options),
    3,
    "profile show",
    "E_PROFILE_SKILLS_ROOT",
  );
  assert.deepEqual(data.profile.skills, { kind: "symlink", rawTarget: target, target });
  assert.deepEqual(data.preserved, []);
  assert.equal(data.managed, null);
  assert.deepEqual(await snapshot(f.root), before);
});

test("dangling and cyclic skills aliases are observable without resolving their contents", async (t) => {
  const f = await fixture(t);
  const path = await profile(f, "legacy", false);
  const skills = join(path, "skills");
  for (const target of ["missing", "skills"]) {
    await symlink(target, skills);
    const before = await snapshot(f.root);
    const data = resultIs(
      await showProfile("legacy", f.options),
      3,
      "profile show",
      "E_PROFILE_SKILLS_ROOT",
    );
    assert.deepEqual(data.profile.skills, { kind: "symlink", rawTarget: target, target: null });
    assert.deepEqual(await snapshot(f.root), before);
    await rm(skills);
  }
});

test("a skills-root file is reported without interpreting it as a directory", async (t) => {
  const f = await fixture(t);
  const path = await profile(f, "legacy", false);
  await file(join(path, "skills"), "Runtime-owned file\n");
  const before = await snapshot(f.root);
  const data = resultIs(
    await showProfile("legacy", f.options),
    3,
    "profile show",
    "E_PROFILE_SKILLS_ROOT",
  );
  assert.equal(data.profile.skills.kind, "file");
  assert.deepEqual(data.preserved, []);
  assert.deepEqual(await snapshot(f.root), before);
});

test("profile-owned files, directories and links are observed without reading skill bytes", async (t) => {
  const f = await fixture(t);
  const path = await profile(f, "local");
  await file(join(path, "skills", "alpha", "SKILL.md"), Buffer.from([0xff, 0xfe]));
  await file(join(path, "skills", "runtime.json"), "Not parsed JSON\n");
  await file(join(path, "skills", ".overlay", "session.txt"), "Profile-owned state\n");
  await symlink("alpha", join(path, "skills", "alias"));
  await symlink("absent", join(path, "skills", "dangling"));
  const before = await snapshot(f.root);
  const data = resultIs(await showProfile("local", f.options), 0, "profile show");
  assert.deepEqual(data.preserved.map(({ name }) => name).sort(), [
    ".overlay",
    "alias",
    "alpha",
    "dangling",
    "runtime.json",
  ]);
  assert.ok(data.preserved.every(({ shadows }) => shadows === false));
  assert.equal(data.preserved.find(({ name }) => name === "alias").kind, "symlink");
  assert.equal(data.preserved.find(({ name }) => name === "dangling").target, null);
  assert.deepEqual(await snapshot(f.root), before);
});

test("read commands surface unreadable profile roots as IO failures rather than absence", {
  skip: process.getuid?.() === 0 ? "root can read mode-zero directories" : false,
}, async (t) => {
  const f = await fixture(t);
  const path = await profile(f, "private");
  await chmod(path, 0);
  try {
    resultIs(await showProfile("private", f.options), 1, "profile show", "E_IO");
  } finally {
    await chmod(path, 0o700);
  }
});

test("pre-aborted profile reads do not create or modify profile/state paths", async (t) => {
  const f = await fixture(t);
  await profile(f);
  const before = await snapshot(f.root);
  const options = { ...f.options, signal: { aborted: true } };
  resultIs(await listProfiles(options), 130, "profile list", "E_INTERRUPTED");
  resultIs(await showProfile("default", options), 130, "profile show", "E_INTERRUPTED");
  assert.deepEqual(await snapshot(f.root), before);
});
