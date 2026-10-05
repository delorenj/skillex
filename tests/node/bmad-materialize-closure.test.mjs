/**
 * SKRILL-27 runtime-closure tests (Node CLI, real spawned dist/cli.js).
 *
 * Proves the validated declared-closure contract:
 *  C1 valid fixture with module assets OUTSIDE the legacy 3 roots materializes
 *     with exact bytes/modes (oracle compares against the real source files).
 *  C2 a declared canonical SKILL path maps to a catalog REFERENCE: no runtime
 *     copy exists; activation links the canonical catalog member.
 *  C3 incomplete genuine runtime support refuses spec build AND plan/apply with
 *     explicit missing counts; zero target writes.
 *  C4 malformed/traversal/duplicate manifest rows refuse spec build loudly.
 *  C5 chmod of an owned materialized directory refuses under the same pin.
 *  C6 a canonical path observed but unmapped to pack membership refuses with an
 *     actionable listing (never a "prune the manifest" demand).
 *  C7 observed non-canonical extras are NOT materialized under the default
 *     `declared` policy, and ARE under explicit `--include-observed-runtime`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

const CLI = join(
  new URL(".", import.meta.url).pathname.replace(/\/$/, ""),
  "..",
  "..",
  "dist",
  "cli.js",
);

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
    findings: parsed?.findings ?? [],
  };
}

const VERSION = "6.12.1-next.0";

/** Minimal BMAD source with a COMPLETE, valid declared closure. */
function sourceFixture(t, { version = VERSION, extra = {}, skipSupport = [] } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-closure-src-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "_bmad", "_config");
  mkdirSync(config, { recursive: true });
  const skills = [
    { name: "bmad-alpha", module: "core" },
    { name: "bmad-beta", module: "bmm" },
  ];
  writeFileSync(
    join(config, "skill-manifest.csv"),
    `${[
      "canonicalId,name,description,module,path",
      ...skills.map(
        (s) =>
          `"${s.name}","${s.name}","${s.name} desc","${s.module}","_bmad/${s.module}/${s.name}/SKILL.md"`,
      ),
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(config, "manifest.yaml"),
    `installation:\n  version: "${version}"\n  installDate: "2026-02-06T07:38:12.789Z"\n  modules:\n  - name: core\n    version: "${version}"\n    source: built-in\n`,
  );
  const declared = [
    "type,name,module,path,hash",
    '"yaml","manifest","_config","_config/manifest.yaml","abc"',
    '"yaml","skills","_config","_config/skill-manifest.csv","abc"',
    '"py","resolve_config","scripts","scripts/resolve_config.py","abc"',
    // Canonical body locations (reference-mapped, never copied):
    ...skills.map((s) => `"md","${s.name}","${s.module}","${s.module}/${s.name}/SKILL.md","abc"`),
    // Genuine support assets OUTSIDE the legacy hardcoded scripts/_config/core:
    '"md","prd-template","bmm","bmm/plan/bmad-prd/assets/prd-template.md","abc"',
    '"md","workflow-doc","bmb","bmb/workflows/foo.md","abc"',
    ...(extra.declaredRows ?? []),
  ];
  writeFileSync(join(config, "files-manifest.csv"), `${declared.join("\n")}\n`);
  for (const s of skills) {
    const rendered = join(root, ".agents", "skills", s.name);
    mkdirSync(rendered, { recursive: true });
    writeFileSync(join(rendered, "SKILL.md"), `---\nname: ${s.name}\n---\n# ${s.name}\n`);
    const body = join(root, "_bmad", s.module, s.name);
    mkdirSync(body, { recursive: true });
    writeFileSync(join(body, "SKILL.md"), `canonical body ${s.name}\n`);
  }
  const support = {
    "scripts/resolve_config.py": "#!/usr/bin/env python3\nprint('cfg')\n",
    "bmm/plan/bmad-prd/assets/prd-template.md": "# PRD template\n",
    "bmb/workflows/foo.md": "# workflow foo\n",
    ...(extra.supportFiles ?? {}),
  };
  for (const [rel, body] of Object.entries(support)) {
    if (skipSupport.includes(rel)) continue;
    const abs = join(root, "_bmad", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    if (rel.endsWith(".py")) chmodSync(abs, 0o755);
  }
  // Observed extra (never declared) — a genuine support extra.
  const observed = join(root, "_bmad", "custom", "notes.md");
  mkdirSync(join(observed, ".."), { recursive: true });
  writeFileSync(observed, "observed extra\n");
  writeFileSync(join(root, "_bmad", "config.toml"), '[core]\nproject_name = "SOURCE-IDENTITY"\n');
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "bmad-alpha.agent.md"), "cmd\n");
  return { root, skills };
}

function registryFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-closure-reg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  return { root, registry, stateHome: join(root, "state") };
}

function freeze(_t, src, reg) {
  const r = run(["bmad", "freeze", src, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(r.exit, 0, `freeze: ${r.stderr}${r.stdout}`);
}

function buildSpec(src, reg, specPath, extraArgs = []) {
  return run(
    [
      "bmad",
      "spec",
      "build",
      `bmad@${VERSION}`,
      src,
      "--registry-root",
      reg.registry,
      "--client",
      "claude-code",
      "--spec-path",
      specPath,
      ...extraArgs,
    ],
    { env: { ...process.env, XDG_STATE_HOME: reg.stateHome } },
  );
}

function plan(reg, project, specPath) {
  return run(["bmad", "plan", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
}

it("C1+C2: complete declared closure outside the 3 roots materializes exact bytes/modes; canonical paths are references only", (t) => {
  const src = sourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const specPath = join(reg.root, "spec.json");
  const build = buildSpec(src.root, reg, specPath);
  assert.equal(build.exit, 0, JSON.stringify(build.findings));
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const alpha = spec.sources.runtimeDeps.find((d) => d.path === "core/bmad-alpha/SKILL.md");
  assert.equal(alpha.role, "canonical-support");
  assert.equal(alpha.canonical, "bmad-alpha");
  assert.equal(alpha.reference, true);
  assert.ok(!alpha.digest, "canonical reference carries no runtime payload digest");

  const project = realpathSync(mkdtempSync("/tmp/skrill27-closure-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const apply = run(["bmad", "apply", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(apply.exit, 0, JSON.stringify(apply.findings));

  // Oracle: exact bytes and modes from the REAL source files.
  for (const rel of [
    "scripts/resolve_config.py",
    "bmm/plan/bmad-prd/assets/prd-template.md",
    "bmb/workflows/foo.md",
  ]) {
    const got = join(project, "_bmad", rel);
    assert.ok(existsSync(got), `missing ${rel}`);
    const expected = readFileSync(join(src.root, "_bmad", rel));
    assert.deepEqual(readFileSync(got), expected, `bytes differ: ${rel}`);
    assert.equal(
      statSync(got).mode & 0o777,
      statSync(join(src.root, "_bmad", rel)).mode & 0o777,
      `mode differs: ${rel}`,
    );
  }
  // The canonical body is a REFERENCE: no runtime copy, catalog-linked activation.
  assert.ok(
    !existsSync(join(project, "_bmad", "core", "bmad-alpha", "SKILL.md")),
    "canonical body copied into runtime",
  );
  const link = join(project, ".agents", "skills", "bmad-alpha");
  assert.ok(lstatSync(link).isSymbolicLink(), "activation is a symlink");
  assert.ok(readlinkSync(link).includes("all-skills"), "activation links the canonical catalog");
});

it("C3: incomplete genuine runtime support refuses build and plan/apply with explicit counts and zero writes", (t) => {
  const src = sourceFixture(t, { skipSupport: ["bmb/workflows/foo.md"] });
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const specPath = join(reg.root, "spec.json");
  const build = buildSpec(src.root, reg, specPath);
  assert.notEqual(build.exit, 0);
  const finding = build.findings.find((f) => f.code === "E_BMAD_SPEC_RUNTIME_MISSING");
  assert.ok(finding, `expected E_BMAD_SPEC_RUNTIME_MISSING, got ${JSON.stringify(build.findings)}`);
  assert.match(finding.message, /1 declared support path/);
  assert.match(finding.detail.join(" "), /bmb\/workflows\/foo\.md/);
  assert.ok(!existsSync(specPath), "no spec written on incomplete closure");
  // No fabricated spec => nothing to plan/apply; a project stays untouched.
  const project = realpathSync(mkdtempSync("/tmp/skrill27-closure-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  assert.deepEqual(readdirSyncSafe(project), [], "no target writes");
});

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

it("C4: malformed/traversal/duplicate manifest rows refuse spec build loudly", (t) => {
  const cases = [
    {
      name: "bad files-manifest header",
      mutate: (root) =>
        writeFileSync(join(root, "_bmad", "_config", "files-manifest.csv"), "wrong,header\n"),
      code: "E_BMAD_SPEC_MANIFEST",
    },
    {
      name: "traversing files-manifest path",
      mutate: (root) => {
        const p = join(root, "_bmad", "_config", "files-manifest.csv");
        writeFileSync(p, `${readFileSync(p, "utf8")}"md","evil","core","../../escape.md","abc"\n`);
      },
      code: "E_BMAD_SPEC_MANIFEST",
    },
    {
      name: "duplicate files-manifest path",
      mutate: (root) => {
        const p = join(root, "_bmad", "_config", "files-manifest.csv");
        writeFileSync(
          p,
          `${readFileSync(p, "utf8")}"md","dup","scripts","scripts/resolve_config.py","abc"\n`,
        );
      },
      code: "E_BMAD_SPEC_MANIFEST",
    },
    {
      name: "short files-manifest row",
      mutate: (root) => {
        const p = join(root, "_bmad", "_config", "files-manifest.csv");
        writeFileSync(p, `${readFileSync(p, "utf8")}"md","only-three","core"\n`);
      },
      code: "E_BMAD_SPEC_MANIFEST",
    },
  ];
  for (const { name, mutate, code } of cases) {
    const src = sourceFixture(t);
    mutate(src.root);
    const reg = registryFixture(t);
    freeze(t, src.root, reg);
    const build = buildSpec(src.root, reg, join(reg.root, "spec.json"));
    assert.notEqual(build.exit, 0, `${name}: expected refusal`);
    assert.ok(
      build.findings.some((f) => f.code === code),
      `${name}: expected ${code}, got ${JSON.stringify(build.findings)}`,
    );
  }
});

it("C5: chmod of an owned materialized directory refuses under the same pin", (t) => {
  const src = sourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const specPath = join(reg.root, "spec.json");
  assert.equal(buildSpec(src.root, reg, specPath).exit, 0);
  const project = realpathSync(mkdtempSync("/tmp/skrill27-closure-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const apply = run(["bmad", "apply", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(apply.exit, 0, JSON.stringify(apply.findings));
  const dir = join(project, "_bmad", "bmm", "plan", "bmad-prd", "assets");
  chmodSync(dir, 0o700);
  const again = plan(reg, project, specPath);
  assert.equal(again.exit, 3, "authored chmod of owned dir must refuse");
  assert.ok(
    again.findings.some(
      (f) =>
        f.code === "E_BMAD_SPEC_COLLISION" &&
        (f.detail ?? []).some((d) => /owned directory/.test(d)),
    ),
    JSON.stringify(again.findings),
  );
});

it("C6: canonical path unmapped to pack membership refuses with an actionable listing", (t) => {
  // Freeze a pack from source A (membership: alpha, beta), then attempt a spec
  // against source B whose skill manifest additionally claims bmad-orphan at a
  // canonical path — an unknown/ambiguous mapping the spec must refuse.
  const srcA = sourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, srcA.root, reg);
  const srcB = sourceFixture(t);
  const sm = join(srcB.root, "_bmad", "_config", "skill-manifest.csv");
  writeFileSync(
    sm,
    `${readFileSync(sm, "utf8")}"bmad-orphan","bmad-orphan","orphan","core","_bmad/core/bmad-orphan/SKILL.md"\n`,
  );
  const orphanDir = join(srcB.root, "_bmad", "core", "bmad-orphan");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, "SKILL.md"), "orphan body\n");
  const build = buildSpec(srcB.root, reg, join(reg.root, "spec.json"));
  assert.notEqual(build.exit, 0);
  const finding = build.findings.find((f) => f.code === "E_BMAD_SPEC_RUNTIME_REFUSE");
  assert.ok(finding, JSON.stringify(build.findings));
  assert.match(finding.message, /bmad-orphan/);
  assert.doesNotMatch(
    finding.fix,
    /prune/i,
    "must never tell the user to prune the authoritative manifest",
  );
});

it("C7: observed extras excluded by default, included only under explicit policy", (t) => {
  const src = sourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const specPath = join(reg.root, "spec.json");
  assert.equal(buildSpec(src.root, reg, specPath).exit, 0);
  const project = realpathSync(mkdtempSync("/tmp/skrill27-closure-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const apply = run(["bmad", "apply", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(apply.exit, 0, JSON.stringify(apply.findings));
  assert.ok(
    !existsSync(join(project, "_bmad", "custom", "notes.md")),
    "observed extra must not materialize under default policy",
  );

  const specPath2 = join(reg.root, "spec-include.json");
  const build2 = buildSpec(src.root, reg, specPath2, ["--include-observed-runtime"]);
  assert.equal(build2.exit, 0, JSON.stringify(build2.findings));
  const spec2 = JSON.parse(readFileSync(specPath2, "utf8"));
  assert.equal(spec2.sources.runtimeExtraPolicy, "include");
  const project2 = realpathSync(mkdtempSync("/tmp/skrill27-closure-proj-"));
  t.after(() => rmSync(project2, { recursive: true, force: true }));
  const apply2 = run(["bmad", "apply", project2, specPath2, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(apply2.exit, 0, JSON.stringify(apply2.findings));
  assert.deepEqual(
    readFileSync(join(project2, "_bmad", "custom", "notes.md")),
    readFileSync(join(src.root, "_bmad", "custom", "notes.md")),
  );
});
