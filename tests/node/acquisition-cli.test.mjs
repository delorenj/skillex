import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { gitAt, loadAcquisitionFixture } from "./acquisition-fixture.mjs";

// The public CLI wiring lands with the coordinator; these tests drive the
// registration module through a faithful replica of the cli.ts harness so the
// flag surface, envelope contract, and exit codes are pinned either way.
const fixture = await loadAcquisitionFixture();

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function makeWorld() {
  const root = realpathSync(mkdtempSync("/tmp/skillex-acquisition-cli-"));
  const registry = join(root, "registry");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const state = join(root, "state");
  const project = join(root, "project");
  mkdirSync(join(project, ".git", "deep"), { recursive: true });
  return { root, registry, home, state, project };
}

function sourceRepo(world) {
  const repo = join(world.root, "repos", "root-skill");
  write(
    join(repo, "SKILL.md"),
    "---\nname: root-skill\ndescription: CLI fixture\n---\n\n# root-skill\n",
  );
  write(join(repo, "references", "guide.md"), "guide\n");
  gitAt(repo, ["init", "--quiet", "--initial-branch=main", "."]);
  gitAt(repo, ["config", "user.email", "fixture@test"]);
  gitAt(repo, ["config", "user.name", "fixture"]);
  gitAt(repo, ["config", "commit.gpgsign", "false"]);
  gitAt(repo, ["add", "-A"]);
  gitAt(repo, ["commit", "--quiet", "-m", "fixture source"]);
  return { url: `file://${repo}`, head: gitAt(repo, ["rev-parse", "HEAD"]).trim() };
}

describe("acquisition CLI", () => {
  it("imports a git remote into the catalog over --json", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const result = run(world, ["import", source.url, "--registry-root", world.registry, "--json"]);
    const value = envelope(result, "import", 0);
    assert.equal(value.data.name, "root-skill");
    assert.equal(value.data.imported, true);
    assert.equal(value.data.source.commit, source.head);
    const canonical = join(world.registry, "all-skills", "root-skill");
    assert.equal(
      readFileSync(join(canonical, "SKILL.md"), "utf8"),
      "---\nname: root-skill\ndescription: CLI fixture\n---\n\n# root-skill\n",
    );
    assert.match(
      readFileSync(join(canonical, ".source.yaml"), "utf8"),
      new RegExp(`file://\\S+root-skill#${source.head}`),
    );
  });

  it("dry-run imports nothing and reports the plan", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const result = run(world, [
      "import",
      source.url,
      "--registry-root",
      world.registry,
      "--dry-run",
      "--json",
    ]);
    const value = envelope(result, "import", 0);
    assert.equal(value.data.dryRun, true);
    assert.equal(value.data.imported, false);
    assert.ok(value.data.changes.length > 0);
    assert.notEqual(existsSync(join(world.registry, "all-skills", "root-skill")), true);
  });

  it("repeated import of identical content is a reuse, not an error", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const once = run(world, ["import", source.url, "--registry-root", world.registry, "--json"]);
    envelope(once, "import", 0);
    const twice = run(world, ["import", source.url, "--registry-root", world.registry, "--json"]);
    const value = envelope(twice, "import", 0);
    assert.equal(value.data.reused, true);
    assert.equal(value.data.imported, false);
  });

  it("refuses a same-name conflict without touching the canonical", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    write(
      join(world.registry, "all-skills", "root-skill", "SKILL.md"),
      "---\nname: root-skill\ndescription: pre-existing\n---\n\n# different\n",
    );
    const result = run(world, ["import", source.url, "--registry-root", world.registry, "--json"]);
    const value = envelope(result, "import", 3);
    assert.ok(value.findings.some((finding) => finding.code === "E_IMPORT_NAME_CONFLICT"));
    assert.match(
      readFileSync(join(world.registry, "all-skills", "root-skill", "SKILL.md"), "utf8"),
      /pre-existing/,
    );
  });

  it("add imports and enables in the current project, creating its manifest", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    mkdirSync(join(world.project, "src"), { recursive: true });
    const result = run(world, ["add", source.url, "--registry-root", world.registry, "--json"], {
      cwd: join(world.project, "src"),
    });
    const value = envelope(result, "add", 0);
    assert.equal(value.data.scope, "project");
    assert.equal(value.data.root, world.project);
    assert.equal(value.data.activation.status, "applied");
    assert.deepEqual(
      JSON.parse(readFileSync(join(world.project, ".agents", "skills.json"), "utf8")).skills,
      ["root-skill"],
    );
    assert.equal(
      realpathSync(join(world.project, ".agents", "skills", "root-skill")),
      join(world.registry, "all-skills", "root-skill"),
    );
    assert.notEqual(existsSync(join(world.home, ".agents", "skills.json")), true);
  });

  it("add -g enables in the global scope and leaves the project alone", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const result = run(world, [
      "add",
      source.url,
      "-g",
      "--registry-root",
      world.registry,
      "--json",
    ]);
    const value = envelope(result, "add", 0);
    assert.equal(value.data.scope, "global");
    assert.equal(value.data.root, world.home);
    assert.deepEqual(
      JSON.parse(readFileSync(join(world.home, ".agents", "skills.json"), "utf8")).skills,
      ["root-skill"],
    );
    assert.notEqual(existsSync(join(world.project, ".agents")), true);
  });

  it("add rejects -p with -g before fetching or writing anything", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const result = run(world, [
      "add",
      source.url,
      "-p",
      world.project,
      "-g",
      "--registry-root",
      world.registry,
      "--json",
    ]);
    const value = envelope(result, "add", 2);
    assert.ok(value.findings.some((finding) => finding.code === "E_SCOPE"));
    assert.notEqual(existsSync(join(world.registry, "all-skills", "root-skill")), true);
    assert.notEqual(existsSync(join(world.project, ".agents")), true);
    assert.notEqual(existsSync(join(world.home, ".agents")), true);
  });

  it("add -p selects the named project explicitly", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const other = join(world.root, "other");
    write(join(other, ".agents", "skills.json"), '{"skills":[]}\n');
    const result = run(world, [
      "add",
      source.url,
      "-p",
      other,
      "--registry-root",
      world.registry,
      "--json",
    ]);
    const value = envelope(result, "add", 0);
    assert.equal(value.data.scope, "project");
    assert.equal(value.data.root, other);
    assert.deepEqual(
      JSON.parse(readFileSync(join(other, ".agents", "skills.json"), "utf8")).skills,
      ["root-skill"],
    );
    assert.notEqual(existsSync(join(world.project, ".agents")), true);
  });

  it("prints human text on stdout and keeps findings out of JSON mode", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const result = run(world, ["import", source.url, "--registry-root", world.registry]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Imported root-skill/);
    assert.equal(result.stderr, "");
  });

  it("accepts the shared flags before the command (root placement)", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const source = sourceRepo(world);
    const result = run(world, ["--json", "--registry-root", world.registry, "import", source.url]);
    envelope(result, "import", 0);
  });

  it("reports usage errors inside the envelope", async (t) => {
    const world = makeWorld();
    t.after(() => rmSync(world.root, { recursive: true, force: true }));
    const result = run(world, ["import", "/nonexistent", "--bogus", "--json"]);
    const value = envelope(result, "cli", 2);
    assert.ok(value.findings.some((finding) => finding.code === "E_USAGE"));
  });
});

function run(world, args, options = {}) {
  const result = spawnSync(process.execPath, [fixture.cli, ...args], {
    cwd: options.cwd ?? world.root,
    env: {
      PATH: process.env.PATH,
      HOME: world.home,
      XDG_STATE_HOME: world.state,
      XDG_CONFIG_HOME: join(world.root, "xdg-config"),
      XDG_CACHE_HOME: join(world.root, "xdg-cache"),
      XDG_DATA_HOME: join(world.root, "xdg-data"),
      XDG_RUNTIME_DIR: join(world.root, "xdg-runtime"),
      NO_COLOR: "1",
      TERM: "dumb",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function envelope(result, command, exit) {
  assert.equal(result.status, exit, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "command",
    "data",
    "exit",
    "findings",
    "ok",
    "schema",
  ]);
  assert.equal(value.schema, 2);
  assert.equal(value.command, command);
  assert.equal(value.exit, exit);
  assert.equal(value.ok, exit === 0);
  assert.ok(Array.isArray(value.findings));
  if (exit === 0) assert.ok(value.findings.every(({ severity }) => severity !== "error"));
  return value;
}
