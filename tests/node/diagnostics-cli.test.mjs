import assert from "node:assert/strict";
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
import { after, before, describe, it } from "node:test";
import { createPackageFixture, nodeBinary, packageName } from "./package-fixture.mjs";

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

function manifest(root, value) {
  write(join(root, ".agents", "skills.json"), `${JSON.stringify(value)}\n`);
}

function activation(root) {
  return join(root, ".agents", "skills");
}

function snapshot(root) {
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    const prefix = [relative(root, path), stat.mode, stat.ino, stat.dev, stat.mtimeMs];
    if (stat.isSymbolicLink()) entries.push([...prefix, "link", readlinkSync(path)]);
    else if (stat.isDirectory()) {
      entries.push([...prefix, "directory"]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else
      entries.push([
        ...prefix,
        "file",
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
    assert.deepEqual(
      snapshot(root),
      before,
      "diagnostic changed fixture bytes, identities, or state",
    );
  }
}

describe("installed diagnostics CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function catalogFor(context) {
    const root = realpathSync(mkdtempSync("/tmp/skillex-diagnostics-cli-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const home = directory(join(root, "home"));
    const project = directory(join(root, "project"));
    const cwd = directory(join(project, "src", "nested"));
    const registry = directory(join(root, "registry"));
    const state = join(root, "state");
    const bin = directory(join(root, "bin"));
    symlinkSync(nodeBinary, join(bin, "node"));
    directory(join(project, ".git"));
    for (const child of ["all-skills", "sets", "packs"]) directory(join(registry, child));
    for (const name of ["alpha", "beta", "gamma"])
      write(
        join(registry, "all-skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Canonical diagnostics fixture\n---\n\n# ${name}\n`,
      );
    manifest(home, { skills: ["alpha"] });
    manifest(project, { skills: ["beta"] });
    function processTable(table = "") {
      const path = write(
        join(bin, "ps"),
        `#!/usr/bin/env node\nif (process.argv.slice(2).join('\\0') !== '-axo\\0pid=,args=') process.exit(2);\nprocess.stdout.write(${JSON.stringify(table)});\n`,
      );
      chmodSync(path, 0o755);
    }
    processTable();
    return {
      root,
      home,
      project,
      cwd,
      registry,
      state,
      bin,
      processTable,
      environment: {
        PATH: bin,
        HOME: home,
        XDG_STATE_HOME: state,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
        NO_COLOR: "1",
        TERM: "dumb",
      },
      set(name, members) {
        const path = directory(join(registry, "sets", name));
        for (const member of members)
          link(join(path, member), join(registry, "all-skills", member));
        return path;
      },
      pack(name, version, members) {
        const path = join(registry, "packs", name, version);
        write(
          join(path, "pack.toml"),
          `[pack]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\n\n[freeform]\nskills = ${JSON.stringify(members)}\n`,
        );
        directory(join(path, "skills"));
        for (const member of members)
          link(join(path, "skills", member), join(registry, "all-skills", member));
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
    assert.equal(result.stderr, "", "JSON diagnostics must remain in the single result envelope");
    assert.equal(
      result.stdout.includes(String.fromCharCode(27)),
      false,
      "JSON output must not contain ANSI escapes",
    );
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
        : placement === "middle"
          ? [args[0], ...flags, ...args.slice(1)]
          : [...args, ...flags];
    return unchanged(catalog.root, () => parsed(run(catalog, actual), args[0], exit));
  }

  function setup(catalog, args = ["sync"]) {
    return parsed(
      run(catalog, [...args, "--registry-root", catalog.registry, "--json"]),
      args[0] === "skill" ? "skill import" : args[0],
      0,
    );
  }

  function scope(result, name = "project") {
    const value = result.data.scopes.find((entry) => entry.scope === name);
    assert.ok(value, `missing scope ${name}: ${JSON.stringify(result.data)}`);
    return value;
  }

  function finding(result, code) {
    const value = result.findings.find((entry) => !code || entry.code === code);
    assert.ok(value, `missing ${code ?? "finding"}: ${JSON.stringify(result.findings)}`);
    assert.match(value.code, /^[EWI]_[A-Z0-9_]+$/);
    assert.ok(value.message.length > 0);
    assert.ok(value.fix);
    return value;
  }

  it("exports installed diagnostics APIs and runs without Python or uv", (context) => {
    const catalog = catalogFor(context);
    assert.equal(
      unchanged(catalog.root, () =>
        module(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      const core = await import('${packageName}');
      for (const name of ['inspectStatus', 'explainSkill', 'doctor']) assert.equal(typeof core[name], 'function');
      for (const name of ['python', 'python3', 'uv']) {
        const result = spawnSync(name, ['--version'], {env: ${JSON.stringify(catalog.environment)}});
        assert.equal(result.error?.code, 'ENOENT');
      }
    `),
      ),
      "",
    );
  });

  it("reports healthy global/project roots, ownership, counts, and every supported alias", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    for (const placement of ["root", "leaf"]) {
      const result = json(catalog, ["status"], 0, placement);
      assert.deepEqual(result.data.writeScopes, ["global", "project"]);
      assert.deepEqual(result.data.changes, []);
      for (const [name, root, desired, aliases] of [
        ["global", catalog.home, ["alpha"], 8],
        ["project", catalog.project, ["alpha", "beta"], 6],
      ]) {
        const report = scope(result, name);
        assert.equal(report.root, root);
        assert.equal(report.mode, "composed");
        assert.deepEqual(report.desired, desired);
        assert.equal(report.actual.root.path, activation(root));
        assert.equal(report.actual.root.kind, "directory");
        assert.deepEqual(report.counts, {
          desired: desired.length,
          actual: desired.length,
          owned: desired.length,
          foreign: 0,
          pack: 0,
          missing: 0,
        });
        assert.equal(report.aliases.length, aliases);
        assert.ok(report.aliases.every(({ reachable, reachesRoot }) => reachable && reachesRoot));
        assert.equal(report.receipt.state, "valid");
      }
    }
    const selected = json(catalog, ["status", "--scope", "project", "--project", catalog.project]);
    assert.deepEqual(selected.data.writeScopes, ["project"]);
    assert.equal(scope(selected).root, catalog.project);
    const doctor = json(catalog, ["doctor"]);
    assert.equal(doctor.data.sourcesOnly, false);
    assert.equal(doctor.data.writers.processObservation, "complete");
    assert.deepEqual(doctor.data.writers.configured, []);
    assert.deepEqual(doctor.data.writers.running, []);
  });

  it("reports exclusive pack mode and pack-owned membership through a whole-root alias", (context) => {
    const catalog = catalogFor(context);
    const pack = catalog.pack("editor", "1.0.0", ["gamma"]);
    manifest(catalog.project, { packs: ["editor"] });
    setup(catalog);
    const report = scope(json(catalog, ["status"]));
    assert.equal(report.mode, "pack");
    assert.equal(report.actual.root.kind, "link");
    assert.equal(report.actual.root.target, join(pack, "skills"));
    assert.deepEqual(report.desired, ["gamma"]);
    assert.equal(report.counts.pack, 1);
    assert.equal(report.actual.entries[0].ownership, "pack");
    assert.ok(report.aliases.every(({ reachesRoot }) => reachesRoot));
    json(catalog, ["doctor"]);

    const bypass = catalogFor(context);
    const directPack = bypass.pack("editor", "1.0.0", ["gamma"]);
    manifest(bypass.project, { packs: ["editor"] });
    const alias = join(bypass.project, ".claude", "skills");
    link(alias, join(directPack, "skills"));
    setup(bypass);
    const drift = json(bypass, ["status", "--scope", "project"], 6);
    finding(drift, "W_ALIAS_BYPASS_ROOT");
    const observation = scope(drift).aliases.find(({ path }) => path === alias);
    assert.equal(observation.reachable, true);
    assert.equal(observation.reachesRoot, false);
    assert.equal(observation.ownership, "foreign");
    const explanation = json(bypass, ["explain", "gamma", "--scope", "project"], 6);
    finding(explanation, "W_ALIAS_BYPASS_ROOT");
    assert.equal(scope(explanation).aliases.find(({ path }) => path === alias).reachable, true);
    const human = unchanged(bypass.root, () =>
      run(bypass, ["status", "--scope", "project", "--registry-root", bypass.registry]),
    );
    assert.equal(human.status, 6, human.stdout + human.stderr);
    assert.match(human.stdout, /reachable, bypasses scope root/);
  });

  it("reports missing activation as drift while sources-only doctor ignores activation and runtime", (context) => {
    const catalog = catalogFor(context);
    const result = json(catalog, ["status"], 6);
    for (const name of ["global", "project"]) {
      const report = scope(result, name);
      assert.equal(report.actual.root.kind, "missing");
      assert.equal(report.counts.actual, 0);
      assert.ok(report.counts.missing > 0);
      assert.equal(report.receipt.state, "missing");
    }
    json(catalog, ["doctor"], 6);
    const sources = json(catalog, ["doctor", "--sources-only"]);
    assert.equal(sources.data.status, null);
    assert.equal(sources.data.writers, null);
    assert.equal(sources.data.sources[0].canonicalSkills, 3);
    assert.equal(existsSync(catalog.state), false);
    const human = unchanged(catalog.root, () =>
      run(catalog, ["status", "--registry-root", catalog.registry]),
    );
    assert.equal(human.status, 6, human.stdout + human.stderr);
    assert.ok(human.stdout.includes(activation(catalog.project)));
    assert.doesNotMatch(human.stdout, /^\s*\{/);
  });

  it("distinguishes missing owned skills from dangling and incorrectly redirected aliases", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    unlinkSync(join(activation(catalog.project), "beta"));
    let report = scope(json(catalog, ["status", "--scope", "project"], 6));
    assert.equal(report.counts.missing, 1);
    assert.equal(
      report.actual.entries.some(({ name }) => name === "beta"),
      false,
    );
    const alias = join(catalog.project, ".claude", "skills");
    unlinkSync(alias);
    link(alias, join(catalog.root, "missing-target"));
    const dangling = json(catalog, ["status", "--scope", "project"], 3);
    finding(dangling);
    report = scope(dangling);
    const missingAlias = report.aliases.find(({ path }) => path === alias);
    assert.equal(missingAlias.kind, "link");
    assert.equal(missingAlias.reachable, false);
    assert.equal(missingAlias.reachesRoot, false);
    unlinkSync(alias);
    link(alias, activation(catalog.home));
    const wrong = json(catalog, ["status", "--scope", "project"], 3);
    const redirected = scope(wrong).aliases.find(({ path }) => path === alias);
    assert.equal(redirected.reachable, true);
    assert.equal(redirected.reachesRoot, false);
    assert.equal(redirected.ownership, "changed");
  });

  it("reports foreign canonical links and BMAD content without adopting ownership or touching Hermes overlays", (context) => {
    const catalog = catalogFor(context);
    link(join(activation(catalog.project), "gamma"), join(catalog.registry, "all-skills", "gamma"));
    write(join(activation(catalog.project), "bmad", "SKILL.md"), "# Installer-owned skill\n");
    write(join(catalog.home, ".hermes", "skills", "runtime", "SKILL.md"), "# Runtime overlay\n");
    setup(catalog);
    const report = scope(json(catalog, ["status"]));
    assert.equal(report.counts.owned, 2);
    assert.equal(report.counts.foreign, 2);
    for (const name of ["gamma", "bmad"])
      assert.equal(report.actual.entries.find((entry) => entry.name === name).ownership, "foreign");
  });

  it("retains useful actual observations for required and optional missing selections", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    manifest(catalog.project, { skills: ["missing"], inherit_global: false });
    const result = json(catalog, ["status", "--scope", "project"], 3);
    finding(result, "E_SKILL_MISSING");
    const report = scope(result);
    assert.equal(report.actual.root.kind, "directory");
    assert.deepEqual(report.actual.entries.map(({ name }) => name).sort(), ["alpha", "beta"]);
    assert.equal(report.receipt.state, "valid");
    assert.equal(report.desired, null);
    manifest(catalog.project, {
      sets: [{ name: "missing", optional: true }],
      inherit_global: false,
    });
    const partial = json(catalog, ["status", "--scope", "project"], 4);
    finding(partial, "W_OPTIONAL_SKIPPED");
    assert.deepEqual(
      scope(partial)
        .actual.entries.map(({ name }) => name)
        .sort(),
      ["alpha", "beta"],
    );
  });

  it("explains inherited, set, and direct origins as well as local exclusion", (context) => {
    const catalog = catalogFor(context);
    catalog.set("writers", ["alpha", "beta"]);
    manifest(catalog.project, { skills: ["alpha"], sets: ["writers"], exclude: ["beta"] });
    setup(catalog);
    const result = json(catalog, ["explain", "alpha", "--scope", "project"], 0, "middle");
    assert.equal(result.data.canonical, join(catalog.registry, "all-skills", "alpha"));
    const effective = scope(result);
    assert.equal(effective.state, "effective");
    for (const kind of ["inherit", "set", "skill"])
      assert.ok(effective.origins.some((origin) => origin.kind === kind));
    assert.ok(effective.origins.some(({ reference }) => reference === "writers"));
    assert.ok(effective.aliases.every(({ reachable }) => reachable));
    const excluded = scope(json(catalog, ["explain", "beta", "--scope", "project"]));
    assert.equal(excluded.state, "excluded");
    assert.equal(excluded.canonical, join(catalog.registry, "all-skills", "beta"));
    assert.ok(excluded.exclusions.length > 0);
    assert.ok(
      excluded.exclusions.some(({ origins }) => origins.some(({ kind }) => kind === "set")),
    );
    assert.ok(excluded.aliases.every(({ reachable }) => !reachable));
  });

  it("explains dormant ordinary selections without treating them as failures under an active pack", (context) => {
    const catalog = catalogFor(context);
    catalog.pack("editor", "1.0.0", ["gamma"]);
    manifest(catalog.project, { skills: ["beta"], packs: ["editor"] });
    setup(catalog);
    const result = json(catalog, ["explain", "beta", "--scope", "project"]);
    const report = scope(result);
    assert.equal(report.state, "dormant");
    assert.equal(report.canonical, join(catalog.registry, "all-skills", "beta"));
    assert.ok(
      report.dormant.some(({ kind, reference }) => kind === "skill" && reference === "beta"),
    );
    assert.ok(report.aliases.every(({ reachable }) => !reachable));
  });

  it("distinguishes a known unselected name from a missing canonical name", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    const known = json(catalog, ["explain", "gamma"]);
    assert.equal(known.data.canonical, join(catalog.registry, "all-skills", "gamma"));
    assert.ok(known.data.scopes.every(({ state }) => state === "unselected"));
    const unknown = json(catalog, ["explain", "missing"], 3);
    finding(unknown, "E_SKILL_MISSING");
  });

  it("keeps noncanonical catalog aliases and copied set/pack definitions as source failures", (context) => {
    const catalog = catalogFor(context);
    const alias = join(catalog.registry, "all-skills", "alias");
    link(alias, join(catalog.registry, "all-skills", "alpha"));
    const copiedSet = write(
      join(catalog.registry, "sets", "copied", "alpha", "SKILL.md"),
      readFileSync(join(catalog.registry, "all-skills", "alpha", "SKILL.md")),
    );
    const pack = catalog.pack("copied", "1.0.0", ["gamma"]);
    unlinkSync(join(pack, "skills", "gamma"));
    const copiedPack = write(
      join(pack, "skills", "gamma", "SKILL.md"),
      readFileSync(join(catalog.registry, "all-skills", "gamma", "SKILL.md")),
    );
    const result = json(catalog, ["doctor", "--sources-only"], 3);
    finding(result, "E_NONCANONICAL_REFERENCE");
    for (const expected of [alias, dirname(copiedSet), dirname(copiedPack)]) {
      assert.ok(
        result.findings.some(
          ({ path }) => path && (path === expected || path.startsWith(`${expected}/`)),
        ),
        `missing source finding for ${expected}`,
      );
    }
    assert.equal(existsSync(catalog.state), false);
  });

  it("reports malformed provenance as a configuration error", (context) => {
    const catalog = catalogFor(context);
    const path = write(
      join(catalog.registry, "all-skills", "alpha", ".source.yaml"),
      "origin: [unterminated\n",
    );
    const result = json(catalog, ["doctor", "--sources-only"], 2);
    assert.equal(finding(result, "E_SKILL_PROVENANCE_INVALID").path, path);
  });

  it("detects changed imported content from its recorded digest without refreshing provenance", (context) => {
    const catalog = catalogFor(context);
    const source = directory(join(catalog.root, "import-source"));
    write(
      join(source, "SKILL.md"),
      "---\nname: imported\ndescription: Imported fixture\n---\n\n# Original\n",
    );
    setup(catalog, ["skill", "import", source, "--name", "imported"]);
    json(catalog, ["doctor", "--sources-only"]);
    const path = join(catalog.registry, "all-skills", "imported", "SKILL.md");
    write(path, `${readFileSync(path, "utf8")}\nA local content change.\n`);
    const result = json(catalog, ["doctor", "--sources-only"], 6);
    finding(result, "W_SKILL_DIGEST_DRIFT");
    assert.ok(result.data.sources.some(({ digestsChecked }) => digestsChecked > 0));
  });

  it("separates configured writer references with source lines from observed running writers", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    const config = write(
      join(catalog.project, "mise.toml"),
      '[tasks.legacy]\nrun = "uv run /legacy/sync-skills.py"\n',
    );
    const service = write(
      join(catalog.environment.XDG_CONFIG_HOME, "systemd", "user", "legacy.service"),
      "[Service]\nExecStart=/usr/bin/python3 /legacy/sync-skills.py --global\n",
    );
    const configured = json(catalog, ["doctor"], 6);
    finding(configured, "W_LEGACY_WRITER_CONFIGURED");
    assert.ok(
      configured.data.writers.configured.some(
        ({ kind, path, line }) => kind === "mise" && path === config && line === 2,
      ),
    );
    assert.ok(
      configured.data.writers.configured.some(
        ({ kind, path, line }) => kind === "service" && path === service && line === 2,
      ),
    );
    assert.deepEqual(configured.data.writers.running, []);
    catalog.processTable("4242 /usr/bin/python3 /legacy/sync-skills.py --global\n");
    const running = json(catalog, ["doctor"], 6);
    finding(running, "W_LEGACY_WRITER_RUNNING");
    assert.ok(
      running.data.writers.running.some(
        ({ pid, entrypoint }) => pid === 4242 && entrypoint.includes("sync-skills.py"),
      ),
    );
    const sources = json(catalog, ["doctor", "--sources-only"]);
    assert.equal(sources.data.writers, null);
  });

  it("does not treat legacy receipts or quoted/read-only process text as a running writer", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    const root = activation(catalog.project);
    const digest = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
    write(
      join(catalog.state, "skillex", "projections", `${digest}.json`),
      `${JSON.stringify({
        version: 1,
        root,
        scope: "project",
        mode: "composed",
        alias_target: null,
        entries: {
          alpha: {
            target: join(catalog.registry, "all-skills", "alpha"),
            origin: "skill:alpha",
            stage: "project",
          },
        },
        manifests: [],
        registry_roots: [],
        written_at: "2026-01-01T00:00:00Z",
        generator: "skillex 0.1.0",
      })}\n`,
    );
    catalog.processTable(
      '4242 /usr/bin/node -e console.log("sync-skills.py")\n4243 /usr/bin/python3 /legacy/skill_ssot.py doctor\n4244 /usr/bin/grep sync-skills.py\n',
    );
    const result = json(catalog, ["doctor"]);
    assert.deepEqual(result.data.writers.running, []);
    assert.equal(result.data.writers.processObservation, "complete");
    assert.equal(
      result.findings.some(({ code }) => code === "W_LEGACY_WRITER_RUNNING"),
      false,
    );
  });

  it("reports unavailable process observation as incomplete while sources-only remains independent", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    unlinkSync(join(catalog.bin, "ps"));
    const result = json(catalog, ["doctor"], 4);
    finding(result, "W_PROCESS_OBSERVATION_UNKNOWN");
    assert.equal(result.data.writers.processObservation, "unknown");
    const sources = json(catalog, ["doctor", "--sources-only"]);
    assert.equal(sources.data.writers, null);
    assert.equal(sources.data.status, null);
  });

  it("keeps malformed scope and explicit-root errors visible without inventing source fallback", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    write(join(catalog.project, ".agents", "skills.json"), "{ malformed\n");
    const invalid = json(catalog, ["status", "--scope", "project"], 2);
    finding(invalid, "E_MANIFEST_PARSE");
    assert.equal(scope(invalid).actual.root.kind, "directory");
    const sources = json(catalog, ["doctor", "--sources-only", "--scope", "project"], 2);
    finding(sources, "E_MANIFEST_PARSE");
    assert.equal(sources.data.status, null);
    assert.equal(sources.data.writers, null);
    manifest(catalog.project, { skills: ["beta"] });
    const missingProject = json(
      catalog,
      [
        "doctor",
        "--sources-only",
        "--scope",
        "project",
        "--project",
        join(catalog.root, "missing-project"),
      ],
      2,
    );
    finding(missingProject, "E_PROJECT_ROOT");
    const missing = join(catalog.root, "missing-registry");
    const result = unchanged(catalog.root, () =>
      parsed(
        run(catalog, ["doctor", "--sources-only", "--registry-root", missing, "--json"]),
        "doctor",
        2,
      ),
    );
    finding(result, "E_REGISTRY_ROOT");
  });

  it("provides human reports and JSON help while refusing write-style diagnostic flags", (context) => {
    const catalog = catalogFor(context);
    setup(catalog);
    for (const args of [["status"], ["explain", "alpha"], ["doctor"]]) {
      const result = unchanged(catalog.root, () =>
        run(catalog, [...args, "--registry-root", catalog.registry]),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.trim().length > 0);
      assert.doesNotMatch(result.stdout, /^\s*\{/);
      if (args[0] !== "doctor")
        assert.ok(result.stdout.includes("alpha") || result.stdout.includes("global"));
    }
    for (const command of ["status", "explain", "doctor"]) {
      const help = unchanged(catalog.root, () =>
        parsed(run(catalog, [command, "--help", "--json"]), "help", 0),
      );
      for (const option of ["--json", "--registry-root", "--scope", "--project"])
        assert.ok(help.data.help.includes(option));
      if (command === "doctor") assert.ok(help.data.help.includes("--sources-only"));
      assert.doesNotMatch(help.data.help, /--repair|--dry-run/);
    }
    for (const args of [
      ["explain", "--json"],
      ["status", "--dry-run", "--json"],
      ["doctor", "--repair", "--json"],
    ]) {
      const result = unchanged(catalog.root, () => parsed(run(catalog, args), "cli", 2));
      finding(result, "E_USAGE");
    }
  });
});
