import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { createPackageFixture } from "./package-fixture.mjs";
import { snapshot } from "./profile-fixture.mjs";

let installed;
before(() => {
  installed = createPackageFixture();
});
after(() => installed?.cleanup());
function world(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-migrate-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const registry = join(root, "registry");
  const cwd = join(root, "ambient-project");
  const file = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  for (const path of [home, join(registry, "all-skills"), cwd])
    mkdirSync(path, { recursive: true });
  file(join(cwd, ".agents", "skills.json"), "malformed ambient manifest");
  const env = {
    PATH: installed.runtimeBin,
    HOME: home,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    NO_COLOR: "1",
  };
  const run = (args, exit = 0) => {
    const result = spawnSync(installed.cli, args, { cwd, env, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    const value = JSON.parse(result.stdout);
    assert.equal(value.command, "migrate");
    assert.equal(value.schema, 2);
    assert.equal(value.exit, exit);
    return value;
  };
  return {
    root,
    home,
    registry,
    cwd,
    file,
    env,
    run,
    args: ["migrate", "--registry-root", registry, "--json"],
  };
}

test("installed migration previews registry conversion without selecting the ambient project", (t) => {
  const f = world(t);
  f.file(join(f.registry, "sets", "tools", "alpha", "SKILL.md"), "# Alpha\n");
  const before = snapshot(f.root);
  const result = f.run(f.args);
  assert.deepEqual(result.data.targets, [f.registry]);
  assert.deepEqual(result.data.applied, []);
  assert.ok(result.data.items.some((item) => item.action === "import-definition"));
  assert.deepEqual(snapshot(f.root), before);
});

test("installed migration applies and converges with no Python or uv on PATH", (t) => {
  const f = world(t);
  const source = join(f.registry, "sets", "tools", "alpha");
  f.file(join(source, "SKILL.md"), "# Alpha\n");
  f.file(join(source, "references", "guide.md"), "Preserve support bytes.\n");
  const result = f.run([...f.args, "--apply"]);
  assert.ok(result.data.applied.length > 0);
  const canonical = join(f.registry, "all-skills", "alpha");
  assert.equal(realpathSync(source), canonical);
  assert.equal(
    readFileSync(join(canonical, "references", "guide.md"), "utf8"),
    "Preserve support bytes.\n",
  );
  const before = snapshot(f.root);
  assert.deepEqual(f.run([...f.args, "--apply"]).data.applied, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("installed explicit null mapping removes only the stale Kurzgesagt member", (t) => {
  const f = world(t);
  const canonical = join(f.registry, "all-skills", "skill-creator");
  f.file(join(canonical, "SKILL.md"), "# Independent current creator\n");
  const pack = join(f.registry, "packs", "Kurzgesagt");
  mkdirSync(pack, { recursive: true });
  const stale = join(pack, "skill-creator");
  symlinkSync("../../missing/skill-creator", stale);
  const mapping = f.file(
    join(f.root, "mapping.json"),
    JSON.stringify({
      version: 1,
      references: { "packs/Kurzgesagt/skill-creator": null },
      packs: { "packs/Kurzgesagt": { name: "kurzgesagt", version: "0.1.0" } },
    }),
  );
  const before = snapshot(canonical);
  const result = f.run([...f.args, "--mapping", mapping, "--apply"]);
  assert.ok(result.data.applied.length > 0);
  assert.equal(existsSync(stale), false);
  assert.deepEqual(snapshot(canonical), before);
});

test("installed migration rejects malformed mapping JSON with configuration exit 2", (t) => {
  const f = world(t);
  const mapping = f.file(join(f.root, "mapping.json"), "{broken");
  const before = snapshot(f.root);
  const result = f.run([...f.args, "--mapping", mapping, "--apply"], 2);
  assert.ok(result.findings.some((finding) => finding.code === "E_MIGRATION_MAPPING"));
  assert.deepEqual(snapshot(f.root), before);
});

test("installed migration rejects a missing mapping file without fallback", (t) => {
  const f = world(t);
  const before = snapshot(f.root);
  f.run([...f.args, "--mapping", join(f.root, "missing.json")], 2);
  assert.deepEqual(snapshot(f.root), before);
});

test("installed migration rejects conflicting explicit scopes before writing", (t) => {
  const f = world(t);
  const before = snapshot(f.root);
  f.run([...f.args, "--scope", "global", "--project", f.cwd, "--apply"], 2);
  assert.deepEqual(snapshot(f.root), before);
});

test("installed migration supports shared JSON and registry flags before the subcommand", (t) => {
  const f = world(t);
  f.file(join(f.registry, "all-skills", "alpha", "SKILL.md"), "# Alpha\n");
  const before = snapshot(f.root);
  f.run(["--registry-root", f.registry, "--json", "migrate"]);
  assert.deepEqual(snapshot(f.root), before);
});

test("installed migration help explains explicit write and target selection", (t) => {
  const f = world(t);
  const before = snapshot(f.root);
  const result = spawnSync(installed.cli, ["migrate", "--help"], {
    cwd: f.cwd,
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  for (const text of [
    "--apply",
    "--project",
    "--scope",
    "--profile",
    "--mapping",
    "--sources-file",
  ])
    assert.ok(result.stdout.includes(text));
  assert.deepEqual(snapshot(f.root), before);
});
