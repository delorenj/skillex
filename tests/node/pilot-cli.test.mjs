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
  assert.match(selected.sets[0], /^base-/);
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
  assert.ok(readlinkSync(join(project, ".agents/skills")).includes(selected.sets[0]));
});
