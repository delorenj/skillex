import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { readActivationReceipt, showProfile, syncProfile } from "@delorenj/skillex";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-profile-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, value) => {
    directory(dirname(path));
    writeFileSync(path, value);
    return path;
  };
  const home = directory(join(root, "home"));
  const project = directory(join(root, "project"));
  const registry = directory(join(root, "registry"));
  const hermesRoot = directory(join(root, "hermes"));
  const profile = directory(join(hermesRoot, "profiles", "work"));
  const skills = directory(join(profile, "skills"));
  const stateHome = join(root, "state");
  const options = {
    home,
    project,
    registryRoot: registry,
    hermesRoot,
    stateHome,
    cwd: root,
    env: {},
    timeoutMs: 10_000,
  };
  const manifest = (scope, value) =>
    file(
      join(scope === "global" ? home : project, ".agents", "skills.json"),
      JSON.stringify(value),
    );
  const skill = (name, selectedRegistry = registry) => {
    const path = join(selectedRegistry, "all-skills", name);
    file(join(path, "SKILL.md"), `# ${name}\n`);
    return path;
  };
  directory(join(project, ".git"));
  skill("alpha");
  skill("beta");
  skill("gamma");
  skill("constructor");
  manifest("global", { inherit_global: false, skills: ["alpha"] });
  manifest("project", { inherit_global: true, skills: ["beta"] });
  return {
    root,
    home,
    project,
    registry,
    hermesRoot,
    profile,
    skills,
    stateHome,
    options,
    directory,
    file,
    manifest,
    skill,
  };
}
function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result, null, 2));
  return result.data;
}
function snapshot(root) {
  const entries = [];
  const visit = (path) => {
    const info = lstatSync(path);
    entries.push([
      relative(root, path),
      info.mode,
      info.ino,
      info.mtimeMs,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return entries;
}
async function immutable(f, action) {
  const before = snapshot(f.root);
  const result = await action();
  assert.deepEqual(snapshot(f.root), before);
  return result;
}
function receipt(f) {
  const directory = join(f.stateHome, "skillex", "profiles", "v2");
  const names = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(names.length, 1);
  const path = join(directory, names[0]);
  return { path, document: JSON.parse(readFileSync(path, "utf8")) };
}
function child(f, injection, options = {}, command = "syncProfile", runtime = {}) {
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs/promises'); const syncfs = require('node:fs');
${injection}
syncBuiltinESMExports();
const { syncProfile, showProfile } = await import('@delorenj/skillex');
const options = ${JSON.stringify({ ...f.options, ...options })};
if (typeof fixtureSignal !== 'undefined') options.signal = fixtureSignal;
process.stdout.write(JSON.stringify(await ${command}('work',options)));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    ...runtime,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

it("projects global and project canonical children while preserving the real directory and source roots", async (t) => {
  const f = fixture(t);
  const rootInode = lstatSync(f.skills).ino;
  const sourceBefore = [snapshot(f.home), snapshot(f.project), snapshot(f.registry)];
  f.file(join(f.skills, "overlay", "SKILL.md"), "# Hermes local overlay\n");
  const overlay = snapshot(join(f.skills, "overlay"));
  const data = ok(await syncProfile("work", f.options));
  assert.equal(lstatSync(f.skills).ino, rootInode);
  assert.equal(lstatSync(f.skills).isDirectory(), true);
  assert.deepEqual(
    data.managed.map((item) => [item.name, item.winner]),
    [
      ["alpha", "global"],
      ["beta", "project"],
    ],
  );
  assert.equal(realpathSync(join(f.skills, "alpha")), join(f.registry, "all-skills", "alpha"));
  assert.equal(realpathSync(join(f.skills, "beta")), join(f.registry, "all-skills", "beta"));
  assert.deepEqual(snapshot(join(f.skills, "overlay")), overlay);
  assert.deepEqual([snapshot(f.home), snapshot(f.project), snapshot(f.registry)], sourceBefore);
  const stored = receipt(f);
  assert.equal(stored.document.activationRoot, f.skills);
  assert.equal(stored.document.scopeRoot, f.profile);
  assert.equal(stored.document.data.project, f.project);
  assert.equal(stored.document.data.root.ino, String(rootInode));
  assert.deepEqual(Object.keys(stored.document.data.links).sort(), ["alpha", "beta"]);
  assert.ok(stored.document.data.sources.some((source) => source.kind === "catalog"));
  const activation = await readActivationReceipt(f.project, f.options);
  assert.ok(activation.path.includes(`${join("activations", "v2")}/`));
  assert.equal(activation.document, undefined);
});

it("project inheritance and masks apply only to project contribution, including flattened pack declarations", async (t) => {
  const f = fixture(t);
  f.manifest("project", { inherit_global: false, skills: ["beta"], exclude: ["alpha"] });
  ok(await syncProfile("work", f.options));
  assert.deepEqual(Object.keys(receipt(f).document.data.links).sort(), ["alpha", "beta"]);
  const pack = join(f.registry, "packs", "suite", "1");
  f.file(
    join(pack, "pack.toml"),
    '[pack]\nname="suite"\nversion="1"\n[freeform]\nskills=["gamma"]\n',
  );
  // These generated links are not used when a profile flattens manifest-authoritative members.
  f.directory(join(pack, "skills"));
  symlinkSync("/not-a-definition", join(pack, "skills", "wrong"));
  f.manifest("project", { packs: ["suite@1"], skills: ["missing-dormant"] });
  const data = ok(await syncProfile("work", f.options));
  assert.deepEqual(
    data.managed.map((item) => item.name),
    ["alpha", "gamma"],
  );
  assert.equal(existsSync(join(f.skills, "beta")), false);
  assert.equal(lstatSync(f.skills).isDirectory(), true);
  assert.ok(
    receipt(f).document.data.sources.some(
      (source) => source.kind === "pack" && source.path === pack,
    ),
  );
});

it("matching foreign links and real local definitions win without being adopted or pruned", async (t) => {
  const f = fixture(t);
  symlinkSync(join(f.registry, "all-skills", "alpha"), join(f.skills, "alpha"));
  f.file(join(f.skills, "beta", "SKILL.md"), "# local beta\n");
  const local = snapshot(f.skills);
  const data = ok(await syncProfile("work", f.options));
  assert.deepEqual(snapshot(f.skills), local);
  assert.ok(data.managed.every((item) => item.state === "shadowed" && item.winner === "profile"));
  assert.deepEqual(receipt(f).document.data.links, {});
  f.manifest("global", {});
  f.manifest("project", { inherit_global: false });
  ok(await syncProfile("work", f.options));
  assert.deepEqual(snapshot(f.skills), local);
});

it("local replacement relinquishes its claim while stale exact owned links alone are pruned", async (t) => {
  const f = fixture(t);
  ok(await syncProfile("work", f.options));
  unlinkSync(join(f.skills, "alpha"));
  f.file(join(f.skills, "alpha"), "local replacement\n");
  const local = snapshot(join(f.skills, "alpha"));
  f.manifest("global", {});
  f.manifest("project", { inherit_global: false });
  const data = ok(await syncProfile("work", f.options));
  assert.ok(data.applied.some((change) => change.action === "release" && change.name === "alpha"));
  assert.ok(data.applied.some((change) => change.action === "prune" && change.name === "beta"));
  assert.deepEqual(snapshot(join(f.skills, "alpha")), local);
  assert.equal(existsSync(join(f.skills, "beta")), false);
  assert.deepEqual(receipt(f).document.data.links, {});
});

it("dry-run is fully immutable and a converged sync preserves receipt bytes and inode", async (t) => {
  const f = fixture(t);
  const preview = ok(await immutable(f, () => syncProfile("work", { ...f.options, dryRun: true })));
  assert.deepEqual(preview.applied, []);
  assert.ok(preview.changes.some((change) => change.action === "write-receipt"));
  assert.equal(existsSync(f.stateHome), false);
  ok(await syncProfile("work", f.options));
  const result = ok(await immutable(f, () => syncProfile("work", f.options)));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.applied, []);
});

it("missing real skills roots may be created and empty projection context is visible and idempotent", async (t) => {
  const f = fixture(t);
  rmSync(f.skills, { recursive: true });
  f.manifest("global", {});
  f.manifest("project", { inherit_global: false });
  const preview = ok(await immutable(f, () => syncProfile("work", { ...f.options, dryRun: true })));
  assert.deepEqual(
    preview.changes.map((change) => change.action),
    ["mkdir", "write-receipt"],
  );
  assert.equal(preview.profile.skills.kind, "missing");
  const data = ok(await syncProfile("work", f.options));
  assert.ok(data.applied.some((change) => change.action === "mkdir"));
  assert.equal(data.profile.skills.kind, "directory");
  assert.equal(lstatSync(f.skills).isDirectory(), true);
  assert.deepEqual(ok(await immutable(f, () => syncProfile("work", f.options))).changes, []);
});

it("missing required sources, invalid state placement, and whole-root aliases refuse before profile writes", async (t) => {
  const f = fixture(t);
  f.manifest("project", { skills: ["missing"] });
  const missing = await immutable(f, () => syncProfile("work", f.options));
  assert.equal(missing.exit, 3);
  f.manifest("project", { skills: ["beta"] });
  const placement = await immutable(f, () =>
    syncProfile("work", { ...f.options, stateHome: join(f.project, "state") }),
  );
  assert.equal(placement.exit, 3);
  rmSync(f.skills, { recursive: true });
  symlinkSync(join(f.registry, "all-skills"), f.skills);
  const alias = await immutable(f, () => syncProfile("work", f.options));
  assert.equal(alias.exit, 3);
  assert.ok(alias.findings.some((finding) => finding.code === "E_PROFILE_SKILLS_ROOT"));
  assert.equal(existsSync(f.stateHome), false);
});

it("profile-local overrides cannot hide divergent canonical definitions", async (t) => {
  const f = fixture(t);
  const globalUrl = "https://example.invalid/global-profile.git";
  const projectUrl = "https://example.invalid/project-profile.git";
  for (const url of [globalUrl, projectUrl])
    f.skill(
      "alpha",
      join(f.home, ".agents", ".cache", "registries", url.replace(/[^a-zA-Z0-9]/g, "_")),
    );
  f.manifest("global", { registry: globalUrl, skills: ["alpha"] });
  f.manifest("project", { registry: projectUrl, inherit_global: false, skills: ["alpha"] });
  f.file(join(f.skills, "alpha", "SKILL.md"), "local shadow");
  const { registryRoot, ...options } = f.options;
  assert.ok(registryRoot);
  const result = await immutable(f, () => syncProfile("work", options));
  assert.equal(result.exit, 3);
  assert.ok(result.findings.some((finding) => finding.code === "E_DIVERGENT_CANONICAL_NAME"));
});

it("replaced root identity refuses while a constructor-named child works through receipt round trips", async (t) => {
  const f = fixture(t);
  f.manifest("project", { skills: ["constructor"] });
  ok(await syncProfile("work", f.options));
  assert.equal(receipt(f).document.data.links.constructor.kind, "link");
  ok(await immutable(f, () => syncProfile("work", f.options)));
  renameSync(f.skills, join(f.profile, "original-skills"));
  f.directory(f.skills);
  const result = await immutable(f, () => syncProfile("work", f.options));
  assert.equal(result.exit, 3);
  assert.ok(result.findings.some((finding) => finding.code === "E_PROFILE_ROOT_CHANGED"));
});

it("concurrent lexical aliases of one profile share its lock, receipt, and exact final selection", async (t) => {
  const f = fixture(t);
  symlinkSync(f.profile, join(f.hermesRoot, "profiles", "alias"));
  const secondProject = f.directory(join(f.root, "second"));
  f.file(
    join(secondProject, ".agents", "skills.json"),
    JSON.stringify({ inherit_global: false, skills: ["gamma"] }),
  );
  const results = await Promise.all([
    syncProfile("work", f.options),
    syncProfile("alias", { ...f.options, project: secondProject }),
  ]);
  for (const result of results) ok(result);
  const stored = receipt(f).document.data;
  const expected = stored.project === secondProject ? ["alpha", "gamma"] : ["alpha", "beta"];
  assert.deepEqual(Object.keys(stored.links).sort(), expected);
  assert.deepEqual(readdirSync(f.skills).sort(), expected);
});

it("an error after publication reports its applied prefix and preserves earlier stale links until retry", async (t) => {
  const f = fixture(t);
  f.manifest("project", { inherit_global: false });
  ok(await syncProfile("work", f.options));
  f.manifest("global", {});
  f.manifest("project", { inherit_global: false, skills: ["beta"] });
  const failed = child(
    f,
    `const original = fs.rename;
fs.rename = async (from, to) => { const result = await original(from,to); if(String(from).endsWith('-new') && String(to).endsWith('/beta')) throw Object.assign(new Error('after publish'), {code:'EIO'}); return result; };`,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.ok(
    failed.data.applied.some((change) => change.name === "beta" && change.action === "create"),
  );
  assert.equal(existsSync(join(f.skills, "alpha")), true);
  const observed = await immutable(f, () => showProfile("work", f.options));
  assert.equal(observed.exit, 4);
  assert.equal(observed.data.pending, true);
  assert.equal(observed.data.managed, null);
  assert.deepEqual(observed.data.changes, [{ action: "recover", path: f.skills }]);
  assert.equal(
    observed.data.preserved.some((entry) => entry.name === "beta"),
    false,
  );
  const preview = await immutable(f, () => syncProfile("work", { ...f.options, dryRun: true }));
  assert.equal(preview.exit, 4);
  assert.equal(preview.data.pending, true);
  assert.equal(preview.data.managed, null);
  assert.deepEqual(preview.data.changes, [{ action: "recover", path: f.skills }]);
  assert.equal(
    preview.data.preserved.some((entry) => entry.name === "beta"),
    false,
  );
  assert.deepEqual(preview.data.applied, []);
  assert.ok(preview.findings.some((finding) => finding.code === "W_PROFILE_RECOVERY_PENDING"));
  ok(await syncProfile("work", f.options));
  assert.deepEqual(readdirSync(f.skills), ["beta"]);
  assert.equal(receipt(f).document.data.pending, undefined);
});

it("a local replacement of an interrupted published link survives recovery and loses the old claim", async (t) => {
  const f = fixture(t);
  const failed = child(
    f,
    `const original = fs.rename;
fs.rename = async (from, to) => { const result = await original(from,to); if(String(from).endsWith('-new') && String(to).endsWith('/alpha')) throw Object.assign(new Error('after publish'), {code:'EIO'}); return result; };`,
  );
  assert.equal(failed.exit, 4);
  unlinkSync(join(f.skills, "alpha"));
  f.file(join(f.skills, "alpha", "SKILL.md"), "local replacement after interruption");
  const before = snapshot(join(f.skills, "alpha"));
  const data = ok(await syncProfile("work", f.options));
  assert.deepEqual(snapshot(join(f.skills, "alpha")), before);
  assert.equal(Object.hasOwn(receipt(f).document.data.links, "alpha"), false);
  assert.equal(data.managed.find((item) => item.name === "alpha").winner, "profile");
});

it("real process termination after parking restores recorded content before attempting missing current manifests", async (t) => {
  const f = fixture(t);
  f.manifest("project", { inherit_global: false });
  ok(await syncProfile("work", f.options));
  const original = lstatSync(join(f.skills, "alpha")).ino;
  f.manifest("global", {});
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises'); const original = fs.rename;
fs.rename = async (from,to) => { const result = await original(from,to); if(String(to).endsWith('-old')) process.kill(process.pid,'SIGKILL'); return result; };
syncBuiltinESMExports(); const {syncProfile} = await import('@delorenj/skillex'); await syncProfile('work',${JSON.stringify(f.options)});`;
  const processFixture = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [codeResult, signal] = await new Promise((resolve, reject) => {
    processFixture.on("error", reject);
    processFixture.on("close", (code, signal) => resolve([code, signal]));
  });
  assert.equal(codeResult, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(existsSync(join(f.skills, "alpha")), false);
  unlinkSync(join(f.project, ".agents", "skills.json"));
  const restored = await syncProfile("work", f.options);
  assert.equal(restored.exit, 4, JSON.stringify(restored));
  assert.ok(restored.data.applied.some((change) => change.action === "recover"));
  assert.equal(lstatSync(join(f.skills, "alpha")).ino, original);
  assert.equal(receipt(f).document.data.pending, undefined);
  f.manifest("project", { inherit_global: false, skills: ["beta"] });
  ok(await syncProfile("work", f.options));
  assert.deepEqual(readdirSync(f.skills), ["beta"]);
});

it("cancellation before planning is immutable and cancellation after publication leaves recoverable exact evidence", async (t) => {
  const f = fixture(t);
  const cancelled = await immutable(f, () =>
    syncProfile("work", { ...f.options, signal: { aborted: true } }),
  );
  assert.equal(cancelled.exit, 130);
  const interrupted = child(
    f,
    `const original = fs.rename;
const fixtureSignal = {aborted:false};
fs.rename = async (from,to) => { const result = await original(from,to); if(String(from).endsWith('-new')) fixtureSignal.aborted = true; return result; };`,
  );
  assert.equal(interrupted.exit, 130, JSON.stringify(interrupted));
  assert.ok(interrupted.data.applied.some((change) => change.action === "create"));
  ok(await syncProfile("work", f.options));
  assert.deepEqual(Object.keys(receipt(f).document.data.links).sort(), ["alpha", "beta"]);
});

it("real termination before staging is journaled preserves the unknown inode and reports it until explicitly removed", async (t) => {
  const f = fixture(t);
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises'); const original = fs.symlink;
fs.symlink = async (target,path,...rest) => { const result = await original(target,path,...rest); if(String(path).includes('.skillex-tmp-profile-') && String(path).endsWith('-new')) process.kill(process.pid,'SIGKILL'); return result; };
syncBuiltinESMExports(); const {syncProfile} = await import('@delorenj/skillex'); await syncProfile('work',${JSON.stringify(f.options)});`;
  const processFixture = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [codeResult, signal] = await new Promise((resolve, reject) => {
    processFixture.on("error", reject);
    processFixture.on("close", (code, signal) => resolve([code, signal]));
  });
  assert.equal(codeResult, null);
  assert.equal(signal, "SIGKILL");
  const artifacts = readdirSync(f.skills).filter((name) =>
    name.startsWith(".skillex-tmp-profile-"),
  );
  assert.equal(artifacts.length, 1);
  const path = join(f.skills, artifacts[0]);
  const artifact = snapshot(path);
  assert.equal(receipt(f).document.data.pending, undefined);
  const observed = await immutable(f, () => showProfile("work", f.options));
  assert.equal(observed.exit, 4);
  assert.ok(
    observed.findings.some(
      (finding) => finding.code === "W_PROFILE_RECOVERY_PRESERVED" && finding.path === path,
    ),
  );
  const resumed = await syncProfile("work", f.options);
  assert.equal(resumed.exit, 4, JSON.stringify(resumed));
  assert.deepEqual(snapshot(path), artifact);
  assert.deepEqual(Object.keys(receipt(f).document.data.links).sort(), ["alpha", "beta"]);
  const repeated = await immutable(f, () => syncProfile("work", f.options));
  assert.equal(repeated.exit, 4);
  assert.deepEqual(repeated.data.changes, []);
  assert.ok(repeated.findings.some((finding) => finding.path === path));
  unlinkSync(path);
  ok(await immutable(f, () => syncProfile("work", f.options)));
});

it("a failed pending receipt publication cleans only its exact known unjournaled stage before retry", async (t) => {
  const f = fixture(t);
  const failed = child(
    f,
    `const original = fs.rename;
fs.rename = async (from,to) => {
  if (String(to).includes('/profiles/v2/') && String(to).endsWith('.json') && JSON.parse(syncfs.readFileSync(from,'utf8')).data.pending) throw Object.assign(new Error('pending receipt publication failed'), {code:'EIO'});
  return original(from,to);
};`,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.deepEqual(readdirSync(f.skills), []);
  assert.equal(receipt(f).document.data.pending, undefined);
  assert.equal(
    failed.findings.some((finding) => finding.code === "W_PROFILE_RECOVERY_PRESERVED"),
    false,
  );
  ok(await syncProfile("work", f.options));
  assert.deepEqual(readdirSync(f.skills).sort(), ["alpha", "beta"]);
});

it("a local entry appearing after final preflight is preserved and reported as the winning partial result", async (t) => {
  const f = fixture(t);
  const path = join(f.skills, "alpha");
  const failed = child(
    f,
    `const original = fs.link;
fs.link = async (from,to) => { const result = await original(from,to); if(String(to).includes('/profiles/v2/') && String(to).endsWith('.json')) syncfs.writeFileSync(${JSON.stringify(path)},${JSON.stringify("late local override\n")},{flag:'wx'}); return result; };`,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.ok(failed.findings.some((finding) => finding.code === "E_PROFILE_CONTENT_CHANGED"));
  assert.equal(readFileSync(path, "utf8"), "late local override\n");
  assert.equal(failed.data.managed.find((item) => item.name === "alpha").winner, "profile");
  assert.ok(failed.data.preserved.some((item) => item.path === path && item.shadows));
  assert.equal(Object.hasOwn(receipt(f).document.data.links, "alpha"), false);
  const local = snapshot(path);
  ok(await syncProfile("work", f.options));
  assert.deepEqual(snapshot(path), local);
  assert.equal(Object.hasOwn(receipt(f).document.data.links, "alpha"), false);
});

it("tilde-expanded protected projects refuse state placement before creating lock or profile state", async (t) => {
  const f = fixture(t);
  rmSync(join(f.project, ".git"), { recursive: true });
  const project = join(f.home, "project");
  renameSync(f.project, project);
  const stateHome = join(project, "state");
  const result = await immutable(f, () =>
    syncProfile("work", { ...f.options, project: "~/project", stateHome }),
  );
  assert.equal(result.exit, 3, JSON.stringify(result));
  assert.ok(result.findings.some((finding) => finding.code === "E_RECEIPT_UNSAFE_PATH"));
  assert.equal(existsSync(stateHome), false);
  assert.equal(existsSync(f.stateHome), false);
});

it("a tilde home uses one normalized state location for the lock and receipt", async (t) => {
  const f = fixture(t);
  f.directory(join(f.root, "node_modules", "@delorenj"));
  symlinkSync(process.cwd(), join(f.root, "node_modules", "@delorenj", "skillex"));
  const result = child(f, "", { home: "~", stateHome: undefined }, "syncProfile", {
    cwd: f.root,
    env: { ...process.env, HOME: f.home },
  });
  const data = ok(result);
  assert.ok(
    data.receiptPath.startsWith(join(f.home, ".local", "state", "skillex", "profiles", "v2")),
  );
  assert.equal(existsSync(join(f.root, "~")), false);
  assert.equal(existsSync(f.stateHome), false);
  assert.deepEqual(readdirSync(f.skills).sort(), ["alpha", "beta"]);
});

it("a lexical profile alias retargeted during sync or read preflight refuses without writing either target", async (t) => {
  for (const command of ["syncProfile", "showProfile"]) {
    const f = fixture(t);
    const canonical = join(f.root, "canonical-profile");
    renameSync(f.profile, canonical);
    symlinkSync(canonical, f.profile);
    if (command === "syncProfile") ok(await syncProfile("work", f.options));
    const other = f.directory(join(f.root, "other-profile"));
    f.file(join(other, "skills", "local"), "local content\n");
    const observed = () => [
      snapshot(canonical),
      snapshot(other),
      existsSync(f.stateHome) ? snapshot(f.stateHome) : null,
    ];
    const before = observed();
    const result = child(
      f,
      `const original = fs.readdir; let swapped = false;
fs.readdir = async (path,...rest) => { const result = await original(path,...rest); if(!swapped && String(path) === ${JSON.stringify(join(canonical, "skills"))}) { swapped = true; syncfs.unlinkSync(${JSON.stringify(f.profile)}); syncfs.symlinkSync(${JSON.stringify(other)},${JSON.stringify(f.profile)}); } return result; };`,
      command === "showProfile" ? { project: undefined } : {},
      command,
    );
    assert.equal(result.exit, 3, JSON.stringify(result));
    assert.ok(result.findings.some((finding) => finding.code === "E_PROFILE_CHANGED"));
    assert.deepEqual(observed(), before);
    if (command === "syncProfile") assert.deepEqual(result.data.applied, []);
    else assert.equal(result.data.managed, null);
  }
});
