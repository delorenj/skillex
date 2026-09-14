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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPackageFixture, packageName } from "./package-fixture.mjs";

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

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

function skillFile(name, description = "Temporary catalog skill", metadata = "") {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${metadata}---\n\n# ${name}\n\nUse this skill for the fixture task.\n`;
}

function catalogFor(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-catalog-cli-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  for (const child of ["all-skills", "sets", "packs"]) {
    mkdirSync(join(registry, child), { recursive: true });
  }
  const source = join(root, "source");
  mkdirSync(source);
  write(join(registry, "README.md"), "Preserve registry-owned content.\n");
  return {
    root,
    registry,
    source,
    skill(name, description, metadata) {
      const path = join(registry, "all-skills", name);
      write(join(path, "SKILL.md"), skillFile(name, description, metadata));
      return path;
    },
    sourceSkill() {
      write(join(source, "SKILL.md"), skillFile("original-name", "Imported authoring guide"));
      write(join(source, "references", "guide.md"), "# Supporting guide\n\nKeep these bytes.\n");
      write(join(source, "assets", "sample.bin"), Buffer.from([0, 1, 255, 13, 10]));
      write(
        join(source, "scripts", "run.mjs"),
        "#!/usr/bin/env node\nprocess.stdout.write('fixture script\\n');\n",
        0o755,
      );
      return source;
    },
  };
}

function withUnchangedTree(root, run) {
  const before = snapshot(root);
  try {
    return run();
  } finally {
    assert.deepEqual(snapshot(root), before, "command changed read-only catalog or source state");
  }
}

function assertOnlySkillAdded(root, before, path) {
  const skill = relative(root, path);
  function outsideSkill(entries) {
    return entries
      .filter(([name]) => name !== skill && !name.startsWith(`${skill}/`))
      .map((entry) => {
        const [name, kind, mode] = entry;
        // Adding a directory changes its parents' timestamps, but cannot change
        // their modes or any content outside the new canonical skill.
        return kind === "directory" && (name === "" || skill.startsWith(`${name}/`))
          ? [name, kind, mode]
          : entry;
      });
  }
  assert.deepEqual(outsideSkill(snapshot(root)), outsideSkill(before));
}

function assertFilesPlanned(data) {
  const planned = new Set(data.changes.map(({ path }) => path));
  for (const [name, kind] of snapshot(data.path)) {
    if (kind === "file") {
      assert.ok(planned.has(join(data.path, name)), `missing planned file: ${name}`);
    }
  }
  for (const path of planned)
    assert.ok(existsSync(path), `planned change was not written: ${path}`);
}

describe("installed skill catalog CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  function envelope(args, command, exit = 0) {
    const result = fixture.runCli(args);
    assert.equal(result.status, exit, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "", "JSON diagnostics belong in the single result envelope");
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

  function json(registry, args, exit = 0) {
    return envelope(
      ["--registry-root", registry, "--json", "skill", ...args],
      `skill ${args[0]}`,
      exit,
    );
  }

  function namedError(value, code) {
    const finding = value.findings.find(
      (entry) => entry.severity === "error" && (!code || entry.code === code),
    );
    assert.ok(finding, `missing ${code ?? "named error"}: ${JSON.stringify(value.findings)}`);
    assert.match(finding.code, /^E_[A-Z0-9_]+$/);
    assert.ok(finding.message.length > 0);
    assert.ok(finding.fix, "the finding should describe a corrective action");
    return finding;
  }

  function mutation(value, registry, name, dryRun) {
    assert.equal(value.data.registry.root, registry);
    assert.equal(value.data.name, name);
    assert.equal(value.data.path, join(registry, "all-skills", name));
    assert.equal(value.data.dryRun, dryRun);
    assert.ok(value.data.changes.length > 0);
    for (const change of value.data.changes) {
      assert.equal(typeof change.action, "string");
      assert.ok(change.action.length > 0);
      assert.ok(
        change.path === value.data.path || change.path.startsWith(`${value.data.path}/`),
        `change escapes canonical skill: ${JSON.stringify(change)}`,
      );
    }
    return value.data;
  }

  it("loads all catalog APIs from the installed package with only Node on PATH", () => {
    assert.deepEqual(readdirSync(fixture.runtimeBin), ["node"]);
    const result = fixture.runModule(`
      import assert from 'node:assert/strict';
      const core = await import('${packageName}');
      for (const name of ['listSkills', 'showSkill', 'createSkill', 'importSkill']) {
        assert.equal(typeof core[name], 'function', name);
      }
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  for (const placement of ["root", "family", "leaf"]) {
    it(`accepts global flags at the ${placement} and filters by description`, (context) => {
      const catalog = catalogFor(context);
      catalog.skill("alpha", "Automate deployment tasks");
      catalog.skill("zebra", "Document a service");
      const flags = ["--registry-root", catalog.registry, "--json"];
      const args =
        placement === "root"
          ? [...flags, "skill", "list", "--query", "DEPLOYMENT"]
          : placement === "family"
            ? ["skill", ...flags, "list", "--query", "DEPLOYMENT"]
            : ["skill", "list", "--query", "DEPLOYMENT", ...flags];
      const value = withUnchangedTree(catalog.root, () => envelope(args, "skill list"));
      assert.equal(value.data.registry.root, catalog.registry);
      assert.equal(value.data.registry.source, "argument");
      assert.deepEqual(
        value.data.skills.map(({ name }) => name),
        ["alpha"],
      );
      assert.equal(value.data.skills[0].description, "Automate deployment tasks");
    });
  }

  it("lists canonical identities in deterministic order and shows metadata and references", (context) => {
    const catalog = catalogFor(context);
    catalog.skill("zebra", "Last skill");
    const alpha = catalog.skill("alpha", "Authoring reference", "license: MIT\n");
    const metadata = skillFile("upstream-display-name", "Authoring reference", "license: MIT\n");
    write(join(alpha, "SKILL.md"), metadata);
    const provenance = { origin: { type: "local", authored_in: catalog.source } };
    write(
      join(alpha, ".source.yaml"),
      `origin:\n  type: local\n  authored_in: ${JSON.stringify(catalog.source)}\n`,
    );
    const setPath = join(catalog.registry, "sets", "writing", "alpha");
    mkdirSync(dirname(setPath), { recursive: true });
    symlinkSync(relative(dirname(setPath), alpha), setPath);
    const pack = join(catalog.registry, "packs", "editor", "1.0.0");
    write(
      join(pack, "pack.toml"),
      '[pack]\nname = "editor"\nversion = "1.0.0"\n\n[freeform]\nskills = ["alpha"]\n',
    );
    const listed = withUnchangedTree(catalog.root, () => json(catalog.registry, ["list"]));
    assert.deepEqual(
      listed.data.skills.map(({ name }) => name),
      ["alpha", "zebra"],
    );
    const shown = withUnchangedTree(catalog.root, () => json(catalog.registry, ["show", "alpha"]));
    const skill = shown.data.skill;
    assert.equal(shown.data.registry.root, catalog.registry);
    assert.equal(skill.name, "alpha");
    assert.equal(skill.path, alpha);
    assert.equal(skill.description, "Authoring reference");
    assert.equal(skill.metadata.name, "upstream-display-name");
    assert.equal(skill.metadata.license, "MIT");
    assert.deepEqual(skill.provenance, provenance);
    assert.deepEqual(
      skill.references.map(({ kind, name, version }) => [kind, name, version ?? null]).sort(),
      [
        ["pack", "editor", "1.0.0"],
        ["set", "writing", null],
      ],
    );
    for (const reference of skill.references) assert.equal(typeof reference.path, "string");
    assert.deepEqual(listed.data.skills[0], skill);
    for (const args of [
      ["list", "--query", "alpha"],
      ["show", "alpha"],
    ]) {
      const result = withUnchangedTree(catalog.root, () =>
        fixture.runCli(["skill", ...args, "--registry-root", catalog.registry]),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      for (const text of ["alpha", "Authoring reference", "writing", "editor", catalog.source]) {
        assert.ok(result.stdout.includes(text), `human output is missing ${text}`);
      }
    }
  });

  it("returns an empty successful list when a query matches no skills", (context) => {
    const catalog = catalogFor(context);
    catalog.skill("alpha", "Authoring reference");
    const value = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["list", "--query", "absent-query"]),
    );
    assert.deepEqual(value.data.skills, []);
  });

  it("prints useful human list and show output without modifying the catalog", (context) => {
    const catalog = catalogFor(context);
    catalog.skill("alpha", "Authoring reference");
    for (const args of [
      ["list", "--query", "alpha"],
      ["show", "alpha"],
    ]) {
      const result = withUnchangedTree(catalog.root, () =>
        fixture.runCli(["skill", ...args, "--registry-root", catalog.registry]),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /alpha/);
      assert.match(result.stdout, /Authoring reference/);
    }
  });

  it("plans a scaffold without creating any catalog or activation files", (context) => {
    const catalog = catalogFor(context);
    const value = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, [
        "create",
        "new-skill",
        "--description",
        "New authoring guide",
        "--dry-run",
      ]),
    );
    const data = mutation(value, catalog.registry, "new-skill", true);
    assert.ok(data.changes.some(({ path }) => path === join(data.path, "SKILL.md")));
    assert.equal(existsSync(data.path), false);
  });

  it("creates a valid canonical scaffold and immediately shows it through the installed CLI", (context) => {
    const catalog = catalogFor(context);
    catalog.skill("existing", "Preserve this definition");
    const before = snapshot(catalog.root);
    const args = ["create", "new-skill", "--description", "New authoring guide"];
    const planned = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, [...args, "--dry-run"]),
    );
    const value = json(catalog.registry, args);
    const data = mutation(value, catalog.registry, "new-skill", false);
    assert.deepEqual(data.changes, planned.data.changes);
    assertFilesPlanned(data);
    assertOnlySkillAdded(catalog.root, before, data.path);
    assert.equal(lstatSync(data.path).isDirectory(), true);
    assert.equal(lstatSync(data.path).isSymbolicLink(), false);
    assert.match(readFileSync(join(data.path, "SKILL.md"), "utf8"), /^---\r?\n/);
    const shown = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["show", "new-skill"]),
    );
    assert.equal(shown.data.skill.name, "new-skill");
    assert.equal(shown.data.skill.metadata.name, "new-skill");
    assert.equal(shown.data.skill.description, "New authoring guide");
  });

  it("creates a minimal valid skill when no description flag is given", (context) => {
    const catalog = catalogFor(context);
    const result = fixture.runCli([
      "skill",
      "create",
      "minimal",
      "--registry-root",
      catalog.registry,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /minimal/);
    const shown = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["show", "minimal"]),
    );
    assert.equal(shown.data.skill.name, "minimal");
    assert.equal(typeof shown.data.skill.description, "string");
    assert.ok(shown.data.skill.description.trim().length > 0);
  });

  it("plans a complete import and preserves all source bytes and executable modes when applied", (context) => {
    const catalog = catalogFor(context);
    catalog.skill("existing", "Preserve this definition");
    const source = catalog.sourceSkill();
    const sourceBefore = snapshot(source);
    const before = snapshot(catalog.root);
    const planned = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["import", source, "--name", "imported-name", "--dry-run"]),
    );
    const plan = mutation(planned, catalog.registry, "imported-name", true);
    const sourceFiles = ["SKILL.md", "references/guide.md", "assets/sample.bin", "scripts/run.mjs"];
    for (const file of sourceFiles) {
      assert.ok(
        plan.changes.some(
          ({ path, source: from }) => path === join(plan.path, file) && from === join(source, file),
        ),
        `dry run is missing the source mapping for ${file}`,
      );
    }
    assert.equal(existsSync(plan.path), false);
    const applied = json(catalog.registry, ["import", source, "--name", "imported-name"]);
    const data = mutation(applied, catalog.registry, "imported-name", false);
    assertFilesPlanned(data);
    assertOnlySkillAdded(catalog.root, before, data.path);
    assert.deepEqual(
      data.changes,
      plan.changes,
      "dry run must report the changes a real import performs",
    );
    for (const file of sourceFiles) {
      assert.deepEqual(readFileSync(join(data.path, file)), readFileSync(join(source, file)));
      assert.equal(
        lstatSync(join(data.path, file)).mode & 0o777,
        lstatSync(join(source, file)).mode & 0o777,
      );
    }
    assert.deepEqual(
      snapshot(source),
      sourceBefore,
      "import must retain the complete source unchanged",
    );
    const shown = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["show", "imported-name"]),
    );
    assert.equal(shown.data.skill.name, "imported-name");
    assert.equal(shown.data.skill.metadata.name, "original-name");
    assert.equal(shown.data.skill.description, "Imported authoring guide");
    assert.ok(shown.data.skill.provenance);
    assert.ok(JSON.stringify(shown.data.skill.provenance).includes(source));
  });

  for (const operation of ["create", "import"]) {
    it(`refuses an existing canonical name during ${operation} without changing either definition`, (context) => {
      const catalog = catalogFor(context);
      catalog.skill("taken", "Existing content must survive");
      const source = catalog.sourceSkill();
      const args =
        operation === "create" ? ["create", "taken"] : ["import", source, "--name", "taken"];
      for (const dryRun of [false, true]) {
        const value = withUnchangedTree(catalog.root, () =>
          json(catalog.registry, dryRun ? [...args, "--dry-run"] : args, 3),
        );
        namedError(value);
      }
    });
  }

  it("reports a missing skill through a refusal envelope and human stderr", (context) => {
    const catalog = catalogFor(context);
    const value = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["show", "missing"], 3),
    );
    const finding = namedError(value);
    assert.match(finding.message, /missing/);
    const result = withUnchangedTree(catalog.root, () =>
      fixture.runCli(["skill", "show", "missing", "--registry-root", catalog.registry]),
    );
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(finding.code));
    assert.match(result.stderr, /missing/);
  });

  it("refuses a missing import source without leaving a partial destination", (context) => {
    const catalog = catalogFor(context);
    const source = join(catalog.root, "missing-source");
    const value = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["import", source, "--name", "missing-import"], 3),
    );
    namedError(value);
    assert.equal(existsSync(join(catalog.registry, "all-skills", "missing-import")), false);
  });

  for (const operation of ["list", "show", "import"]) {
    it(`returns E_SKILL_METADATA_INVALID for malformed YAML during ${operation}`, (context) => {
      const catalog = catalogFor(context);
      const malformed = "---\nname: broken\ndescription: [unterminated\n---\n\n# Broken\n";
      const source =
        operation === "import" ? catalog.source : join(catalog.registry, "all-skills", "broken");
      const skill = write(join(source, "SKILL.md"), malformed);
      const args =
        operation === "list"
          ? ["list"]
          : operation === "show"
            ? ["show", "broken"]
            : ["import", source, "--name", "broken"];
      const value = withUnchangedTree(catalog.root, () => json(catalog.registry, args, 2));
      const finding = namedError(value, "E_SKILL_METADATA_INVALID");
      assert.equal(finding.path, skill);
    });
  }

  it("keeps a usable mixed catalog partial even when the query filters out its valid skill", (context) => {
    const catalog = catalogFor(context);
    catalog.skill("valid", "Usable authoring guide");
    write(
      join(catalog.registry, "all-skills", "broken", "SKILL.md"),
      "---\nname: broken\ndescription: [unterminated\n---\n",
    );
    for (const query of [[], ["--query", "no-skill-matches"]]) {
      const value = withUnchangedTree(catalog.root, () =>
        json(catalog.registry, ["list", ...query], 4),
      );
      namedError(value, "E_SKILL_METADATA_INVALID");
      assert.deepEqual(
        value.data.skills.map(({ name }) => name),
        query.length === 0 ? ["valid"] : [],
      );
    }
  });

  it("reports malformed provenance with a named configuration diagnostic", (context) => {
    const catalog = catalogFor(context);
    const path = catalog.skill("broken-provenance", "Valid skill metadata");
    const provenance = write(join(path, ".source.yaml"), "source: [unterminated\n");
    const value = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["show", "broken-provenance"], 2),
    );
    assert.equal(namedError(value, "E_SKILL_PROVENANCE_INVALID").path, provenance);
  });

  it("rejects invalid UTF-8 metadata instead of silently replacing source bytes", (context) => {
    const catalog = catalogFor(context);
    const path = write(
      join(catalog.registry, "all-skills", "invalid-encoding", "SKILL.md"),
      Buffer.from([0xff, 0xfe, 0x00]),
    );
    const value = withUnchangedTree(catalog.root, () =>
      json(catalog.registry, ["show", "invalid-encoding"], 2),
    );
    assert.equal(namedError(value, "E_INVALID_UTF8").path, path);
  });

  for (const operation of ["create", "import"]) {
    for (const name of ["../escape", "nested/name"]) {
      it(`rejects unsafe ${operation} name ${JSON.stringify(name)} before writing`, (context) => {
        const catalog = catalogFor(context);
        const source = catalog.sourceSkill();
        const args = operation === "create" ? ["create", name] : ["import", source, "--name", name];
        const result = withUnchangedTree(catalog.root, () =>
          fixture.runCli(["skill", ...args, "--registry-root", catalog.registry, "--json"]),
        );
        assert.notEqual(result.status, 0);
        assert.equal(result.stderr, "");
        const value = JSON.parse(result.stdout);
        assert.equal(value.schema, 2);
        assert.equal(value.command, `skill ${operation}`);
        assert.equal(value.exit, result.status);
        assert.equal(value.ok, false);
        namedError(value);
      });
    }
  }

  for (const args of [
    ["skill", "list", "--query"],
    ["skill", "import", "/fixture/source"],
  ]) {
    it(`returns usage diagnostics for incomplete arguments ${JSON.stringify(args)}`, () => {
      const value = envelope([...args, "--json"], "cli", 2);
      namedError(value, "E_USAGE");
    });
  }
});
