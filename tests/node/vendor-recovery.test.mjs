import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
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
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
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
assert.ok(gitCandidate, "recovery fixtures require a real executable Git binary");
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
      for (const name of readdirSync(path).sort()) visit(join(path, name));
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
    assert.deepEqual(snapshot(root), before, `recovery changed preserved evidence under ${root}`);
  }
}

function finding(result, code) {
  const value = result.findings.find((entry) => entry.code === code);
  assert.ok(value, `missing ${code}: ${JSON.stringify(result)}`);
  assert.ok(value.fix);
  return value;
}

function success(result) {
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.ok, true);
  return result.data;
}

describe("installed public vendor recovery", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function worldFor(context) {
    const root = realpathSync(mkdtempSync("/tmp/skillex-vendor-recovery-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const registry = directory(join(root, "registry"));
    const catalog = directory(join(registry, "all-skills"));
    const home = directory(join(root, "home"));
    const upstream = directory(join(root, "upstream"));
    const state = join(root, "state");
    const bin = directory(join(root, "bin"));
    symlinkSync(nodeBinary, join(bin, "node"));
    symlinkSync(gitBinary, join(bin, "git"));
    const env = {
      PATH: bin,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: state,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      NO_COLOR: "1",
    };
    function git(...args) {
      const result = spawnSync(gitBinary, args, {
        cwd: upstream,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout.trim();
    }
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Vendor recovery fixture");
    git("config", "user.email", "vendor-recovery@example.test");
    git("config", "commit.gpgsign", "false");
    for (const name of ["alpha", "beta"]) {
      write(
        join(upstream, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Recovery fixture\n---\n\n# Original ${name}\n`,
      );
      write(join(upstream, "skills", name, "references", "guide.md"), `Original ${name} guide\n`);
    }
    git("add", "--all");
    git("commit", "-qm", "Initial recovery fixture");
    write(
      join(catalog, "sources.toml"),
      'version = 1\n\n[[source]]\nname = "tools"\nrepo = "https://example.invalid/recovery.git"\nversion = "main"\ncheckout = "tools"\nsubdir = "skills"\n',
    );
    const journal = join(
      state,
      "skillex",
      "vendor",
      "v1",
      `${createHash("sha256").update(catalog).digest("hex")}.json`,
    );
    const options = {
      registryRoot: registry,
      home,
      cwd: root,
      stateHome: state,
      env,
      checkouts: { tools: upstream },
      timeoutMs: 1_000,
    };
    function advance() {
      for (const name of ["alpha", "beta"])
        write(join(upstream, "skills", name, "references", "guide.md"), `Updated ${name} guide\n`);
      git("add", "--all");
      git("commit", "-qm", "Update both vendor members");
    }
    return { root, registry, catalog, home, upstream, state, journal, options, advance };
  }

  function child(source) {
    const result = fixture.runModule(source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  }

  function call(world, name = "syncVendorSources", args = [world.options]) {
    const result = child(`
      const core = await import('${packageName}');
      process.stdout.write(JSON.stringify(await core[${JSON.stringify(name)}](...${JSON.stringify(args)})));
    `);
    assert.equal(result.schema, 2);
    assert.equal(result.ok, result.exit === 0);
    return result;
  }

  function inject(world, mode) {
    const output = child(`
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { basename, join } from 'node:path';
      const options = ${JSON.stringify(world.options)};
      const journal = ${JSON.stringify(world.journal)};
      const mode = ${JSON.stringify(mode)};
      const originalLink = fs.link;
      const originalRename = fs.rename;
      let injected = false;
      fs.link = async (...args) => {
        if (!injected && args[1] === journal && mode.startsWith('journal-')) {
          injected = true;
          if (mode === 'journal-rival') await fs.writeFile(journal, 'Foreign journal arrived before publication\\n');
          else throw Object.assign(new Error('Injected journal publication failure'), { code: 'EIO' });
        }
        return originalLink(...args);
      };
      fs.rename = async (...args) => {
        const staged = basename(String(args[0])).startsWith('.skillex-tmp-vendor-') && String(args[0]).endsWith('-new');
        if (!injected && mode === 'before-beta-publication' && staged && args[1] === join(options.registryRoot, 'all-skills', 'beta')) {
          injected = true;
          throw Object.assign(new Error('Injected stop before beta publication'), { code: 'EIO' });
        }
        return originalRename(...args);
      };
      syncBuiltinESMExports();
      const { syncVendorSources } = await import('${packageName}');
      const result = await syncVendorSources(options);
      process.stdout.write(JSON.stringify({ result, injected }));
    `);
    assert.equal(
      output.injected,
      true,
      `filesystem fault was not exercised: ${JSON.stringify(output)}`,
    );
    assert.notEqual(output.result.exit, 0, JSON.stringify(output.result));
    assert.equal(output.result.schema, 2);
    assert.equal(output.result.command, "vendor sync");
    assert.equal(output.result.ok, false);
    return output.result;
  }

  function pending(world) {
    const journal = JSON.parse(readFileSync(world.journal, "utf8"));
    assert.equal(journal.catalog, world.catalog);
    assert.equal(journal.phase, "ready");
    assert.ok(journal.operations.length > 0);
    for (const operation of journal.operations)
      for (const path of [operation.stage, operation.parked])
        if (path !== null) assert.equal(dirname(path), world.catalog);
    return journal;
  }

  function journalFiles(world) {
    return existsSync(dirname(world.journal)) ? readdirSync(dirname(world.journal)).sort() : [];
  }

  it("cleans a failed first journal publication and converges on retry", (context) => {
    const world = worldFor(context);
    const result = unchanged(world.catalog, () => inject(world, "journal-fail"));
    finding(result, "E_IO");
    assert.deepEqual(result.data?.applied ?? [], []);
    assert.equal(existsSync(world.journal), false);
    assert.deepEqual(journalFiles(world), [], "failed journal publication left a temporary file");
    const applied = success(call(world));
    assert.deepEqual(applied.applied.map(({ name }) => name).sort(), ["alpha", "beta"]);
    assert.equal(existsSync(world.journal), false);
    assert.deepEqual(journalFiles(world), []);
    success(call(world, "inspectVendorStatus"));
  });

  it("does not overwrite a competing first journal or leave its own temporary file", (context) => {
    const world = worldFor(context);
    unchanged(world.catalog, () => inject(world, "journal-rival"));
    assert.equal(
      readFileSync(world.journal, "utf8"),
      "Foreign journal arrived before publication\n",
    );
    assert.deepEqual(journalFiles(world), [basename(world.journal)]);
    const result = unchanged(world.root, () => call(world));
    assert.equal(result.exit, 3);
    finding(result, "E_VENDOR_JOURNAL");
  });

  it("preserves pre-existing foreign, symlinked, and malformed journals", (context) => {
    const foreign = worldFor(context);
    inject(foreign, "before-beta-publication");
    pending(foreign);
    for (const kind of ["foreign", "symlink", "malformed"]) {
      const world = worldFor(context);
      directory(dirname(world.journal));
      if (kind === "foreign") write(world.journal, readFileSync(foreign.journal));
      else if (kind === "symlink") {
        const other = write(join(world.root, "foreign-journal.json"), "Do not read or overwrite\n");
        symlinkSync(relative(dirname(world.journal), other), world.journal);
      } else write(world.journal, '{"schema":1,"operations":[]}\n');
      if (kind !== "symlink") chmodSync(world.journal, 0o600);
      const result = unchanged(foreign.root, () => unchanged(world.root, () => call(world)));
      assert.equal(result.exit, 3);
      finding(result, "E_VENDOR_JOURNAL");
    }
  });

  for (const location of ["stage", "parked"]) {
    it(`preserves edited ${location} evidence before cleaning any earlier published member`, (context) => {
      const world = worldFor(context);
      success(call(world));
      world.advance();
      inject(world, "before-beta-publication");
      const journal = pending(world);
      const alpha = journal.operations.find(({ change }) => change.name === "alpha");
      const beta = journal.operations.find(({ change }) => change.name === "beta");
      assert.ok(alpha.parked && existsSync(alpha.parked));
      assert.equal(
        readFileSync(join(world.catalog, "alpha", "references", "guide.md"), "utf8"),
        "Updated alpha guide\n",
      );
      assert.ok(beta[location] && existsSync(beta[location]));
      write(
        join(beta[location], "references", "guide.md"),
        `Edited ${location} recovery material\n`,
      );
      const journalBefore = readFileSync(world.journal);
      const result = unchanged(world.catalog, () => call(world));
      assert.equal(result.exit, 3);
      finding(result, "E_VENDOR_JOURNAL");
      assert.deepEqual(readFileSync(world.journal), journalBefore);
      assert.equal(
        existsSync(alpha.parked),
        true,
        "earlier recovery evidence was cleaned before validation finished",
      );
      assert.equal(
        readFileSync(join(beta[location], "references", "guide.md"), "utf8"),
        `Edited ${location} recovery material\n`,
      );
    });
  }

  it("blocks create and import until a pending vendor journal is safely recovered", (context) => {
    const world = worldFor(context);
    inject(world, "before-beta-publication");
    pending(world);
    const originalJournal = readFileSync(world.journal);
    const status = unchanged(world.root, () => call(world, "inspectVendorStatus"));
    assert.equal(status.exit, 4);
    finding(status, "W_VENDOR_RECOVERY_PENDING");
    assert.deepEqual(readFileSync(world.journal), originalJournal);
    for (const [name, args] of [
      ["createSkill", ["local", { ...world.options, description: "Local fixture" }]],
      ["importSkill", [join(world.upstream, "skills", "alpha"), "imported", world.options]],
    ]) {
      const result = unchanged(world.catalog, () => call(world, name, args));
      assert.equal(result.exit, 3);
      finding(result, "E_VENDOR_RECOVERY_PENDING");
      assert.deepEqual(readFileSync(world.journal), originalJournal);
    }
    success(call(world));
    assert.equal(existsSync(world.journal), false);
    success(
      call(world, "createSkill", ["local", { ...world.options, description: "Local fixture" }]),
    );
    success(
      call(world, "importSkill", [
        join(world.upstream, "skills", "alpha"),
        "imported",
        world.options,
      ]),
    );
    assert.equal(existsSync(join(world.catalog, "local", "SKILL.md")), true);
    assert.equal(existsSync(join(world.catalog, "imported", "SKILL.md")), true);
  });
});
