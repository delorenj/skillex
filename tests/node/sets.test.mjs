import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { addSetSkills, createSet, listSets, removeSetSkills, showSet } from "@delorenj/skillex";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-sets-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  const options = {
    registryRoot: registry,
    home: root,
    cwd: root,
    env: {},
    stateHome,
    timeoutMs: 10_000,
  };
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  function file(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }
  function skill(name) {
    const path = join(registry, "all-skills", name);
    file(join(path, "SKILL.md"), `# ${name}\n`);
    return path;
  }
  function link(path, target) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), target), path);
    return path;
  }
  return { root, registry, options, stateHome, file, skill, link };
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.mode,
      info.mtimeMs,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return rows;
}

function ok(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.ok(result.data);
  return result.data;
}

function refused(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((finding) => finding.code === code && finding.fix && finding.path),
    JSON.stringify(result.findings),
  );
}

it("creates and edits sets with canonical links and idempotent membership", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  assert.deepEqual(ok(await listSets(f.options)).sets, []);
  const created = ok(await createSet("Daily_Work", f.options));
  const path = join(f.registry, "sets", "Daily_Work");
  assert.deepEqual(created.composition, { kind: "set", name: "Daily_Work", path, skills: [] });
  assert.equal(created.dryRun, false);
  assert.deepEqual(
    created.changes.map((change) => change.action),
    ["create-directory", "create-directory"],
  );
  f.file(join(path, "hooks", "run.sh"), "#!/bin/sh\nprintf done\n");
  f.file(join(path, "README.md"), "Set support\n");
  const added = ok(await addSetSkills("Daily_Work", ["beta", "alpha", "beta"], f.options));
  assert.deepEqual(added.composition.skills, [
    { name: "alpha", path: alpha },
    { name: "beta", path: beta },
  ]);
  assert.deepEqual(
    added.changes.map((change) => change.action),
    ["create-link", "create-link"],
  );
  assert.equal(realpathSync(join(path, "alpha")), alpha);
  assert.equal(realpathSync(join(path, "beta")), beta);
  const before = snapshot(f.root);
  assert.deepEqual(ok(await createSet("Daily_Work", f.options)).changes, []);
  assert.deepEqual(ok(await addSetSkills("Daily_Work", ["alpha", "beta"], f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), before);
  assert.deepEqual(ok(await showSet("Daily_Work", f.options)).set, added.composition);
  assert.deepEqual(ok(await listSets(f.options)).sets, [added.composition]);
  ok(await removeSetSkills("Daily_Work", ["alpha"], f.options));
  assert.equal(existsSync(join(path, "alpha")), false);
  assert.equal(readFileSync(join(path, "hooks", "run.sh"), "utf8"), "#!/bin/sh\nprintf done\n");
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), "Set support\n");
  const removed = snapshot(f.root);
  assert.deepEqual(ok(await removeSetSkills("Daily_Work", ["alpha"], f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), removed);
});

it("set read, create, add, and remove dry-runs preserve every fixture entry and leave state absent", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  const path = join(f.registry, "sets", "existing");
  f.link(join(path, "alpha"), join(f.registry, "all-skills", "alpha"));
  const before = snapshot(f.root);
  ok(await listSets(f.options));
  ok(await showSet("existing", f.options));
  for (const result of [
    await createSet("new-set", { ...f.options, dryRun: true }),
    await addSetSkills("existing", ["beta"], { ...f.options, dryRun: true }),
    await removeSetSkills("existing", ["alpha"], { ...f.options, dryRun: true }),
  ]) {
    const data = ok(result);
    assert.equal(data.dryRun, true);
    assert.ok(data.changes.length > 0);
  }
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("preflights every requested skill and refuses unknown names without a lock or any writes", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.file(join(f.registry, "sets", "work", "README.md"), "preserve\n");
  const before = snapshot(f.root);
  refused(await addSetSkills("work", ["alpha", "missing"], f.options), "E_SKILL_MISSING");
  refused(await removeSetSkills("work", ["missing"], f.options), "E_SKILL_MISSING");
  refused(await addSetSkills("work", ["../escape"], f.options), "E_MANIFEST_INVALID", 2);
  refused(await createSet("../escape", f.options), "E_MANIFEST_INVALID", 2);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

for (const shape of ["file", "directory", "wrong-link", "dangling-link"]) {
  it(`refuses conflicting set ${shape} content before valid additions`, async (t) => {
    const f = fixture(t);
    f.skill("alpha");
    const beta = f.skill("beta");
    const path = join(f.registry, "sets", "work", "alpha");
    if (shape === "file") f.file(path, "foreign\n");
    else if (shape === "directory") f.file(join(path, "support.txt"), "foreign\n");
    else f.link(path, shape === "wrong-link" ? beta : join(f.root, "absent"));
    const before = snapshot(f.root);
    const result = await addSetSkills("work", ["beta", "alpha"], f.options);
    assert.equal(result.exit, 3, JSON.stringify(result.findings));
    assert.ok(result.findings.every((finding) => finding.path && finding.fix));
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(existsSync(f.stateHome), false);
  });
}

it("rejects nested embedded definitions and symlinked set roots, including idempotent create", async (t) => {
  const f = fixture(t);
  f.file(join(f.registry, "sets", "embedded", "support", "nested", "SKILL.md"), "# forbidden\n");
  f.link(join(f.registry, "sets", "linked"), join(f.registry, "sets", "embedded"));
  const before = snapshot(f.root);
  for (const name of ["embedded", "linked"]) {
    refused(await createSet(name, f.options), "E_NONCANONICAL_REFERENCE");
    refused(await showSet(name, f.options), "E_NONCANONICAL_REFERENCE");
  }
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("lists valid sets in stable order and retains unrelated validation failures", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.link(join(f.registry, "sets", "zebra", "alpha"), alpha);
  f.link(join(f.registry, "sets", "alpha", "alpha"), alpha);
  f.link(join(f.registry, "sets", "broken", "alpha"), join(f.root, "missing"));
  const before = snapshot(f.root);
  const result = await listSets(f.options);
  assert.equal(result.exit, 4);
  assert.deepEqual(
    result.data.sets.map((set) => set.name),
    ["alpha", "zebra"],
  );
  assert.ok(result.findings.every((finding) => finding.path && finding.fix));
  assert.deepEqual(snapshot(f.root), before);
});

it("serializes concurrent set changes and preserves both updates", async (t) => {
  const f = fixture(t);
  for (const name of ["alpha", "beta", "gamma", "delta"]) f.skill(name);
  ok(await createSet("work", f.options));
  const results = await Promise.all(
    ["alpha", "beta", "gamma", "delta"].map((name) => addSetSkills("work", [name], f.options)),
  );
  for (const result of results) ok(result);
  assert.deepEqual(
    ok(await showSet("work", f.options)).set.skills.map((skill) => skill.name),
    ["alpha", "beta", "delta", "gamma"],
  );
});
