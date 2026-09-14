import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { migrate } from "@delorenj/skillex";
import { snapshot } from "./profile-fixture.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-migration-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const registry = join(root, "registry");
  const catalog = join(registry, "all-skills");
  const stateHome = join(root, "state");
  const prepared = join(registry, "docs", "vendoring", "sources.toml");
  const destination = join(catalog, "sources.toml");
  const file = (path, bytes) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };
  mkdirSync(home, { recursive: true });
  file(join(catalog, "alpha", "SKILL.md"), "# Alpha\n");
  file(
    join(catalog, "alpha", ".source.yaml"),
    "origin:\n  type: vendored\n  source: local-source\n  upstream: https://example.test/repo.git\n  upstream_version: previous-pin\n",
  );
  const text =
    'version = 1\n[[source]]\nname = "local-source"\nrepo = "https://example.test/repo.git"\nversion = "new-pin"\n';
  file(prepared, text);
  return {
    root,
    home,
    registry,
    catalog,
    stateHome,
    prepared,
    destination,
    text,
    file,
    options: { home, cwd: root, registryRoot: registry, stateHome, env: {} },
  };
}
function success(result) {
  assert.equal(result.exit, 0, JSON.stringify(result));
  return result.data;
}
function has(result, code) {
  assert.ok(
    result.findings.some((finding) => finding.code === code),
    JSON.stringify(result),
  );
}

test("source onboarding preview verifies recorded source identity without writes or changing pins", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const data = success(await migrate(f.options));
  assert.ok(data.items.some((item) => item.action === "onboard-source-declaration"));
  assert.deepEqual(data.applied, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("source onboarding publishes the exact prepared declaration, records evidence, and is idempotent", async (t) => {
  const f = fixture(t);
  const skillBefore = snapshot(join(f.catalog, "alpha"));
  const data = success(await migrate({ ...f.options, apply: true }));
  assert.equal(readFileSync(f.destination, "utf8"), f.text);
  assert.deepEqual(snapshot(join(f.catalog, "alpha")), skillBefore);
  const key = createHash("sha256").update(f.destination).digest("hex");
  const receipt = join(f.stateHome, "skillex", "migrations", "v2", `${key}.json`);
  assert.ok(data.receipts.includes(receipt));
  const saved = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(saved.data.phase, "verified");
  const before = snapshot(f.catalog);
  const bytes = readFileSync(receipt);
  const next = success(await migrate({ ...f.options, apply: true }));
  assert.deepEqual(next.applied, []);
  assert.deepEqual(snapshot(f.catalog), before);
  assert.deepEqual(readFileSync(receipt), bytes);
});

test("an existing source declaration remains authoritative over an invalid prepared fallback", async (t) => {
  const f = fixture(t);
  f.file(f.destination, f.text);
  f.file(f.prepared, "invalid = [");
  const before = snapshot(f.root);
  success(await migrate(f.options));
  assert.deepEqual(snapshot(f.root), before);
});

test("onboarding refuses a prepared source that changes recorded upstream identity", async (t) => {
  const f = fixture(t);
  f.file(f.prepared, f.text.replace("example.test/repo", "example.test/different"));
  const before = snapshot(f.catalog);
  const result = await migrate({ ...f.options, apply: true });
  assert.equal(result.exit, 3);
  has(result, "E_MIGRATION_SOURCES");
  assert.deepEqual(snapshot(f.catalog), before);
  assert.equal(existsSync(f.destination), false);
});

test("a missing explicit declaration cannot fall back to the prepared file", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = await migrate({ ...f.options, sourcesFile: join(f.root, "missing.toml") });
  assert.equal(result.exit, 3);
  has(result, "E_MIGRATION_SOURCES");
  assert.deepEqual(snapshot(f.root), before);
});

test("onboarding never overwrites a different existing declaration", async (t) => {
  const f = fixture(t);
  f.file(f.destination, f.text.replace("new-pin", "original-pin"));
  const before = snapshot(f.catalog);
  const result = await migrate({ ...f.options, sourcesFile: f.prepared, apply: true });
  assert.equal(result.exit, 3);
  has(result, "E_MIGRATION_SOURCES");
  assert.deepEqual(snapshot(f.catalog), before);
});

test("source migration refuses state inside its selected catalog before creating locks", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = await migrate({ ...f.options, stateHome: join(f.catalog, "state"), apply: true });
  assert.equal(result.exit, 3);
  has(result, "E_RECEIPT_UNSAFE_PATH");
  assert.deepEqual(snapshot(f.root), before);
});

test("unknown source staging remains visible and immutable on repeated migration", async (t) => {
  const f = fixture(t);
  const artifact = f.file(join(f.catalog, ".skillex-tmp-migrate-sources-unknown"), "foreign\n");
  const before = snapshot(f.catalog);
  for (const apply of [false, true, false]) {
    const result = await migrate({ ...f.options, apply });
    assert.equal(result.exit, 4);
    has(result, "W_MIGRATION_RECOVERY_PRESERVED");
    assert.equal(readFileSync(artifact, "utf8"), "foreign\n");
    assert.deepEqual(snapshot(f.catalog), before);
  }
});

test("an error immediately after source publication reports its actual prefix and recovers", async (t) => {
  const f = fixture(t);
  const original = fs.link;
  fs.link = async (source, target) => {
    await original(source, target);
    if (target === f.destination)
      throw Object.assign(new Error("injected post-publication error"), { code: "EIO" });
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await migrate({ ...f.options, apply: true });
  } finally {
    fs.link = original;
    syncBuiltinESMExports();
  }
  assert.equal(result.exit, 4, JSON.stringify(result));
  assert.ok(result.data.applied.includes(`sources:${f.destination}`));
  assert.equal(readFileSync(f.destination, "utf8"), f.text);
  const identity = lstatSync(f.destination).ino;
  const preview = await migrate(f.options);
  assert.equal(preview.exit, 4);
  has(preview, "W_MIGRATION_PENDING");
  success(await migrate({ ...f.options, apply: true }));
  assert.equal(lstatSync(f.destination).ino, identity);
});

test("an invalid explicit target refuses before onboarding an otherwise ready declaration", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = await migrate({
    ...f.options,
    project: join(f.root, "missing-project"),
    apply: true,
  });
  assert.equal(result.exit, 2);
  has(result, "E_MIGRATION_CONFIG");
  assert.deepEqual(snapshot(f.root), before);
});

test("registry-only migration ignores ambient project selection", async (t) => {
  const f = fixture(t);
  const project = join(f.root, "project");
  f.file(join(project, ".agents", "skills.json"), "invalid JSON");
  const before = snapshot(project);
  const data = success(await migrate({ ...f.options, cwd: project }));
  assert.deepEqual(data.targets, [f.registry]);
  assert.deepEqual(snapshot(project), before);
});

test("mapping schema and traversal errors are rejected before any catalog publication", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  for (const mapping of [
    { version: 2 },
    { version: 1, unknown: {} },
    { version: 1, names: { "../escape": "alpha" } },
    { version: 1, wrappers: { "sets/tools": { name: "hub", ownedPaths: ["../SKILL.md"] } } },
  ]) {
    const result = await migrate({ ...f.options, mapping, apply: true });
    assert.equal(result.exit, 2);
    has(result, "E_MIGRATION_CONFIG");
    assert.deepEqual(snapshot(f.root), before);
  }
});

test("already cancelled migration is immutable", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = await migrate({ ...f.options, apply: true, signal: { aborted: true } });
  assert.equal(result.exit, 130);
  assert.deepEqual(snapshot(f.root), before);
});
