import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import { join } from "node:path";
import { test } from "node:test";
import { createPackageFixture } from "./package-fixture.mjs";

test("installed CLI adopts, selects, derives, normalizes and isolates one project without global writes", (t) => {
  const installed = createPackageFixture();
  t.after(installed.cleanup);
  const root = mkdtempSync("/tmp/skillex-pilot-cli-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    project = join(root, "project"),
    registry = join(root, "registry");
  for (const p of [
    home,
    project,
    join(project, ".git"),
    join(project, ".agents/skills"),
    join(home, ".agents/skills"),
    join(registry, "all-skills"),
    join(registry, "sets/base"),
    join(registry, "packs"),
  ])
    mkdirSync(p, { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) {
    const p = join(registry, "all-skills", name);
    mkdirSync(p);
    writeFileSync(join(p, "SKILL.md"), `---\nname: ${name}\ndescription: pilot fixture\n---\n`);
  }
  symlinkSync(join(registry, "all-skills", "alpha"), join(registry, "sets/base/alpha"));
  symlinkSync(join(registry, "all-skills", "alpha"), join(project, ".agents/skills/alpha"));
  writeFileSync(join(home, ".agents/skills.json"), ' {"sets":["legacy-one","legacy-two"]}\n');
  writeFileSync(join(home, ".agents/skills/sentinel"), "global unchanged");
  writeFileSync(join(project, ".agents/skills.json"), '{"inherit_global":false}\n');
  const before = readFileSync(join(home, ".agents/skills.json"), "utf8");
  const env = {
    ...installed.environment,
    HOME: home,
    XDG_STATE_HOME: join(root, "state"),
    PJ_SKILLS_REGISTRY_ROOT: registry,
  };
  function cli(...args) {
    const run = spawnSync(
      process.execPath,
      [installed.cli, "--json", "--registry-root", registry, ...args],
      { cwd: project, env, encoding: "utf8", timeout: 20000 },
    );
    assert.ifError(run.error);
    const result = JSON.parse(run.stdout);
    assert.equal(run.status, 0, JSON.stringify(result));
    return result.data;
  }
  cli("root", "adopt", "--project", project, "--apply");
  const source = join(root, "source");
  mkdirSync(source);
  for (const name of ["beta", "gamma"])
    symlinkSync(join(registry, "all-skills", name), join(source, name));
  cli("pack", "create", "addon", "--version", "1.0.0", "--from-root", source);
  cli("enable", "set", "base", "--project", project);
  assert.equal(realpathSync(join(project, ".agents/skills")), join(registry, "sets/base"));
  cli("enable", "pack", "addon@1.0.0", "--project", project);
  const selected = JSON.parse(readFileSync(join(project, ".agents/skills.json"), "utf8"));
  assert.match(selected.set, /^base-/);
  assert.deepEqual(selected.packs, ["addon@1.0.0"]);
  assert.equal(readdirSync(join(registry, "sets/base")).length, 1);
  assert.deepEqual(cli("normalize", "--project", project).changes, []);
  cli("clients", "isolate", "--client", "opencode", "--project", project, "--apply");
  assert.deepEqual(
    cli("clients", "isolate", "--client", "opencode", "--project", project).changes,
    [],
  );
  const rules = JSON.parse(readFileSync(join(project, "opencode.json"), "utf8")).permissions;
  assert.deepEqual(rules[0], { action: "skill", resource: "*", effect: "deny" });
  assert.deepEqual(
    rules
      .slice(1)
      .map((x) => x.resource)
      .sort(),
    ["alpha", "beta", "gamma"],
  );
  cli("clients", "unisolate", "--client", "opencode", "--project", project, "--apply");
  assert.equal(readFileSync(join(home, ".agents/skills.json"), "utf8"), before);
  assert.equal(readFileSync(join(home, ".agents/skills/sentinel"), "utf8"), "global unchanged");
  assert.ok(readlinkSync(join(project, ".agents/skills")).includes(selected.set));
});

test("installed CLI normalizes a Holocene-shaped legacy manifest with derived root and packs", (t) => {
  const installed = createPackageFixture();
  t.after(installed.cleanup);
  const root = mkdtempSync("/tmp/skillex-pilot-cli-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    project = join(root, "project"),
    registry = join(root, "registry");
  for (const p of [
    home,
    project,
    join(project, ".git"),
    join(project, ".agents/skills"),
    join(registry, "all-skills"),
    join(registry, "sets/base"),
    join(registry, "packs"),
  ])
    mkdirSync(p, { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) {
    const p = join(registry, "all-skills", name);
    mkdirSync(p);
    writeFileSync(join(p, "SKILL.md"), `---\nname: ${name}\ndescription: pilot fixture\n---\n`);
  }
  symlinkSync(join(registry, "all-skills", "alpha"), join(registry, "sets/base/alpha"));
  mkdirSync(join(home, ".agents/skills"), { recursive: true });
  writeFileSync(join(home, ".agents/skills.json"), '{"skills":[]}\n');
  writeFileSync(join(project, ".agents/skills.json"), '{"inherit_global":false}\n');
  const env = {
    ...installed.environment,
    HOME: home,
    XDG_STATE_HOME: join(root, "state"),
    PJ_SKILLS_REGISTRY_ROOT: registry,
  };
  function run(...args) {
    const execution = spawnSync(
      process.execPath,
      [installed.cli, "--json", "--registry-root", registry, ...args],
      { cwd: project, env, encoding: "utf8", timeout: 20000 },
    );
    assert.ifError(execution.error);
    return { status: execution.status, result: JSON.parse(execution.stdout) };
  }
  function cli(...args) {
    const { status, result } = run(...args);
    assert.equal(status, 0, JSON.stringify(result));
    return result.data;
  }
  const source = join(root, "source");
  mkdirSync(source);
  for (const name of ["beta", "gamma"])
    symlinkSync(join(registry, "all-skills", name), join(source, name));
  cli("root", "adopt", "--project", project, "--apply");
  cli("pack", "create", "packs2", "--version", "1.0.0", "--from-root", source);
  cli("enable", "set", "base", "--project", project);
  cli("enable", "pack", "packs2@1.0.0", "--project", project);
  const corrected = JSON.parse(readFileSync(join(project, ".agents/skills.json"), "utf8"));
  assert.match(corrected.set, /^base-/);
  assert.deepEqual(corrected.packs, ["packs2@1.0.0"]);
  const derivedRoot = realpathSync(join(project, ".agents/skills"));

  // Holocene-shaped legacy state: the same corrected selection serialized with
  // the retired sets array, activation root already symlinked at the derived set.
  writeFileSync(
    join(project, ".agents/skills.json"),
    `${JSON.stringify({ inherit_global: false, sets: [corrected.set], packs: ["packs2@1.0.0"] }, null, 2)}\n`,
  );
  const normalized = cli("normalize", "--project", project, "--apply");
  assert.equal(normalized.manifest.set, corrected.set);
  const saved = JSON.parse(readFileSync(join(project, ".agents/skills.json"), "utf8"));
  assert.equal(saved.set, corrected.set);
  assert.deepEqual(saved.packs, ["packs2@1.0.0"]);
  assert.equal("sets" in saved, false);
  assert.equal(realpathSync(join(project, ".agents/skills")), derivedRoot);
  assert.deepEqual(cli("normalize", "--project", project).changes, []);
  assert.equal(realpathSync(join(project, ".agents/skills")), derivedRoot);

  for (const value of [[corrected.set], { name: corrected.set }, null, ""]) {
    const bytes = `${JSON.stringify({ inherit_global: false, set: value, packs: ["packs2@1.0.0"] }, null, 2)}\n`;
    writeFileSync(join(project, ".agents/skills.json"), bytes);
    const refused = run("normalize", "--project", project, "--apply");
    assert.notEqual(refused.status, 0, JSON.stringify(value));
    assert.equal(readFileSync(join(project, ".agents/skills.json"), "utf8"), bytes);
  }
});
