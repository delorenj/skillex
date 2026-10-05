/**
 * SKRILL-27 functional slice 1 tests (Node CLI, real spawned dist/cli.js).
 *
 * Proves canonical SUBTREE closure against an authentic-shaped next.1 source:
 *  N1 next.1-shaped fixture (skill manifest dirs + relocated rendered skills,
 *     files manifest declaring body + support children that no longer exist
 *     under _bmad/) builds a spec WITHOUT --include-observed: every declared
 *     canonical path maps to a verified catalog reference (exact member+suffix,
 *     actual kind/bytes verified against the frozen catalog), zero
 *     misclassified missing support, and plan/apply materialize the support
 *     scaffold + required metadata without any runtime canonical copies.
 *  N2 absent canonical child in the CATALOG refuses (never borrowed from a
 *     wrong name/basename).
 *  N3 canonical child byte tamper in the REGISTRY refuses under the same pack
 *     version label (aggregate pin covers children).
 *  N4 ambiguous mapping (one directory claimed by two skills) refuses.
 *  N5 declared non-pyc genuine missing support still refuses.
 *  N6 declared __pycache__/*.pyc absent everywhere is an exact bounded cache
 *     classification: never missing support, never materialized, never
 *     fabricated.
 *  N7 required metadata closure: _config/{skill-manifest,files-manifest,
 *     bmad-help}.csv classified as required metadata; a missing one refuses.
 *  N8 canonical child tamper inside a catalog member refuses a second build
 *     under the same version label (distinct from N3 for reporting).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

const VERSION = "6.12.1-next.1";

/**
 * Authentic next.1-shaped source fixture.
 *
 * Mirrors the real installer output: the files manifest declares canonical
 * bodies AND support children under `_bmad/<dir>/<skill>/...`, but the
 * installer RELOCATED the whole canonical trees into `.agents/skills/<name>`
 * (so none of the declared canonical paths exist under `_bmad/`); the frozen
 * registry holds the canonical trees.
 */
function nextSourceFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-native-src-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "_bmad", "_config");
  mkdirSync(config, { recursive: true });

  const skills = [
    {
      name: "bmad-alpha",
      module: "core",
      dir: "core/bmad-alpha",
      children: { "references/run.md": "# run\n" },
    },
    {
      name: "bmad-beta",
      module: "bmm",
      dir: "bmm/plan/bmad-beta",
      children: {
        "scripts/doit.py": "#!/usr/bin/env python3\nprint('doit')\n",
        "assets/tpl.md": "# tpl\n",
      },
    },
  ];

  // Skill manifest: paths are the OLD source paths (`_bmad/<dir>/SKILL.md`).
  writeFileSync(
    join(config, "skill-manifest.csv"),
    `${[
      "canonicalId,name,description,module,path",
      ...skills.map(
        (s) => `"${s.name}","${s.name}","${s.name} desc","${s.module}","_bmad/${s.dir}/SKILL.md"`,
      ),
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(config, "manifest.yaml"),
    `installation:\n  version: "${VERSION}"\n  installDate: "2026-10-04T00:00:00.000Z"\n  modules:\n  - name: core\n    version: "${VERSION}"\n    source: built-in\n`,
  );
  writeFileSync(
    join(config, "bmad-help.csv"),
    `${[
      "module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs",
      "core,bmad-alpha,Alpha,A,alpha help,configure,,,,false,,",
      "bmm,bmad-beta,Beta,B,beta help,configure,,,,false,,",
    ].join("\n")}\n`,
  );

  // Files manifest declares: metadata, scaffold support, canonical body +
  // children (relocated — absent under _bmad/), generated project config, and
  // a declared generated pyc cache under a canonical subtree.
  const declared = [
    "type,name,module,path,hash",
    '"yaml","manifest","_config","_config/manifest.yaml","x"',
    '"py","resolve_config","scripts","scripts/resolve_config.py","x"',
    ...skills.flatMap((s) => [
      `"md","${s.name}","${s.module}","${s.dir}/SKILL.md","x"`,
      ...Object.keys(s.children).map(
        (rel) => `"md","child","${s.module}","${s.dir}/${rel}","x"`,
      ),
    ]),
    '"toml","config","core","config.toml","x"',
    '"pyc","cache","bmm","bmm/plan/bmad-beta/scripts/__pycache__/doit.cpython-311.pyc","x"',
  ];
  writeFileSync(join(config, "files-manifest.csv"), `${declared.join("\n")}\n`);

  // Real on-disk scaffold support.
  mkdirSync(join(root, "_bmad", "scripts"), { recursive: true });
  writeFileSync(join(root, "_bmad", "scripts", "resolve_config.py"), "#!/usr/bin/env python3\n");
  chmodSync(join(root, "_bmad", "scripts", "resolve_config.py"), 0o755);

  // Rendered relocated canonical trees under .agents/skills (what freeze reads).
  for (const s of skills) {
    const rendered = join(root, ".agents", "skills", s.name);
    mkdirSync(rendered, { recursive: true });
    writeFileSync(join(rendered, "SKILL.md"), `---\nname: ${s.name}\n---\n# ${s.name}\n`);
    for (const [rel, body] of Object.entries(s.children)) {
      const abs = join(rendered, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
      if (rel.endsWith(".py")) chmodSync(abs, 0o755);
    }
  }
  writeFileSync(join(root, "_bmad", "config.toml"), '[core]\nproject_name = "SRC"\n');
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "bmad-alpha.agent.md"), "cmd\n");
  return { root, skills };
}

function registryFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-native-reg-"));
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

function buildSpec(src, reg, specPath) {
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
    ],
    { env: { ...process.env, XDG_STATE_HOME: reg.stateHome } },
  );
}

function dep(spec, path) {
  return spec.sources.runtimeDeps.find((d) => d.path === path);
}

it("N1: relocated canonical subtree classifies as verified references; spec builds without --include-observed", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const specPath = join(reg.root, "spec.json");
  const build = buildSpec(src.root, reg, specPath);
  assert.equal(build.exit, 0, JSON.stringify(build.findings, null, 1));

  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const body = dep(spec, "core/bmad-alpha/SKILL.md");
  assert.equal(body.role, "canonical-support");
  assert.equal(body.canonical, "bmad-alpha");
  assert.equal(body.reference, true);
  const child = dep(spec, "bmm/plan/bmad-beta/scripts/doit.py");
  assert.ok(child, "declared canonical child missing from runtimeDeps");
  assert.equal(child.role, "canonical-support");
  assert.equal(child.canonical, "bmad-beta");
  assert.equal(child.reference, true);
  assert.equal(child.canonicalPath, "scripts/doit.py");
  const cache = dep(spec, "bmm/plan/bmad-beta/scripts/__pycache__/doit.cpython-311.pyc");
  assert.ok(cache, "declared cache missing");
  assert.equal(cache.role, "cache");
  const missing = spec.sources.runtimeDeps.filter((d) => d.missing === true);
  assert.deepEqual(missing, [], "no dependency may be classified missing");
  const help = dep(spec, "_config/bmad-help.csv");
  assert.ok(help, "bmad-help.csv not in closure");
  assert.equal(help.role, "support");
  assert.equal(help.origin, "observed");
  assert.equal(help.metadata, true);

  // plan (no writes) then apply: support scaffold + required metadata
  // materialize; canonical references produce NO runtime copies.
  const project = realpathSync(mkdtempSync("/tmp/skrill27-native-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const planRun = run(["bmad", "plan", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(planRun.exit, 0, JSON.stringify(planRun.findings));
  const apply = run(["bmad", "apply", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(apply.exit, 0, JSON.stringify(apply.findings));
  assert.ok(existsSync(join(project, "_bmad", "scripts", "resolve_config.py")));
  assert.equal(
    lstatSync(join(project, "_bmad", "scripts", "resolve_config.py")).mode & 0o777,
    0o755,
  );
  assert.ok(existsSync(join(project, "_bmad", "_config", "bmad-help.csv")));
  assert.ok(existsSync(join(project, "_bmad", "_config", "skill-manifest.csv")));
  assert.ok(!existsSync(join(project, "_bmad", "bmm", "plan", "bmad-beta", "scripts", "doit.py")));
  assert.ok(!existsSync(join(project, "_bmad", "core", "bmad-alpha", "SKILL.md")));
});

it("N2: absent canonical child in the catalog refuses (never borrowed)", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const fm = join(src.root, "_bmad", "_config", "files-manifest.csv");
  writeFileSync(
    fm,
    `${readFileSync(fm, "utf8")}"md","child","core","core/bmad-alpha/references/ABSENT.md","x"\n`,
  );
  const build = buildSpec(src.root, reg, join(reg.root, "spec.json"));
  assert.notEqual(build.exit, 0);
  assert.ok(
    build.findings.some(
      (f) =>
        (f.code === "E_BMAD_SPEC_RUNTIME_REFUSE" || f.code === "E_BMAD_SPEC_RUNTIME_MISSING") &&
        /ABSENT\.md/.test(`${f.message}${(f.detail ?? []).join(" ")}`),
    ),
    JSON.stringify(build.findings, null, 1),
  );
});

it("N3: canonical child byte tamper in the registry refuses under the same label", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const first = buildSpec(src.root, reg, join(reg.root, "spec-a.json"));
  assert.equal(first.exit, 0, JSON.stringify(first.findings));
  const child = join(reg.registry, "all-skills", "bmad-beta", "scripts", "doit.py");
  writeFileSync(child, "#!/usr/bin/env python3\nprint('tampered')\n");
  const second = buildSpec(src.root, reg, join(reg.root, "spec-b.json"));
  assert.notEqual(second.exit, 0, "same version label with tampered catalog must refuse");
});

it("N4: ambiguous mapping (one directory claimed by two skills) refuses", (t) => {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-native-src-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "_bmad", "_config");
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "skill-manifest.csv"),
    `${[
      "canonicalId,name,description,module,path",
      '"bmad-alpha","bmad-alpha","a","core","_bmad/core/shared/SKILL.md"',
      '"bmad-beta","bmad-beta","b","core","_bmad/core/shared/SKILL.md"',
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(config, "manifest.yaml"),
    `installation:\n  version: "${VERSION}"\n  installDate: "2026-10-04T00:00:00.000Z"\n  modules:\n  - name: core\n    version: "${VERSION}"\n    source: built-in\n`,
  );
  writeFileSync(
    join(config, "bmad-help.csv"),
    "module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs\n",
  );
  writeFileSync(
    join(config, "files-manifest.csv"),
    `${[
      "type,name,module,path,hash",
      '"yaml","manifest","_config","_config/manifest.yaml","x"',
      '"md","shared","core","core/shared/SKILL.md","x"',
    ].join("\n")}\n`,
  );
  for (const name of ["bmad-alpha", "bmad-beta"]) {
    const rendered = join(root, ".agents", "skills", name);
    mkdirSync(rendered, { recursive: true });
    writeFileSync(join(rendered, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  writeFileSync(join(root, "_bmad", "config.toml"), '[core]\nproject_name = "SRC"\n');
  const reg = registryFixture(t);
  freeze(t, root, reg);
  const build = buildSpec(root, reg, join(reg.root, "spec.json"));
  assert.notEqual(build.exit, 0);
  assert.ok(
    build.findings.some((f) => f.code === "E_BMAD_SPEC_MANIFEST"),
    JSON.stringify(build.findings, null, 1),
  );
});

it("N5: genuine missing non-pyc support still refuses", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const fm = join(src.root, "_bmad", "_config", "files-manifest.csv");
  writeFileSync(
    fm,
    `${readFileSync(fm, "utf8")}"md","realgap","bmm","bmm/plan/REAL-GAP.md","x"\n`,
  );
  const build = buildSpec(src.root, reg, join(reg.root, "spec.json"));
  assert.notEqual(build.exit, 0);
  assert.ok(
    build.findings.some(
      (f) => f.code === "E_BMAD_SPEC_RUNTIME_MISSING" && /REAL-GAP\.md/.test(f.message),
    ),
    JSON.stringify(build.findings),
  );
});

it("N6: declared pyc absent everywhere classifies as bounded cache, never materialized", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const specPath = join(reg.root, "spec.json");
  assert.equal(buildSpec(src.root, reg, specPath).exit, 0);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const cache = dep(spec, "bmm/plan/bmad-beta/scripts/__pycache__/doit.cpython-311.pyc");
  assert.equal(cache.role, "cache");
  assert.equal(cache.origin, "declared");
  assert.ok(!cache.missing);
  const project = realpathSync(mkdtempSync("/tmp/skrill27-native-proj-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const apply = run(["bmad", "apply", project, specPath, "--registry-root", reg.registry], {
    env: { ...process.env, XDG_STATE_HOME: reg.stateHome },
  });
  assert.equal(apply.exit, 0, JSON.stringify(apply.findings));
  assert.ok(
    !existsSync(
      join(
        project,
        "_bmad",
        "bmm",
        "plan",
        "bmad-beta",
        "scripts",
        "__pycache__",
        "doit.cpython-311.pyc",
      ),
    ),
  );
});

it("N7: required metadata closure — a missing real metadata file refuses", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  rmSync(join(src.root, "_bmad", "_config", "bmad-help.csv"));
  const build = buildSpec(src.root, reg, join(reg.root, "spec.json"));
  assert.notEqual(build.exit, 0);
  assert.ok(
    build.findings.some(
      (f) => f.code === "E_BMAD_SPEC_RUNTIME_MISSING" && /bmad-help\.csv/.test(f.message),
    ),
    JSON.stringify(build.findings, null, 1),
  );
});

it("N8: child tamper inside a catalog member refuses a second build under the same label", (t) => {
  const src = nextSourceFixture(t);
  const reg = registryFixture(t);
  freeze(t, src.root, reg);
  const a = buildSpec(src.root, reg, join(reg.root, "s1.json"));
  assert.equal(a.exit, 0, JSON.stringify(a.findings));
  const child = join(reg.registry, "all-skills", "bmad-alpha", "references", "run.md");
  writeFileSync(child, "# tampered\n");
  const b = buildSpec(src.root, reg, join(reg.root, "s2.json"));
  assert.notEqual(b.exit, 0);
});
