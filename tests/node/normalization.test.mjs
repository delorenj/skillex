import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  addPackSkills,
  createPack,
  inspectStatus,
  normalizeScope,
  resolveSelection,
  sync,
} from "../../dist/index.js";
import { createResolutionFixture } from "./resolution-fixture.mjs";

function fixture(t) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp"; // Receipt fixtures must be outside this host's ~/.claude Git checkout.
  let f;
  try {
    f = createResolutionFixture(t, resolveSelection);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  for (const root of [f.home, f.project]) rmSync(join(root, ".agents/skills"), { recursive: true });
  const options = {
    home: f.home,
    cwd: f.project,
    project: f.project,
    scope: "project",
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    env: {},
  };
  return { ...f, options };
}
function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  return result.data;
}

test("normalize refuses multiple legacy sets without an explicit base", async (t) => {
  const f = fixture(t);
  f.skill("one");
  f.skill("two");
  f.set("first", ["one"]);
  f.set("second", ["two"]);
  f.manifest(f.project, { sets: ["first", "second"] });
  const before = readFileSync(join(f.project, ".agents/skills.json"), "utf8");
  const r = await normalizeScope({ ...f.options, apply: true });
  assert.equal(r.exit, 3);
  assert.match(r.findings[0].message, /explicit base/);
  assert.equal(readFileSync(join(f.project, ".agents/skills.json"), "utf8"), before);
});

test("normalize translates a plain single legacy set with packs and zero root changes", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two"]) f.skill(name);
  f.set("min-global", ["one"]);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("packs2", "1.0.0", opts));
  ok(await addPackSkills("packs2@1.0.0", ["two"], opts));
  // Holocene-shaped legacy state: the selected name is already this project's
  // derived set (base + owner digest), the root is its symlink, packs ride on it.
  const derived = `min-global-${createHash("sha256").update(f.project).digest("hex").slice(0, 6)}`;
  f.set(derived, ["one", "two"]);
  writeFileSync(
    join(f.registry, "sets", derived, ".skillex-set.json"),
    `${JSON.stringify(
      {
        schema: 1,
        derived: {
          owner: { scope: "project", root: f.project },
          base: "min-global",
          packs: ["packs2@1.0.0"],
          skills: [],
          removed: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  f.manifest(f.project, { sets: [derived], packs: ["packs2@1.0.0"] });
  symlinkSync(join(f.registry, "sets", derived), join(f.project, ".agents/skills"));
  const rootBefore = realpathSync(join(f.project, ".agents/skills"));
  const result = ok(await normalizeScope(f.options));
  assert.equal(result.manifest.set, derived);
  assert.deepEqual(result.manifest.packs, ["packs2@1.0.0"]);
  ok(await normalizeScope({ ...f.options, apply: true }));
  const saved = JSON.parse(readFileSync(join(f.project, ".agents/skills.json"), "utf8"));
  assert.equal(saved.set, derived);
  assert.deepEqual(saved.packs, ["packs2@1.0.0"]);
  assert.equal(saved.sets, undefined);
  assert.equal(realpathSync(join(f.project, ".agents/skills")), rootBefore);
  assert.deepEqual(ok(await normalizeScope(f.options)).changes, []);
});

test("fleet singleton legacy sets preserve global union, scoped membership and no-op replay", async (t) => {
  const names = [
    ["joe-pesci", "founder-portfolio-advisor"],
    ["rererere", "n8n"],
    ["n8n-specialist", "n8n"],
    ["infra-specialist", "infra-specialist"],
    ["morgan-finance", "automaticai-finance"],
    ["bennett", "automaticai-executive-office"],
    ["marge-simpson", "hr-director"],
    ["context-director", "context-director"],
    ["peter-griffin", "token-ops"],
  ];
  for (const [profile, setName] of names) {
    await t.test(profile, async (caseContext) => {
      const f = fixture(caseContext);
      f.skill("global-member");
      f.skill("role-member");
      f.set(setName, ["role-member"]);
      f.manifest(f.home, { skills: ["global-member"] });
      f.manifest(f.project, { inherit_global: false, sets: [setName] });
      const preview = ok(await normalizeScope(f.options));
      assert.deepEqual(preview.manifest, { inherit_global: false, set: setName });
      assert.equal(
        preview.changes.some((change) => change.action === "write-manifest"),
        true,
      );
      ok(await normalizeScope({ ...f.options, apply: true }));
      const resolved = ok(await resolveSelection(f.options));
      assert.deepEqual(
        resolved.scopes
          .find((scope) => scope.scope === "project")
          .bindings.map((binding) => binding.name),
        ["role-member"],
      );
      const global = ok(await resolveSelection({ ...f.options, scope: "global" }));
      assert.deepEqual(
        global.scopes[0].bindings.map((binding) => binding.name),
        ["global-member"],
      );
      assert.deepEqual(ok(await normalizeScope(f.options)).changes, []);
    });
  }
});

test("normalize translates a legacy empty sets array by omitting the field", async (t) => {
  const f = fixture(t);
  f.skill("one");
  f.manifest(f.project, { sets: [], inherit_global: false });
  const result = ok(await normalizeScope(f.options));
  assert.equal(result.manifest.set, undefined);
  ok(await normalizeScope({ ...f.options, apply: true }));
  const saved = JSON.parse(readFileSync(join(f.project, ".agents/skills.json"), "utf8"));
  assert.equal("set" in saved, false);
  assert.equal("sets" in saved, false);
  assert.deepEqual(ok(await normalizeScope(f.options)).changes, []);
});

test("normalize refuses mixed set and sets declarations even when they match", async (t) => {
  const f = fixture(t);
  f.skill("one");
  f.set("base", ["one"]);
  f.manifest(f.project, { set: "base", sets: ["base"], inherit_global: false });
  const before = readFileSync(join(f.project, ".agents/skills.json"), "utf8");
  const r = await normalizeScope({ ...f.options, apply: true });
  assert.equal(r.exit, 3);
  assert.match(r.findings[0].message, /cannot mix/);
  assert.equal(readFileSync(join(f.project, ".agents/skills.json"), "utf8"), before);
});

test("normalize refuses a legacy optional set rather than stripping its semantics", async (t) => {
  const f = fixture(t);
  f.skill("one");
  f.set("base", ["one"]);
  f.manifest(f.project, { sets: [{ name: "base", optional: true }], inherit_global: false });
  const before = readFileSync(join(f.project, ".agents/skills.json"), "utf8");
  const r = await normalizeScope({ ...f.options, apply: true });
  assert.equal(r.exit, 3);
  assert.match(r.findings[0].message, /optional/i);
  assert.equal(readFileSync(join(f.project, ".agents/skills.json"), "utf8"), before);
});

test("normalize refuses array, object, and null set values without mutating the manifest", async (t) => {
  const f = fixture(t);
  f.skill("one");
  for (const value of [["base"], { name: "base" }, null, ""]) {
    f.manifest(f.project, { set: value, inherit_global: false });
    const before = readFileSync(join(f.project, ".agents/skills.json"), "utf8");
    const r = await normalizeScope({ ...f.options, apply: true });
    assert.equal(r.exit, 3, JSON.stringify(value));
    assert.match(r.findings[0].message, /set.*string|arrays, objects, null/i);
    assert.equal(readFileSync(join(f.project, ".agents/skills.json"), "utf8"), before);
  }
});

test("legacy multi-set grouping uses the explicitly chosen base and pack references", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "three"]) f.skill(name);
  f.set("global", ["one"]);
  f.set("addon", ["two", "three"]);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("addon", "1.0.0", opts));
  ok(await addPackSkills("addon@1.0.0", ["two", "three"], opts));
  f.manifest(f.project, { sets: ["addon", "global"], inherit_global: false });
  const result = ok(await normalizeScope({ ...f.options, baseSet: "global" }));
  assert.match(result.manifest.set, /^global-/);
  assert.deepEqual(result.manifest.packs, ["addon@1.0.0"]);
  assert.equal(result.manifest.skills, undefined);
});

test("legacy multiple-set apply repairs invalid manifest and preserves inherited members", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "inherited"]) f.skill(name);
  f.set("base", ["one"]);
  f.set("extra", ["two"]);
  f.manifest(f.home, { skills: ["inherited"] });
  f.manifest(f.project, { sets: ["base", "extra"], inherit_global: true });
  ok(await normalizeScope({ ...f.options, baseSet: "base", apply: true }));
  const resolved = ok(await resolveSelection(f.options));
  assert.deepEqual(
    resolved.scopes
      .find((s) => s.scope === "project")
      .bindings.map((b) => b.name)
      .sort(),
    ["inherited", "one", "two"],
  );
  assert.deepEqual(ok(await normalizeScope({ ...f.options, baseSet: "base" })).changes, []);
});

test("normalization refuses legacy exclusive pack aliases rather than wake dormant intent", async (t) => {
  const f = fixture(t);
  for (const name of ["packed", "dormant"]) f.skill(name);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("focus", "1.0.0", opts));
  ok(await addPackSkills("focus@1.0.0", ["packed"], opts));
  f.manifest(f.project, { packs: ["focus@1.0.0"], skills: ["dormant"] });
  symlinkSync(join(f.registry, "packs/focus/1.0.0/skills"), join(f.project, ".agents/skills"));
  const before = readFileSync(join(f.project, ".agents/skills.json"), "utf8");
  const result = await normalizeScope({ ...f.options, apply: true });
  assert.equal(result.exit, 3);
  assert.match(result.findings[0].message, /dormant/);
  assert.equal(readFileSync(join(f.project, ".agents/skills.json"), "utf8"), before);
});

test("conflicting versions refuse without dropping members", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two"]) f.skill(name);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  for (const [version, name] of [
    ["1.0.0", "one"],
    ["2.0.0", "two"],
  ]) {
    ok(await createPack("extra", version, opts));
    ok(await addPackSkills(`extra@${version}`, [name], opts));
  }
  f.manifest(f.project, { packs: ["extra@1.0.0", "extra@2.0.0"], inherit_global: false });
  const result = await normalizeScope({ ...f.options, apply: true });
  assert.equal(result.exit, 3);
  assert.match(result.findings[0].message, /conflicting/);
});

test("legacy empty include preserves zero selected members", async (t) => {
  const f = fixture(t);
  f.skill("one");
  f.set("base", ["one"]);
  f.manifest(f.project, { sets: [{ name: "base", include: [] }], inherit_global: false });
  const result = ok(await normalizeScope(f.options));
  assert.deepEqual(result.manifest.exclude, ["one"]);
});

test("normalize groups full pack membership and removes duplicate declarations", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "three"]) f.skill(name);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("pair", "1.0.0", opts));
  ok(await addPackSkills("pair@1.0.0", ["one", "two"], opts));
  f.manifest(f.project, { inherit_global: false, skills: ["one", "two", "one", "three"] });
  const before = readFileSync(join(f.project, ".agents/skills.json"), "utf8");
  const preview = ok(await normalizeScope(f.options));
  assert.deepEqual(preview.manifest.packs, ["pair@1.0.0"]);
  assert.deepEqual(preview.manifest.skills, ["three"]);
  assert.equal(readFileSync(join(f.project, ".agents/skills.json"), "utf8"), before);
  ok(await normalizeScope({ ...f.options, apply: true }));
  assert.deepEqual(ok(await normalizeScope(f.options)).changes, []);
});

test("global expanded members are simplified even around a selected shared set", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "three"]) f.skill(name);
  f.set("base", ["one"]);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("pair", "1.0.0", opts));
  ok(await addPackSkills("pair@1.0.0", ["two", "three"], opts));
  f.manifest(f.project, { set: "base", skills: ["two", "three"], inherit_global: false });
  const result = ok(await normalizeScope(f.options));
  assert.deepEqual(result.manifest.packs, ["pair@1.0.0"]);
  assert.equal(result.manifest.skills, undefined);
});

test("normalize decomposes an exact captured set into explicit base and packs", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "three"]) f.skill(name);
  f.set("captured", ["one", "two", "three"]);
  f.set("base", ["one"]);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("pair", "1.0.0", opts));
  ok(await addPackSkills("pair@1.0.0", ["two", "three"], opts));
  f.manifest(f.project, { set: "captured" });
  const result = ok(await normalizeScope({ ...f.options, baseSet: "base" }));
  assert.match(result.manifest.set, /^base-/);
  assert.deepEqual(result.manifest.packs, ["pair@1.0.0"]);
  ok(await normalizeScope({ ...f.options, baseSet: "base", apply: true }));
  assert.deepEqual(ok(await normalizeScope({ ...f.options, baseSet: "base" })).changes, []);
});

test("normalize never widens partial pack coverage", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "three"]) f.skill(name);
  const opts = {
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    home: f.home,
    env: {},
  };
  ok(await createPack("trio", "1.0.0", opts));
  ok(await addPackSkills("trio@1.0.0", ["one", "two", "three"], opts));
  f.manifest(f.project, { inherit_global: false, skills: ["one", "two"] });
  const r = ok(await normalizeScope(f.options));
  assert.equal(r.manifest.packs, undefined);
  assert.deepEqual(r.manifest.skills, ["one", "two"]);
});

test("normalize replaces individually repeated global group by global set", async (t) => {
  const f = fixture(t);
  f.skill("one");
  f.skill("two");
  f.set("global", ["one", "two"]);
  f.manifest(f.home, { set: "global" });
  f.manifest(f.project, { inherit_global: true, skills: ["one", "two"] });
  const globalManifest = readFileSync(join(f.home, ".agents/skills.json"), "utf8");
  const status = await inspectStatus(f.options);
  assert.ok(status.findings.some((finding) => finding.code === "W_MANIFEST_GLOBAL_EXPANDED"));
  const r = ok(await normalizeScope(f.options));
  assert.equal(r.manifest.set, "global");
  assert.equal(r.manifest.skills, undefined);
  ok(await normalizeScope({ ...f.options, apply: true }));
  assert.equal(readFileSync(join(f.home, ".agents/skills.json"), "utf8"), globalManifest);
  assert.deepEqual(ok(await normalizeScope(f.options)).changes, []);
});

test("normalize deduplicates an inherited partial group without replacing global identity", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two", "three"]) f.skill(name);
  f.set("global", ["one", "two"]);
  f.manifest(f.home, { set: "global" });
  f.manifest(f.project, { inherit_global: true, skills: ["one", "three"] });
  const r = ok(await normalizeScope(f.options));
  assert.deepEqual(r.manifest.skills, ["three"]);
  assert.equal(r.manifest.set, undefined);
});

test("normalize refuses conflicting preview/apply and does not hide invalid references", async (t) => {
  const f = fixture(t);
  f.manifest(f.project, { skills: ["missing"], inherit_global: false });
  assert.equal((await normalizeScope({ ...f.options, dryRun: true, apply: true })).exit, 2);
  assert.equal((await normalizeScope(f.options)).ok, false);
});

test("normalized ordinary pack selection remains independent during sync", async (t) => {
  const f = fixture(t);
  for (const name of ["one", "two"]) f.skill(name);
  f.manifest(f.project, { inherit_global: false, skills: ["one", "one", "two"] });
  ok(await normalizeScope({ ...f.options, apply: true }));
  assert.deepEqual(ok(await sync({ ...f.options, dryRun: true })).changes, []);
});
