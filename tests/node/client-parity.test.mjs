import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  inspectClientParity,
  resolveEffectiveSelection,
  showProfile,
  sync,
  syncProfile,
} from "@delorenj/skillex";

function fixture(t) {
  const root = realpathSync(
    mkdtempSync(join(process.env.SKILLEX_TEST_TMPDIR ?? tmpdir(), "skillex-parity-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, text) => {
    dir(dirname(path));
    writeFileSync(path, text);
    return path;
  };
  const home = dir(join(root, "home"));
  const project = dir(join(root, "project"));
  const registryRoot = dir(join(root, "registry"));
  const hermesRoot = dir(join(root, "hermes"));
  const profile = dir(join(hermesRoot, "profiles", "pilot"));
  dir(join(profile, "skills"));
  dir(join(project, ".git"));
  for (const name of ["all-skills", "sets", "packs"]) dir(join(registryRoot, name));
  const skill = (name, text = `---\nname: ${name}\ndescription: Parity fixture\n---\n`) =>
    file(join(registryRoot, "all-skills", name, "SKILL.md"), text);
  skill("global");
  skill("shared");
  skill("role");
  const manifest = (path, value) =>
    file(join(path, ".agents", "skills.json"), JSON.stringify(value));
  manifest(home, { skills: ["global", "shared"] });
  manifest(project, { inherit_global: false, skills: ["role", "shared"] });
  file(join(profile, "config.yaml"), "skills:\n  external_dirs: []\n  inherit_global: false\n");
  const options = {
    home,
    project,
    cwd: project,
    registryRoot,
    hermesRoot,
    stateHome: join(root, "state"),
    env: {},
    profile: "pilot",
  };
  const activate = async () => {
    const result = await sync({ ...options, scope: "both" });
    assert.equal(result.exit, 0, JSON.stringify(result));
    // The scratch parent is under .hermes; Skillex deliberately never creates
    // generic aliases below that protected ancestor. Simulate the client alias
    // that an ordinary home/project would have in the bounded fixture instead.
    for (const base of [home, project]) {
      // Ordinary temp roots already receive aliases from sync. Protected .hermes
      // scratch roots do not; add only the missing fixture-owned alias.
      const alias = join(base, ".claude", "skills");
      if (!existsSync(alias)) {
        dir(dirname(alias));
        symlinkSync(join(base, ".agents", "skills"), alias);
      }
      assert.equal(realpathSync(alias), realpathSync(join(base, ".agents", "skills")));
    }
    const projected = await syncProfile("pilot", { ...options, skillexOnly: true });
    assert.equal(projected.exit, 0, JSON.stringify(projected));
  };
  return {
    root,
    home,
    project,
    registryRoot,
    hermesRoot,
    profile,
    options,
    dir,
    file,
    skill,
    manifest,
    activate,
  };
}

test("effective union ignores scope opt-out, deduplicates origins and survives role set", async (t) => {
  const f = fixture(t);
  const first = await resolveEffectiveSelection(f.options);
  assert.equal(first.exit, 0, JSON.stringify(first));
  assert.deepEqual(
    first.data.bindings.map(({ name }) => name),
    ["global", "role", "shared"],
  );
  assert.equal(first.data.bindings.find(({ name }) => name === "shared").winner, "project");
  const set = f.dir(join(f.registryRoot, "sets", "desk"));
  for (const name of ["role", "shared"])
    symlinkSync(join(f.registryRoot, "all-skills", name), join(set, name));
  f.manifest(f.project, { sets: ["desk"], inherit_global: false });
  const second = await resolveEffectiveSelection(f.options);
  assert.equal(second.exit, 0, JSON.stringify(second));
  assert.deepEqual(
    second.data.bindings.map(({ name }) => name),
    ["global", "role", "shared"],
  );
  await f.activate();
  assert.equal(lstatSync(join(f.profile, "skills")).isDirectory(), true);
  assert.deepEqual(
    (await showProfile("pilot", f.options)).data.managed.map(({ name }) => name),
    ["global", "role", "shared"],
  );
  assert.deepEqual((await syncProfile("pilot", f.options)).data.applied, []);
});

test("all four adapters inspect the same union but never certify runtime from links", async (t) => {
  const f = fixture(t);
  await f.activate();
  const before = readFileSync(join(f.profile, "config.yaml"), "utf8");
  const result = await inspectClientParity(f.options);
  assert.equal(result.exit, 4, JSON.stringify(result));
  assert.equal(result.data.runtime, "unverified");
  assert.deepEqual(
    result.data.expected.map(({ name }) => name),
    ["global", "role", "shared"],
  );
  assert.deepEqual(
    result.data.consumers.map(({ client, filesystem }) => [client, filesystem]),
    [
      ["claude", "matched"],
      ["codex", "matched"],
      ["kimi", "matched"],
      ["hermes", "matched"],
    ],
  );
  assert.equal(readFileSync(join(f.profile, "config.yaml"), "utf8"), before);
  assert.deepEqual((await showProfile("pilot", f.options)).data.changes, []);
});

test("strict marker loss is refused without writing or silently restoring policy", async (t) => {
  const f = fixture(t);
  await f.activate();
  unlinkSync(join(f.profile, ".no-bundled-skills"));
  const shown = await showProfile("pilot", f.options);
  assert.equal(shown.exit, 3, JSON.stringify(shown));
  assert(shown.findings.some(({ code }) => code === "E_PROFILE_SKILLEX_ONLY"));
  assert.equal((await syncProfile("pilot", f.options)).exit, 3);
  assert.equal(existsSync(join(f.profile, ".no-bundled-skills")), false);
});

test("strict create_dir is an additional discovery route, not permission to bypass ownership", async (t) => {
  const f = fixture(t);
  f.file(join(f.profile, "config.yaml"), "skills:\n  external_dirs: []\n  create_dir: ~/foreign\n");
  const refused = await syncProfile("pilot", { ...f.options, skillexOnly: true });
  assert.equal(refused.exit, 3);
  assert.equal(existsSync(f.options.stateHome), false);
});

test("foreign containers and trusted project shadows are reported and preserved", async (t) => {
  const f = fixture(t);
  await f.activate();
  const foreign = f.file(
    join(f.home, ".agents", "skills", "synced", "copy", "SKILL.md"),
    "---\nname: extra\ndescription: Foreign\n---\n",
  );
  const shadow = f.file(
    join(f.project, ".hermes", "skills", "role", "SKILL.md"),
    "---\nname: role\ndescription: Shadow\n---\n",
  );
  f.file(
    join(f.profile, "config.yaml"),
    `skills:\n  external_dirs: []\n  trusted_project_dirs: [${JSON.stringify(f.project)}]\n`,
  );
  const result = await inspectClientParity(f.options);
  assert.notEqual(result.exit, 0);
  assert(
    result.data.consumers
      .find(({ client }) => client === "hermes")
      .roots.includes(join(f.project, ".hermes/skills")),
  );
  assert(
    result.data.consumers
      .find(({ client }) => client === "hermes")
      .canonicalConflicts.includes("role"),
  );
  assert.equal(readFileSync(foreign, "utf8").includes("extra"), true);
  assert.equal(readFileSync(shadow, "utf8").includes("Shadow"), true);
});

test("Hermes reports index-vs-lookup disagreement for per-skill symlinks across distinct roots", async (t) => {
  const f = fixture(t);
  await f.activate();
  const projectRole = join(f.project, ".agents", "skills", "role");
  const trustedRole = join(f.project, ".hermes", "skills", "role");
  f.dir(dirname(trustedRole));
  symlinkSync(realpathSync(projectRole), trustedRole);
  f.file(
    join(f.profile, "config.yaml"),
    `skills:\n  external_dirs: []\n  trusted_project_dirs: [${JSON.stringify(f.project)}]\n`,
  );
  const result = await inspectClientParity(f.options);
  const hermes = result.data.consumers.find(({ client }) => client === "hermes");
  assert.deepEqual(hermes.canonicalConflicts, []);
  assert.deepEqual(hermes.indexLookupDisagreements, ["role"]);
  assert.equal(hermes.quarantine, "unknown");
  assert.equal(
    readFileSync(join(trustedRole, "SKILL.md"), "utf8").includes("Parity fixture"),
    true,
  );
});

test("invalid metadata and dangling links cannot pass the filesystem check", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.skill("role", "# no metadata\n");
  const dead = join(f.home, ".agents", "skills", "dead");
  symlinkSync(join(f.root, "missing"), dead);
  const result = await inspectClientParity(f.options);
  assert.notEqual(result.exit, 0);
  const kimi = result.data.consumers.find(({ client }) => client === "kimi");
  assert(kimi.metadataIssues.some(({ path }) => path.endsWith("/role")));
  assert(kimi.missing.includes("role"));
  assert(kimi.unreachable.includes(dead));
});

test("divergent canonical names refuse even when project opts out of inheritance", async (t) => {
  const f = fixture(t);
  const alternate = f.dir(
    join(f.home, ".agents", ".cache", "registries", "https___example_invalid_other"),
  );
  for (const name of ["all-skills", "sets", "packs"]) f.dir(join(alternate, name));
  f.file(
    join(alternate, "all-skills", "shared", "SKILL.md"),
    "---\nname: shared\ndescription: Different\n---\n",
  );
  f.manifest(f.project, {
    inherit_global: false,
    registry: "https://example.invalid/other",
    skills: ["shared"],
  });
  const { registryRoot, ...options } = f.options;
  // Global uses a separately discoverable registry; explicit override would mask the collision.
  f.manifest(f.home, { registry: "https://example.invalid/global", skills: ["shared"] });
  const global = f.dir(
    join(f.home, ".agents", ".cache", "registries", "https___example_invalid_global"),
  );
  for (const name of ["all-skills", "sets", "packs"]) f.dir(join(global, name));
  f.file(
    join(global, "all-skills", "shared", "SKILL.md"),
    "---\nname: shared\ndescription: Global\n---\n",
  );
  assert(registryRoot);
  const result = await resolveEffectiveSelection(options);
  assert.equal(result.exit, 3, JSON.stringify(result));
  assert(result.findings.some(({ code }) => code === "E_DIVERGENT_CANONICAL_NAME"));
});

test("CLI parity is read-only, requires an explicit Hermes profile, and rejects unsupported flags", () => {
  const run = (...args) =>
    spawnSync(process.execPath, ["dist/cli.js", "clients", "parity", ...args], {
      encoding: "utf8",
    });
  assert.notEqual(run("--project", process.cwd()).status, 0);
  assert.notEqual(run("--project", process.cwd(), "--profile", "pilot", "--apply").status, 0);
  const invalid = run(
    "--project",
    process.cwd(),
    "--profile",
    "pilot",
    "--kimi-dialect",
    "unknown",
    "--json",
  );
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).findings[0].code, "E_CLIENT_PARITY_OPTIONS");
});

for (const inherit of [true, false]) {
  test(`cross-registry union retains source registry, inherit_global=${inherit}, strict sync converges`, async (t) => {
    const f = fixture(t);
    const cached = (id) => {
      const root = f.dir(
        join(f.home, ".agents/.cache/registries", `https___example_invalid_${id}`),
      );
      for (const name of ["all-skills", "sets", "packs"]) f.dir(join(root, name));
      return root;
    };
    const a = cached("a");
    const b = cached("b");
    f.file(join(a, "all-skills/alpha/SKILL.md"), "# alpha\n");
    f.file(join(b, "all-skills/beta/SKILL.md"), "# beta\n");
    f.manifest(f.home, { registry: "https://example.invalid/a", skills: ["alpha"] });
    f.manifest(f.project, {
      registry: "https://example.invalid/b",
      inherit_global: inherit,
      skills: ["beta"],
    });
    const { registryRoot, ...options } = f.options;
    assert(registryRoot);
    const selected = await resolveEffectiveSelection(options);
    assert.equal(selected.exit, 0, JSON.stringify(selected));
    // Exercise publication too: the wrong registry used to fail after receipt writes began.
    const synced = await syncProfile("pilot", { ...options, skillexOnly: true });
    assert.equal(synced.exit, 0, JSON.stringify(synced));
    assert.equal(selected.data.bindings.find(({ name }) => name === "alpha").registry, a);
    assert.deepEqual(
      synced.data.managed.map(({ name }) => name),
      ["alpha", "beta"],
    );
    const again = await syncProfile("pilot", { ...options, dryRun: true });
    assert.equal(again.exit, 0, JSON.stringify(again));
    assert.deepEqual(again.data.changes, []);
    assert.deepEqual((await showProfile("pilot", options)).data.changes, []);
  });
}

function trust(f, extra = "", project = f.project) {
  f.file(
    join(f.profile, "config.yaml"),
    `skills:\n  external_dirs: []\n  trusted_project_dirs: [${JSON.stringify(project)}]\n${extra}`,
  );
}
const consumer = (result, client) => {
  assert(result.data, JSON.stringify(result));
  return result.data.consumers.find((row) => row.client === client);
};

test("foreign metadata alias colliding with selected role is not a filesystem match", async (t) => {
  const f = fixture(t);
  await f.activate();
  const alien = f.file(
    join(f.project, ".hermes/skills/alien/SKILL.md"),
    "---\nname: role\ndescription: Foreign alias\n---\n",
  );
  trust(f);
  const hermes = consumer(await inspectClientParity(f.options), "hermes");
  assert.equal(hermes.filesystem, "drift");
  assert(hermes.canonicalConflicts.includes("role"));
  assert(hermes.foreign.some(({ name, path }) => name === "alien" && path === dirname(alien)));
  assert(
    hermes.candidates.some(
      ({ directoryName, advertisedName, lookupNames }) =>
        directoryName === "alien" &&
        advertisedName === "role" &&
        lookupNames.includes("alien") &&
        lookupNames.includes("role"),
    ),
  );
  assert.equal(readFileSync(alien, "utf8").includes("Foreign alias"), true);
});

test("omitted name uses Claude/Hermes and legacy Kimi fallback, not Codex or Kimi Code", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.skill("role", "---\ndescription: Omitted name\n---\n");
  const result = await inspectClientParity(f.options);
  for (const client of ["claude", "hermes"])
    assert.equal(consumer(result, client).filesystem, "matched", JSON.stringify(result));
  for (const client of ["codex", "kimi"]) assert(consumer(result, client).missing.includes("role"));
  const legacy = await inspectClientParity({ ...f.options, kimiDialect: "python-1.47" });
  assert.equal(consumer(legacy, "kimi").filesystem, "matched");
});

test("directory and advertised name are independent, not silently discarded", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.skill("role", "---\nname: renamed\ndescription: Different name\n---\n");
  const result = await inspectClientParity(f.options);
  for (const row of result.data.consumers) {
    assert.equal(row.filesystem, "drift");
    assert(
      row.candidates.some(
        ({ directoryName, advertisedName }) =>
          directoryName === "role" && advertisedName === "renamed",
      ),
    );
    assert(row.metadataIssues.length);
  }
});

test("canonical links with advertised aliases are present, with lookup and naming drift separate", async (t) => {
  const f = fixture(t);
  f.skill("role", "---\nname: pjangler\ndescription: Alias\n---\n");
  await f.activate();
  const result = await inspectClientParity(f.options);
  for (const row of result.data.consumers) {
    assert(!row.missing.includes("role"), JSON.stringify(row));
    const candidate = row.candidates.find(
      ({ directoryName, target }) =>
        directoryName === "role" && target === join(f.registryRoot, "all-skills", "role"),
    );
    assert(candidate);
    assert.equal(candidate.advertisedName, "pjangler");
    assert(candidate.lookupNames.includes("pjangler"));
    assert.equal(candidate.lookupNames.includes("role"), row.client === "hermes");
    assert(row.metadataIssues.some(({ reason }) => reason.includes("differs from advertised")));
    assert.equal(row.filesystem, "drift");
  }
  assert.equal(result.data.runtime, "unverified");
  assert.equal(
    readFileSync(join(f.registryRoot, "all-skills/role/SKILL.md"), "utf8").includes("pjangler"),
    true,
  );
});

test("unsupported missing metadata cannot count as canonical membership", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.skill("role", "---\nname: pjangler\n---\n");
  const result = await inspectClientParity(f.options);
  for (const client of ["codex", "kimi"]) {
    const row = consumer(result, client);
    assert(row.missing.includes("role"));
    assert(row.metadataIssues.some(({ reason }) => reason.includes("require explicit")));
  }
  assert(!consumer(result, "hermes").missing.includes("role"));
});

test("ordinary converged profile without either strict marker is blocked without mutation", async (t) => {
  const f = fixture(t);
  await f.activate();
  for (const marker of [".skillex-only", ".no-bundled-skills"]) unlinkSync(join(f.profile, marker));
  assert.equal((await syncProfile("pilot", f.options)).exit, 0);
  assert.deepEqual((await showProfile("pilot", f.options)).data.changes, []);
  const config = readFileSync(join(f.profile, "config.yaml"), "utf8");
  const result = await inspectClientParity(f.options);
  const hermes = consumer(result, "hermes");
  assert.equal(hermes.filesystem, "blocked");
  for (const marker of [".skillex-only", ".no-bundled-skills"]) {
    assert(hermes.limitations.some((text) => text.includes(marker)));
    assert.equal(existsSync(join(f.profile, marker)), false);
  }
  assert.equal(readFileSync(join(f.profile, "config.yaml"), "utf8"), config);
});

for (const markerName of [".skillex-only", ".no-bundled-skills"]) {
  test(`nonregular ${markerName} blocks audit without changing the marker`, async (t) => {
    const f = fixture(t);
    await f.activate();
    unlinkSync(join(f.profile, markerName));
    const marker = f.dir(join(f.profile, markerName));
    const foreign = f.file(join(marker, "foreign.txt"), "must remain");
    const hermes = consumer(await inspectClientParity(f.options), "hermes");
    assert.equal(hermes.filesystem, "blocked");
    assert(hermes.limitations.some((text) => text.includes(markerName)));
    assert.equal(readFileSync(foreign, "utf8"), "must remain");
    assert.equal(lstatSync(marker).isDirectory(), true);
  });
}

test("whole Hermes project root aliases deduplicate by real identity", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.dir(join(f.project, ".hermes"));
  symlinkSync(join(f.project, ".agents/skills"), join(f.project, ".hermes/skills"));
  trust(f);
  const hermes = consumer(await inspectClientParity(f.options), "hermes");
  assert.equal(hermes.filesystem, "matched", JSON.stringify(hermes));
  assert.deepEqual(hermes.indexLookupDisagreements, []);
  assert.equal(hermes.roots.length, 2);
});

test("byte-identical copies in distinct Hermes roots remain canonical conflicts, not adopted", async (t) => {
  const f = fixture(t);
  await f.activate();
  const copy = f.file(
    join(f.project, ".hermes/skills/role/SKILL.md"),
    readFileSync(join(f.registryRoot, "all-skills/role/SKILL.md"), "utf8"),
  );
  trust(f);
  const hermes = consumer(await inspectClientParity(f.options), "hermes");
  assert(hermes.canonicalConflicts.includes("role"));
  assert.deepEqual(hermes.indexLookupDisagreements, []);
  assert.equal(
    readFileSync(copy, "utf8"),
    readFileSync(join(f.registryRoot, "all-skills/role/SKILL.md"), "utf8"),
  );
});

test("Hermes project_discovery false excludes trusted roots", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.file(
    join(f.project, ".hermes/skills/role/SKILL.md"),
    "---\nname: role\ndescription: Shadow\n---\n",
  );
  trust(f, "  project_discovery: false\n");
  const hermes = consumer(await inspectClientParity(f.options), "hermes");
  assert.deepEqual(hermes.roots, [join(f.profile, "skills")]);
  assert.equal(hermes.filesystem, "matched");
});

test("Hermes trust paths compare real identities, including symlinks", async (t) => {
  const f = fixture(t);
  await f.activate();
  const alias = join(f.root, "project-alias");
  symlinkSync(f.project, alias);
  trust(f, "", alias);
  const hermes = consumer(await inspectClientParity(f.options), "hermes");
  assert(hermes.roots.includes(realpathSync(join(f.project, ".agents/skills"))));
});

test("Hermes expands declared trust environment before resolving real project paths", async (t) => {
  const f = fixture(t);
  await f.activate();
  const alien = f.file(
    join(f.project, ".hermes/skills/alien/SKILL.md"),
    "---\nname: role\ndescription: Foreign\n---\n",
  );
  const alias = join(f.root, "project-alias");
  symlinkSync(f.project, alias);
  for (const spelling of [`${"$"}{SKILLEX_PARITY_PROJECT}`, "$SKILLEX_PARITY_PROJECT"]) {
    trust(f, "", spelling);
    const hermes = consumer(
      await inspectClientParity({
        ...f.options,
        env: { SKILLEX_PARITY_PROJECT: alias },
      }),
      "hermes",
    );
    assert(hermes.roots.includes(join(f.project, ".hermes/skills")));
    assert(hermes.canonicalConflicts.includes("role"));
    assert(hermes.foreign.some(({ name }) => name === "alien"));
  }
  assert.equal(readFileSync(alien, "utf8").includes("Foreign"), true);
  trust(f, "", `${"$"}{SKILLEX_PARITY_UNDEFINED}`);
  const unbound = consumer(await inspectClientParity(f.options), "hermes");
  assert(!unbound.roots.includes(join(f.project, ".hermes/skills")));
  assert.equal(unbound.filesystem, "matched");
});

for (const kind of ["directory", "file", "dangling"]) {
  test(`legacy Kimi project generic root ignores .config, user preference requires directory: ${kind}`, async (t) => {
    const f = fixture(t);
    await f.activate();
    // Remove brand aliases so only generic discovery can provide membership.
    for (const base of [f.home, f.project])
      for (const name of [".claude", ".codex", ".kimi", ".kimi-code"])
        rmSync(join(base, name), { recursive: true, force: true });
    f.dir(join(f.project, ".config/agents/skills"));
    const preferred = join(f.home, ".config/agents/skills");
    if (kind === "directory") f.dir(preferred);
    else if (kind === "file") f.file(preferred, "not a directory");
    else {
      f.dir(dirname(preferred));
      symlinkSync(join(f.root, "missing"), preferred);
    }
    const kimi = consumer(
      await inspectClientParity({ ...f.options, kimiDialect: "python-1.47" }),
      "kimi",
    );
    assert(kimi.roots.includes(join(f.project, ".agents/skills")));
    assert(!kimi.roots.includes(join(f.project, ".config/agents/skills")));
    assert.equal(kimi.roots.includes(preferred), kind === "directory");
    assert.equal(kimi.missing.includes("global"), kind === "directory");
    assert(!kimi.missing.includes("role"));
  });
}

test("Kimi Code deduplicates identical real roots before inspecting entries", async (t) => {
  const f = fixture(t);
  await f.activate();
  const kimi = consumer(await inspectClientParity(f.options), "kimi");
  assert.equal(kimi.filesystem, "matched", JSON.stringify(kimi));
  assert.equal(
    kimi.roots.filter((root) => root === realpathSync(join(f.project, ".agents/skills"))).length,
    1,
  );
  assert.equal(
    kimi.roots.filter((root) => root === realpathSync(join(f.home, ".agents/skills"))).length,
    1,
  );
});

test("Kimi Code 2.1 default inspects .kimi-code and ignores legacy .config preference", async (t) => {
  const f = fixture(t);
  await f.activate();
  f.dir(join(f.home, ".config/agents/skills"));
  f.file(
    join(f.project, ".kimi-code/skills/alien/SKILL.md"),
    "---\nname: role\ndescription: Shadow\n---\n",
  );
  const kimi = consumer(await inspectClientParity(f.options), "kimi");
  assert(kimi.canonicalConflicts.includes("role"));
  assert(!kimi.roots.some((p) => p.includes(".config/agents")));
});
