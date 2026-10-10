import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { retireMiseSkillTasks, retireMiseText } from "../../dist/index.js";

const source = `# Keep this header
[tools]
node = "24"
[env]
KEEP = "same"

[tasks.build]
run = "npm run build"

[tasks."skills:sync"]
alias = "ss"
tools = { "npm:@delorenj/skillex" = "0.1.1" }
run = "skillex sync --scope project"

[tasks.check]
run = "npm test"
depends = ["build", "skills:sync"]
depends_post = ["ss"]

[[watch_files]]
patterns = [".agents/skills.json"]
task = "skills:sync"

[[watch_files]]
patterns = ["src/**"]
task = "build"

[[hooks.enter]]
run = "mise run ss"

[[hooks.enter]]
run = "echo keep"
`;

test("retires task-local pins and call edges while preserving unrelated configuration", () => {
  const result = retireMiseText(source);
  const out = parse(result.text);
  assert.deepEqual(result.tasks, ["skills:sync"]);
  assert.equal(result.references, 4);
  assert.deepEqual(out.tools, { node: "24" });
  assert.deepEqual(out.env, { KEEP: "same" });
  assert.deepEqual(out.tasks.build, { run: "npm run build" });
  assert.deepEqual(out.tasks.check.depends, ["build"]);
  assert.deepEqual(out.tasks.check.depends_post, []);
  assert.deepEqual(out.watch_files, [{ patterns: ["src/**"], task: "build" }]);
  assert.deepEqual(out.hooks.enter, [{ run: "echo keep" }]);
  assert.ok(result.text.startsWith("# Keep this header\n"));
  assert.ok(result.text.includes('[tasks.build]\nrun = "npm run build"\n'));
  assert.equal(retireMiseText(result.text).text, result.text);
});

test("legacy hyphenated skill-task names are retired too", () => {
  const result = retireMiseText(
    '[tasks.skills-sync]\nrun="custom-wrapper"\n[tasks.skills-provision-packs]\nrun="custom-provisioner"\n',
  );
  assert.deepEqual(result.tasks, ["skills-provision-packs", "skills-sync"]);
});

test("preserves the following tool's managed comment markers", () => {
  const result = retireMiseText(
    '[tasks."skills:sync"]\nrun="skillex sync"\n\n# >>> mise-versioning >>>\n[tasks.version]\nrun="echo version"\n# <<< mise-versioning <<<\n',
  );
  assert.ok(result.text.includes("# >>> mise-versioning >>>"));
  assert.ok(result.text.includes("# <<< mise-versioning <<<"));
});

test("retains checks whose argument is the skillex source directory", () => {
  const text = '[tasks."python:tc"]\nrun="uv run mypy src/skillex"\n';
  assert.equal(retireMiseText(text).text, text);
});

test("detects non-prefixed legacy tasks and fleet resync wrappers", () => {
  const result = retireMiseText(`[tasks."topology:check"]
run = "uv run skillex topology check"
[tasks.refresh]
run = "python3 /repo/scripts/hermes-skillex-resync.py"
[tasks."hermes:resync:status"]
run = "/repo/scripts/install-hermes-resync.sh status"
[tasks.provision]
run = "python3 sync-skills.py"
[tasks.test]
run = "npm test"
`);
  assert.deepEqual(result.tasks, [
    "hermes:resync:status",
    "provision",
    "refresh",
    "topology:check",
  ]);
  assert.deepEqual(Object.keys(parse(result.text).tasks), ["test"]);
});

test("does not parse table-looking text inside multiline values as real tasks", () => {
  const text = `[env]
EXAMPLE = '''
[tasks.skills]
not a task
'''
[tasks.test]
run = "npm test"
[tasks."skills:sync"]
run = "skillex sync"
`;
  const result = retireMiseText(text);
  assert.equal(parse(result.text).env.EXAMPLE, parse(text).env.EXAMPLE);
  assert.deepEqual(result.tasks, ["skills:sync"]);
});

test("recognizes legacy script-style hooks and refuses mixed command chains", () => {
  const result = retireMiseText('[[hooks.enter]]\nscript="python3 provision-packs.py"\n');
  assert.equal(result.references, 1);
  assert.throws(
    () => retireMiseText('[[hooks.enter]]\nrun="skillex sync && echo keep"\n'),
    /mixed task\/hook/,
  );
});

test("removes hooks calling retired projectors even with no named task", () => {
  const result = retireMiseText(`[[hooks.enter]]
run = "uv run skillex sync"
[tools]
node = "24"
`);
  assert.deepEqual(parse(result.text), { tools: { node: "24" } });
  assert.equal(result.references, 1);
});

test("refuses compact task syntax instead of rewriting unrelated bytes", () => {
  assert.throws(
    () => retireMiseText('[tasks]\n"skills:sync" = "skillex sync"\nbuild = "npm run build"\n'),
    /cannot yet be removed/,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "skillex-retired-mise-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  await mkdir(project);
  await mkdir(home);
  return { root, project, home, stateHome };
}

test("preview writes nothing, apply preserves mode, repeat preserves bytes and inode", async (t) => {
  const f = await fixture(t);
  const path = join(f.project, "mise.toml");
  await writeFile(path, source, { mode: 0o640 });
  const before = await lstat(path);
  const preview = await retireMiseSkillTasks(f);
  assert.equal(preview.exit, 0);
  assert.equal(preview.findings[0].code, "W_RETIRED_MISE_SKILL_TASK");
  assert.equal(await readFile(path, "utf8"), source);
  await assert.rejects(lstat(f.stateHome), { code: "ENOENT" });
  const result = await retireMiseSkillTasks({ ...f, apply: true });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.deepEqual(result.data.applied, [path]);
  const after = await lstat(path);
  assert.equal(after.mode, before.mode);
  const again = await retireMiseSkillTasks({ ...f, apply: true });
  assert.deepEqual(again.data.changes, []);
  assert.equal((await lstat(path)).ino, after.ino);
});

test("all configs preflight before writes; malformed sibling refuses everything", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, "mise.toml"), source);
  await writeFile(join(f.project, "mise.local.toml"), "not valid toml");
  const result = await retireMiseSkillTasks({ ...f, apply: true });
  assert.equal(result.ok, false);
  assert.equal(await readFile(join(f.project, "mise.toml"), "utf8"), source);
  await assert.rejects(lstat(f.stateHome), { code: "ENOENT" });
});

test("refuses config symlinks and redirected parent directories", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.toml");
  await writeFile(outside, source);
  await symlink(outside, join(f.project, "mise.toml"));
  assert.equal((await retireMiseSkillTasks({ ...f, apply: true })).exit, 3);
  const alias = join(f.root, "alias");
  await symlink(f.home, alias);
  await writeFile(join(f.home, "mise.toml"), source);
  assert.equal(
    (await retireMiseSkillTasks({ project: alias, stateHome: f.stateHome, apply: true })).exit,
    3,
  );
  assert.equal(await readFile(outside, "utf8"), source);
});

test("global selector never edits project and conflicting selectors refuse", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".config/mise"), { recursive: true });
  const global = join(f.home, ".config/mise/config.toml");
  await writeFile(global, source);
  await writeFile(join(f.project, "mise.toml"), source);
  const result = await retireMiseSkillTasks({
    home: f.home,
    global: true,
    stateHome: f.stateHome,
    apply: true,
  });
  assert.equal(result.exit, 0);
  assert.equal(await readFile(join(f.project, "mise.toml"), "utf8"), source);
  assert.equal((await retireMiseSkillTasks({ ...f, global: true, apply: true })).exit, 2);
});

test("wildcard dependencies refuse because their membership may cross config boundaries", () => {
  assert.throws(
    () =>
      retireMiseText(
        '[tasks."skills:sync"]\nrun="skillex sync"\n[tasks.build]\nrun="npm run build"\n[tasks.check]\ndepends=["*"]\nrun="npm test"\n',
      ),
    /wildcard dependency/,
  );
});

test("wrapper matching is token exact and follows aliases", () => {
  const result = retireMiseText(
    '[tasks.skill]\nrun="skillex sync"\nalias="ss"\n[tasks.refresh]\nrun="mise run ss"\n[tasks.lint]\nrun="mise run lint --dir skills"\n',
  );
  assert.deepEqual(result.tasks, ["refresh", "skill"]);
  assert.equal(parse(result.text).tasks.lint.run, "mise run lint --dir skills");
});

test("mixed tasks, wrapper hooks, and shell substitutions refuse without data loss", () => {
  for (const text of [
    '[tasks.check]\nrun=["npm test","skillex doctor"]\n',
    '[tasks."skills:sync"]\nrun="skillex sync"\n[[hooks.enter]]\nrun=["mise run skills:sync","echo important"]\n',
    '[tasks."skills:sync"]\nrun="skillex sync"\n[[hooks.enter]]\nrun="mise run skills:sync && echo important"\n',
    '[tasks.check]\nrun="X=$(skillex sync)"\n',
    '[tasks.check]\nrun="echo `skillex sync`"\n',
  ])
    assert.throws(() => retireMiseText(text), /mixed task\/hook/);
  const prose = '[tasks.help]\nrun="echo deprecated: use skillex sync directly"\n';
  assert.equal(retireMiseText(prose).text, prose);
});

test("mixed hooks and broad watches refuse instead of dropping unrelated behavior", () => {
  assert.throws(
    () => retireMiseText('[[hooks.enter]]\nrun=["skillex sync","echo important"]\n'),
    /mixed task\/hook/,
  );
  assert.throws(
    () =>
      retireMiseText(
        '[tasks."skills:sync"]\nrun="skillex sync"\n[tasks.build]\nrun="npm run build"\n[[watch_files]]\npatterns=["**"]\ntask="*"\n',
      ),
    /wildcard/,
  );
});

test("explicit missing config refuses; unconfigured project stays a write-free no-op", async (t) => {
  const f = await fixture(t);
  assert.equal((await retireMiseSkillTasks({ file: join(f.project, "absent.toml") })).exit, 2);
  assert.equal((await retireMiseSkillTasks({ project: join(f.root, "absent") })).exit, 2);
  const result = await retireMiseSkillTasks(f);
  assert.deepEqual(result.data.changes, []);
  await assert.rejects(lstat(f.stateHome), { code: "ENOENT" });
});
