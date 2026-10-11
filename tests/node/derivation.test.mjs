import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import {
  derivedSetName,
  derivedState,
  desiredDerivedMembers,
  disableSelection,
  enableSelection,
  materializeDerivedSet,
  normalizeScope,
  planDerivedSet,
  readSetOrigin,
  resolveSelection,
  retireDerivedSet,
  SET_ORIGIN_FILE,
  sync,
  withLock,
} from "@delorenj/skillex";

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    const name = relative(root, path);
    if (info.isSymbolicLink()) rows.push([name, "link", info.mode, info.ino, readlinkSync(path)]);
    else if (info.isDirectory()) {
      rows.push([name, "directory", info.mode, info.ino]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else
      rows.push([
        name,
        "file",
        info.mode,
        info.ino,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
  }
  visit(root);
  return rows;
}

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-derivation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  const options = {
    home,
    cwd: projectA,
    registryRoot: registry,
    stateHome,
    env: {},
    timeoutMs: 10_000,
  };
  function directory(path) {
    mkdirSync(path, { recursive: true });
    return path;
  }
  function file(path, value) {
    directory(dirname(path));
    writeFileSync(path, value);
    return path;
  }
  function link(path, target) {
    directory(dirname(path));
    symlinkSync(relative(dirname(path), target), path);
    return path;
  }
  function manifest(scopeRoot, raw) {
    return file(join(scopeRoot, ".agents", "skills.json"), `${JSON.stringify(raw)}\n`);
  }
  function skill(name) {
    const path = directory(join(registry, "all-skills", name));
    file(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Derivation fixture\n---\n`);
    return path;
  }
  function set(name, members) {
    const path = directory(join(registry, "sets", name));
    for (const member of members) link(join(path, member), join(registry, "all-skills", member));
    return path;
  }
  function pack(name, version, members) {
    const path = directory(join(registry, "packs", name, version));
    file(
      join(path, "pack.toml"),
      `[pack]\nname=${JSON.stringify(name)}\nversion=${JSON.stringify(version)}\n[freeform]\nskills=${JSON.stringify(members)}\n`,
    );
    directory(join(path, "skills"));
    for (const member of members)
      link(join(path, "skills", member), join(registry, "all-skills", member));
    return path;
  }
  for (const name of ["alpha", "beta", "gamma", "delta"]) skill(name);
  set("writers", ["alpha", "beta"]);
  pack("extra", "1.0.0", ["gamma"]);
  directory(join(projectA, ".git"));
  directory(join(projectB, ".git"));
  manifest(home, { inherit_global: false, skills: [] });
  manifest(projectA, { inherit_global: true, skills: [] });
  manifest(projectB, { inherit_global: true, skills: [] });
  return {
    root,
    home,
    projectA,
    projectB,
    registry,
    stateHome,
    options,
    directory,
    file,
    link,
    manifest,
    skill,
    set,
    pack,
  };
}

function ownerOf(fixtureRoot) {
  return { scope: "project", root: fixtureRoot.projectA };
}

const INPUTS = {
  base: "writers",
  packs: ["extra@1.0.0"],
  skills: ["delta"],
  removed: ["beta"],
};

function assertRefused(result, code) {
  assert.equal(result.ok, false);
  const finding = result.findings.find(
    (entry) => entry.severity === "error" && (!code || entry.code === code),
  );
  assert.ok(finding, `missing ${code ?? "error"} finding: ${JSON.stringify(result.findings)}`);
  return finding;
}

function scopeActivation(scopeRoot) {
  return join(scopeRoot, ".agents", "skills");
}

function declaration(scopeRoot) {
  return JSON.parse(readFileSync(join(scopeRoot, ".agents", "skills.json"), "utf8"));
}

async function selectedDerived(f, inputs = INPUTS, owner = ownerOf(f)) {
  const created = await materializeDerivedSet({ ...f.options, owner, inputs });
  assert.equal(created.ok, true, JSON.stringify(created.findings));
  const name = derivedSetName(inputs.base, owner.root);
  f.manifest(owner.root, {
    sets: [name],
    packs: inputs.packs,
    skills: inputs.skills,
    exclude: inputs.removed,
  });
  const options = {
    ...f.options,
    scope: owner.scope,
    ...(owner.scope === "project" ? { project: owner.root } : {}),
  };
  const active = await sync(options);
  assert.equal(active.ok, true, JSON.stringify(active.findings));
  return { options, name, path: join(f.registry, "sets", name) };
}

for (const drift of [
  "missing-base",
  "missing-pack",
  "missing-direct",
  "excluded-link",
  "unexpected-link",
  "base-change",
]) {
  it(`refuses full derived membership drift (${drift}) in both resolution and sync`, async (t) => {
    const f = fixture(t);
    const derived = await selectedDerived(f);
    if (drift.startsWith("missing"))
      unlinkSync(
        join(
          derived.path,
          { "missing-base": "alpha", "missing-pack": "gamma", "missing-direct": "delta" }[drift],
        ),
      );
    else if (drift === "excluded-link")
      f.link(join(derived.path, "beta"), join(f.registry, "all-skills", "beta"));
    else if (drift === "unexpected-link")
      f.link(join(derived.path, "surprise"), f.skill("surprise"));
    else f.link(join(f.registry, "sets", "writers", "added"), f.skill("added"));
    const before = snapshot(f.root);
    for (const result of [
      await resolveSelection(derived.options),
      await sync({ ...derived.options, dryRun: true }),
      await sync(derived.options),
    ]) {
      assertRefused(result, "E_SET_DRIFT");
      assert.equal(result.exit, 3);
      assert.deepEqual(snapshot(f.root), before);
    }
    if (drift.startsWith("missing") || drift === "base-change") {
      const repair = await enableSelection("pack", "extra@1.0.0", derived.options);
      assert.equal(repair.ok, true, JSON.stringify(repair.findings));
      assert.equal((await resolveSelection(derived.options)).ok, true);
      const stable = snapshot(f.root);
      assert.deepEqual(
        (await enableSelection("pack", "extra@1.0.0", derived.options)).data.changes,
        [],
      );
      assert.deepEqual(snapshot(f.root), stable);
    }
  });
}

it("a vanished sole pack member cannot silently resolve and sync as an empty derived set", async (t) => {
  const f = fixture(t);
  f.set("empty", []);
  const derived = await selectedDerived(f, {
    base: "empty",
    packs: ["extra@1.0.0"],
    skills: [],
    removed: [],
  });
  unlinkSync(join(derived.path, "gamma"));
  const before = snapshot(f.root);
  assertRefused(await resolveSelection(derived.options), "E_SET_DRIFT");
  assertRefused(await sync(derived.options), "E_SET_DRIFT");
  assert.deepEqual(snapshot(f.root), before);
});

it("reports an unversioned pack membership advance as drift and repairs it explicitly", async (t) => {
  const f = fixture(t);
  const derived = await selectedDerived(f, {
    base: "writers",
    packs: ["extra"],
    skills: [],
    removed: [],
  });
  f.pack("extra", "2.0.0", ["delta"]);
  const before = snapshot(f.root);
  assertRefused(await resolveSelection(derived.options), "E_SET_DRIFT");
  assertRefused(await sync(derived.options), "E_SET_DRIFT");
  const preview = await enableSelection("pack", "extra", { ...derived.options, dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview.findings));
  assert.ok(
    preview.data.changes.some(
      (change) => change.action === "remove-link" && change.path === join(derived.path, "gamma"),
    ),
  );
  assert.ok(
    preview.data.changes.some(
      (change) => change.action === "create-link" && change.path === join(derived.path, "delta"),
    ),
  );
  assert.deepEqual(snapshot(f.root), before);
  const repair = await enableSelection("pack", "extra", derived.options);
  assert.equal(repair.ok, true, JSON.stringify(repair.findings));
  assert.equal(existsSync(join(derived.path, "gamma")), false);
  assert.equal(existsSync(join(derived.path, "delta")), true);
  assert.equal((await sync(derived.options)).ok, true);
});

it("validates nested derived bases and refuses sidecar cycles read-only", async (t) => {
  const f = fixture(t);
  const global = await selectedDerived(f, INPUTS, { scope: "global", root: f.home });
  const project = await selectedDerived(f, {
    base: global.name,
    packs: [],
    skills: ["beta"],
    removed: [],
  });
  const metadata = join(global.path, SET_ORIGIN_FILE);
  const origin = JSON.parse(readFileSync(metadata, "utf8"));
  origin.derived.base = project.name;
  f.file(metadata, JSON.stringify(origin));
  const before = snapshot(f.root);
  const result = await resolveSelection(project.options);
  assertRefused(result, "E_SET_DRIFT");
  assert.ok(result.findings.some((finding) => finding.message.includes("cycle")));
  assert.deepEqual(snapshot(f.root), before);
});

it("a project can select a globally derived set without duplicating its owner's extras", async (t) => {
  const f = fixture(t);
  const global = await selectedDerived(f, INPUTS, { scope: "global", root: f.home });
  f.manifest(f.projectA, { sets: [global.name] });
  const options = { ...f.options, scope: "project", project: f.projectA };
  const preserved = { global: snapshot(f.home), source: snapshot(global.path) };
  const resolved = await resolveSelection(options);
  assert.equal(resolved.ok, true, JSON.stringify(resolved.findings));
  assert.deepEqual(resolved.data.scopes[0].bindings.map((binding) => binding.name).sort(), [
    "alpha",
    "delta",
    "gamma",
  ]);
  const active = await sync(options);
  assert.equal(active.ok, true, JSON.stringify(active.findings));
  assert.equal(realpathSync(scopeActivation(f.projectA)), global.path);
  assert.deepEqual({ global: snapshot(f.home), source: snapshot(global.path) }, preserved);
  const stable = snapshot(f.root);
  assert.deepEqual((await sync(options)).data.changes, []);
  assert.deepEqual(snapshot(f.root), stable);
  unlinkSync(join(global.path, "gamma"));
  assertRefused(await resolveSelection(options), "E_SET_DRIFT");
  assertRefused(await sync(options), "E_SET_DRIFT");
});

function injectDerivedSelection(f, derived, mode) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { options, derived, mode } = JSON.parse(process.argv[1]);
const manifest = join(options.project, '.agents', 'skills.json');
const metadata = join(derived, '.skillex-set.json');
const rename = fs.rename, symlink = fs.symlink, link = fs.link, open = fs.open, readFile = fs.readFile;
let saved = false;
fs.rename = async (from, to) => {
  if (mode === 'manifest-rename' && to === manifest) throw Object.assign(new Error('injected manifest failure'), {code:'EIO'});
  if (mode === 'origin-rename' && to === metadata) throw Object.assign(new Error('injected origin failure'), {code:'EIO'});
  const result = await rename(from, to);
  if (to === manifest) saved = true;
  return result;
};
fs.open = async (path, ...args) => {
  if (mode === 'manifest-read' && saved && path === manifest) throw Object.assign(new Error('injected saved manifest read failure'), {code:'EIO'});
  return open(path, ...args);
};
fs.readFile = async (path, ...args) => {
  if (mode === 'origin-read' && saved && path === metadata) throw Object.assign(new Error('injected origin read failure'), {code:'EIO'});
  return readFile(path, ...args);
};
fs.link = async (from, to) => {
  if (mode === 'origin-create' && to === metadata) throw Object.assign(new Error('injected first origin failure'), {code:'EIO'});
  return link(from, to);
};
fs.symlink = async (target, path, ...rest) => {
  if (mode === 'member-create' && path === join(derived, 'delta')) throw Object.assign(new Error('injected member failure'), {code:'EIO'});
  if (path.startsWith(derived + '/')) {
    const current = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (!current.skills?.includes('delta')) throw new Error('derived write before durable intent');
  }
  return symlink(target, path, ...rest);
};
syncBuiltinESMExports();
const { enableSelection } = await import('@delorenj/skillex');
process.stdout.write(JSON.stringify(await enableSelection('skill', 'delta', options)));
`,
      JSON.stringify({
        options: { ...f.options, scope: "project", project: f.projectA },
        derived,
        mode,
      }),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

it("a failed manifest publication never edits an already active derived set", async (t) => {
  const f = fixture(t);
  const derived = await selectedDerived(f, {
    base: "writers",
    packs: ["extra@1.0.0"],
    skills: [],
    removed: [],
  });
  const before = {
    project: snapshot(f.projectA),
    registry: snapshot(f.registry),
    state: snapshot(join(f.stateHome, "skillex", "activations")),
  };
  const result = injectDerivedSelection(f, derived.path, "manifest-rename");
  assert.equal(result.exit, 1, JSON.stringify(result.findings));
  assert.equal(result.data.saved, false);
  assert.deepEqual(result.data.applied, []);
  assert.deepEqual(
    {
      project: snapshot(f.projectA),
      registry: snapshot(f.registry),
      state: snapshot(join(f.stateHome, "skillex", "activations")),
    },
    before,
  );
  assert.equal(existsSync(join(scopeActivation(f.projectA), "delta")), false);
  assert.equal((await sync(derived.options)).ok, true);
});

for (const mode of ["origin-rename", "member-create", "manifest-read", "origin-read"]) {
  for (const recovery of ["enable", "normalize"]) {
    it(`persists recoverable selection before ${mode} failure and converges through ${recovery}`, async (t) => {
      const f = fixture(t);
      const derived = await selectedDerived(f, {
        base: "writers",
        packs: ["extra@1.0.0"],
        skills: [],
        removed: [],
      });
      const result = injectDerivedSelection(f, derived.path, mode);
      assertRefused(result, "E_SELECTION_PARTIAL");
      assert.equal(result.exit, 4);
      assert.equal(result.data.saved, true);
      assert.ok(declaration(f.projectA).skills.includes("delta"));
      assert.equal(existsSync(join(derived.path, "delta")), false);
      assertRefused(await resolveSelection(derived.options), "E_SET_DRIFT");
      const repaired =
        recovery === "enable"
          ? await enableSelection("skill", "delta", derived.options)
          : await normalizeScope({ ...derived.options, apply: true });
      assert.equal(repaired.ok, true, JSON.stringify(repaired.findings));
      assert.equal(existsSync(join(scopeActivation(f.projectA), "delta")), true);
      assert.equal((await sync(derived.options)).ok, true);
      const stable = snapshot(f.root);
      const repeat =
        recovery === "enable"
          ? await enableSelection("skill", "delta", derived.options)
          : await normalizeScope({ ...derived.options, apply: true });
      assert.equal(repeat.ok, true, JSON.stringify(repeat.findings));
      assert.deepEqual(repeat.data.changes, []);
      assert.deepEqual(snapshot(f.root), stable);
    });
  }
}

for (const recovery of ["enable", "normalize"]) {
  it(`a saved but not-yet-created derived selection resumes through ${recovery} without double derivation`, async (t) => {
    const f = fixture(t);
    const options = { ...f.options, scope: "project", project: f.projectA };
    assert.equal((await enableSelection("set", "writers", options)).ok, true);
    const name = derivedSetName("writers", f.projectA);
    // This is the recoverable state of a successful intent save followed by a
    // process stop before any catalog writes; fixtures never edit live roots.
    f.manifest(f.projectA, { sets: [name], skills: ["delta"] });
    const result =
      recovery === "enable"
        ? await enableSelection("skill", "delta", options)
        : await normalizeScope({ ...options, apply: true });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(declaration(f.projectA).sets, [name]);
    assert.deepEqual(readdirSync(join(f.registry, "sets")).sort(), ["writers", name].sort());
    assert.equal(existsSync(join(scopeActivation(f.projectA), "delta")), true);
  });
}

it("derives a deterministic scope-owned name and reads it back from materialized state", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.match(name, /^writers-[0-9a-f]{6}$/);
  const created = await materializeDerivedSet({
    ...f.options,
    owner,
    inputs: { ...INPUTS, removed: [] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.findings));
  const state = await derivedState(f.registry, name);
  assert.ok(state, "materialized set must expose its derivation state");
  assert.deepEqual(state.origin.derived.owner, { scope: owner.scope, root: owner.root });
  assert.equal(state.origin.derived.base, "writers");
  assert.deepEqual(state.members.sort(), ["alpha", "beta", "delta", "gamma"]);
});

it("computes desired membership as base ∪ packs ∪ skills − removed", async (t) => {
  const f = fixture(t);
  const members = await desiredDerivedMembers(f.registry, INPUTS);
  assert.deepEqual([...members.keys()].sort(), ["alpha", "delta", "gamma"]);
  for (const [name, target] of members)
    assert.equal(target, realpathSync(join(f.registry, "all-skills", name)));
});

it("plans a derived set without writing, including the refusal path", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const before = snapshot(f.registry);
  const preview = await planDerivedSet({ ...f.options, owner, inputs: INPUTS });
  assert.equal(preview.creates, true);
  assert.equal(preview.name, derivedSetName("writers", owner.root));
  assert.deepEqual(preview.changes.map((change) => change.action).sort(), [
    "create-directory",
    "create-link",
    "create-link",
    "create-link",
    "write-origin",
  ]);
  assert.deepEqual(snapshot(f.registry), before);
  // A plain shared set occupying the derived name refuses write-free.
  const occupied = derivedSetName("writers", owner.root);
  f.set(occupied, ["alpha"]);
  const occupiedBefore = snapshot(f.registry);
  const refusal = await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS });
  assertRefused(refusal, "E_COMPOSITION_CONFLICT");
  assert.deepEqual(snapshot(f.registry), occupiedBefore);
});

it("materializes once, then repeats as a true no-op including inodes", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  const path = join(f.registry, "sets", name);
  const first = await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS });
  assert.equal(first.ok, true, JSON.stringify(first.findings));
  assert.ok(first.data.changes.length > 0);
  for (const member of ["alpha", "delta", "gamma"])
    assert.equal(
      realpathSync(join(path, member)),
      realpathSync(join(f.registry, "all-skills", member)),
    );
  const origin = await readSetOrigin(path);
  assert.deepEqual(origin.derived, { owner, ...INPUTS });

  const identity = () => ({
    set: lstatSync(path).ino,
    origin: lstatSync(join(path, SET_ORIGIN_FILE)).ino,
    members: readdirSync(path)
      .filter((entry) => entry !== SET_ORIGIN_FILE)
      .sort()
      .map((entry) => [entry, lstatSync(join(path, entry)).ino]),
  });
  const before = identity();
  const second = await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS });
  assert.equal(second.ok, true, JSON.stringify(second.findings));
  assert.deepEqual(second.data.changes, []);
  assert.deepEqual(identity(), before);
});

it("repairs a drifted origin sidecar even when membership already matches", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const originPath = join(f.registry, "sets", name, SET_ORIGIN_FILE);
  const document = JSON.parse(readFileSync(originPath, "utf8"));
  document.derived.packs = ["extra@0.9.0"];
  writeFileSync(originPath, `${JSON.stringify(document, null, 2)}\n`);

  const repaired = await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS });
  assert.equal(repaired.ok, true, JSON.stringify(repaired.findings));
  assert.ok(
    repaired.data.changes.some((change) => change.action === "write-origin"),
    "drifted origin bytes must be rewritten",
  );
  const origin = await readSetOrigin(join(f.registry, "sets", name));
  assert.deepEqual(origin.derived.packs, ["extra@1.0.0"]);
});

it("repairs member links without rewriting an identical origin sidecar", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const originPath = join(f.registry, "sets", name, SET_ORIGIN_FILE);
  const originInode = lstatSync(originPath).ino;
  unlinkSync(join(f.registry, "sets", name, "gamma"));

  const repaired = await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS });
  assert.equal(repaired.ok, true, JSON.stringify(repaired.findings));
  assert.ok(repaired.data.changes.some((change) => change.action === "create-link"));
  assert.ok(!repaired.data.changes.some((change) => change.action === "write-origin"));
  assert.equal(lstatSync(originPath).ino, originInode);
  assert.equal(
    realpathSync(join(f.registry, "sets", name, "gamma")),
    realpathSync(join(f.registry, "all-skills", "gamma")),
  );
});

it("retires only an owned derived set and leaves shared source untouched", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const before = snapshot(f.registry).filter(([entry]) => !entry.startsWith(`sets/${name}`));
  const retired = await retireDerivedSet(f.options, owner, name);
  assert.equal(retired.ok, true, JSON.stringify(retired.findings));
  assert.equal(existsSync(join(f.registry, "sets", name)), false);
  assert.deepEqual(snapshot(f.registry), before);
  // Repeated retirement of an absent set is a write-free no-op.
  const again = await retireDerivedSet(f.options, owner, name);
  assert.equal(again.ok, true);
  assert.deepEqual(snapshot(f.registry), before);
});

it("refuses retirement of foreign-owned derived sets, plain sets, and mixed content write-free", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  // A derived set owned by a different scope root.
  const foreignName = derivedSetName("writers", join(f.root, "other-project"));
  const foreignPath = f.set(foreignName, ["alpha", "beta"]);
  f.file(
    join(foreignPath, SET_ORIGIN_FILE),
    `${JSON.stringify(
      {
        schema: 1,
        derived: {
          owner: { scope: "project", root: join(f.root, "other-project") },
          base: "writers",
          packs: [],
          skills: [],
          removed: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  const foreignBefore = snapshot(foreignPath);
  const foreignOwner = await derivedState(f.registry, foreignName);
  assert.equal(foreignOwner.origin.derived.owner.root, join(f.root, "other-project"));
  assertRefused(await retireDerivedSet(f.options, owner, foreignName), "E_COMPOSITION_CONFLICT");
  assert.deepEqual(snapshot(foreignPath), foreignBefore);

  // A plain shared set at this owner's derived name is shared source, never removed.
  const plainName = derivedSetName("writers", owner.root);
  const plainPath = f.set(plainName, ["alpha"]);
  const plainBefore = snapshot(plainPath);
  assertRefused(await retireDerivedSet(f.options, owner, plainName), "E_COMPOSITION_CONFLICT");
  assert.deepEqual(snapshot(plainPath), plainBefore);

  // Foreign content inside an owned derived set refuses before any member is removed.
  const ownedName = derivedSetName("writers", owner.root);
  rmSync(join(f.registry, "sets", ownedName), { recursive: true, force: true });
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const ownedPath = join(f.registry, "sets", ownedName);
  f.file(join(ownedPath, "zz-notes.txt"), "Foreign content must block retirement.\n");
  const mixedBefore = snapshot(ownedPath);
  assertRefused(await retireDerivedSet(f.options, owner, ownedName), "E_COMPOSITION_CONFLICT");
  assert.deepEqual(
    snapshot(ownedPath),
    mixedBefore,
    "refusal must not leave a half-retired derived set",
  );

  // Dry-run validates without writing.
  rmSync(join(ownedPath, "zz-notes.txt"));
  const validBefore = snapshot(ownedPath);
  const planned = await retireDerivedSet({ ...f.options, dryRun: true }, owner, ownedName);
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  assert.ok(planned.findings.some((finding) => finding.code === "W_RETIRE_PLANNED"));
  assert.deepEqual(snapshot(ownedPath), validBefore);
});

it("derives a scope-owned set when one consumer of a shared set enables a pack", async (t) => {
  const f = fixture(t);
  const options = { ...f.options };
  const enable = (kind, reference, scopeOptions) =>
    enableSelection(kind, reference, { ...options, ...scopeOptions });
  const disable = (kind, reference, scopeOptions) =>
    disableSelection(kind, reference, { ...options, ...scopeOptions });

  // All three scopes share the plain set: exclusive root symlinks per scope.
  assert.equal((await enable("set", "writers", { scope: "global" })).ok, true);
  assert.equal(
    (await enable("set", "writers", { scope: "project", project: f.projectA })).ok,
    true,
  );
  assert.equal(
    (await enable("set", "writers", { scope: "project", project: f.projectB })).ok,
    true,
  );
  const shared = join(f.registry, "sets", "writers");
  for (const scopeRoot of [f.home, f.projectA, f.projectB]) {
    assert.ok(lstatSync(scopeActivation(scopeRoot)).isSymbolicLink());
    assert.equal(realpathSync(scopeActivation(scopeRoot)), realpathSync(shared));
  }
  const homeBefore = snapshot(f.home);
  const projectBBefore = snapshot(f.projectB);
  const sharedBefore = snapshot(shared);

  // One consumer adds a pack: it alone switches to its scope-owned derived set.
  const packed = await enable("pack", "extra@1.0.0", { scope: "project", project: f.projectA });
  assert.equal(packed.ok, true, JSON.stringify(packed.findings));
  const derived = derivedSetName("writers", f.projectA);
  assert.deepEqual(declaration(f.projectA).sets, [derived]);
  assert.equal(realpathSync(scopeActivation(f.projectA)), join(f.registry, "sets", derived));
  assert.deepEqual(
    readdirSync(join(f.registry, "sets", derived))
      .filter((entry) => entry !== SET_ORIGIN_FILE)
      .sort(),
    ["alpha", "beta", "gamma"],
  );
  assert.deepEqual(snapshot(f.home), homeBefore, "the other consumer and the shared");
  assert.deepEqual(snapshot(f.projectB), projectBBefore, "source must remain unchanged");
  assert.deepEqual(snapshot(shared), sharedBefore);

  // A repeated identical enable is a write-free no-op.
  const manifestPath = join(f.projectA, ".agents", "skills.json");
  const rootLink = lstatSync(scopeActivation(f.projectA)).ino;
  const manifestInode = lstatSync(manifestPath).ino;
  const repeat = await enable("pack", "extra@1.0.0", { scope: "project", project: f.projectA });
  assert.equal(repeat.ok, true, JSON.stringify(repeat.findings));
  assert.equal(repeat.data.changed, false);
  assert.deepEqual(repeat.data.changes, []);
  assert.equal(lstatSync(scopeActivation(f.projectA)).ino, rootLink);
  assert.equal(lstatSync(manifestPath).ino, manifestInode);

  // Removing the pack collapses back to the plain shared set and retires the derived set.
  const collapsed = await disable("pack", "extra@1.0.0", {
    scope: "project",
    project: f.projectA,
  });
  assert.equal(collapsed.ok, true, JSON.stringify(collapsed.findings));
  assert.deepEqual(declaration(f.projectA).sets, ["writers"]);
  assert.equal(realpathSync(scopeActivation(f.projectA)), realpathSync(shared));
  assert.equal(existsSync(join(f.registry, "sets", derived)), false);
  assert.deepEqual(snapshot(f.home), homeBefore);
  assert.deepEqual(snapshot(f.projectB), projectBBefore);
  assert.deepEqual(snapshot(shared), sharedBefore);
});

async function sharedConsumers(f) {
  for (const project of [f.projectA, f.projectB]) {
    const selected = await enableSelection("set", "writers", {
      ...f.options,
      scope: "project",
      project,
    });
    assert.equal(selected.ok, true, JSON.stringify(selected.findings));
  }
}

for (const boundary of ["alias", "root", "alias-parent", "receipt"]) {
  it(`refuses pack derivation before any writes when the ${boundary} is foreign or changed`, async (t) => {
    const f = fixture(t);
    await sharedConsumers(f);
    if (boundary === "receipt") {
      const receipts = join(f.stateHome, "skillex", "activations", "v2");
      for (const name of readdirSync(receipts))
        if (name.endsWith(".json")) f.file(join(receipts, name), "invalid receipt\n");
    } else {
      const path =
        boundary === "alias"
          ? join(f.projectA, ".claude", "skills")
          : boundary === "root"
            ? scopeActivation(f.projectA)
            : join(f.projectA, ".claude");
      rmSync(path, { recursive: true });
      if (boundary === "alias-parent") {
        const foreign = f.directory(join(f.root, "foreign-client"));
        f.file(join(foreign, "notes.txt"), "Preserve redirected parent\n");
        f.link(path, foreign);
      } else f.file(join(path, "notes.txt"), "Preserve foreign data\n");
    }
    const before = snapshot(f.root);
    const derivedPath = join(f.registry, "sets", derivedSetName("writers", f.projectA));
    for (const dryRun of [true, false]) {
      const result = await enableSelection("pack", "extra@1.0.0", {
        ...f.options,
        scope: "project",
        project: f.projectA,
        dryRun,
      });
      assertRefused(result);
      assert.equal(result.exit, 3, JSON.stringify(result.findings));
      assert.equal(result.data, null, "refusal must precede the save/apply boundary");
      assert.equal(existsSync(derivedPath), false);
      assert.deepEqual(
        snapshot(f.root),
        before,
        "neither scope, catalog, manifest nor receipt may change",
      );
    }
  });
}

it("previews the complete derived activation and repairs aliases on an otherwise unchanged enable", async (t) => {
  const f = fixture(t);
  await sharedConsumers(f);
  const options = { ...f.options, scope: "project", project: f.projectA };
  const before = snapshot(f.root);
  const preview = await enableSelection("pack", "extra@1.0.0", { ...options, dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview.findings));
  const rootChange = preview.data.changes.find((change) => change.action === "replace-root");
  assert.equal(rootChange.path, scopeActivation(f.projectA));
  assert.equal(rootChange.target, join(f.registry, "sets", derivedSetName("writers", f.projectA)));
  assert.ok(preview.data.changes.some((change) => change.action === "write-receipt"));
  assert.deepEqual(snapshot(f.root), before);
  const applied = await enableSelection("pack", "extra@1.0.0", options);
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  assert.deepEqual(preview.data.changes, applied.data.changes);

  const alias = join(f.projectA, ".claude", "skills");
  unlinkSync(alias);
  const repair = await enableSelection("pack", "extra@1.0.0", { ...options, dryRun: true });
  assert.equal(repair.ok, true, JSON.stringify(repair.findings));
  assert.equal(repair.data.changed, false);
  assert.ok(
    repair.data.changes.some((change) => change.path === alias && change.action === "create-link"),
  );
  assert.equal(existsSync(alias), false);
  const repaired = await enableSelection("pack", "extra@1.0.0", options);
  assert.equal(repaired.ok, true, JSON.stringify(repaired.findings));
  assert.equal(realpathSync(alias), realpathSync(scopeActivation(f.projectA)));
  const stable = snapshot(f.root);
  const repeat = await enableSelection("pack", "extra@1.0.0", options);
  assert.equal(repeat.ok, true, JSON.stringify(repeat.findings));
  assert.deepEqual(repeat.data.changes, []);
  assert.deepEqual(snapshot(f.root), stable);
});

it("refuses selection collapse before writes if its derived-set retirement contains foreign data", async (t) => {
  const f = fixture(t);
  await sharedConsumers(f);
  const options = { ...f.options, scope: "project", project: f.projectA };
  const selected = await enableSelection("pack", "extra@1.0.0", options);
  assert.equal(selected.ok, true, JSON.stringify(selected.findings));
  const path = join(f.registry, "sets", derivedSetName("writers", f.projectA));
  f.file(join(path, "notes.txt"), "Preserve user data\n");
  const before = snapshot(f.root);
  for (const dryRun of [true, false]) {
    const result = await disableSelection("pack", "extra@1.0.0", { ...options, dryRun });
    assertRefused(result, "E_COMPOSITION_CONFLICT");
    assert.equal(result.exit, 3);
    assert.equal(result.data, null);
    assert.deepEqual(snapshot(f.root), before);
  }
});

it("selection reports a retirement failure after activation as partial instead of success", async (t) => {
  const f = fixture(t);
  await sharedConsumers(f);
  const options = { ...f.options, scope: "project", project: f.projectA };
  const selected = await enableSelection("pack", "extra@1.0.0", options);
  assert.equal(selected.ok, true, JSON.stringify(selected.findings));
  const path = join(f.registry, "sets", derivedSetName("writers", f.projectA));
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const options = JSON.parse(process.argv[1]);
const path = process.argv[2];
const rmdir = fs.rmdir;
fs.rmdir = async (target, ...args) => {
  if (target === path) throw Object.assign(new Error('Injected retirement failure'), {code: 'EIO'});
  return rmdir(target, ...args);
};
syncBuiltinESMExports();
const { disableSelection } = await import('@delorenj/skillex');
process.stdout.write(JSON.stringify(await disableSelection('pack', 'extra@1.0.0', options)));
`,
      JSON.stringify(options),
      path,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assertRefused(result, "E_COMPOSITION_PARTIAL");
  assertRefused(result, "E_SELECTION_PARTIAL");
  assert.equal(result.exit, 4);
  assert.equal(result.data.saved, true);
  assert.deepEqual(declaration(f.projectA).sets, ["writers"]);
  assert.ok(!result.data.applied.some((change) => change.action === "retire-set"));
  assert.equal(realpathSync(scopeActivation(f.projectA)), join(f.registry, "sets", "writers"));
  assert.ok(lstatSync(path).isDirectory());
});

it("standalone retirement observes the composition lock while dry-run remains write-free", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const before = snapshot(f.registry);
  await withLock(
    `${f.registry}#compositions`,
    async () => {
      const heldBefore = snapshot(f.root);
      const preview = await retireDerivedSet({ ...f.options, dryRun: true }, owner, name);
      assert.equal(preview.ok, true, JSON.stringify(preview.findings));
      assert.equal(preview.data.retired, null);
      assert.deepEqual(preview.data.removed, []);
      assert.deepEqual(snapshot(f.root), heldBefore);
      const blocked = await retireDerivedSet({ ...f.options, timeoutMs: 0 }, owner, name);
      assertRefused(blocked, "E_LOCK_BUSY");
      assert.deepEqual(snapshot(f.registry), before);
    },
    f.options,
  );
  const retired = await retireDerivedSet(f.options, owner, name);
  assert.equal(retired.ok, true, JSON.stringify(retired.findings));
  assert.equal(retired.data.retired, name);
});

function injectedRetirement(f, mode) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const { options, owner, name, mode } = JSON.parse(process.argv[1]);
const path = join(options.registryRoot, 'sets', name);
const metadata = join(path, '.skillex-set.json');
const unlink = fs.unlink, rmdir = fs.rmdir, rename = fs.rename, readFile = fs.readFile, readdir = fs.readdir;
let fired = false, locked = false, inventories = 0;
const { retireDerivedSet } = await import('@delorenj/skillex');
const originalLink = fs.link;
fs.link = async (...args) => {
  const result = await originalLink(...args);
  if (!fired && String(args[1]).endsWith('/ticket.json')) {
    locked = true;
    if (mode === 'owner-after-lock') {
      fired = true;
      const raw = JSON.parse(await readFile(metadata, 'utf8'));
      raw.derived.owner.root += '-foreign';
      await fs.writeFile(metadata, JSON.stringify(raw));
    }
  }
  return result;
};
fs.readdir = async (target, ...args) => {
  const result = await readdir(target, ...args);
  if (locked && target === path && !args.length && ++inventories === 3 && mode === 'replace-before-delete') {
    await rename(join(path, 'alpha'), join(options.cwd, 'parked-member'));
    await fs.symlink('../../all-skills/alpha', join(path, 'alpha'));
  }
  return result;
};
if (mode !== 'owner-after-lock') {
  fs.unlink = async (target, ...args) => {
    if (mode === 'after-unlink-error' && target === join(path, 'alpha')) {
      await unlink(target, ...args);
      throw Object.assign(new Error('Injected error after deletion'), { code: 'EIO' });
    }
    const result = await unlink(target, ...args);
    if (!fired && target === join(path, 'alpha')) {
      fired = true;
      if (mode === 'replace-member') {
        await rename(join(path, 'delta'), join(options.cwd, 'parked-member'));
        // Same canonical target, different inode: equality of target is not ownership.
        await fs.symlink('../../all-skills/delta', join(path, 'delta'));
      }
      if (mode === 'replace-directory') {
        await rename(path, path + '-parked');
        await fs.mkdir(path);
        await fs.writeFile(join(path, 'delta'), 'foreign replacement');
      }
      if (mode === 'change-owner') {
        const raw = JSON.parse(await readFile(metadata, 'utf8'));
        raw.derived.owner.root += '-foreign';
        await fs.writeFile(metadata, JSON.stringify(raw));
      }
      if (mode === 'foreign-entry') await fs.writeFile(join(path, 'notes.txt'), 'foreign content');
    }
    return result;
  };
  fs.rmdir = async (target, ...args) => {
    if (mode === 'rmdir-error' && target === path) throw Object.assign(new Error('Injected directory removal failure'), { code: 'EIO' });
    return rmdir(target, ...args);
  };
}
syncBuiltinESMExports();
const result = await retireDerivedSet(options, owner, name);
process.stdout.write(JSON.stringify(result));
`,
      JSON.stringify({
        options: f.options,
        owner: ownerOf(f),
        name: derivedSetName("writers", f.projectA),
        mode,
      }),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

it("retirement rechecks owner metadata under the composition lock before removing members", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const path = join(f.registry, "sets", name);
  const members = snapshot(path).filter(([entry]) => entry !== SET_ORIGIN_FILE);
  const result = injectedRetirement(f, "owner-after-lock");
  assertRefused(result, "E_COMPOSITION_CONFLICT");
  assert.equal(result.exit, 3);
  assert.equal(result.data, null);
  assert.deepEqual(
    snapshot(path).filter(([entry]) => entry !== SET_ORIGIN_FILE),
    members,
  );
});

it("retirement refuses an identity replacement after locked preflight but before first deletion", async (t) => {
  const f = fixture(t);
  const owner = ownerOf(f);
  const name = derivedSetName("writers", owner.root);
  assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
  const path = join(f.registry, "sets", name);
  const before = snapshot(path).filter(([entry]) => entry !== "alpha");
  const result = injectedRetirement(f, "replace-before-delete");
  assertRefused(result, "E_COMPOSITION_CONFLICT");
  assert.equal(result.exit, 3);
  assert.equal(result.data, null);
  assert.deepEqual(
    snapshot(path).filter(([entry]) => entry !== "alpha"),
    before,
  );
  assert.ok(lstatSync(join(f.projectA, "parked-member")).isSymbolicLink());
  assert.equal(realpathSync(join(path, "alpha")), join(f.registry, "all-skills", "alpha"));
});

for (const mode of [
  "replace-member",
  "replace-directory",
  "change-owner",
  "foreign-entry",
  "after-unlink-error",
  "rmdir-error",
]) {
  it(`reports partial retirement and preserves remaining identities after ${mode}`, async (t) => {
    const f = fixture(t);
    const owner = ownerOf(f);
    const name = derivedSetName("writers", owner.root);
    assert.equal((await materializeDerivedSet({ ...f.options, owner, inputs: INPUTS })).ok, true);
    const path = join(f.registry, "sets", name);
    const shared = snapshot(join(f.registry, "sets", "writers"));
    const result = injectedRetirement(f, mode);
    assertRefused(result, "E_COMPOSITION_PARTIAL");
    assert.equal(result.exit, 4, JSON.stringify(result.findings));
    assert.equal(result.data.retired, null);
    assert.ok(result.data.removed.includes(join(path, "alpha")));
    assert.deepEqual(snapshot(join(f.registry, "sets", "writers")), shared);
    if (mode === "replace-directory") {
      assert.equal(readFileSync(join(path, "delta"), "utf8"), "foreign replacement");
      assert.ok(existsSync(join(`${path}-parked`, "delta")));
    } else if (mode !== "rmdir-error") {
      assert.ok(
        existsSync(join(path, "delta")),
        "unremoved or foreign replacement member must survive",
      );
      assert.ok(
        existsSync(join(path, SET_ORIGIN_FILE)),
        "retain ownership evidence on a member failure",
      );
      if (mode === "foreign-entry")
        assert.equal(readFileSync(join(path, "notes.txt"), "utf8"), "foreign content");
    }
  });
}
