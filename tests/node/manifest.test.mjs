import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ajv } from "ajv";
import {
  isSkillName,
  isVersionComponent,
  parseManifest,
  readManifest,
  SkillexError,
} from "../../dist/index.js";

const manifestPath = "/example/project/.agents/skills.json";
const schema = JSON.parse(
  await readFile(
    new URL(import.meta.resolve("@delorenj/skillex/schemas/skills.schema.json")),
    "utf8",
  ),
);
const validateSchema = new Ajv({ strict: true }).compile(schema);

function diagnostic(code, path = manifestPath, field) {
  return (error) => {
    assert.ok(error instanceof SkillexError);
    assert.equal(error.exit, 2);
    assert.ok(error.findings.length > 0);
    const finding = error.findings.find((entry) => entry.code === code);
    assert.ok(finding, `Expected ${code}: ${JSON.stringify(error.findings)}`);
    assert.equal(finding.severity, "error");
    assert.equal(finding.path, path);
    assert.ok(finding.fix.length > 0, "failure must explain a corrective action");
    if (field) assert.ok(finding.message.includes(field), finding.message);
    return true;
  };
}

describe("canonical manifest validation", () => {
  it("normalizes an empty declaration without mutating it", () => {
    const raw = Object.freeze({});
    assert.deepEqual(parseManifest(raw, manifestPath), {
      path: manifestPath,
      inheritGlobal: true,
      skills: [],
      sets: [],
      packs: [],
      exclude: [],
    });
    assert.equal(validateSchema(raw), true);
    assert.deepEqual(raw, {});
  });

  it("preserves scope, offline registry identity, declaration order, and duplicate contributions", () => {
    const raw = {
      $schema: "https://invalid.example/not-fetched.json",
      scope: "project",
      inherit_global: false,
      registry: "git@example.test:private/catalog.git",
      skills: ["memory", { name: "agent-v2" }, "memory"],
      sets: ["Legacy_Set", { name: "minimal", optional: true, include: [], exclude: ["memory"] }],
      packs: [],
      exclude: ["agent-v2"],
    };
    assert.equal(validateSchema(raw), true);
    assert.deepEqual(parseManifest(raw, manifestPath), {
      path: manifestPath,
      scope: "project",
      inheritGlobal: false,
      registry: "git@example.test:private/catalog.git",
      skills: [{ name: "memory" }, { name: "agent-v2" }, { name: "memory" }],
      sets: [
        { name: "Legacy_Set", optional: false, exclude: [] },
        { name: "minimal", optional: true, include: [], exclude: ["memory"] },
      ],
      packs: [],
      exclude: ["agent-v2"],
    });
  });

  it("normalizes pack shorthands and object entries without discarding dormant selections", () => {
    for (const [entry, expected] of [
      ["Hermes_Base", { name: "Hermes_Base", optional: false }],
      [
        "Hermes_Base@1.2.0-next.3+build.7",
        { name: "Hermes_Base", version: "1.2.0-next.3+build.7", optional: false },
      ],
      [
        { name: "Hermes_Base", version: "local_snapshot", optional: true },
        { name: "Hermes_Base", version: "local_snapshot", optional: true },
      ],
    ]) {
      const raw = {
        inherit_global: true,
        skills: ["dormant-skill"],
        sets: [{ name: "Dormant_Set", include: ["dormant-skill"] }],
        exclude: ["dormant-skill"],
        packs: [entry],
      };
      const value = parseManifest(raw, manifestPath);
      assert.equal(validateSchema(raw), true);
      assert.deepEqual(value.packs, [expected]);
      assert.deepEqual(value.skills, [{ name: "dormant-skill" }]);
      assert.deepEqual(value.sets, [
        { name: "Dormant_Set", include: ["dormant-skill"], exclude: [], optional: false },
      ]);
      assert.deepEqual(value.exclude, ["dormant-skill"]);
      assert.equal(value.inheritGlobal, true);
    }
  });

  it("returns independent arrays and entries for consumers", () => {
    const raw = {
      skills: [{ name: "memory" }],
      sets: [{ name: "Core", include: ["memory"], exclude: ["old-memory"] }],
      packs: [{ name: "Base", version: "1.0.0" }],
      exclude: ["old-memory"],
    };
    const before = structuredClone(raw);
    const value = parseManifest(raw, manifestPath);
    value.skills[0].name = "changed";
    value.sets[0].include.push("another");
    value.sets[0].exclude.length = 0;
    value.packs[0].version = "2.0.0";
    value.exclude.length = 0;
    assert.deepEqual(raw, before);
  });

  const invalid = [
    ["null root", null],
    ["array root", []],
    ["string root", "memory"],
    ["unknown root field", { skill: [] }],
    ["nonboolean inheritance", { inherit_global: "true" }],
    ["unsupported scope", { scope: "profile" }],
    ["empty registry identity", { registry: " " }],
    ["scalar skill selection", { skills: "memory" }],
    ["numeric skill entry", { skills: [1] }],
    ["empty skill object", { skills: [{}] }],
    ["uppercase canonical name", { skills: ["Memory"] }],
    ["skill version shorthand", { skills: ["memory@1.0.0"] }],
    ["skill traversal", { skills: ["../memory"] }],
    ["skill nested path", { skills: ["tools/memory"] }],
    ["skill Windows path", { skills: ["tools\\memory"] }],
    ["hidden skill name", { skills: [".memory"] }],
    ["trailing skill separator", { skills: ["memory-"] }],
    ["unknown skill field", { skills: [{ name: "memory", optional: true }] }],
    ["set version shorthand", { sets: ["Core@1.0.0"] }],
    ["set traversal", { sets: [{ name: "../Core" }] }],
    ["nonboolean set optional", { sets: [{ name: "Core", optional: 1 }] }],
    ["invalid set include", { sets: [{ name: "Core", include: ["Memory"] }] }],
    ["scalar set exclude", { sets: [{ name: "Core", exclude: "memory" }] }],
    ["unknown set field", { sets: [{ name: "Core", include_all: true }] }],
    ["multiple packs", { packs: ["One", "Two"] }],
    ["empty pack version", { packs: ["Base@"] }],
    ["multiple pack versions", { packs: ["Base@1@2"] }],
    ["pack traversal", { packs: ["../Base@1"] }],
    ["pack version traversal", { packs: [{ name: "Base", version: "../1" }] }],
    ["pack version path", { packs: ["Base@1/2"] }],
    ["nonboolean pack optional", { packs: [{ name: "Base", optional: "true" }] }],
    ["unknown pack field", { packs: [{ name: "Base", selected: true }] }],
    ["scalar exclusions", { exclude: "memory" }],
    ["unsafe excluded name", { exclude: ["Memory"] }],
    ["invalid dormant skill", { packs: ["Base"], skills: ["Unsafe"] }],
  ];
  for (const [name, raw] of invalid) {
    it(`rejects ${name} against the shipped schema`, () => {
      assert.equal(validateSchema(raw), false);
      assert.throws(() => parseManifest(raw, manifestPath), diagnostic("E_MANIFEST_INVALID"));
    });
  }

  const legacy = [
    [{ source: "file:///old" }, "/source"],
    [{ slots: {} }, "/slots"],
    [{ payload: {} }, "/payload"],
    [{ skills: [{ name: "memory", source: "file:///old" }] }, "/skills/0/source"],
    [
      { skills: [{ name: "memory", registry_path: "all-skills/other" }] },
      "/skills/0/registry_path",
    ],
    [{ skills: [{ name: "memory", registry: "https://example.test" }] }, "/skills/0/registry"],
    [{ skills: [{ name: "memory", version: "1.0.0" }] }, "/skills/0/version"],
    [{ sets: [{ name: "Core", flatten: false }] }, "/sets/0/flatten"],
    [{ sets: [{ name: "Core", sealed: false }] }, "/sets/0/sealed"],
    [{ sets: [{ name: "Core", registry: "x" }] }, "/sets/0/registry"],
    [{ sets: [{ name: "Core", version: "1" }] }, "/sets/0/version"],
    [{ packs: [{ name: "Base", policy: {} }] }, "/packs/0/policy"],
    [{ packs: [{ name: "Base", payload: null }] }, "/packs/0/payload"],
    [{ packs: [{ name: "Base", include: [] }] }, "/packs/0/include"],
    [{ packs: [{ name: "Base", exclude: [] }] }, "/packs/0/exclude"],
  ];
  for (const [raw, pointer] of legacy) {
    it(`identifies retired field ${pointer} with a migration action`, () => {
      assert.equal(validateSchema(raw), false);
      assert.throws(
        () => parseManifest(raw, manifestPath),
        diagnostic("E_LEGACY_FIELD", manifestPath, pointer),
      );
    });
  }

  it("names helpers follow the same safe component rules as the schema", () => {
    for (const name of ["a", "agent_skill", "memory.v2", "33god-hub"]) {
      assert.equal(isSkillName(name), true);
      assert.equal(validateSchema({ skills: [name] }), true);
    }
    for (const name of ["../a", "a/b", "a\\b", "Mixed", "a@1", "a\n", "", null, 1]) {
      assert.equal(isSkillName(name), false);
      assert.equal(validateSchema({ skills: [name] }), false);
    }
    for (const version of ["1", "1.2.3-beta.1+sha.42", "Local_1"]) {
      assert.equal(isVersionComponent(version), true);
      assert.equal(validateSchema({ packs: [{ name: "Base", version }] }), true);
    }
    for (const version of ["..", "/abs", "1/2", "a@b", "", null]) {
      assert.equal(isVersionComponent(version), false);
      assert.equal(validateSchema({ packs: [{ name: "Base", version }] }), false);
    }
  });
});

describe("reading a manifest", () => {
  it("reads valid JSON without changing the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skillex-manifest-"));
    try {
      const path = join(directory, "skills.json");
      const bytes = '{ "skills": ["memory"], "exclude": ["old-memory"] }\n';
      await writeFile(path, bytes);
      const manifest = await readManifest(path);
      assert.deepEqual(manifest.skills, [{ name: "memory" }]);
      assert.deepEqual(manifest.exclude, ["old-memory"]);
      assert.equal(manifest.path, path);
      assert.equal(await readFile(path, "utf8"), bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes absent files, unreadable paths, invalid JSON, and invalid declarations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skillex-manifest-"));
    try {
      const path = join(directory, "skills.json");
      await assert.rejects(readManifest(path), diagnostic("E_MANIFEST_MISSING", path));
      await assert.rejects(readManifest(directory), diagnostic("E_MANIFEST_INVALID", directory));
      for (const bytes of ["", "{", '{"skills": [],}', "// comment\n{}", "secret-content{broken"]) {
        await writeFile(path, bytes);
        await assert.rejects(readManifest(path), (error) => {
          diagnostic("E_MANIFEST_PARSE", path)(error);
          assert.ok(!JSON.stringify(error.findings).includes("secret-content"));
          return true;
        });
      }
      await writeFile(path, '{"skills":["../outside"]}');
      await assert.rejects(readManifest(path), diagnostic("E_MANIFEST_INVALID", path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
