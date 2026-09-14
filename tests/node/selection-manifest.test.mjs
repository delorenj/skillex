import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  readSelectionManifest,
  SelectionManifestWriteError,
  withLock,
  writeSelectionManifest,
} from "@delorenj/skillex";

const moduleUrl = import.meta.resolve("@delorenj/skillex");

async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-selection-manifest-"));
  const scope = join(root, "project");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  const agents = join(scope, ".agents");
  const path = join(agents, "skills.json");
  const children = [];
  await mkdir(join(scope, ".git"), { recursive: true });
  await mkdir(home);
  await writeFile(join(scope, "README.md"), "Source manifests belong in this repository.\n");
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    scope,
    home,
    stateHome,
    agents,
    path,
    children,
    options: { home, stateHome, env: {} },
  };
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function seed(f, raw, mode = 0o640) {
  await mkdir(f.agents, { recursive: true });
  await writeFile(
    f.path,
    typeof raw === "string" || Buffer.isBuffer(raw) ? raw : JSON.stringify(raw),
    { mode },
  );
  await chmod(f.path, mode);
  return readSelectionManifest(f.scope);
}

function persist(f, previous, raw) {
  return withLock("skillex:activation:v2", () => writeSelectionManifest(previous, raw), f.options);
}

async function rejectedRead(promise, code, exit = 3) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.exit, exit);
    assert.equal(error.findings[0].code, code);
    assert.equal(typeof error.findings[0].fix, "string");
    return true;
  });
}

async function rejectedWrite(promise, code, { published = false, exit = 3 } = {}) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SelectionManifestWriteError);
    assert.equal(error.published, published);
    assert.equal(error.exit, exit);
    assert.equal(error.findings[0].code, code);
    assert.equal(typeof error.findings[0].fix, "string");
    return true;
  });
}

test("missing declarations are read-only plain snapshots with canonical scope roots", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "scope-alias");
  await symlink(f.scope, alias);
  const first = await readSelectionManifest(alias);
  assert.deepEqual(first, {
    root: f.scope,
    path: f.path,
    exists: false,
    raw: null,
    manifest: null,
  });
  assert.deepEqual(await readSelectionManifest(f.scope), first);
  await absent(f.agents);
  await absent(f.stateHome);
  assert.deepEqual((await readdir(f.scope)).sort(), [".git", "README.md"]);
});

test("existing .agents with no declaration is also a write-free read", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agents);
  await writeFile(join(f.agents, "config.json"), '{"unrelated":true}');
  const before = await lstat(f.agents, { bigint: true });
  const snapshot = await readSelectionManifest(f.scope);
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.raw, null);
  assert.equal((await lstat(f.agents, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.deepEqual(await readdir(f.agents), ["config.json"]);
  await absent(f.stateHome);
});

test("scope roots must exist and are never created by reads", async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, "missing-scope");
  await rejectedRead(readSelectionManifest(missing), "E_MANIFEST_ROOT");
  await absent(missing);
  await rejectedRead(readSelectionManifest(""), "E_MANIFEST_ROOT", 2);
});

test("creation writes a complete current manifest inside the source repository", async (t) => {
  const f = await fixture(t);
  const previous = await readSelectionManifest(f.scope);
  const raw = { scope: "project", inherit_global: true, skills: ["alpha"] };
  const written = await persist(f, previous, raw);
  assert.equal(written.exists, true);
  assert.deepEqual(written.raw, raw);
  assert.equal(written.manifest.path, f.path);
  assert.deepEqual(written.manifest.skills, [{ name: "alpha" }]);
  assert.equal(previous.exists, false);
  assert.equal((await lstat(f.path)).isFile(), true);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o644);
  assert.equal(await readFile(f.path, "utf8"), `${JSON.stringify(raw, null, 2)}\n`);
  assert.deepEqual(await readdir(f.agents), ["skills.json"]);
  assert.equal(
    await readFile(join(f.scope, "README.md"), "utf8"),
    "Source manifests belong in this repository.\n",
  );
});

test("updates preserve permissions and replace only the declaration inode", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] }, 0o640);
  const inode = (await lstat(f.path)).ino;
  const parent = (await lstat(f.agents)).ino;
  const written = await persist(f, previous, { skills: ["alpha", "beta"], exclude: ["gamma"] });
  assert.notEqual((await lstat(f.path)).ino, inode);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o640);
  assert.equal((await lstat(f.agents)).ino, parent);
  assert.deepEqual(written.raw, { skills: ["alpha", "beta"], exclude: ["gamma"] });
  assert.deepEqual(await readdir(f.agents), ["skills.json"]);
});

test("semantic no-ops preserve original bytes, mode, inode, and modification time", async (t) => {
  const f = await fixture(t);
  const bytes =
    '{ "sets": [ {"name":"general", "optional":false, "exclude":[]} ], "skills": [{"name":"alpha"}], "inherit_global":true }\r\n';
  const previous = await seed(f, bytes, 0o640);
  const before = await lstat(f.path, { bigint: true });
  const returned = await persist(f, previous, { skills: ["alpha"], sets: ["general"] });
  const after = await lstat(f.path, { bigint: true });
  assert.equal(await readFile(f.path, "utf8"), bytes);
  for (const field of ["dev", "ino", "mode", "mtimeNs"]) assert.equal(after[field], before[field]);
  assert.deepEqual(returned.raw, JSON.parse(bytes));
  assert.deepEqual(await readdir(f.agents), ["skills.json"]);
});

test("snapshot payload edits cannot falsify original bytes or no-op decisions", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] });
  const bytes = await readFile(f.path);
  const inode = (await lstat(f.path)).ino;
  previous.raw.skills.push("beta");
  previous.manifest.skills.push({ name: "gamma" });
  const returned = await persist(f, previous, { skills: ["alpha"] });
  assert.deepEqual(await readFile(f.path), bytes);
  assert.equal((await lstat(f.path)).ino, inode);
  assert.deepEqual(returned.raw, { skills: ["alpha"] });
});

test("foreign .agents assets and unrelated temporary-looking files survive updates", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, {});
  await mkdir(join(f.agents, "skills", "bmad"), { recursive: true });
  await writeFile(join(f.agents, "skills", "bmad", "SKILL.md"), "Installer-owned bytes.\n");
  await writeFile(join(f.agents, ".skillex-tmp-foreign"), "Foreign staging-like file.\n");
  const target = join(f.root, "external-support");
  await writeFile(target, "Support bytes.\n");
  await symlink(target, join(f.agents, ".skillex-tmp-unrelated-link"));
  await persist(f, previous, { skills: ["alpha"] });
  assert.equal(
    await readFile(join(f.agents, "skills", "bmad", "SKILL.md"), "utf8"),
    "Installer-owned bytes.\n",
  );
  assert.equal(
    await readFile(join(f.agents, ".skillex-tmp-foreign"), "utf8"),
    "Foreign staging-like file.\n",
  );
  assert.equal(await readlink(join(f.agents, ".skillex-tmp-unrelated-link")), target);
  assert.deepEqual((await readdir(f.agents)).sort(), [
    ".skillex-tmp-foreign",
    ".skillex-tmp-unrelated-link",
    "skills",
    "skills.json",
  ]);
});

test("reconstructed snapshots do not authorize writes", async (t) => {
  const f = await fixture(t);
  const previous = await readSelectionManifest(f.scope);
  await rejectedWrite(persist(f, { ...previous }, {}), "E_MANIFEST_CHANGED");
  await absent(f.agents);
});

test("invalid proposed declarations fail before creating .agents", async (t) => {
  const f = await fixture(t);
  const previous = await readSelectionManifest(f.scope);
  for (const [raw, code] of [
    [{ source: "legacy" }, "E_LEGACY_FIELD"],
    [{ packs: ["alpha", "beta"] }, "E_MANIFEST_INVALID"],
    [{ inherit_global: "yes" }, "E_MANIFEST_INVALID"],
    [{ skills: ["../outside"] }, "E_MANIFEST_INVALID"],
  ]) {
    await rejectedWrite(persist(f, previous, raw), code, { exit: 2 });
    await absent(f.agents);
  }
});

test("reads refuse malformed, legacy, and invalid UTF-8 declarations without changing them", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agents);
  for (const [bytes, code] of [
    [Buffer.from("{"), "E_MANIFEST_PARSE"],
    [Buffer.from("[]"), "E_MANIFEST_INVALID"],
    [Buffer.from('{"source":"legacy"}'), "E_LEGACY_FIELD"],
    [Buffer.from([0xff, 0x7b, 0x7d]), "E_INVALID_UTF8"],
  ]) {
    await writeFile(f.path, bytes);
    await rejectedRead(readSelectionManifest(f.scope), code, 2);
    assert.deepEqual(await readFile(f.path), bytes);
  }
});

test("symlinked or file-shaped .agents paths are refused without following them", async (t) => {
  const f = await fixture(t);
  const foreign = join(f.root, "foreign-agents");
  await mkdir(foreign);
  await writeFile(join(foreign, "skills.json"), "{}");
  await symlink(foreign, f.agents);
  await rejectedRead(readSelectionManifest(f.scope), "E_MANIFEST_UNSAFE_PATH");
  assert.equal(await readFile(join(foreign, "skills.json"), "utf8"), "{}");
  await unlink(f.agents);
  await writeFile(f.agents, "foreign file");
  await rejectedRead(readSelectionManifest(f.scope), "E_MANIFEST_UNSAFE_PATH");
  assert.equal(await readFile(f.agents, "utf8"), "foreign file");
});

test("symlinked and directory-shaped declaration entries are preserved", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agents);
  const target = join(f.root, "foreign.json");
  await writeFile(target, "{}");
  await symlink(target, f.path);
  await rejectedRead(readSelectionManifest(f.scope), "E_MANIFEST_UNSAFE_PATH");
  assert.equal(await readlink(f.path), target);
  await unlink(f.path);
  await mkdir(f.path);
  await rejectedRead(readSelectionManifest(f.scope), "E_MANIFEST_UNSAFE_PATH");
  assert.equal((await lstat(f.path)).isDirectory(), true);
});

test("a declaration appearing after an absence snapshot is never adopted or overwritten", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agents);
  const previous = await readSelectionManifest(f.scope);
  await writeFile(f.path, "{}");
  await rejectedWrite(persist(f, previous, {}), "E_MANIFEST_CHANGED");
  assert.equal(await readFile(f.path, "utf8"), "{}");
});

test("changed bytes refuse writes even when the declaration is still semantically equal", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] });
  const inode = (await lstat(f.path)).ino;
  const bytes = '{ "skills" : [ "alpha" ] }\n';
  await writeFile(f.path, bytes);
  assert.equal((await lstat(f.path)).ino, inode);
  await rejectedWrite(persist(f, previous, { skills: ["alpha"] }), "E_MANIFEST_CHANGED");
  assert.equal(await readFile(f.path, "utf8"), bytes);
});

test("identical bytes in another inode and concurrent mode changes lose snapshot authority", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] }, 0o640);
  const bytes = await readFile(f.path);
  await rename(f.path, join(f.root, "retained-original"));
  await writeFile(f.path, bytes, { mode: 0o640 });
  await rejectedWrite(persist(f, previous, { skills: ["beta"] }), "E_MANIFEST_CHANGED");
  const current = await readSelectionManifest(f.scope);
  await chmod(f.path, 0o600);
  await rejectedWrite(persist(f, current, { skills: ["beta"] }), "E_MANIFEST_CHANGED");
  assert.deepEqual(await readFile(f.path), bytes);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
});

test("replaced .agents and scope roots are detected before declaration writes", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] });
  const bytes = await readFile(f.path);
  await rename(f.agents, join(f.scope, "retained-agents"));
  await mkdir(f.agents);
  await writeFile(f.path, bytes, { mode: 0o640 });
  await rejectedWrite(persist(f, previous, { skills: ["beta"] }), "E_MANIFEST_CHANGED");
  const current = await readSelectionManifest(f.scope);
  await rename(f.scope, join(f.root, "retained-project"));
  await mkdir(f.agents, { recursive: true });
  await writeFile(f.path, bytes, { mode: 0o640 });
  await rejectedWrite(persist(f, current, { skills: ["beta"] }), "E_MANIFEST_CHANGED");
  assert.deepEqual(await readFile(f.path), bytes);
});

test("a new foreign .agents directory invalidates an earlier missing-parent snapshot", async (t) => {
  const f = await fixture(t);
  const previous = await readSelectionManifest(f.scope);
  await mkdir(f.agents);
  await writeFile(join(f.agents, "foreign.txt"), "Preserve me.\n");
  await rejectedWrite(persist(f, previous, {}), "E_MANIFEST_CHANGED");
  assert.deepEqual(await readdir(f.agents), ["foreign.txt"]);
  assert.equal(await readFile(join(f.agents, "foreign.txt"), "utf8"), "Preserve me.\n");
});

test("parent redirection after reading cannot write through a foreign symlink", async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] });
  const foreign = join(f.root, "foreign-agents");
  await mkdir(foreign);
  await writeFile(join(foreign, "skills.json"), "{}");
  await rename(f.agents, join(f.scope, "retained-agents"));
  await symlink(foreign, f.agents);
  await rejectedWrite(persist(f, previous, { skills: ["beta"] }), "E_MANIFEST_CHANGED");
  assert.equal(await readlink(f.agents), foreign);
  assert.equal(await readFile(join(foreign, "skills.json"), "utf8"), "{}");
});

test("read-only directories allow no-ops and report unpublished write failures", {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const f = await fixture(t);
  const previous = await seed(f, { skills: ["alpha"] }, 0o444);
  await chmod(f.agents, 0o500);
  try {
    const returned = await persist(f, previous, { skills: [{ name: "alpha" }] });
    assert.deepEqual(returned.raw, { skills: ["alpha"] });
    await rejectedWrite(persist(f, returned, { skills: ["beta"] }), "E_IO", { exit: 1 });
    assert.equal(await readFile(f.path, "utf8"), '{"skills":["alpha"]}');
    assert.deepEqual(await readdir(f.agents), ["skills.json"]);
  } finally {
    await chmod(f.agents, 0o755);
  }
});

for (const existing of [false, true]) {
  test(`durability failures report saved intent after ${existing ? "replacement" : "first publication"}`, {
    skip: process.getuid?.() === 0,
  }, async (t) => {
    const f = await fixture(t);
    if (existing) await seed(f, { skills: ["alpha"] });
    else await mkdir(f.agents);
    await chmod(f.agents, 0o300);
    try {
      const previous = await readSelectionManifest(f.scope);
      await rejectedWrite(persist(f, previous, { skills: ["beta"] }), "E_IO", {
        published: true,
        exit: 1,
      });
      assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { skills: ["beta"] });
    } finally {
      await chmod(f.agents, 0o755);
    }
    assert.deepEqual(await readdir(f.agents), ["skills.json"]);
  });
}

test("a prepublication failure removes only the newly created empty .agents directory", {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const f = await fixture(t);
  await chmod(f.scope, 0o300);
  try {
    const previous = await readSelectionManifest(f.scope);
    await rejectedWrite(persist(f, previous, { skills: ["alpha"] }), "E_IO", { exit: 1 });
    await absent(f.agents);
  } finally {
    await chmod(f.scope, 0o755);
  }
  assert.deepEqual((await readdir(f.scope)).sort(), [".git", "README.md"]);
});

test("readers observe complete source declarations during child-process atomic updates", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const names = (sequence) =>
    Array.from({ length: 200 }, (_, index) => `step-${sequence}-${index}`);
  await seed(f, { skills: names(0) });
  const source = `
    import { readSelectionManifest, writeSelectionManifest, withLock } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.argv[1]);
    for (let sequence = 1; sequence <= 24; sequence++) {
      await withLock('skillex:activation:v2', async () => {
        const previous = await readSelectionManifest(input.scope);
        await writeSelectionManifest(previous, {skills:Array.from({length:200},(_,index)=>'step-'+sequence+'-'+index)});
      }, input.options);
    }
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      JSON.stringify({ scope: f.scope, options: f.options }),
    ],
    { cwd: f.scope, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let done = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      done = true;
      resolve(code);
    });
  });
  f.children.push(child);
  let observations = 0;
  while (!done) {
    const raw = JSON.parse(await readFile(f.path, "utf8"));
    const sequence = Number(raw.skills[0].split("-")[1]);
    assert.ok(sequence >= 0 && sequence <= 24);
    assert.deepEqual(raw.skills, names(sequence));
    observations++;
    await delay(1);
  }
  assert.equal(await child.exited, 0, output);
  assert.equal(output, "");
  assert.ok(observations > 1);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).skills, names(24));
  assert.deepEqual(await readdir(f.agents), ["skills.json"]);
});
