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
  GLOBAL_CLI_ALIASES,
  PROJECT_CLI_ALIASES,
  planSync,
  sync,
  withLock,
} from "@delorenj/skillex";

function fixture(t) {
  // The user TMPDIR can itself be in a checkout; receipt state must not be.
  const root = realpathSync(mkdtempSync("/tmp/skillex-reconciliation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  const options = {
    home,
    cwd: project,
    registryRoot: registry,
    stateHome,
    env: {},
    timeoutMs: 10_000,
  };
  function directory(path) {
    mkdirSync(path, { recursive: true });
    return path;
  }
  function file(path, text) {
    directory(dirname(path));
    writeFileSync(path, text);
    return path;
  }
  function link(path, target, absolute = false) {
    directory(dirname(path));
    symlinkSync(absolute ? target : relative(dirname(path), target), path);
    return path;
  }
  function manifest(scope, value) {
    return file(
      join(scope === "global" ? home : project, ".agents", "skills.json"),
      JSON.stringify(value),
    );
  }
  function skill(name) {
    const path = join(registry, "all-skills", name);
    file(join(path, "SKILL.md"), `# ${name}\n`);
    return path;
  }
  function pack(name, version, names) {
    const path = join(registry, "packs", name, version);
    file(
      join(path, "pack.toml"),
      `[pack]\nname=${JSON.stringify(name)}\nversion=${JSON.stringify(version)}\n[freeform]\nskills=${JSON.stringify(names)}\n`,
    );
    directory(join(path, "skills"));
    for (const member of names)
      link(join(path, "skills", member), join(registry, "all-skills", member));
    return path;
  }
  directory(join(project, ".git"));
  directory(join(registry, "all-skills"));
  manifest("global", {});
  manifest("project", {});
  return {
    root,
    home,
    project,
    registry,
    stateHome,
    options,
    directory,
    file,
    link,
    manifest,
    skill,
    pack,
  };
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
  assert.ok(result.data);
  return result.data;
}

function finding(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  const found = result.findings.find((item) => item.code === code);
  assert.ok(found, JSON.stringify(result.findings));
  assert.ok(found.fix);
  return found;
}

function activation(base) {
  return join(base, ".agents", "skills");
}
function receipt(result, scope = "project") {
  const path = result.scopes.find((item) => item.scope === scope).receiptPath;
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}

it("syncs both scopes, inheritance and aliases, records exact ownership, and has a write-free second run", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  f.manifest("global", { skills: ["alpha"] });
  f.manifest("project", { skills: ["beta"] });
  const result = ok(await sync(f.options));
  assert.deepEqual(result.writeScopes, ["global", "project"]);
  assert.equal(realpathSync(join(activation(f.home), "alpha")), alpha);
  for (const [name, path] of [
    ["alpha", alpha],
    ["beta", beta],
  ])
    assert.equal(realpathSync(join(activation(f.project), name)), path);
  for (const [base, aliases] of [
    [f.home, GLOBAL_CLI_ALIASES],
    [f.project, PROJECT_CLI_ALIASES],
  ]) {
    for (const path of aliases) assert.equal(realpathSync(join(base, path)), activation(base));
  }
  const record = receipt(result).value;
  assert.equal(record.schema, 2);
  assert.equal(record.activationRoot, activation(f.project));
  assert.equal(
    record.data.directories[activation(f.project)].ino,
    String(lstatSync(activation(f.project), { bigint: true }).ino),
  );
  const owned = record.data.links[join(activation(f.project), "alpha")];
  assert.equal(owned.raw, readlinkSync(join(activation(f.project), "alpha")));
  assert.equal(
    owned.ino,
    String(lstatSync(join(activation(f.project), "alpha"), { bigint: true }).ino),
  );
  assert.equal(record.data.sources[0].commit, null);
  assert.ok(record.data.sources[0].reason);
  const before = snapshot(f.root);
  assert.deepEqual(ok(await sync(f.options)).changes, []);
  assert.deepEqual(ok(await planSync(f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), before);
});

it("previews alias and root changes without writes and returns drift only when requested", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("global", { skills: ["alpha"] });
  const before = snapshot(f.root);
  const plan = ok(await planSync(f.options));
  assert.ok(
    plan.changes.some((item) => item.path === join(f.home, ".config", "opencode", "skills")),
  );
  assert.ok(plan.changes.some((item) => item.path === join(f.project, ".codex", "skills")));
  const preview = ok(await sync({ ...f.options, dryRun: true }));
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.applied, []);
  assert.equal((await planSync({ ...f.options, exitCode: true })).exit, 6);
  assert.equal((await sync({ ...f.options, dryRun: true, exitCode: true })).exit, 6);
  finding(await sync({ ...f.options, exitCode: true }), "E_SYNC_OPTIONS", 2);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
  ok(await sync(f.options));
  assert.equal((await sync({ ...f.options, dryRun: true, exitCode: true })).exit, 0);
});

it("retains correct preexisting links without adopting ownership or creating state", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  f.link(join(activation(f.project), "alpha"), alpha, true);
  for (const [index, path] of PROJECT_CLI_ALIASES.entries())
    f.link(join(f.project, path), activation(f.project), index % 2 === 0);
  const before = snapshot(f.root);
  assert.deepEqual(ok(await sync({ ...f.options, scope: "project" })).changes, []);
  assert.equal(existsSync(f.stateHome), false);
  assert.deepEqual(snapshot(f.root), before);
  f.manifest("project", { inherit_global: false });
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.equal(existsSync(f.stateHome), false);
});

it("prunes only recorded stale links while preserving foreign skills, BMAD content and overlays", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  ok(await sync({ ...f.options, scope: "project" }));
  f.link(join(activation(f.project), "beta"), beta);
  f.file(join(activation(f.project), "bmad", "SKILL.md"), "# Installer owned\n");
  f.file(join(f.project, ".hermes", "skills", "overlay", "SKILL.md"), "# Overlay\n");
  f.file(join(f.project, ".cursor", "rules", "keep.md"), "Retain\n");
  const foreignBefore = snapshot(join(activation(f.project), "bmad"));
  const overlayBefore = snapshot(join(f.project, ".hermes"));
  f.manifest("project", { inherit_global: false });
  const updated = ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(existsSync(join(activation(f.project), "alpha")), false);
  assert.equal(realpathSync(join(activation(f.project), "beta")), beta);
  assert.deepEqual(snapshot(join(activation(f.project), "bmad")), foreignBefore);
  assert.deepEqual(snapshot(join(f.project, ".hermes")), overlayBefore);
  assert.ok(!receipt(updated).value.data.links[join(activation(f.project), "beta")]);
  assert.ok(existsSync(join(alpha, "SKILL.md")));
});

it("switches composed to pack, pack version to pack version, then back using the same receipt key", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  const first = f.pack("tools", "1.0.0", ["beta"]);
  const second = f.pack("tools", "2.0.0", ["alpha", "beta"]);
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  const composed = ok(await sync({ ...f.options, scope: "project" }));
  const key = receipt(composed).path;
  f.manifest("project", { skills: ["missing-dormant"], packs: ["tools@1.0.0"] });
  const packed = ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(lstatSync(activation(f.project)).isSymbolicLink(), true);
  assert.equal(realpathSync(activation(f.project)), join(first, "skills"));
  assert.equal(receipt(packed).path, key);
  assert.deepEqual(Object.keys(receipt(packed).value.data.directories), []);
  assert.ok(receipt(packed).value.data.links[activation(f.project)]);
  f.manifest("project", { packs: ["tools"] });
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(realpathSync(activation(f.project)), join(second, "skills"));
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  const restored = ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(lstatSync(activation(f.project)).isDirectory(), true);
  assert.deepEqual(readdirSync(activation(f.project)), ["alpha"]);
  assert.equal(receipt(restored).path, key);
  assert.ok(!receipt(restored).value.data.pending);
  assert.deepEqual(
    readdirSync(join(f.project, ".agents")).filter((name) => name.startsWith(".skillex-tmp-")),
    [],
  );
  for (const path of PROJECT_CLI_ALIASES)
    assert.equal(realpathSync(join(f.project, path)), activation(f.project));
});

it("preserves unavailable optional selections and refuses unverified generated pack links", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  ok(await sync({ ...f.options, scope: "project" }));
  f.manifest("project", { packs: [{ name: "absent", optional: true }] });
  let before = snapshot(f.root);
  finding(await sync({ ...f.options, scope: "project" }), "W_OPTIONAL_SKIPPED", 4);
  assert.deepEqual(snapshot(f.root), before);
  const path = f.pack("tools", "1.0.0", ["alpha"]);
  unlinkSync(join(path, "skills", "alpha"));
  f.manifest("project", { packs: ["tools"] });
  before = snapshot(f.root);
  finding(await sync({ ...f.options, scope: "project" }), "E_PACK_LINK_MISSING");
  assert.deepEqual(snapshot(f.root), before);
});

it("preflights every selected scope before creating global roots or lock state", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("global", { skills: ["alpha"] });
  f.file(join(f.project, ".codex", "skills", "foreign.txt"), "Preserve\n");
  const before = snapshot(f.root);
  finding(await sync(f.options), "E_ACTIVATION_CONFLICT");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(activation(f.home)), false);
  assert.equal(existsSync(f.stateHome), false);
});

it("project-only sync resolves global inheritance from nested cwd without mutating global activation", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.manifest("global", { skills: ["alpha"] });
  const nested = f.directory(join(f.project, "src", "deep"));
  const homeBefore = snapshot(f.home);
  const result = ok(await sync({ ...f.options, cwd: nested, scope: "project" }));
  assert.deepEqual(result.writeScopes, ["project"]);
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.deepEqual(snapshot(f.home), homeBefore);
});

it("global scope ignores unrelated malformed projects and explicit project overrides nested repositories", async (t) => {
  const f = fixture(t);
  f.file(join(f.project, ".agents", "skills.json"), "broken JSON");
  const projectBefore = snapshot(f.project);
  ok(await sync({ ...f.options, scope: "global" }));
  assert.deepEqual(snapshot(f.project), projectBefore);
  f.manifest("project", { inherit_global: false });
  const nested = f.directory(join(f.project, "nested", ".git"));
  const result = ok(
    await sync({ ...f.options, cwd: dirname(nested), scope: "project", project: f.project }),
  );
  assert.deepEqual(result.writeScopes, ["project"]);
});

for (const shape of ["real-child", "wrong-link", "redirected-parent"]) {
  it(`refuses ${shape} destinations without changing source, activation or state`, async (t) => {
    const f = fixture(t);
    f.skill("alpha");
    const beta = f.skill("beta");
    f.manifest("project", { inherit_global: false, skills: ["alpha"] });
    if (shape === "real-child")
      f.file(join(activation(f.project), "alpha", "foreign.txt"), "preserve\n");
    else if (shape === "wrong-link") f.link(join(activation(f.project), "alpha"), beta);
    else f.link(join(f.project, ".codex"), f.directory(join(f.root, "elsewhere")));
    const before = snapshot(f.root);
    finding(await sync({ ...f.options, scope: "project" }), "E_ACTIVATION_CONFLICT");
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(existsSync(f.stateHome), false);
  });
}

it("refuses whole-root transitions when the root or any contained entry is unowned", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.pack("tools", "1.0.0", ["alpha"]);
  f.manifest("project", { inherit_global: false });
  ok(await sync({ ...f.options, scope: "project" }));
  f.file(join(activation(f.project), "foreign", "keep.txt"), "preserve\n");
  f.manifest("project", { packs: ["tools"] });
  const before = snapshot(f.root);
  finding(await sync({ ...f.options, scope: "project" }), "E_ACTIVATION_CONFLICT");
  assert.deepEqual(snapshot(f.root), before);
});

it("refuses foreign aliases that point directly at the old pack when switching plans", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  const first = f.pack("tools", "1.0.0", ["alpha"]);
  f.pack("tools", "2.0.0", ["alpha"]);
  f.manifest("project", { packs: ["tools@1.0.0"] });
  f.link(join(f.project, ".codex", "skills"), join(first, "skills"), true);
  ok(await sync({ ...f.options, scope: "project" }));
  f.manifest("project", { packs: ["tools@2.0.0"] });
  const before = snapshot(f.root);
  finding(await sync({ ...f.options, scope: "project" }), "E_ACTIVATION_CONFLICT");
  assert.deepEqual(snapshot(f.root), before);
});

it("refuses cyclic aliases and recursive source destinations", async (t) => {
  const f = fixture(t);
  f.link(join(f.project, ".codex", "skills"), join(f.project, ".claude", "skills"));
  f.link(join(f.project, ".claude", "skills"), join(f.project, ".codex", "skills"));
  const before = snapshot(f.root);
  finding(await sync({ ...f.options, scope: "project" }), "E_ACTIVATION_RECURSIVE");
  assert.deepEqual(snapshot(f.root), before);
  const skillRoot = f.skill("recursive");
  f.file(
    join(skillRoot, ".agents", "skills.json"),
    '{"inherit_global":false,"skills":["recursive"]}',
  );
  finding(
    await sync({ ...f.options, project: skillRoot, scope: "project" }),
    "E_ACTIVATION_RECURSIVE",
  );
});

it("refuses changed ownership identities without adopting a same-target replacement", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  ok(await sync({ ...f.options, scope: "project" }));
  const path = join(activation(f.project), "alpha");
  const original = lstatSync(path, { bigint: true }).ino;
  const parked = join(f.root, "original-link");
  // Keep the original inode alive so the filesystem cannot recycle it.
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { renameSync } from 'node:fs'; renameSync(process.argv[1], process.argv[2]);",
    path,
    parked,
  ]);
  assert.equal(child.status, 0);
  f.link(path, alpha);
  assert.notEqual(lstatSync(path, { bigint: true }).ino, original);
  const before = snapshot(f.root);
  finding(await sync({ ...f.options, scope: "project" }), "E_OWNERSHIP_CHANGED");
  assert.deepEqual(snapshot(f.root), before);
});

it("serializes concurrent sync invocations and converges on one owned root", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  for (const result of await Promise.all(
    Array.from({ length: 4 }, () => sync({ ...f.options, scope: "project" })),
  ))
    ok(result);
  assert.deepEqual(ok(await planSync({ ...f.options, scope: "project" })).changes, []);
});

function injectSync(options, mode) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
const options = JSON.parse(process.argv[1]);
const mode = process.argv[2];
const original = fs.link;
fs.link = async (...args) => {
  const destination = args[1];
  const selected = mode.startsWith('root') ? destination === join(options.project ?? options.cwd, '.agents', 'skills') : basename(destination) === 'beta';
  if (selected) {
    if (mode === 'published-kill') { await original(...args); process.exit(75); }
    if (mode === 'foreign') await fs.writeFile(destination, 'Foreign interference\\n');
    if (mode === 'root-published') await original(...args);
    throw Object.assign(new Error('Injected activation interruption'), { code: 'EIO' });
  }
  return original(...args);
};
syncBuiltinESMExports();
const { sync } = await import('@delorenj/skillex');
process.stdout.write(JSON.stringify(await sync(options)));`,
      JSON.stringify(options),
      mode,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (mode === "published-kill") {
    assert.equal(child.status, 75, child.stderr);
    return;
  }
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  return JSON.parse(child.stdout);
}

for (const changedIntent of [false, true]) {
  it(`recovers an interrupted child publication with ${changedIntent ? "changed" : "unchanged"} manifest intent`, async (t) => {
    const f = fixture(t);
    for (const name of ["alpha", "beta", "gamma"]) f.skill(name);
    const options = { ...f.options, scope: "project" };
    f.manifest("project", { inherit_global: false });
    const initial = ok(await sync(options));
    f.manifest("project", { inherit_global: false, skills: ["alpha", "beta"] });
    finding(injectSync(options, "child"), "E_SYNC_PARTIAL", 4);
    assert.ok(receipt(initial).value.data.pending);
    if (changedIntent) f.manifest("project", { inherit_global: false, skills: ["alpha", "gamma"] });
    const before = snapshot(f.root);
    assert.ok(ok(await planSync(options)).changes.some((item) => item.action === "recover"));
    assert.deepEqual(snapshot(f.root), before);
    const recovered = ok(await sync(options));
    assert.deepEqual(
      readdirSync(activation(f.project)).sort(),
      ["alpha", changedIntent ? "gamma" : "beta"].sort(),
    );
    assert.ok(!receipt(recovered).value.data.pending);
    assert.deepEqual(ok(await planSync(options)).changes, []);
  });
}

for (const mode of ["root-unpublished", "root-published"]) {
  it(`recovers ${mode} pack switching without deleting foreign or canonical content`, async (t) => {
    const f = fixture(t);
    const alpha = f.skill("alpha");
    const pack = f.pack("tools", "1.0.0", ["alpha"]);
    const options = { ...f.options, scope: "project" };
    f.manifest("project", { inherit_global: false, skills: ["alpha"] });
    ok(await sync(options));
    f.manifest("project", { packs: ["tools"] });
    finding(injectSync(options, mode), "E_SYNC_PARTIAL", 4);
    const before = snapshot(f.root);
    ok(await planSync(options));
    assert.deepEqual(snapshot(f.root), before);
    const recovered = ok(await sync(options));
    assert.equal(realpathSync(activation(f.project)), join(pack, "skills"));
    assert.ok(existsSync(join(alpha, "SKILL.md")));
    assert.ok(!receipt(recovered).value.data.pending);
    assert.deepEqual(
      readdirSync(join(f.project, ".agents")).filter((name) => name.startsWith(".skillex-tmp-")),
      [],
    );
  });
}

it("recovers a dead writer after publication using its recorded identity and bounded stale-lock cleanup", async (t) => {
  const f = fixture(t);
  f.skill("beta");
  const options = { ...f.options, scope: "project" };
  f.manifest("project", { inherit_global: false });
  ok(await sync(options));
  f.manifest("project", { inherit_global: false, skills: ["beta"] });
  injectSync(options, "published-kill");
  // A killed writer's old selection must not be replayed after intent changes.
  f.manifest("project", { inherit_global: false });
  ok(await sync(options));
  assert.equal(existsSync(join(activation(f.project), "beta")), false);
  assert.deepEqual(ok(await planSync(options)).changes, []);
});

it("refuses recovery when foreign interference occupies a pending destination", async (t) => {
  const f = fixture(t);
  f.skill("beta");
  const options = { ...f.options, scope: "project" };
  f.manifest("project", { inherit_global: false });
  ok(await sync(options));
  f.manifest("project", { inherit_global: false, skills: ["beta"] });
  finding(injectSync(options, "foreign"), "E_SYNC_PARTIAL", 4);
  const before = snapshot(f.root);
  finding(await sync(options), "E_OWNERSHIP_CHANGED");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(readFileSync(join(activation(f.project), "beta"), "utf8"), "Foreign interference\n");
});

it("does not prune an earlier scope when a later scope addition fails", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.skill("beta");
  f.manifest("global", { skills: ["alpha"] });
  f.manifest("project", { inherit_global: false });
  ok(await sync(f.options));
  f.manifest("global", {});
  f.manifest("project", { inherit_global: false, skills: ["beta"] });
  finding(injectSync(f.options, "child"), "E_SYNC_PARTIAL", 4);
  assert.equal(realpathSync(join(activation(f.home), "alpha")), alpha);
  const recovered = ok(await sync(f.options));
  assert.equal(existsSync(join(activation(f.home), "alpha")), false);
  assert.equal(
    realpathSync(join(activation(f.project), "beta")),
    join(f.registry, "all-skills", "beta"),
  );
  assert.ok(!receipt(recovered).value.data.pending);
});

function injectBoundary(options, mode) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const options = JSON.parse(process.argv[1]);
const mode = process.argv[2];
const root = join(options.cwd, '.agents', 'skills');
const originalStat = fs.lstat;
const originalRename = fs.rename;
const controller = new AbortController();
if (mode === 'cancel') options.signal = controller.signal;
let reads = 0;
let changed = false;
fs.lstat = async (...args) => {
  if (mode === 'root-swap' && args[0] === root && ++reads === 5) {
    await originalRename(root, join(options.cwd, 'parked-original'));
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'foreign.txt'), 'Preserve foreign root\\n');
  }
  const info = await originalStat(...args);
  if (mode === 'cross-device' && args[0] === join(options.cwd, '.codex')) info.dev += typeof info.dev === 'bigint' ? 1n : 1;
  return info;
};
fs.rename = async (...args) => {
  const result = await originalRename(...args);
  if (!changed && args[1].includes('/activations/v2/') && args[1].endsWith('.json')) {
    const receipt = JSON.parse(await fs.readFile(args[1], 'utf8'));
    if (receipt.data.pending) {
      changed = true;
      if (mode === 'source-skill') await fs.unlink(join(options.registryRoot, 'all-skills', 'beta', 'SKILL.md'));
      if (mode === 'source-pack') await fs.unlink(join(options.registryRoot, 'packs', 'tools', '1.0.0', 'skills', 'alpha'));
      if (mode === 'cancel') controller.abort();
    }
  }
  return result;
};
syncBuiltinESMExports();
const { sync } = await import('@delorenj/skillex');
process.stdout.write(JSON.stringify(await sync(options)));`,
      JSON.stringify(options),
      mode,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  return JSON.parse(child.stdout);
}

it("rechecks the activation-root inode captured during planning before child writes", async (t) => {
  const f = fixture(t);
  for (const name of ["alpha", "beta"]) f.skill(name);
  const options = { ...f.options, scope: "project" };
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  ok(await sync(options));
  f.manifest("project", { inherit_global: false, skills: ["alpha", "beta"] });
  finding(injectBoundary(options, "root-swap"), "E_OWNERSHIP_CHANGED");
  assert.equal(
    readFileSync(join(activation(f.project), "foreign.txt"), "utf8"),
    "Preserve foreign root\n",
  );
  assert.equal(existsSync(join(activation(f.project), "beta")), false);
  assert.equal(lstatSync(join(f.project, "parked-original", "alpha")).isSymbolicLink(), true);
});

for (const kind of ["skill", "pack"]) {
  it(`revalidates ${kind} sources after journaling and before publication`, async (t) => {
    const f = fixture(t);
    f.skill("alpha");
    f.skill("beta");
    f.pack("tools", "1.0.0", ["alpha"]);
    const options = { ...f.options, scope: "project" };
    f.manifest("project", { inherit_global: false });
    ok(await sync(options));
    f.manifest(
      "project",
      kind === "skill" ? { inherit_global: false, skills: ["beta"] } : { packs: ["tools"] },
    );
    const result = injectBoundary(options, `source-${kind}`);
    finding(result, "E_SYNC_PARTIAL", 4);
    finding(result, kind === "skill" ? "E_SKILL_MISSING" : "E_PACK_LINK_MISSING", 4);
    assert.equal(lstatSync(activation(f.project)).isDirectory(), true);
    assert.deepEqual(readdirSync(activation(f.project)), []);
  });
}

it("returns interruption before writes for already-aborted planning and sync", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const before = snapshot(f.root);
  for (const result of [
    await planSync({ ...f.options, signal: controller.signal }),
    await sync({ ...f.options, signal: controller.signal }),
    await sync({ ...f.options, dryRun: true, signal: controller.signal }),
  ])
    finding(result, "E_INTERRUPTED", 130);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("returns 130 at a journaled cancellation boundary and safely recovers on retry", async (t) => {
  const f = fixture(t);
  f.skill("beta");
  const options = { ...f.options, scope: "project" };
  f.manifest("project", { inherit_global: false });
  const initial = ok(await sync(options));
  f.manifest("project", { inherit_global: false, skills: ["beta"] });
  const interrupted = injectBoundary(options, "cancel");
  finding(interrupted, "E_INTERRUPTED", 130);
  finding(interrupted, "E_SYNC_PARTIAL", 130);
  assert.ok(receipt(initial).value.data.pending);
  assert.equal(existsSync(join(activation(f.project), "beta")), false);
  ok(await sync(options));
  assert.deepEqual(ok(await planSync(options)).changes, []);
});

it("cancellation while waiting for the bounded lock returns 130 instead of contention", async (t) => {
  const f = fixture(t);
  await withLock(
    "skillex:activation:v2",
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        finding(
          await sync({ ...f.options, scope: "project", timeoutMs: 80, signal: controller.signal }),
          "E_INTERRUPTED",
          130,
        );
      } finally {
        clearTimeout(timer);
      }
    },
    f.options,
  );
  assert.equal(existsSync(activation(f.project)), false);
});

it("records actual local Git commit hashes for the catalog and pack sources", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  const pack = f.pack("tools", "1.0.0", ["alpha"]);
  const git = (args, input = "") => {
    const result = spawnSync("git", ["-C", f.registry, ...args], { encoding: "utf8", input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  const tree = git(["mktree"]);
  const commit = git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      "--no-gpg-sign",
      tree,
    ],
    "Receipt revision fixture\n",
  );
  git(["update-ref", "refs/heads/fixture", commit]);
  git(["symbolic-ref", "HEAD", "refs/heads/fixture"]);
  f.manifest("project", { packs: ["tools"] });
  const result = ok(await sync({ ...f.options, scope: "project" }));
  assert.deepEqual(receipt(result).value.data.sources, [
    { kind: "catalog", path: join(f.registry, "all-skills"), commit, reason: null },
    { kind: "pack", path: pack, commit, reason: null },
  ]);
});

it("refuses cross-device alias staging during readonly preflight", async (t) => {
  const f = fixture(t);
  f.directory(join(f.project, ".codex"));
  const before = snapshot(f.root);
  const result = injectBoundary({ ...f.options, scope: "project" }, "cross-device");
  const refusal = finding(result, "E_ACTIVATION_FILESYSTEM");
  assert.equal(refusal.path, join(f.project, ".codex", "skills"));
  assert.match(refusal.fix, /same local filesystem/);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});
