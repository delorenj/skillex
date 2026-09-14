import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPackageFixture, packageName } from "./package-fixture.mjs";
import {
  assertLinks,
  createProfileWorld,
  directory,
  finding,
  identity,
  link,
  manifest,
  parsed,
  protectedSnapshot,
  snapshot,
  unchanged,
  write,
} from "./profile-fixture.mjs";

function managedNames(data) {
  return data.managed.map(({ name }) => name).sort();
}

function candidate(data, name) {
  const value = data.managed.find((entry) => entry.name === name);
  assert.ok(value, `missing profile candidate ${name}`);
  return value;
}

describe("installed Hermes profile CLI", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => fixture?.cleanup());

  it("imports the public APIs without Python and lists profile path metadata read-only", (context) => {
    const world = createProfileWorld(context, fixture);
    const external = directory(join(world.root, "external-runtime"));
    directory(join(external, "skills"));
    link(join(world.hermesRoot, "profiles", "linked"), external);
    const imported = world.module(
      [
        "import assert from 'node:assert/strict';",
        "import { spawnSync } from 'node:child_process';",
        "import { listProfiles, showProfile, syncProfile } from " +
          JSON.stringify(packageName) +
          ";",
        "for (const value of [listProfiles, showProfile, syncProfile]) assert.equal(typeof value, 'function');",
        "for (const name of ['python', 'python3', 'uv']) assert.equal(spawnSync(name, ['--version']).error?.code, 'ENOENT');",
      ].join("\n"),
    );
    assert.equal(imported, "");
    assert.deepEqual(readdirSync(fixture.runtimeBin), ["node"]);
    for (const placement of ["root", "family", "leaf"]) {
      const result = unchanged(world.root, () => world.json(["list"], { placement }));
      const profiles = new Map(result.data.profiles.map((entry) => [entry.profile.name, entry]));
      assert.deepEqual([...profiles.keys()].sort(), ["builder", "default", "linked"]);
      assert.equal(profiles.get("default").profile.root, world.hermesRoot);
      assert.equal(profiles.get("builder").projection, "unmanaged");
      assert.equal(profiles.get("builder").project, null);
      assert.equal(profiles.get("linked").profile.rootSymlink, true);
      assert.equal(profiles.get("linked").profile.root, external);
    }
    const legacy = directory(join(world.hermesRoot, "profiles", "legacy"));
    link(join(legacy, "skills"), join(world.hermesRoot, "skills"));
    write(
      join(world.hermesRoot, "skills", "runtime-owned", "SKILL.md"),
      "# Shared runtime skill\n",
    );
    const invalid = unchanged(world.root, () => world.json(["list"], { exit: 3 }));
    finding(invalid, "E_PROFILE_SKILLS_ROOT");
    const profiles = new Map(invalid.data.profiles.map((entry) => [entry.profile.name, entry]));
    assert.deepEqual([...profiles.keys()].sort(), ["builder", "default", "legacy", "linked"]);
    assert.equal(profiles.get("legacy").profile.skills.kind, "symlink");
    assert.equal(profiles.get("legacy").profile.skills.target, join(world.hermesRoot, "skills"));
    const shown = unchanged(world.root, () => world.json(["show", "legacy"], { exit: 3 }));
    finding(shown, "E_PROFILE_SKILLS_ROOT");
    assert.equal(shown.data.profile.root, legacy);
    assert.deepEqual(shown.data.preserved, [], "show traversed a shared whole-skills link");
  });

  it("shows unmanaged local entries and explicit project winners without inferring the CWD", (context) => {
    const world = createProfileWorld(context, fixture);
    write(join(world.skillsRoot, "alpha", "SKILL.md"), "# Profile-local alpha\n");
    const unmanaged = unchanged(world.root, () => world.json(["show", "builder"])).data;
    assert.equal(unmanaged.project, null);
    assert.equal(unmanaged.managed, null);
    assert.deepEqual(unmanaged.changes, []);
    assert.ok(unmanaged.preserved.some(({ name }) => name === "alpha"));
    const shown = unchanged(world.root, () =>
      world.json(["show", "builder", "--project", world.project], { exit: 6 }),
    ).data;
    assert.equal(shown.project, world.project);
    assert.deepEqual(managedNames(shown), ["alpha", "beta"]);
    assert.equal(candidate(shown, "alpha").state, "shadowed");
    assert.equal(candidate(shown, "alpha").winner, "profile");
    assert.equal(candidate(shown, "beta").winner, "project");
    assert.ok(candidate(shown, "alpha").origins.some(({ scope }) => scope === "global"));
    assert.ok(shown.preserved.find(({ name }) => name === "alpha").shadows);
    assert.equal(existsSync(world.state), false);
  });

  it("honors Hermes root selection and the closest command override without sticky profile inference", (context) => {
    const world = createProfileWorld(context, fixture);
    write(join(world.hermesRoot, "active_profile"), "builder\n");
    const defaultProfile = unchanged(world.root, () =>
      world.json(["show", "default"], {
        hermesRoot: null,
        environment: { HERMES_HOME: world.profile },
      }),
    ).data.profile;
    assert.equal(defaultProfile.name, "default");
    assert.equal(defaultProfile.root, world.hermesRoot);
    const fallback = unchanged(world.root, () =>
      world.json(["show", "builder"], {
        hermesRoot: null,
        environment: { HERMES_HOME: "", HERMES_PROFILES_DIR: join(world.root, "unused") },
      }),
    );
    assert.equal(fallback.data.profile.root, world.profile);
    const overridden = unchanged(world.root, () =>
      parsed(
        world.run([
          "--json",
          "--registry-root",
          world.registry,
          "profile",
          "--hermes-root",
          join(world.root, "missing-hermes"),
          "show",
          "builder",
          "--hermes-root",
          world.hermesRoot,
        ]),
        "profile show",
      ),
    );
    assert.equal(overridden.data.profile.root, world.profile);
    finding(
      unchanged(world.root, () => world.json(["list"], { hermesRoot: "", exit: 2 })),
      "E_HERMES_ROOT",
    );
  });

  it("projects global plus explicit project A from project B without touching generic activations", (context) => {
    const world = createProfileWorld(context, fixture);
    const rootIdentity = identity(world.skillsRoot);
    const sources = [
      snapshot(world.registry),
      snapshot(join(world.home, ".agents")),
      snapshot(world.project),
      snapshot(world.otherProject),
      snapshot(join(world.hermesRoot, "skills")),
    ];
    const result = world.sync().data;
    assert.equal(result.project, world.project);
    assert.equal(result.profile.root, world.profile);
    assert.equal(result.dryRun, false);
    assert.deepEqual(managedNames(result), ["alpha", "beta"]);
    assert.equal(candidate(result, "alpha").winner, "global");
    assert.equal(candidate(result, "beta").winner, "project");
    assertLinks(world, ["alpha", "beta"]);
    assert.deepEqual(readdirSync(world.skillsRoot).sort(), ["alpha", "beta"]);
    assert.deepEqual(identity(world.skillsRoot), rootIdentity);
    assert.ok(result.receiptPath.startsWith(`${world.receipts}/`));
    assert.equal(lstatSync(result.receiptPath).isFile(), true);
    assert.equal(existsSync(join(world.state, "skillex", "activations")), false);
    for (const root of [world.home, world.project, world.otherProject]) {
      for (const name of [".agents", ".claude", ".codex", ".gemini", ".copilot"])
        assert.equal(existsSync(join(root, name, "skills")), false);
    }
    assert.deepEqual(
      [
        snapshot(world.registry),
        snapshot(join(world.home, ".agents")),
        snapshot(world.project),
        snapshot(world.otherProject),
        snapshot(join(world.hermesRoot, "skills")),
      ],
      sources,
      "profile sync changed declarations, canonical content, or generic scope roots",
    );
  });

  it("keeps independent global contributions through project inheritance and exclusion settings", (context) => {
    const world = createProfileWorld(context, fixture);
    world.set("tools", ["alpha", "beta", "gamma", "shared"]);
    manifest(world.home, { skills: ["alpha", "shared"] });
    for (const inherit of [false, true]) {
      manifest(world.project, {
        inherit_global: inherit,
        sets: ["tools"],
        exclude: ["alpha", "gamma", "shared"],
      });
      const result = world.sync().data;
      assert.deepEqual(managedNames(result), ["alpha", "beta", "shared"]);
      assert.equal(candidate(result, "alpha").winner, "global");
      assert.equal(candidate(result, "beta").winner, "project");
      assertLinks(world, ["alpha", "beta", "shared"]);
      assert.equal(existsSync(join(world.skillsRoot, "gamma")), false);
    }
    manifest(world.project, { inherit_global: false, skills: ["shared"] });
    const combined = world.sync().data;
    assert.deepEqual(
      [...new Set(candidate(combined, "shared").origins.map(({ scope }) => scope))].sort(),
      ["global", "project"],
    );
    assertLinks(world, ["alpha", "shared"]);
  });

  it("flattens authoritative pack membership and restores ordinary project selection in the same directory", (context) => {
    const world = createProfileWorld(context, fixture);
    const globalPack = world.pack("global-tools", "1.0.0", ["alpha", "shared"], false);
    const projectPack = world.pack("project-tools", "2.0.0", ["beta", "shared"], false);
    manifest(world.home, {
      skills: ["dormant-missing"],
      packs: [{ name: "global-tools", version: "1.0.0" }],
    });
    manifest(world.project, {
      inherit_global: false,
      skills: ["gamma"],
      packs: [{ name: "project-tools", version: "2.0.0" }],
    });
    const before = identity(world.skillsRoot);
    assert.equal(existsSync(join(globalPack, "skills")), false);
    assert.equal(existsSync(join(projectPack, "skills")), false);
    const packed = world.sync().data;
    assert.deepEqual(managedNames(packed), ["alpha", "beta", "shared"]);
    assertLinks(world, ["alpha", "beta", "shared"]);
    assert.equal(lstatSync(world.skillsRoot).isDirectory(), true);
    assert.deepEqual(identity(world.skillsRoot), before);
    manifest(world.project, { inherit_global: false, skills: ["gamma"] });
    const restored = world.sync().data;
    assert.deepEqual(managedNames(restored), ["alpha", "gamma", "shared"]);
    assertLinks(world, ["alpha", "gamma", "shared"]);
    assert.equal(existsSync(join(world.skillsRoot, "beta")), false);
    assert.deepEqual(identity(world.skillsRoot), before);
  });

  it("preserves local definitions, same-target foreign links, and Hermes runtime overlays without adoption", (context) => {
    const world = createProfileWorld(context, fixture);
    write(join(world.skillsRoot, "alpha", "SKILL.md"), "# Runtime-owned alpha\n");
    link(join(world.skillsRoot, "beta"), join(world.registry, "all-skills", "beta"));
    const external = directory(join(world.root, "runtime-overlay"));
    write(join(external, "notes.txt"), "Foreign overlay bytes.\n");
    link(join(world.skillsRoot, "external-tools"), external);
    write(join(world.skillsRoot, ".metadata.json"), '{"runtime":"hermes"}\n');
    write(join(world.skillsRoot, ".builtin", "index.json"), '{"managedBy":"hermes"}\n');
    write(join(world.profile, "runtime-state.json"), '{"session":"fixture"}\n');
    const before = snapshot(world.profile);
    const result = world.sync().data;
    for (const name of ["alpha", "beta"]) {
      assert.equal(candidate(result, name).state, "shadowed");
      assert.equal(candidate(result, name).winner, "profile");
      assert.ok(result.preserved.find((entry) => entry.name === name).shadows);
    }
    assert.deepEqual(snapshot(world.profile), before);
    manifest(world.home, {});
    manifest(world.project, { inherit_global: false });
    const removed = world.sync().data;
    assert.deepEqual(removed.managed, []);
    assert.ok(removed.changes.every(({ action }) => action !== "prune"));
    assert.deepEqual(
      snapshot(world.profile),
      before,
      "foreign exact-target link was adopted or pruned",
    );
  });

  it("previews winning sources and operations without creating state or changing any inode", (context) => {
    const world = createProfileWorld(context, fixture);
    write(join(world.skillsRoot, "alpha", "SKILL.md"), "# Keep profile override\n");
    assert.equal(existsSync(world.state), false);
    const result = unchanged(world.root, () =>
      world.json(["sync", "builder", "--project", world.project, "--dry-run"]),
    ).data;
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.applied, []);
    assert.equal(candidate(result, "alpha").winner, "profile");
    assert.equal(candidate(result, "beta").winner, "project");
    assert.ok(
      result.changes.some(
        ({ action, path }) => action === "create" && path === join(world.skillsRoot, "beta"),
      ),
    );
    assert.equal(existsSync(world.state), false);
  });

  it("keeps converged identities and receipt bytes stable and shows the recorded project from unrelated CWD", (context) => {
    const world = createProfileWorld(context, fixture);
    const first = world.sync().data;
    const receipt = readFileSync(first.receiptPath);
    const before = protectedSnapshot(world);
    const second = world.sync().data;
    assert.deepEqual(second.changes, []);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(readFileSync(second.receiptPath), receipt);
    assert.deepEqual(protectedSnapshot(world), before);
    const shown = unchanged(world.root, () => world.json(["show", "builder"])).data;
    assert.equal(shown.project, world.project);
    assert.deepEqual(managedNames(shown), ["alpha", "beta"]);
    assert.deepEqual(shown.changes, []);
    const listed = unchanged(world.root, () => world.json(["list"])).data.profiles;
    const builder = listed.find(({ profile }) => profile.name === "builder");
    assert.equal(builder.project, world.project);
    assert.equal(builder.projection, "managed");
    assert.equal(builder.counts.managed, 2);
  });

  it("prunes only stale receipt-owned links while preserving unowned references and runtime files", (context) => {
    const world = createProfileWorld(context, fixture);
    const foreign = link(
      join(world.skillsRoot, "gamma"),
      join(world.registry, "all-skills", "gamma"),
    );
    const notes = write(join(world.skillsRoot, "runtime.txt"), "Hermes owns this file.\n");
    const foreignBefore = snapshot(foreign);
    const notesBefore = snapshot(notes);
    world.sync();
    manifest(world.home, {});
    manifest(world.project, { inherit_global: false, skills: ["alpha"] });
    const narrowed = world.sync().data;
    assert.ok(narrowed.changes.some(({ action, name }) => action === "prune" && name === "beta"));
    assertLinks(world, ["alpha", "gamma"]);
    assert.equal(existsSync(join(world.skillsRoot, "beta")), false);
    manifest(world.project, { inherit_global: false });
    world.sync();
    assert.equal(existsSync(join(world.skillsRoot, "alpha")), false);
    assert.deepEqual(snapshot(foreign), foreignBefore);
    assert.deepEqual(snapshot(notes), notesBefore);
  });

  it("relinquishes replaced managed children and preserves their new local contents on later pruning", (context) => {
    const world = createProfileWorld(context, fixture);
    world.sync();
    unlinkSync(join(world.skillsRoot, "alpha"));
    write(join(world.skillsRoot, "alpha", "SKILL.md"), "# New runtime-owned alpha\n");
    unlinkSync(join(world.skillsRoot, "beta"));
    link(join(world.skillsRoot, "beta"), join(world.registry, "all-skills", "gamma"));
    const local = snapshot(world.skillsRoot);
    const released = world.sync().data;
    for (const name of ["alpha", "beta"]) {
      assert.equal(candidate(released, name).winner, "profile");
      assert.ok(
        released.changes.some((entry) => entry.action === "release" && entry.name === name),
      );
    }
    assert.deepEqual(snapshot(world.skillsRoot), local);
    manifest(world.home, {});
    manifest(world.project, { inherit_global: false });
    world.sync();
    assert.deepEqual(snapshot(world.skillsRoot), local);
  });

  it("supports a symlinked named profile root while preserving its real skills directory identity", (context) => {
    const world = createProfileWorld(context, fixture);
    const runtime = directory(join(world.root, "linked-runtime"));
    const skillsRoot = directory(join(runtime, "skills"));
    const lexical = link(join(world.hermesRoot, "profiles", "linked"), runtime);
    const before = identity(skillsRoot);
    const result = world.json(["sync", "linked", "--project", world.project]).data;
    assert.equal(result.profile.path, lexical);
    assert.equal(result.profile.root, runtime);
    assert.equal(result.profile.rootSymlink, true);
    assert.equal(result.profile.skillsRoot, skillsRoot);
    assert.deepEqual(identity(skillsRoot), before);
    assertLinks(world, ["alpha", "beta"], skillsRoot);
    assert.equal(lstatSync(lexical).isSymbolicLink(), true);
    const shown = unchanged(world.root, () => world.json(["show", "linked"])).data;
    assert.equal(shown.project, world.project);
    assert.equal(shown.receiptPath, result.receiptPath);
  });

  it("refuses whole-skills symlinks without following or modifying their shared targets", (context) => {
    for (const dangling of [false, true]) {
      const world = createProfileWorld(context, fixture);
      rmSync(world.skillsRoot, { recursive: true });
      const target = dangling
        ? join(world.root, "missing-shared-skills")
        : join(world.hermesRoot, "skills");
      if (!dangling) write(join(target, "hermes-owned", "SKILL.md"), "# Shared runtime content\n");
      link(world.skillsRoot, target);
      const result = unchanged(world.root, () => world.sync({ exit: 3 }));
      finding(result, "E_PROFILE_SKILLS_ROOT");
      assert.equal(lstatSync(world.skillsRoot).isSymbolicLink(), true);
      assert.equal(existsSync(world.state), false);
    }
  });

  it("preserves an existing projection when selection is optional-incomplete, missing, or malformed", (context) => {
    const world = createProfileWorld(context, fixture);
    world.sync();
    for (const scenario of [
      {
        declaration: { sets: [{ name: "missing", optional: true }] },
        exit: 4,
        code: "W_OPTIONAL_SKIPPED",
      },
      { declaration: { skills: ["missing"] }, exit: 3, code: "E_SKILL_MISSING" },
      { declaration: null, exit: 2, code: "E_MANIFEST_PARSE" },
    ]) {
      if (scenario.declaration === null)
        write(join(world.project, ".agents", "skills.json"), '{"skills":');
      else manifest(world.project, { inherit_global: false, ...scenario.declaration });
      const result = unchanged(world.root, () => world.sync({ exit: scenario.exit }));
      finding(result, scenario.code);
      assertLinks(world, ["alpha", "beta"]);
    }
  });

  it("refuses a canonical name that resolves to different global and project registries", (context) => {
    const world = createProfileWorld(context, fixture);
    const registries = ["https://example.test/global.git", "https://example.test/project.git"];
    for (const [index, registry] of registries.entries()) {
      const cached = join(
        world.home,
        ".agents",
        ".cache",
        "registries",
        registry.replace(/[^a-zA-Z0-9]/g, "_"),
      );
      write(join(cached, "all-skills", "alpha", "SKILL.md"), `# Canonical alpha ${index}\n`);
      manifest(index === 0 ? world.home : world.project, {
        registry,
        inherit_global: false,
        skills: ["alpha"],
      });
    }
    const result = unchanged(world.root, () => world.sync({ registryRoot: null, exit: 3 }));
    finding(result, "E_DIVERGENT_CANONICAL_NAME");
    assert.deepEqual(readdirSync(world.skillsRoot), []);
    assert.equal(existsSync(world.state), false);
  });

  it("refuses malformed profile ownership evidence without replacing it or touching child links", (context) => {
    const world = createProfileWorld(context, fixture);
    const initial = world.sync().data;
    write(initial.receiptPath, '{"schema":2,"incomplete":');
    const result = unchanged(world.root, () => world.sync({ exit: 3 }));
    assert.ok(result.findings.some(({ severity }) => severity === "error"));
    assert.equal(readFileSync(initial.receiptPath, "utf8"), '{"schema":2,"incomplete":');
    assertLinks(world, ["alpha", "beta"]);
  });

  it("provides human output, help, shared flags, and actionable JSON selector errors", (context) => {
    const world = createProfileWorld(context, fixture);
    const flags = ["--registry-root", world.registry, "--hermes-root", world.hermesRoot];
    const help = unchanged(world.root, () => world.run(["profile", "sync", "--help", ...flags]));
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /--project/);
    assert.match(help.stdout, /--dry-run/);
    const preview = unchanged(world.root, () =>
      world.run(["profile", "sync", "builder", "--project", world.project, "--dry-run", ...flags]),
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.stderr, "");
    assert.match(preview.stdout, /builder/);
    assert.match(preview.stdout, /alpha|beta/);
    const human = world.run(["profile", "sync", "builder", "--project", world.project, ...flags]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /builder/);
    const missing = unchanged(world.root, () => world.json(["show", "missing"], { exit: 2 }));
    finding(missing, "E_PROFILE_NOT_FOUND");
    finding(
      unchanged(world.root, () => world.json(["show", "../builder"], { exit: 2 })),
      "E_PROFILE_NAME",
    );
    for (const args of [
      ["profile", "sync"],
      ["profile", "show"],
      ["profile", "sync", "builder"],
      ["profile", "sync", "builder", "--project", world.project, "--scope", "both"],
      ["profile", "show", "builder", "--dry-run"],
    ]) {
      const result = unchanged(world.root, () => parsed(world.run(["--json", ...args]), "cli", 2));
      finding(result, "E_USAGE");
    }
    const badProject = unchanged(world.root, () =>
      world.json(["sync", "builder", "--project", join(world.root, "missing-project")], {
        exit: 2,
      }),
    );
    assert.ok(badProject.findings.some(({ severity }) => severity === "error"));
    const humanError = unchanged(world.root, () =>
      world.run(["profile", "show", "missing", ...flags]),
    );
    assert.equal(humanError.status, 2);
    assert.equal(humanError.stdout, "");
    assert.match(humanError.stderr, /missing/i);
  });

  it("returns JSON interruption while waiting for its profile lock and converges on rerun", (context) => {
    const world = createProfileWorld(context, fixture);
    const before = protectedSnapshot(world);
    const resource = `skillex:profiles:v2:${realpathSync(world.skillsRoot)}`;
    const args = world.argsFor(["sync", "builder", "--project", world.project]);
    const result = JSON.parse(
      world.module(
        [
          "import assert from 'node:assert/strict';",
          "import { spawn } from 'node:child_process';",
          "import { readdirSync } from 'node:fs';",
          "import { setTimeout as delay } from 'node:timers/promises';",
          `import { withLock } from ${JSON.stringify(packageName)};`,
          `const state = ${JSON.stringify(world.state)};`,
          `await withLock(${JSON.stringify(resource)}, async () => {`,
          "  const before = new Set(readdirSync(state, {recursive:true}));",
          "  const child = spawn(" +
            JSON.stringify(fixture.cli) +
            ", " +
            JSON.stringify(args) +
            ", " +
            JSON.stringify({ cwd: world.cwd, env: world.environment }) +
            ");",
          "  let stdout = ''; let stderr = ''; let ended = false; let timeout;",
          "  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');",
          "  child.stdout.on('data', value => { stdout += value; });",
          "  child.stderr.on('data', value => { stderr += value; });",
          "  const closed = new Promise((resolve,reject) => {",
          "    child.once('error',reject);",
          "    child.once('close',(status,signal) => { ended=true; resolve({status,signal,stdout,stderr}); });",
          "  });",
          "  closed.catch(() => {});",
          "  try {",
          "    const waiting = () => readdirSync(state,{recursive:true}).some(path => !before.has(path));",
          "    const deadline = Date.now() + 5_000;",
          "    while (!ended && !waiting() && Date.now() < deadline) await delay(10);",
          "    assert.equal(ended,false,'CLI exited before lock acquisition: ' + stdout + stderr);",
          "    assert.ok(waiting(),'CLI never entered lock acquisition');",
          "    assert.equal(child.kill('SIGINT'),true);",
          "    const result = await Promise.race([closed,new Promise((_,reject) => {",
          "      timeout=setTimeout(() => reject(new Error('SIGINT did not stop profile sync')),10_000);",
          "    })]);",
          "    assert.equal(result.signal,null,'SIGINT must produce the JSON result');",
          "    process.stdout.write(JSON.stringify(result));",
          "  } finally {",
          "    clearTimeout(timeout);",
          "    if (!ended) { child.kill('SIGKILL'); await closed.catch(() => {}); }",
          "  }",
          `}, {stateHome:state,home:${JSON.stringify(world.home)}});`,
        ].join("\n"),
      ),
    );
    const interrupted = parsed(result, "profile sync", 130);
    finding(interrupted, "E_INTERRUPTED");
    assert.deepEqual(interrupted.data?.applied ?? [], []);
    assert.deepEqual(protectedSnapshot(world), before);
    assert.equal(existsSync(world.receipts), false);
    world.sync();
    assertLinks(world, ["alpha", "beta"]);
  });
});
