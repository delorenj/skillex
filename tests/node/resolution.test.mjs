import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { resolveSelection } from "@delorenj/skillex";
import {
  assertFailure,
  assertOptionalSkip,
  assertSuccess,
  createResolutionFixture,
  resolvedScope,
} from "./resolution-fixture.mjs";

const names = (scope) => scope.bindings.map((binding) => binding.name);

it("composes inheritance, declared sets, and explicit skills with complete provenance", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const name of ["shared", "zeta", "alpha", "local-only", "exclude-me"]) f.skill(name);
  f.set("first", ["zeta", "shared", "exclude-me"]);
  f.set("second", ["alpha", "shared"]);
  const globalManifest = f.manifest(f.home, { skills: ["shared"] });
  const projectManifest = f.manifest(f.project, {
    sets: ["first", "second"],
    skills: ["local-only", "shared"],
    exclude: ["exclude-me"],
  });

  const result = await f.resolve();
  assertSuccess(result);
  const project = resolvedScope(result);
  assert.deepEqual(names(project), ["shared", "zeta", "alpha", "local-only"]);
  assert.equal(project.mode, "composed");
  const shared = project.bindings.find((binding) => binding.name === "shared");
  assert.equal(shared.path, join(f.registry, "all-skills", "shared"));
  assert.ok(
    shared.origins.some(
      (origin) => origin.scope === "global" && origin.manifest === globalManifest,
    ),
  );
  assert.ok(shared.origins.some((origin) => origin.kind === "inherit"));
  assert.ok(
    shared.origins.some((origin) => origin.kind === "skill" && origin.manifest === projectManifest),
  );
  for (const set of ["first", "second"]) {
    assert.ok(
      shared.origins.some((origin) => origin.kind === "set" && origin.reference.includes(set)),
    );
  }
  assert.ok(project.excluded.some((entry) => entry.name === "exclude-me" && entry.by === "scope"));
});

it("project-only targeting still resolves global inheritance by default", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("global-skill");
  f.skill("local-skill");
  f.manifest(f.home, { skills: ["global-skill"] });
  f.manifest(f.project, { skills: ["local-skill"] });

  const result = await f.resolve({ scope: "project" });
  assertSuccess(result);
  assert.deepEqual(result.data.writeScopes, ["project"]);
  assert.deepEqual(names(resolvedScope(result)), ["global-skill", "local-skill"]);
  assert.equal(resolvedScope(result, "global").root, f.home);
  assert.equal(resolvedScope(result).root, f.project);
});

it("disabled inheritance avoids reading a malformed global manifest", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("local-skill");
  f.file(join(f.home, ".agents", "skills.json"), "not json\n");
  f.manifest(f.project, { skills: ["local-skill"], inherit_global: false });

  const result = await f.resolve();
  assertSuccess(result);
  assert.deepEqual(
    result.data.scopes.map((scope) => scope.scope),
    ["project"],
  );
  assert.deepEqual(names(resolvedScope(result)), ["local-skill"]);
});

it("global targeting does not parse an unrelated malformed project manifest", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("global-skill");
  f.manifest(f.home, { skills: ["global-skill"] });
  f.file(join(f.project, ".agents", "skills.json"), "not json\n");
  const result = await f.resolve({ scope: "global" });
  assertSuccess(result);
  assert.deepEqual(result.data.writeScopes, ["global"]);
  assert.deepEqual(
    result.data.scopes.map((scope) => scope.scope),
    ["global"],
  );
  assert.deepEqual(names(resolvedScope(result, "global")), ["global-skill"]);
});

it("a project may explicitly re-enable a skill excluded globally", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("shared");
  f.skill("global-only");
  f.manifest(f.home, { skills: ["shared", "global-only"], exclude: ["shared"] });
  f.manifest(f.project, { skills: ["shared"] });

  const result = await f.resolve();
  assertSuccess(result);
  assert.deepEqual(names(resolvedScope(result, "global")), ["global-only"]);
  assert.deepEqual(names(resolvedScope(result)), ["global-only", "shared"]);
  assert.ok(resolvedScope(result, "global").excluded.some((entry) => entry.name === "shared"));
});

it("scope exclusions apply after direct entries and inherited or set contributions", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const name of ["inherited", "from-set", "direct", "keep"]) f.skill(name);
  f.set("selection", ["from-set", "keep"]);
  f.manifest(f.home, { skills: ["inherited"] });
  f.manifest(f.project, {
    sets: ["selection"],
    skills: ["direct", "inherited"],
    exclude: ["inherited", "from-set", "direct"],
  });

  const result = await f.resolve();
  assertSuccess(result);
  assert.deepEqual(names(resolvedScope(result)), ["keep"]);
  assert.deepEqual(names(resolvedScope(result, "global")), ["inherited"]);
  assert.deepEqual(
    resolvedScope(result)
      .excluded.map((entry) => entry.name)
      .sort(),
    ["direct", "from-set", "inherited"],
  );
});

it("set include and exclude filters run before resolving unselected broken references", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("good");
  f.set("filtered", ["good", "broken", "unselected"]);
  f.manifest(f.project, {
    sets: [{ name: "filtered", include: ["good", "broken"], exclude: ["broken"] }],
  });

  const result = await f.resolve();
  assertSuccess(result);
  assert.deepEqual(names(resolvedScope(result)), ["good"]);
});

it("a requested include member absent from a required set is an error", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("good");
  f.set("filtered", ["good"]);
  f.manifest(f.project, { sets: [{ name: "filtered", include: ["missing"] }] });
  assertFailure(await f.resolve(), "E_SET_MEMBER_MISSING");
});

it("an optional missing set reports partial resolution while preserving direct selections", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("keep");
  f.manifest(f.project, { sets: [{ name: "absent", optional: true }], skills: ["keep"] });
  const result = await f.resolve();
  assertOptionalSkip(result);
  assert.deepEqual(names(resolvedScope(result)), ["keep"]);
});

it("optional unresolved set members remain visible without discarding valid members", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("good");
  f.set("partly-present", ["good", "broken"]);
  f.manifest(f.project, { sets: [{ name: "partly-present", optional: true }] });
  const result = await f.resolve();
  assertOptionalSkip(result);
  assert.deepEqual(names(resolvedScope(result)), ["good"]);
  assert.ok(result.findings.some((finding) => JSON.stringify(finding).includes("broken")));
});

it("optional missing include members report a skip and retain present requested members", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("good");
  f.set("filtered", ["good"]);
  f.manifest(f.project, {
    sets: [{ name: "filtered", include: ["good", "missing"], optional: true }],
  });
  const result = await f.resolve();
  assertOptionalSkip(result);
  assert.deepEqual(names(resolvedScope(result)), ["good"]);
});

for (const [field, reference, code] of [
  ["skills", "absent", "E_SKILL_MISSING"],
  ["sets", "absent", "E_SET_MISSING"],
  ["packs", "absent@1.0.0", "E_PACK_MISSING"],
]) {
  it(`refuses a missing required ${field} reference`, async (t) => {
    const f = createResolutionFixture(t, resolveSelection);
    f.manifest(f.project, { [field]: [reference] });
    assertFailure(await f.resolve(), code);
  });
}

it("an exclusive pack resolves its manifest without a materialized skills directory", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("packed");
  const packRoot = f.pack("focus", "1.0.0", ["packed"]);
  f.file(join(f.home, ".agents", "skills.json"), "not json\n");
  f.manifest(f.project, {
    packs: ["focus@1.0.0"],
    sets: ["dormant-missing-set"],
    skills: ["dormant-missing-skill"],
    exclude: ["packed"],
    inherit_global: true,
  });

  const result = await f.resolve();
  assertSuccess(result);
  const project = resolvedScope(result);
  assert.equal(project.mode, "pack");
  assert.deepEqual(names(project), ["packed"]);
  assert.equal(project.pack.name, "focus");
  assert.equal(project.pack.version, "1.0.0");
  assert.equal(project.pack.path, packRoot);
  assert.equal(existsSync(join(packRoot, "skills")), false);
  assert.deepEqual(
    project.manifest.skills.map((skill) => skill.name),
    ["dormant-missing-skill"],
  );
  assert.deepEqual(
    project.manifest.sets.map((set) => set.name),
    ["dormant-missing-set"],
  );
  assert.deepEqual(project.manifest.exclude, ["packed"]);
  assert.equal(project.manifest.inheritGlobal, true);
  assert.deepEqual(
    result.data.scopes.map((scope) => scope.scope),
    ["project"],
  );
});

it("disabling a pack restores the retained composition and its exclusions", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const name of ["global-skill", "set-skill", "local-skill", "packed"]) f.skill(name);
  f.set("ordinary", ["set-skill"]);
  f.pack("focus", "1.0.0", ["packed"]);
  f.manifest(f.home, { skills: ["global-skill"] });
  const ordinary = {
    sets: ["ordinary"],
    skills: ["local-skill"],
    exclude: ["set-skill", "packed"],
  };
  f.manifest(f.project, { ...ordinary, packs: ["focus@1.0.0"] });
  const active = await f.resolve();
  assertSuccess(active);
  assert.deepEqual(names(resolvedScope(active)), ["packed"]);

  f.manifest(f.project, { ...ordinary, packs: [] });
  const restored = await f.resolve();
  assertSuccess(restored);
  assert.equal(resolvedScope(restored).mode, "composed");
  assert.deepEqual(names(resolvedScope(restored)), ["global-skill", "local-skill"]);
  assert.ok(resolvedScope(restored).excluded.some((entry) => entry.name === "set-skill"));
});

it("an optional missing pack never substitutes the dormant composition", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("dormant");
  f.file(join(f.home, ".agents", "skills.json"), "not json\n");
  f.manifest(f.project, { packs: [{ name: "absent", optional: true }], skills: ["dormant"] });
  const result = await f.resolve();
  assertOptionalSkip(result);
  assert.equal(resolvedScope(result).mode, "pack");
  assert.deepEqual(names(resolvedScope(result)), []);
});

it("auto targeting resolves global writes even when the project uses an exclusive pack", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("global-skill");
  f.skill("packed");
  f.pack("focus", "1.0.0", ["packed"]);
  f.manifest(f.home, { skills: ["global-skill"] });
  f.manifest(f.project, { packs: ["focus@1.0.0"] });
  const result = await f.resolve({ scope: "auto" });
  assertSuccess(result);
  assert.deepEqual(result.data.writeScopes, ["global", "project"]);
  assert.deepEqual(names(resolvedScope(result, "global")), ["global-skill"]);
  assert.deepEqual(names(resolvedScope(result)), ["packed"]);
});

it("both-scope targeting validates global input even when project inheritance is disabled", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.file(join(f.home, ".agents", "skills.json"), "not json\n");
  f.manifest(f.project, { skills: [], inherit_global: false });
  assertFailure(await f.resolve({ scope: "both" }), "E_MANIFEST_PARSE");
});

it("versionless pack selection uses semantic version ordering", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const [version, name] of [
    ["2.0.0", "two"],
    ["10.0.0", "ten"],
  ]) {
    f.skill(name);
    f.pack("versioned", version, [name]);
  }
  f.manifest(f.project, { packs: ["versioned"] });
  const result = await f.resolve();
  assertSuccess(result);
  assert.equal(resolvedScope(result).pack.version, "10.0.0");
  assert.deepEqual(names(resolvedScope(result)), ["ten"]);
});

it("multiple packs fail preflight even when neither pack exists", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.manifest(f.project, { packs: ["first", "second"] });
  assertFailure(await f.resolve(), "E_MANIFEST_INVALID");
});

for (const filter of ["include", "exclude"]) {
  it(`rejects pack ${filter} filters instead of accepting ineffective selection`, async (t) => {
    const f = createResolutionFixture(t, resolveSelection);
    f.manifest(f.project, { packs: [{ name: "focus", [filter]: [] }] });
    assertFailure(await f.resolve(), "E_LEGACY_FIELD");
  });
}

it("schema validation still rejects legacy fields in a pack's dormant selection", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("packed");
  f.pack("focus", "1.0.0", ["packed"]);
  f.manifest(f.project, {
    packs: ["focus@1.0.0"],
    skills: [{ name: "dormant", source: "file:///legacy/skill" }],
  });
  assertFailure(await f.resolve(), "E_LEGACY_FIELD");
});

it("selected pack trees cannot contain embedded skill definitions", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("packed");
  const packRoot = f.pack("focus", "1.0.0", ["packed"]);
  f.file(join(packRoot, "payload", "copied", "SKILL.md"), "# Copied definition\n");
  f.manifest(f.project, { packs: ["focus@1.0.0"] });
  assertFailure(await f.resolve());
});

it("pack manifests reject legacy copied-payload policy", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("packed");
  const packRoot = f.pack("focus", "1.0.0", ["packed"]);
  f.file(
    join(packRoot, "pack.toml"),
    '[pack]\nname = "focus"\nversion = "1.0.0"\n[freeform]\nskills = ["packed"]\n[policy]\nflatten = true\n',
  );
  f.manifest(f.project, { packs: ["focus@1.0.0"] });
  assertFailure(await f.resolve(), "E_LEGACY_FIELD");
});

for (const variant of ["directory-link", "definition-link"]) {
  it(`rejects a canonical catalog entry with a ${variant}`, async (t) => {
    const f = createResolutionFixture(t, resolveSelection);
    const external = f.directory(join(f.root, "external", "borrowed"));
    f.file(join(external, "SKILL.md"), "# Borrowed definition\n");
    const canonical = join(f.registry, "all-skills", "borrowed");
    if (variant === "directory-link") f.link(canonical, external);
    else f.link(join(canonical, "SKILL.md"), join(external, "SKILL.md"));
    f.manifest(f.project, { skills: ["borrowed"] });
    assertFailure(await f.resolve(), "E_NONCANONICAL_REFERENCE");
  });
}

it("rejects copied definitions in a set even when a canonical definition exists", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("original");
  const setRoot = f.set("copied");
  f.file(join(setRoot, "original", "SKILL.md"), "# Copied definition\n");
  f.manifest(f.project, { sets: ["copied"] });
  assertFailure(await f.resolve(), "E_NONCANONICAL_REFERENCE");
});

it("set symlinks must point to the canonical definition of their declared name", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("declared");
  const wrongTarget = f.skill("different");
  const setRoot = f.set("mismatched");
  f.link(join(setRoot, "declared"), wrongTarget);
  f.manifest(f.project, { sets: ["mismatched"] });
  assertFailure(await f.resolve(), "E_NONCANONICAL_REFERENCE");
});

it("divergent canonical paths for one inherited name are refused across registry caches", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  const globalUrl = "https://registry.invalid/global.git";
  const projectUrl = "https://registry.invalid/project.git";
  f.skill("shared", f.cachedRegistry(globalUrl));
  f.skill("shared", f.cachedRegistry(projectUrl));
  f.manifest(f.home, { registry: globalUrl, skills: ["shared"] });
  f.manifest(f.project, { registry: projectUrl, skills: ["shared"] });
  assertFailure(await f.resolve({ registryRoot: undefined }), "E_DIVERGENT_CANONICAL_NAME");
});

it("an explicit registry root outranks a different valid environment registry", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  const explicitPath = f.skill("selected");
  const other = f.createRegistry(join(f.root, "environment-registry"));
  f.skill("selected", other);
  f.manifest(f.project, { skills: ["selected"] });
  const result = await f.resolve({ env: { PJ_SKILLS_REGISTRY_ROOT: other } });
  assertSuccess(result);
  assert.equal(resolvedScope(result).registry.root, f.registry);
  assert.equal(resolvedScope(result).registry.source, "argument");
  assert.equal(resolvedScope(result).bindings[0].path, explicitPath);
});

for (const source of ["argument", "environment"]) {
  for (const scope of ["auto", "project"]) {
    it(`resolves a relative ${source} registry from nested invocation cwd with ${scope} targeting`, async (t) => {
      const f = createResolutionFixture(t, resolveSelection);
      const cwd = f.directory(join(f.project, "src", "nested"));
      const registry = f.createRegistry(join(cwd, "local-catalog"));
      f.skill("global-skill", registry);
      f.skill("project-skill", registry);
      f.manifest(f.home, { skills: ["global-skill"] });
      f.manifest(f.project, { skills: ["project-skill"] });
      const options =
        source === "argument"
          ? { registryRoot: "local-catalog" }
          : { registryRoot: undefined, env: { PJ_SKILLS_REGISTRY_ROOT: "local-catalog" } };

      const result = await f.resolve({ cwd, scope, ...options });
      assertSuccess(result);
      assert.deepEqual(
        result.data.writeScopes,
        scope === "auto" ? ["global", "project"] : ["project"],
      );
      assert.deepEqual(names(resolvedScope(result)), ["global-skill", "project-skill"]);
      for (const name of ["global", "project"]) {
        const selected = resolvedScope(result, name);
        assert.equal(selected.registry.root, registry);
        assert.equal(selected.registry.source, source);
        for (const binding of selected.bindings) {
          assert.equal(binding.path, join(registry, "all-skills", binding.name));
        }
      }
    });
  }
}

it("invalid explicit registry roots never fall through to a valid environment root", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("selected");
  f.manifest(f.project, { skills: ["selected"] });
  const plainFile = f.file(join(f.root, "not-a-registry"), "file\n");
  for (const registryRoot of [join(f.root, "missing"), plainFile, ""]) {
    await t.test(JSON.stringify(registryRoot), async () => {
      assertFailure(
        await f.resolve({ registryRoot, env: { PJ_SKILLS_REGISTRY_ROOT: f.registry } }),
        "E_REGISTRY_ROOT",
      );
    });
  }
});

for (const scope of ["auto", "project"]) {
  for (const hasGlobalSkill of [false, true]) {
    it(`uses the invocation registry checkout for ${scope} targeting with an ${hasGlobalSkill ? "inherited" : "empty"} global selection and no installed catalog`, async (t) => {
      const f = createResolutionFixture(t, resolveSelection);
      f.skill("global-skill");
      f.skill("project-skill");
      f.directory(join(f.registry, ".git"));
      f.manifest(f.home, { skills: hasGlobalSkill ? ["global-skill"] : [] });
      f.manifest(f.registry, { skills: ["project-skill"] });
      const cwd = f.directory(join(f.registry, "tools", "nested"));
      const installedRoot = f.directory(join(f.root, "installed-package"));
      f.file(join(installedRoot, "package.json"), '{"name":"@delorenj/skillex","type":"module"}\n');

      const result = await f.resolve({
        cwd,
        scope,
        registryRoot: undefined,
        env: {},
        installedRoot,
      });
      assertSuccess(result);
      assert.deepEqual(
        result.data.writeScopes,
        scope === "auto" ? ["global", "project"] : ["project"],
      );
      assert.equal(resolvedScope(result).root, f.registry);
      assert.deepEqual(
        names(resolvedScope(result, "global")),
        hasGlobalSkill ? ["global-skill"] : [],
      );
      assert.deepEqual(
        names(resolvedScope(result)),
        hasGlobalSkill ? ["global-skill", "project-skill"] : ["project-skill"],
      );
      for (const name of ["global", "project"]) {
        assert.equal(resolvedScope(result, name).registry.root, f.registry);
        assert.equal(resolvedScope(result, name).registry.source, "checkout");
      }
    });
  }
}

it("discovers the nearest project manifest from nested working directories", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("outer");
  f.skill("inner");
  f.manifest(f.project, { skills: ["outer"], inherit_global: false });
  const inner = f.directory(join(f.project, "nested-project"));
  f.directory(join(inner, ".git"));
  f.manifest(inner, { skills: ["inner"], inherit_global: false });
  const cwd = f.directory(join(inner, "src", "deep"));
  const result = await f.resolve({ cwd });
  assertSuccess(result);
  assert.equal(resolvedScope(result).root, inner);
  assert.deepEqual(names(resolvedScope(result)), ["inner"]);
});

it("does not inherit an outer project across an unrelated nested Git boundary", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  const nested = f.directory(join(f.project, "unrelated"));
  f.directory(join(nested, ".git"));
  const cwd = f.directory(join(nested, "src"));
  assertFailure(await f.resolve({ cwd }), "E_NO_PROJECT_MANIFEST");
});

it("an explicit project override selects its manifest across a nested Git boundary", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("outer");
  f.manifest(f.project, { skills: ["outer"], inherit_global: false });
  const nested = f.directory(join(f.project, "unrelated"));
  f.directory(join(nested, ".git"));
  const result = await f.resolve({ cwd: nested, project: f.project });
  assertSuccess(result);
  assert.equal(resolvedScope(result).root, f.project);
  assert.deepEqual(names(resolvedScope(result)), ["outer"]);
});

it("auto targeting outside a project resolves and selects only the global scope", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  f.skill("global-skill");
  f.manifest(f.home, { skills: ["global-skill"] });
  const result = await f.resolve({ cwd: f.directory(join(f.root, "outside")), scope: "auto" });
  assertSuccess(result);
  assert.deepEqual(result.data.writeScopes, ["global"]);
  assert.deepEqual(
    result.data.scopes.map((scope) => scope.scope),
    ["global"],
  );
  assert.deepEqual(names(resolvedScope(result, "global")), ["global-skill"]);
});

it("malformed JSON becomes an actionable result instead of an uncaught rejection", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  const path = f.file(join(f.project, ".agents", "skills.json"), "{invalid json\n");
  const result = await f.resolve();
  assertFailure(result, "E_MANIFEST_PARSE");
  assert.equal(result.findings.find((finding) => finding.code === "E_MANIFEST_PARSE").path, path);
});

it("schema-invalid manifests fail before any references are resolved", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const manifest of [
    { skills: "not-an-array" },
    { skills: [], inherit_global: "yes" },
    { skills: [], exclude: [42] },
  ]) {
    await t.test(JSON.stringify(manifest), async () => {
      f.manifest(f.project, manifest);
      assertFailure(await f.resolve(), "E_MANIFEST_INVALID");
    });
  }
});

it("unsafe canonical names cannot escape a catalog or enter a composition", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const manifest of [
    { skills: ["../outside"] },
    { skills: ["/absolute"] },
    { skills: ["bad\\name"] },
    { sets: ["bad/name"] },
    { skills: [], exclude: ["../outside"] },
  ]) {
    await t.test(JSON.stringify(manifest), async () => {
      f.manifest(f.project, manifest);
      assertFailure(await f.resolve(), "E_MANIFEST_INVALID");
    });
  }
});

it("legacy source, payload, and slot fields receive migration diagnostics", async (t) => {
  const f = createResolutionFixture(t, resolveSelection);
  for (const manifest of [
    { skills: [{ name: "old", source: "file:///legacy/skill" }] },
    { sets: [{ name: "old", registry_path: "skill-sets/old" }] },
    { skills: [], payload: "snapshot" },
    { skills: [], slots: [] },
    { packs: [{ name: "old", flatten: false }] },
  ]) {
    await t.test(JSON.stringify(manifest), async () => {
      f.manifest(f.project, manifest);
      assertFailure(await f.resolve(), "E_LEGACY_FIELD");
    });
  }
});
