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
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPackageFixture, packageName } from "./package-fixture.mjs";

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

function link(path, target) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(relative(dirname(path), target), path);
  return path;
}

function snapshot(root) {
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    const name = relative(root, path);
    if (stat.isSymbolicLink()) {
      entries.push([name, "link", stat.mode, stat.mtimeMs, readlinkSync(path)]);
    } else if (stat.isDirectory()) {
      entries.push([name, "directory", stat.mode, stat.mtimeMs]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      entries.push([
        name,
        "file",
        stat.mode,
        stat.mtimeMs,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
    }
  }
  visit(root);
  return entries;
}

function unchanged(root, run) {
  const before = snapshot(root);
  try {
    return run();
  } finally {
    assert.deepEqual(snapshot(root), before, "command changed catalog or state unexpectedly");
  }
}

function supportAssets(path) {
  const assets = [
    write(join(path, "README.md"), "# Composition-owned support\n"),
    write(join(path, "references", "guide.md"), "Retain this supporting guide.\n"),
    write(join(path, "commands", "start.md"), "Start with the supporting guide.\n"),
    write(join(path, "hooks", "start.mjs"), "#!/usr/bin/env node\n// Fixture hook.\n", 0o755),
  ];
  const before = assets.map((asset) => [asset, snapshot(asset)]);
  return () => {
    for (const [asset, contents] of before) assert.deepEqual(snapshot(asset), contents);
  };
}

function assertReferences(catalog, composition, names) {
  const root = composition.kind === "set" ? composition.path : join(composition.path, "skills");
  for (const name of names) {
    const member = join(root, name);
    assert.equal(lstatSync(member).isSymbolicLink(), true, `${member} must be a reference`);
    assert.equal(realpathSync(member), join(catalog.registry, "all-skills", name));
  }
  for (const [path, kind] of snapshot(composition.path)) {
    assert.ok(kind !== "file" || basename(path) !== "SKILL.md", `copied definition: ${path}`);
  }
}

describe("installed set and pack CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function catalogFor(context) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-composition-cli-")));
    const registry = join(root, "registry");
    const state = join(root, "state");
    const previousState = fixture.environment.XDG_STATE_HOME;
    fixture.environment.XDG_STATE_HOME = state;
    context.after(() => {
      fixture.environment.XDG_STATE_HOME = previousState;
      rmSync(root, { recursive: true, force: true });
    });
    for (const name of ["all-skills", "sets", "packs"]) {
      mkdirSync(join(registry, name), { recursive: true });
    }
    for (const name of ["alpha", "beta", "gamma"]) {
      write(
        join(registry, "all-skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Canonical fixture skill\n---\n\n# ${name}\n`,
      );
    }
    write(join(registry, "README.md"), "Do not change registry support content.\n");
    return {
      root,
      registry,
      state,
      set(name, members = []) {
        const path = join(registry, "sets", name);
        mkdirSync(path, { recursive: true });
        for (const member of members)
          link(join(path, member), join(registry, "all-skills", member));
        return path;
      },
      pack(name, version, members = [], materialize = true) {
        const path = join(registry, "packs", name, version);
        write(
          join(path, "pack.toml"),
          `[pack]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\ndescription = "Fixture loadout"\n\n[freeform]\nskills = ${JSON.stringify(members)}\n`,
        );
        if (materialize) {
          mkdirSync(join(path, "skills"), { recursive: true });
          for (const member of members) {
            link(join(path, "skills", member), join(registry, "all-skills", member));
          }
        }
        return path;
      },
    };
  }

  function envelope(args, command, exit = 0) {
    const result = fixture.runCli(args);
    assert.equal(result.status, exit, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "", "JSON commands must emit diagnostics only in their envelope");
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
    if (exit === 0) assert.deepEqual(value.findings, []);
    return value;
  }

  function json(catalog, args, exit = 0, placement = "root") {
    const flags = ["--registry-root", catalog.registry, "--json"];
    const actual =
      placement === "root"
        ? [...flags, ...args]
        : placement === "family"
          ? [args[0], ...flags, ...args.slice(1)]
          : [...args, ...flags];
    return envelope(actual, `${args[0]} ${args[1]}`, exit);
  }

  function namedError(value, code) {
    const finding = value.findings.find(
      (entry) => entry.severity === "error" && (!code || entry.code === code),
    );
    assert.ok(finding, `missing ${code ?? "error finding"}: ${JSON.stringify(value.findings)}`);
    assert.match(finding.code, /^E_[A-Z0-9_]+$/);
    assert.ok(finding.message.length > 0);
    assert.ok(finding.fix, "the error should describe how to correct it");
    return finding;
  }

  function details(catalog, value, kind, name, names, version) {
    assert.equal(value.kind, kind);
    assert.equal(value.name, name);
    assert.equal(value.version, version);
    const path =
      kind === "set"
        ? join(catalog.registry, "sets", name)
        : join(catalog.registry, "packs", name, version);
    assert.equal(value.path, path);
    assert.deepEqual(
      value.skills.map(({ name: skill }) => skill),
      names,
    );
    for (const skill of value.skills) {
      assert.equal(skill.path, join(catalog.registry, "all-skills", skill.name));
    }
    return value;
  }

  function mutation(catalog, value, kind, name, names, version, dryRun = false) {
    assert.equal(value.data.registry.root, catalog.registry);
    assert.equal(value.data.dryRun, dryRun);
    const composition = details(catalog, value.data.composition, kind, name, names, version);
    assert.ok(Array.isArray(value.data.changes));
    for (const change of value.data.changes) {
      assert.equal(typeof change.action, "string");
      assert.ok(change.action.length > 0);
      assert.equal(typeof change.path, "string");
    }
    return composition;
  }

  it("exports the composition APIs from the installed package with only Node on PATH", () => {
    assert.deepEqual(readdirSync(fixture.runtimeBin), ["node"]);
    const result = fixture.runModule(`
      import assert from 'node:assert/strict';
      const core = await import('${packageName}');
      for (const name of [
        'listSets', 'showSet', 'createSet', 'addSetSkills', 'removeSetSkills',
        'listPacks', 'showPack', 'createPack', 'addPackSkills', 'removePackSkills', 'verifyPack',
      ]) assert.equal(typeof core[name], 'function', name);
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  for (const placement of ["root", "family", "leaf"]) {
    it(`accepts global options at the ${placement} without creating state for reads`, (context) => {
      const catalog = catalogFor(context);
      catalog.set("writers", ["alpha"]);
      const result = unchanged(catalog.root, () => json(catalog, ["set", "list"], 0, placement));
      assert.equal(result.data.registry.root, catalog.registry);
      assert.equal(result.data.sets.length, 1);
      details(catalog, result.data.sets[0], "set", "writers", ["alpha"]);
      assert.equal(existsSync(catalog.state), false);
    });
  }

  it("lists empty set and pack catalogs without mutation", (context) => {
    const catalog = catalogFor(context);
    for (const kind of ["set", "pack"]) {
      const result = unchanged(catalog.root, () => json(catalog, [kind, "list"]));
      assert.deepEqual(result.data[`${kind}s`], []);
    }
    assert.equal(existsSync(catalog.state), false);
  });

  for (const kind of ["set", "pack"]) {
    it(`returns usable ${kind} entries with partial exit 4 when another composition is invalid`, (context) => {
      const catalog = catalogFor(context);
      if (kind === "set") {
        catalog.set("valid", ["alpha"]);
        catalog.set("broken", ["not-in-catalog"]);
      } else {
        catalog.pack("valid", "1.0.0", ["alpha"]);
        catalog.pack("broken", "1.0.0", ["not-in-catalog"]);
      }
      const result = unchanged(catalog.root, () => json(catalog, [kind, "list"], 4));
      namedError(result);
      assert.deepEqual(
        result.data[`${kind}s`].map(({ name }) => name),
        ["valid"],
      );
      details(
        catalog,
        result.data[`${kind}s`][0],
        kind,
        "valid",
        ["alpha"],
        kind === "pack" ? "1.0.0" : undefined,
      );
      assert.equal(existsSync(catalog.state), false);
    });
  }

  for (const kind of ["set", "pack"]) {
    it(`previews ${kind} creation without creating state, then applies the same complete plan`, (context) => {
      const catalog = catalogFor(context);
      const version = kind === "pack" ? "7.4.2" : undefined;
      const args =
        kind === "set"
          ? ["set", "create", "writers"]
          : [
              "pack",
              "create",
              "writers",
              "--version",
              version,
              "--description",
              "Authoring loadout",
            ];
      const before = snapshot(join(catalog.registry, "all-skills"));
      const preview = unchanged(catalog.root, () => json(catalog, [...args, "--dry-run"]));
      const planned = mutation(catalog, preview, kind, "writers", [], version, true);
      assert.ok(preview.data.changes.length > 0);
      assert.ok(preview.data.changes.some(({ path }) => path === planned.path));
      if (kind === "pack") {
        assert.ok(
          preview.data.changes.some(({ path }) => path === join(planned.path, "pack.toml")),
        );
      }
      assert.equal(existsSync(planned.path), false);
      assert.equal(existsSync(catalog.state), false);
      const result = json(catalog, args, 0, "leaf");
      const composition = mutation(catalog, result, kind, "writers", [], version);
      assert.deepEqual(result.data.changes, preview.data.changes);
      assert.equal(lstatSync(composition.path).isDirectory(), true);
      for (const { path } of result.data.changes) assert.ok(existsSync(path));
      if (kind === "pack") {
        assert.equal(composition.description, "Authoring loadout");
        const shown = unchanged(catalog.root, () =>
          json(catalog, ["pack", "show", "writers@7.4.2"]),
        );
        assert.equal(shown.data.pack.version, "7.4.2");
        assert.equal(shown.data.pack.description, "Authoring loadout");
      }
      const repeated = unchanged(catalog.root, () => json(catalog, args));
      mutation(catalog, repeated, kind, "writers", [], version);
      assert.deepEqual(repeated.data.changes, []);
      assert.deepEqual(snapshot(join(catalog.registry, "all-skills")), before);
    });
  }

  for (const kind of ["set", "pack"]) {
    it(`maintains ${kind} canonical links, preserves support assets, and makes repeated edits no-ops`, (context) => {
      const catalog = catalogFor(context);
      const version = kind === "pack" ? "1.2.3" : undefined;
      const reference = kind === "pack" ? "writers@1.2.3" : "writers";
      const path = kind === "pack" ? catalog.pack("writers", version) : catalog.set("writers");
      const verifyAssets = supportAssets(path);
      const canonicalBefore = snapshot(join(catalog.registry, "all-skills"));
      const add = [kind, "add", reference, "beta", "alpha"];
      const preview = unchanged(catalog.root, () => json(catalog, [...add, "--dry-run"]));
      const planned = mutation(catalog, preview, kind, "writers", ["alpha", "beta"], version, true);
      const membersRoot = kind === "set" ? planned.path : join(planned.path, "skills");
      for (const name of ["alpha", "beta"]) {
        const change = preview.data.changes.find(({ path }) => path === join(membersRoot, name));
        assert.ok(change, `missing planned member ${name}`);
        assert.ok(change.target, "a link preview must report its canonical target");
        assert.equal(
          resolve(dirname(change.path), change.target),
          join(catalog.registry, "all-skills", name),
        );
      }
      if (kind === "pack") {
        assert.ok(
          preview.data.changes.some(({ path }) => path === join(planned.path, "pack.toml")),
        );
      }
      assert.equal(existsSync(catalog.state), false);
      const added = json(catalog, add, 0, "family");
      const composition = mutation(catalog, added, kind, "writers", ["alpha", "beta"], version);
      assert.deepEqual(added.data.changes, preview.data.changes);
      assertReferences(catalog, composition, ["alpha", "beta"]);
      verifyAssets();
      const shown = unchanged(catalog.root, () => json(catalog, [kind, "show", reference]));
      details(catalog, shown.data[kind], kind, "writers", ["alpha", "beta"], version);
      const repeatedAdd = unchanged(catalog.root, () => json(catalog, add));
      assert.deepEqual(repeatedAdd.data.changes, []);

      const remove = [kind, "remove", reference, "alpha"];
      const removePreview = unchanged(catalog.root, () => json(catalog, [...remove, "--dry-run"]));
      mutation(catalog, removePreview, kind, "writers", ["beta"], version, true);
      assert.ok(removePreview.data.changes.some(({ path }) => path === join(membersRoot, "alpha")));
      const removed = json(catalog, remove);
      const remainder = mutation(catalog, removed, kind, "writers", ["beta"], version);
      assert.deepEqual(removed.data.changes, removePreview.data.changes);
      assert.equal(existsSync(join(membersRoot, "alpha")), false);
      assertReferences(catalog, remainder, ["beta"]);
      const repeatedRemove = unchanged(catalog.root, () => json(catalog, remove));
      assert.deepEqual(repeatedRemove.data.changes, []);
      verifyAssets();
      assert.deepEqual(snapshot(join(catalog.registry, "all-skills")), canonicalBefore);
      if (kind === "pack") {
        const verified = unchanged(catalog.root, () =>
          json(catalog, ["pack", "verify", reference]),
        );
        details(catalog, verified.data.pack, "pack", "writers", ["beta"], version);
      }
    });
  }

  it("selects the latest semantic pack version while preserving explicit versions", (context) => {
    const catalog = catalogFor(context);
    catalog.pack("writers", "2.0.0", ["alpha"]);
    catalog.pack("writers", "10.0.0", ["beta"]);
    const latest = unchanged(catalog.root, () => json(catalog, ["pack", "show", "writers"]));
    details(catalog, latest.data.pack, "pack", "writers", ["beta"], "10.0.0");
    const old = unchanged(catalog.root, () => json(catalog, ["pack", "show", "writers@2.0.0"]));
    details(catalog, old.data.pack, "pack", "writers", ["alpha"], "2.0.0");
    const listed = unchanged(catalog.root, () => json(catalog, ["pack", "list"]));
    assert.deepEqual(listed.data.packs.map(({ name, version }) => `${name}@${version}`).sort(), [
      "writers@10.0.0",
      "writers@2.0.0",
    ]);
    assert.equal(existsSync(catalog.state), false);
  });

  for (const kind of ["set", "pack"]) {
    it(`prints usable human ${kind} list and show output`, (context) => {
      const catalog = catalogFor(context);
      if (kind === "set") catalog.set("writers", ["alpha"]);
      else catalog.pack("writers", "1.2.3", ["alpha"]);
      for (const args of [
        [kind, "list"],
        [kind, "show", "writers"],
      ]) {
        const result = unchanged(catalog.root, () =>
          fixture.runCli([...args, "--registry-root", catalog.registry]),
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /writers/);
        if (args[1] === "show") assert.match(result.stdout, /alpha/);
        if (kind === "pack") assert.match(result.stdout, /1\.2\.3/);
      }
    });
  }

  it("returns lock-busy exit 5 from the installed CLI while a public lock is held", (context) => {
    const catalog = catalogFor(context);
    catalog.set("writers", ["alpha"]);
    const args = ["--registry-root", catalog.registry, "--json", "set", "add", "writers", "beta"];
    const result = unchanged(catalog.registry, () =>
      fixture.runModule(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { withLock } from '${packageName}';
      await withLock(${JSON.stringify(`${catalog.registry}#compositions`)}, async () => {
        const child = spawnSync(${JSON.stringify(fixture.cli)}, ${JSON.stringify(args)}, {
          encoding: 'utf8', env: process.env, timeout: 10_000,
        });
        assert.ifError(child.error);
        assert.equal(child.signal, null);
        assert.equal(child.status, 5, child.stdout + child.stderr);
        assert.equal(child.stderr, '');
        const result = JSON.parse(child.stdout);
        assert.equal(result.schema, 2);
        assert.equal(result.command, 'set add');
        assert.equal(result.exit, 5);
        assert.equal(result.ok, false);
        assert.ok(result.findings.some(({ code, severity }) =>
          code === 'E_LOCK_BUSY' && severity === 'error'));
      }, { stateHome: ${JSON.stringify(catalog.state)} });
    `),
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const added = json(catalog, ["set", "add", "writers", "beta"]);
    const composition = mutation(catalog, added, "set", "writers", ["alpha", "beta"]);
    assertReferences(catalog, composition, ["alpha", "beta"]);
  });

  for (const kind of ["set", "pack"]) {
    for (const action of ["add", "remove"]) {
      it(`refuses all ${kind} ${action} changes when any requested canonical name is missing`, (context) => {
        const catalog = catalogFor(context);
        const members = action === "remove" ? ["alpha", "beta"] : [];
        if (kind === "set") catalog.set("writers", members);
        else catalog.pack("writers", "1.0.0", members);
        for (const dryRun of [false, true]) {
          const args = [
            kind,
            action,
            "writers",
            "alpha",
            "not-in-catalog",
            ...(dryRun ? ["--dry-run"] : []),
          ];
          namedError(unchanged(catalog.root, () => json(catalog, args, 3)));
        }
        assert.equal(existsSync(catalog.state), false);
      });
    }
  }

  for (const kind of ["set", "pack"]) {
    it(`refuses a missing ${kind} reference before creating any catalog or state paths`, (context) => {
      const catalog = catalogFor(context);
      for (const action of ["show", "add", "remove"]) {
        const args = [kind, action, "missing", ...(action === "show" ? [] : ["alpha"])];
        namedError(unchanged(catalog.root, () => json(catalog, args, 3)));
      }
      assert.equal(existsSync(catalog.state), false);
    });
  }

  for (const kind of ["set", "pack"]) {
    it(`refuses a noncanonical destination collision during ${kind} creation`, (context) => {
      const catalog = catalogFor(context);
      const path =
        kind === "set"
          ? join(catalog.registry, "sets", "collision")
          : join(catalog.registry, "packs", "collision", "1.0.0");
      write(path, "This owned file must survive.\n");
      const args =
        kind === "set"
          ? [kind, "create", "collision"]
          : [kind, "create", "collision", "--version", "1.0.0"];
      namedError(unchanged(catalog.root, () => json(catalog, args, 3)));
      assert.equal(existsSync(catalog.state), false);
    });
  }

  for (const kind of ["set", "pack"]) {
    it(`refuses ${kind} edits with dangling or conflicting member links`, (context) => {
      const catalog = catalogFor(context);
      const path =
        kind === "set"
          ? catalog.set("writers", ["alpha"])
          : catalog.pack("writers", "1.0.0", ["alpha"]);
      const member = join(path, ...(kind === "pack" ? ["skills"] : []), "alpha");
      unlinkSync(member);
      link(member, join(catalog.registry, "all-skills", "missing"));
      namedError(unchanged(catalog.root, () => json(catalog, [kind, "add", "writers", "beta"], 3)));
      unlinkSync(member);
      link(member, join(catalog.registry, "all-skills", "beta"));
      namedError(
        unchanged(catalog.root, () => json(catalog, [kind, "remove", "writers", "alpha"], 3)),
      );
      assert.equal(existsSync(catalog.state), false);
    });
  }

  for (const kind of ["set", "pack"]) {
    it(`rejects unsafe ${kind} names as configuration errors`, (context) => {
      const catalog = catalogFor(context);
      const args =
        kind === "set"
          ? [kind, "create", "../escape"]
          : [kind, "create", "../escape", "--version", "1.0.0"];
      namedError(unchanged(catalog.root, () => json(catalog, args, 2)));
      assert.equal(existsSync(catalog.state), false);
    });
  }

  for (const defect of [
    "missing canonical member",
    "missing member link",
    "extra link",
    "wrong link",
    "embedded definition",
  ]) {
    it(`verifies pack ${defect} as drift without changing files or state`, (context) => {
      const catalog = catalogFor(context);
      const members = defect === "missing canonical member" ? ["missing"] : ["alpha"];
      const path = catalog.pack("writers", "1.0.0", members, defect !== "missing member link");
      if (defect === "extra link")
        link(join(path, "skills", "beta"), join(catalog.registry, "all-skills", "beta"));
      if (defect === "wrong link") {
        unlinkSync(join(path, "skills", "alpha"));
        link(join(path, "skills", "alpha"), join(catalog.registry, "all-skills", "beta"));
      }
      if (defect === "embedded definition")
        write(join(path, "references", "nested", "SKILL.md"), "# Forbidden copied definition\n");
      const result = unchanged(catalog.root, () =>
        json(catalog, ["pack", "verify", "writers@1.0.0"], 3),
      );
      namedError(result);
      assert.equal(existsSync(catalog.state), false);
    });
  }

  it("reports invalid pack metadata with a configuration diagnostic", (context) => {
    const catalog = catalogFor(context);
    const path = catalog.pack("broken", "1.0.0");
    write(join(path, "pack.toml"), '[pack\nname = "broken"\n');
    namedError(unchanged(catalog.root, () => json(catalog, ["pack", "show", "broken"], 2)));
    assert.equal(existsSync(catalog.state), false);
  });

  it("requires an explicit pack composition version instead of consuming the root version flag", (context) => {
    const catalog = catalogFor(context);
    const value = unchanged(catalog.root, () =>
      envelope(
        ["--registry-root", catalog.registry, "--json", "pack", "create", "missing-version"],
        "cli",
        2,
      ),
    );
    namedError(value, "E_USAGE");
    assert.equal(existsSync(catalog.state), false);
  });

  it("accepts an equals-form composition version for pack creation", (context) => {
    const catalog = catalogFor(context);
    const args = ["pack", "create", "equals-version", "--version=7.4.2"];
    const preview = unchanged(catalog.root, () => json(catalog, [...args, "--dry-run"]));
    mutation(catalog, preview, "pack", "equals-version", [], "7.4.2", true);
    assert.equal(existsSync(catalog.state), false);
    const applied = json(catalog, args);
    const composition = mutation(catalog, applied, "pack", "equals-version", [], "7.4.2");
    assert.deepEqual(applied.data.changes, preview.data.changes);
    assertReferences(catalog, composition, []);
    const shown = unchanged(catalog.root, () => json(catalog, ["pack", "show", "equals-version"]));
    details(catalog, shown.data.pack, "pack", "equals-version", [], "7.4.2");
  });

  for (const args of [
    ["--version", "pack", "create", "writers", "--version", "7.4.2"],
    ["pack", "create", "writers", "--version", "7.4.2", "-V"],
    ["pack", "create", "writers", "-V"],
  ]) {
    it(`prints only the package version for ${JSON.stringify(args)}`, (context) => {
      const catalog = catalogFor(context);
      const result = unchanged(catalog.root, () =>
        envelope(["--registry-root", catalog.registry, "--json", ...args], "version"),
      );
      assert.deepEqual(result.data, { version: fixture.installedPackage.version });
      assert.equal(existsSync(catalog.state), false);
    });
  }

  for (const action of ["render", "seal", "flatten"]) {
    it(`does not expose the legacy pack ${action} command`, () => {
      const result = envelope(["pack", action, "--json"], "cli", 2);
      namedError(result, "E_USAGE");
    });
  }
});
