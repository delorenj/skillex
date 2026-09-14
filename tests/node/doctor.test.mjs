import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { doctor, importSkill, sync } from "@delorenj/skillex";

async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const registry = join(root, "catalog");
  const state = join(root, "state");
  const config = join(root, "config");
  await Promise.all([
    mkdir(home),
    mkdir(project),
    mkdir(join(registry, "all-skills"), { recursive: true }),
  ]);
  const options = {
    home,
    cwd: project,
    registryRoot: registry,
    stateHome: state,
    scope: "global",
    env: { XDG_CONFIG_HOME: config },
    processSnapshot: async () => "",
  };
  return { root, home, project, registry, state, config, options };
}

async function file(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (mode !== undefined) await chmod(path, mode);
}

async function skill(
  f,
  name = "alpha",
  content = "# Instructions\nUse this skill to finish the task.\n",
) {
  const path = join(f.registry, "all-skills", name);
  await file(join(path, "SKILL.md"), content);
  return path;
}

async function manifest(root, raw) {
  await file(join(root, ".agents", "skills.json"), `${JSON.stringify(raw)}\n`);
}

async function healthy(t, scope = "global") {
  const f = await fixture(t);
  await skill(f);
  const root = scope === "global" ? f.home : f.project;
  await manifest(root, { skills: ["alpha"], inherit_global: false });
  f.options.scope = scope;
  const applied = await sync(f.options);
  assert.equal(applied.exit, 0, JSON.stringify(applied));
  return f;
}

async function pack(f, name, names, version) {
  const path = join(f.registry, "packs", name, ...(version ? [version] : []));
  await file(
    join(path, "pack.toml"),
    `[pack]\nname = "${name}"\nversion = "${version ?? "1.0.0"}"\n[freeform]\nskills = ${JSON.stringify(names)}\n`,
  );
  await mkdir(join(path, "skills"));
  for (const name of names)
    await symlink(
      relative(join(path, "skills"), join(f.registry, "all-skills", name)),
      join(path, "skills", name),
    );
  return path;
}

async function snapshot(root) {
  const out = [];
  const visit = async (path) => {
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file";
    out.push([
      relative(root, path),
      kind,
      info.mode,
      info.ino,
      info.mtimeMs,
      kind === "link"
        ? await readlink(path)
        : kind === "file"
          ? (await readFile(path)).toString("hex")
          : "",
    ]);
    if (kind === "directory")
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root);
  return out;
}

function finding(result, code, path) {
  const match = result.findings.find(
    (item) => item.code === code && (path === undefined || item.path === path),
  );
  assert.ok(match, `${code} ${path ?? ""}: ${JSON.stringify(result)}`);
  assert.ok(match.fix);
  return match;
}

function legacyDigest(files) {
  const text = files
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([path, content, executable]) =>
        `${executable ? "100755" : "100644"} ${createHash("sha256").update(content).digest("hex")}  ${path}\n`,
    )
    .join("");
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function upstream(f, path, extra = "") {
  await file(
    join(f.registry, "all-skills", "sources.toml"),
    'version = 1\n[[source]]\nname = "upstream"\nrepo = "https://example.test/skills.git"\nversion = "main"\n',
  );
  await file(
    join(path, ".source.yaml"),
    `origin:\n  type: vendored\n  source: upstream\n  upstream: https://example.test/skills.git\n${extra}`,
  );
}

test("sources-only is write-free and independent of missing scope, state, and process paths", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const result = await doctor({
    ...f.options,
    sourcesOnly: true,
    project: join(f.root, "missing"),
    stateHome: "",
    processSnapshot: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.schema, 2);
  assert.equal(result.command, "doctor");
  assert.equal(result.data.status, null);
  assert.equal(result.data.writers, null);
  assert.deepEqual(result.data.sources[0], {
    registry: { root: f.registry, source: "argument", searched: [f.registry] },
    canonicalSkills: 0,
    sets: 0,
    packs: 0,
    provenance: 0,
    digestsChecked: 0,
  });
  assert.deepEqual(await snapshot(f.root), before);
});

test("source audit accepts absent frontmatter and ordinary support content", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(join(path, "references", "guide.md"), "Guide\n");
  await skill(f, "beta", "---\ndescription: A useful skill\n---\nDo work.\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.data.sources[0].canonicalSkills, 2);
});

test("hidden and dormant composition copies are all reported", async (t) => {
  const f = await fixture(t);
  await skill(f);
  const paths = [
    join(f.registry, "sets", ".retired", "one", "SKILL.md"),
    join(f.registry, "packs", "_archive", "two", "SKILL.md"),
    join(f.registry, "packs", "_archive", "three", "SKILL.md"),
  ];
  for (const path of paths) await file(path, "Copied instructions\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  for (const path of paths) finding(result, "E_NONCANONICAL_REFERENCE", path);
});

test("source audit aggregates catalog links, off-catalog references, and dangling references", async (t) => {
  const f = await fixture(t);
  const canonical = await skill(f);
  const foreign = join(f.root, "foreign");
  await file(join(foreign, "SKILL.md"), "Foreign\n");
  await mkdir(join(f.registry, "sets", ".hidden"), { recursive: true });
  const outside = join(f.registry, "sets", ".hidden", "outside");
  const dangling = join(f.registry, "sets", ".hidden", "dangling");
  const linked = join(f.registry, "all-skills", "linked");
  await symlink(foreign, outside);
  await symlink(join(f.root, "missing"), dangling);
  await symlink(canonical, linked);
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  for (const path of [outside, dangling, linked]) finding(result, "E_NONCANONICAL_REFERENCE", path);
});

test("a linked canonical SKILL.md is refused", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(join(f.root, "instructions.md"), "Instructions\n");
  await rm(join(path, "SKILL.md"));
  await symlink(join(f.root, "instructions.md"), join(path, "SKILL.md"));
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_NONCANONICAL_REFERENCE", join(path, "SKILL.md"));
});

test("sets accept canonical references and their own support assets", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  const set = join(f.registry, "sets", "daily");
  await file(join(set, "references", "guide.md"), "Composition documentation\n");
  await symlink(path, join(set, "alpha"));
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.data.sources[0].sets, 1);
});

test("set member names cannot disguise a different canonical skill", async (t) => {
  const f = await fixture(t);
  await skill(f);
  const beta = await skill(f, "beta");
  const set = join(f.registry, "sets", "daily");
  await mkdir(set, { recursive: true });
  await symlink(beta, join(set, "alpha"));
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_NONCANONICAL_REFERENCE", join(set, "alpha"));
});

test("all pack versions are audited, including an inactive older version", async (t) => {
  const f = await fixture(t);
  await skill(f);
  const old = await pack(f, "daily", ["alpha"], "1.0.0");
  await pack(f, "daily", ["alpha"], "2.0.0");
  await rm(join(old, "skills", "alpha"));
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  assert.equal(result.data.sources[0].packs, 2);
  finding(result, "E_PACK_LINK_MISSING", join(old, "skills", "alpha"));
});

test("pack verification aggregates missing, extra, and wrong-target members", async (t) => {
  const f = await fixture(t);
  await skill(f);
  const beta = await skill(f, "beta");
  const path = await pack(f, "daily", ["alpha", "beta"]);
  await rm(join(path, "skills", "beta"));
  await rm(join(path, "skills", "alpha"));
  await symlink(beta, join(path, "skills", "alpha"));
  await file(join(path, "skills", "foreign.txt"), "Foreign\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_PACK_LINK_MISSING");
  finding(result, "E_PACK_LINK_EXTRA");
  finding(result, "E_PACK_LINK_TARGET");
});

test("malformed and legacy pack manifests retain configuration failures", async (t) => {
  const f = await fixture(t);
  await file(join(f.registry, "packs", "broken", "pack.toml"), "[pack\n");
  await file(join(f.registry, "packs", "legacy", "pack.toml"), "[slots]\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 2);
  finding(result, "E_PACK_MANIFEST_INVALID");
  finding(result, "E_LEGACY_FIELD");
});

test("a pack directory without any manifest remains a failure", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.registry, "packs", "empty"), { recursive: true });
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_PACK_MANIFEST_MISSING");
});

test("malformed provenance is a configuration failure", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(join(path, ".source.yaml"), "origin: [unterminated\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 2);
  finding(result, "E_SKILL_PROVENANCE_INVALID", join(path, ".source.yaml"));
});

test("invalid SKILL.md frontmatter is a configuration failure", async (t) => {
  const f = await fixture(t);
  await skill(f, "alpha", "---\ndescription: [invalid]\n---\nInstructions\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 2);
  finding(result, "E_SKILL_METADATA_INVALID");
});

test("known provenance fields reject incorrect types", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(join(path, ".source.yaml"), "origin:\n  digest: false\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 2);
  finding(result, "E_SKILL_PROVENANCE_INVALID");
});

test("upstream provenance requires a source manifest without resolving an upstream checkout", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(join(path, ".source.yaml"), "origin:\n  type: vendored\n  source: upstream\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_SOURCES_MANIFEST_MISSING", join(f.registry, "all-skills", "sources.toml"));
});

test("upstream provenance requires a matching named source declaration", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await upstream(f, path);
  await file(join(path, ".source.yaml"), "origin:\n  type: vendored\n  source: missing\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_SOURCE_DECLARATION_MISSING");
});

test("source declarations are parsed even without upstream skills", async (t) => {
  const f = await fixture(t);
  await file(join(f.registry, "all-skills", "sources.toml"), "[[source]\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 2);
  finding(result, "E_SOURCES_MANIFEST_INVALID");
});

test("provenance cannot silently switch its declared upstream identity", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await upstream(f, path);
  await file(
    join(path, ".source.yaml"),
    "origin:\n  type: vendored\n  source: upstream\n  upstream: https://elsewhere.test/repo.git\n",
  );
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_SOURCE_IDENTITY_MISMATCH");
});

test("imported bytes and modes verify, then byte edits report drift without writes", async (t) => {
  const f = await fixture(t);
  const source = join(f.root, "import");
  await file(join(source, "SKILL.md"), "Imported instructions\n");
  await file(join(source, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  const imported = await importSkill(source, "alpha", f.options);
  assert.equal(imported.exit, 0, JSON.stringify(imported));
  const initial = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(initial.exit, 0, JSON.stringify(initial));
  assert.equal(initial.data.sources[0].digestsChecked, 1);
  await file(join(imported.data.path, "SKILL.md"), "Locally edited instructions\n");
  const before = await snapshot(f.root);
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 6);
  finding(result, "W_SKILL_DIGEST_DRIFT");
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), "Imported instructions\n");
});

test("executable mode changes count as digest drift", async (t) => {
  const f = await fixture(t);
  const source = join(f.root, "import");
  await file(join(source, "SKILL.md"), "Instructions\n");
  await file(join(source, "run.sh"), "echo ready\n", 0o755);
  const imported = await importSkill(source, "alpha", f.options);
  assert.equal(imported.exit, 0);
  await chmod(join(imported.data.path, "run.sh"), 0o644);
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 6);
  finding(result, "W_SKILL_DIGEST_DRIFT");
});

test("legacy vendored digests include all regular files and ignore only root provenance", async (t) => {
  const f = await fixture(t);
  const path = await skill(f, "alpha", "Instructions\n");
  await file(join(path, "authored.log"), "Authored log fixture\n");
  await file(join(path, "run.sh"), "echo ready\n", 0o755);
  const digest = legacyDigest([
    ["SKILL.md", "Instructions\n", false],
    ["authored.log", "Authored log fixture\n", false],
    ["run.sh", "echo ready\n", true],
  ]);
  await upstream(
    f,
    path,
    `  digest: ${digest}\nmodified_locally: false\nnotes: preserved evidence\n`,
  );
  const initial = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(initial.exit, 0, JSON.stringify(initial));
  await file(join(path, "authored.log"), "Changed bytes\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 6);
  finding(result, "W_SKILL_DIGEST_DRIFT");
});

test("repository administration cannot be silently dropped from a vendored digest", async (t) => {
  const f = await fixture(t);
  const path = await skill(f, "alpha", "Instructions\n");
  await file(join(path, ".git", "config"), "Repository metadata\n");
  await upstream(f, path, `  digest: ${legacyDigest([["SKILL.md", "Instructions\n", false]])}\n`);
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 3);
  finding(result, "E_PROVENANCE_CONTENT_UNSAFE", join(path, ".git"));
});

test("unsupported digest formats are incomplete observations", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(
    join(path, ".source.yaml"),
    `origin:\n  type: local\n  digest: sha256:${"0".repeat(64)}\n  digest_format: future-format\n`,
  );
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 4);
  finding(result, "W_SKILL_DIGEST_UNSUPPORTED");
});

test("safe imported symlinks verify their actual stored target bytes", async (t) => {
  const f = await fixture(t);
  const source = join(f.root, "import");
  await file(join(source, "SKILL.md"), "Instructions\n");
  await file(join(source, "data.txt"), "Support\n");
  await symlink("data.txt", join(source, "alias.txt"));
  const imported = await importSkill(source, "alpha", f.options);
  assert.equal(imported.exit, 0);
  const first = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(first.exit, 0, JSON.stringify(first));
  await rm(join(imported.data.path, "alias.txt"));
  await symlink(join(imported.data.path, "data.txt"), join(imported.data.path, "alias.txt"));
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 6);
  finding(result, "W_SKILL_DIGEST_DRIFT");
});

test("full doctor retains source findings and actual status when resolution refuses", async (t) => {
  const f = await healthy(t);
  await manifest(f.home, { skills: "invalid" });
  const copy = join(f.registry, "sets", ".retired", "SKILL.md");
  await file(copy, "Copied instructions\n");
  const result = await doctor(f.options);
  assert.equal(result.exit, 2, JSON.stringify(result));
  finding(result, "E_NONCANONICAL_REFERENCE", copy);
  assert.ok(result.findings.some((item) => item.path === join(f.home, ".agents", "skills.json")));
  assert.ok(result.data.status.scopes[0].actual.entries.some((entry) => entry.name === "alpha"));
});

test("healthy full doctor does not mutate source, manifests, activation, or state", async (t) => {
  const f = await healthy(t);
  const before = await snapshot(f.root);
  const result = await doctor(f.options);
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.data.status.scopes[0].counts.owned, 1);
  assert.equal(result.data.writers.processObservation, "complete");
  assert.deepEqual(await snapshot(f.root), before);
});

test("configured mise tasks and user services have exact file and line evidence", async (t) => {
  const f = await healthy(t);
  const mise = join(f.home, "mise.toml");
  const service = join(f.config, "systemd", "user", "legacy.service");
  await file(mise, '[tasks.legacy]\nrun = "uv run /legacy/sync-skills.py"\n');
  await file(service, "[Service]\nExecStart=/usr/bin/python3 /legacy/skill_ssot.py sweep\n");
  const result = await doctor(f.options);
  assert.equal(result.exit, 6);
  assert.deepEqual(
    result.data.writers.configured.map(({ path, line, kind }) => ({ path, line, kind })),
    [
      { path: service, line: 2, kind: "service" },
      { path: mise, line: 2, kind: "mise" },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.deepEqual(result.data.writers.running, []);
  finding(result, "W_LEGACY_WRITER_CONFIGURED", mise);
  finding(result, "W_LEGACY_WRITER_CONFIGURED", service);
});

test("comments, descriptions, and echo commands do not configure a legacy writer", async (t) => {
  const f = await healthy(t);
  await file(
    join(f.home, "mise.toml"),
    '# run = "uv run /legacy/sync-skills.py"\n[tasks.notes]\ndescription = "uv run /legacy/sync-skills.py"\nrun = "echo /legacy/sync-skills.py"\n',
  );
  await file(
    join(f.config, "systemd", "user", "notes.service"),
    "# ExecStart=/usr/bin/python3 /legacy/sync-skills.py\n[Unit]\nDescription=python3 /legacy/sync-skills.py\n[Service]\nExecStart=/bin/echo /legacy/sync-skills.py\n",
  );
  const result = await doctor(f.options);
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.deepEqual(result.data.writers.configured, []);
});

test("project writer discovery includes ancestor hooks but not unrelated registry tasks", async (t) => {
  const f = await healthy(t, "project");
  const parent = join(f.root, "mise.toml");
  const unrelated = join(f.registry, "mise.toml");
  await file(parent, '[hooks]\nenter = "uv run /legacy/provision-packs.py"\n');
  await file(unrelated, '[tasks.legacy]\nrun = "uv run /legacy/sync-skills.py"\n');
  const result = await doctor(f.options);
  assert.equal(result.exit, 6);
  finding(result, "W_LEGACY_WRITER_CONFIGURED", parent);
  assert.ok(!result.data.writers.configured.some((entry) => entry.path === unrelated));
});

test("running writer evidence recognizes only actual interpreter, uv, or script entrypoints", async (t) => {
  const f = await healthy(t);
  const commands = [
    "/usr/bin/python3 /legacy/sync-skills.py --global",
    "/usr/bin/uv run /legacy/provision-packs.py",
    "/usr/bin/python3 -m skillex sync",
    "/usr/bin/python3 /legacy/bin/skillex sync",
    "/usr/bin/uv run skillex sync",
    "/legacy/skill_ssot.py rescue /skills/copied",
    "/usr/bin/bash /legacy/skill-ssot-daemon.sh",
  ];
  const result = await doctor({
    ...f.options,
    processSnapshot: async () =>
      commands.map((command, index) => `${4000 + index} ${command}`).join("\n"),
  });
  assert.equal(result.exit, 6);
  assert.deepEqual(
    result.data.writers.running.map((entry) => entry.pid),
    commands.map((_, index) => 4000 + index),
  );
  assert.equal(
    result.findings.filter((item) => item.code === "W_LEGACY_WRITER_RUNNING").length,
    commands.length,
  );
});

test("arbitrary argv and read-only Python invocations do not prove a running writer", async (t) => {
  const f = await healthy(t);
  const commands = [
    "node -e 'console.log(\"python3 /legacy/sync-skills.py\")'",
    "/usr/bin/python3 -c 'print(\"/legacy/sync-skills.py\")'",
    "/bin/echo python3 /legacy/sync-skills.py",
    "/usr/bin/grep sync-skills.py",
    "/bin/sh -c 'python3 /legacy/sync-skills.py'",
    "/usr/bin/python3 /legacy/skill_ssot.py doctor",
    "/usr/bin/python3 /legacy/skill_ssot.py list-paths",
    "/usr/bin/uv run skillex status",
    "/usr/bin/python3 -m skillex sync --dry-run",
    "/bin/skillex sync",
  ];
  const result = await doctor({
    ...f.options,
    processSnapshot: async () =>
      commands.map((command, index) => `${5000 + index} ${command}`).join("\n"),
  });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.deepEqual(result.data.writers.running, []);
});

test("unavailable process observation is partial and cannot claim a clean writer check", async (t) => {
  const f = await healthy(t);
  const result = await doctor({
    ...f.options,
    processSnapshot: async () => {
      throw new Error("unavailable");
    },
  });
  assert.equal(result.exit, 4);
  assert.equal(result.data.writers.processObservation, "unknown");
  assert.deepEqual(result.data.writers.running, []);
  finding(result, "W_PROCESS_OBSERVATION_UNKNOWN");
});

test("malformed process output preserves already observed writers but remains incomplete", async (t) => {
  const f = await healthy(t);
  const result = await doctor({
    ...f.options,
    processSnapshot: async () =>
      "4000 /usr/bin/python3 /legacy/sync-skills.py\nnot a process row\n",
  });
  assert.equal(result.exit, 4);
  assert.equal(result.data.writers.running[0].pid, 4000);
  assert.equal(result.data.writers.processObservation, "unknown");
  finding(result, "W_PROCESS_OBSERVATION_UNKNOWN");
  finding(result, "W_LEGACY_WRITER_RUNNING");
});

test("default process observation executes bounded ps with injected environment", async (t) => {
  const f = await healthy(t);
  const bin = join(f.root, "bin");
  await file(
    join(bin, "ps"),
    `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '-axo pid=,args=') process.exit(9);\nprocess.stdout.write('4321 /usr/bin/python3 /legacy/sync-skills.py\\n');\n`,
    0o755,
  );
  const options = { ...f.options, env: { ...f.options.env, PATH: bin } };
  delete options.processSnapshot;
  const result = await doctor(options);
  assert.equal(result.exit, 6);
  assert.equal(result.data.writers.processObservation, "complete");
  assert.equal(result.data.writers.running[0].pid, 4321);
});

test("missing ps is an unknown observation rather than an empty healthy table", async (t) => {
  const f = await healthy(t);
  const options = { ...f.options, env: { ...f.options.env, PATH: join(f.root, "no-programs") } };
  delete options.processSnapshot;
  const result = await doctor(options);
  assert.equal(result.exit, 4);
  finding(result, "W_PROCESS_OBSERVATION_UNKNOWN");
});

test("malformed applicable writer configuration is an incomplete observation", async (t) => {
  const f = await healthy(t);
  const path = join(f.home, "mise.toml");
  await file(path, "[tasks\n");
  const result = await doctor(f.options);
  assert.equal(result.exit, 4);
  finding(result, "W_WRITER_CONFIG_UNREADABLE", path);
});

test("an interrupted doctor returns a shaped incomplete result without observations or writes", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const result = await doctor({ ...f.options, signal: { aborted: true } });
  assert.equal(result.exit, 130);
  assert.deepEqual(result.data.sources, []);
  assert.equal(result.data.status, null);
  assert.equal(result.data.writers, null);
  finding(result, "E_INTERRUPTED");
  assert.deepEqual(await snapshot(f.root), before);
});

test("sources-only validates the selected manifest while preserving topology findings", async (t) => {
  const f = await fixture(t);
  const selected = join(f.project, ".agents", "skills.json");
  await file(selected, "{ broken JSON\n");
  const copied = join(f.registry, "sets", ".old", "SKILL.md");
  await file(copied, "Copied instructions\n");
  const before = await snapshot(f.root);
  const result = await doctor({ ...f.options, sourcesOnly: true, scope: "project" });
  assert.equal(result.exit, 2, JSON.stringify(result));
  finding(result, "E_MANIFEST_PARSE", selected);
  finding(result, "E_NONCANONICAL_REFERENCE", copied);
  assert.equal(result.data.status, null);
  assert.equal(result.data.writers, null);
  assert.deepEqual(await snapshot(f.root), before);
});

test("sources-only honors an explicit missing project selector", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "missing-project");
  const result = await doctor({ ...f.options, sourcesOnly: true, scope: "project", project: path });
  assert.equal(result.exit, 2);
  finding(result, "E_PROJECT_ROOT", path);
  assert.equal(result.data.sources.length, 1);
});

test("sources-only follows each selected manifest registry without reading activation state", async (t) => {
  const f = await fixture(t);
  const urls = ["https://example.test/global.git", "https://example.test/project.git"];
  const roots = urls.map((url) =>
    join(f.home, ".agents", ".cache", "registries", url.replace(/[^a-zA-Z0-9]/g, "_")),
  );
  for (const root of roots) await mkdir(join(root, "all-skills"), { recursive: true });
  await manifest(f.home, { registry: urls[0], skills: [] });
  await manifest(f.project, { registry: urls[1], skills: [], inherit_global: false });
  const copied = join(roots[1], "packs", "_archive", "SKILL.md");
  await file(copied, "Old copied payload\n");
  await file(join(f.state, "not-a-valid-receipt.json"), "Broken runtime state\n");
  await symlink(join(f.root, "missing-activation"), join(f.project, ".agents", "skills"));
  const options = {
    ...f.options,
    sourcesOnly: true,
    scope: "both",
    stateHome: "",
    installedRoot: join(f.root, "not-installed"),
  };
  delete options.registryRoot;
  const before = await snapshot(f.root);
  const result = await doctor(options);
  assert.equal(result.exit, 3, JSON.stringify(result));
  assert.deepEqual(result.data.sources.map((source) => source.registry.root).sort(), roots.sort());
  finding(result, "E_NONCANONICAL_REFERENCE", copied);
  assert.ok(
    !result.findings.some(
      (item) => item.code.startsWith("E_ACTIVATION") || item.code.includes("RECEIPT"),
    ),
  );
  assert.deepEqual(await snapshot(f.root), before);
});

test("array-shaped provenance origin is rejected instead of becoming empty metadata", async (t) => {
  const f = await fixture(t);
  const path = await skill(f);
  await file(join(path, ".source.yaml"), "origin: []\n");
  const result = await doctor({ ...f.options, sourcesOnly: true });
  assert.equal(result.exit, 2);
  finding(result, "E_SKILL_PROVENANCE_INVALID", join(path, ".source.yaml"));
});

test("unresolved configured shell wrappers retain candidate evidence without claiming an invocation", async (t) => {
  const f = await healthy(t);
  const path = join(f.home, "mise.toml");
  await file(path, '[tasks.legacy]\nrun = "cd /repo && uv run /legacy/sync-skills.py"\n');
  const result = await doctor(f.options);
  assert.equal(result.exit, 4);
  const evidence = finding(result, "W_LEGACY_WRITER_CANDIDATE", path);
  assert.ok(evidence.detail.some((line) => line.startsWith("line 2:")));
  assert.deepEqual(result.data.writers.configured, []);
  assert.deepEqual(result.data.writers.running, []);
});

test("interpreter and uv help flags cannot masquerade as writer execution", async (t) => {
  const f = await healthy(t);
  const commands = [
    "/usr/bin/python3 --help /legacy/sync-skills.py",
    "/usr/bin/python3 -V /legacy/sync-skills.py",
    "/usr/bin/uv run --help /legacy/sync-skills.py",
  ];
  const result = await doctor({
    ...f.options,
    processSnapshot: async () =>
      commands.map((command, index) => `${6000 + index} ${command}`).join("\n"),
  });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.deepEqual(result.data.writers.running, []);
});
