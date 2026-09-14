import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
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
import { setTimeout as delay } from "node:timers/promises";
import { migrate, resolveSelection, withLock } from "@delorenj/skillex";

function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
function file(path, bytes) {
  directory(dirname(path));
  writeFileSync(path, bytes);
  return path;
}
function link(path, target) {
  directory(dirname(path));
  symlinkSync(relative(dirname(path), target), path);
}
function snapshot(root) {
  if (!existsSync(root)) return null;
  const result = [];
  const visit = (path) => {
    const info = lstatSync(path);
    const row = [relative(root, path), info.mode, info.dev, info.ino, info.mtimeMs];
    if (info.isSymbolicLink()) result.push([...row, "link", readlinkSync(path)]);
    else if (info.isDirectory()) {
      result.push([...row, "directory"]);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else
      result.push([...row, "file", createHash("sha256").update(readFileSync(path)).digest("hex")]);
  };
  visit(root);
  return result;
}
async function unchanged(root, action) {
  const before = snapshot(root);
  try {
    return await action();
  } finally {
    assert.deepEqual(snapshot(root), before, "migration preview or refusal changed fixture state");
  }
}
function ok(result, command = "migrate") {
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.schema, 2);
  assert.equal(result.command, command);
  assert.equal(result.ok, true);
  assert.ok(result.data);
  return result.data;
}
function finding(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result));
  assert.equal(result.ok, false);
  const found = result.findings.find((entry) => entry.code === code);
  assert.ok(found, `missing ${code}: ${JSON.stringify(result.findings)}`);
  assert.ok(found.fix);
  return found;
}
function manifestItem(data) {
  const item = data.items.find(
    ({ area, action }) => area === "manifest" && action !== "retire-legacy-manifest",
  );
  assert.ok(item, "migration did not report the selected manifest");
  return item;
}
function manifestReceipt(data, target, stateHome) {
  const key = createHash("sha256").update(target).digest("hex");
  const path = join(stateHome, "skillex", "migrations", "v2", `${key}.json`);
  assert.ok(data.receipts.includes(path), "migration did not report the manifest receipt");
  return path;
}
function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-migration-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = directory(join(root, "home"));
  const project = directory(join(root, "project"));
  const unrelated = directory(join(root, "unrelated"));
  const registry = directory(join(root, "registry"));
  const stateHome = join(root, "state");
  directory(join(project, ".git"));
  directory(join(registry, ".git"));
  for (const part of ["all-skills", "sets", "packs"]) directory(join(registry, part));
  const target = join(project, ".agents", "skills.json");
  const legacy = join(home, ".config", "skillex", "skillex.toml");
  const source = directory(join(root, "external-alpha"));
  file(
    join(source, "SKILL.md"),
    "---\nname: alpha\ndescription: Migration fixture\n---\n# Alpha\n",
  );
  file(join(source, "references", "guide.md"), "Preserve external support bytes.\n");
  chmodSync(file(join(source, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n"), 0o755);
  cpSync(source, join(registry, "all-skills", "alpha"), { recursive: true });
  file(join(registry, "all-skills", "beta", "SKILL.md"), "# Canonical beta\n");
  const options = {
    home,
    cwd: unrelated,
    project,
    registryRoot: registry,
    stateHome,
    env: {},
    timeoutMs: 5_000,
  };
  const manifest = (value) => file(target, `${JSON.stringify(value, null, 2)}\n`);
  const globalOptions = () => {
    const value = { ...options, scope: "global" };
    delete value.project;
    return value;
  };
  const toml = (extra = "") =>
    file(
      legacy,
      "[skillex]\nskills_root = " +
        JSON.stringify(join(registry, "all-skills")) +
        "\npacks_root = " +
        JSON.stringify(join(root, "old-packs")) +
        "\nlog_format = 'console'\n[scopes.global]\nactive_pack = 'old-tools'\n" +
        extra,
    );
  const pack = directory(join(registry, "packs", "tools", "1.2.3"));
  file(
    join(pack, "pack.toml"),
    "[pack]\nname='tools'\nversion='1.2.3'\n[freeform]\nskills=['alpha']\n",
  );
  directory(join(pack, "skills"));
  link(join(pack, "skills", "alpha"), join(registry, "all-skills", "alpha"));
  const packMapping = {
    version: 1,
    packs: { [join(root, "old-packs", "old-tools")]: { name: "tools", version: "1.2.3" } },
  };
  const mapping = { version: 1, names: { [source]: "alpha" } };
  return {
    root,
    home,
    project,
    unrelated,
    registry,
    stateHome,
    target,
    legacy,
    source,
    options,
    manifest,
    globalOptions,
    toml,
    packMapping,
    mapping,
  };
}
function child(options, injection) {
  const code = [
    "import fs from 'node:fs/promises';",
    "import { syncBuiltinESMExports } from 'node:module';",
    injection,
    "syncBuiltinESMExports();",
    "const { migrate } = await import('@delorenj/skillex');",
    `process.stdout.write(JSON.stringify(await migrate(${JSON.stringify(options)})));`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

it("never discovers the ambient manifest scope and rejects conflicting explicit selectors", async (t) => {
  const f = fixture(t);
  f.manifest({ skills: ["alpha"] });
  const unselected = ok(
    await unchanged(f.root, () => migrate({ ...f.options, project: undefined })),
  );
  assert.equal(
    unselected.items.some(({ area }) => area === "manifest" || area === "activation"),
    false,
  );
  for (const options of [
    { ...f.options, project: undefined, scope: "project" },
    { ...f.options, scope: "global" },
  ])
    finding(await unchanged(f.root, () => migrate(options)), "E_MIGRATION_CONFIG", 2);
});

it("previews exact external references with complete proposed intent and no state writes", async (t) => {
  const f = fixture(t);
  f.manifest({ inherit_global: false, skills: [{ name: "alpha", source: `file://${f.source}` }] });
  const data = ok(await unchanged(f.root, () => migrate({ ...f.options, mapping: f.mapping })));
  const item = manifestItem(data);
  assert.equal(item.action, "write-manifest");
  assert.equal(item.state, "ready");
  assert.match(item.beforeDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(item.afterDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(item.details.some((line) => line.includes('"alpha"') && line.includes("Proposed")));
  assert.deepEqual(data.applied, []);
  assert.equal(existsSync(f.stateHome), false);
});

it("applies canonical intent while preserving sources and activations, then remains byte-identical", async (t) => {
  const f = fixture(t);
  f.manifest({ inherit_global: false, skills: [{ name: "alpha", source: `file://${f.source}` }] });
  const preserved = [
    snapshot(f.source),
    snapshot(f.registry),
    snapshot(join(f.project, ".agents", "skills")),
  ];
  const data = ok(await migrate({ ...f.options, mapping: f.mapping, apply: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), {
    inherit_global: false,
    skills: ["alpha"],
  });
  assert.deepEqual(data.applied, [`manifest:${f.target}`]);
  assert.equal(manifestItem(data).state, "verified");
  const receipt = manifestReceipt(data, f.target, f.stateHome);
  assert.deepEqual(
    [snapshot(f.source), snapshot(f.registry), snapshot(join(f.project, ".agents", "skills"))],
    preserved,
  );
  assert.ok(readdirSync(dirname(f.target)).every((name) => !name.startsWith(".skillex-tmp")));
  const before = [snapshot(f.target), snapshot(receipt)];
  const repeat = ok(await migrate({ ...f.options, apply: true }));
  assert.deepEqual(repeat.applied, []);
  assert.deepEqual([snapshot(f.target), snapshot(receipt)], before);
});

it("translates slash references and preserves legacy empty-include selection meaning", async (t) => {
  const f = fixture(t);
  const set = directory(join(f.registry, "sets", "tools"));
  for (const name of ["alpha", "beta"]) link(join(set, name), join(f.registry, "all-skills", name));
  f.manifest({
    inherit_global: false,
    sets: [{ name: "tools", source: `file://${set}`, include: [] }],
    skills: ["sets/tools/alpha"],
  });
  ok(await migrate({ ...f.options, apply: true }));
  const raw = JSON.parse(readFileSync(f.target, "utf8"));
  assert.deepEqual(raw.sets, [{ name: "tools" }]);
  assert.deepEqual(raw.skills, ["alpha"]);
  const resolved = ok(await resolveSelection({ ...f.options, scope: "project" }), "resolve");
  assert.deepEqual(
    resolved.scopes
      .at(-1)
      .bindings.map(({ name }) => name)
      .sort(),
    ["alpha", "beta"],
  );
});

it("does not infer external names or discard unknown slot, payload, and additive pack semantics", async (t) => {
  const f = fixture(t);
  for (const raw of [
    { skills: [{ name: "alpha", source: `file://${f.source}` }] },
    { skills: ["alpha"], slots: { workflow: "alpha" } },
    { payload: { root: f.source }, skills: ["alpha"] },
    { packs: ["tools", "other"] },
    { packs: [{ name: "tools", flatten: true }], skills: ["alpha"] },
    { packs: [{ name: "tools", include: ["alpha"] }] },
  ]) {
    f.manifest(raw);
    const result = await unchanged(f.root, () => migrate({ ...f.options, apply: true }));
    finding(result, "E_MIGRATION_MANIFEST_MAPPING");
    assert.equal(manifestItem(result.data).state, "blocked");
    assert.equal(manifestItem(result.data).action, "map-manifest");
  }
});

it("requires an explicit decision before legacy project packs stop inheriting global skills", async (t) => {
  const f = fixture(t);
  file(join(f.home, ".agents", "skills.json"), JSON.stringify({ skills: ["beta"] }));
  const selected = { name: "tools", version: "1.2.3", flatten: false };
  for (const inherit of [undefined, true]) {
    f.manifest({
      ...(inherit === undefined ? {} : { inherit_global: inherit }),
      packs: [selected],
    });
    finding(
      await unchanged(f.root, () => migrate({ ...f.options, apply: true })),
      "E_MIGRATION_MANIFEST_MAPPING",
    );
  }
  f.manifest({ inherit_global: false, packs: [selected] });
  ok(await migrate({ ...f.options, apply: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), {
    inherit_global: false,
    packs: [{ name: "tools", version: "1.2.3" }],
  });
  f.manifest({ packs: [selected] });
  const replacement = { packs: [{ name: "tools", version: "1.2.3" }] };
  ok(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, manifests: { [f.target]: replacement } },
    }),
  );
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), replacement);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, ".agents", "skills.json"), "utf8")), {
    skills: ["beta"],
  });
});

it("uses an explicitly authored replacement without copying raw retired payload text into state", async (t) => {
  const f = fixture(t);
  f.manifest({ slots: { workflow: "alpha" }, payload: { template: "PRIVATE_SOURCE_MARKER" } });
  const replacement = { inherit_global: false, skills: ["alpha"] };
  const data = ok(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, manifests: { [f.target]: replacement } },
    }),
  );
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), replacement);
  const state = readFileSync(manifestReceipt(data, f.target, f.stateHome), "utf8");
  assert.equal(state.includes("PRIVATE_SOURCE_MARKER"), false);
  assert.equal(state.includes('"template"'), false);
  assert.ok(readdirSync(dirname(f.target)).every((name) => !name.startsWith(".skillex-tmp")));
});

it("refuses malformed declarations by default but accepts an exact authored replacement", async (t) => {
  const f = fixture(t);
  file(f.target, '{"skills":');
  finding(await unchanged(f.root, () => migrate(f.options)), "E_MANIFEST_PARSE", 2);
  ok(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, manifests: { [f.target]: { skills: ["alpha"] } } },
    }),
  );
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), { skills: ["alpha"] });
});

it("honors migration digest pins over source modes before publishing a declaration", async (t) => {
  const f = fixture(t);
  f.manifest({ skills: [{ name: "alpha", source: `file://${f.source}` }] });
  const preview = ok(await migrate({ ...f.options, mapping: f.mapping }));
  const decision = manifestItem(preview).details.find((line) => line.includes("source digest"));
  const digest = decision.match(/sha256:[a-f0-9]{64}/)[0];
  chmodSync(join(f.source, "scripts", "run.sh"), 0o644);
  finding(
    await unchanged(f.root, () =>
      migrate({
        ...f.options,
        apply: true,
        mapping: { ...f.mapping, digests: { [f.source]: digest } },
      }),
    ),
    "E_MIGRATION_DIGEST",
  );
});

it("uses catalog conversion name mappings even after the old lexical source was retired", async (t) => {
  const f = fixture(t);
  const old = join(f.registry, "all-skills", "old-alpha");
  link(old, f.source);
  f.manifest({ skills: ["old-alpha"] });
  const options = { ...f.options, mapping: { version: 1, names: { [old]: "alpha" } } };
  const preview = ok(await unchanged(f.root, () => migrate(options)));
  assert.equal(manifestItem(preview).action, "write-manifest");
  ok(await migrate({ ...options, apply: true }));
  assert.equal(existsSync(old), false);
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), { skills: ["alpha"] });
  assert.deepEqual(ok(await migrate({ ...f.options, apply: true })).applied, []);
});

it("translates an explicit TOML scope and retires it only after verified canonical publication", async (t) => {
  const f = fixture(t);
  f.toml(
    `[cli.claude]\nenabled=true\nglobal_root=${JSON.stringify(join(f.home, ".claude"))}\nproject_root='.claude'\n`,
  );
  const options = { ...f.globalOptions(), mapping: f.packMapping };
  const preview = ok(await unchanged(f.root, () => migrate(options)));
  assert.ok(
    preview.items.some(
      ({ action, path }) => action === "retire-legacy-manifest" && path === f.legacy,
    ),
  );
  assert.equal(existsSync(join(f.home, ".agents")), false);
  const data = ok(await migrate({ ...options, apply: true }));
  assert.equal(existsSync(f.legacy), false);
  const target = join(f.home, ".agents", "skills.json");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    scope: "global",
    packs: [{ name: "tools", version: "1.2.3" }],
  });
  assert.ok(data.applied.includes(`manifest-retire:${f.legacy}`));
  assert.ok(
    data.items.filter(({ area }) => area === "manifest").every(({ state }) => state === "verified"),
  );
  const receipt = manifestReceipt(data, target, f.stateHome);
  const before = [snapshot(target), snapshot(receipt)];
  assert.deepEqual(ok(await migrate({ ...f.globalOptions(), apply: true })).applied, []);
  assert.deepEqual([snapshot(target), snapshot(receipt)], before);
});

it("previews a future canonical destination and publishes it before the dependent manifest", async (t) => {
  const f = fixture(t);
  f.manifest({ skills: [{ name: "alpha", source: `file://${f.source}` }] });
  const options = { ...f.options, mapping: { version: 1, names: { [f.source]: "vendor-alpha" } } };
  const preview = ok(await unchanged(f.root, () => migrate(options)));
  const catalogItem = "catalog:all-skills/vendor-alpha";
  assert.ok(manifestItem(preview).dependsOn.includes(catalogItem));
  const target = join(f.registry, "all-skills", "vendor-alpha");
  assert.equal(existsSync(target), false);
  const source = snapshot(f.source);
  const data = ok(await migrate({ ...options, apply: true }));
  assert.ok(data.applied.indexOf(catalogItem) >= 0);
  assert.ok(data.applied.indexOf(catalogItem) < data.applied.indexOf(`manifest:${f.target}`));
  assert.deepEqual(
    readFileSync(join(target, "SKILL.md")),
    readFileSync(join(f.source, "SKILL.md")),
  );
  assert.deepEqual(snapshot(f.source), source);
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), { skills: ["vendor-alpha"] });
});

it("uses the normal global XDG state default outside authored manifest and source roots", async (t) => {
  const f = fixture(t);
  const target = file(
    join(f.home, ".agents", "skills.json"),
    JSON.stringify({ skills: [{ name: "alpha", source: `file://${f.source}` }] }),
  );
  const options = { ...f.globalOptions(), mapping: f.mapping };
  delete options.stateHome;
  const state = join(f.home, ".local", "state");
  ok(await unchanged(f.root, () => migrate(options)));
  assert.equal(existsSync(state), false);
  const source = snapshot(f.source);
  const result = ok(await migrate({ ...options, apply: true }));
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { skills: ["alpha"] });
  manifestReceipt(result, target, state);
  assert.deepEqual(snapshot(f.source), source);
  assert.equal(existsSync(join(f.home, ".agents", "skills")), false);
});

it("blocks conflicting TOML, other active scopes, and non-equivalent adapter policy without changing either source", async (t) => {
  const f = fixture(t);
  for (const extra of [
    "[scopes.project]\nactive_pack='other-tools'\n",
    "[cli.claude]\nenabled=false\nglobal_root='~/.claude'\nproject_root='.claude'\n",
    "[cli.claude]\nglobal_root='/other/runtime'\nproject_root='.claude'\n",
  ]) {
    f.toml(extra);
    finding(
      await unchanged(f.root, () =>
        migrate({ ...f.globalOptions(), mapping: f.packMapping, apply: true }),
      ),
      "E_MIGRATION_MANIFEST_MAPPING",
    );
  }
  f.toml();
  file(join(f.home, ".agents", "skills.json"), '{"skills":["beta"]}\n');
  finding(
    await unchanged(f.root, () =>
      migrate({ ...f.globalOptions(), mapping: f.packMapping, apply: true }),
    ),
    "E_MIGRATION_MANIFEST_MAPPING",
  );
});

it("refuses linked declarations and state inside registry or external source before writing", async (t) => {
  const f = fixture(t);
  const foreign = file(join(f.root, "foreign.json"), '{"skills":["alpha"]}\n');
  link(f.target, foreign);
  finding(
    await unchanged(f.root, () => migrate({ ...f.options, apply: true })),
    "E_MIGRATION_MANIFEST_PATH",
  );
  rmSync(f.target);
  f.manifest({ skills: [{ name: "alpha", source: `file://${f.source}` }] });
  for (const source of [f.registry, f.source])
    finding(
      await unchanged(f.root, () =>
        migrate({
          ...f.options,
          mapping: f.mapping,
          apply: true,
          stateHome: join(source, "state"),
        }),
      ),
      "E_RECEIPT_UNSAFE_PATH",
    );
});

it("compares the exact authored declaration again after waiting for the shared activation lock", async (t) => {
  const f = fixture(t);
  f.manifest({ skills: [{ name: "alpha", source: `file://${f.source}` }] });
  let pending;
  await withLock(
    "skillex:activation:v2",
    async () => {
      const before = new Set(readdirSync(f.stateHome, { recursive: true }));
      pending = migrate({ ...f.options, mapping: f.mapping, apply: true });
      const waiting = () =>
        readdirSync(f.stateHome, { recursive: true }).some((path) => !before.has(path));
      const deadline = Date.now() + 5_000;
      while (!waiting() && Date.now() < deadline) await delay(10);
      assert.ok(waiting(), "migration did not reach lock acquisition");
      f.manifest({ skills: ["beta"] });
    },
    f.options,
  );
  finding(await pending, "E_MIGRATION_CHANGED");
  assert.deepEqual(JSON.parse(readFileSync(f.target, "utf8")), { skills: ["beta"] });
});

it("refuses a changed canonical destination after lock wait without replacing legacy intent", async (t) => {
  const f = fixture(t);
  f.manifest({ skills: [{ name: "alpha", source: `file://${f.source}` }] });
  const before = snapshot(f.target);
  const source = snapshot(f.source);
  let pending;
  await withLock(
    "skillex:activation:v2",
    async () => {
      const initial = new Set(readdirSync(f.stateHome, { recursive: true }));
      pending = migrate({ ...f.options, mapping: f.mapping, apply: true });
      const waiting = () =>
        readdirSync(f.stateHome, { recursive: true }).some((path) => !initial.has(path));
      const deadline = Date.now() + 5_000;
      while (!waiting() && Date.now() < deadline) await delay(10);
      assert.ok(waiting(), "migration did not reach lock acquisition");
      file(join(f.registry, "all-skills", "alpha", "SKILL.md"), "# Edited canonical definition\n");
    },
    f.options,
  );
  finding(await pending, "E_MIGRATION_CHANGED");
  assert.deepEqual(snapshot(f.target), before);
  assert.deepEqual(snapshot(f.source), source);
  assert.equal(existsSync(join(f.stateHome, "skillex", "migrations")), false);
});

it("retains legacy TOML through retirement failure and resumes verified publication without repeating the mapping", async (t) => {
  const f = fixture(t);
  f.toml();
  const options = { ...f.globalOptions(), mapping: f.packMapping, apply: true };
  const result = child(
    options,
    [
      "const original = fs.unlink;",
      "fs.unlink = async function(path, ...args) {",
      `  if (String(path) === ${JSON.stringify(f.legacy)}) throw Object.assign(new Error('fixture retirement failure'), {code:'EIO'});`,
      "  return original.call(this,path,...args);",
      "};",
    ].join("\n"),
  );
  finding(result, "E_IO", 4);
  assert.equal(existsSync(f.legacy), true);
  const target = join(f.home, ".agents", "skills.json");
  assert.equal(JSON.parse(readFileSync(target, "utf8")).packs[0].name, "tools");
  const before = snapshot(target);
  const preview = await unchanged(f.root, () => migrate(f.globalOptions()));
  finding(preview, "W_MIGRATION_MANIFEST_PENDING", 4);
  const resumed = ok(await migrate({ ...f.globalOptions(), apply: true }));
  assert.equal(existsSync(f.legacy), false);
  assert.deepEqual(snapshot(target), before);
  assert.ok(resumed.applied.includes(`manifest-retire:${f.legacy}`));
});

it("preserves changed TOML encountered after target verification instead of retiring stale evidence", async (t) => {
  const f = fixture(t);
  f.toml();
  const replacement = "[scopes.global]\nactive_pack='operator-edit'\n";
  const result = child(
    { ...f.globalOptions(), mapping: f.packMapping, apply: true },
    [
      "const original = fs.rename;",
      "fs.rename = async function(source,target,...args) {",
      "  let verified = false;",
      "  if (String(target).includes('/migrations/v2/')) {",
      "    try { verified = JSON.parse(await fs.readFile(source,'utf8')).data?.phase === 'verified'; } catch {}",
      "  }",
      "  const result = await original.call(this,source,target,...args);",
      `  if (verified) await fs.writeFile(${JSON.stringify(f.legacy)},${JSON.stringify(replacement)});`,
      "  return result;",
      "};",
    ].join("\n"),
  );
  finding(result, "E_MIGRATION_CHANGED", 4);
  assert.equal(readFileSync(f.legacy, "utf8"), replacement);
  assert.equal(
    JSON.parse(readFileSync(join(f.home, ".agents", "skills.json"), "utf8")).packs[0].name,
    "tools",
  );
});

it("refuses malformed migration receipts without clobbering current intent or verification evidence", async (t) => {
  const f = fixture(t);
  f.manifest({ skills: [{ name: "alpha", source: `file://${f.source}` }] });
  const data = ok(await migrate({ ...f.options, mapping: f.mapping, apply: true }));
  file(manifestReceipt(data, f.target, f.stateHome), '{"schema":2,');
  finding(
    await unchanged(f.root, () => migrate({ ...f.options, apply: true })),
    "E_RECEIPT_INVALID",
  );
});
