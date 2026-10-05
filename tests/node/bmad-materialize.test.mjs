/**
 * Seeded generative cross-project CLI property tests for BMAD materialization
 * (SKRILL-27). Exercises the BUILT CLI (dist/cli.js) like bmad-freeze tests do.
 *
 * Laws under test (from the SKRILL-27 contract):
 *  L1 equivalence: same S/C at distinct roots => identical normalized output.
 *  L2 idempotence: second apply = zero changes, byte-stable (no volatile rewrite).
 *  L3 dry-run: same decisions as apply, zero writes.
 *  L4 preservation: foreign collisions refuse before ANY write; tree unchanged.
 *  L5 pin integrity: tampered pinned input under same label refuses.
 *  L6 explicit deps: missing required runtime refuses with actionable error.
 *  L7 no ambient: polluted HOME/global manifest cannot influence the result.
 *
 * Every failure prints the seed + case for reproduction.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
  assertSameManaged,
  expectedRuntimeNodes,
  managedPaths,
  normalized,
  observeTree,
} from "./bmad-materialize-oracle.mjs";

const CLI = join(dirnameOf(import.meta.url), "..", "..", "dist", "cli.js");

function dirnameOf(url) {
  return new URL(".", url).pathname.replace(/\/$/, "");
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args], {
    encoding: "utf8",
    ...options,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return {
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    data: parsed?.data ?? null,
    envelope: parsed,
  };
}

/** Deterministic PRNG (mulberry32) — reproducible seeds. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a synthetic BMAD-enabled source fixture (v1/v2 distinct content+membership)
 * with a COMPLETE runtime tree including _bmad/scripts support files.
 */
function sourceFixture(t, { version, variant, completeRuntime = true }) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "_bmad", "_config");
  mkdirSync(config, { recursive: true });
  const skills =
    variant === "v1"
      ? [
          { name: "bmad-alpha", module: "core" },
          { name: "bmad-beta", module: "bmm" },
        ]
      : [
          { name: "bmad-alpha", module: "core" },
          { name: "bmad-beta", module: "bmm" },
          { name: "bmad-gamma", module: "cis" }, // v2 adds a member
        ];
  const csvRows = [
    "canonicalId,name,description,module,path",
    ...skills.map(
      (skill) =>
        `"${skill.name}","${skill.name}","${skill.name} ${variant}","${skill.module}","_bmad/${skill.module}/${skill.name}/SKILL.md"`,
    ),
  ];
  writeFileSync(join(config, "skill-manifest.csv"), `${csvRows.join("\n")}\n`);
  const yaml = [
    "installation:",
    `  version: "${version}"`,
    '  installDate: "2026-02-06T07:38:12.789Z"',
    '  lastUpdated: "2026-09-20T06:04:31.608Z"',
    "modules:",
    "  - name: core",
    `    version: "${version}"`,
    "    source: built-in",
  ].join("\n");
  writeFileSync(join(config, "manifest.yaml"), `${yaml}\n`);
  writeFileSync(
    join(config, "files-manifest.csv"),
    `${[
      "type,name,module,path,hash",
      '"yaml","manifest","_config","_config/manifest.yaml","abc"',
      '"yaml","skills","_config","_config/skill-manifest.csv","abc"',
      '"py","resolve_config","scripts","scripts/resolve_config.py","abc"',
      '"py","render_skill","scripts","scripts/render_skill.py","abc"',
      '"py","config_utils","scripts","scripts/config_utils.py","abc"',
      '"md","workflow","core","core/workflow.md","abc"',
      // Canonical skill body locations per the skill manifest: these are bound
      // as catalog REFERENCES at spec build, never copied into the runtime.
      ...skills.map(
        (skill) =>
          `"md","${skill.name}","${skill.module}","${skill.module}/${skill.name}/SKILL.md","abc"`,
      ),
      // Genuine support assets OUTSIDE the legacy hardcoded 3 roots (bmm module
      // workflows + assets) — a complete declared closure must materialize them.
      '"md","prd-template","bmm","bmm/plan/bmad-prd/assets/prd-template.md","abc"',
      '"yaml","module-config","bmb","bmb/bmad-bmb-setup/assets/module.yaml","abc"',
    ].join("\n")}\n`,
  );
  for (const skill of skills) {
    const path = join(root, ".agents", "skills", skill.name);
    mkdirSync(join(path, "references"), { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.name} ${variant}\n---\n\n# ${skill.name} (${variant})\nUses {project-root}/_bmad/scripts/resolve_config.py\n`,
    );
    writeFileSync(join(path, "references", "guide.md"), `Guide ${variant} for ${skill.name}\n`);
    // The source install's own runtime tree holds the canonical bodies under
    // _bmad/<module>/<name>/ (the skill manifest points here); they are
    // reference-mapped, never copied.
    const runtimeSkill = join(root, "_bmad", skill.module, skill.name);
    mkdirSync(runtimeSkill, { recursive: true });
    writeFileSync(join(runtimeSkill, "SKILL.md"), `canonical ${skill.name} ${variant}\n`);
  }
  // Complete runtime support tree.
  const scripts = join(root, "_bmad", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["resolve_config.py", "render_skill.py", "config_utils.py"]) {
    writeFileSync(join(scripts, name), `#!/usr/bin/env python3\n# ${variant} ${name}\n`);
  }
  mkdirSync(join(root, "_bmad", "core"), { recursive: true });
  writeFileSync(join(root, "_bmad", "core", "workflow.md"), `core workflow ${variant}\n`);
  // Support assets outside the legacy 3 roots.
  mkdirSync(join(root, "_bmad", "bmm", "plan", "bmad-prd", "assets"), { recursive: true });
  writeFileSync(
    join(root, "_bmad", "bmm", "plan", "bmad-prd", "assets", "prd-template.md"),
    `prd template ${variant}\n`,
  );
  mkdirSync(join(root, "_bmad", "bmb", "bmad-bmb-setup", "assets"), { recursive: true });
  writeFileSync(
    join(root, "_bmad", "bmb", "bmad-bmb-setup", "assets", "module.yaml"),
    `module: bmb-setup ${variant}\n`,
  );
  writeFileSync(
    join(root, "_bmad", "config.toml"),
    `# installer-managed ${variant}\n[core]\nproject_name = "SOURCE-IDENTITY"\n`,
  );
  if (!completeRuntime) rmSync(scripts, { recursive: true, force: true });
  // Per-client commands (2 layouts minimum across versions).
  const claude = join(root, ".claude", "commands");
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    join(claude, "bmad-alpha.agent.md"),
    `---\nname: alpha\n---\nLOAD {project-root}/_bmad/core/workflow.md\n`,
  );
  const opencode = join(root, ".opencode", "commands");
  mkdirSync(opencode, { recursive: true });
  writeFileSync(join(opencode, "bmad-alpha.md"), `@skills/bmad-alpha\n`);
  return { root, version, variant, members: skills.map((s) => s.name) };
}

function registryFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  return {
    root,
    registry,
    stateHome,
    options: { registryRoot: registry, home: root, cwd: root, env: { XDG_STATE_HOME: stateHome } },
  };
}

/** Seedable noise injection: unrelated foreign files at randomized spots. */
function injectNoise(projectRoot, random, count) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const name = `unrelated-${i}-${Math.floor(random() * 1000)}.txt`;
    const dir = join(projectRoot, random() < 0.5 ? "docs" : "notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `noise ${i}\n`);
    names.push(join(dir, name));
  }
  return names;
}

const CLIENT_COMBOS = [
  ["claude-code"],
  ["codex", "gemini"],
  ["claude-code", "opencode-skill", "qwen"],
];

/** Build specs for both versions into their own ISOLATED registries via real freeze. */
function materializationWorld(t, seed) {
  const random = rng(seed);
  const v1Source = sourceFixture(t, { version: "6.12.1-next.0", variant: "v1" });
  const v2Source = sourceFixture(t, { version: "6.13.0-rc.1", variant: "v2" });
  const reg1 = registryFixture(t);
  const reg2 = registryFixture(t);
  const freeze1 = run(["bmad", "freeze", v1Source.root, "--registry-root", reg1.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg1.stateHome },
  });
  assert.equal(freeze1.exit, 0, freeze1.stderr + freeze1.stdout);
  const freeze2 = run(["bmad", "freeze", v2Source.root, "--registry-root", reg2.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg2.stateHome },
  });
  assert.equal(freeze2.exit, 0, freeze2.stderr + freeze2.stdout);
  return { random, sources: { v1: v1Source, v2: v2Source }, registries: { v1: reg1, v2: reg2 } };
}

function buildSpec(world, versionKey, clients, specPath, projectName) {
  const registry = world.registries[versionKey];
  const packRef = `bmad@${world.sources[versionKey].version}`;
  const args = [
    "bmad",
    "spec",
    "build",
    packRef,
    world.sources[versionKey].root,
    "--registry-root",
    registry.registry,
    ...clients.flatMap((client) => ["--client", client]),
    "--spec-path",
    specPath,
  ];
  if (projectName) args.push("--project-name", projectName);
  return run(args, { env: { ...process.env, HOME: world.sources[versionKey].root } });
}

function planOrApply(world, versionKey, projectRoot, specPath, dryRun, extraEnv = {}) {
  const registry = world.registries[versionKey];
  return run(
    [
      "bmad",
      dryRun ? "plan" : "apply",
      projectRoot,
      specPath,
      "--registry-root",
      registry.registry,
    ],
    {
      env: { ...process.env, HOME: registry.root, XDG_STATE_HOME: registry.stateHome, ...extraEnv },
    },
  );
}

/** THE property: distinct roots, same S/C => identical normalized output. */
it("L1 equivalence: same spec/config at 3 distinct roots normalizes identically", (t) => {
  for (const seed of [12345, 67890]) {
    const world = materializationWorld(t, seed);
    const clients = CLIENT_COMBOS[seed % CLIENT_COMBOS.length];
    const specPath = join(world.registries.v1.root, "spec-v1.json");
    const build = buildSpec(world, "v1", clients, specPath, "EquivalentProject");
    assert.equal(build.exit, 0, build.stderr + build.stdout);
    const roots = [];
    for (let i = 0; i < 3; i += 1) {
      const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      roots.push(root);
    }
    const observations = [];
    for (const root of roots) {
      injectNoise(root, world.random, 1 + Math.floor(world.random() * 3));
      const apply = planOrApply(world, "v1", root, specPath, false);
      assert.equal(apply.exit, 0, `seed=${seed} root=${root} ${apply.stderr}${apply.stdout}`);
      observations.push(observeTree(root));
    }
    const base = managedPaths(observations[0]);
    for (let i = 1; i < observations.length; i += 1) {
      const problems = assertSameManaged(
        managedPaths(observations[i]),
        base,
        `seed=${seed} root#${i}`,
      );
      assert.deepEqual(problems, [], `seed=${seed}: cross-root managed divergence`);
    }
    // Independent expected runtime bytes (oracle-authored, not planner echoes).
    const expectedRuntime = expectedRuntimeNodes(world.sources.v1.root, "EquivalentProject");
    const runtimeProblems = [];
    for (const key of Object.keys(expectedRuntime)) {
      const observed = base[key];
      const expected = expectedRuntime[key];
      if (!observed) runtimeProblems.push(`missing ${key}`);
      else if (
        expected.kind === "file" &&
        observed.kind === "file" &&
        observed.sha256 !== expected.sha256
      )
        runtimeProblems.push(`bytes differ: ${key}`);
    }
    assert.deepEqual(runtimeProblems, [], `seed=${seed}: runtime bytes vs independent expectation`);
    // Project identity: materialized config must NOT be the source's identity.
    const config = readFileSync(join(roots[0], "_bmad", "config.toml"), "utf8");
    assert.match(config, /project_name = "EquivalentProject"/);
    assert.doesNotMatch(config, /SOURCE-IDENTITY/);
  }
});

/** L2 idempotence: second apply zero changes, no mtime churn on owned files. */
it("L2 idempotence: repeat apply is a byte-and-mtime no-op", (t) => {
  const seed = 424242;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "IdemProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", root, specPath, false).exit, 0);
  const first = observeTree(root);
  // Touch nothing; second apply must report zero writes.
  const second = planOrApply(world, "v1", root, specPath, false);
  assert.equal(second.exit, 0, second.stderr + second.stdout);
  assert.equal(second.data.changesWritten, 0, `seed=${seed}: second apply wrote changes`);
  const after = observeTree(root);
  // No volatile rewrite: file identity (bytes) identical; owned runtime files untouched.
  assert.deepEqual(assertSameManaged(normalized(after), normalized(first), "second-apply"), []);
  for (const rel of Object.keys(first.mtimes)) {
    if (rel.startsWith("_bmad/") || rel.startsWith(".skillex/"))
      assert.equal(after.mtimes[rel], first.mtimes[rel], `volatile rewrite detected: ${rel}`);
  }
});

/** L3 dry-run: identical decisions, zero target writes. */
it("L3 dry-run plans identically and writes nothing", (t) => {
  const seed = 777;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v2.root, "spec.json");
  assert.equal(buildSpec(world, "v2", ["codex", "gemini"], specPath, "DryProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = observeTree(root);
  const dry = planOrApply(world, "v2", root, specPath, true);
  assert.equal(dry.exit, 0, dry.stderr + dry.stdout);
  assert.equal(dry.data.applied, false);
  const after = observeTree(root);
  assert.deepEqual(assertSameManaged(normalized(after), normalized(before), "dry-run"), []);
  // The dry plan's node count equals what apply realizes.
  const apply = planOrApply(world, "v2", root, specPath, false);
  assert.equal(apply.exit, 0, apply.stderr + apply.stdout);
  assert.equal(apply.data.nodes.length, dry.data.nodes.length, "dry/apply node divergence");
  assert.ok(apply.data.changesWritten > 0, "apply wrote nothing");
});

/** L4 preservation: foreign collision at a desired path refuses, tree unchanged. */
it("L4 foreign collision refuses before any write", (t) => {
  const seed = 31337;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "CollisionProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Foreign file occupying a desired runtime path (even with MATCHING bytes from source).
  const scriptDir = join(root, "_bmad", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(
    join(scriptDir, "resolve_config.py"),
    readFileSync(join(world.sources.v1.root, "_bmad", "scripts", "resolve_config.py")),
  );
  const before = observeTree(root);
  const dry = planOrApply(world, "v1", root, specPath, true);
  assert.equal(
    dry.exit,
    3,
    `seed=${seed}: collision must REFUSE (exit 4), got ${dry.exit}: ${dry.stdout}`,
  );
  const applied = planOrApply(world, "v1", root, specPath, false);
  assert.equal(applied.exit, 3, `seed=${seed}: apply must REFUSE on collision`);
  const after = observeTree(root);
  assert.deepEqual(
    assertSameManaged(normalized(after), normalized(before), "collision-refusal"),
    [],
  );
});

/** L4b authored edit to an owned file refuses rather than silently repairing. */
it("L4b authored edit of owned runtime refuses", (t) => {
  const seed = 99991;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "EditProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", root, specPath, false).exit, 0);
  const owned = join(root, "_bmad", "scripts", "resolve_config.py");
  writeFileSync(owned, "# local edit\n");
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(refusal.exit, 3, `seed=${seed}: authored edit must refuse, got ${refusal.exit}`);
  assert.equal(readFileSync(owned, "utf8"), "# local edit\n", "authored edit was clobbered");
});

/**
 * L5 pin integrity under the NAMES-ONLY model (ADR-0001): identity is the
 * aggregate composition pin (exact pack.toml bytes + declared membership),
 * never a sealed per-skill inventory. Removing a pinned member from the
 * canonical catalog breaks the membership closure and must refuse.
 */
it("L5 removed pinned member refuses", (t) => {
  const seed = 88881;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "PinProject").exit, 0);
  // Remove a pinned member from the canonical catalog AFTER spec build.
  rmSync(join(world.registries.v1.registry, "all-skills", "bmad-alpha"), {
    recursive: true,
    force: true,
  });
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(refusal.exit, 3, `seed=${seed}: removed member must refuse`);
  assert.ok(
    (refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_PIN"),
    `seed=${seed}: expected E_BMAD_SPEC_PIN, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
  );
  assert.ok(!existsSync(join(root, "_bmad")), "refusal wrote runtime anyway");
});

/** L5b spec document tampering (digest mismatch) refuses. */
it("L5b edited spec document refuses", (t) => {
  const seed = 88882;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "DocProject").exit, 0);
  const raw = JSON.parse(readFileSync(specPath, "utf8"));
  // Names-only: tamper the aggregate composition pin, not member objects.
  raw.sources.composition.packTomlSha256 = "0".repeat(64);
  writeFileSync(specPath, JSON.stringify(raw, null, 2));
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(refusal.exit, 3, `seed=${seed}: edited spec must refuse`);
});

/**
 * L5c pin integrity, CONTENT dimension: tampering a pinned member's canonical
 * SKILL.md BYTES under the same version label (while the member still exists —
 * bmad-beta in the same pack is untouched) must refuse plan AND apply with
 * E_BMAD_SPEC_PIN exit 3 before any write.
 */
it("L5c tampered canonical member bytes refuse plan and apply before any write", (t) => {
  const seed = 88883;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "ByteTamper").exit, 0);
  const skillMd = join(world.registries.v1.registry, "all-skills", "bmad-alpha", "SKILL.md");
  writeFileSync(skillMd, `${readFileSync(skillMd, "utf8")}\n# tampered bytes\n`);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = observeTree(root);
  for (const dryRun of [true, false]) {
    const refusal = planOrApply(world, "v1", root, specPath, dryRun);
    assert.equal(
      refusal.exit,
      3,
      `seed=${seed} dryRun=${dryRun}: byte tamper must refuse, got ${refusal.exit}: ${refusal.stdout}`,
    );
    assert.ok(
      (refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_PIN"),
      `seed=${seed}: expected E_BMAD_SPEC_PIN, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
    );
  }
  assert.deepEqual(
    assertSameManaged(normalized(observeTree(root)), normalized(before), "l5c"),
    [],
    "refusal wrote anyway",
  );
});

/**
 * L5d pin integrity, MODE dimension: chmod'ing a pinned member's canonical
 * support file (references/guide.md -> executable) changes no bytes but must
 * still refuse — the aggregate pin binds modes/types, not just bytes.
 */
it("L5d tampered canonical member file mode refuses", (t) => {
  const seed = 88884;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "ModeTamper").exit, 0);
  const guide = join(
    world.registries.v1.registry,
    "all-skills",
    "bmad-alpha",
    "references",
    "guide.md",
  );
  chmodSync(guide, 0o755);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = observeTree(root);
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(refusal.exit, 3, `seed=${seed}: mode tamper must refuse, got ${refusal.exit}`);
  assert.ok(
    (refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_PIN"),
    `seed=${seed}: expected E_BMAD_SPEC_PIN, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
  );
  assert.deepEqual(
    assertSameManaged(normalized(observeTree(root)), normalized(before), "l5d"),
    [],
    "refusal wrote anyway",
  );
});

/** I1 aggregate pin interface: names-only members + exact pack.toml bytes bound. */
it("I1 composition aggregate pin binds exact pack bytes with names-only members", (t) => {
  const seed = 110011;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  const build = buildSpec(world, "v1", ["claude-code"], specPath, "PinIface");
  assert.equal(build.exit, 0, build.stderr + build.stdout);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  assert.ok(
    spec.sources.members.every((member) => typeof member === "string"),
    "members must be names-only strings",
  );
  const packToml = readFileSync(
    join(world.registries.v1.registry, "packs", "bmad", world.sources.v1.version, "pack.toml"),
  );
  assert.equal(
    spec.sources.composition.packTomlSha256,
    createHash("sha256").update(packToml).digest("hex"),
    "composition pin must equal the exact current pack.toml bytes",
  );
  assert.match(spec.sources.composition.membersSha256, /^[0-9a-f]{64}$/);
  assert.equal(spec.sources.composition.packVersion, world.sources.v1.version);
  for (const inventory of spec.sources.commands)
    assert.equal(inventory.commandsPath, `commands/${inventory.client}`);
});

/** I2 tampered pack.toml bytes under the same label refuse before any write. */
it("I2 tampered pack manifest refuses read-only plan with zero writes", (t) => {
  const seed = 220022;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "Tamper").exit, 0);
  const packToml = join(
    world.registries.v1.registry,
    "packs",
    "bmad",
    world.sources.v1.version,
    "pack.toml",
  );
  writeFileSync(packToml, `${readFileSync(packToml, "utf8")}\n# tampered membership\n`);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = observeTree(root);
  const refusal = planOrApply(world, "v1", root, specPath, true);
  assert.equal(refusal.exit, 3, JSON.stringify(refusal.envelope?.findings ?? []));
  assert.ok((refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_PIN"));
  assert.deepEqual(assertSameManaged(normalized(observeTree(root)), normalized(before), "i2"), []);
});

/** I3 read-only plan on a FRESH project writes nothing anywhere (no initScope). */
it("I3 read-only plan on a fresh project writes nothing", (t) => {
  const seed = 330033;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "ReadOnly").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = planOrApply(world, "v1", root, specPath, true);
  assert.equal(plan.exit, 0, plan.stderr + plan.stdout);
  assert.equal(plan.data.applied, false);
  assert.equal(plan.data.changesWritten, 0);
  const written = Object.keys(observeTree(root).files);
  assert.deepEqual(written, [], `read-only plan wrote: ${written.join(", ")}`);
});

/** I4 malformed existing selection manifest refuses the read-only plan. */
it("I4 malformed existing manifest refuses read-only plan without writes", (t) => {
  const seed = 440044;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "Malformed").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills.json"), "{ not valid json");
  const before = observeTree(root);
  const refusal = planOrApply(world, "v1", root, specPath, true);
  assert.notEqual(refusal.exit, 0, "malformed manifest must refuse");
  assert.ok(
    (refusal.envelope?.findings ?? []).some((f) => f.code === "E_MANIFEST_PARSE"),
    `expected E_MANIFEST_PARSE, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
  );
  assert.deepEqual(assertSameManaged(normalized(observeTree(root)), normalized(before), "i4"), []);
});

/** I5 relocated runtime read path that does not exist refuses truthfully. */
it("I5 wrong runtime read path refuses with E_BMAD_SPEC_RUNTIME_MISSING", (t) => {
  const seed = 550055;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "RuntimePath").exit, 0);
  const raw = JSON.parse(readFileSync(specPath, "utf8"));
  // The digest normalizes the locator out; only the READ path is edited.
  raw.sources.runtime.path = "/nonexistent/skrill27-runtime";
  writeFileSync(specPath, JSON.stringify(raw, null, 2));
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refusal = planOrApply(world, "v1", root, specPath, true);
  assert.notEqual(refusal.exit, 0, "missing runtime root must refuse");
  assert.ok(
    (refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_RUNTIME_MISSING"),
    `expected E_BMAD_SPEC_RUNTIME_MISSING, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
  );
  assert.deepEqual(Object.keys(observeTree(root).files), [], "refusal wrote anyway");
});

/** I6 unsafe spec shapes (traversal member / command file name) refuse at parse. */
it("I6 unsafe spec fields refuse before any target write", (t) => {
  const seed = 660066;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "Unsafe").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mutate of [
    (raw) => {
      raw.sources.members = ["../evil"];
    },
    (raw) => {
      raw.sources.members[0] = { name: "bmad-alpha", digest: "x" };
    },
    (raw) => {
      raw.sources.commands[0].files[0] = { name: "../../evil", sha256: "0".repeat(64) };
    },
    (raw) => {
      delete raw.sources.composition;
    },
  ]) {
    const raw = JSON.parse(readFileSync(specPath, "utf8"));
    mutate(raw);
    const tempSpec = join(world.registries.v1.root, "spec-unsafe.json");
    writeFileSync(tempSpec, JSON.stringify(raw, null, 2));
    const refusal = planOrApply(world, "v1", root, tempSpec, true);
    assert.notEqual(refusal.exit, 0, `unsafe shape must refuse: ${JSON.stringify(mutate)}`);
    assert.ok(
      (refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_PIN"),
      `expected E_BMAD_SPEC_PIN for ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
    );
  }
  assert.deepEqual(
    Object.keys(observeTree(root).files),
    [],
    "no target writes for any unsafe shape",
  );
});

/** L6 explicit runtime: incomplete runtime source refuses with actionable error. */
it("L6 incomplete runtime source refuses before writes", (t) => {
  const seed = 60606;
  const world = materializationWorld(t, seed);
  const incomplete = sourceFixture(t, {
    version: "6.12.1-next.0",
    variant: "v1",
    completeRuntime: false,
  });
  const specPath = join(world.registries.v1.root, "spec-bad.json");
  const _build = buildSpec(world, "v1", ["claude-code"], specPath, "MissingRuntime");
  // Rebuild the spec against the incomplete runtime root.
  const rebuild = run([
    "bmad",
    "spec",
    "build",
    `bmad@${world.sources.v1.version}`,
    incomplete.root,
    "--registry-root",
    world.registries.v1.registry,
    "--client",
    "claude-code",
    "--spec-path",
    specPath,
  ]);
  assert.notEqual(rebuild.exit, 0, `seed=${seed}: incomplete runtime must not build a spec`);
  const findings = rebuild.envelope?.findings ?? [];
  assert.ok(
    findings.some((f) => f.code === "E_BMAD_SPEC_RUNTIME_MISSING"),
    `seed=${seed}: expected E_BMAD_SPEC_RUNTIME_MISSING, got ${JSON.stringify(findings)}`,
  );
});

/** L7 no ambient: polluted HOME/global manifest cannot influence output. */
it("L7 polluted global environment cannot influence materialization", (t) => {
  const seed = 70707;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "AmbientProject").exit, 0);
  const pollutedHome = realpathSync(mkdtempSync("/tmp/skrill27-home-"));
  t.after(() => rmSync(pollutedHome, { recursive: true, force: true }));
  // A global manifest selecting a DIFFERENT pack must not leak into the project.
  const globalAgents = join(pollutedHome, ".agents");
  mkdirSync(globalAgents, { recursive: true });
  writeFileSync(
    join(globalAgents, "skills.json"),
    JSON.stringify(
      {
        skills: [{ name: "unrelated-global-skill" }],
        sets: [],
        packs: [],
        exclude: [],
        inherit_global: true,
      },
      null,
      2,
    ),
  );
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apply = planOrApply(world, "v1", root, specPath, false, { HOME: pollutedHome });
  assert.equal(apply.exit, 0, `seed=${seed}: ${apply.stderr}${apply.stdout}`);
  const manifest = JSON.parse(readFileSync(join(root, ".agents", "skills.json"), "utf8"));
  assert.equal(manifest.inherit_global, false, "ambient global inheritance leaked");
  assert.deepEqual(
    manifest.packs.map((p) => p.name),
    ["bmad"],
    "polluted global pack selection leaked",
  );
  const members = readdirSync(join(root, ".agents", "skills")).filter((n) => n !== "skills.json");
  for (const member of world.sources.v1.members) {
    assert.ok(members.includes(member), `member ${member} missing`);
  }
  assert.ok(!members.includes("unrelated-global-skill"), "global-only skill leaked into project");
});

/** Cross-version distinctness: v1 and v2 specs produce different, correct outputs. */
it("distinct versions materialize distinct membership at the same root shape", (t) => {
  const seed = 515151;
  const world = materializationWorld(t, seed);
  const spec1 = join(world.registries.v1.root, "spec.json");
  const spec2 = join(world.registries.v2.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], spec1, "Proj").exit, 0);
  assert.equal(buildSpec(world, "v2", ["claude-code"], spec2, "Proj").exit, 0);
  const s1 = JSON.parse(readFileSync(spec1, "utf8"));
  const s2 = JSON.parse(readFileSync(spec2, "utf8"));
  assert.notEqual(s1.digest, s2.digest, "distinct versions must have distinct spec digests");
  assert.ok(s2.sources.members.length > s1.sources.members.length);
  const root1 = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  const root2 = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root1, { recursive: true, force: true }));
  t.after(() => rmSync(root2, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", root1, spec1, false).exit, 0);
  assert.equal(planOrApply(world, "v2", root2, spec2, false).exit, 0);
  const obs1 = normalized(observeTree(root1));
  const obs2 = normalized(observeTree(root2));
  assert.ok(obs1["_bmad/scripts/render_skill.py"] && obs2["_bmad/scripts/render_skill.py"]);
  assert.notEqual(
    obs1["_bmad/scripts/render_skill.py"].sha256,
    obs2["_bmad/scripts/render_skill.py"].sha256,
    "v1/v2 runtime bytes must differ",
  );
});

/** Different config C is NOT expected-equal: identity is explicit input. */
it("different project config yields different (correct) config.toml", (t) => {
  const seed = 202020;
  const world = materializationWorld(t, seed);
  const specA = join(world.registries.v1.root, "a.json");
  const specB = join(world.registries.v1.root, "b.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specA, "ProjectA").exit, 0);
  assert.equal(buildSpec(world, "v1", ["claude-code"], specB, "ProjectB").exit, 0);
  const rootA = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  const rootB = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(rootA, { recursive: true, force: true }));
  t.after(() => rmSync(rootB, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", rootA, specA, false).exit, 0);
  assert.equal(planOrApply(world, "v1", rootB, specB, false).exit, 0);
  const a = readFileSync(join(rootA, "_bmad", "config.toml"), "utf8");
  const b = readFileSync(join(rootB, "_bmad", "config.toml"), "utf8");
  assert.match(a, /ProjectA/);
  assert.match(b, /ProjectB/);
  assert.notEqual(a, b);
});

/**
 * R1: a foreign receipt carrying an UNKNOWN field is refused as foreign/tampered
 * content before ANY write, and the whole tree stays unchanged. Matching the body
 * shape is not enough to adopt a receipt.
 */
it("R1 unknown receipt metadata field refuses before any write", (t) => {
  const seed = 606060;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "ReceiptProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A well-formed receipt EXCEPT for one unknown metadata field.
  const foreign = {
    schema: "skillex.bmad-materialization-receipt/v1",
    specDigest: JSON.parse(readFileSync(specPath, "utf8")).digest,
    inputsDigest: "0".repeat(64),
    bmadVersion: "6.12.1-next.0",
    owned: ["_bmad/config.toml"],
    extra_metadata: { note: "foreign" },
  };
  mkdirSync(join(root, ".skillex"), { recursive: true });
  writeFileSync(
    join(root, ".skillex", "bmad-materialization.json"),
    JSON.stringify(foreign, null, 2),
  );
  const before = observeTree(root);
  for (const dryRun of [true, false]) {
    const refusal = planOrApply(world, "v1", root, specPath, dryRun);
    assert.equal(refusal.exit, 3, `dryRun=${dryRun} must refuse: ${refusal.stdout}`);
    assert.ok(
      (refusal.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
      `expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
    );
  }
  assert.deepEqual(assertSameManaged(normalized(observeTree(root)), normalized(before), "r1"), []);
});

/**
 * R2: a FOREIGN file at a desired runtime path whose bytes EXACTLY match the source
 * is still refused (ownership requires the receipt, never adoption). No outside write.
 */
it("R2 foreign matching payload refuses; no outside writes", (t) => {
  const seed = 707070;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "MatchProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Byte-identical to the pinned source support file, but NOT receipt-owned.
  const scriptDir = join(root, "_bmad", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(
    join(scriptDir, "render_skill.py"),
    readFileSync(join(world.sources.v1.root, "_bmad", "scripts", "render_skill.py")),
  );
  const outside = join(root, "docs", "outside.txt");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(outside, "unrelated foreign content\n");
  const before = observeTree(root);
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(refusal.exit, 3, `must refuse matching foreign payload: ${refusal.stdout}`);
  const after = observeTree(root);
  assert.deepEqual(assertSameManaged(normalized(after), normalized(before), "r2"), []);
  // The pre-existing unrelated foreign file is preserved untouched.
  assert.equal(readFileSync(outside, "utf8"), "unrelated foreign content\n");
});

/**
 * R3: a symlinked parent on the path to the RECEIPT refuses before any write; no
 * outside-the-project write occurs through the followed link.
 */
it("R3 symlinked receipt parent refuses with no outside writes", (t) => {
  const seed = 808080;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "SymlinkProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  const outside = realpathSync(mkdtempSync("/tmp/skrill27-outside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  // `.skillex` is a symlink to an OUTSIDE directory: following it would write outside.
  symlinkSync(outside, join(root, ".skillex"), "dir");
  const marker = join(outside, "sentinel.txt");
  writeFileSync(marker, "outside\n");
  const before = observeTree(root);
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.notEqual(refusal.exit, 0, `symlinked receipt parent must refuse: ${refusal.stdout}`);
  assert.ok(
    (refusal.envelope?.findings ?? []).some(
      (f) =>
        f.code === "E_BMAD_SPEC_COLLISION" ||
        f.code === "E_MANIFEST_UNSAFE_PATH" ||
        f.code === "E_IO",
    ),
    `expected a collision/unsafe-path finding, got ${JSON.stringify(refusal.envelope?.findings ?? [])}`,
  );
  // No outside write happened: the sentinel is the only file out there.
  assert.deepEqual(readdirSync(outside).sort(), ["sentinel.txt"], "outside dir was written");
  assert.deepEqual(assertSameManaged(normalized(observeTree(root)), normalized(before), "r3"), []);
});

/**
 * R4: deleting a receipt-OWNED runtime file (a missing artifact) is repaired by a
 * re-apply: the owned file is recreated, and the operation succeeds.
 */
it("R4 deleted owned runtime file is repaired on re-apply", (t) => {
  const seed = 909090;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "RepairProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", root, specPath, false).exit, 0);
  const owned = join(root, "_bmad", "scripts", "config_utils.py");
  rmSync(owned);
  const repair = planOrApply(world, "v1", root, specPath, false);
  assert.equal(repair.exit, 0, `repair must succeed: ${repair.stderr}${repair.stdout}`);
  assert.ok(existsSync(owned), "owned file was not repaired");
  assert.equal(
    readFileSync(owned, "utf8"),
    readFileSync(join(world.sources.v1.root, "_bmad", "scripts", "config_utils.py"), "utf8"),
    "repaired bytes differ from the pinned source",
  );
});

/**
 * R5: an authored chmod on an owned runtime file (mode dimension) refuses rather
 * than silently re-chmod'ing it back; bytes stay under the author's control.
 */
it("R5 authored chmod of owned runtime file refuses", (t) => {
  const seed = 111111;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "ChmodProject").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", root, specPath, false).exit, 0);
  const owned = join(root, "_bmad", "scripts", "resolve_config.py");
  chmodSync(owned, 0o755);
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(
    refusal.exit,
    3,
    `authored chmod must refuse, got ${refusal.exit}: ${refusal.stdout}`,
  );
  assert.equal(statSync(owned).mode & 0o777, 0o755, "authored mode was clobbered");
});

/**
 * R6: an authored edit to a receipt-owned ACTIVATION target (a member symlink under
 * .agents/skills) refuses instead of being silently repaired.
 */
it("R6 authored edit of owned activation symlink refuses", (t) => {
  const seed = 121212;
  const world = materializationWorld(t, seed);
  const specPath = join(world.registries.v1.root, "spec.json");
  assert.equal(buildSpec(world, "v1", ["claude-code"], specPath, "ActivationEdit").exit, 0);
  const root = realpathSync(mkdtempSync("/tmp/skrill27-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(planOrApply(world, "v1", root, specPath, false).exit, 0);
  const ownedLink = join(root, ".agents", "skills", "bmad-alpha");
  // Diagnostic-first (R6 nondeterministic activation-layout regression): capture the
  // ACTUAL published entry + layout/env BEFORE cleanup so a harness EISDIR is
  // diagnosable instead of losing evidence. Persisted to /tmp, never the repo.
  let entryKind = "missing";
  try {
    const st = lstatSync(ownedLink);
    entryKind = st.isSymbolicLink()
      ? `symlink->${readlinkSync(ownedLink)}`
      : st.isDirectory()
        ? "directory"
        : st.isFile()
          ? "file"
          : "other";
  } catch (e) {
    entryKind = `error:${e.code}`;
  }
  let activationLayout = "unknown";
  try {
    activationLayout = JSON.stringify(
      readdirSync(join(root, ".agents", "skills"), { withFileTypes: true }).map(
        (d) => `${d.name}:${d.isSymbolicLink() ? "link" : d.isDirectory() ? "dir" : "file"}`,
      ),
    );
  } catch {}
  const diag = {
    node: process.version,
    pid: process.pid,
    root,
    ownedLink,
    entryKind,
    activationLayout,
    env: { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME },
  };
  writeFileSync(`/tmp/skrill27-r6-diag-${process.pid}.json`, JSON.stringify(diag, null, 2));
  if (!lstatSync(ownedLink).isSymbolicLink()) {
    // Not the contract layout the test authors: surface a clear, actionable failure
    // with the persisted diagnostic rather than a raw EISDIR from rmSync.
    assert.fail(
      `R6 precondition: expected .agents/skills/bmad-alpha to be a symlink (composed member-link layout) but found ${entryKind}. activationLayout=${activationLayout} diag=/tmp/skrill27-r6-diag-${process.pid}.json`,
    );
  }
  // Node 24.6.0: rmSync WITHOUT options throws ERR_FS_EISDIR on a symlink whose
  // target is a directory path; unlinkSync removes the link itself on all
  // supported versions. Root-caused: deterministic on 24.6.0, clean on 26.5.0.
  unlinkSync(ownedLink);
  mkdirSync(ownedLink, { recursive: true });
  writeFileSync(join(ownedLink, "SKILL.md"), "# authored replacement\n");
  const refusal = planOrApply(world, "v1", root, specPath, false);
  assert.equal(refusal.exit, 3, `authored activation edit must refuse: ${refusal.stdout}`);
  assert.equal(readFileSync(join(ownedLink, "SKILL.md"), "utf8"), "# authored replacement\n");
});
