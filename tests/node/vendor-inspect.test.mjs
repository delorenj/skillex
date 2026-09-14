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
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  doctor,
  inspectVendorStatus,
  listVendorSources,
  showVendorSource,
} from "@delorenj/skillex";

const repo = "https://example.test/upstream.git";
const commit = "a".repeat(40);
const tree = "b".repeat(40);

async function file(path, content, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, mode);
}

async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-vendor-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const registry = join(root, "registry");
  const config = join(root, "config");
  await Promise.all([
    mkdir(home),
    mkdir(cwd),
    mkdir(join(registry, "all-skills"), { recursive: true }),
  ]);
  return {
    root,
    home,
    cwd,
    registry,
    config,
    manifest: join(registry, "all-skills", "sources.toml"),
    mapping: join(config, "skillex", "sources.local.toml"),
    options: {
      home,
      cwd,
      registryRoot: registry,
      env: { XDG_CONFIG_HOME: config, PATH: join(root, "no-executables") },
    },
  };
}

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${key} = ${toml(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value);
}

function source(overrides = {}) {
  return { name: "upstream", repo, version: "main", skills: ["alpha"], ...overrides };
}

async function declarations(f, entries = [source()]) {
  await file(
    f.manifest,
    `version = 1\n${entries
      .map(
        (entry) =>
          `[[source]]\n${Object.entries(entry)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key} = ${toml(value)}\n`)
            .join("")}`,
      )
      .join("\n")}`,
  );
}

function wireDigest(files) {
  const records = [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = records
    .map(
      ([path, bytes, mode]) =>
        `${mode & 0o100 ? "100755" : "100644"} ${createHash("sha256").update(bytes).digest("hex")}  ${path}\n`,
    )
    .join("");
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function recorded(f, options = {}) {
  const name = options.name ?? "alpha";
  const path = join(f.registry, "all-skills", name);
  const files = options.files ?? [["SKILL.md", "# Instructions\nDo the work.\n", 0o644]];
  for (const [name, bytes, mode] of files) await file(join(path, name), bytes, mode);
  const digest = wireDigest(files);
  const raw = {
    origin: {
      type: "vendored",
      source: "upstream",
      upstream: repo,
      upstream_version: "main",
      upstream_commit: commit,
      upstream_tree: tree,
      upstream_path: `skills/${name}`,
      extracted_at: "2026-09-14T00:00:00+00:00",
      digest,
      ...options.origin,
    },
    modified_locally: false,
    ...options.raw,
  };
  const save = () => file(join(path, ".source.yaml"), `${JSON.stringify(raw, null, 2)}\n`);
  await save();
  return { name, path, files, raw, digest, save };
}

async function snapshot(root) {
  const result = [];
  const visit = async (path) => {
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file";
    result.push([
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
  return result;
}

function resultIs(result, exit, command, code) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, exit, JSON.stringify(result));
  assert.equal(result.command, command);
  if (code) {
    const finding = result.findings.find((item) => item.code === code);
    assert.ok(finding, `${code}: ${JSON.stringify(result)}`);
    assert.ok(finding.fix);
  }
  return result.data;
}

test("read APIs require the canonical declaration and never load a prepared migration file", async (t) => {
  const f = await fixture(t);
  await file(join(f.registry, "docs", "vendoring", "sources.toml"), "version = 1\n");
  const before = await snapshot(f.root);
  for (const [command, invoke] of [
    ["vendor list", () => listVendorSources(f.options)],
    ["vendor show", () => showVendorSource("upstream", f.options)],
    ["vendor status", () => inspectVendorStatus(f.options)],
  ])
    resultIs(await invoke(), 2, command, "E_SOURCES_MANIFEST_MISSING");
  assert.deepEqual(await snapshot(f.root), before);
});

test("declarations expose legacy defaults, shared checkout IDs, and explicit empty membership", async (t) => {
  const f = await fixture(t);
  await declarations(f, [
    source({ name: "Upstream-Tools", checkout: "shared", skills: [] }),
    source({ name: "discovery", checkout: "shared", skills: undefined, optional: true }),
    source({ name: "single", subdir: "", skills: [{ name: "alpha", dir: "Skill" }] }),
  ]);
  const before = await snapshot(f.root);
  const data = resultIs(await listVendorSources(f.options), 0, "vendor list");
  assert.deepEqual(
    data.sources.map(({ source }) => [source.name, source.membership, source.checkout]),
    [
      ["Upstream-Tools", "explicit", "shared"],
      ["discovery", "discovery", "shared"],
      ["single", "explicit", "single"],
    ],
  );
  assert.equal(data.sources[0].source.subdir, "skills");
  assert.deepEqual(data.sources[1].source.include, []);
  assert.equal(data.sources[1].source.optional, true);
  assert.deepEqual(data.sources[2].source.skills, [{ name: "alpha", dir: "Skill" }]);
  assert.equal(data.sources[2].source.subdir, "");
  assert.ok(data.sources.every(({ checkout }) => checkout.root === null));
  assert.deepEqual(await snapshot(f.root), before);
});

test("source selection deduplicates requested order and refuses unknown names or checkout IDs", async (t) => {
  const f = await fixture(t);
  await declarations(f, [source(), source({ name: "other", skills: [] })]);
  const data = resultIs(
    await listVendorSources({ ...f.options, sources: ["other", "upstream", "other"] }),
    0,
    "vendor list",
  );
  assert.deepEqual(
    data.sources.map(({ source }) => source.name),
    ["other", "upstream"],
  );
  resultIs(await showVendorSource("missing", f.options), 2, "vendor show", "E_SOURCE_UNKNOWN");
  resultIs(
    await inspectVendorStatus({ ...f.options, sources: ["missing"] }),
    2,
    "vendor status",
    "E_SOURCE_UNKNOWN",
  );
  resultIs(
    await listVendorSources({ ...f.options, checkouts: { misspelled: f.cwd } }),
    2,
    "vendor list",
    "E_SOURCE_CHECKOUT_UNKNOWN",
  );
});

for (const [label, overrides] of [
  ["machine checkout path", { checkout: "/tmp/upstream" }],
  ["traversing subdirectory", { subdir: "../skills" }],
  ["absolute subdirectory", { subdir: "/skills" }],
  ["control character in subdirectory", { subdir: "skills/\nprivate" }],
  ["traversing member directory", { skills: [{ name: "alpha", dir: "../alpha" }] }],
  ["duplicate member names", { skills: ["alpha", "alpha"] }],
  ["noncanonical skill name", { skills: ["Alpha"] }],
  ["unknown member field", { skills: [{ name: "alpha", branch: "main" }] }],
  ["explicit empty inventory with include", { skills: [], include: [] }],
  ["explicit inventory with exclude", { exclude: ["alpha"] }],
  ["nonboolean optional field", { optional: "yes" }],
  ["unsafe version expression", { version: "HEAD^{commit}" }],
  ["unknown source field", { experimental: true }],
])
  test(`invalid source declaration rejects ${label}`, async (t) => {
    const f = await fixture(t);
    await declarations(f, [source(overrides)]);
    const before = await snapshot(f.root);
    resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCES_MANIFEST_INVALID");
    assert.deepEqual(await snapshot(f.root), before);
  });

test("invalid TOML, schema versions, duplicate sources and retired fetch flags fail clearly", async (t) => {
  const f = await fixture(t);
  for (const text of ["version = [unterminated\n", "version = 2\n", "unrecognized = true\n"]) {
    await file(f.manifest, text);
    resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCES_MANIFEST_INVALID");
  }
  await declarations(f, [source(), source()]);
  resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCES_MANIFEST_INVALID");
  await declarations(f, [source({ fetch: true })]);
  resultIs(await listVendorSources(f.options), 2, "vendor list", "E_LEGACY_FIELD");
});

test("source declarations refuse symlinks, nonregular metadata and invalid UTF-8", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const text = await readFile(f.manifest);
  await file(join(f.root, "external.toml"), text);
  await rm(f.manifest);
  await symlink(join(f.root, "external.toml"), f.manifest);
  resultIs(await listVendorSources(f.options), 3, "vendor list", "E_NONCANONICAL_REFERENCE");
  await rm(f.manifest);
  await mkdir(f.manifest);
  resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCES_MANIFEST_INVALID");
  await rm(f.manifest, { recursive: true });
  await file(f.manifest, Buffer.from([0xff, 0xfe]));
  resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCES_MANIFEST_INVALID");
});

test("checkout precedence is explicit, environment, mapping, then default with canonical paths", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const explicit = join(f.cwd, "explicit");
  const environment = join(f.home, "environment");
  const mapping = join(f.root, "mapped");
  const fallback = join(f.home, "code", "upstream");
  for (const path of [explicit, environment, mapping, fallback])
    await mkdir(path, { recursive: true });
  await file(f.mapping, `[checkouts]\nupstream = ${toml(mapping)}\n`);
  const linked = join(f.cwd, "linked");
  await symlink(explicit, linked);
  const before = await snapshot(f.root);
  const inspect = async (options) =>
    resultIs(await listVendorSources(options), 0, "vendor list").sources[0].checkout;
  assert.deepEqual(
    await inspect({
      ...f.options,
      checkouts: { upstream: "linked" },
      env: { ...f.options.env, SKILLEX_SOURCE_UPSTREAM: "~/environment" },
    }),
    { id: "upstream", root: explicit, source: "argument", searched: [linked] },
  );
  assert.equal(
    (
      await inspect({
        ...f.options,
        env: { ...f.options.env, SKILLEX_SOURCE_UPSTREAM: "~/environment" },
      })
    ).root,
    environment,
  );
  assert.equal((await inspect(f.options)).source, "mapping");
  assert.equal((await inspect(f.options)).root, mapping);
  assert.deepEqual(await snapshot(f.root), before);
  await rm(mapping, { recursive: true });
  assert.deepEqual(await inspect(f.options), {
    id: "upstream",
    root: fallback,
    source: "default",
    searched: [mapping, fallback],
  });
});

test("explicit and environment checkout overrides never fall through when absent or invalid", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const fallback = join(f.home, "code", "upstream");
  await mkdir(fallback, { recursive: true });
  const missing = join(f.root, "missing");
  const options = {
    ...f.options,
    env: { ...f.options.env, SKILLEX_SOURCE_UPSTREAM: fallback },
    checkouts: { upstream: missing },
  };
  const data = resultIs(await listVendorSources(options), 0, "vendor list");
  assert.deepEqual(data.sources[0].checkout, {
    id: "upstream",
    root: null,
    source: "argument",
    searched: [missing],
  });
  for (const options of [
    { ...f.options, checkouts: { upstream: "" } },
    { ...f.options, env: { ...f.options.env, SKILLEX_SOURCE_UPSTREAM: "" } },
  ])
    resultIs(await listVendorSources(options), 2, "vendor list", "E_SOURCE_CHECKOUT_INVALID");
  await file(missing, "not a directory\n");
  resultIs(await listVendorSources(options), 2, "vendor list", "E_SOURCE_CHECKOUT_INVALID");
  await rm(missing);
  await symlink(join(f.root, "no-target"), missing);
  resultIs(await listVendorSources(options), 2, "vendor list", "E_SOURCE_CHECKOUT_INVALID");
});

test("invalid machine mappings block fallback but explicit checkout avoids irrelevant mappings", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  await file(f.mapping, "[checkouts\n");
  resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCE_CHECKOUTS_INVALID");
  resultIs(
    await listVendorSources({ ...f.options, checkouts: { upstream: f.cwd } }),
    0,
    "vendor list",
  );
  await file(f.mapping, "[checkouts]\nupstream = false\n");
  resultIs(await listVendorSources(f.options), 2, "vendor list", "E_SOURCE_CHECKOUTS_INVALID");
});

test("source show remains useful before first sync and exposes recorded orphan membership", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const first = resultIs(await showVendorSource("upstream", f.options), 0, "vendor show");
  assert.equal(first.membership, "explicit");
  assert.equal(first.skills[0].state, "missing");
  assert.equal(first.checkout.root, null);
  await recorded(f);
  await recorded(f, { name: "retired" });
  const before = await snapshot(f.root);
  const shown = resultIs(await showVendorSource("upstream", f.options), 0, "vendor show");
  assert.deepEqual(
    shown.skills.map(({ name, state }) => [name, state]),
    [
      ["alpha", "recorded"],
      ["retired", "orphaned"],
    ],
  );
  assert.ok(shown.skills.every(({ digest }) => digest === null));
  assert.deepEqual(await snapshot(f.root), before);
});

test("offline status verifies full bytes and mode wire format without checkout, mapping or Git", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f, {
    files: [
      ["SKILL.md", "# No frontmatter needed\n", 0o644],
      ["scripts/tool.sh", "#!/bin/sh\nexit 0\n", 0o755],
      ["support/session.log", "Authored support log\n", 0o644],
      [".cache/reference.txt", "Authored cache example\n", 0o644],
      ["support/é.txt", "Unicode name\n", 0o644],
      ["support/𐀀.txt", Buffer.from([0, 1, 0xff]), 0o644],
    ],
  });
  await file(f.mapping, "invalid TOML [[[\n");
  const before = await snapshot(f.root);
  const data = resultIs(
    await inspectVendorStatus({ ...f.options, checkouts: { upstream: "" } }),
    0,
    "vendor status",
  );
  assert.equal(data.upstream, false);
  assert.equal(data.sources[0].checkout, null);
  assert.equal(data.skills[0].state, "ok");
  assert.equal(data.skills[0].digest, entry.digest);
  assert.equal(data.skills[0].recordedCommit, commit);
  assert.deepEqual(await snapshot(f.root), before);
});

for (const [label, edit] of [
  ["instruction bytes", (path) => file(join(path, "SKILL.md"), "Changed instructions\n")],
  ["executable mode", (path) => chmod(join(path, "SKILL.md"), 0o755)],
  ["authored log", (path) => file(join(path, "notes.log"), "Authored reference\n")],
  ["nested authored cache", (path) => file(join(path, ".cache", "example.txt"), "Support\n")],
])
  test(`status detects ${label} changes independently of modified_locally flags`, async (t) => {
    const f = await fixture(t);
    await declarations(f);
    const entry = await recorded(f);
    await edit(entry.path);
    const before = await snapshot(f.root);
    const data = resultIs(
      await inspectVendorStatus(f.options),
      6,
      "vendor status",
      "W_SKILL_DIGEST_DRIFT",
    );
    assert.equal(data.skills[0].state, "modified");
    assert.notEqual(data.skills[0].digest, entry.digest);
    assert.deepEqual(await snapshot(f.root), before);
  });

test("receipt formatting and extra evidence leave the digest stable while a local-edit flag stays drift", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f, {
    raw: {
      modified_locally: true,
      previous_provenance: { origin: { type: "adhoc", path: "/old/source" } },
    },
  });
  const data = resultIs(
    await inspectVendorStatus(f.options),
    6,
    "vendor status",
    "W_VENDOR_LOCAL_EDITS",
  );
  assert.equal(data.skills[0].digest, entry.digest);
  assert.equal(data.skills[0].state, "modified");
  entry.raw.modified_locally = false;
  await entry.save();
  resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
});

test("offline status identifies version and explicit directory declaration drift without Git", async (t) => {
  const f = await fixture(t);
  await declarations(f, [
    source({
      version: "release/v2",
      subdir: "catalog",
      skills: [{ name: "alpha", dir: "upstream-alpha" }],
    }),
  ]);
  const entry = await recorded(f);
  const result = await inspectVendorStatus(f.options);
  const data = resultIs(result, 6, "vendor status", "W_VENDOR_DECLARATION_DRIFT");
  assert.equal(data.skills[0].state, "stale");
  assert.equal(data.skills[0].digest, entry.digest);
  const finding = result.findings.find(({ code }) => code === "W_VENDOR_DECLARATION_DRIFT");
  assert.equal(finding.detail.length, 2);
  entry.raw.origin.upstream_version = "release/v2";
  entry.raw.origin.upstream_path = "catalog/upstream-alpha";
  await entry.save();
  resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
});

test("offline discovery status compares recorded paths with the current declared subtree", async (t) => {
  const f = await fixture(t);
  await declarations(f, [source({ skills: undefined, subdir: "new-skills" })]);
  await recorded(f);
  resultIs(await inspectVendorStatus(f.options), 6, "vendor status", "W_VENDOR_DECLARATION_DRIFT");
});

test("missing receipt, digest or pin evidence is incomplete and never silently clean", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f);
  delete entry.raw.origin.digest;
  await entry.save();
  let data = resultIs(
    await inspectVendorStatus(f.options),
    4,
    "vendor status",
    "W_VENDOR_DIGEST_MISSING",
  );
  assert.equal(data.skills[0].state, "unknown");
  assert.equal(data.skills[0].digest, entry.digest);
  entry.raw.origin.digest = entry.digest;
  delete entry.raw.origin.upstream_commit;
  await entry.save();
  data = resultIs(
    await inspectVendorStatus(f.options),
    4,
    "vendor status",
    "W_VENDOR_PROVENANCE_INCOMPLETE",
  );
  assert.equal(data.skills[0].state, "unknown");
  await rm(join(entry.path, ".source.yaml"));
  data = resultIs(await inspectVendorStatus(f.options), 4, "vendor status", "W_VENDOR_UNRECORDED");
  assert.equal(data.skills[0].state, "unrecorded");
});

test("malformed provenance is configuration failure while valid foreign ownership is an invariant", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f);
  for (const text of [
    "origin: [unterminated\n",
    "origin: []\n",
    "origin:\n  digest: nope\n",
    "origin:\n  upstream_commit: 42\n",
    "origin:\n  upstream_commit: abbreviated\n",
    "origin:\n  upstream_tree: 'aaaa'\n",
    "origin:\n  upstream_path: ../outside\n",
    "origin:\n  upstream_path: /absolute\n",
    'origin:\n  upstream_path: "skills/\\nalpha"\n',
  ]) {
    await file(join(entry.path, ".source.yaml"), text);
    const data = resultIs(
      await inspectVendorStatus(f.options),
      2,
      "vendor status",
      "E_SKILL_PROVENANCE_INVALID",
    );
    assert.equal(data.skills[0].state, "invalid");
  }
  entry.raw.origin.source = "foreign";
  await entry.save();
  const data = resultIs(
    await inspectVendorStatus({ ...f.options, sources: ["upstream"] }),
    3,
    "vendor status",
    "E_SOURCE_IDENTITY_MISMATCH",
  );
  assert.equal(data.skills[0].state, "foreign");
});

test("complete SHA-256 Git object IDs are supported alongside SHA-1 receipts", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  await recorded(f, { origin: { upstream_commit: "c".repeat(64), upstream_tree: "d".repeat(64) } });
  const data = resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
  assert.equal(data.skills[0].recordedCommit, "c".repeat(64));
});

test("transport-equivalent receipt identity is accepted and different upstream is refused", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f, { origin: { upstream: "git@example.test:upstream.git" } });
  resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
  entry.raw.origin.upstream = "https://example.test/different.git";
  await entry.save();
  resultIs(await inspectVendorStatus(f.options), 3, "vendor status", "E_SOURCE_IDENTITY_MISMATCH");
});

test("symlinked receipts and canonical directories are refused without changing their targets", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f);
  const external = join(f.root, "external.yaml");
  await file(external, await readFile(join(entry.path, ".source.yaml")));
  await rm(join(entry.path, ".source.yaml"));
  await symlink(external, join(entry.path, ".source.yaml"));
  let before = await snapshot(f.root);
  resultIs(await inspectVendorStatus(f.options), 3, "vendor status", "E_NONCANONICAL_REFERENCE");
  assert.deepEqual(await snapshot(f.root), before);
  await rm(entry.path, { recursive: true });
  const target = join(f.root, "external-skill");
  await file(join(target, "SKILL.md"), "External\n");
  await symlink(target, entry.path);
  before = await snapshot(f.root);
  resultIs(await inspectVendorStatus(f.options), 3, "vendor status", "E_NONCANONICAL_REFERENCE");
  assert.deepEqual(await snapshot(f.root), before);
});

test("missing canonical content is an invariant and unknown digest formats remain incomplete", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  let data = resultIs(
    await inspectVendorStatus(f.options),
    3,
    "vendor status",
    "E_VENDOR_NOT_VENDORED",
  );
  assert.equal(data.skills[0].state, "missing");
  await recorded(f, { origin: { digest_format: "future-v9" } });
  data = resultIs(
    await inspectVendorStatus(f.options),
    4,
    "vendor status",
    "W_SKILL_DIGEST_UNSUPPORTED",
  );
  assert.equal(data.skills[0].state, "unknown");
});

for (const administration of [".git", ".hg", ".svn"])
  test(`nested ${administration} under an authored excluded directory is refused`, async (t) => {
    const f = await fixture(t);
    await declarations(f);
    const entry = await recorded(f);
    await file(join(entry.path, ".cache", administration, "config"), "administration\n");
    const data = resultIs(
      await inspectVendorStatus(f.options),
      3,
      "vendor status",
      "E_PROVENANCE_CONTENT_UNSAFE",
    );
    assert.equal(data.skills[0].state, "invalid");
    entry.raw.origin.digest_format = "skillex-tree-v1+symlinks";
    await entry.save();
    resultIs(
      await doctor({ ...f.options, scope: "global", sourcesOnly: true }),
      3,
      "doctor",
      "E_PROVENANCE_CONTENT_UNSAFE",
    );
  });

test("vendored support symlinks are refused even when their target is internal", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  const entry = await recorded(f);
  await symlink("SKILL.md", join(entry.path, "guide.md"));
  const before = await snapshot(f.root);
  resultIs(await inspectVendorStatus(f.options), 3, "vendor status", "E_PROVENANCE_CONTENT_UNSAFE");
  assert.deepEqual(await snapshot(f.root), before);
});

test("explicitly removed members are drift while unrecorded discovery membership is unknown", async (t) => {
  const f = await fixture(t);
  await declarations(f, [source({ skills: [] })]);
  await recorded(f);
  let data = resultIs(
    await inspectVendorStatus(f.options),
    6,
    "vendor status",
    "W_VENDOR_ORPHANED",
  );
  assert.equal(data.skills[0].state, "orphaned");
  await declarations(f, [source({ skills: undefined })]);
  data = resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
  assert.equal(data.sources[0].membership, "recorded");
  assert.equal(data.skills[0].state, "ok");
  await rm(join(f.registry, "all-skills", "alpha"), { recursive: true });
  resultIs(await inspectVendorStatus(f.options), 4, "vendor status", "W_VENDOR_MEMBERSHIP_UNKNOWN");
  await declarations(f, [source({ skills: [] })]);
  resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
});

test("undeclared recorded sources are reported without losing healthy selected observations", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  await recorded(f);
  await recorded(f, { name: "orphan", origin: { source: "removed" } });
  const data = resultIs(
    await inspectVendorStatus(f.options),
    3,
    "vendor status",
    "E_SOURCE_DECLARATION_MISSING",
  );
  assert.equal(data.skills[0].state, "ok");
  resultIs(await inspectVendorStatus({ ...f.options, sources: ["upstream"] }), 0, "vendor status");
});

test("requested upstream observation distinguishes required and optional unavailable checkouts", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  await recorded(f);
  let data = resultIs(
    await inspectVendorStatus({ ...f.options, upstream: true }),
    3,
    "vendor status",
    "E_SOURCE_CHECKOUT_MISSING",
  );
  assert.equal(data.skills[0].state, "unknown");
  assert.equal(data.skills[0].digest, data.skills[0].recordedDigest);
  await declarations(f, [source({ optional: true })]);
  data = resultIs(
    await inspectVendorStatus({ ...f.options, upstream: true }),
    4,
    "vendor status",
    "W_SOURCE_OPTIONAL_MISSING",
  );
  assert.equal(data.sources[0].checkout.root, null);
});

test("pre-aborted read APIs return interrupted results without writing any state", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  await recorded(f);
  const before = await snapshot(f.root);
  const options = { ...f.options, signal: { aborted: true } };
  resultIs(await listVendorSources(options), 130, "vendor list", "E_INTERRUPTED");
  resultIs(await showVendorSource("upstream", options), 130, "vendor show", "E_INTERRUPTED");
  resultIs(await inspectVendorStatus(options), 130, "vendor status", "E_INTERRUPTED");
  assert.deepEqual(await snapshot(f.root), before);
});

test("valid pending vendor journal keeps matching recorded content incomplete without recovery", async (t) => {
  const f = await fixture(t);
  await declarations(f, [source({ skills: undefined })]);
  await recorded(f);
  const stateHome = join(f.root, "explicit-state");
  const catalog = join(f.registry, "all-skills");
  const journal = join(
    stateHome,
    "skillex",
    "vendor",
    "v1",
    `${createHash("sha256").update(catalog).digest("hex")}.json`,
  );
  await file(
    journal,
    JSON.stringify({
      schema: 1,
      catalog,
      host: hostname(),
      uid: String(process.getuid?.() ?? 0),
      phase: "preparing",
      operations: [],
    }),
    0o600,
  );
  const before = await snapshot(f.root);
  const result = await inspectVendorStatus({ ...f.options, stateHome });
  const data = resultIs(result, 4, "vendor status", "W_VENDOR_RECOVERY_PENDING");
  assert.equal(data.skills[0].state, "ok");
  assert.equal(
    result.findings.find(({ code }) => code === "W_VENDOR_RECOVERY_PENDING").path,
    journal,
  );
  assert.deepEqual(await snapshot(f.root), before);
  resultIs(await inspectVendorStatus(f.options), 0, "vendor status");
  resultIs(await listVendorSources({ ...f.options, stateHome }), 0, "vendor list");
});

test("malformed or symlinked vendor state preserves source data and never repairs the journal", async (t) => {
  const f = await fixture(t);
  await declarations(f);
  await recorded(f);
  const stateHome = join(f.root, "state");
  const catalog = join(f.registry, "all-skills");
  const journal = join(
    stateHome,
    "skillex",
    "vendor",
    "v1",
    `${createHash("sha256").update(catalog).digest("hex")}.json`,
  );
  await file(journal, "{ malformed\n", 0o600);
  let before = await snapshot(f.root);
  let data = resultIs(
    await inspectVendorStatus({ ...f.options, stateHome }),
    3,
    "vendor status",
    "E_VENDOR_JOURNAL",
  );
  assert.equal(data.skills[0].state, "ok");
  assert.deepEqual(await snapshot(f.root), before);
  await rm(journal);
  const external = join(f.root, "external-state.json");
  await file(external, "{}\n");
  await symlink(external, journal);
  before = await snapshot(f.root);
  data = resultIs(
    await inspectVendorStatus({ ...f.options, stateHome }),
    3,
    "vendor status",
    "E_VENDOR_JOURNAL",
  );
  assert.equal(data.skills[0].state, "ok");
  assert.deepEqual(await snapshot(f.root), before);
});
