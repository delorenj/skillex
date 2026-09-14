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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { explainSkill, inspectStatus, PROJECT_CLI_ALIASES, sync } from "@delorenj/skillex";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-diagnostics-"));
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
    scope: "project",
    timeoutMs: 10_000,
  };
  function directory(path) {
    mkdirSync(path, { recursive: true });
    return path;
  }
  function file(path, content) {
    directory(dirname(path));
    writeFileSync(path, content);
    return path;
  }
  function link(path, target) {
    directory(dirname(path));
    symlinkSync(relative(dirname(path), target), path);
    return path;
  }
  function manifest(scope, raw) {
    return file(
      join(scope === "global" ? home : project, ".agents", "skills.json"),
      JSON.stringify(raw),
    );
  }
  function skill(name, base = registry) {
    return directory(dirname(file(join(base, "all-skills", name, "SKILL.md"), `# ${name}\n`)));
  }
  function set(name, members) {
    const path = directory(join(registry, "sets", name));
    for (const name of members) link(join(path, name), join(registry, "all-skills", name));
    return path;
  }
  function pack(name, version, members) {
    const path = join(registry, "packs", name, version);
    file(
      join(path, "pack.toml"),
      `[pack]\nname=${JSON.stringify(name)}\nversion=${JSON.stringify(version)}\n[freeform]\nskills=${JSON.stringify(members)}\n`,
    );
    directory(join(path, "skills"));
    for (const name of members)
      link(join(path, "skills", name), join(registry, "all-skills", name));
    return path;
  }
  directory(join(project, ".git"));
  directory(join(registry, "all-skills"));
  manifest("global", { inherit_global: false });
  manifest("project", { inherit_global: false });
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
function activation(root) {
  return join(root, ".agents", "skills");
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
function result(value, exit = 0) {
  assert.equal(value.schema, 2);
  assert.equal(value.exit, exit, JSON.stringify(value.findings));
  assert.equal(value.ok, exit === 0);
  assert.ok(value.data);
  return value.data;
}
function finding(value, code, exit = 3) {
  result(value, exit);
  const found = value.findings.find((item) => item.code === code);
  assert.ok(found, JSON.stringify(value.findings));
  assert.ok(found.fix);
  return found;
}
function scope(data, name = "project") {
  const found = data.scopes.find((scope) => scope.scope === name);
  assert.ok(found);
  return found;
}

it("reports missing desired activation as drift without creating roots, aliases, or state", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  const before = snapshot(f.root);
  const status = result(await inspectStatus(f.options), 6);
  assert.deepEqual(status.writeScopes, ["project"]);
  const project = scope(status);
  assert.equal(project.mode, "composed");
  assert.deepEqual(project.desired, ["alpha"]);
  assert.equal(project.actual.root.kind, "missing");
  assert.deepEqual(project.actual.entries, []);
  assert.equal(project.counts.missing, 1);
  assert.equal(project.receipt.state, "missing");
  assert.ok(project.receipt.path);
  assert.ok(project.aliases.every((alias) => !alias.reachable && !alias.reachesRoot));
  assert.ok(status.changes.some((change) => change.action === "create-directory"));
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
  result(await sync(f.options));
  const healthy = scope(result(await inspectStatus(f.options)));
  assert.equal(healthy.actual.root.ownership, "owned");
  assert.equal(healthy.counts.owned, 1);
  assert.equal(healthy.counts.missing, 0);
  assert.ok(healthy.aliases.every((alias) => alias.reachesRoot));
});

it("reports unowned canonical links and BMAD entries as foreign without adopting or treating them as drift", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  f.link(join(activation(f.project), "alpha"), alpha);
  f.file(join(activation(f.project), "bmad", "SKILL.md"), "# Installer owned\n");
  for (const alias of PROJECT_CLI_ALIASES) f.link(join(f.project, alias), activation(f.project));
  const before = snapshot(f.root);
  const status = scope(result(await inspectStatus(f.options)));
  assert.deepEqual(status.counts, {
    desired: 1,
    actual: 2,
    owned: 0,
    foreign: 2,
    pack: 0,
    missing: 0,
  });
  assert.equal(status.actual.entries.find((entry) => entry.name === "alpha").ownership, "foreign");
  assert.equal(status.actual.entries.find((entry) => entry.name === "bmad").kind, "directory");
  assert.equal(status.receipt.state, "missing");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("keeps actual ownership, aliases, and receipt observations when required resolution fails", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  result(await sync(f.options));
  f.manifest("project", { inherit_global: false, skills: ["gone"] });
  const before = snapshot(f.root);
  const blocked = await inspectStatus(f.options);
  finding(blocked, "E_SKILL_MISSING");
  assert.equal(blocked.data.resolution, null);
  const project = scope(blocked.data);
  assert.equal(project.desired, null);
  assert.equal(project.counts.desired, null);
  assert.equal(project.actual.entries[0].name, "alpha");
  assert.equal(project.actual.entries[0].ownership, "owned");
  assert.equal(project.receipt.state, "valid");
  assert.ok(project.aliases.every((alias) => alias.reachesRoot));
  const explained = await explainSkill("alpha", f.options);
  finding(explained, "E_SKILL_MISSING");
  assert.equal(scope(explained.data).state, "blocked");
  assert.equal(scope(explained.data).actual.reachable, true);
  assert.deepEqual(snapshot(f.root), before);
});

it("collects identifiable roots for malformed and absent project manifests while retaining configuration exits", async (t) => {
  const f = fixture(t);
  f.file(join(activation(f.project), "foreign.txt"), "Do not change\n");
  f.file(join(f.project, ".agents", "skills.json"), "{broken");
  let before = snapshot(f.root);
  const malformed = await inspectStatus(f.options);
  finding(malformed, "E_MANIFEST_PARSE", 2);
  assert.equal(scope(malformed.data).actual.entries[0].name, "foreign.txt");
  assert.deepEqual(snapshot(f.root), before);
  unlinkSync(join(f.project, ".agents", "skills.json"));
  before = snapshot(f.root);
  const absent = await inspectStatus({ ...f.options, project: f.project });
  finding(absent, "E_NO_PROJECT_MANIFEST", 2);
  assert.equal(scope(absent.data).root, f.project);
  assert.equal(scope(absent.data).actual.entries[0].name, "foreign.txt");
  assert.deepEqual(snapshot(f.root), before);
});

it("detects exact ownership replacement and still reports the wrong alias target", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  result(await sync(f.options));
  const path = join(f.project, ".claude", "skills");
  renameSync(path, join(f.root, "original-alias"));
  f.link(path, join(f.root, "missing-target"));
  const before = snapshot(f.root);
  const blocked = await inspectStatus(f.options);
  finding(blocked, "E_OWNERSHIP_CHANGED");
  const alias = scope(blocked.data).aliases.find((alias) => alias.path === path);
  assert.equal(alias.kind, "link");
  assert.equal(alias.ownership, "changed");
  assert.equal(alias.reachable, false);
  assert.equal(alias.reachesRoot, false);
  assert.deepEqual(snapshot(f.root), before);
});

it("counts pack members separately and rejects aliases that bypass the stable activation root", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  const pack = f.pack("tools", "1.0.0", ["alpha", "beta"]);
  f.pack("tools", "2.0.0", ["alpha", "beta"]);
  f.manifest("project", { packs: ["tools@1.0.0"] });
  for (const alias of PROJECT_CLI_ALIASES) f.link(join(f.project, alias), activation(f.project));
  const cross = join(f.project, ".codex", "skills");
  unlinkSync(cross);
  f.link(cross, join(f.project, ".claude", "skills"));
  result(await sync(f.options));
  const healthy = scope(result(await inspectStatus(f.options)));
  assert.equal(healthy.mode, "pack");
  assert.deepEqual(healthy.counts, {
    desired: 2,
    actual: 2,
    owned: 0,
    foreign: 0,
    pack: 2,
    missing: 0,
  });
  assert.ok(healthy.actual.entries.every((entry) => entry.ownership === "pack"));
  assert.equal(healthy.aliases.find((alias) => alias.path === cross).reachesRoot, true);
  const direct = join(f.project, ".claude", "skills");
  unlinkSync(direct);
  f.link(direct, join(pack, "skills"));
  const currentResult = await inspectStatus(f.options);
  finding(currentResult, "W_ALIAS_BYPASS_ROOT", 6);
  const current = scope(currentResult.data);
  assert.equal(current.aliases.find((alias) => alias.path === direct).reachable, true);
  assert.equal(current.aliases.find((alias) => alias.path === direct).reachesRoot, false);
  const usable = scope(result(await explainSkill("alpha", f.options), 6));
  assert.equal(usable.aliases.find((alias) => alias.path === direct).reachable, true);
  assert.equal(usable.aliases.find((alias) => alias.path === cross).reachable, true);
  // The old direct-pack alias must block a change to another version.
  f.manifest("project", { packs: ["tools@2.0.0"] });
  const before = snapshot(f.root);
  const bypassed = await inspectStatus(f.options);
  result(bypassed, 3);
  const aliases = scope(bypassed.data).aliases;
  assert.equal(aliases.find((alias) => alias.path === direct).reachable, true);
  assert.equal(aliases.find((alias) => alias.path === direct).reachesRoot, false);
  assert.equal(aliases.find((alias) => alias.path === cross).reachesRoot, false);
  assert.deepEqual(snapshot(f.root), before);
});

it("traces aliases through parent links while preserving the planner's redirected-parent refusal", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  result(await sync(f.options));
  rmSync(join(f.project, ".gemini"), { recursive: true });
  f.link(join(f.project, ".gemini"), join(f.project, ".claude"));
  const before = snapshot(f.root);
  const blocked = await inspectStatus(f.options);
  result(blocked, 3);
  const alias = scope(blocked.data).aliases.find(
    (alias) => alias.path === join(f.project, ".gemini", "skills"),
  );
  assert.equal(alias.reachable, true);
  assert.equal(alias.reachesRoot, true);
  assert.deepEqual(snapshot(f.root), before);
});

it("explains canonical contributions, inherited origins, set exclusions, and known unselected names", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  f.skill("unused");
  f.set("tools", ["alpha", "beta"]);
  f.manifest("global", { skills: ["alpha"] });
  f.manifest("project", { skills: ["alpha"], sets: [{ name: "tools", exclude: ["beta"] }] });
  result(await sync(f.options));
  const before = snapshot(f.root);
  const effective = result(await explainSkill("alpha", f.options));
  assert.equal(effective.canonical, alpha);
  assert.equal(scope(effective).state, "effective");
  assert.deepEqual([...new Set(scope(effective).origins.map((origin) => origin.kind))].sort(), [
    "inherit",
    "set",
    "skill",
  ]);
  assert.ok(scope(effective).origins.some((origin) => origin.scope === "global"));
  assert.ok(scope(effective).aliases.every((alias) => alias.reachable));
  const excluded = result(await explainSkill("beta", f.options));
  assert.equal(excluded.canonical, beta);
  assert.equal(scope(excluded).state, "excluded");
  assert.equal(scope(excluded).exclusions[0].by, "set");
  assert.equal(scope(excluded).exclusions[0].reference, "tools");
  assert.ok(scope(excluded).aliases.every((alias) => !alias.reachable));
  assert.equal(scope(result(await explainSkill("unused", f.options))).state, "unselected");
  finding(await explainSkill("unknown", f.options), "E_SKILL_MISSING");
  assert.deepEqual(snapshot(f.root), before);
});

it("explains a local exclusion without editing inherited declarations", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("global", { skills: ["alpha"] });
  f.manifest("project", { exclude: ["alpha"] });
  result(await sync(f.options));
  const before = snapshot(f.root);
  const explained = scope(result(await explainSkill("alpha", f.options)));
  assert.equal(explained.state, "excluded");
  assert.equal(explained.exclusions[0].by, "scope");
  assert.ok(explained.origins.some((origin) => origin.kind === "inherit"));
  assert.deepEqual(snapshot(f.root), before);
});

it("explains dormant direct, set, and global selections under an exclusive pack", async (t) => {
  const f = fixture(t);
  for (const name of ["direct", "from-set", "global", "packed"]) f.skill(name);
  f.set("ordinary", ["from-set"]);
  f.pack("tools", "1.0.0", ["packed"]);
  f.manifest("global", { skills: ["global"] });
  f.manifest("project", {
    skills: ["direct"],
    sets: ["ordinary", "missing-dormant"],
    packs: ["tools@1.0.0"],
  });
  result(await sync(f.options));
  const before = snapshot(f.root);
  for (const [name, kind] of [
    ["direct", "skill"],
    ["from-set", "set"],
    ["global", "inherit"],
  ]) {
    const explained = scope(result(await explainSkill(name, f.options)));
    assert.equal(explained.state, "dormant");
    assert.ok(explained.dormant.some((origin) => origin.kind === kind));
    assert.equal(explained.actual.reachable, false);
  }
  const packed = scope(result(await explainSkill("packed", f.options)));
  assert.equal(packed.state, "effective");
  assert.equal(packed.origins[0].kind, "pack");
  assert.ok(packed.aliases.every((alias) => alias.reachable));
  assert.deepEqual(snapshot(f.root), before);
  f.file(join(f.home, ".agents", "skills.json"), "{invalid dormant global");
  const isolated = await explainSkill("direct", f.options);
  result(isolated);
  assert.ok(isolated.findings.some((finding) => finding.code === "I_DORMANT_UNRESOLVED"));
  assert.equal(scope(isolated.data).state, "dormant");
});

it("reports named CLI reachability separately from a reachable scope root", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  result(await sync(f.options));
  unlinkSync(join(activation(f.project), "alpha"));
  const before = snapshot(f.root);
  const status = scope(result(await inspectStatus(f.options), 6));
  assert.ok(status.aliases.every((alias) => alias.reachesRoot));
  assert.equal(status.counts.missing, 1);
  const explained = scope(result(await explainSkill("alpha", f.options), 6));
  assert.equal(explained.state, "effective");
  assert.equal(explained.actual.kind, "missing");
  assert.ok(explained.aliases.every((alias) => !alias.reachable));
  assert.deepEqual(snapshot(f.root), before);
});

it("never chooses a canonical winner after inherited and local sources diverge", async (t) => {
  const f = fixture(t);
  const globalUrl = "https://example.invalid/global";
  const localUrl = "https://example.invalid/local";
  for (const url of [globalUrl, localUrl])
    f.skill(
      "alpha",
      join(f.home, ".agents", ".cache", "registries", url.replace(/[^a-zA-Z0-9]/g, "_")),
    );
  f.manifest("global", { registry: globalUrl, skills: ["alpha"] });
  f.manifest("project", { registry: localUrl, skills: ["alpha"] });
  const { registryRoot: _, ...options } = f.options;
  const before = snapshot(f.root);
  const explained = await explainSkill("alpha", options);
  finding(explained, "E_DIVERGENT_CANONICAL_NAME");
  assert.equal(explained.data.canonical, null);
  assert.equal(scope(explained.data).state, "blocked");
  assert.deepEqual(snapshot(f.root), before);
});

it("uses the resolved inherited canonical target instead of an unselected local catalog name", async (t) => {
  const f = fixture(t);
  const globalUrl = "https://example.invalid/global";
  const localUrl = "https://example.invalid/local";
  const catalog = (url) =>
    join(f.home, ".agents", ".cache", "registries", url.replace(/[^a-zA-Z0-9]/g, "_"));
  const alpha = f.skill("alpha", catalog(globalUrl));
  f.skill("beta", catalog(localUrl));
  f.manifest("global", { registry: globalUrl, skills: ["alpha"] });
  f.manifest("project", { registry: localUrl });
  const { registryRoot: _, ...options } = f.options;
  result(await sync(options));
  let before = snapshot(f.root);
  const inherited = result(await explainSkill("alpha", options));
  assert.equal(inherited.canonical, alpha);
  assert.equal(scope(inherited).canonical, alpha);
  assert.equal(scope(inherited).state, "effective");
  assert.deepEqual(snapshot(f.root), before);
  f.skill("alpha", catalog(localUrl));
  before = snapshot(f.root);
  const stillInherited = result(await explainSkill("alpha", options));
  assert.equal(stillInherited.canonical, alpha);
  assert.ok(scope(stillInherited).aliases.every((alias) => alias.reachable));
  assert.deepEqual(snapshot(f.root), before);
  f.manifest("project", { registry: localUrl, exclude: ["alpha"] });
  result(await sync(options));
  before = snapshot(f.root);
  const excluded = result(await explainSkill("alpha", options));
  assert.equal(excluded.canonical, alpha);
  assert.equal(scope(excluded).state, "excluded");
  assert.deepEqual(snapshot(f.root), before);
});

it("reports a published pending journal without recovering or misclassifying its exact new link", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  const synced = result(await sync(f.options));
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const rename=fs.rename;
fs.rename=async (...args)=>{ const value=await rename(...args); if(basename(args[1])==='alpha' && basename(args[0]).startsWith('.skillex-tmp-')) process.exit(75); return value; };
syncBuiltinESMExports();
const {sync}=await import('@delorenj/skillex');
await sync(JSON.parse(process.argv[1]));
`,
      JSON.stringify(f.options),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(child.status, 75, child.stderr);
  const receipt = synced.scopes[0].receiptPath;
  assert.ok(JSON.parse(readFileSync(receipt, "utf8")).data.pending);
  const before = snapshot(f.root);
  const status = await inspectStatus(f.options);
  finding(status, "W_RECOVERY_PENDING", 6);
  const observed = scope(status.data);
  assert.equal(observed.receipt.state, "pending");
  assert.ok(observed.receipt.pending.path.endsWith("/alpha"));
  assert.equal(observed.actual.entries[0].ownership, "owned");
  assert.ok(!status.findings.some((finding) => finding.code === "E_OWNERSHIP_CHANGED"));
  assert.equal(scope(result(await explainSkill("alpha", f.options), 6)).state, "effective");
  assert.deepEqual(snapshot(f.root), before);
});

it("reports invalid receipts alongside actual activation instead of adopting ownership", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.manifest("project", { inherit_global: false, skills: ["alpha"] });
  const synced = result(await sync(f.options));
  f.file(synced.scopes[0].receiptPath, "{invalid receipt");
  const before = snapshot(f.root);
  const blocked = await inspectStatus(f.options);
  finding(blocked, "E_RECEIPT_INVALID");
  const observed = scope(blocked.data);
  assert.equal(observed.receipt.state, "invalid");
  assert.equal(observed.actual.entries[0].ownership, "foreign");
  assert.deepEqual(snapshot(f.root), before);
});

it("retains invariant exits through file and cyclic roots and supports write-free cancellation", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.file(activation(f.project), "Foreign root file\n");
  let before = snapshot(f.root);
  const file = await explainSkill("alpha", f.options);
  result(file, 3);
  assert.equal(scope(file.data).state, "blocked");
  assert.deepEqual(snapshot(f.root), before);
  unlinkSync(activation(f.project));
  symlinkSync("skills", activation(f.project));
  before = snapshot(f.root);
  finding(await explainSkill("alpha", f.options), "E_ACTIVATION_RECURSIVE");
  assert.deepEqual(snapshot(f.root), before);
  const interrupted = await inspectStatus({ ...f.options, signal: { aborted: true } });
  assert.equal(interrupted.exit, 130);
  assert.equal(interrupted.data, null);
  assert.deepEqual(snapshot(f.root), before);
});

it("retains an independent root-file invariant before an optional-resolution partial exit", async (t) => {
  const f = fixture(t);
  f.manifest("project", { inherit_global: false, sets: [{ name: "missing", optional: true }] });
  f.file(activation(f.project), "Preserve foreign root content\n");
  const before = snapshot(f.root);
  const blocked = await inspectStatus(f.options);
  finding(blocked, "E_ACTIVATION_CONFLICT");
  assert.ok(blocked.findings.some((finding) => finding.code === "W_OPTIONAL_SKIPPED"));
  assert.equal(scope(blocked.data).actual.root.kind, "file");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});
