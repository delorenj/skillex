import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Receipt guards forbid repository ancestors, including ~/.claude; use isolated OS temp state.
const temp = () =>
  process.env.SKILLEX_TEST_TMP ?? (process.platform === "linux" ? "/tmp" : tmpdir());
const repository = fileURLToPath(new URL("../../", import.meta.url));

async function fixture(t) {
  const base = realpathSync(mkdtempSync(join(temp(), "skillex-root-adopt-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const directory = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, text) => {
    directory(dirname(path));
    writeFileSync(path, text);
    return path;
  };
  const project = directory(join(base, "project"));
  const home = directory(join(base, "home"));
  const registry = directory(join(base, "registry"));
  const root = directory(join(project, ".agents", "skills"));
  const global = directory(join(home, ".agents", "skills"));
  file(join(project, ".agents", "skills.json"), '{"inherit_global":true,"skills":["alpha"]}\n');
  file(join(home, ".agents", "skills.json"), '{"sets":["general","developer"]}\n');
  const skill = (name) => {
    const path = directory(join(registry, "all-skills", name));
    file(join(path, "SKILL.md"), `# ${name}\n`);
    file(join(path, "references", "usage.txt"), `Authored support for ${name}\n`);
    return path;
  };
  const alpha = skill("alpha");
  const liam = skill("liam-dev");
  symlinkSync(alpha, join(root, "alpha"));
  symlinkSync("../../../deleted/liam", join(root, "liam"));
  symlinkSync(alpha, join(global, "alpha"));
  directory(join(project, ".claude"));
  symlinkSync("../.agents/skills", join(project, ".claude", "skills"));
  file(join(project, ".codex", "skills", ".system", "untouched"), "installer-owned\n");
  directory(join(base, "node_modules", "@delorenj"));
  symlinkSync(repository, join(base, "node_modules", "@delorenj", "skillex"));
  for (const dependency of Object.keys(
    JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).dependencies,
  ))
    symlinkSync(
      join(repository, "node_modules", dependency),
      join(base, "node_modules", dependency),
    );
  const module = join(base, "root-cutover.mjs");
  await build({
    absWorkingDir: repository,
    stdin: {
      contents:
        "export {adoptRoot} from './src/core/root-cutover.ts'; export {sync} from './src/core/reconciliation.ts';",
      resolveDir: repository,
      sourcefile: "root-adoption-fixture.ts",
      loader: "ts",
    },
    outfile: module,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const { adoptRoot, sync } = await import(module);
  const options = {
    project,
    registryRoot: registry,
    home,
    cwd: project,
    stateHome: join(base, "state"),
    env: {},
    map: ["liam=liam-dev"],
    timeoutMs: 10_000,
  };
  return {
    base,
    project,
    home,
    registry,
    root,
    alpha,
    liam,
    module,
    adoptRoot,
    sync,
    options,
    directory,
    file,
    skill,
  };
}
function replacementFixture(f) {
  const version = "6.12.1-next.1";
  const members = ["bmad-build", "bmad-help", "bmad-new"];
  const pack = f.directory(join(f.registry, "packs", "bmad", version));
  const packLinks = f.directory(join(pack, "skills"));
  f.file(
    join(pack, "pack.toml"),
    `[pack]\nname = "bmad"\nversion = "${version}"\n[freeform]\nskills = ${JSON.stringify(members)}\n[source]\ntype = "bmad-freeze"\nbmad_version = "${version}"\n`,
  );
  for (const name of members) {
    const canonical = f.skill(name);
    f.file(join(canonical, "SKILL.md"), `---\nname: ${name}\n---\n# canonical ${version}\n`);
    f.file(
      join(canonical, ".source.yaml"),
      `origin:\n  type: bmad-freeze\n  bmad_version: ${version}\n`,
    );
    symlinkSync(canonical, join(packLinks, name));
  }
  for (const name of ["bmad-build", "bmad-help", "bmad-old-stub"]) {
    f.file(
      join(f.root, name, "SKILL.md"),
      `---\nname: ${name}\n---\n# installer-owned next.0 ${name}\n`,
    );
    f.file(join(f.root, name, "references", "notes.txt"), `local ${name} notes never deleted\n`);
  }
  f.file(join(f.project, "_bmad", "_config", "manifest.yaml"), "version: 6.12.1-next.0\n");
  return {
    pack,
    members,
    options: { ...f.options, replacePack: `bmad@${version}`, replacePrefix: "bmad-" },
  };
}
function snapshot(root) {
  const rows = [];
  const walk = (path) => {
    const stat = lstatSync(path);
    rows.push([
      relative(root, path),
      stat.ino,
      stat.mode,
      stat.mtimeMs,
      stat.isSymbolicLink()
        ? readlinkSync(path)
        : stat.isFile()
          ? readFileSync(path).toString("hex")
          : "directory",
    ]);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return rows;
}
async function immutable(f, action) {
  const before = snapshot(f.base);
  const result = await action();
  assert.deepEqual(snapshot(f.base), before);
  return result;
}
function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result, null, 2));
  return result.data;
}
function receipt(path) {
  return JSON.parse(readFileSync(path, "utf8")).data;
}
function injected(f, injection, options = f.options) {
  const source = `import {createRequire,syncBuiltinESMExports} from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises');
${injection}
syncBuiltinESMExports();
const {adoptRoot} = await import(${JSON.stringify(f.module)});
process.stdout.write(JSON.stringify(await adoptRoot(${JSON.stringify({ ...options, apply: true })})));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: repository,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("explicit broken rename inventories and preserves the complete root, manifests, catalog and aliases", async (t) => {
  const f = await fixture(t);
  const original = snapshot(f.root);
  const catalog = snapshot(f.registry);
  const global = snapshot(f.home);
  const aliases = [".claude", ".codex"].map((name) => snapshot(join(f.project, name)));
  const manifest = readFileSync(join(f.project, ".agents", "skills.json"), "utf8");
  const preview = ok(await immutable(f, () => f.adoptRoot(f.options)));
  assert.deepEqual(
    preview.inventory.map((item) => [item.name, item.action]),
    [
      ["alpha", "adopt"],
      ["liam", "map"],
    ],
  );
  assert.deepEqual(preview.changes, [
    "quarantine-original-root",
    "publish-canonical-links",
    "adopt-root",
  ]);
  assert.equal(existsSync(f.options.stateHome), false);
  const applied = ok(await f.adoptRoot({ ...f.options, apply: true }));
  assert.ok(applied.applied);
  assert.ok(!applied.quarantine.startsWith(f.project));
  assert.deepEqual(snapshot(applied.quarantine), original);
  assert.equal(readlinkSync(join(applied.quarantine, "liam")), "../../../deleted/liam");
  assert.deepEqual(readdirSync(f.root).sort(), ["alpha", "liam-dev"]);
  assert.equal(realpathSync(join(f.root, "liam-dev")), f.liam);
  const ownership = receipt(applied.receipt);
  assert.equal(ownership.directories[f.root].ino, String(lstatSync(f.root).ino));
  assert.deepEqual(Object.keys(ownership.links).sort(), [
    join(f.root, "alpha"),
    join(f.root, "liam-dev"),
  ]);
  assert.equal(receipt(applied.journal).phase, "complete");
  assert.deepEqual(snapshot(f.registry), catalog);
  assert.deepEqual(snapshot(f.home), global);
  assert.deepEqual(
    [".claude", ".codex"].map((name) => snapshot(join(f.project, name))),
    aliases,
  );
  assert.equal(readFileSync(join(f.project, ".agents", "skills.json"), "utf8"), manifest);
  assert.deepEqual(
    ok(await immutable(f, () => f.adoptRoot({ ...f.options, apply: true }))).changes,
    [],
  );
  assert.deepEqual(
    ok(await immutable(f, () => f.adoptRoot({ ...f.options, map: [] }))).changes,
    [],
  );
});

test("adopted ownership allows a later set switch without losing the quarantined original", async (t) => {
  const f = await fixture(t);
  rmSync(join(f.project, ".codex"), { recursive: true });
  const adopted = ok(await f.adoptRoot({ ...f.options, apply: true }));
  const original = snapshot(adopted.quarantine);
  const global = snapshot(f.home);
  const selected = f.directory(join(f.registry, "sets", "pilot"));
  for (const [name, target] of [
    ["alpha", f.alpha],
    ["liam-dev", f.liam],
  ])
    symlinkSync(target, join(selected, name));
  f.file(
    join(f.project, ".agents", "skills.json"),
    JSON.stringify({ inherit_global: false, sets: ["pilot"] }),
  );
  const synced = await f.sync({ ...f.options, scope: "project" });
  ok(synced);
  assert.equal(lstatSync(f.root).isSymbolicLink(), true);
  assert.equal(realpathSync(f.root), selected);
  assert.deepEqual(snapshot(adopted.quarantine), original);
  assert.deepEqual(snapshot(f.home), global);
  const rerun = ok(await immutable(f, () => f.adoptRoot({ ...f.options, apply: true })));
  assert.deepEqual(rerun.changes, []);
  assert.equal(realpathSync(f.root), selected);
});

test("unowned known-good links adopt in place with no root or link inode changes", async (t) => {
  const f = await fixture(t);
  unlinkSync(join(f.root, "liam"));
  const root = snapshot(f.root);
  const applied = ok(await f.adoptRoot({ ...f.options, map: [], apply: true }));
  assert.equal(applied.quarantine, null);
  assert.deepEqual(snapshot(f.root), root);
  assert.equal(existsSync(applied.journal), false);
  assert.deepEqual(
    ok(await immutable(f, () => f.adoptRoot({ ...f.options, map: [], apply: true }))).changes,
    [],
  );
});

test("all preflight refusals are write-free, including apply, and never guess liam-dev", async (t) => {
  for (const [name, mutate, options] of [
    ["missing mapping", () => {}, { map: [] }],
    ["missing canonical", () => {}, { map: ["liam=missing"] }],
    ["stale mapping", () => {}, { map: ["liam=liam-dev", "missing=alpha"] }],
    ["duplicate mapping", () => {}, { map: ["liam=liam-dev", "liam=alpha"] }],
    ["mapping collision", () => {}, { map: ["liam=alpha"] }],
    ["unsafe mapping", () => {}, { map: ["liam=../liam-dev"] }],
    ["foreign entry", (f) => f.file(join(f.root, "local", "SKILL.md"), "local edits\n"), {}],
    ["metadata", (f) => f.file(join(f.root, "README.md"), "retain me\n"), {}],
    [
      "different real bytes",
      (f) => f.file(join(f.root, "local", "SKILL.md"), "different\n"),
      { map: ["liam=liam-dev", "local=alpha"] },
    ],
    [
      "symlink canonical SKILL",
      (f) => {
        rmSync(join(f.liam, "SKILL.md"));
        symlinkSync(join(f.alpha, "SKILL.md"), join(f.liam, "SKILL.md"));
      },
      {},
    ],
    ["conflicting modes", () => {}, { dryRun: true }],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t);
      mutate(f);
      const result = await immutable(f, () =>
        f.adoptRoot({ ...f.options, ...options, apply: true }),
      );
      assert.ok([2, 3].includes(result.exit), JSON.stringify(result));
      assert.equal(existsSync(f.options.stateHome), false);
    });
});

test("explicit byte-equivalent local definitions become links with every original byte quarantined", async (t) => {
  const f = await fixture(t);
  f.file(join(f.root, "local", "SKILL.md"), "# alpha\n");
  f.file(join(f.root, "local", "references", "usage.txt"), "Authored support for alpha\n");
  unlinkSync(join(f.root, "alpha"));
  const before = snapshot(f.root);
  const options = { ...f.options, map: ["liam=liam-dev", "local=alpha"] };
  ok(await immutable(f, () => f.adoptRoot(options)));
  const data = ok(await f.adoptRoot({ ...options, apply: true }));
  assert.deepEqual(snapshot(data.quarantine), before);
  assert.equal(realpathSync(join(f.root, "alpha")), f.alpha);
  assert.deepEqual(
    ok(await immutable(f, () => f.adoptRoot({ ...options, apply: true }))).changes,
    [],
  );
});

test("foreign equivalent links require mapping and preserve their targets", async (t) => {
  const f = await fixture(t);
  const external = f.directory(join(f.base, "external"));
  f.file(join(external, "SKILL.md"), "# alpha\n");
  f.file(join(external, "references", "usage.txt"), "Authored support for alpha\n");
  unlinkSync(join(f.root, "alpha"));
  symlinkSync(external, join(f.root, "alpha"));
  assert.equal((await immutable(f, () => f.adoptRoot({ ...f.options, apply: true }))).exit, 3);
  const before = snapshot(external);
  ok(await f.adoptRoot({ ...f.options, map: ["liam=liam-dev", "alpha=alpha"], apply: true }));
  assert.deepEqual(snapshot(external), before);
});

test("scope, ancestor, and state redirections are refused without writes", async (t) => {
  for (const kind of [
    "home",
    "global overlap",
    "symlink agents",
    "source state",
    "project state",
    "symlink state",
    "root alias",
  ])
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      let options = f.options;
      if (kind === "home") options = { ...options, project: f.home };
      if (kind === "global overlap") {
        rmSync(join(f.home, ".agents", "skills"), { recursive: true });
        symlinkSync(f.root, join(f.home, ".agents", "skills"));
      }
      if (kind === "symlink agents") {
        const outside = f.directory(join(f.base, "outside"));
        rmSync(join(f.project, ".agents"), { recursive: true });
        symlinkSync(outside, join(f.project, ".agents"));
      }
      if (kind === "source state") options = { ...options, stateHome: join(f.registry, "state") };
      if (kind === "project state") options = { ...options, stateHome: join(f.project, "state") };
      if (kind === "symlink state")
        symlinkSync(f.directory(join(f.base, "outside")), f.options.stateHome);
      if (kind === "root alias") {
        rmSync(f.root, { recursive: true });
        symlinkSync(f.registry, f.root);
      }
      const result = await immutable(f, () => f.adoptRoot({ ...options, apply: true }));
      assert.ok([2, 3].includes(result.exit), JSON.stringify(result));
    });
});

test("failure before journaling a complete stage preserves the original and safely retries a new stage", async (t) => {
  const f = await fixture(t);
  const original = snapshot(f.root);
  const failed = injected(
    f,
    `const original = fs.symlink; fs.symlink = async (...args) => { const result = await original(...args); if(String(args[1]).includes('.root-cutover-')) throw new Error('injected stage failure'); return result; };`,
  );
  assert.equal(failed.status, 0, failed.stderr);
  const result = JSON.parse(failed.stdout);
  assert.equal(result.exit, 4, failed.stdout);
  assert.deepEqual(snapshot(f.root), original);
  assert.equal(receipt(result.data.journal).phase, "preparing");
  ok(await immutable(f, () => f.adoptRoot(f.options)));
  const recovered = ok(await f.adoptRoot({ ...f.options, apply: true }));
  assert.equal(recovered.preservedStages.length, 1);
  assert.ok(existsSync(recovered.preservedStages[0]));
  assert.deepEqual(snapshot(recovered.quarantine), original);
  ok(await immutable(f, () => f.adoptRoot({ ...f.options, apply: true })));
});

test("an injected foreign staging entry is never published or adopted", async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.root);
  const injectedFile = `const original = fs.symlink; let inserted = false; fs.symlink = async (...args) => { const result = await original(...args); if (!inserted && String(args[1]).includes('.root-cutover-')) { inserted = true; await fs.writeFile(new URL('unplanned', 'file://' + String(args[1]).slice(0,String(args[1]).lastIndexOf('/')+1)), 'foreign bytes'); } return result; };`;
  const failed = injected(f, injectedFile);
  assert.equal(failed.status, 0, failed.stderr);
  const result = JSON.parse(failed.stdout);
  assert.equal(result.exit, 4, failed.stdout);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(receipt(result.data.journal).phase, "preparing");
  const retried = ok(await f.adoptRoot({ ...f.options, apply: true }));
  assert.equal(retried.preservedStages.length, 1);
  assert.equal(
    readFileSync(join(retried.preservedStages[0], "unplanned"), "utf8"),
    "foreign bytes",
  );
  assert.deepEqual(readdirSync(f.root).sort(), ["alpha", "liam-dev"]);
});

test("SIGKILL after parking or publishing resumes exact journal intent and retains the raw broken link", async (t) => {
  for (const moment of ["parked", "published"])
    await t.test(moment, async (t) => {
      const f = await fixture(t);
      const original = snapshot(f.root);
      const predicate =
        moment === "parked"
          ? `String(to).endsWith('-old')`
          : `String(to) === ${JSON.stringify(f.root)}`;
      const failed = injected(
        f,
        `const original = fs.rename; fs.rename = async (from,to) => { const result = await original(from,to); if(String(from).includes('.root-cutover-') || String(to).includes('.root-cutover-')) { if(${predicate}) process.kill(process.pid,'SIGKILL'); } return result; };`,
      );
      assert.equal(failed.signal, "SIGKILL", failed.stderr);
      const preview = ok(await immutable(f, () => f.adoptRoot({ ...f.options, map: [] })));
      assert.equal(preview.recovery, true);
      const recovered = ok(await f.adoptRoot({ ...f.options, map: [], apply: true }));
      assert.deepEqual(snapshot(recovered.quarantine), original);
      assert.equal(readlinkSync(join(recovered.quarantine, "liam")), "../../../deleted/liam");
      assert.equal(realpathSync(join(f.root, "liam-dev")), f.liam);
      assert.equal(receipt(recovered.journal).phase, "complete");
      ok(await immutable(f, () => f.adoptRoot({ ...f.options, apply: true })));
    });
});

test("changed canonical bytes during an interrupted cutover block replay without new writes", async (t) => {
  const f = await fixture(t);
  const failed = injected(
    f,
    `const original = fs.rename; fs.rename = async (from,to) => { const result = await original(from,to); if(String(to).includes('.root-cutover-') && String(to).endsWith('-old')) process.kill(process.pid,'SIGKILL'); return result; };`,
  );
  assert.equal(failed.signal, "SIGKILL");
  f.file(join(f.liam, "SKILL.md"), "# new canonical bytes after preflight\n");
  const result = await immutable(f, () => f.adoptRoot({ ...f.options, apply: true }));
  assert.equal(result.exit, 3, JSON.stringify(result));
  assert.equal(existsSync(f.root), false);
});

test("cross-device quarantine refuses before state creation instead of copying/deleting a root", async (t) => {
  const f = await fixture(t);
  if (!existsSync("/dev/shm") || lstatSync("/dev/shm").dev === lstatSync(f.root).dev)
    return t.skip("No separate local filesystem available");
  const state = mkdtempSync("/dev/shm/skillex-root-state-");
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const before = snapshot(state);
  const result = await immutable(f, () =>
    f.adoptRoot({ ...f.options, stateHome: state, apply: true }),
  );
  assert.equal(result.exit, 3, JSON.stringify(result));
  assert.ok(result.findings.some((finding) => finding.message.includes("same filesystem")));
  assert.deepEqual(snapshot(state), before);
});

test("changed recovery evidence is refused without further writes", async (t) => {
  const f = await fixture(t);
  const failed = injected(
    f,
    `const original = fs.rename; fs.rename = async (from,to) => { const result = await original(from,to); if(String(to).includes('.root-cutover-') && String(to).endsWith('-old')) process.kill(process.pid,'SIGKILL'); return result; };`,
  );
  assert.equal(failed.signal, "SIGKILL");
  const preview = ok(await f.adoptRoot(f.options));
  f.file(join(preview.quarantine, "unexpected"), "preserve this too\n");
  const refused = await immutable(f, () => f.adoptRoot({ ...f.options, apply: true }));
  assert.equal(refused.exit, 3, JSON.stringify(refused));
  assert.ok(refused.findings.some((finding) => finding.code === "E_ROOT_RECOVERY"));
});

test("paired pinned-pack policy replaces only verified real family skills, retires stubs, and adds missing members", async (t) => {
  const f = await fixture(t);
  const replacement = replacementFixture(f);
  const original = snapshot(f.root);
  const catalog = snapshot(f.registry);
  const runtime = snapshot(join(f.project, "_bmad"));
  const home = snapshot(f.home);
  const aliases = [".claude", ".codex"].map((name) => snapshot(join(f.project, name)));
  const manifest = snapshot(join(f.project, ".agents", "skills.json"));
  const preview = ok(await immutable(f, () => f.adoptRoot(replacement.options)));
  assert.deepEqual(preview.replacement, { pack: "bmad@6.12.1-next.1", prefix: "bmad-" });
  assert.deepEqual(
    preview.inventory
      .filter((item) => item.name.startsWith("bmad-"))
      .map((item) => [item.name, item.action])
      .sort(),
    [
      ["bmad-build", "replace"],
      ["bmad-help", "replace"],
      ["bmad-new", "add"],
      ["bmad-old-stub", "retire"],
    ],
  );
  for (const item of preview.inventory.filter((item) => item.name.startsWith("bmad-")))
    assert.match(item.reason, /bmad@6.12.1-next.1/);
  const applied = ok(await f.adoptRoot({ ...replacement.options, apply: true }));
  assert.deepEqual(snapshot(applied.quarantine), original);
  assert.deepEqual(readdirSync(f.root).sort(), ["alpha", ...replacement.members, "liam-dev"]);
  assert.equal(readlinkSync(join(applied.quarantine, "liam")), "../../../deleted/liam");
  assert.match(
    readFileSync(join(applied.quarantine, "bmad-old-stub", "SKILL.md"), "utf8"),
    /next.0/,
  );
  const journal = receipt(applied.journal);
  assert.equal(journal.replacement.pack, replacement.options.replacePack);
  assert.deepEqual(journal.replacement.names, replacement.members);
  assert.ok(journal.proofs.some((proof) => proof.path === replacement.pack));
  assert.deepEqual(
    Object.keys(receipt(applied.receipt).links).sort(),
    readdirSync(f.root)
      .sort()
      .map((name) => join(f.root, name)),
  );
  assert.deepEqual(snapshot(f.registry), catalog);
  assert.deepEqual(snapshot(join(f.project, "_bmad")), runtime);
  assert.deepEqual(snapshot(f.home), home);
  assert.deepEqual(
    [".claude", ".codex"].map((name) => snapshot(join(f.project, name))),
    aliases,
  );
  assert.deepEqual(snapshot(join(f.project, ".agents", "skills.json")), manifest);
  assert.deepEqual(
    ok(await immutable(f, () => f.adoptRoot({ ...replacement.options, apply: true }))).changes,
    [],
  );
  assert.deepEqual(
    ok(await immutable(f, () => f.adoptRoot({ ...f.options, apply: true }))).changes,
    [],
  );
  assert.equal(
    (
      await immutable(f, () =>
        f.adoptRoot({ ...replacement.options, replacePack: "bmad@6.12.1-next.2", apply: true }),
      )
    ).exit,
    3,
  );
});

test("replacement policy refuses unpaired/broad choices, invalid identities, pack drift, and nonfamily foreign content without writes", async (t) => {
  for (const [name, mutate, options] of [
    ["unpaired pack", () => {}, { replacePrefix: undefined }],
    ["unpaired prefix", () => {}, { replacePack: undefined }],
    ["unversioned", () => {}, { replacePack: "bmad" }],
    ["version range", () => {}, { replacePack: "bmad@^6.12.1" }],
    ["empty prefix", () => {}, { replacePrefix: "" }],
    ["broad prefix", () => {}, { replacePrefix: "b" }],
    ["wildcard prefix", () => {}, { replacePrefix: "bmad-*" }],
    ["unrelated prefix", () => {}, { replacePrefix: "other-" }],
    ["tiny family", () => {}, { replacePack: "b@1.0.0", replacePrefix: "b-" }],
    [
      "foreign real skill",
      (f) =>
        f.file(join(f.root, "custom-local", "SKILL.md"), "---\nname: custom-local\n---\nprivate\n"),
      {},
    ],
    [
      "missing frontmatter",
      (f) => f.file(join(f.root, "bmad-build", "SKILL.md"), "# no identity\n"),
      {},
    ],
    [
      "wrong frontmatter",
      (f) => f.file(join(f.root, "bmad-build", "SKILL.md"), "---\nname: unrelated\n---\nprivate\n"),
      {},
    ],
    [
      "invalid frontmatter",
      (f) =>
        f.file(
          join(f.root, "bmad-build", "SKILL.md"),
          "---\nname: bmad-build\nname: bmad-help\n---\n",
        ),
      {},
    ],
    [
      "retirement identity",
      (f) => f.file(join(f.root, "bmad-old-stub", "SKILL.md"), "# no identity\n"),
      {},
    ],
    [
      "linked SKILL.md",
      (f) => {
        unlinkSync(join(f.root, "bmad-build", "SKILL.md"));
        symlinkSync(join(f.alpha, "SKILL.md"), join(f.root, "bmad-build", "SKILL.md"));
      },
      {},
    ],
    ["prefix real file", (f) => f.file(join(f.root, "bmad-not-a-skill"), "private bytes\n"), {}],
    ["overlapping map", () => {}, { map: ["liam=liam-dev", "bmad-build=bmad-help"] }],
    [
      "canonical link drift",
      (f, r) => {
        unlinkSync(join(r.pack, "skills", "bmad-build"));
        symlinkSync(f.alpha, join(r.pack, "skills", "bmad-build"));
      },
      {},
    ],
    [
      "pack version drift",
      (f) =>
        f.file(
          join(f.registry, "all-skills", "bmad-build", ".source.yaml"),
          "origin:\n  bmad_version: 6.12.1-next.0\n",
        ),
      {},
    ],
    [
      "pack foreign member",
      (f, r) => {
        f.file(
          join(r.pack, "pack.toml"),
          '[pack]\nname="bmad"\nversion="6.12.1-next.1"\n[freeform]\nskills=["alpha"]\n',
        );
        rmSync(join(r.pack, "skills"), { recursive: true });
        f.directory(join(r.pack, "skills"));
        symlinkSync(f.alpha, join(r.pack, "skills", "alpha"));
      },
      {},
    ],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const replacement = replacementFixture(f);
      mutate(f, replacement);
      const refused = await immutable(f, () =>
        f.adoptRoot({ ...replacement.options, ...options, apply: true }),
      );
      assert.ok([2, 3].includes(refused.exit), JSON.stringify(refused));
      assert.equal(existsSync(f.options.stateHome), false);
    });
});

test("replacement prefix never retires symlinks or authorizes foreign link content", async (t) => {
  const f = await fixture(t);
  const replacement = replacementFixture(f);
  const legacy = f.skill("bmad-legacy-link");
  symlinkSync(legacy, join(f.root, "bmad-legacy-link"));
  const data = ok(await f.adoptRoot({ ...replacement.options, apply: true }));
  assert.equal(realpathSync(join(f.root, "bmad-legacy-link")), legacy);
  assert.equal(data.inventory.find((item) => item.name === "bmad-legacy-link").action, "adopt");
});

test("replacement cutover recovers preparing/parked/published phases with saved policy and exact pack evidence", async (t) => {
  for (const phase of ["preparing", "parked", "published"])
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      const replacement = replacementFixture(f);
      const before = snapshot(f.root);
      const script =
        phase === "preparing"
          ? "const original = fs.symlink; fs.symlink = async (...args) => { const result = await original(...args); if(String(args[1]).includes('.root-cutover-')) process.kill(process.pid,'SIGKILL'); return result; };"
          : `const original = fs.rename; fs.rename = async (from,to) => { const result = await original(from,to); if(${phase === "parked" ? "String(to).includes('.root-cutover-') && String(to).endsWith('-old')" : `String(from).includes('.root-cutover-') && String(to) === ${JSON.stringify(f.root)}`}) process.kill(process.pid,'SIGKILL'); return result; };`;
      const failed = injected(f, script, replacement.options);
      assert.equal(failed.signal, "SIGKILL", failed.stderr);
      const preview = ok(await immutable(f, () => f.adoptRoot(f.options)));
      assert.equal(preview.replacement.pack, replacement.options.replacePack);
      const recovered = ok(await f.adoptRoot({ ...f.options, apply: true }));
      assert.deepEqual(snapshot(recovered.quarantine), before);
      assert.deepEqual(readdirSync(f.root).sort(), ["alpha", ...replacement.members, "liam-dev"]);
      assert.equal(receipt(recovered.journal).phase, "complete");
      ok(await immutable(f, () => f.adoptRoot({ ...replacement.options, apply: true })));
    });
});

test("interrupted replacement refuses changed pack evidence even before stage preparation completes", async (t) => {
  const f = await fixture(t);
  const replacement = replacementFixture(f);
  const failed = injected(
    f,
    "const original = fs.symlink; fs.symlink = async (...args) => { const result = await original(...args); if(String(args[1]).includes('.root-cutover-')) process.kill(process.pid,'SIGKILL'); return result; };",
    replacement.options,
  );
  assert.equal(failed.signal, "SIGKILL");
  f.file(
    join(replacement.pack, "pack.toml"),
    `${readFileSync(join(replacement.pack, "pack.toml"), "utf8")}\n# changed after authority was saved\n`,
  );
  const refused = await immutable(f, () => f.adoptRoot({ ...f.options, apply: true }));
  assert.equal(refused.exit, 3, JSON.stringify(refused));
});

test("completed adoption reports a missing durable archive without replay or a false preservation claim", async (t) => {
  for (const disposition of ["moved", "deleted"])
    await t.test(disposition, async (t) => {
      const f = await fixture(t);
      const replacement = replacementFixture(f);
      const applied = ok(await f.adoptRoot({ ...replacement.options, apply: true }));
      assert.equal(applied.archiveStatus, "verified");
      const original = snapshot(applied.quarantine);
      const moved = join(f.base, "operator-kept-original");
      if (disposition === "moved") renameSync(applied.quarantine, moved);
      else rmSync(applied.quarantine, { recursive: true });
      for (const apply of [false, true]) {
        const result = await immutable(f, () => f.adoptRoot({ ...replacement.options, apply }));
        const data = ok(result);
        assert.equal(data.archiveStatus, "missing");
        assert.equal(data.quarantine, applied.quarantine);
        assert.equal(data.applied, false);
        assert.deepEqual(data.changes, []);
        const warning = result.findings.find(
          (finding) => finding.code === "W_ROOT_ARCHIVE_MISSING",
        );
        assert.equal(warning?.path, applied.quarantine);
        assert.match(warning.fix, /backup/);
        assert.match(warning.message, /No preservation claim/);
        assert.equal(receipt(applied.journal).phase, "complete");
      }
      if (disposition === "moved") {
        assert.deepEqual(snapshot(moved), original);
        renameSync(moved, applied.quarantine);
        const restored = await immutable(f, () =>
          f.adoptRoot({ ...replacement.options, apply: true }),
        );
        assert.equal(ok(restored).archiveStatus, "verified");
        assert.ok(!restored.findings.some((finding) => finding.code === "W_ROOT_ARCHIVE_MISSING"));
      }
    });
});

test("completed adoption refuses changed existing archives with a specific preservation diagnostic", async (t) => {
  const f = await fixture(t);
  const replacement = replacementFixture(f);
  const applied = ok(await f.adoptRoot({ ...replacement.options, apply: true }));
  f.file(join(applied.quarantine, "bmad-old-stub", "SKILL.md"), "operator edit after adoption\n");
  const refused = await immutable(f, () => f.adoptRoot({ ...replacement.options, apply: true }));
  assert.equal(refused.exit, 3);
  assert.ok(
    refused.findings.some(
      (finding) => finding.code === "E_ROOT_ARCHIVE_CHANGED" && finding.path === applied.quarantine,
    ),
  );
  assert.ok(!refused.findings.some((finding) => finding.code === "E_MIGRATION_ACTIVATION"));
});

test("completed adoption cannot treat receipt loss as ownership even if its archive is missing", async (t) => {
  for (const missingArchive of [false, true])
    await t.test(`missingArchive=${missingArchive}`, async (t) => {
      const f = await fixture(t);
      const replacement = replacementFixture(f);
      const applied = ok(await f.adoptRoot({ ...replacement.options, apply: true }));
      unlinkSync(applied.receipt);
      if (missingArchive) renameSync(applied.quarantine, join(f.base, "operator-kept-original"));
      const result = await immutable(f, () => f.adoptRoot({ ...replacement.options, apply: true }));
      assert.equal(result.exit, 3);
      const finding = result.findings.find((finding) => finding.code === "E_ROOT_RECEIPT_MISSING");
      assert.equal(finding?.path, applied.receipt);
      assert.match(finding.fix, /Restore the matching activation receipt from backup/);
      assert.match(finding.fix, /do not delete the journal/);
      assert.ok(existsSync(applied.journal));
      assert.ok(!existsSync(applied.receipt));
    });
});

test("missing archive never weakens interrupted cutover recovery", async (t) => {
  for (const phase of ["parked", "published"])
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      const replacement = replacementFixture(f);
      const failed = injected(
        f,
        `const original = fs.rename; fs.rename = async (from,to) => { const result = await original(from,to); if(${phase === "parked" ? "String(to).includes('.root-cutover-') && String(to).endsWith('-old')" : `String(from).includes('.root-cutover-') && String(to) === ${JSON.stringify(f.root)}`}) process.kill(process.pid,'SIGKILL'); return result; };`,
        replacement.options,
      );
      assert.equal(failed.signal, "SIGKILL", failed.stderr);
      const preview = ok(await f.adoptRoot(replacement.options));
      renameSync(preview.quarantine, join(f.base, "operator-kept-original"));
      const result = await immutable(f, () => f.adoptRoot({ ...replacement.options, apply: true }));
      assert.equal(result.exit, 3);
      assert.ok(result.findings.some((finding) => finding.code === "E_ROOT_RECOVERY"));
      assert.ok(!result.findings.some((finding) => finding.code === "W_ROOT_ARCHIVE_MISSING"));
    });
});

test("invalid explicit project paths return actionable configuration errors without writes", async (t) => {
  const f = await fixture(t);
  const regular = f.file(join(f.base, "not-a-project"), "file\n");
  for (const project of [join(f.base, "typo-project"), regular, join(regular, "child")]) {
    const result = await immutable(f, () => f.adoptRoot({ ...f.options, project, apply: true }));
    assert.equal(result.exit, 2, JSON.stringify(result));
    assert.ok(
      result.findings.some(
        (finding) => finding.code === "E_PROJECT" && finding.fix.includes("project"),
      ),
    );
    assert.ok(!result.findings.some((finding) => finding.code === "E_IO"));
  }
});

test("cancellation is write-free and concurrent callers converge", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await immutable(f, () =>
        f.adoptRoot({ ...f.options, apply: true, signal: { aborted: true } }),
      )
    ).exit,
    130,
  );
  for (const result of await Promise.all([
    f.adoptRoot({ ...f.options, apply: true }),
    f.adoptRoot({ ...f.options, apply: true }),
  ]))
    ok(result);
  ok(await immutable(f, () => f.adoptRoot({ ...f.options, apply: true })));
});
