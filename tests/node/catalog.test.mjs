import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { listSkills, showSkill } from "@delorenj/skillex";
import { createResolutionFixture } from "./resolution-fixture.mjs";

function success(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.ok(result.data);
  return result.data;
}

function finding(result, code, exit) {
  assert.equal(result.ok, false);
  assert.equal(result.exit, exit);
  const found = result.findings.find((entry) => entry.code === code);
  assert.ok(found, JSON.stringify(result.findings));
  assert.ok(found.path);
  assert.ok(found.fix);
  return found;
}

it("lists canonical names in stable order and searches names or descriptions", async (t) => {
  const f = createResolutionFixture(t, listSkills);
  f.skill("zebra");
  const alpha = f.skill("alpha");
  f.file(
    join(alpha, "SKILL.md"),
    "---\nname: friendly-alias\ndescription: Publish a RELEASE\n---\n# Alpha\n",
  );
  f.skill("beta");

  const all = success(await f.resolve());
  assert.deepEqual(
    all.skills.map((skill) => skill.name),
    ["alpha", "beta", "zebra"],
  );
  assert.equal(all.registry.root, f.registry);
  assert.equal(all.registry.source, "argument");
  assert.equal(all.skills[0].metadata.name, "friendly-alias");
  for (const query of ["ALP", " release "]) {
    const matches = success(await f.resolve({ query })).skills;
    assert.deepEqual(
      matches.map((skill) => skill.name),
      ["alpha"],
    );
  }
  assert.deepEqual(success(await f.resolve({ query: "friendly-alias" })).skills, []);
  assert.deepEqual(success(await f.resolve({ query: "unmatched phrase" })).skills, []);
  finding(await f.resolve({ query: 12 }), "E_QUERY", 2);
});

it("shows the canonical directory identity with unchanged provenance fields", async (t) => {
  const f = createResolutionFixture(t, (options) => showSkill("project-jangler", options));
  const path = f.skill("project-jangler");
  f.file(
    join(path, "SKILL.md"),
    "---\nname: pjangler\ndescription: |\n  Develop project tools.\nmetadata:\n  categories: [infra, cli]\n---\n# Tools\n",
  );
  f.file(
    join(path, ".source.yaml"),
    "origin:\n  type: vendored\n  upstream_commit: abc123\n  upstream_path: skills/project-jangler\n  digest: sha256:012345\nmodified_locally: false\nextra:\n  modes: [493, 420]\n",
  );
  const { skill } = success(await f.resolve());
  assert.equal(skill.name, "project-jangler");
  assert.equal(skill.path, path);
  assert.equal(skill.metadata.name, "pjangler");
  assert.equal(skill.description, "Develop project tools.\n");
  assert.deepEqual(skill.metadata.metadata, { categories: ["infra", "cli"] });
  assert.deepEqual(skill.provenance, {
    origin: {
      type: "vendored",
      upstream_commit: "abc123",
      upstream_path: "skills/project-jangler",
      digest: "sha256:012345",
    },
    modified_locally: false,
    extra: { modes: [493, 420] },
  });
});

it("allows Markdown without frontmatter and empty frontmatter", async (t) => {
  const f = createResolutionFixture(t, (options) => showSkill("plain", options));
  const path = f.skill("plain");
  for (const text of [
    "# Ordinary Markdown\n",
    "---\n---\n# Empty metadata\n",
    "---\n# comment\n---\n",
  ]) {
    f.file(join(path, "SKILL.md"), text);
    const { skill } = success(await f.resolve());
    assert.equal(skill.description, null);
    assert.deepEqual(skill.metadata, {});
    assert.equal(skill.provenance, null);
  }
});

it("reads UTF-8 BOM and CRLF frontmatter without changing source bytes", async (t) => {
  const f = createResolutionFixture(t, (options) => showSkill("windows", options));
  const path = f.skill("windows");
  f.file(
    join(path, "SKILL.md"),
    "\uFEFF---\r\nname: Windows\r\ndescription: CRLF text\r\n---\r\n# Windows\r\n",
  );
  assert.equal(success(await f.resolve()).skill.description, "CRLF text");
});

it("maps canonical set links and each pack version's declared membership", async (t) => {
  const f = createResolutionFixture(t, (options) => showSkill("shared", options));
  f.skill("shared");
  f.skill("other");
  const second = f.set("Second", ["shared", "other"]);
  const first = f.set("First", ["shared"]);
  const v2 = f.pack("bundle", "2.0.0", ["shared"]);
  const v1 = f.pack("bundle", "1.0.0", ["shared", "shared"]);
  f.pack("unrelated", "1.0.0", ["other"]);
  const { skill } = success(await f.resolve());
  assert.deepEqual(skill.references, [
    { kind: "pack", name: "bundle", version: "1.0.0", path: v1 },
    { kind: "pack", name: "bundle", version: "2.0.0", path: v2 },
    { kind: "set", name: "First", path: first },
    { kind: "set", name: "Second", path: second },
  ]);
});

it("continues past unrelated legacy packs while retaining valid references", async (t) => {
  const f = createResolutionFixture(t, (options) => showSkill("shared", options));
  f.skill("shared");
  const valid = f.pack("valid", "1.0.0", ["shared"]);
  const legacy = f.pack("legacy", "1.0.0", ["shared"]);
  f.file(
    join(legacy, "pack.toml"),
    '[pack]\nname="legacy"\nversion="1.0.0"\n[freeform]\nskills=["shared"]\n[policy]\nflatten=true\n',
  );
  const result = await f.resolve();
  assert.equal(finding(result, "E_LEGACY_FIELD", 4).path, join(legacy, "pack.toml"));
  assert.equal(result.data.skill.name, "shared");
  assert.deepEqual(result.data.skill.references, [
    { kind: "pack", name: "valid", version: "1.0.0", path: valid },
  ]);
});

it("reports missing or mismatched set members without fabricating references", async (t) => {
  const f = createResolutionFixture(t, (options) => showSkill("shared", options));
  f.skill("shared");
  const other = f.skill("other");
  const valid = f.set("valid", ["shared"]);
  const wrong = f.set("wrong");
  f.link(join(wrong, "shared"), other);
  f.set("missing", ["not-present"]);
  const result = await f.resolve();
  finding(result, "E_NONCANONICAL_REFERENCE", 4);
  finding(result, "E_SKILL_MISSING", 4);
  assert.deepEqual(result.data.skill.references, [{ kind: "set", name: "valid", path: valid }]);
});

it("lists valid entries while reporting malformed metadata and linked catalog entries", async (t) => {
  const f = createResolutionFixture(t, listSkills);
  f.skill("valid");
  const invalid = f.skill("invalid");
  f.file(join(invalid, "SKILL.md"), "---\ndescription: [wrong, type]\n---\n");
  const external = f.directory(join(f.root, "external"));
  f.file(join(external, "SKILL.md"), "---\ndescription: Must not be followed\n---\n");
  f.link(join(f.registry, "all-skills", "linked"), external);
  const result = await f.resolve();
  finding(result, "E_SKILL_METADATA_INVALID", 4);
  finding(result, "E_NONCANONICAL_REFERENCE", 4);
  assert.deepEqual(
    result.data.skills.map((skill) => skill.name),
    ["valid"],
  );
});

it("does not mistake catalog metadata files or hidden directories for skills", async (t) => {
  const f = createResolutionFixture(t, listSkills);
  f.file(join(f.registry, "all-skills", "README.md"), "Catalog\n");
  f.file(join(f.registry, "all-skills", "sources.toml"), "[sources]\n");
  f.file(join(f.registry, "all-skills", ".github", "config.yml"), "ignored: true\n");
  assert.deepEqual(success(await f.resolve()).skills, []);
});

it("reports a wholly malformed catalog as a configuration failure", async (t) => {
  const f = createResolutionFixture(t, listSkills);
  const path = f.skill("invalid");
  f.file(join(path, "SKILL.md"), "---\ndescription: [wrong, type]\n---\n");
  const result = await f.resolve();
  finding(result, "E_SKILL_METADATA_INVALID", 2);
  assert.deepEqual(result.data.skills, []);
});

it("reports a catalog containing only linked definitions as an invariant failure", async (t) => {
  const f = createResolutionFixture(t, listSkills);
  const external = f.directory(join(f.root, "external"));
  f.file(join(external, "SKILL.md"), "# External definition\n");
  f.link(join(f.registry, "all-skills", "linked"), external);
  const result = await f.resolve();
  finding(result, "E_NONCANONICAL_REFERENCE", 3);
  assert.deepEqual(result.data.skills, []);
});

it("keeps partial inspection semantics when the query filters out valid definitions", async (t) => {
  const f = createResolutionFixture(t, listSkills);
  f.skill("valid");
  const path = f.skill("invalid");
  f.file(join(path, "SKILL.md"), "---\ndescription: [wrong, type]\n---\n");
  const result = await f.resolve({ query: "no matches" });
  finding(result, "E_SKILL_METADATA_INVALID", 4);
  assert.deepEqual(result.data.skills, []);
});

for (const [title, body] of [
  ["unterminated frontmatter", "---\nname: broken\n"],
  ["malformed YAML", "---\nname: [unterminated\n---\n"],
  ["duplicate YAML keys", "---\nname: one\nname: two\n---\n"],
  ["scalar YAML", "---\nnot-a-mapping\n---\n"],
  ["sequence YAML", "---\n- first\n- second\n---\n"],
  ["nonstring name", "---\nname: 12\n---\n"],
  ["nonstring description", "---\ndescription: {wrong: type}\n---\n"],
  ["nonfinite number", "---\nmetadata: .inf\n---\n"],
  ["recursive alias", "---\nmetadata: &cycle [*cycle]\n---\n"],
  ["unresolved alias", "---\nmetadata: *missing\n---\n"],
  ["unsupported tag", "---\nmetadata: !unknown value\n---\n"],
]) {
  it(`reports ${title} as malformed metadata`, async (t) => {
    const f = createResolutionFixture(t, (options) => showSkill("invalid", options));
    const path = f.skill("invalid");
    f.file(join(path, "SKILL.md"), body);
    const warn = t.mock.method(console, "warn", () =>
      assert.fail("YAML warnings leaked to console"),
    );
    const result = await f.resolve();
    assert.equal(finding(result, "E_SKILL_METADATA_INVALID", 2).path, join(path, "SKILL.md"));
    assert.equal(result.data, null);
    assert.equal(warn.mock.callCount(), 0);
  });
}

for (const body of [
  "origin: [wrong]\n",
  "modified_locally: 1\n",
  "origin: {broken\n",
  "- wrong\n",
]) {
  it(`reports malformed provenance ${JSON.stringify(body)}`, async (t) => {
    const f = createResolutionFixture(t, (options) => showSkill("invalid", options));
    const path = f.skill("invalid");
    f.file(join(path, ".source.yaml"), body);
    const result = await f.resolve();
    assert.equal(finding(result, "E_SKILL_PROVENANCE_INVALID", 2).path, join(path, ".source.yaml"));
    assert.equal(result.data, null);
  });
}

for (const file of ["SKILL.md", ".source.yaml"]) {
  it(`rejects invalid UTF-8 in ${file}`, async (t) => {
    const f = createResolutionFixture(t, (options) => showSkill("invalid", options));
    const path = f.skill("invalid");
    f.file(join(path, file), Buffer.from([0xc3, 0x28]));
    const result = await f.resolve();
    assert.equal(finding(result, "E_INVALID_UTF8", 2).path, join(path, file));
    assert.equal(result.data, null);
  });

  it(`rejects linked ${file}`, async (t) => {
    const f = createResolutionFixture(t, (options) => showSkill("linked", options));
    const path = f.directory(join(f.registry, "all-skills", "linked"));
    if (file !== "SKILL.md") f.file(join(path, "SKILL.md"), "# Normal skill\n");
    const outside = f.file(join(f.root, "outside.yml"), "origin: {}\n");
    f.link(join(path, file), outside);
    const result = await f.resolve();
    finding(result, "E_NONCANONICAL_REFERENCE", 3);
    assert.equal(result.data, null);
  });
}

it("rejects missing or unsafe selected names with actionable diagnostics", async (t) => {
  for (const name of ["absent", "../outside", "Uppercase"]) {
    const f = createResolutionFixture(t, (options) => showSkill(name, options));
    const result = await f.resolve();
    finding(
      result,
      name === "absent" ? "E_SKILL_MISSING" : "E_SKILL_NAME",
      name === "absent" ? 3 : 2,
    );
    assert.equal(result.data, null);
  }
});
