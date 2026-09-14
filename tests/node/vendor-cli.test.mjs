import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { createPackageFixture, nodeBinary, packageName } from "./package-fixture.mjs";

const gitCandidate = (process.env.PATH ?? "")
  .split(delimiter)
  .map((directory) => join(directory, "git"))
  .find((path) => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
assert.ok(gitCandidate, "the test runner needs Git to prepare committed upstream fixtures");
const gitBinary = realpathSync(gitCandidate);

function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function write(path, content) {
  directory(dirname(path));
  writeFileSync(path, content);
  return path;
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const stat = lstatSync(path);
    const prefix = [relative(root, path), stat.mode, stat.ino, stat.dev, stat.mtimeMs];
    if (stat.isSymbolicLink()) rows.push([...prefix, "link", readlinkSync(path)]);
    else if (stat.isDirectory()) {
      rows.push([...prefix, "directory"]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else
      rows.push([...prefix, "file", createHash("sha256").update(readFileSync(path)).digest("hex")]);
  }
  visit(root);
  return rows;
}

function unchanged(root, action) {
  const before = snapshot(root);
  try {
    return action();
  } finally {
    assert.deepEqual(snapshot(root), before, `unexpected filesystem mutation under ${root}`);
  }
}

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([key, field]) => `${key} = ${toml(field)}`)
      .join(", ")} }`;
  return JSON.stringify(value);
}

describe("installed vendor CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function worldFor(context) {
    const root = realpathSync(mkdtempSync("/tmp/skillex-vendor-cli-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const home = directory(join(root, "home"));
    const cwd = directory(join(root, "work"));
    const registry = directory(join(root, "registry"));
    const catalog = directory(join(registry, "all-skills"));
    const upstream = directory(join(root, "upstream"));
    const state = join(root, "state");
    const bin = directory(join(root, "bin"));
    const config = directory(join(root, "config"));
    symlinkSync(nodeBinary, join(bin, "node"));
    const gitShim = write(
      join(bin, "git"),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.some(arg => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(arg))) {
  process.stderr.write('Network Git operation forbidden by fixture\\n');
  process.exit(97);
}
const result = spawnSync(${JSON.stringify(gitBinary)}, args, { env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 98);
`,
    );
    chmodSync(gitShim, 0o755);
    const environment = {
      PATH: bin,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      NO_COLOR: "1",
      TERM: "dumb",
    };
    function git(...args) {
      const result = spawnSync(gitBinary, args, {
        cwd: upstream,
        env: environment,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout.trim();
    }
    const repo = "https://example.invalid/vendor-fixture.git";
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Vendor fixture");
    git("config", "user.email", "vendor-fixture@example.test");
    git("config", "commit.gpgsign", "false");
    git("remote", "add", "origin", repo);
    for (const [subdir, name] of [
      ["skills", "alpha"],
      ["skills", "beta"],
      ["extras", "gamma"],
    ]) {
      write(
        join(upstream, subdir, name, "SKILL.md"),
        `---\nname: upstream-${name}\ndescription: Committed vendor fixture\n---\n\n# ${name}\n`,
      );
      write(join(upstream, subdir, name, "references", "guide.md"), `# ${name} guide\n`);
    }
    const executable = write(
      join(upstream, "skills", "alpha", "scripts", "run.sh"),
      "#!/bin/sh\nexit 0\n",
    );
    chmodSync(executable, 0o755);
    git("add", "--all");
    git("commit", "-qm", "Committed vendor fixture");
    git("tag", "v1.0.0");
    const commit = git("rev-parse", "v1.0.0^{commit}");
    directory(join(registry, "sets"));
    directory(join(registry, "packs"));
    write(join(home, ".agents", "skills.json"), '{"skills":[]}\n');
    write(join(home, ".hermes", "skills", "runtime", "SKILL.md"), "# Preserved runtime content\n");
    const declaration = {
      name: "tools",
      repo,
      version: "v1.0.0",
      checkout: "tools-work",
      subdir: "skills",
    };
    const manifest = join(catalog, "sources.toml");
    function sources(entries = [declaration]) {
      write(
        manifest,
        `version = 1\n${entries
          .map(
            (source) =>
              `\n[[source]]\n${Object.entries(source)
                .map(([key, value]) => `${key} = ${toml(value)}`)
                .join("\n")}\n`,
          )
          .join("")}`,
      );
    }
    sources();
    const mapping = write(
      join(config, "skillex", "sources.local.toml"),
      `[checkouts]\ntools-work = ${JSON.stringify(upstream)}\n`,
    );
    return {
      root,
      home,
      cwd,
      registry,
      catalog,
      upstream,
      state,
      bin,
      config,
      environment,
      repo,
      declaration,
      manifest,
      mapping,
      sources,
      commit,
      git,
    };
  }

  function module(source) {
    const result = fixture.runModule(source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  }

  function run(world, args) {
    return JSON.parse(
      module(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(${JSON.stringify(fixture.cli)}, ${JSON.stringify(args)}, {
        cwd: ${JSON.stringify(world.cwd)}, env: ${JSON.stringify(world.environment)},
        encoding: 'utf8', timeout: 20_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      process.stdout.write(JSON.stringify({status: result.status, stdout: result.stdout, stderr: result.stderr}));
    `),
    );
  }

  function parsed(result, command, exit) {
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(result.stderr, "", "JSON vendor output must stay in one result envelope");
    assert.equal(result.stdout.includes(String.fromCharCode(27)), false);
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

  function json(world, args, exit = 0, placement = "leaf") {
    const flags = ["--registry-root", world.registry, "--json"];
    const command =
      placement === "root"
        ? [...flags, "vendor", ...args]
        : placement === "family"
          ? ["vendor", ...flags, ...args]
          : ["vendor", ...args, ...flags];
    const action = () => parsed(run(world, command), `vendor ${args[0]}`, exit);
    return args[0] !== "sync" || args.includes("--dry-run")
      ? unchanged(world.root, action)
      : action();
  }

  function finding(result, code) {
    const value = result.findings.find((entry) => !code || entry.code === code);
    assert.ok(value, `missing ${code ?? "finding"}: ${JSON.stringify(result.findings)}`);
    assert.match(value.code, /^[EWI]_[A-Z0-9_]+$/);
    assert.ok(value.message.length > 0);
    return value;
  }

  function refused(world, args, code, exit = 3) {
    const before = snapshot(world.catalog);
    const source = existsSync(world.upstream) ? snapshot(world.upstream) : null;
    const home = snapshot(world.home);
    const config = snapshot(world.config);
    const result = json(world, args, exit);
    assert.deepEqual(snapshot(world.catalog), before, "refused sync changed canonical content");
    if (source) assert.deepEqual(snapshot(world.upstream), source, "refused sync changed upstream");
    assert.deepEqual(snapshot(world.home), home);
    assert.deepEqual(snapshot(world.config), config);
    finding(result, code);
    return result;
  }

  function receipt(world, name = "alpha") {
    return parseYaml(readFileSync(join(world.catalog, name, ".source.yaml"), "utf8"));
  }

  it("exports the installed vendor APIs and runs with Git but without Python or uv", (context) => {
    const world = worldFor(context);
    unchanged(world.root, () =>
      module(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      const core = await import('${packageName}');
      for (const name of ['listVendorSources', 'showVendorSource', 'inspectVendorStatus', 'syncVendorSources'])
        assert.equal(typeof core[name], 'function');
      for (const name of ['python', 'python3', 'uv']) {
        const result = spawnSync(name, ['--version'], { env: ${JSON.stringify(world.environment)} });
        assert.equal(result.error?.code, 'ENOENT');
      }
      const git = spawnSync('git', ['--version'], { env: ${JSON.stringify(world.environment)} });
      assert.equal(git.status, 0);
    `),
    );
  });

  it("lists declarations and shows source membership through machine-local checkout mappings", (context) => {
    const world = worldFor(context);
    world.sources([{ ...world.declaration, skills: ["alpha"] }]);
    for (const placement of ["root", "family", "leaf"]) {
      const result = json(world, ["list"], 0, placement);
      assert.equal(result.data.manifest, world.manifest);
      assert.equal(result.data.registry.root, world.registry);
      assert.deepEqual(
        result.data.sources.map(({ source }) => source.name),
        ["tools"],
      );
      assert.equal(result.data.sources[0].checkout.root, world.upstream);
      assert.equal(result.data.sources[0].checkout.source, "mapping");
    }
    const result = json(world, ["show", "tools"]);
    assert.equal(result.data.source.name, "tools");
    assert.equal(result.data.source.repo, world.repo);
    assert.equal(result.data.membership, "explicit");
    assert.deepEqual(
      result.data.skills.map(({ name }) => name),
      ["alpha"],
    );
    assert.equal(result.data.skills[0].state, "missing");
    json(world, ["show", "alpha"], 2);
    assert.equal(existsSync(world.state), false);
  });

  it("imports committed bytes and executable modes with complete pinned provenance", (context) => {
    const world = worldFor(context);
    const committed = readFileSync(join(world.upstream, "skills", "alpha", "SKILL.md"));
    write(
      join(world.upstream, "skills", "alpha", "SKILL.md"),
      "Dirty checkout text must not ship\n",
    );
    write(join(world.upstream, "skills", "alpha", "untracked.txt"), "Uncommitted support file\n");
    const beforeSource = snapshot(world.upstream);
    const beforeHome = snapshot(world.home);
    const result = json(world, ["sync"]);
    assert.equal(result.data.dryRun, false);
    assert.deepEqual(result.data.applied.map(({ name }) => name).sort(), ["alpha", "beta"]);
    assert.deepEqual(snapshot(world.upstream), beforeSource);
    assert.deepEqual(snapshot(world.home), beforeHome);
    const path = join(world.catalog, "alpha");
    assert.equal(lstatSync(path).isDirectory(), true);
    assert.equal(lstatSync(join(path, "SKILL.md")).isSymbolicLink(), false);
    assert.deepEqual(readFileSync(join(path, "SKILL.md")), committed);
    assert.equal(existsSync(join(path, "untracked.txt")), false);
    assert.equal(readFileSync(join(path, "references", "guide.md"), "utf8"), "# alpha guide\n");
    assert.equal(lstatSync(join(path, "scripts", "run.sh")).mode & 0o111, 0o111);
    const record = receipt(world);
    assert.equal(record.origin.type, "vendored");
    assert.equal(record.origin.source, "tools");
    assert.equal(record.origin.upstream, world.repo);
    assert.equal(record.origin.upstream_version, "v1.0.0");
    assert.equal(record.origin.upstream_commit, world.commit);
    assert.equal(
      record.origin.upstream_tree,
      world.git("rev-parse", `${world.commit}:skills/alpha`),
    );
    assert.equal(record.origin.upstream_path, "skills/alpha");
    assert.match(record.origin.digest, /^sha256:[a-f0-9]{64}$/);
    json(world, ["status"]);
  });

  it("previews imports without staging, locks, receipt writes, or activation changes", (context) => {
    const world = worldFor(context);
    const result = json(world, ["sync", "--dry-run"]);
    assert.equal(result.data.dryRun, true);
    assert.deepEqual(result.data.applied, []);
    assert.deepEqual(result.data.changes.map(({ name }) => name).sort(), ["alpha", "beta"]);
    assert.equal(existsSync(world.state), false);
    assert.deepEqual(readdirSync(world.catalog), ["sources.toml"]);
    const human = unchanged(world.root, () =>
      run(world, ["vendor", "sync", "--dry-run", "--registry-root", world.registry]),
    );
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.ok(human.stdout.includes("alpha"));
    assert.doesNotMatch(human.stdout, /^\s*\{/);
  });

  it("keeps a converged catalog and provenance byte-identical on repeated sync", (context) => {
    const world = worldFor(context);
    json(world, ["sync"]);
    const result = unchanged(world.catalog, () => json(world, ["sync"]));
    assert.deepEqual(result.data.applied, []);
    assert.ok(result.data.changes.every(({ action }) => action === "unchanged"));
  });

  it("verifies catalog content offline after both the checkout and Git disappear", (context) => {
    const world = worldFor(context);
    json(world, ["sync"]);
    rmSync(world.upstream, { recursive: true });
    unlinkSync(join(world.bin, "git"));
    const result = json(world, ["status"]);
    assert.equal(result.data.upstream, false);
    assert.deepEqual(result.data.skills.map(({ name }) => name).sort(), ["alpha", "beta"]);
    assert.ok(
      result.data.skills.every(
        ({ state, recordedCommit }) => state === "ok" && recordedCommit === world.commit,
      ),
    );
    assert.ok(result.data.sources.every(({ checkout }) => checkout === null));
    const shown = json(world, ["show", "tools"]);
    assert.equal(shown.data.membership, "recorded");
    assert.deepEqual(shown.data.skills.map(({ name }) => name).sort(), ["alpha", "beta"]);
  });

  it("makes missing and malformed source declarations actionable configuration errors", (context) => {
    const world = worldFor(context);
    unlinkSync(world.manifest);
    for (const action of ["list", "status", "sync"]) {
      const result =
        action === "sync"
          ? refused(world, [action], "E_SOURCES_MANIFEST_MISSING", 2)
          : json(world, [action], 2);
      const error = finding(result, "E_SOURCES_MANIFEST_MISSING");
      assert.equal(error.path, world.manifest);
      assert.ok(error.fix);
    }
    write(world.manifest, "[[source]\n");
    finding(json(world, ["list"], 2), "E_SOURCES_MANIFEST_INVALID");
    world.sources([{ ...world.declaration, checkout: world.upstream }]);
    finding(json(world, ["list"], 2), "E_SOURCES_MANIFEST_INVALID");
  });

  it("selects named sources and resolves repeatable explicit checkout arguments", (context) => {
    const world = worldFor(context);
    world.sources([
      { ...world.declaration, skills: ["alpha"] },
      {
        ...world.declaration,
        name: "extras",
        checkout: "extra-work",
        subdir: "extras",
        skills: ["gamma"],
      },
    ]);
    const result = json(world, [
      "sync",
      "--source",
      "extras",
      "--checkout",
      `extra-work=${world.upstream}`,
    ]);
    assert.deepEqual(
      result.data.applied.map(({ name }) => name),
      ["gamma"],
    );
    assert.equal(existsSync(join(world.catalog, "alpha")), false);
    const listed = json(world, [
      "list",
      "--source",
      "tools",
      "--source",
      "extras",
      "--checkout",
      `tools-work=${world.upstream}`,
      "--checkout",
      `extra-work=${world.upstream}`,
    ]);
    assert.deepEqual(listed.data.sources.map(({ source }) => source.name).sort(), [
      "extras",
      "tools",
    ]);
    assert.ok(
      listed.data.sources.every(
        ({ checkout }) => checkout.root === world.upstream && checkout.source === "argument",
      ),
    );
    const beforeAction = unchanged(world.root, () =>
      parsed(
        run(world, [
          "vendor",
          "--source",
          "extras",
          "--checkout",
          `extra-work=${world.upstream}`,
          "list",
          "--registry-root",
          world.registry,
          "--json",
        ]),
        "vendor list",
        0,
      ),
    );
    assert.deepEqual(
      beforeAction.data.sources.map(({ source }) => source.name),
      ["extras"],
    );
    finding(json(world, ["status", "--source", "unknown"], 2), "E_SOURCE_UNKNOWN");
  });

  it("does not fall back from an invalid explicit checkout to a working mapping", (context) => {
    const world = worldFor(context);
    refused(
      world,
      ["sync", "--checkout", `tools-work=${join(world.root, "missing")}`],
      "E_SOURCE_CHECKOUT_MISSING",
    );
    write(world.mapping, "[checkouts\n");
    finding(json(world, ["list"], 2), "E_SOURCE_CHECKOUTS_INVALID");
  });

  it("refuses the entire sync before publication when one required pin is unavailable", (context) => {
    const world = worldFor(context);
    world.sources([
      world.declaration,
      { ...world.declaration, name: "extras", subdir: "extras", version: "v9.9.9" },
    ]);
    const result = refused(world, ["sync"], "E_VENDOR_REF", 2);
    assert.deepEqual(result.data?.applied ?? [], []);
    assert.equal(existsSync(join(world.catalog, "alpha")), false);
  });

  it("requires explicit adoption and separately authorizes discarding unmanaged edits", (context) => {
    const world = worldFor(context);
    cpSync(join(world.upstream, "skills", "alpha"), join(world.catalog, "alpha"), {
      recursive: true,
    });
    refused(world, ["sync"], "E_VENDOR_UNMANAGED");
    json(world, ["sync", "--adopt"]);
    assert.equal(receipt(world).origin.source, "tools");

    const edited = worldFor(context);
    cpSync(join(edited.upstream, "skills", "alpha"), join(edited.catalog, "alpha"), {
      recursive: true,
    });
    write(join(edited.catalog, "alpha", "local-only.md"), "Unmanaged local support content\n");
    refused(edited, ["sync", "--adopt"], "E_VENDOR_LOCAL_EDITS");
    json(edited, ["sync", "--adopt", "--discard-local-edits"]);
    assert.equal(existsSync(join(edited.catalog, "alpha", "local-only.md")), false);
    assert.equal(receipt(edited).origin.source, "tools");
  });

  it("refuses linked canonical destinations even with adoption and edit-discard flags", (context) => {
    const world = worldFor(context);
    symlinkSync(
      relative(world.catalog, join(world.upstream, "skills", "alpha")),
      join(world.catalog, "alpha"),
    );
    refused(world, ["sync", "--adopt", "--discard-local-edits"], "E_VENDOR_DESTINATION_LINK");
    assert.equal(lstatSync(join(world.catalog, "alpha")).isSymbolicLink(), true);
  });

  it("detects byte and executable-mode edits offline and restores them only when explicitly requested", (context) => {
    const world = worldFor(context);
    json(world, ["sync"]);
    const path = join(world.catalog, "alpha", "SKILL.md");
    const committed = readFileSync(path);
    write(path, `${committed.toString("utf8")}\nLocal authored change.\n`);
    finding(json(world, ["status"], 6), "W_SKILL_DIGEST_DRIFT");
    refused(world, ["sync"], "E_VENDOR_LOCAL_EDITS");
    json(world, ["sync", "--discard-local-edits", "--dry-run"]);
    json(world, ["sync", "--discard-local-edits"]);
    assert.deepEqual(readFileSync(path), committed);
    const executable = join(world.catalog, "alpha", "scripts", "run.sh");
    chmodSync(executable, 0o644);
    finding(json(world, ["status"], 6), "W_SKILL_DIGEST_DRIFT");
    refused(world, ["sync"], "E_VENDOR_LOCAL_EDITS");
    json(world, ["sync", "--discard-local-edits"]);
    assert.equal(lstatSync(executable).mode & 0o111, 0o111);
    json(world, ["status"]);
  });

  it("prunes only explicitly removed managed members and protects unavailable optional sources", (context) => {
    const world = worldFor(context);
    json(world, ["sync"]);
    world.sources([{ ...world.declaration, skills: ["alpha"] }]);
    unchanged(world.catalog, () => json(world, ["sync"]));
    assert.equal(existsSync(join(world.catalog, "beta", "SKILL.md")), true);
    const preview = json(world, ["sync", "--prune", "--dry-run"]);
    assert.ok(
      preview.data.changes.some(({ action, name }) => action === "prune" && name === "beta"),
    );
    assert.equal(existsSync(join(world.catalog, "beta")), true);
    json(world, ["sync", "--prune"]);
    assert.equal(existsSync(join(world.catalog, "beta")), false);
    assert.equal(existsSync(join(world.catalog, "alpha", "SKILL.md")), true);
    world.sources([{ ...world.declaration, skills: [] }]);
    unchanged(world.catalog, () => json(world, ["sync"]));
    json(world, ["sync", "--prune"]);
    assert.deepEqual(readdirSync(world.catalog), ["sources.toml"]);

    const optional = worldFor(context);
    json(optional, ["sync"]);
    optional.sources([{ ...optional.declaration, optional: true }]);
    rmSync(optional.upstream, { recursive: true });
    const result = unchanged(optional.catalog, () => json(optional, ["sync", "--prune"], 4));
    assert.deepEqual(result.data.applied, []);
    assert.equal(finding(result, "W_OPTIONAL_SKIPPED").severity, "warning");
    assert.equal(existsSync(join(optional.catalog, "alpha", "SKILL.md")), true);
    assert.equal(existsSync(join(optional.catalog, "beta", "SKILL.md")), true);
  });

  it("keeps offline status separate from an explicitly requested upstream pin comparison", (context) => {
    const world = worldFor(context);
    world.sources([{ ...world.declaration, version: "main" }]);
    json(world, ["sync"]);
    write(
      join(world.upstream, "skills", "alpha", "references", "guide.md"),
      "# A newer committed guide\n",
    );
    world.git("add", "--all");
    world.git("commit", "-qm", "Advance upstream pin");
    json(world, ["status"]);
    const status = json(world, ["status", "--upstream"], 6);
    assert.equal(status.data.upstream, true);
    assert.ok(status.data.skills.some(({ state }) => state === "stale"));
    assert.ok(
      status.data.sources.some(
        ({ upstreamCommit }) => upstreamCommit === world.git("rev-parse", "HEAD"),
      ),
    );
  });

  it("provides readable human output and JSON help while rejecting malformed arguments", (context) => {
    const world = worldFor(context);
    for (const args of [["list"], ["show", "tools"]]) {
      const result = unchanged(world.root, () =>
        run(world, ["vendor", ...args, "--registry-root", world.registry]),
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes("tools"));
      assert.doesNotMatch(result.stdout, /^\s*\{/);
    }
    for (const action of ["list", "show", "status", "sync"]) {
      const result = unchanged(world.root, () =>
        parsed(run(world, ["vendor", action, "--help", "--json"]), "help", 0),
      );
      for (const flag of ["--registry-root", "--json", "--source", "--checkout"])
        assert.ok(result.data.help.includes(flag), `${action} help omitted ${flag}`);
      if (action === "sync")
        for (const flag of ["--adopt", "--discard-local-edits", "--prune", "--dry-run"])
          assert.ok(result.data.help.includes(flag));
    }
    for (const args of [
      ["vendor", "show", "--json"],
      ["vendor", "status", "--dry-run", "--json"],
      ["vendor", "sync", "--unknown", "--json"],
    ]) {
      const result = unchanged(world.root, () => parsed(run(world, args), "cli", 2));
      finding(result, "E_USAGE");
    }
    const duplicate = unchanged(world.root, () =>
      json(
        world,
        [
          "sync",
          "--checkout",
          `tools-work=${world.upstream}`,
          "--checkout",
          `tools-work=${join(world.root, "different")}`,
        ],
        2,
      ),
    );
    finding(duplicate, "E_VENDOR_CHECKOUT");
    const error = unchanged(world.root, () =>
      run(world, ["vendor", "show", "missing", "--registry-root", world.registry]),
    );
    assert.equal(error.status, 2);
    assert.ok(error.stderr.includes("E_SOURCE_UNKNOWN"));
  });
});
