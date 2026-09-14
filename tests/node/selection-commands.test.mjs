import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  disableSelection,
  enableSelection,
  initScope,
  planSync,
  setInheritance,
  sync,
  withLock,
} from "@delorenj/skillex";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-selection-"));
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
  function manifest(scope, raw) {
    return file(manifestPath(scope === "global" ? home : project), JSON.stringify(raw));
  }
  function skill(name) {
    const path = join(registry, "all-skills", name);
    file(join(path, "SKILL.md"), `# ${name}\n`);
    return path;
  }
  function set(name, members) {
    const path = directory(join(registry, "sets", name));
    for (const member of members) link(join(path, member), join(registry, "all-skills", member));
    return path;
  }
  function pack(name, version, members) {
    const path = join(registry, "packs", name, version);
    file(
      join(path, "pack.toml"),
      `[pack]\nname=${JSON.stringify(name)}\nversion=${JSON.stringify(version)}\n[freeform]\nskills=${JSON.stringify(members)}\n`,
    );
    directory(join(path, "skills"));
    for (const member of members)
      link(join(path, "skills", member), join(registry, "all-skills", member));
    return path;
  }
  directory(join(project, ".git"));
  directory(join(registry, "all-skills"));
  manifest("global", { inherit_global: false });
  manifest("project", { inherit_global: true });
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
    set,
    pack,
  };
}

function manifestPath(root) {
  return join(root, ".agents", "skills.json");
}
function activation(root) {
  return join(root, ".agents", "skills");
}
function declaration(root) {
  return JSON.parse(readFileSync(manifestPath(root), "utf8"));
}
function snapshot(root) {
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.mode,
      info.mtimeMs,
      info.ino,
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

it("initializes the nearest Git project without a registry or activation and preserves existing bytes", async (t) => {
  const f = fixture(t);
  rmSync(join(f.project, ".agents"), { recursive: true });
  rmSync(f.registry, { recursive: true });
  const nested = f.directory(join(f.project, "src", "nested"));
  const initialized = ok(await initScope({ ...f.options, cwd: nested }));
  assert.equal(initialized.scope, "project");
  assert.equal(initialized.root, f.project);
  assert.equal(initialized.saved, true);
  assert.deepEqual(initialized.manifest, { inherit_global: true });
  assert.deepEqual(
    initialized.applied.map((change) => change.action),
    ["write-manifest"],
  );
  assert.equal(existsSync(activation(f.project)), false);
  assert.equal(existsSync(join(f.project, ".claude")), false);
  f.file(manifestPath(f.project), '{ "skills": ["still-missing"], "inherit_global": false }\n');
  chmodSync(manifestPath(f.project), 0o640);
  const before = snapshot(f.root);
  const repeat = ok(await initScope({ ...f.options, cwd: nested }));
  assert.equal(repeat.changed, false);
  assert.equal(repeat.saved, false);
  assert.deepEqual(repeat.changes, []);
  assert.deepEqual(snapshot(f.root), before);
});

it("initializes global or explicit non-Git scopes and refuses conflicting scope identities", async (t) => {
  const f = fixture(t);
  unlinkSync(manifestPath(f.home));
  const global = ok(await initScope({ ...f.options, cwd: f.home }));
  assert.equal(global.scope, "global");
  assert.deepEqual(declaration(f.home), { inherit_global: false });
  const external = f.directory(join(f.root, "external"));
  const project = ok(await initScope({ ...f.options, project: external }));
  assert.equal(project.scope, "project");
  assert.deepEqual(declaration(external), { inherit_global: true });
  const before = snapshot(f.root);
  finding(await initScope({ ...f.options, project: f.home }), "E_PROJECT_ROOT", 2);
  finding(await initScope({ ...f.options, project: external, scope: "global" }), "E_SCOPE", 2);
  finding(await initScope({ ...f.options, scope: "both" }), "E_SCOPE", 2);
  assert.deepEqual(snapshot(f.root), before);
});

it("previews init without creating state and rejects state placement inside the new project", async (t) => {
  const f = fixture(t);
  rmSync(join(f.project, ".agents"), { recursive: true });
  const before = snapshot(f.root);
  const preview = ok(await initScope({ ...f.options, dryRun: true }));
  assert.equal(preview.saved, false);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(
    preview.changes.map((change) => change.action),
    ["write-manifest"],
  );
  assert.deepEqual(preview.applied, []);
  assert.deepEqual(snapshot(f.root), before);
  finding(
    await initScope({ ...f.options, stateHome: join(f.project, "state") }),
    "E_RECEIPT_UNSAFE_PATH",
  );
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("enables from a nested project while leaving global intent and activation untouched", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  f.manifest("global", { inherit_global: false, skills: ["alpha"] });
  const globalBefore = snapshot(f.home);
  const nested = f.directory(join(f.project, "src", "deep"));
  const enabled = ok(await enableSelection("skill", "beta", { ...f.options, cwd: nested }));
  assert.equal(enabled.scope, "project");
  assert.equal(enabled.saved, true);
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.equal(realpathSync(join(activation(f.project), "beta")), beta);
  assert.deepEqual(snapshot(f.home), globalBefore);
  const projectBefore = snapshot(f.project);
  const global = ok(
    await enableSelection("skill", "beta", { ...f.options, cwd: nested, scope: "global" }),
  );
  assert.equal(global.scope, "global");
  assert.deepEqual(declaration(f.home).skills, ["alpha", "beta"]);
  assert.equal(realpathSync(join(activation(f.home), "beta")), beta);
  assert.deepEqual(snapshot(f.project), projectBefore);
});

it("uses global for a checkout with no manifest and requires init for an explicitly selected project", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  rmSync(join(f.project, ".agents"), { recursive: true });
  const before = snapshot(f.root);
  finding(
    await enableSelection("skill", "alpha", { ...f.options, scope: "project" }),
    "E_MANIFEST_MISSING",
    2,
  );
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(ok(await enableSelection("skill", "alpha", f.options)).scope, "global");
  assert.equal(existsSync(manifestPath(f.project)), false);
  assert.equal(existsSync(activation(f.project)), false);
  assert.deepEqual(declaration(f.home).skills, ["alpha"]);
});

it("masks inherited and set members locally, then re-enables an explicit canonical skill", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.skill("beta");
  const set = f.set("tools", ["alpha", "beta"]);
  f.manifest("global", { skills: ["alpha"] });
  f.manifest("project", { sets: ["tools"], skills: [{ name: "alpha" }] });
  ok(await sync({ ...f.options, scope: "project" }));
  const globalBefore = snapshot(f.home);
  const setBefore = snapshot(set);
  const disabled = ok(await disableSelection("skill", "alpha", f.options));
  assert.deepEqual(disabled.manifest.skills, []);
  assert.deepEqual(disabled.manifest.exclude, ["alpha"]);
  assert.equal(existsSync(join(activation(f.project), "alpha")), false);
  assert.equal(existsSync(join(activation(f.project), "beta")), true);
  const enabled = ok(await enableSelection("skill", "alpha", f.options));
  assert.deepEqual(enabled.manifest.skills, ["alpha"]);
  assert.deepEqual(enabled.manifest.exclude, []);
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.deepEqual(snapshot(f.home), globalBefore);
  assert.deepEqual(snapshot(set), setBefore);
});

it("preserves an existing filtered optional set and repairs activation on a declaration no-op", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.skill("beta");
  f.set("tools", ["alpha", "beta"]);
  f.file(
    manifestPath(f.project),
    '{ "inherit_global": false, "sets": [{"name":"tools","include":["alpha"],"optional":true}] }\n',
  );
  chmodSync(manifestPath(f.project), 0o640);
  const bytes = readFileSync(manifestPath(f.project));
  const inode = lstatSync(manifestPath(f.project)).ino;
  const enabled = ok(await enableSelection("set", "tools", f.options));
  assert.equal(enabled.changed, false);
  assert.equal(enabled.saved, false);
  assert.ok(enabled.applied.some((change) => change.action === "create-directory"));
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.equal(existsSync(join(activation(f.project), "beta")), false);
  assert.deepEqual(readFileSync(manifestPath(f.project)), bytes);
  assert.equal(lstatSync(manifestPath(f.project)).ino, inode);
  const before = snapshot(f.root);
  assert.deepEqual(ok(await enableSelection("set", "tools", f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), before);
});

it("retains dormant selections through pack switches and restores them only for a matching disable", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.skill("beta");
  const first = f.pack("tools", "1.0.0", ["beta"]);
  const second = f.pack("tools", "2.0.0", ["alpha", "beta"]);
  f.manifest("project", { inherit_global: false, skills: [{ name: "alpha" }], exclude: ["beta"] });
  ok(await sync({ ...f.options, scope: "project" }));
  const packed = ok(await enableSelection("pack", "tools@1.0.0", f.options));
  assert.deepEqual(packed.manifest.skills, [{ name: "alpha" }]);
  assert.deepEqual(packed.manifest.exclude, ["beta"]);
  assert.equal(realpathSync(activation(f.project)), join(first, "skills"));
  const before = snapshot(f.root);
  for (const operation of [
    enableSelection("skill", "beta", f.options),
    disableSelection("set", "missing", f.options),
    setInheritance(true, f.options),
  ])
    finding(await operation, "E_PACK_ACTIVE");
  finding(await disableSelection("pack", "different", f.options), "E_PACK_SELECTION_MISMATCH");
  finding(await disableSelection("pack", "tools@2.0.0", f.options), "E_PACK_SELECTION_MISMATCH");
  assert.deepEqual(snapshot(f.root), before);
  ok(await enableSelection("pack", "tools@2.0.0", f.options));
  assert.equal(realpathSync(activation(f.project)), join(second, "skills"));
  ok(await disableSelection("pack", "tools", f.options));
  assert.equal(lstatSync(activation(f.project)).isDirectory(), true);
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.equal(existsSync(join(activation(f.project), "beta")), false);
  assert.deepEqual(declaration(f.project).packs, []);
});

it("removes missing direct declarations without looking up their absent sources", async (t) => {
  const f = fixture(t);
  for (const [kind, raw, reference] of [
    ["skill", { skills: ["gone"] }, "gone"],
    ["set", { sets: ["gone"] }, "gone"],
    ["pack", { packs: ["gone@1.0.0"] }, "gone"],
  ]) {
    f.manifest("project", { inherit_global: false, ...raw });
    const removed = ok(await disableSelection(kind, reference, f.options));
    assert.equal(removed.saved, true);
    assert.equal(existsSync(join(activation(f.project), "gone")), false);
  }
  const before = snapshot(f.root);
  const noop = ok(await disableSelection("pack", "already-absent@3.0.0", f.options));
  assert.deepEqual(noop.changes, []);
  assert.deepEqual(snapshot(f.root), before);
});

it("refuses a local exclusion when a retained required set still names a missing source", async (t) => {
  const f = fixture(t);
  f.set("tools", ["gone"]);
  f.manifest("project", { inherit_global: false, skills: ["gone"], sets: ["tools"] });
  const before = snapshot(f.root);
  const result = await disableSelection("skill", "gone", f.options);
  assert.equal(result.exit, 3, JSON.stringify(result.findings));
  assert.ok(
    result.findings.some((item) => item.fix?.includes("Retained set or inherited selections")),
    JSON.stringify(result.findings),
  );
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("toggles inheritance only for the selected project and preserves global state", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  f.manifest("global", { skills: ["alpha"] });
  f.manifest("project", { skills: ["beta"] });
  ok(await sync(f.options));
  const globalBefore = snapshot(f.home);
  ok(await setInheritance(false, f.options));
  assert.equal(declaration(f.project).inherit_global, false);
  assert.equal(existsSync(join(activation(f.project), "alpha")), false);
  assert.equal(realpathSync(join(activation(f.project), "beta")), beta);
  ok(await setInheritance(true, f.options));
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
  assert.deepEqual(snapshot(f.home), globalBefore);
  const before = snapshot(f.root);
  finding(await setInheritance(false, { ...f.options, scope: "global" }), "E_SCOPE", 2);
  assert.deepEqual(snapshot(f.root), before);
});

it("refuses malformed or unknown enables and foreign activation collisions before any writes", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  let before = snapshot(f.root);
  finding(await enableSelection("skill", "Upper/Unsafe", f.options), "E_MANIFEST_INVALID", 2);
  finding(await enableSelection("skill", "absent", f.options), "E_SKILL_MISSING");
  assert.deepEqual(snapshot(f.root), before);
  f.file(join(activation(f.project), "alpha"), "Preserve foreign contents\n");
  before = snapshot(f.root);
  const collision = await enableSelection("skill", "alpha", f.options);
  assert.equal(collision.exit, 3, JSON.stringify(collision.findings));
  assert.ok(collision.findings.every((item) => item.fix));
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("previews the proposed declaration and complete activation changes without writes", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  const before = snapshot(f.root);
  const result = ok(await enableSelection("skill", "alpha", { ...f.options, dryRun: true }));
  assert.equal(result.changed, true);
  assert.equal(result.saved, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.manifest.skills, ["alpha"]);
  assert.ok(result.changes.some((change) => change.action === "write-manifest"));
  assert.ok(result.changes.some((change) => change.path === join(f.project, ".claude", "skills")));
  assert.deepEqual(result.applied, []);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("serializes concurrent selection edits without losing either declaration", async (t) => {
  const f = fixture(t);
  for (const name of ["alpha", "beta", "gamma"]) f.skill(name);
  const results = await Promise.all(
    ["alpha", "beta", "gamma"].map((name) => enableSelection("skill", name, f.options)),
  );
  for (const result of results) ok(result);
  assert.deepEqual([...declaration(f.project).skills].sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual(ok(await planSync({ ...f.options, scope: "project" })).changes, []);
});

function injectSelection(options, mode) {
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
const path = join(options.cwd, '.agents', 'skills.json');
const rename = fs.rename;
const readFile = fs.readFile;
const controller = new AbortController();
let saved = false;
if (mode === 'cancel') options.signal = controller.signal;
fs.rename = async (...args) => {
  if (args[1] !== path) return rename(...args);
  if (mode === 'before-save') throw Object.assign(new Error('Injected manifest publication failure'), {code:'EIO'});
  const result = await rename(...args);
  saved = true;
  if (mode === 'cancel') controller.abort();
  if (mode === 'collision') await fs.writeFile(join(options.cwd, '.agents', 'skills', 'alpha'), 'Foreign content\\n');
  return result;
};
fs.readFile = async (...args) => {
  if (mode === 'foreign-intent' && saved && args[0] === path) {
    saved = false;
    await fs.writeFile(path, JSON.stringify({inherit_global:false,skills:['beta']}));
  }
  return readFile(...args);
};
syncBuiltinESMExports();
const { enableSelection } = await import('@delorenj/skillex');
process.stdout.write(JSON.stringify(await enableSelection('skill', 'alpha', options)));
`,
      JSON.stringify(options),
      mode,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  return JSON.parse(child.stdout);
}

it("reports saved intent honestly when a post-save activation collision occurs and sync recovers", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  ok(await sync({ ...f.options, scope: "project" }));
  const result = injectSelection(f.options, "collision");
  finding(result, "E_SELECTION_PARTIAL", 4);
  assert.equal(result.data.saved, true);
  assert.deepEqual(
    result.data.applied.map((change) => change.action),
    ["write-manifest"],
  );
  assert.deepEqual(declaration(f.project).skills, ["alpha"]);
  assert.equal(readFileSync(join(activation(f.project), "alpha"), "utf8"), "Foreign content\n");
  unlinkSync(join(activation(f.project), "alpha"));
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
});

it("keeps original intent on publication failure and reports saved intent on cancellation", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  ok(await sync({ ...f.options, scope: "project" }));
  const bytes = readFileSync(manifestPath(f.project));
  const activeBefore = snapshot(activation(f.project));
  const failed = injectSelection(f.options, "before-save");
  finding(failed, "E_IO", 1);
  assert.equal(failed.data.saved, false);
  assert.deepEqual(readFileSync(manifestPath(f.project)), bytes);
  assert.deepEqual(snapshot(activation(f.project)), activeBefore);
  const interrupted = injectSelection(f.options, "cancel");
  finding(interrupted, "E_INTERRUPTED", 130);
  finding(interrupted, "E_SELECTION_PARTIAL", 130);
  assert.equal(interrupted.data.saved, true);
  assert.deepEqual(declaration(f.project).skills, ["alpha"]);
  assert.deepEqual(snapshot(activation(f.project)), activeBefore);
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(realpathSync(join(activation(f.project), "alpha")), alpha);
});

it("refuses different foreign intent at the saved-manifest read boundary", async (t) => {
  const f = fixture(t);
  for (const name of ["alpha", "beta"]) f.skill(name);
  ok(await sync({ ...f.options, scope: "project" }));
  const activeBefore = snapshot(activation(f.project));
  const result = injectSelection(f.options, "foreign-intent");
  finding(result, "E_MANIFEST_CHANGED", 4);
  finding(result, "E_SELECTION_PARTIAL", 4);
  assert.equal(result.data.saved, true);
  assert.deepEqual(declaration(f.project).skills, ["beta"]);
  assert.deepEqual(snapshot(activation(f.project)), activeBefore);
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(existsSync(join(activation(f.project), "alpha")), false);
  assert.equal(existsSync(join(activation(f.project), "beta")), true);
});

it("returns interruption before any writes and after an aborted contention wait", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  const before = snapshot(f.root);
  finding(
    await enableSelection("skill", "alpha", {
      ...f.options,
      signal: { aborted: true },
      dryRun: true,
    }),
    "E_INTERRUPTED",
    130,
  );
  assert.deepEqual(snapshot(f.root), before);
  const controller = new AbortController();
  await withLock(
    "skillex:activation:v2",
    async () => {
      const timer = setTimeout(() => controller.abort(), 25);
      try {
        const result = await enableSelection("skill", "alpha", {
          ...f.options,
          timeoutMs: 75,
          signal: controller.signal,
        });
        finding(result, "E_INTERRUPTED", 130);
      } finally {
        clearTimeout(timer);
      }
    },
    f.options,
  );
  assert.deepEqual(declaration(f.project), { inherit_global: true });
  assert.equal(existsSync(activation(f.project)), false);
});
