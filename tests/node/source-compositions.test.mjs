import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { createPack, createSet, executeImports, showSet, verifyPack } from "@delorenj/skillex";

function fixture(t) {
  // Receipt state must not inherit the host's Git-backed ~/.claude TMPDIR.
  const root = realpathSync(mkdtempSync("/tmp/skillex-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  const options = {
    registryRoot: registry,
    home: root,
    cwd: root,
    env: {},
    stateHome,
    timeoutMs: 10_000,
  };
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  function file(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }
  function skill(name, text = `# ${name}\n`) {
    const path = join(registry, "all-skills", name);
    file(join(path, "SKILL.md"), text);
    return path;
  }
  function sourceSkill(path, text) {
    file(join(path, "SKILL.md"), text);
    return path;
  }
  function link(path, target) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), target), path);
    return path;
  }
  function gitSource(name, build) {
    const repo = join(root, "repos", name);
    build(repo);
    const git = (args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "--quiet", "--initial-branch=main", "."]);
    git(["config", "user.email", "fixture@test"]);
    git(["config", "user.name", "fixture"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "fixture source"]);
    return { url: `file://${repo}`, commit: git(["rev-parse", "HEAD"]).trim(), repo };
  }
  return { root, registry, stateHome, options, file, skill, sourceSkill, link, gitSource };
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.mode,
      info.mtimeMs,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return rows;
}

function ok(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.ok, true);
  assert.ok(result.data);
  return result.data;
}

function refused(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((finding) => finding.code === code && finding.fix && finding.path),
    JSON.stringify(result.findings),
  );
  return result.findings;
}

function refusedCode(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((finding) => finding.code === code && finding.fix),
    JSON.stringify(result.findings),
  );
  return result.findings;
}

function memberNames(data) {
  return data.composition.skills.map((skill) => skill.name);
}

it("creates a set from a skill root of canonical links, preserving the source", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  const sources = join(f.root, "sources", "links");
  f.link(join(sources, "alpha"), alpha);
  f.link(join(sources, "beta"), beta);
  f.file(join(sources, "README.md"), "support\n");
  const before = snapshot(f.root);
  const result = await createSet("from-links", { ...f.options, fromRoot: sources });
  const data = ok(result);
  // Regression: source-backed create must actually link its members.
  assert.deepEqual(memberNames(data), ["alpha", "beta"]);
  assert.deepEqual(data.changes.map((change) => change.action).sort(), [
    "create-directory",
    "create-directory",
    "create-link",
    "create-link",
    "write-origin",
  ]);
  const setPath = join(f.registry, "sets", "from-links");
  assert.equal(realpathSync(join(setPath, "alpha")), alpha);
  assert.equal(realpathSync(join(setPath, "beta")), beta);
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "I_SOURCE_FOREIGN" && finding.path.endsWith("README.md"),
    ),
    JSON.stringify(result.findings),
  );
  // The source root is read in place and never mutated.
  const after = snapshot(f.root);
  const sourceRows = after.filter(([path]) => path.startsWith(join("sources", "links")));
  assert.deepEqual(
    sourceRows,
    before.filter(([path]) => path.startsWith(join("sources", "links"))),
  );
});

it("accepts an aliased skill root without writing through the source alias", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const source = join(f.root, "source");
  mkdirSync(source);
  f.link(join(source, "alpha"), alpha);
  const alias = join(f.root, "root-alias");
  symlinkSync(source, alias);
  const before = snapshot(source);
  const result = ok(await createSet("aliased", { ...f.options, fromRoot: alias }));
  assert.deepEqual(memberNames(result), ["alpha"]);
  assert.deepEqual(snapshot(source), before);
});

it("accepts an individual skill directory as --from and maps identical canonical bytes", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha", "# alpha\nshared body\n");
  // An individual skill path is valid: the directory's own name is the member.
  const copy = f.sourceSkill(join(f.root, "sources", "alpha"), "# alpha\nshared body\n");
  const solo = f.sourceSkill(join(f.root, "sources", "solo"), "# solo\nfresh skill\n");
  const data = ok(
    await createSet("mixed", {
      ...f.options,
      from: [copy, solo],
      import: true,
    }),
  );
  assert.deepEqual(memberNames(data), ["alpha", "solo"]);
  assert.equal(realpathSync(join(f.registry, "sets", "mixed", "alpha")), alpha);
  assert.equal(
    readFileSync(join(f.registry, "all-skills", "solo", "SKILL.md"), "utf8"),
    "# solo\nfresh skill\n",
  );
});

it("discovers nested skills through group directories and stops at SKILL.md", async (t) => {
  const f = fixture(t);
  const nested = join(f.root, "sources", "nested");
  f.sourceSkill(join(nested, "groups", "bmad", "agents", "analyst"), "# analyst\n");
  f.file(
    join(nested, "groups", "bmad", "agents", "analyst", "references", "inside.md"),
    "internal support\n",
  );
  f.sourceSkill(join(nested, "groups", "writer"), "# writer\n");
  f.sourceSkill(join(nested, "solo"), "# solo\n");
  f.file(join(nested, "groups", "assets", "plain.txt"), "not a skill\n");
  const data = ok(await createSet("deep", { ...f.options, fromRoot: nested, import: true }));
  assert.deepEqual(memberNames(data), ["analyst", "solo", "writer"]);
  // The analyst's own references/ stayed inside the skill: no "references"
  // member and no import of internal support files as members.
  assert.equal(existsSync(join(f.registry, "all-skills", "references")), false);
  assert.equal(
    readFileSync(join(f.registry, "all-skills", "analyst", "references", "inside.md"), "utf8"),
    "internal support\n",
  );
  assert.ok(
    existsSync(join(f.registry, "all-skills", "analyst", "SKILL.md")) &&
      existsSync(join(f.registry, "all-skills", "solo", "SKILL.md")) &&
      existsSync(join(f.registry, "all-skills", "writer", "SKILL.md")),
  );
});

it("refuses divergent same-name skills without selecting or importing either side", async (t) => {
  const f = fixture(t);
  f.skill("alpha", "# canonical alpha\n");
  const sources = join(f.root, "sources", "divergent");
  f.sourceSkill(join(sources, "alpha"), "# different alpha\n");
  const before = snapshot(f.root);
  const findings = refused(
    await createSet("wont-exist", { ...f.options, fromRoot: sources, import: true }),
    "E_SOURCE_DIVERGENT",
  );
  assert.ok(findings.some((finding) => finding.message.includes("digest")));
  // Refusal is write-free: no set, no canonical edits.
  assert.equal(existsSync(join(f.registry, "sets")), false);
  assert.deepEqual(snapshot(f.root), before);
});

it("maps same-name skills whose canonical bytes digest identically", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha", "# alpha\nbody\n");
  const sources = join(f.root, "sources", "identical");
  f.sourceSkill(join(sources, "alpha"), "# alpha\nbody\n");
  const data = ok(await createSet("same-bytes", { ...f.options, fromRoot: sources }));
  assert.deepEqual(memberNames(data), ["alpha"]);
  assert.equal(realpathSync(join(f.registry, "sets", "same-bytes", "alpha")), alpha);
});

it("refuses unknown source skills without --import and never skips them silently", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  const sources = join(f.root, "sources", "unknown");
  f.sourceSkill(join(sources, "alpha"), "# alpha\n");
  f.sourceSkill(join(sources, "gamma"), "# gamma\n");
  const before = snapshot(f.root);
  const findings = refused(
    await createSet("wont-exist", { ...f.options, fromRoot: sources }),
    "E_SOURCE_UNMAPPED",
  );
  assert.ok(
    findings.some((finding) => finding.fix.includes("--import") && finding.path.includes("gamma")),
    JSON.stringify(findings),
  );
  assert.equal(existsSync(join(f.registry, "sets")), false);
  assert.equal(existsSync(join(f.registry, "all-skills", "gamma")), false);
  assert.deepEqual(snapshot(f.root), before);
});

it("imports unknown source skills under --import and records them in set provenance", async (t) => {
  const f = fixture(t);
  const sources = join(f.root, "sources", "unknown");
  f.sourceSkill(join(sources, "alpha"), "# alpha\n");
  f.sourceSkill(join(sources, "gamma"), "# gamma\n");
  const data = ok(await createSet("imported", { ...f.options, fromRoot: sources, import: true }));
  assert.deepEqual(memberNames(data), ["alpha", "gamma"]);
  assert.equal(
    readFileSync(join(f.registry, "all-skills", "alpha", "SKILL.md"), "utf8"),
    "# alpha\n",
  );
  const origin = JSON.parse(
    readFileSync(join(f.registry, "sets", "imported", ".skillex-set.json"), "utf8"),
  );
  assert.equal(origin.schema, 1);
  assert.deepEqual(origin.provenance.imported, ["alpha", "gamma"]);
  assert.deepEqual(origin.provenance.sources, [{ type: "path", label: sources }]);
});

it("acquires an explicit file:// Git source once, pins its commit, and keeps provenance free of temp paths", async (t) => {
  const f = fixture(t);
  const remote = f.gitSource("skills-repo", (repo) => {
    f.sourceSkill(join(repo, "skills", "alpha"), "# alpha from git\n");
    f.sourceSkill(join(repo, "skills", "gamma"), "# gamma from git\n");
  });
  const data = ok(
    await createSet("git-set", {
      ...f.options,
      from: [remote.url],
      import: true,
    }),
  );
  assert.deepEqual(memberNames(data), ["alpha", "gamma"]);
  assert.equal(
    readFileSync(join(f.registry, "all-skills", "alpha", "SKILL.md"), "utf8"),
    "# alpha from git\n",
  );
  const originPath = join(f.registry, "sets", "git-set", ".skillex-set.json");
  const origin = JSON.parse(readFileSync(originPath, "utf8"));
  assert.deepEqual(origin.provenance.sources, [
    { type: "git", label: remote.url, commit: remote.commit },
  ]);
  assert.deepEqual(origin.provenance.imported, ["alpha", "gamma"]);
  // Provenance must be stable: no ephemeral clone directory ever appears.
  const originText = readFileSync(originPath, "utf8");
  assert.ok(!originText.includes("skillex-source-"), "origin leaked a clone temp path");
  const receipt = readFileSync(join(f.registry, "all-skills", "gamma", ".source.yaml"), "utf8");
  assert.ok(receipt.includes(`${remote.url}#${remote.commit}`), receipt);
  assert.ok(!receipt.includes("skillex-source-"), "receipt leaked the clone temp path");
});

it("sanitizes credentials from remote acquisition failures", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const findings = refusedCode(
    await createSet("nope", {
      ...f.options,
      from: ["https://user:sekrit-token@127.0.0.1:1/repo.git"],
    }),
    "E_SOURCE_ACQUIRE",
  );
  const text = JSON.stringify(findings);
  assert.ok(!text.includes("sekrit-token"), text);
  assert.ok(text.includes("[redacted]"), text);
  assert.deepEqual(snapshot(f.root), before);
});

it("repeats are write-free no-ops for sets and packs", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const sources = join(f.root, "sources", "links");
  f.link(join(sources, "alpha"), alpha);
  const first = ok(await createSet("repeat", { ...f.options, fromRoot: sources }));
  assert.ok(first.changes.some((change) => change.action === "create-link"));
  const afterFirst = snapshot(f.root);
  const second = ok(await createSet("repeat", { ...f.options, fromRoot: sources }));
  assert.deepEqual(second.changes, []);
  assert.deepEqual(memberNames(second), ["alpha"]);
  assert.deepEqual(snapshot(f.root), afterFirst);

  const solo = f.sourceSkill(join(f.root, "sources", "packsrc"), "# packed\n");
  const packFirst = ok(
    await createPack("loadout", "1.0.0", {
      ...f.options,
      from: [solo],
      import: true,
    }),
  );
  assert.ok(packFirst.changes.some((change) => change.action === "write-manifest"));
  const packAfterFirst = snapshot(f.root);
  const packSecond = ok(await createPack("loadout", "1.0.0", { ...f.options, from: [solo] }));
  assert.deepEqual(packSecond.changes, []);
  assert.deepEqual(snapshot(f.root), packAfterFirst);
});

it("source-backed pack creation records provenance, links members, and verifies green", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const remote = f.gitSource("pack-repo", (repo) => {
    f.sourceSkill(join(repo, "skills", "alpha"), "# alpha\n");
    f.sourceSkill(join(repo, "skills", "beta"), "# beta\n");
  });
  const data = ok(
    await createPack("web", "1.0.0", {
      ...f.options,
      from: [remote.url],
      import: true,
      description: "From a Git source",
    }),
  );
  assert.deepEqual(memberNames(data), ["alpha", "beta"]);
  const packRoot = join(f.registry, "packs", "web", "1.0.0");
  assert.equal(realpathSync(join(packRoot, "skills", "alpha")), alpha);
  const manifest = readFileSync(join(packRoot, "pack.toml"), "utf8");
  assert.ok(manifest.includes(`label = "${remote.url}"`), manifest);
  assert.ok(manifest.includes(`commit = "${remote.commit}"`), manifest);
  assert.ok(!manifest.includes("skillex-source-"), "pack manifest leaked a clone temp path");
  ok(await verifyPack("web@1.0.0", f.options));
});

it("dry-run source creation plans imports and compositions without mutating anything", async (t) => {
  const f = fixture(t);
  const sources = join(f.root, "sources", "unknown");
  f.sourceSkill(join(sources, "gamma"), "# gamma\n");
  const before = snapshot(f.root);
  const data = ok(
    await createSet("preview", { ...f.options, fromRoot: sources, import: true, dryRun: true }),
  );
  assert.equal(data.dryRun, true);
  assert.ok(data.changes.some((change) => change.action === "create-link"));
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(join(f.registry, "all-skills", "gamma")), false);
  assert.equal(existsSync(join(f.registry, "sets")), false);
  // The real run then lands everything the preview promised.
  ok(await createSet("preview", { ...f.options, fromRoot: sources, import: true }));
  assert.deepEqual(
    ok(await showSet("preview", f.options)).set.skills.map((skill) => skill.name),
    ["gamma"],
  );
});

it("refuses repeats whose existing members the sources do not explain, write-free", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  const sources = join(f.root, "sources", "links");
  f.link(join(sources, "alpha"), alpha);
  ok(await createSet("grown", { ...f.options, fromRoot: sources }));
  // Someone added beta by hand; the source repeat must not silently drop it.
  f.link(join(f.registry, "sets", "grown", "beta"), beta);
  const before = snapshot(f.root);
  refused(await createSet("grown", { ...f.options, fromRoot: sources }), "E_COMPOSITION_CONFLICT");
  assert.deepEqual(snapshot(f.root), before);
});

it("refuses broken member links whose canonical lost its marker", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.registry, "all-skills", "markerless"), { recursive: true });
  f.file(join(f.registry, "all-skills", "markerless", "README.md"), "no skill here\n");
  const sources = join(f.root, "sources", "broken");
  f.link(join(sources, "markerless"), join(f.registry, "all-skills", "markerless"));
  const before = snapshot(f.root);
  refused(await createSet("broken", { ...f.options, fromRoot: sources }), "E_SOURCE_BROKEN");
  assert.deepEqual(snapshot(f.root), before);
});

it("a valid first import followed by an invalid later one refuses with zero catalog or composition changes", async (t) => {
  const f = fixture(t);
  const sources = join(f.root, "sources", "mixed");
  f.sourceSkill(join(sources, "fine"), "# fine\n");
  // Invalid canonical name: planning must catch it before any import executes.
  f.sourceSkill(join(sources, "Not-A-Name"), "# bad name\n");
  const before = snapshot(f.root);
  refusedCode(
    await createSet("partial", { ...f.options, fromRoot: sources, import: true }),
    "E_SKILL_NAME",
  );
  // Zero catalog writes: the valid earlier import never ran.
  assert.equal(existsSync(join(f.registry, "all-skills", "fine")), false);
  assert.equal(existsSync(join(f.registry, "all-skills", "Not-A-Name")), false);
  assert.equal(existsSync(join(f.registry, "sets", "partial")), false);
  assert.deepEqual(snapshot(f.root), before);
});

it("an invalid set name refuses before any import executes", async (t) => {
  const f = fixture(t);
  const sources = join(f.root, "sources", "unknown");
  f.sourceSkill(join(sources, "gamma"), "# gamma\n");
  const before = snapshot(f.root);
  refused(
    await createSet("../escape", { ...f.options, fromRoot: sources, import: true }),
    "E_MANIFEST_INVALID",
    2,
  );
  assert.equal(existsSync(join(f.registry, "all-skills", "gamma")), false);
  assert.equal(existsSync(join(f.registry, "sets")), false);
  assert.deepEqual(snapshot(f.root), before);
});

it("an existing set destination that conflicts refuses before importing anything", async (t) => {
  const f = fixture(t);
  const other = f.skill("other");
  f.link(join(f.registry, "sets", "taken", "other"), other);
  const sources = join(f.root, "sources", "unknown");
  f.sourceSkill(join(sources, "gamma"), "# gamma\n");
  const before = snapshot(f.root);
  refused(
    await createSet("taken", { ...f.options, fromRoot: sources, import: true }),
    "E_COMPOSITION_CONFLICT",
  );
  // The unmapped skill was never imported: destination preflight ran first.
  assert.equal(existsSync(join(f.registry, "all-skills", "gamma")), false);
  assert.deepEqual(snapshot(f.root), before);
});

it("an existing pack destination that conflicts refuses before importing anything", async (t) => {
  const f = fixture(t);
  const other = f.skill("other");
  const packRoot = join(f.registry, "packs", "taken", "1.0.0");
  f.file(
    join(packRoot, "pack.toml"),
    `[pack]\nname="taken"\nversion="1.0.0"\n[freeform]\nskills=["other"]\n`,
  );
  f.link(join(packRoot, "skills", "other"), other);
  const sources = join(f.root, "sources", "unknown");
  f.sourceSkill(join(sources, "gamma"), "# gamma\n");
  const before = snapshot(f.root);
  refused(
    await createPack("taken", "1.0.0", { ...f.options, fromRoot: sources, import: true }),
    "E_COMPOSITION_CONFLICT",
  );
  assert.equal(existsSync(join(f.registry, "all-skills", "gamma")), false);
  assert.deepEqual(snapshot(f.root), before);
});

it("a remote source followed by an invalid local source refuses and releases the clone", async (t) => {
  const f = fixture(t);
  const remote = f.gitSource("cleanup-repo", (repo) => {
    f.sourceSkill(join(repo, "skills", "alpha"), "# alpha\n");
  });
  const cloneDirs = () =>
    readdirSync("/tmp")
      .filter((name) => name.startsWith("skillex-source-"))
      .sort();
  const before = cloneDirs();
  refusedCode(
    await createSet("nope", {
      ...f.options,
      from: [remote.url, join(f.root, "sources", "missing")],
    }),
    "E_SOURCE_NOT_FOUND",
    2,
  );
  assert.equal(existsSync(join(f.registry, "sets")), false);
  // The successful first clone was released when the second source failed.
  assert.deepEqual(cloneDirs(), before);
});

it("executeImports discloses imports that landed before a later failure, without rolling them back", async (t) => {
  const f = fixture(t);
  const first = f.sourceSkill(join(f.root, "sources", "okone"), "# okone\n");
  const second = f.sourceSkill(join(f.root, "sources", "oktwo"), "# oktwo\n");
  const planned = [
    { name: "okone", path: first, label: first },
    { name: "oktwo", path: second, label: second },
    { name: "broken", path: join(f.root, "sources", "vanished"), label: "vanished" },
  ];
  const outcome = await executeImports(planned, f.options);
  assert.deepEqual(
    outcome.executed.map((item) => item.name),
    ["okone", "oktwo"],
  );
  const text = JSON.stringify(outcome.findings);
  assert.ok(
    outcome.findings.some((finding) => finding.code === "E_IMPORT_SOURCE"),
    text,
  );
  const disclosure = outcome.findings.find((finding) => finding.code === "E_SOURCE_IMPORT_PARTIAL");
  assert.ok(disclosure, text);
  assert.ok(disclosure.message.includes("okone") && disclosure.message.includes("oktwo"), text);
  // No invented rollback: the definitions that landed remain.
  assert.equal(existsSync(join(f.registry, "all-skills", "okone")), true);
  assert.equal(existsSync(join(f.registry, "all-skills", "oktwo")), true);
});
