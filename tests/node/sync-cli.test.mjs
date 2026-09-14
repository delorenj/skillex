import assert from "node:assert/strict";
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
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPackageFixture, packageName } from "./package-fixture.mjs";

const projectAliases = [
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".opencode/skills",
  ".kimi-code/skills",
];
const globalAliases = [
  ".claude/skills",
  ".codex/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".kimi-code/skills",
  ".kimi/skills",
  ".openclaw/skills",
  ".config/opencode/skills",
];

function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function write(path, content) {
  directory(dirname(path));
  writeFileSync(path, content);
  return path;
}

function link(path, target, absolute = false) {
  directory(dirname(path));
  symlinkSync(absolute ? target : relative(dirname(path), target), path);
  return path;
}

function manifest(root, value) {
  write(join(root, ".agents", "skills.json"), `${JSON.stringify(value)}\n`);
}

function activation(root) {
  return join(root, ".agents", "skills");
}

function snapshot(root) {
  if (!existsSync(root)) return null;
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    const name = relative(root, path);
    const identity = [stat.mode, stat.ino, stat.dev, stat.mtimeMs];
    if (stat.isSymbolicLink()) {
      entries.push([name, "link", ...identity, readlinkSync(path)]);
    } else if (stat.isDirectory()) {
      entries.push([name, "directory", ...identity]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      entries.push([
        name,
        "file",
        ...identity,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
    }
  }
  visit(root);
  return entries;
}

function unchanged(root, action) {
  const before = snapshot(root);
  try {
    return action();
  } finally {
    assert.deepEqual(
      snapshot(root),
      before,
      "read-only operation changed fixture content or identities",
    );
  }
}

function protectedSnapshot(catalog) {
  const content = snapshot(catalog.root)
    .filter(([name]) => name !== "state" && !name.startsWith("state/"))
    .map((entry) => (entry[0] === "" ? entry.slice(0, -1) : entry));
  return { content, receipts: snapshot(catalog.receipts) };
}

function unchangedProtected(catalog, action) {
  const before = protectedSnapshot(catalog);
  try {
    return action();
  } finally {
    assert.deepEqual(
      protectedSnapshot(catalog),
      before,
      "refused operation changed activation or receipt state",
    );
  }
}

describe("installed sync CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function catalogFor(context) {
    const root = realpathSync(mkdtempSync("/tmp/skillex-sync-cli-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const home = directory(join(root, "home"));
    const project = directory(join(root, "project"));
    const cwd = directory(join(project, "src", "nested"));
    const registry = directory(join(root, "registry"));
    const state = join(root, "state");
    for (const name of ["all-skills", "sets", "packs"]) directory(join(registry, name));
    for (const name of ["alpha", "beta", "gamma"]) {
      write(
        join(registry, "all-skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Canonical sync fixture\n---\n\n# ${name}\n`,
      );
    }
    directory(join(project, ".git"));
    manifest(home, { skills: ["alpha"] });
    manifest(project, { skills: ["beta"] });
    const environment = {
      PATH: fixture.runtimeBin,
      HOME: home,
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
      NO_COLOR: "1",
      TERM: "dumb",
    };
    return {
      root,
      home,
      project,
      cwd,
      registry,
      state,
      environment,
      receipts: join(state, "skillex", "activations", "v2"),
      pack(name, version, members, materialize = true) {
        const path = join(registry, "packs", name, version);
        write(
          join(path, "pack.toml"),
          `[pack]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\n\n[freeform]\nskills = ${JSON.stringify(members)}\n`,
        );
        if (materialize) {
          directory(join(path, "skills"));
          for (const member of members)
            link(join(path, "skills", member), join(registry, "all-skills", member));
        }
        write(join(path, "references", "guide.md"), "Preserve pack support content.\n");
        return path;
      },
    };
  }

  function module(source) {
    const result = fixture.runModule(source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  }

  function run(catalog, args) {
    return JSON.parse(
      module(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(${JSON.stringify(fixture.cli)}, ${JSON.stringify(args)}, {
        cwd: ${JSON.stringify(catalog.cwd)}, env: ${JSON.stringify(catalog.environment)},
        encoding: 'utf8', timeout: 15_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      process.stdout.write(JSON.stringify({status: result.status, stdout: result.stdout, stderr: result.stderr}));
    `),
    );
  }

  function parsed(result, command, exit) {
    assert.equal(result.status, exit, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "", "JSON diagnostics belong in the result envelope");
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

  function json(catalog, args = [], exit = 0, placement = "leaf") {
    const globals = ["--registry-root", catalog.registry, "--json"];
    const actual =
      placement === "root" ? [...globals, "sync", ...args] : ["sync", ...args, ...globals];
    return parsed(run(catalog, actual), "sync", exit);
  }

  function namedError(result, code) {
    const finding = result.findings.find(
      (entry) => entry.severity === "error" && (!code || entry.code === code),
    );
    assert.ok(finding, `missing ${code ?? "error"}: ${JSON.stringify(result.findings)}`);
    assert.match(finding.code, /^E_[A-Z0-9_]+$/);
    assert.ok(finding.message.length > 0);
    assert.ok(finding.fix);
    return finding;
  }

  function assertProjection(catalog, root, names, scope, mode = "composed", packRoot) {
    const path = activation(root);
    assert.equal(lstatSync(path).isSymbolicLink(), mode === "pack");
    if (mode === "pack") assert.equal(realpathSync(path), join(packRoot, "skills"));
    for (const name of names) {
      assert.equal(realpathSync(join(path, name)), join(catalog.registry, "all-skills", name));
      assert.equal(lstatSync(join(path, name)).isSymbolicLink(), true);
    }
    for (const alias of scope === "global" ? globalAliases : projectAliases) {
      const aliasRoot = join(root, alias);
      assert.equal(lstatSync(aliasRoot).isSymbolicLink(), true, `missing ${scope} alias ${alias}`);
      assert.equal(realpathSync(aliasRoot), realpathSync(path));
      for (const name of names)
        assert.equal(
          realpathSync(join(aliasRoot, name, "SKILL.md")),
          join(catalog.registry, "all-skills", name, "SKILL.md"),
        );
    }
  }

  it("exposes installed planning/apply APIs and plans without Python, uv, or state writes", (context) => {
    const catalog = catalogFor(context);
    assert.deepEqual(readdirSync(fixture.runtimeBin), ["node"]);
    const output = unchanged(catalog.root, () =>
      module(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { planSync, sync } from '${packageName}';
      assert.equal(typeof sync, 'function');
      for (const program of ['python', 'python3', 'uv']) {
        const absent = spawnSync(program, ['--version'], {env: ${JSON.stringify(catalog.environment)}});
        assert.equal(absent.error?.code, 'ENOENT');
      }
      const result = await planSync(${JSON.stringify({ home: catalog.home, cwd: catalog.cwd, stateHome: catalog.state, registryRoot: catalog.registry, env: catalog.environment })});
      process.stdout.write(JSON.stringify(result));
    `),
    );
    const plan = JSON.parse(output);
    assert.equal(plan.exit, 0, JSON.stringify(plan.findings));
    assert.deepEqual(plan.data.writeScopes, ["global", "project"]);
    assert.ok(plan.data.changes.length > 0);
    assert.equal(existsSync(catalog.state), false);
  });

  for (const placement of ["root", "leaf"]) {
    it(`previews all bindings and aliases with global flags at the ${placement}`, (context) => {
      const catalog = catalogFor(context);
      const result = unchanged(catalog.root, () =>
        json(catalog, ["--dry-run", "--exit-code"], 6, placement),
      );
      assert.equal(result.data.dryRun, true);
      assert.deepEqual(result.data.applied, []);
      assert.deepEqual(result.data.writeScopes, ["global", "project"]);
      const paths = new Set(result.data.changes.map(({ path }) => path));
      for (const [root, aliases, names] of [
        [catalog.home, globalAliases, ["alpha"]],
        [catalog.project, projectAliases, ["alpha", "beta"]],
      ]) {
        assert.ok(paths.has(activation(root)));
        for (const alias of aliases)
          assert.ok(paths.has(join(root, alias)), `preview is missing alias ${alias}`);
        for (const name of names) assert.ok(paths.has(join(activation(root), name)));
      }
      assert.equal(existsSync(catalog.state), false);
      assert.equal(existsSync(activation(catalog.home)), false);
      assert.equal(existsSync(activation(catalog.project)), false);
    });
  }

  it("applies global and nearest-project projections and converges without replacing identities or receipts", (context) => {
    const catalog = catalogFor(context);
    const source = snapshot(catalog.registry);
    const result = json(catalog);
    assert.deepEqual(result.data.writeScopes, ["global", "project"]);
    assert.equal(result.data.dryRun, false);
    assert.ok(result.data.applied.length > 0);
    assertProjection(catalog, catalog.home, ["alpha"], "global");
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
    assert.ok(existsSync(catalog.receipts));
    const home = snapshot(catalog.home);
    const project = snapshot(catalog.project);
    const receipts = snapshot(catalog.receipts);
    const repeated = json(catalog, ["--scope", "both"]);
    assert.deepEqual(repeated.data.changes, []);
    assert.deepEqual(repeated.data.applied, []);
    assert.deepEqual(snapshot(catalog.home), home);
    assert.deepEqual(snapshot(catalog.project), project);
    assert.deepEqual(snapshot(catalog.receipts), receipts);
    assert.deepEqual(snapshot(catalog.registry), source);
    const preview = unchanged(catalog.root, () => json(catalog, ["--dry-run", "--exit-code"]));
    assert.deepEqual(preview.data.changes, []);
  });

  it("narrows writes to the project while retaining global inheritance and applying project exclusions", (context) => {
    const catalog = catalogFor(context);
    manifest(catalog.home, { skills: ["alpha", "gamma"] });
    manifest(catalog.project, { skills: ["beta"], exclude: ["gamma"] });
    const home = snapshot(catalog.home);
    const result = json(catalog, ["--scope", "project"]);
    assert.deepEqual(result.data.writeScopes, ["project"]);
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
    assert.equal(existsSync(join(activation(catalog.project), "gamma")), false);
    assert.deepEqual(snapshot(catalog.home), home);
  });

  it("narrows global writes without reading a malformed project declaration", (context) => {
    const catalog = catalogFor(context);
    write(join(catalog.project, ".agents", "skills.json"), "{ malformed\n");
    const project = snapshot(catalog.project);
    const result = json(catalog, ["--scope", "global"]);
    assert.deepEqual(result.data.writeScopes, ["global"]);
    assertProjection(catalog, catalog.home, ["alpha"], "global");
    assert.deepEqual(snapshot(catalog.project), project);
  });

  it("targets the exact explicit project instead of the nearest invocation project", (context) => {
    const catalog = catalogFor(context);
    const selected = directory(join(catalog.root, "selected-project"));
    manifest(selected, { skills: ["gamma"], inherit_global: false });
    const home = snapshot(catalog.home);
    const nearby = snapshot(catalog.project);
    const result = json(catalog, ["--scope", "project", "--project", selected]);
    assert.deepEqual(result.data.writeScopes, ["project"]);
    assertProjection(catalog, selected, ["gamma"], "project");
    assert.deepEqual(snapshot(catalog.home), home);
    assert.deepEqual(snapshot(catalog.project), nearby);
  });

  it("preserves correct absolute and relative CLI aliases without claiming or replacing them", (context) => {
    const catalog = catalogFor(context);
    directory(activation(catalog.project));
    const relativeAlias = link(
      join(catalog.project, ".claude", "skills"),
      activation(catalog.project),
    );
    const absoluteAlias = link(
      join(catalog.project, ".codex", "skills"),
      activation(catalog.project),
      true,
    );
    const before = [snapshot(relativeAlias), snapshot(absoluteAlias)];
    json(catalog, ["--scope", "project"]);
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
    assert.deepEqual([snapshot(relativeAlias), snapshot(absoluteAlias)], before);
  });

  it("prunes stale owned links while preserving unowned canonical links, BMAD output, and Hermes content", (context) => {
    const catalog = catalogFor(context);
    manifest(catalog.project, { skills: ["alpha", "beta"], inherit_global: false });
    json(catalog, ["--scope", "project"]);
    link(join(activation(catalog.project), "gamma"), join(catalog.registry, "all-skills", "gamma"));
    const privateSkill = directory(join(catalog.root, "private-skill"));
    write(join(privateSkill, "SKILL.md"), "# Unrelated private skill\n");
    const privateLink = link(join(activation(catalog.project), "private"), privateSkill);
    const bmad = write(
      join(activation(catalog.project), "bmad", "SKILL.md"),
      "# Installer-owned BMAD skill\n",
    );
    const hermes = write(
      join(catalog.home, ".hermes", "profiles", "research", "skills", "private", "SKILL.md"),
      "# Profile-owned skill\n",
    );
    const overlay = write(
      join(catalog.home, ".hermes", "skills", "runtime", "SKILL.md"),
      "# Runtime overlay\n",
    );
    const preserved = [
      snapshot(bmad),
      snapshot(hermes),
      snapshot(overlay),
      snapshot(join(activation(catalog.project), "gamma")),
      snapshot(privateLink),
    ];
    manifest(catalog.project, { skills: ["beta"], inherit_global: false });
    json(catalog);
    assert.equal(existsSync(join(activation(catalog.project), "alpha")), false);
    assertProjection(catalog, catalog.project, ["beta"], "project");
    assert.deepEqual(
      [
        snapshot(bmad),
        snapshot(hermes),
        snapshot(overlay),
        snapshot(join(activation(catalog.project), "gamma")),
        snapshot(privateLink),
      ],
      preserved,
    );
  });

  it("does not adopt a preexisting canonical link when its desired selection later disappears", (context) => {
    const catalog = catalogFor(context);
    manifest(catalog.project, { skills: ["alpha"], inherit_global: false });
    const existing = link(
      join(activation(catalog.project), "alpha"),
      join(catalog.registry, "all-skills", "alpha"),
    );
    const identity = snapshot(existing);
    json(catalog, ["--scope", "project"]);
    manifest(catalog.project, { skills: [], inherit_global: false });
    json(catalog, ["--scope", "project"]);
    assert.deepEqual(snapshot(existing), identity);
  });

  it("never imports pruning authority from an unchanged legacy Python receipt", (context) => {
    const catalog = catalogFor(context);
    manifest(catalog.project, { skills: [], inherit_global: false });
    const root = activation(catalog.project);
    const target = join(catalog.registry, "all-skills", "alpha");
    const existing = link(join(root, "alpha"), target);
    const digest = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
    const receipt = write(
      join(catalog.state, "skillex", "projections", `${digest}.json`),
      `${JSON.stringify({
        version: 1,
        root,
        scope: "project",
        mode: "composed",
        alias_target: null,
        entries: { alpha: { target, origin: "skill:alpha", stage: "project" } },
        manifests: [],
        registry_roots: [],
        written_at: "2026-01-01T00:00:00Z",
        generator: "skillex 0.1.0",
      })}\n`,
    );
    const before = [snapshot(receipt), snapshot(existing)];
    json(catalog, ["--scope", "project"]);
    assert.deepEqual([snapshot(receipt), snapshot(existing)], before);
  });

  for (const collision of [
    "canonical skill",
    "BMAD alias directory",
    "foreign alias",
    "symlinked alias parent",
  ]) {
    it(`refuses a ${collision} collision before changing either scope`, (context) => {
      const catalog = catalogFor(context);
      const outside = directory(join(catalog.root, "outside"));
      write(join(outside, "preserve.md"), "Unrelated content.\n");
      if (collision === "canonical skill")
        write(
          join(activation(catalog.project), "alpha", "SKILL.md"),
          "# Existing owned definition\n",
        );
      if (collision === "BMAD alias directory")
        write(
          join(catalog.project, ".claude", "skills", "bmad", "SKILL.md"),
          "# BMAD installer output\n",
        );
      if (collision === "foreign alias") link(join(catalog.project, ".claude", "skills"), outside);
      if (collision === "symlinked alias parent") link(join(catalog.project, ".claude"), outside);
      namedError(unchangedProtected(catalog, () => json(catalog, [], 3)));
      assert.equal(existsSync(activation(catalog.home)), false);
    });
  }

  it("switches composed roots to exclusive packs, changes versions, and restores dormant selections", (context) => {
    const catalog = catalogFor(context);
    const ordinary = { skills: ["alpha", "beta"], inherit_global: false };
    manifest(catalog.project, ordinary);
    const first = catalog.pack("editor", "1.0.0", ["gamma"]);
    const second = catalog.pack("editor", "2.0.0", ["beta"]);
    const source = snapshot(catalog.registry);
    json(catalog, ["--scope", "project"]);
    const aliases = projectAliases.map((alias) => snapshot(join(catalog.project, alias)));
    for (const [version, pack, names] of [
      ["1.0.0", first, ["gamma"]],
      ["2.0.0", second, ["beta"]],
    ]) {
      manifest(catalog.project, { ...ordinary, packs: [{ name: "editor", version }] });
      const result = json(catalog, ["--scope", "project"]);
      assert.equal(result.data.scopes.find(({ scope }) => scope === "project").mode, "pack");
      assertProjection(catalog, catalog.project, names, "project", "pack", pack);
      assert.deepEqual(readdirSync(activation(catalog.project)).sort(), names);
    }
    manifest(catalog.project, ordinary);
    const restored = json(catalog, ["--scope", "project"]);
    assert.equal(restored.data.scopes.find(({ scope }) => scope === "project").mode, "composed");
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
    assert.deepEqual(readdirSync(activation(catalog.project)).sort(), ["alpha", "beta"]);
    assert.deepEqual(
      projectAliases.map((alias) => snapshot(join(catalog.project, alias))),
      aliases,
    );
    assert.deepEqual(snapshot(catalog.registry), source);
  });

  it("verifies pack membership before activating a whole-root alias", (context) => {
    const catalog = catalogFor(context);
    catalog.pack("unmaterialized", "1.0.0", ["alpha"], false);
    manifest(catalog.project, { packs: ["unmaterialized"], inherit_global: false });
    namedError(
      unchanged(catalog.root, () =>
        json(catalog, ["--scope", "project", "--dry-run", "--exit-code"], 3),
      ),
    );
    namedError(unchangedProtected(catalog, () => json(catalog, ["--scope", "project"], 3)));
    assert.equal(existsSync(activation(catalog.project)), false);
  });

  it("preserves activation and receipts when an optional pack or set cannot be fully resolved", (context) => {
    const catalog = catalogFor(context);
    manifest(catalog.project, { skills: ["alpha"], inherit_global: false });
    json(catalog, ["--scope", "project"]);
    for (const declaration of [
      { packs: [{ name: "missing", optional: true }], inherit_global: false },
      { skills: ["beta"], sets: [{ name: "missing", optional: true }], inherit_global: false },
    ]) {
      manifest(catalog.project, declaration);
      const preview = unchanged(catalog.root, () =>
        json(catalog, ["--scope", "project", "--dry-run", "--exit-code"], 4),
      );
      assert.ok(preview.findings.some(({ code }) => code === "W_OPTIONAL_SKIPPED"));
      const result = unchangedProtected(catalog, () => json(catalog, ["--scope", "project"], 4));
      assert.ok(result.findings.some(({ code }) => code === "W_OPTIONAL_SKIPPED"));
      assert.deepEqual(readdirSync(activation(catalog.project)), ["alpha"]);
    }
  });

  it("serializes concurrent installed invocations and leaves a converged projection", (context) => {
    const catalog = catalogFor(context);
    const args = ["sync", "--registry-root", catalog.registry, "--json"];
    const results = JSON.parse(
      module(`
      import { spawn } from 'node:child_process';
      function run() {
        return new Promise((resolve, reject) => {
          const child = spawn(${JSON.stringify(fixture.cli)}, ${JSON.stringify(args)}, {
            cwd: ${JSON.stringify(catalog.cwd)}, env: ${JSON.stringify(catalog.environment)},
          });
          let stdout = ''; let stderr = '';
          child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
          child.stdout.on('data', chunk => { stdout += chunk; });
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.on('error', reject);
          child.on('close', (status, signal) => signal ? reject(new Error(signal)) : resolve({status, stdout, stderr}));
        });
      }
      process.stdout.write(JSON.stringify(await Promise.all([run(), run()])));
    `),
    );
    for (const result of results) parsed(result, "sync", 0);
    assertProjection(catalog, catalog.home, ["alpha"], "global");
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
    assert.deepEqual(
      unchanged(catalog.root, () => json(catalog, ["--dry-run", "--exit-code"])).data.changes,
      [],
    );
  });

  it("reports lock contention from the installed CLI and succeeds after the owner releases", (context) => {
    const catalog = catalogFor(context);
    const args = ["sync", "--registry-root", catalog.registry, "--json"];
    const output = unchangedProtected(catalog, () =>
      module(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { withLock } from '${packageName}';
      await withLock('skillex:activation:v2', async () => {
        const result = spawnSync(${JSON.stringify(fixture.cli)}, ${JSON.stringify(args)}, {
          cwd: ${JSON.stringify(catalog.cwd)}, env: ${JSON.stringify(catalog.environment)},
          encoding: 'utf8', timeout: 10_000,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        process.stdout.write(JSON.stringify({status: result.status, stdout: result.stdout, stderr: result.stderr}));
      }, {stateHome: ${JSON.stringify(catalog.state)}});
    `),
    );
    namedError(parsed(JSON.parse(output), "sync", 5), "E_LOCK_BUSY");
    json(catalog);
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
  });

  it("handles SIGINT while waiting for the activation lock and converges on rerun", (context) => {
    const catalog = catalogFor(context);
    const args = ["sync", "--registry-root", catalog.registry, "--json"];
    const output = unchangedProtected(catalog, () =>
      module(`
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      import { readdirSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      import { withLock } from '${packageName}';
      const state = ${JSON.stringify(catalog.state)};
      await withLock('skillex:activation:v2', async () => {
        const before = new Set(readdirSync(state, {recursive: true}));
        const child = spawn(${JSON.stringify(fixture.cli)}, ${JSON.stringify(args)}, {
          cwd: ${JSON.stringify(catalog.cwd)}, env: ${JSON.stringify(catalog.environment)},
        });
        let stdout = ''; let stderr = ''; let ended = false; let timeout;
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const closed = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (status, signal) => {
            ended = true;
            resolve({status, signal, stdout, stderr});
          });
        });
        closed.catch(() => {});
        try {
          // The held owner is idle, and only this child can add state paths.
          // Its new lock claim proves the sync action is active before SIGINT.
          const waiting = () => readdirSync(state, {recursive: true}).some(path => !before.has(path));
          const deadline = Date.now() + 5_000;
          while (!ended && !waiting() && Date.now() < deadline) await delay(10);
          assert.equal(ended, false, 'CLI exited before entering lock acquisition: ' + stdout + stderr);
          assert.ok(waiting(), 'CLI never entered lock acquisition');
          assert.equal(child.kill('SIGINT'), true);
          const result = await Promise.race([
            closed,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('SIGINT did not stop the CLI')), 10_000);
            }),
          ]);
          assert.equal(result.signal, null, 'SIGINT must produce the JSON interruption result');
          process.stdout.write(JSON.stringify(result));
        } finally {
          clearTimeout(timeout);
          if (!ended) {
            child.kill('SIGKILL');
            await closed.catch(() => {});
          }
        }
      }, {stateHome: state});
    `),
    );
    const interrupted = parsed(JSON.parse(output), "sync", 130);
    namedError(interrupted, "E_INTERRUPTED");
    assert.deepEqual(interrupted.data?.applied ?? [], []);
    assert.equal(existsSync(activation(catalog.home)), false);
    assert.equal(existsSync(activation(catalog.project)), false);
    assert.equal(existsSync(catalog.receipts), false);
    json(catalog);
    assertProjection(catalog, catalog.home, ["alpha"], "global");
    assertProjection(catalog, catalog.project, ["alpha", "beta"], "project");
    assert.deepEqual(
      unchanged(catalog.root, () => json(catalog, ["--dry-run", "--exit-code"])).data.changes,
      [],
    );
  });

  it("prints human previews and sync help with the supported options", (context) => {
    const catalog = catalogFor(context);
    const result = unchanged(catalog.root, () =>
      run(catalog, ["sync", "--dry-run", "--registry-root", catalog.registry]),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.trim().length > 0);
    assert.doesNotMatch(result.stdout, /^\s*\{/);
    const help = unchanged(catalog.root, () =>
      parsed(run(catalog, ["sync", "--help", "--json"]), "help", 0),
    );
    for (const option of [
      "--scope",
      "--project",
      "--dry-run",
      "--exit-code",
      "--registry-root",
      "--json",
    ]) {
      assert.ok(help.data.help.includes(option), `sync help is missing ${option}`);
    }
  });

  it("rejects exit-code without dry-run and preserves usage/configuration errors over drift", (context) => {
    const catalog = catalogFor(context);
    namedError(unchanged(catalog.root, () => json(catalog, ["--exit-code"], 2)));
    const usage = unchanged(catalog.root, () =>
      parsed(run(catalog, ["sync", "--unknown-option", "--json"]), "cli", 2),
    );
    namedError(usage, "E_USAGE");
    manifest(catalog.project, { skills: ["../unsafe"] });
    namedError(unchanged(catalog.root, () => json(catalog, ["--dry-run", "--exit-code"], 2)));
    assert.equal(existsSync(catalog.state), false);
  });
});
