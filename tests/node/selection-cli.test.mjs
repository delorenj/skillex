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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPackageFixture, packageName } from "./package-fixture.mjs";

function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function write(path, content) {
  directory(dirname(path));
  writeFileSync(path, content);
  return path;
}

function link(path, target) {
  directory(dirname(path));
  symlinkSync(relative(dirname(path), target), path);
}

function manifestPath(root) {
  return join(root, ".agents", "skills.json");
}

function manifest(root, value) {
  write(manifestPath(root), `${JSON.stringify(value, null, 2)}\n`);
}

function readManifest(root) {
  return JSON.parse(readFileSync(manifestPath(root), "utf8"));
}

function names(value, key) {
  return (value[key] ?? []).map((entry) => (typeof entry === "string" ? entry : entry.name));
}

function activation(root) {
  return join(root, ".agents", "skills");
}

function snapshot(root) {
  if (!existsSync(root)) return null;
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    const identity = [stat.mode, stat.ino, stat.dev, stat.mtimeMs];
    const name = relative(root, path);
    if (stat.isSymbolicLink()) entries.push([name, "link", ...identity, readlinkSync(path)]);
    else if (stat.isDirectory()) {
      entries.push([name, "directory", ...identity]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else
      entries.push([
        name,
        "file",
        ...identity,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
  }
  visit(root);
  return entries;
}

function unchanged(root, action) {
  const before = snapshot(root);
  try {
    return action();
  } finally {
    assert.deepEqual(snapshot(root), before, "preview changed fixture bytes or identities");
  }
}

function protectedSnapshot(catalog) {
  return {
    content: snapshot(catalog.root)
      .filter(([name]) => name !== "state" && !name.startsWith("state/"))
      .map((entry) => (entry[0] === "" ? entry.slice(0, -1) : entry)),
    receipts: snapshot(catalog.receipts),
  };
}

function unchangedProtected(catalog, action) {
  const before = protectedSnapshot(catalog);
  try {
    return action();
  } finally {
    assert.deepEqual(
      protectedSnapshot(catalog),
      before,
      "refusal changed declaration or activation state",
    );
  }
}

describe("installed selection CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function catalogFor(context, options = {}) {
    const root = realpathSync(mkdtempSync("/tmp/skillex-selection-cli-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const home = directory(join(root, "home"));
    const project = directory(join(root, "project"));
    const cwd = directory(join(project, "src", "nested"));
    const registry = directory(join(root, "registry"));
    const state = join(root, "state");
    directory(join(project, ".git"));
    for (const child of ["all-skills", "sets", "packs"]) directory(join(registry, child));
    for (const name of ["alpha", "beta", "gamma"])
      write(
        join(registry, "all-skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Canonical selection fixture\n---\n\n# ${name}\n`,
      );
    if (options.homeManifest !== null)
      manifest(home, options.homeManifest ?? { skills: ["alpha"] });
    if (options.projectManifest !== null)
      manifest(project, options.projectManifest ?? { skills: [] });
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
      set(name, members) {
        const path = directory(join(registry, "sets", name));
        for (const member of members)
          link(join(path, member), join(registry, "all-skills", member));
        return path;
      },
      pack(name, version, members, materialize = true) {
        const path = join(registry, "packs", name, version);
        write(
          join(path, "pack.toml"),
          `[pack]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\n\n[freeform]\nskills = ${JSON.stringify(members)}\n`,
        );
        write(join(path, "references", "guide.md"), "Preserve pack support.\n");
        if (materialize) {
          directory(join(path, "skills"));
          for (const member of members)
            link(join(path, "skills", member), join(registry, "all-skills", member));
        }
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
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(result.stderr, "", "JSON diagnostics must stay inside the result envelope");
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

  function json(catalog, args, exit = 0, placement = "leaf") {
    const flags = ["--registry-root", catalog.registry, "--json"];
    const actual =
      placement === "root"
        ? [...flags, ...args]
        : placement === "family"
          ? [args[0], ...flags, ...args.slice(1)]
          : [...args, ...flags];
    return parsed(run(catalog, actual), args[0], exit);
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

  function selected(result, root, scope, dryRun = false) {
    assert.equal(result.data.scope, scope);
    assert.equal(result.data.root, root);
    assert.equal(result.data.manifestPath, manifestPath(root));
    assert.equal(result.data.dryRun, dryRun);
    assert.equal(typeof result.data.changed, "boolean");
    assert.equal(typeof result.data.saved, "boolean");
    assert.ok(Array.isArray(result.data.changes));
    assert.ok(Array.isArray(result.data.applied));
    if (dryRun) {
      assert.equal(result.data.saved, false);
      assert.deepEqual(result.data.applied, []);
    }
  }

  function assertActivated(catalog, root, expected, pack) {
    const path = activation(root);
    assert.equal(lstatSync(path).isSymbolicLink(), !!pack);
    if (pack) assert.equal(realpathSync(path), join(pack, "skills"));
    assert.deepEqual(readdirSync(path).sort(), [...expected].sort());
    for (const name of expected)
      assert.equal(realpathSync(join(path, name)), join(catalog.registry, "all-skills", name));
    for (const alias of [".claude/skills", ".codex/skills"]) {
      assert.equal(realpathSync(join(root, alias)), realpathSync(path));
    }
  }

  it("exports the selection APIs from an installed package with only Node on PATH", () => {
    assert.deepEqual(readdirSync(fixture.runtimeBin), ["node"]);
    assert.equal(
      module(`
      import assert from 'node:assert/strict';
      const core = await import('${packageName}');
      for (const name of ['initScope', 'enableSelection', 'disableSelection', 'setInheritance']) {
        assert.equal(typeof core[name], 'function', name);
      }
    `),
      "",
    );
  });

  it("initializes the nearest Git root without activation and defaults project inheritance on", (context) => {
    const catalog = catalogFor(context, { projectManifest: null });
    const home = snapshot(catalog.home);
    const result = json(catalog, ["init"]);
    selected(result, catalog.project, "project");
    assert.equal(result.data.changed, true);
    assert.equal(result.data.saved, true);
    assert.deepEqual(readManifest(catalog.project).skills ?? [], []);
    assert.equal(readManifest(catalog.project).inherit_global ?? true, true);
    assert.equal(existsSync(activation(catalog.project)), false);
    assert.equal(existsSync(join(catalog.project, ".claude")), false);
    assert.equal(existsSync(catalog.receipts), false);
    const repeated = unchangedProtected(catalog, () => json(catalog, ["init"]));
    assert.equal(repeated.data.changed, false);
    assert.equal(repeated.data.saved, false);
    assert.deepEqual(repeated.data.changes, []);
    json(catalog, ["enable", "skill", "beta"]);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    assert.deepEqual(snapshot(catalog.home), home);
  });

  it("leaves an existing declaration byte-for-byte intact when init is repeated", (context) => {
    const catalog = catalogFor(context);
    write(
      manifestPath(catalog.project),
      '{\n   "exclude": ["gamma"],\n   "skills": ["beta"],\n   "inherit_global": false\n}\n\n',
    );
    const result = unchangedProtected(catalog, () => json(catalog, ["init"]));
    assert.equal(result.data.changed, false);
    assert.equal(result.data.saved, false);
    assert.deepEqual(result.data.manifest, readManifest(catalog.project));
    assert.equal(existsSync(activation(catalog.project)), false);
  });

  it("initializes an explicit existing non-Git project without touching the nearby project", (context) => {
    const catalog = catalogFor(context);
    const target = directory(join(catalog.root, "explicit-project"));
    const nearby = snapshot(catalog.project);
    const result = json(catalog, ["init", "--project", target]);
    selected(result, target, "project");
    assert.equal(existsSync(manifestPath(target)), true);
    assert.equal(existsSync(activation(target)), false);
    assert.equal(existsSync(join(target, ".git")), false);
    assert.deepEqual(snapshot(catalog.project), nearby);
  });

  it("initializes global selection outside any project without activating it", (context) => {
    const catalog = catalogFor(context, { homeManifest: null, projectManifest: null });
    catalog.cwd = directory(join(catalog.root, "outside"));
    const result = json(catalog, ["init"]);
    selected(result, catalog.home, "global");
    assert.equal(existsSync(manifestPath(catalog.home)), true);
    assert.equal(existsSync(manifestPath(catalog.project)), false);
    assert.equal(existsSync(activation(catalog.home)), false);
  });

  for (const placement of ["root", "family", "leaf"]) {
    it(`enables a project skill immediately with shared flags at the ${placement}`, (context) => {
      const catalog = catalogFor(context);
      const home = snapshot(catalog.home);
      const source = snapshot(catalog.registry);
      const result = json(catalog, ["enable", "skill", "beta"], 0, placement);
      selected(result, catalog.project, "project");
      assert.equal(result.data.saved, true);
      assert.deepEqual(names(readManifest(catalog.project), "skills"), ["beta"]);
      assertActivated(catalog, catalog.project, ["alpha", "beta"]);
      assert.deepEqual(snapshot(catalog.home), home);
      assert.deepEqual(snapshot(catalog.registry), source);
    });
  }

  it("defaults enable to global when a Git root has no existing project declaration", (context) => {
    const catalog = catalogFor(context, { projectManifest: null });
    const project = snapshot(catalog.project);
    const result = json(catalog, ["enable", "skill", "beta"]);
    selected(result, catalog.home, "global");
    assertActivated(catalog, catalog.home, ["alpha", "beta"]);
    assert.deepEqual(snapshot(catalog.project), project);
  });

  it("honors explicit global selection while leaving the discovered project untouched", (context) => {
    const catalog = catalogFor(context);
    const project = snapshot(catalog.project);
    const result = json(catalog, ["enable", "skill", "beta", "--scope", "global"]);
    selected(result, catalog.home, "global");
    assertActivated(catalog, catalog.home, ["alpha", "beta"]);
    assert.deepEqual(snapshot(catalog.project), project);
  });

  it("treats the project option as an exact project target without requiring a scope flag", (context) => {
    const catalog = catalogFor(context);
    const target = directory(join(catalog.root, "selected-project"));
    manifest(target, { skills: ["gamma"], inherit_global: false });
    const nearby = snapshot(catalog.project);
    const home = snapshot(catalog.home);
    const result = json(catalog, ["enable", "skill", "beta", "--project", target]);
    selected(result, target, "project");
    assertActivated(catalog, target, ["beta", "gamma"]);
    assert.deepEqual(snapshot(catalog.project), nearby);
    assert.deepEqual(snapshot(catalog.home), home);
  });

  it("requires explicit init for a missing selected declaration instead of creating it", (context) => {
    const catalog = catalogFor(context, { projectManifest: null });
    for (const args of [
      ["enable", "skill", "beta", "--scope", "project"],
      ["disable", "skill", "alpha", "--scope", "project"],
      ["inherit", "off", "--project", catalog.project],
    ]) {
      const finding = namedError(
        unchangedProtected(catalog, () => json(catalog, args, 2)),
        "E_MANIFEST_MISSING",
      );
      assert.match(finding.fix, /init/);
    }
    assert.equal(existsSync(manifestPath(catalog.project)), false);
    assert.equal(existsSync(activation(catalog.project)), false);
  });

  it("masks inherited skills locally and reenables them without editing global intent", (context) => {
    const catalog = catalogFor(context);
    const home = snapshot(catalog.home);
    json(catalog, ["enable", "skill", "beta"]);
    json(catalog, ["disable", "skill", "alpha"]);
    assert.ok(readManifest(catalog.project).exclude.includes("alpha"));
    assert.equal(names(readManifest(catalog.project), "skills").includes("alpha"), false);
    assertActivated(catalog, catalog.project, ["beta"]);
    json(catalog, ["enable", "skill", "alpha"]);
    assert.equal((readManifest(catalog.project).exclude ?? []).includes("alpha"), false);
    assert.ok(names(readManifest(catalog.project), "skills").includes("alpha"));
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    assert.deepEqual(snapshot(catalog.home), home);
  });

  it("manages set contributions and local skill exclusions without changing the shared set", (context) => {
    const catalog = catalogFor(context);
    catalog.set("writers", ["beta", "gamma"]);
    const source = snapshot(catalog.registry);
    const home = snapshot(catalog.home);
    json(catalog, ["enable", "set", "writers"]);
    assertActivated(catalog, catalog.project, ["alpha", "beta", "gamma"]);
    json(catalog, ["disable", "skill", "gamma"]);
    assert.deepEqual(names(readManifest(catalog.project), "sets"), ["writers"]);
    assert.ok(readManifest(catalog.project).exclude.includes("gamma"));
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    json(catalog, ["enable", "skill", "gamma"]);
    assertActivated(catalog, catalog.project, ["alpha", "beta", "gamma"]);
    json(catalog, ["disable", "set", "writers"]);
    assert.deepEqual(names(readManifest(catalog.project), "sets"), []);
    assertActivated(catalog, catalog.project, ["alpha", "gamma"]);
    assert.deepEqual(snapshot(catalog.registry), source);
    assert.deepEqual(snapshot(catalog.home), home);
  });

  it("turns project inheritance off and on with immediate activation and no global write", (context) => {
    const catalog = catalogFor(context);
    const home = snapshot(catalog.home);
    json(catalog, ["enable", "skill", "beta"]);
    const off = json(catalog, ["inherit", "off"]);
    selected(off, catalog.project, "project");
    assert.equal(readManifest(catalog.project).inherit_global, false);
    assertActivated(catalog, catalog.project, ["beta"]);
    json(catalog, ["inherit", "on"]);
    assert.equal(readManifest(catalog.project).inherit_global, true);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    assert.deepEqual(snapshot(catalog.home), home);
  });

  it("retains dormant ordinary selections under a pack and restores them when it is disabled", (context) => {
    const catalog = catalogFor(context);
    catalog.set("writers", ["alpha", "gamma"]);
    const pack = catalog.pack("editor", "1.0.0", ["gamma"]);
    const ordinary = {
      skills: ["beta"],
      sets: ["writers"],
      exclude: ["gamma"],
      inherit_global: true,
    };
    manifest(catalog.project, ordinary);
    const source = snapshot(catalog.registry);
    json(catalog, ["enable", "pack", "editor@1.0.0"]);
    const active = readManifest(catalog.project);
    for (const key of Object.keys(ordinary)) assert.deepEqual(active[key], ordinary[key]);
    assertActivated(catalog, catalog.project, ["gamma"], pack);
    const preview = unchanged(catalog.root, () =>
      json(catalog, ["disable", "pack", "editor@1.0.0", "--dry-run"]),
    );
    selected(preview, catalog.project, "project", true);
    assert.ok(
      preview.data.changes.some(
        ({ action, path }) => action === "write-manifest" && path === manifestPath(catalog.project),
      ),
    );
    json(catalog, ["disable", "pack", "editor@1.0.0"]);
    assert.deepEqual(names(readManifest(catalog.project), "packs"), []);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    assert.deepEqual(snapshot(catalog.registry), source);
  });

  it("refuses skill, set, and inheritance edits while a pack is active", (context) => {
    const catalog = catalogFor(context);
    catalog.set("writers", ["beta"]);
    catalog.pack("editor", "1.0.0", ["gamma"]);
    json(catalog, ["enable", "pack", "editor@1.0.0"]);
    for (const args of [
      ["enable", "skill", "beta"],
      ["disable", "skill", "alpha"],
      ["enable", "set", "writers"],
      ["disable", "set", "writers"],
      ["inherit", "off"],
    ])
      namedError(unchangedProtected(catalog, () => json(catalog, args, 3)));
  });

  it("never disables a different pack name or version and accepts the matching unversioned name", (context) => {
    const catalog = catalogFor(context);
    catalog.pack("editor", "1.0.0", ["gamma"]);
    catalog.pack("editor", "2.0.0", ["beta"]);
    catalog.pack("other", "1.0.0", ["alpha"]);
    json(catalog, ["enable", "pack", "editor@1.0.0"]);
    for (const reference of ["other", "editor@2.0.0"])
      namedError(
        unchangedProtected(catalog, () => json(catalog, ["disable", "pack", reference], 3)),
      );
    json(catalog, ["disable", "pack", "editor"]);
    assert.deepEqual(names(readManifest(catalog.project), "packs"), []);
    assertActivated(catalog, catalog.project, ["alpha"]);
  });

  it("repairs activation drift even when enabling the same declaration requires no manifest write", (context) => {
    const catalog = catalogFor(context);
    catalog.pack("editor", "1.0.0", ["gamma"]);
    json(catalog, ["enable", "skill", "beta"]);
    const declaration = snapshot(manifestPath(catalog.project));
    unlinkSync(join(activation(catalog.project), "beta"));
    unlinkSync(join(catalog.project, ".claude", "skills"));
    const result = json(catalog, ["enable", "skill", "beta"]);
    assert.equal(result.data.changed, false);
    assert.equal(result.data.saved, false);
    assert.ok(result.data.applied.length > 0);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    assert.deepEqual(snapshot(manifestPath(catalog.project)), declaration);
    const repeated = json(catalog, ["enable", "skill", "beta"]);
    assert.deepEqual(repeated.data.changes, []);
    assert.equal(repeated.data.saved, false);
    unlinkSync(join(activation(catalog.project), "alpha"));
    const absentPack = json(catalog, ["disable", "pack", "editor"]);
    assert.equal(absentPack.data.changed, false);
    assert.equal(absentPack.data.saved, false);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    assert.deepEqual(snapshot(manifestPath(catalog.project)), declaration);
  });

  it("previews init without creating a manifest, activation, or state", (context) => {
    const catalog = catalogFor(context, { projectManifest: null });
    const result = unchanged(catalog.root, () => json(catalog, ["init", "--dry-run"]));
    selected(result, catalog.project, "project", true);
    assert.ok(
      result.data.changes.some(
        ({ action, path }) => action === "write-manifest" && path === manifestPath(catalog.project),
      ),
    );
    assert.equal(existsSync(manifestPath(catalog.project)), false);
    assert.equal(existsSync(catalog.state), false);
  });

  it("previews combined declaration, canonical link, and alias changes with zero writes", (context) => {
    const catalog = catalogFor(context);
    catalog.set("writers", ["beta", "gamma"]);
    catalog.pack("editor", "1.0.0", ["gamma"]);
    for (const args of [
      ["enable", "skill", "beta"],
      ["disable", "skill", "alpha"],
      ["enable", "set", "writers"],
      ["enable", "pack", "editor@1.0.0"],
      ["inherit", "off"],
    ]) {
      const result = unchanged(catalog.root, () => json(catalog, [...args, "--dry-run"]));
      selected(result, catalog.project, "project", true);
      const paths = new Set(result.data.changes.map(({ path }) => path));
      assert.ok(paths.has(manifestPath(catalog.project)));
      assert.ok(paths.has(activation(catalog.project)));
      assert.ok(paths.has(join(catalog.project, ".claude", "skills")));
      if (args[0] === "enable" && args[1] === "skill")
        assert.ok(paths.has(join(activation(catalog.project), "beta")));
    }
    assert.equal(existsSync(catalog.state), false);
  });

  for (const defect of ["missing skill", "colliding real content", "unverified pack"]) {
    it(`refuses ${defect} before saving selection or changing activation`, (context) => {
      const catalog = catalogFor(context);
      let args = ["enable", "skill", "missing"];
      if (defect === "colliding real content") {
        write(join(activation(catalog.project), "beta", "SKILL.md"), "# Existing definition\n");
        args = ["enable", "skill", "beta"];
      }
      if (defect === "unverified pack") {
        catalog.pack("broken", "1.0.0", ["gamma"], false);
        args = ["enable", "pack", "broken@1.0.0"];
      }
      namedError(unchangedProtected(catalog, () => json(catalog, args, 3)));
    });
  }

  it("respects a nested Git boundary for default selection and initializes that inner root", (context) => {
    const catalog = catalogFor(context);
    const inner = directory(join(catalog.project, "nested-repository"));
    directory(join(inner, ".git"));
    catalog.cwd = directory(join(inner, "src"));
    const outer = snapshot(manifestPath(catalog.project));
    selected(json(catalog, ["enable", "skill", "beta"]), catalog.home, "global");
    assert.equal(existsSync(manifestPath(inner)), false);
    selected(json(catalog, ["init"]), inner, "project");
    selected(json(catalog, ["enable", "skill", "gamma"]), inner, "project");
    assertActivated(catalog, inner, ["alpha", "beta", "gamma"]);
    assert.deepEqual(snapshot(manifestPath(catalog.project)), outer);
    assert.equal(existsSync(activation(catalog.project)), false);
  });

  it("returns JSON interruption without saving intent while enable waits for the activation lock", (context) => {
    const catalog = catalogFor(context);
    const args = ["enable", "skill", "beta", "--registry-root", catalog.registry, "--json"];
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
          // A new state path can only come from this child's active lock attempt.
          const waiting = () => readdirSync(state, {recursive: true}).some(path => !before.has(path));
          const deadline = Date.now() + 5_000;
          while (!ended && !waiting() && Date.now() < deadline) await delay(10);
          assert.equal(ended, false, 'CLI exited before lock acquisition: ' + stdout + stderr);
          assert.ok(waiting(), 'CLI never entered lock acquisition');
          assert.equal(child.kill('SIGINT'), true);
          const result = await Promise.race([
            closed,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('SIGINT did not stop selection')), 10_000);
            }),
          ]);
          assert.equal(result.signal, null);
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
    const interrupted = parsed(JSON.parse(output), "enable", 130);
    namedError(interrupted, "E_INTERRUPTED");
    assert.equal(interrupted.data?.saved ?? false, false);
    assert.deepEqual(interrupted.data?.applied ?? [], []);
    assert.equal(existsSync(activation(catalog.project)), false);
    json(catalog, ["enable", "skill", "beta"]);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
  });

  it("provides human preview/success output and actionable errors with consistent JSON usage failures", (context) => {
    const catalog = catalogFor(context);
    const args = ["enable", "skill", "beta", "--registry-root", catalog.registry];
    const preview = unchanged(catalog.root, () => run(catalog, [...args, "--dry-run"]));
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.stderr, "");
    assert.ok(preview.stdout.trim().length > 0);
    const applied = run(catalog, args);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stderr, "");
    assert.ok(applied.stdout.trim().length > 0);
    assertActivated(catalog, catalog.project, ["alpha", "beta"]);
    const error = unchangedProtected(catalog, () =>
      run(catalog, ["enable", "skill", "missing", "--registry-root", catalog.registry]),
    );
    assert.equal(error.status, 3);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /E_[A-Z0-9_]+/);
    for (const invalid of [
      ["enable", "--json"],
      ["disable", "skill", "--json"],
      ["inherit", "off", "--unknown", "--json"],
    ]) {
      namedError(
        unchanged(catalog.root, () => parsed(run(catalog, invalid), "cli", 2)),
        "E_USAGE",
      );
    }
    namedError(
      unchangedProtected(catalog, () => json(catalog, ["enable", "skill", "../unsafe"], 2)),
    );
  });
});
