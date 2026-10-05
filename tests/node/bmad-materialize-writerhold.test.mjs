/**
 * SKRILL-27 writer-hold regressions: F1 publication race, F2 partial-failure
 * recovery, F3 authored-selection preservation.
 *
 * These tests exercise the BUILT CLI (dist/cli.js) as a real spawned process,
 * with deterministic EIO/race injection via NODE_OPTIONS CJS preloads that
 * intercept the CLI's own `node:fs/promises` ESM imports (the interception
 * mechanism the independent reviewer proved works). All fixtures live under
 * /tmp; the repo is never mutated by a test.
 *
 * Contracts asserted (independent reproduction of the review's findings):
 *  F1: a foreign file planted in the lstat->publish gap of the SAME iteration
 *      is never clobbered; the apply refuses with foreign bytes intact.
 *  F2: an EIO mid-apply leaves a pending journal; the envelope carries truthful
 *      partial data (not null); a clean retry recovers (exit 0); a foreign file
 *      planted at a not-yet-published path between attempts still refuses.
 *  F3: an existing authored manifest (foreign optional pack / inherit_global:true
 *      / different registry pointer) refuses BEFORE any write, identically for
 *      dry-run and apply, with the whole tree (manifest bytes included) untouched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
  failAtOpenPreload,
  plantForeignOnOpenPathPreload,
  tamperSourceAtOpenPreload,
} from "./bmad-materialize-faults.helper.mjs";

const CLI = join(
  new URL(".", import.meta.url).pathname.replace(/\/$/, ""),
  "..",
  "..",
  "dist",
  "cli.js",
);
const RECEIPT_REL = join(".skillex", "bmad-materialization.json");
const JOURNAL_REL = join(".skillex", "bmad-materialization.pending.json");

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

/** Minimal BMAD-enabled source fixture (v1 shape). */
function sourceFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-fault-src-"));
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
          `"${s.name}","${s.name}","${s.name} v1","${s.module}","_bmad/${s.module}/${s.name}/SKILL.md"`,
      ),
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(config, "manifest.yaml"),
    `${[
      "installation:",
      '  version: "6.12.1-next.0"',
      '  installDate: "2026-02-06T07:38:12.789Z"',
      '  lastUpdated: "2026-09-20T06:04:31.608Z"',
      "modules:",
      "  - name: core",
      '    version: "6.12.1-next.0"',
      "    source: built-in",
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(config, "files-manifest.csv"),
    `${[
      "type,name,module,path,hash",
      '"yaml","manifest","_config","_config/manifest.yaml","abc"',
      '"yaml","skills","_config","_config/skill-manifest.csv","abc"',
      '"py","resolve_config","scripts","scripts/resolve_config.py","abc"',
      '"py","render_skill","scripts","scripts/render_skill.py","abc"',
      '"md","workflow","core","core/workflow.md","abc"',
    ].join("\n")}\n`,
  );
  for (const s of skills) {
    const p = join(root, ".agents", "skills", s.name);
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "SKILL.md"),
      `---\nname: ${s.name}\ndescription: ${s.name} v1\n---\n\n# ${s.name}\nUses {project-root}/_bmad/scripts/resolve_config.py\n`,
    );
  }
  const scripts = join(root, "_bmad", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const n of ["resolve_config.py", "render_skill.py"])
    writeFileSync(join(scripts, n), `#!/usr/bin/env python3\n# v1 ${n}\n`);
  mkdirSync(join(root, "_bmad", "core"), { recursive: true });
  writeFileSync(join(root, "_bmad", "core", "workflow.md"), "core workflow v1\n");
  writeFileSync(
    join(root, "_bmad", "config.toml"),
    '# installer-managed v1\n[core]\nproject_name = "SOURCE-IDENTITY"\n',
  );
  const claude = join(root, ".claude", "commands");
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    join(claude, "bmad-alpha.agent.md"),
    "---\nname: alpha\n---\nLOAD {project-root}/_bmad/core/workflow.md\n",
  );
  return { root, members: skills.map((s) => s.name) };
}

/** Freeze + spec build through the real CLI; returns the spec path. */
function buildWorld(t) {
  const src = sourceFixture(t);
  const regRoot = realpathSync(mkdtempSync("/tmp/skrill27-fault-reg-"));
  t.after(() => rmSync(regRoot, { recursive: true, force: true }));
  const registry = join(regRoot, "registry");
  const stateHome = join(regRoot, "state");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  const freeze = run(["bmad", "freeze", src.root, "--registry-root", registry], {
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });
  assert.equal(freeze.exit, 0, freeze.stderr + freeze.stdout);
  const specPath = join(regRoot, "spec.json");
  const spec = run(
    [
      "bmad",
      "spec",
      "build",
      "bmad@6.12.1-next.0",
      src.root,
      "--registry-root",
      registry,
      "--client",
      "claude-code",
      "--spec-path",
      specPath,
    ],
    { env: { ...process.env, HOME: src.root } },
  );
  assert.equal(spec.exit, 0, spec.stderr + spec.stdout);
  return { src, regRoot, registry, stateHome, specPath };
}

function applyEnv(world, _projectRoot, extra = {}) {
  return {
    env: {
      ...process.env,
      HOME: world.regRoot,
      XDG_STATE_HOME: world.stateHome,
      ...extra,
    },
  };
}

function applyCmd(world, projectRoot, extraEnv = {}) {
  return run(
    ["bmad", "apply", projectRoot, world.specPath, "--registry-root", world.registry],
    applyEnv(world, projectRoot, extraEnv),
  );
}

function planCmd(world, projectRoot, extraEnv = {}) {
  return run(
    ["bmad", "plan", projectRoot, world.specPath, "--registry-root", world.registry],
    applyEnv(world, projectRoot, extraEnv),
  );
}

function projectFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skrill27-fault-proj-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function listAllFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// F1: publication race — foreign file planted in the same-iteration gap.
// ---------------------------------------------------------------------------
it("F1: foreign file planted in the lstat->publish gap is never clobbered", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  const victimRel = join("_bmad", "scripts", "render_skill.py");
  const victim = join(project, victimRel);
  // Plant when the config.toml data publish opens: preflight already verified
  // the whole tree absent, so the victim's own iteration is still coming — this
  // is the same-iteration TOCTOU gap the review proved clobbers with plain
  // copyFile/writeFile. Exclusive create (O_EXCL) must refuse, bytes intact.
  const foreignBytes = "FOREIGN-USER-DATA\n";
  const env = plantForeignOnOpenPathPreload(
    project,
    join("_bmad", "config.toml"),
    victim,
    foreignBytes,
  );
  const apply = applyCmd(world, project, env);
  assert.notEqual(
    apply.exit,
    0,
    `planted foreign content must refuse, got exit 0: ${apply.stdout}`,
  );
  assert.ok(existsSync(victim), "planted foreign file must still exist after the refusal");
  assert.equal(
    readFileSync(victim, "utf8"),
    foreignBytes,
    "foreign bytes were clobbered by the apply",
  );
  assert.ok(
    (apply.envelope?.findings ?? []).some(
      (f) => f.code === "E_IO" || f.code === "E_BMAD_SPEC_COLLISION",
    ),
    `expected E_IO/E_BMAD_SPEC_COLLISION, got ${JSON.stringify(apply.envelope?.findings ?? [])}`,
  );
});

it("F1b: pinned source bytes are published even if the source tree is tampered mid-apply", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  const victimSrc = join(world.src.root, "_bmad", "scripts", "render_skill.py");
  const pinnedBytes = readFileSync(victimSrc, "utf8");
  // The tamper fires on the FIRST apply-stage open EXCLUDING opens under the
  // source tree (in-apply digest re-verification reads those before any data
  // publish) and excluding lock-file opens in the state home (the catalog lock
  // ticket happens before applyRuntime). That lands the tamper after runtime
  // verification, immediately before the first pinned-byte publication —
  // proving the published bytes are the preflight-pinned ones, not a re-read.
  const tampered = tamperSourceAtOpenPreload(
    project,
    1,
    [world.src.root, world.stateHome],
    victimSrc,
    "TAMPERED-SOURCE-BYTES\n",
  );
  const apply = applyCmd(world, project, tampered);
  assert.equal(apply.exit, 0, apply.stderr + apply.stdout);
  const published = readFileSync(join(project, "_bmad", "scripts", "render_skill.py"), "utf8");
  assert.equal(published, pinnedBytes, "tampered source bytes leaked into the published file");
});

// ---------------------------------------------------------------------------
// F2: partial failure — truthful evidence and clean recovery.
// ---------------------------------------------------------------------------
it("F2: mid-apply EIO leaves a pending journal, truthful partial data, and recovers cleanly", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  // In this fixture's deterministic open order, the runtime publishes are:
  // #1 lock ticket, #2 lock ticket, #3 journal header, #4 _bmad dir (chmod),
  // #5 _bmad/_config dir, #6 _bmad/scripts dir, #7 _bmad/core dir,
  // #8 _bmad/config.toml, #9 _bmad/core/workflow.md,
  // #10 _bmad/scripts/resolve_config.py, #11 _bmad/scripts/render_skill.py.
  // Failing #10 leaves four dirs + two files actually published (truthful
  // partial), with the journal recording exactly those publications.
  const failEnv = failAtOpenPreload(project, 10);
  const failed = applyCmd(world, project, failEnv);
  assert.notEqual(failed.exit, 0, `injected EIO must fail the apply: ${failed.stdout}`);
  assert.ok(failed.data, "partial evidence must be truthful (data, not null)");
  assert.ok(
    failed.data.changesWritten >= 4,
    "partial changesWritten must count the actual publications so far",
  );
  assert.ok(existsSync(join(project, JOURNAL_REL)), "pending journal must survive the failure");
  assert.ok(
    !existsSync(join(project, RECEIPT_REL)),
    "receipt must not exist before the full validated publication",
  );
  assert.ok(
    (failed.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_PARTIAL"),
    `expected E_BMAD_SPEC_PARTIAL, got ${JSON.stringify(failed.envelope?.findings ?? [])}`,
  );
  // Clean retry (no fault injection): adopts journaled bytes and completes.
  const retry = applyCmd(world, project);
  assert.equal(retry.exit, 0, `retry must recover: ${retry.stderr}${retry.stdout}`);
  assert.ok(!existsSync(join(project, JOURNAL_REL)), "pending journal must be removed on success");
  assert.ok(existsSync(join(project, RECEIPT_REL)), "receipt must exist after recovery");
  const again = applyCmd(world, project);
  assert.equal(
    again.exit,
    0,
    `repeat apply after recovery must be a no-op: ${again.stderr}${again.stdout}`,
  );
  assert.equal(again.data.changesWritten, 0, "repeat apply after recovery must write nothing");
});

it("F2b: a foreign file planted at a not-yet-published path between attempts still refuses", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  const failEnv = failAtOpenPreload(project, 10);
  const failed = applyCmd(world, project, failEnv);
  assert.notEqual(failed.exit, 0);
  assert.ok(
    existsSync(join(project, JOURNAL_REL)),
    "journal must exist after the interrupted apply",
  );
  // Foreign content at a path the journal does NOT claim (published later).
  const pendingRel = join("_bmad", "scripts", "render_skill.py");
  const pending = join(project, pendingRel);
  mkdirSync(join(project, "_bmad", "scripts"), { recursive: true });
  writeFileSync(pending, "FOREIGN-USER-DATA\n");
  const retry = applyCmd(world, project);
  assert.notEqual(
    retry.exit,
    0,
    `retry must refuse the planted foreign path, got exit 0: ${retry.stdout}`,
  );
  assert.ok(
    (retry.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
    `expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(retry.envelope?.findings ?? [])}`,
  );
  assert.equal(
    readFileSync(pending, "utf8"),
    "FOREIGN-USER-DATA\n",
    "foreign bytes were clobbered on retry",
  );
});

it("F2c: an authored edit to a journaled file between attempts refuses", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  // open#9 = the second published file (config.toml is #8); both are journaled.
  const failEnv = failAtOpenPreload(project, 10);
  assert.notEqual(applyCmd(world, project, failEnv).exit, 0);
  assert.ok(existsSync(join(project, JOURNAL_REL)));
  // A journaled runtime file from the interrupted attempt: authored edit.
  const firstPublished = join(project, "_bmad", "config.toml");
  assert.ok(existsSync(firstPublished), "expected the journaled runtime file to exist");
  writeFileSync(firstPublished, "# authored edit between attempts\n");
  const retry = applyCmd(world, project);
  assert.notEqual(
    retry.exit,
    0,
    `retry must refuse the authored edit, got exit 0: ${retry.stdout}`,
  );
  assert.ok(
    (retry.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
    `expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(retry.envelope?.findings ?? [])}`,
  );
});

it("F2d: a receipt-write EIO after full runtime publication leaves a recoverable journal", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  // Count runtime file nodes: config.toml + support files + journal handle opens.
  // Fail late (the receipt write is one of the last opens) — open#40 is safely
  // past all data publishes in this fixture shape but before/at the receipt.
  const failEnv = failAtOpenPreload(project, 40);
  const failed = applyCmd(world, project, failEnv);
  // Either the receipt write faulted (recoverable via journal) or the apply
  // completed; both are acceptable — but if it failed, the journal must remain.
  if (failed.exit !== 0) {
    assert.ok(failed.data, "partial evidence must be present");
    assert.ok(
      existsSync(join(project, JOURNAL_REL)),
      "journal must survive a receipt-stage failure",
    );
    const retry = applyCmd(world, project);
    assert.equal(
      retry.exit,
      0,
      `retry after receipt-stage failure must recover: ${retry.stderr}${retry.stdout}`,
    );
  }
});

// ---------------------------------------------------------------------------
// F3: authored selection preservation — refuse before any write.
// ---------------------------------------------------------------------------
function authoredManifest(world, project, mutate) {
  mkdirSync(join(project, ".agents"), { recursive: true });
  const base = {
    inherit_global: false,
    registry: world.registry,
    skills: [],
    sets: [],
    packs: [{ name: "bmad", version: "6.12.1-next.0", optional: false }],
    exclude: [],
  };
  mutate(base);
  writeFileSync(join(project, ".agents", "skills.json"), `${JSON.stringify(base, null, 2)}\n`);
}

it("F3a: declared-but-not-installed optional foreign pack refuses, dry and apply, tree unchanged", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  authoredManifest(world, project, (m) => {
    m.inherit_global = false;
    m.packs = [{ name: "team-standards", version: "2.1.0", optional: true }];
  });
  const manifestBytesBefore = readFileSync(join(project, ".agents", "skills.json"), "utf8");
  const filesBefore = listAllFiles(project).map((p) => [p, readFileSync(p, "utf8")]);
  const dry = planCmd(world, project);
  assert.equal(dry.exit, 3, `dry-run must refuse the authored foreign pack: ${dry.stdout}`);
  const apply = applyCmd(world, project);
  assert.equal(apply.exit, 3, `apply must refuse the authored foreign pack: ${apply.stdout}`);
  for (const r of [dry, apply]) {
    assert.ok(
      (r.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
      `expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(r.envelope?.findings ?? [])}`,
    );
  }
  assert.equal(
    readFileSync(join(project, ".agents", "skills.json"), "utf8"),
    manifestBytesBefore,
    "manifest bytes changed despite the refusal",
  );
  assert.deepEqual(
    listAllFiles(project).map((p) => [p, readFileSync(p, "utf8")]),
    filesBefore,
    "tree changed despite the refusal",
  );
});

it("F3b: authored inherit_global=true refuses and is never silently flipped", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  authoredManifest(world, project, (m) => {
    m.inherit_global = true;
  });
  const manifestBytesBefore = readFileSync(join(project, ".agents", "skills.json"), "utf8");
  const dry = planCmd(world, project);
  assert.equal(dry.exit, 3, `dry-run must refuse authored inherit_global=true: ${dry.stdout}`);
  const apply = applyCmd(world, project);
  assert.equal(apply.exit, 3, `apply must refuse authored inherit_global=true: ${apply.stdout}`);
  assert.equal(readFileSync(join(project, ".agents", "skills.json"), "utf8"), manifestBytesBefore);
  assert.ok(!existsSync(join(project, "_bmad")), "refusal wrote runtime anyway");
});

it("F3c: authored registry pointer differing from the resolved registry refuses", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  authoredManifest(world, project, (m) => {
    m.registry = "/elsewhere/authored-registry";
  });
  const manifestBytesBefore = readFileSync(join(project, ".agents", "skills.json"), "utf8");
  const apply = applyCmd(world, project);
  assert.equal(apply.exit, 3, `apply must refuse the authored registry pointer: ${apply.stdout}`);
  assert.ok(
    (apply.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
    `expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(apply.envelope?.findings ?? [])}`,
  );
  assert.equal(readFileSync(join(project, ".agents", "skills.json"), "utf8"), manifestBytesBefore);
});

it("F3d: a compatible authored manifest repeats successfully with unknown metadata preserved", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  authoredManifest(world, project, (m) => {
    m.scope = "project";
    m.sets = ["team-set"];
    m.exclude = ["unrelated-skill"];
  });
  const first = applyCmd(world, project);
  assert.equal(first.exit, 0, first.stderr + first.stdout);
  const manifest = JSON.parse(readFileSync(join(project, ".agents", "skills.json"), "utf8"));
  assert.equal(manifest.scope, "project", "authored unknown metadata was not preserved");
  assert.deepEqual(manifest.sets, ["team-set"], "authored sets were not preserved");
  assert.deepEqual(manifest.exclude, ["unrelated-skill"], "authored exclude was not preserved");
  assert.equal(manifest.inherit_global, false);
  assert.equal(manifest.packs.length, 1);
  assert.equal(manifest.packs[0].name, "bmad");
  // Second apply: idempotent no-op.
  const second = applyCmd(world, project);
  assert.equal(second.exit, 0, second.stderr + second.stdout);
  assert.equal(second.data.changesWritten, 0, "second apply must be a no-op");
});

// ---------------------------------------------------------------------------
// J1: journal binds the ACTUAL published filesystem identity (dev/ino), and a
// byte-identical FOREIGN replacement at a journaled path is refused — never
// auto-owned. (Independent reviewer reproduction: same bytes/mode, different
// inode at the journaled path auto-owned and the retry exited 0.)
// ---------------------------------------------------------------------------

/** Read the pending journal (header line + one JSON record per line). */
function readJournal(project) {
  const text = readFileSync(join(project, JOURNAL_REL), "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  return { header: JSON.parse(lines[0]), records: lines.slice(1).map((l) => JSON.parse(l)) };
}

it("J1a: journal record binds the actual published dev+ino; foreign same-bytes replacement refuses", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  // config.toml is open#8 in this fixture's deterministic order (dirs #4-#7,
  // config.toml #8, workflow.md #9, resolve_config.py #10...). Failing #10 leaves
  // config.toml + workflow.md actually published and journaled.
  const victimRel = join("_bmad", "config.toml");
  const victim = join(project, victimRel);

  const failEnv = failAtOpenPreload(project, 10);
  assert.notEqual(applyCmd(world, project, failEnv).exit, 0);
  assert.ok(existsSync(join(project, JOURNAL_REL)), "pending journal must survive");

  // The published bytes are the MATERIALIZED config (generated; honoring explicit
  // project config), not the source-tree config.toml — capture the actual publication.
  const publishedBytes = readFileSync(victim, "utf8");

  // Journal records must carry the ACTUAL published filesystem identity (dev/ino).
  const { records } = readJournal(project);
  const configRec = records.find((r) => r.path === victimRel);
  assert.ok(configRec, "config.toml must be journaled");
  assert.equal(typeof configRec.dev, "string", "journal record must bind dev (string)");
  assert.equal(typeof configRec.ino, "string", "journal record must bind ino (string)");
  const liveStat = statSync(victim);
  assert.equal(
    configRec.dev,
    liveStat.dev.toString(),
    "journaled dev must match the actual publication",
  );
  assert.equal(
    configRec.ino,
    liveStat.ino.toString(),
    "journaled ino must match the actual publication",
  );

  // Keep the original published file ALIVE under an absolute name OUTSIDE the managed
  // tree (rename, not delete — this avoids inode reuse so the replacement is a
  // genuinely different identity even though its bytes+mode are identical).
  const absKeepAlive = join(
    realpathSync(join(project, "..")),
    `skrill27-keepalive-${process.pid}-${Date.now()}`,
  );
  renameSync(victim, absKeepAlive);
  t.after(() => {
    try {
      rmSync(absKeepAlive, { force: true });
    } catch {}
  });
  assert.ok(
    existsSync(absKeepAlive),
    "original published file must be kept alive outside the managed tree",
  );
  assert.ok(!existsSync(victim), "journaled path must be absent after the rename");

  // Plant a FOREIGN byte-identical + same-mode file at the journaled path (new inode).
  writeFileSync(victim, publishedBytes, { mode: 0o644 });
  const foreignStat = statSync(victim);
  assert.notEqual(foreignStat.ino.toString(), "0", "foreign replacement must exist");
  // The foreign replacement is a DIFFERENT inode than the journaled original
  // (the original is kept alive, so its inode cannot be reused here).
  assert.notEqual(
    foreignStat.ino.toString(),
    configRec.ino,
    "foreign replacement must be a different inode than the journaled original",
  );

  // Whole-tree snapshot BEFORE the retry: plan AND apply must refuse with zero writes.
  const treeBefore = listAllFiles(project).map((p) => [p, readFileSync(p, "utf8")]);
  const dry = planCmd(world, project);
  assert.equal(
    dry.exit,
    3,
    `plan must refuse the foreign replacement, got ${dry.exit}: ${dry.stdout}`,
  );
  assert.ok(
    (dry.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
    `plan: expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(dry.envelope?.findings ?? [])}`,
  );
  const retry = applyCmd(world, project);
  assert.equal(
    retry.exit,
    3,
    `apply must refuse the foreign replacement, got ${retry.exit}: ${retry.stdout}`,
  );
  assert.ok(
    (retry.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
    `apply: expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(retry.envelope?.findings ?? [])}`,
  );
  // Zero additional writes across the WHOLE tree; the foreign file is intact.
  assert.deepEqual(
    listAllFiles(project).map((p) => [p, readFileSync(p, "utf8")]),
    treeBefore,
    "whole tree changed despite the refusal",
  );
  assert.equal(readFileSync(victim, "utf8"), publishedBytes, "foreign bytes must be intact");
  assert.ok(existsSync(join(project, JOURNAL_REL)), "journal must be kept after the refusal");
  // The kept-alive original is untouched (it is the true published identity).
  assert.equal(
    readFileSync(absKeepAlive, "utf8"),
    publishedBytes,
    "original published file must be untouched",
  );
});

it("J1b: original publication kept alive elsewhere => clean retry recovers; repeat is a no-op", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  const victimRel = join("_bmad", "config.toml");
  const victim = join(project, victimRel);

  const failEnv = failAtOpenPreload(project, 10);
  assert.notEqual(applyCmd(world, project, failEnv).exit, 0);
  assert.ok(existsSync(join(project, JOURNAL_REL)));
  const publishedBytes = readFileSync(victim, "utf8");

  // Rename the journaled original OUT to an absolute path outside the tree (keep the
  // inode alive), then restore the EXACT original inode by renaming it BACK. The
  // journaled path now holds the SAME dev/ino the journal recorded => the retry must
  // adopt it and complete cleanly.
  const stash = join(
    realpathSync(join(project, "..")),
    `skrill27-stash-${process.pid}-${Date.now()}`,
  );
  renameSync(victim, stash);
  t.after(() => {
    try {
      rmSync(stash, { force: true });
    } catch {}
  });
  renameSync(stash, victim); // same inode restored at the journaled path
  const retry = applyCmd(world, project);
  assert.equal(
    retry.exit,
    0,
    `retry must recover the genuine original: ${retry.stderr}${retry.stdout}`,
  );
  assert.ok(!existsSync(join(project, JOURNAL_REL)), "journal must be removed on success");
  assert.ok(existsSync(join(project, RECEIPT_REL)), "receipt must exist after recovery");
  assert.equal(readFileSync(victim, "utf8"), publishedBytes, "restored original bytes");
  const again = applyCmd(world, project);
  assert.equal(
    again.exit,
    0,
    `repeat apply after recovery must be a no-op: ${again.stderr}${again.stdout}`,
  );
  assert.equal(again.data.changesWritten, 0, "repeat apply after recovery must write nothing");
});

it("J1c: a legacy journal record without dev/ino refuses explicitly (no auto-adoption)", (t) => {
  const world = buildWorld(t);
  const project = projectFixture(t);
  const failEnv = failAtOpenPreload(project, 10);
  assert.notEqual(applyCmd(world, project, failEnv).exit, 0);
  assert.ok(existsSync(join(project, JOURNAL_REL)));

  // Strip the identity fields from every record, emulating a legacy/unknown journal.
  const { header, records } = readJournal(project);
  const stripped = records.map(({ dev, ino, ...rest }) => rest);
  writeFileSync(
    join(project, JOURNAL_REL),
    `${JSON.stringify(header)}\n${stripped.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );

  const retry = applyCmd(world, project);
  assert.notEqual(
    retry.exit,
    0,
    `retry must refuse a journal without filesystem identity, got exit 0: ${retry.stdout}`,
  );
  assert.ok(
    (retry.envelope?.findings ?? []).some((f) => f.code === "E_BMAD_SPEC_COLLISION"),
    `expected E_BMAD_SPEC_COLLISION, got ${JSON.stringify(retry.envelope?.findings ?? [])}`,
  );
  // The journal is preserved (recovery bytes are never guessed or discarded).
  assert.ok(
    existsSync(join(project, JOURNAL_REL)),
    "journal must be kept for explicit operator cleanup",
  );
});
