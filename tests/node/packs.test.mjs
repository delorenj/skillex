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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import {
  addPackSkills,
  createPack,
  listPacks,
  removePackSkills,
  showPack,
  verifyPack,
} from "@delorenj/skillex";
import { parse as parseToml } from "smol-toml";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-packs-")));
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
  function skill(name) {
    const path = join(registry, "all-skills", name);
    file(join(path, "SKILL.md"), `# ${name}\n`);
    return path;
  }
  function link(path, target) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), target), path);
    return path;
  }
  function pack(name, version, names = [], generated = true) {
    const path = join(registry, "packs", name, version);
    file(
      join(path, "pack.toml"),
      `[pack]\nname=${JSON.stringify(name)}\nversion=${JSON.stringify(version)}\n[freeform]\nskills=${JSON.stringify(names)}\n`,
    );
    if (generated) {
      mkdirSync(join(path, "skills"));
      for (const member of new Set(names))
        link(join(path, "skills", member), join(registry, "all-skills", member));
    }
    return path;
  }
  return { root, registry, options, stateHome, file, skill, link, pack };
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
  assert.deepEqual(result.findings, []);
  assert.ok(result.data);
  return result.data;
}

function finding(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  const found = result.findings.find((entry) => entry.code === code);
  assert.ok(found, JSON.stringify(result.findings));
  assert.ok(found.path);
  assert.ok(found.fix);
  return found;
}

it("creates explicit pack versions, resolves latest, and edits authoritative membership", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  assert.deepEqual(ok(await listPacks(f.options)).packs, []);
  for (const version of ["2.0.0", "1.0.0"]) {
    const created = ok(
      await createPack("loadout", version, { ...f.options, description: "Daily tools" }),
    );
    assert.equal(created.composition.version, version);
    assert.equal(created.composition.description, "Daily tools");
    assert.equal(lstatSync(join(created.composition.path, "skills")).isDirectory(), true);
    ok(await verifyPack(`loadout@${version}`, f.options));
  }
  const added = ok(await addPackSkills("loadout", ["beta", "alpha", "beta"], f.options));
  const path = join(f.registry, "packs", "loadout", "2.0.0");
  assert.deepEqual(added.composition.skills, [
    { name: "alpha", path: alpha },
    { name: "beta", path: beta },
  ]);
  assert.deepEqual(parseToml(readFileSync(join(path, "pack.toml"), "utf8")).freeform.skills, [
    "beta",
    "alpha",
  ]);
  for (const name of ["alpha", "beta"])
    assert.equal(realpathSync(join(path, "skills", name)), join(f.registry, "all-skills", name));
  assert.equal(ok(await showPack("loadout", f.options)).pack.version, "2.0.0");
  assert.deepEqual(ok(await showPack("loadout@1.0.0", f.options)).pack.skills, []);
  assert.deepEqual(
    ok(await listPacks(f.options)).packs.map((pack) => pack.version),
    ["1.0.0", "2.0.0"],
  );
  const before = snapshot(f.root);
  assert.deepEqual(ok(await createPack("loadout", "2.0.0", f.options)).changes, []);
  assert.deepEqual(ok(await addPackSkills("loadout", ["alpha", "beta"], f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), before);
  ok(await removePackSkills("loadout", ["alpha"], f.options));
  assert.deepEqual(ok(await showPack("loadout", f.options)).pack.skills, [
    { name: "beta", path: beta },
  ]);
  ok(await verifyPack("loadout", f.options));
  const removed = snapshot(f.root);
  assert.deepEqual(ok(await removePackSkills("loadout", ["alpha"], f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), removed);
});

it("preserves source provenance, manifest mode, and pack support assets across edits", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  const path = f.pack("tools", "legacy-version", ["alpha"]);
  const manifest = join(path, "pack.toml");
  f.file(
    manifest,
    '[pack]\nname="tools"\nversion="legacy-version"\ndescription="Custom tools"\n[freeform]\nskills=["alpha"]\n[source]\nurl="https://example.test/tools"\nrevision="revision-1"\ncaptured=2026-09-14T10:11:12Z\n[source.vendor]\npath="upstream/tools"\nflags=[true, false]\n',
  );
  chmodSync(manifest, 0o640);
  for (const asset of [
    "hooks/run.sh",
    "commands/run.md",
    "references/guide.md",
    "scripts/helper.sh",
  ])
    f.file(join(path, asset), `${asset}\n`);
  chmodSync(join(path, "hooks", "run.sh"), 0o755);
  const supportBefore = ["hooks", "commands", "references", "scripts"].map((dir) =>
    snapshot(join(path, dir)),
  );
  const provenance = parseToml(readFileSync(manifest, "utf8")).source;
  ok(await addPackSkills("tools", ["beta"], f.options));
  ok(await removePackSkills("tools", ["alpha"], f.options));
  const updated = parseToml(readFileSync(manifest, "utf8"));
  assert.deepEqual(updated.source, provenance);
  assert.equal(updated.pack.description, "Custom tools");
  assert.equal(lstatSync(manifest).mode & 0o777, 0o640);
  assert.deepEqual(
    ["hooks", "commands", "references", "scripts"].map((dir) => snapshot(join(path, dir))),
    supportBefore,
  );
  assert.deepEqual(
    readdirSync(path).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

it("all pack dry-runs and inspections preserve content and leave lock state absent", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  f.pack("tools", "1.0.0", ["alpha"]);
  const before = snapshot(f.root);
  ok(await listPacks(f.options));
  ok(await showPack("tools", f.options));
  ok(await verifyPack("tools", f.options));
  for (const result of [
    await createPack("new", "1.0.0", { ...f.options, dryRun: true }),
    await addPackSkills("tools", ["beta"], { ...f.options, dryRun: true }),
    await removePackSkills("tools", ["alpha"], { ...f.options, dryRun: true }),
  ]) {
    const data = ok(result);
    assert.equal(data.dryRun, true);
    assert.ok(data.changes.length);
  }
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("refuses unknown skills, invalid references, and malformed descriptions before writes", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.pack("tools", "1.0.0");
  const before = snapshot(f.root);
  finding(await addPackSkills("tools", ["alpha", "missing"], f.options), "E_SKILL_MISSING");
  finding(await removePackSkills("tools", ["missing"], f.options), "E_SKILL_MISSING");
  finding(await addPackSkills("../tools", ["alpha"], f.options), "E_MANIFEST_INVALID", 2);
  finding(await createPack("tools", "../escape", f.options), "E_MANIFEST_INVALID", 2);
  finding(
    await createPack("new", "1.0.0", { ...f.options, description: { text: "wrong" } }),
    "E_PACK_MANIFEST_INVALID",
    2,
  );
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("repairs generated roots and missing links from a committed declaration on retry", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  const path = f.pack("tools", "1.0.0", ["beta", "alpha"], false);
  const original = readFileSync(join(path, "pack.toml"));
  finding(await verifyPack("tools", f.options), "E_PACK_SKILLS_MISSING");
  const dryrunBefore = snapshot(f.root);
  const preview = ok(await createPack("tools", "1.0.0", { ...f.options, dryRun: true }));
  assert.deepEqual(
    preview.changes.map((change) => change.action),
    ["create-directory", "create-link", "create-link"],
  );
  assert.deepEqual(snapshot(f.root), dryrunBefore);
  ok(await createPack("tools", "1.0.0", f.options));
  ok(await verifyPack("tools", f.options));
  unlinkSync(join(path, "skills", "alpha"));
  finding(await verifyPack("tools", f.options), "E_PACK_LINK_MISSING");
  const repaired = ok(await addPackSkills("tools", ["alpha"], f.options));
  assert.deepEqual(
    repaired.changes.map((change) => change.action),
    ["create-link"],
  );
  assert.deepEqual(readFileSync(join(path, "pack.toml")), original);
  ok(await verifyPack("tools", f.options));
});

it("finishes explicit stale removals without adopting unrelated extra links", async (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha");
  const beta = f.skill("beta");
  const path = f.pack("tools", "1.0.0", []);
  f.link(join(path, "skills", "alpha"), alpha);
  const initial = snapshot(f.root);
  finding(await createPack("tools", "1.0.0", f.options), "E_COMPOSITION_CONFLICT");
  assert.deepEqual(snapshot(f.root), initial);
  const removed = ok(await removePackSkills("tools", ["alpha"], f.options));
  assert.deepEqual(
    removed.changes.map((change) => change.action),
    ["remove-link"],
  );
  ok(await verifyPack("tools", f.options));
  f.link(join(path, "skills", "alpha"), alpha);
  f.link(join(path, "skills", "beta"), beta);
  const withExtra = snapshot(f.root);
  finding(await removePackSkills("tools", ["alpha"], f.options), "E_COMPOSITION_CONFLICT");
  assert.deepEqual(snapshot(f.root), withExtra);
});

it("does not rewrite valid duplicate declarations during idempotent commands", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.pack("tools", "1.0.0", ["alpha", "alpha"]);
  const before = snapshot(f.root);
  assert.deepEqual(ok(await createPack("tools", "1.0.0", f.options)).changes, []);
  assert.deepEqual(ok(await addPackSkills("tools", ["alpha"], f.options)).changes, []);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

for (const shape of ["wrong-link", "dangling-link", "file", "directory", "symlink-root", "extra"]) {
  it(`verification reports ${shape} and mutations refuse without writes`, async (t) => {
    const f = fixture(t);
    f.skill("alpha");
    const beta = f.skill("beta");
    const path = f.pack("tools", "1.0.0", ["alpha"]);
    const member = join(path, "skills", "alpha");
    if (shape === "symlink-root") {
      rmSync(join(path, "skills"), { recursive: true });
      f.link(join(path, "skills"), join(f.registry, "all-skills"));
    } else if (shape === "extra") f.file(join(path, "skills", "surprise.txt"), "preserve\n");
    else {
      unlinkSync(member);
      if (shape === "wrong-link" || shape === "dangling-link")
        f.link(member, shape === "wrong-link" ? beta : join(f.root, "missing"));
      else if (shape === "file") f.file(member, "preserve\n");
      else f.file(join(member, "support.txt"), "preserve\n");
    }
    const before = snapshot(f.root);
    finding(
      await verifyPack("tools", f.options),
      shape === "symlink-root"
        ? "E_PACK_SKILLS_ROOT"
        : shape === "extra"
          ? "E_PACK_LINK_EXTRA"
          : "E_PACK_LINK_TARGET",
    );
    finding(await addPackSkills("tools", ["beta"], f.options), "E_COMPOSITION_CONFLICT");
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(existsSync(f.stateHome), false);
  });
}

it("verification names missing canonical members and embedded definitions at any depth", async (t) => {
  const f = fixture(t);
  const path = f.pack("tools", "1.0.0", ["missing"]);
  let before = snapshot(f.root);
  finding(await verifyPack("tools", f.options), "E_SKILL_MISSING");
  assert.deepEqual(snapshot(f.root), before);
  f.file(join(path, "support", "nested", "SKILL.md"), "# Embedded\n");
  before = snapshot(f.root);
  finding(await verifyPack("tools", f.options), "E_NONCANONICAL_REFERENCE");
  finding(await createPack("tools", "1.0.0", f.options), "E_NONCANONICAL_REFERENCE");
  assert.deepEqual(snapshot(f.root), before);
});

for (const malformed of ["description", "source", "legacy", "unknown", "utf8"]) {
  it(`reports malformed ${malformed} pack data without creating state`, async (t) => {
    const f = fixture(t);
    const path = f.pack("tools", "1.0.0");
    const manifest = join(path, "pack.toml");
    const base = '[pack]\nname="tools"\nversion="1.0.0"\n';
    const membership = "[freeform]\nskills=[]\n";
    if (malformed === "description")
      f.file(manifest, `${base}description=["wrong"]\n${membership}`);
    else if (malformed === "source") f.file(manifest, `source="wrong"\n${base}${membership}`);
    else if (malformed === "legacy")
      f.file(manifest, `${base}${membership}[policy]\nflatten=true\n`);
    else if (malformed === "unknown") f.file(manifest, `${base}unrecognized=true\n${membership}`);
    else
      f.file(
        manifest,
        Buffer.concat([
          Buffer.from(`${base}description="`),
          Buffer.from([0xff]),
          Buffer.from(`"\n${membership}`),
        ]),
      );
    const before = snapshot(f.root);
    finding(
      await createPack("tools", "1.0.0", f.options),
      malformed === "legacy" ? "E_LEGACY_FIELD" : "E_PACK_MANIFEST_INVALID",
      2,
    );
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(existsSync(f.stateHome), false);
  });
}

it("lists each version alongside actionable failures and requires disambiguating legacy versions", async (t) => {
  const f = fixture(t);
  f.pack("tools", "nightly");
  f.pack("tools", "stable");
  const broken = f.pack("broken", "1.0.0");
  f.file(join(broken, "pack.toml"), "not valid TOML\n");
  const before = snapshot(f.root);
  const result = await listPacks(f.options);
  finding(result, "E_PACK_MANIFEST_INVALID", 4);
  assert.deepEqual(
    result.data.packs.map((pack) => pack.version),
    ["nightly", "stable"],
  );
  finding(await showPack("tools", f.options), "E_PACK_VERSION_REQUIRED", 2);
  assert.equal(ok(await showPack("tools@nightly", f.options)).pack.version, "nightly");
  assert.deepEqual(snapshot(f.root), before);
});

it("reports unsafe versions as configuration errors while retaining valid versions and families", async (t) => {
  const f = fixture(t);
  const unsafe = f.pack("tools", "bad version");
  const before = snapshot(f.root);
  const invalidOnly = await listPacks(f.options);
  const invalid = finding(invalidOnly, "E_PACK_VERSION", 2);
  assert.equal(invalid.path, unsafe);
  assert.match(invalid.fix, /Rename.*directory/);
  assert.deepEqual(invalidOnly.data.packs, []);
  assert.deepEqual(snapshot(f.root), before);

  f.pack("tools", "1.0.0");
  f.pack("other", "2.0.0");
  const mixedBefore = snapshot(f.root);
  const mixed = await listPacks(f.options);
  finding(mixed, "E_PACK_VERSION", 4);
  assert.deepEqual(
    mixed.data.packs.map((pack) => [pack.name, pack.version]),
    [
      ["other", "2.0.0"],
      ["tools", "1.0.0"],
    ],
  );
  assert.deepEqual(snapshot(f.root), mixedBefore);
  assert.equal(existsSync(f.stateHome), false);
});

it("refuses exclusive creation over a version directory without a manifest", async (t) => {
  const f = fixture(t);
  f.file(join(f.registry, "packs", "tools", "1.0.0", "skills", "foreign.txt"), "preserve\n");
  const before = snapshot(f.root);
  finding(await createPack("tools", "1.0.0", f.options), "E_PACK_MANIFEST_MISSING");
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(f.stateHome), false);
});

it("serializes concurrent pack additions without losing manifest membership", async (t) => {
  const f = fixture(t);
  for (const name of ["alpha", "beta", "gamma", "delta"]) f.skill(name);
  ok(await createPack("tools", "1.0.0", f.options));
  const results = await Promise.all(
    ["alpha", "beta", "gamma", "delta"].map((name) => addPackSkills("tools", [name], f.options)),
  );
  for (const result of results) ok(result);
  assert.deepEqual(
    ok(await showPack("tools", f.options)).pack.skills.map((skill) => skill.name),
    ["alpha", "beta", "delta", "gamma"],
  );
  ok(await verifyPack("tools", f.options));
});

function injectedWriteFailure(options, boundary) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const options = JSON.parse(process.argv[1]);
const boundary = process.argv[2];
const method = boundary === 'manifest' ? 'open' : 'symlink';
const original = fs[method];
fs[method] = async (...args) => {
  const path = method === 'open' ? args[0] : args[1];
  if ((method === 'open' && basename(path).startsWith('.pack.toml.')) || (method === 'symlink' && basename(path) === 'beta')) {
    throw Object.assign(new Error('Injected composition write failure'), { code: 'EIO' });
  }
  return original(...args);
};
syncBuiltinESMExports();
const api = await import('@delorenj/skillex');
const result = boundary === 'manifest'
  ? await api.createPack('tools', '1.0.0', options)
  : await api.addPackSkills('tools', ['alpha', 'beta'], options);
process.stdout.write(JSON.stringify(result));`,
      JSON.stringify(options),
      boundary,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  return JSON.parse(child.stdout);
}

it("reports pre-manifest partial creation honestly and refuses to adopt the partial directory", async (t) => {
  const f = fixture(t);
  const result = injectedWriteFailure(f.options, "manifest");
  const partial = finding(result, "E_COMPOSITION_PARTIAL", 4);
  assert.match(partial.fix, /empty partial directories/);
  const path = join(f.registry, "packs", "tools", "1.0.0");
  assert.equal(lstatSync(join(path, "skills")).isDirectory(), true);
  assert.equal(existsSync(join(path, "pack.toml")), false);
  assert.deepEqual(readdirSync(path), ["skills"]);
  const before = snapshot(f.root);
  finding(await createPack("tools", "1.0.0", f.options), "E_PACK_MANIFEST_MISSING");
  assert.deepEqual(snapshot(f.root), before);
});

it("reports interrupted link execution and converges on retry without rewriting the saved declaration", async (t) => {
  const f = fixture(t);
  f.skill("alpha");
  f.skill("beta");
  const path = f.pack("tools", "1.0.0");
  finding(injectedWriteFailure(f.options, "link"), "E_COMPOSITION_PARTIAL", 4);
  assert.equal(
    realpathSync(join(path, "skills", "alpha")),
    join(f.registry, "all-skills", "alpha"),
  );
  assert.equal(existsSync(join(path, "skills", "beta")), false);
  const manifest = readFileSync(join(path, "pack.toml"));
  assert.deepEqual(parseToml(manifest.toString("utf8")).freeform.skills, ["alpha", "beta"]);
  finding(await verifyPack("tools", f.options), "E_PACK_LINK_MISSING");
  const repaired = ok(await addPackSkills("tools", ["alpha", "beta"], f.options));
  assert.deepEqual(
    repaired.changes.map((change) => change.action),
    ["create-link"],
  );
  assert.deepEqual(readFileSync(join(path, "pack.toml")), manifest);
  ok(await verifyPack("tools", f.options));
});
