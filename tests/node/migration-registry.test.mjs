import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { migrate, verifyPack, withLock } from "@delorenj/skillex";
import { parse as parseToml } from "smol-toml";

async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-migration-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryRoot = join(root, "registry");
  const home = join(root, "home");
  const stateHome = join(root, "state");
  for (const path of [join(registryRoot, "all-skills"), home])
    await mkdir(path, { recursive: true });
  const file = async (path, bytes, mode) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    if (mode !== undefined) await chmod(path, mode);
    return path;
  };
  const skill = async (path, body = "# Shared instructions\n") => {
    await file(join(path, "SKILL.md"), body);
    return path;
  };
  return {
    root,
    registryRoot,
    home,
    stateHome,
    file,
    skill,
    canonical: (name) => join(registryRoot, "all-skills", name),
    set: (name) => join(registryRoot, "sets", name),
    pack: (name) => join(registryRoot, "packs", name),
    options: { registryRoot, home, stateHome, cwd: root, env: {} },
  };
}

async function snapshot(root) {
  const result = [];
  const walk = async (path) => {
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file";
    result.push([
      relative(root, path),
      kind,
      info.ino,
      info.mode,
      info.mtimeMs,
      kind === "file"
        ? (await readFile(path)).toString("hex")
        : kind === "link"
          ? await readlink(path)
          : null,
    ]);
    if (kind === "directory")
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  };
  await walk(root);
  return result;
}

function resultIs(result, exit, code) {
  assert.equal(result.schema, 2);
  assert.equal(result.command, "migrate");
  assert.equal(result.exit, exit, JSON.stringify(result));
  if (code)
    assert.ok(
      result.findings.some((item) => item.code === code),
      JSON.stringify(result),
    );
  return result.data;
}
function registryReceipt(f) {
  const key = createHash("sha256").update(join(f.registryRoot, "all-skills")).digest("hex");
  return join(f.stateHome, "skillex", "migrations", "v2", `${key}.json`);
}
async function pack(f, name, members, extra = "") {
  await f.file(
    join(f.pack(name), "pack.toml"),
    `[pack]\nname = "${name}"\nversion = "1.0.0"\n[freeform]\nskills = ${JSON.stringify(members)}\n${extra}`,
  );
  return f.pack(name);
}

test("registry migration preview inventories complete embedded content with zero filesystem writes", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  await f.file(join(source, ".hidden", "guide.txt"), "hidden support\n");
  await f.file(join(source, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  await f.file(join(source, ".source.yaml"), "origin:\n  type: local\n  note: preserve evidence\n");
  const before = await snapshot(f.root);
  const data = resultIs(await migrate(f.options), 0);
  assert.ok(
    data.items.some(
      (item) =>
        item.action === "import-definition" &&
        item.path === f.canonical("alpha") &&
        item.beforeDigest,
    ),
  );
  assert.ok(
    data.items.some(
      (item) =>
        item.action === "canonicalize-set" && item.dependsOn.includes("catalog:all-skills/alpha"),
    ),
  );
  assert.deepEqual(data.applied, []);
  assert.deepEqual(await snapshot(f.root), before);
});

test("apply preserves bytes, modes, provenance and support, then converges without further writes", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  await f.file(join(source, ".hidden", "guide.txt"), Buffer.from([0, 1, 2, 255]));
  await f.file(join(source, "run.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  const provenance = "origin:\n  type: local\n  note: original evidence\n";
  await f.file(join(source, ".source.yaml"), provenance);
  await f.file(join(f.set("tools"), "README.md"), "Composition support\n");
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.deepEqual(
    await readFile(join(f.canonical("alpha"), ".hidden", "guide.txt")),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal((await lstat(join(f.canonical("alpha"), "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(f.canonical("alpha"), ".source.yaml"), "utf8"), provenance);
  assert.equal(await realpath(source), f.canonical("alpha"));
  assert.equal(await readFile(join(f.set("tools"), "README.md"), "utf8"), "Composition support\n");
  const receiptPath = registryReceipt(f);
  assert.ok(data.receipts.includes(receiptPath));
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.data.phase, "complete");
  assert.ok(receipt.data.verified.some((item) => item.path === source && item.beforeDigest));
  const before = await snapshot(f.root);
  const again = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(await snapshot(f.root), before);
});

test("identical content reuses an existing canonical name and normalizes the set label", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("canonical"));
  await f.skill(join(f.set("tools"), "legacy"));
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.deepEqual((await readdir(join(f.registryRoot, "all-skills"))).sort(), ["canonical"]);
  assert.deepEqual(await readdir(f.set("tools")), ["canonical"]);
  assert.equal(await realpath(join(f.set("tools"), "canonical")), f.canonical("canonical"));
});

test("identical payloads with different provenance reuse content without losing either origin", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("canonical"));
  await f.file(
    join(f.canonical("canonical"), ".source.yaml"),
    "origin:\n  type: local\n  note: canonical origin\n",
  );
  const source = await f.skill(join(f.set("tools"), "legacy"));
  await f.file(join(source, ".source.yaml"), "origin:\n  type: local\n  note: legacy origin\n");
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.deepEqual(await readdir(join(f.registryRoot, "all-skills")), ["canonical"]);
  assert.match(
    await readFile(join(f.canonical("canonical"), ".source.yaml"), "utf8"),
    /canonical origin/,
  );
  const receipt = JSON.parse(await readFile(registryReceipt(f), "utf8"));
  assert.equal(receipt.data.provenance[source].origin.note, "legacy origin");
});

test("differing content receives a deterministic source-qualified canonical name", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"), "# Existing canonical\n");
  await f.skill(join(f.set("tools"), "alpha"), "# Independent variant\n");
  const first = resultIs(await migrate(f.options), 0);
  const second = resultIs(await migrate(f.options), 0);
  assert.deepEqual(first.items, second.items);
  assert.ok(
    first.items.some(
      (item) => item.path === f.canonical("tools-alpha") && item.action === "import-definition",
    ),
  );
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.equal(
    await readFile(join(f.canonical("alpha"), "SKILL.md"), "utf8"),
    "# Existing canonical\n",
  );
  assert.equal(
    await readFile(join(f.canonical("tools-alpha"), "SKILL.md"), "utf8"),
    "# Independent variant\n",
  );
});

test("duplicate embedded definitions share one new canonical destination", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("first"), "alpha"));
  await f.skill(join(f.set("second"), "alpha"));
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.equal(data.applied.filter((id) => id === "catalog:all-skills/alpha").length, 1);
  assert.equal(await realpath(join(f.set("first"), "alpha")), f.canonical("alpha"));
  assert.equal(await realpath(join(f.set("second"), "alpha")), f.canonical("alpha"));
});

test("explicit name and digest mappings refuse changed or conflicting content without cutover", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("chosen"), "# Existing\n");
  const source = await f.skill(join(f.set("tools"), "alpha"), "# Different\n");
  const before = await snapshot(f.root);
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, names: { "sets/tools/alpha": "chosen" } },
    }),
    3,
    "E_MIGRATION_NAME_CONFLICT",
  );
  assert.deepEqual(await snapshot(f.root), before);
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, digests: { [source]: `sha256:${"0".repeat(64)}` } },
    }),
    3,
    "E_MIGRATION_DIGEST",
  );
  assert.deepEqual(await snapshot(f.root), before);
});

test("digest values from preview pin the exact migrated definition inventory", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  const preview = resultIs(await migrate(f.options), 0);
  const digest = preview.items.find((item) => item.path === source).beforeDigest;
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: {
        version: 1,
        names: { "sets/tools/alpha": "selected" },
        digests: { "sets/tools/alpha": digest },
      },
    }),
    0,
  );
  assert.equal(await realpath(join(f.set("tools"), "selected")), f.canonical("selected"));
});

test("missing references block their composition while independent definitions are retained", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  const missing = join(f.set("tools"), "missing");
  await symlink("../../all-skills/missing", missing);
  const before = await snapshot(f.set("tools"));
  const preview = resultIs(await migrate(f.options), 3, "E_MIGRATION_REFERENCE");
  assert.ok(preview.items.some((item) => item.path === f.set("tools") && item.state === "blocked"));
  resultIs(await migrate({ ...f.options, apply: true }), 4, "E_MIGRATION_REFERENCE");
  assert.deepEqual(await snapshot(f.set("tools")), before);
  assert.ok((await lstat(source)).isDirectory());
  assert.equal(
    await readFile(join(f.canonical("alpha"), "SKILL.md"), "utf8"),
    "# Shared instructions\n",
  );
});

test("exact dangling-reference mappings repair names without inventing content", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("successor"));
  await mkdir(f.set("tools"), { recursive: true });
  await symlink("../../all-skills/gone", join(f.set("tools"), "old"));
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, references: { "sets/tools/old": "successor" } },
    }),
    0,
  );
  assert.deepEqual(await readdir(f.set("tools")), ["successor"]);
  assert.equal(await realpath(join(f.set("tools"), "successor")), f.canonical("successor"));
});

test("null mappings retire exact symbolic references and preserve their real referents", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  await mkdir(f.set("tools"), { recursive: true });
  await symlink("../../all-skills/alpha", join(f.set("tools"), "alpha"));
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, references: { "sets/tools/alpha": null } },
    }),
    0,
  );
  assert.deepEqual(await readdir(f.set("tools")), []);
  assert.ok((await lstat(f.canonical("alpha"))).isDirectory());
  await f.skill(join(f.set("tools"), "real"));
  const before = await snapshot(f.root);
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, references: { "sets/tools/real": null } },
    }),
    3,
    "E_MIGRATION_REFERENCE",
  );
  assert.deepEqual(await snapshot(f.root), before);
});

test("nested pack inventories and assigned slots become explicit canonical leaf membership", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("base"), "# Base\n");
  const path = await pack(
    f,
    "bundle",
    ["container"],
    '[slots.agent]\nskill = "base"\nrequired = true\n[policy]\nflatten = true\nsealed = false\n[source]\nupstream = "fixture"\n',
  );
  await f.skill(join(path, "container", "alpha"), "# Alpha\n");
  await f.skill(join(path, "container", "deep", "beta"), "# Beta\n");
  await f.file(join(path, "scripts", "pack.sh"), "#!/bin/sh\ntrue\n", 0o755);
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  const raw = parseToml(await readFile(join(path, "pack.toml"), "utf8"));
  assert.deepEqual(raw.freeform.skills, ["base", "alpha", "beta"]);
  assert.equal(raw.policy, undefined);
  assert.equal(raw.slots, undefined);
  assert.equal(raw.source.legacy_migration.policy.flatten, true);
  assert.equal(raw.source.upstream, "fixture");
  assert.equal((await lstat(join(path, "scripts", "pack.sh"))).mode & 0o777, 0o755);
  const verified = await verifyPack("bundle", f.options);
  assert.equal(verified.exit, 0, JSON.stringify(verified));
  const before = await snapshot(f.root);
  assert.deepEqual(resultIs(await migrate({ ...f.options, apply: true }), 0).applied, []);
  assert.deepEqual(await snapshot(f.root), before);
});

test("missing pack versions require authored mappings instead of an invented default", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  await f.file(
    join(f.pack("bundle"), "pack.toml"),
    '[pack]\nname = "bundle"\n[freeform]\nskills = ["alpha"]\n',
  );
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 3, "E_MIGRATION_PACK_MAPPING");
  assert.deepEqual(await snapshot(f.root), before);
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, packs: { "packs/bundle": { name: "bundle", version: "2.0.0" } } },
    }),
    0,
  );
  assert.equal((await verifyPack("bundle", f.options)).exit, 0);
});

test("an explicitly renamed manifest-less pack preserves all content before retiring its old root", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  const old = f.pack("LegacyBundle");
  await f.file(join(old, "README.md"), "Preserved pack support\n");
  await symlink("../../all-skills/alpha", join(old, "alpha"));
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: {
        version: 1,
        packs: { "packs/LegacyBundle": { name: "legacy-bundle", version: "1.0.0" } },
      },
    }),
    0,
  );
  assert.equal(existsSync(old), false);
  assert.equal(
    await readFile(join(f.pack("legacy-bundle"), "README.md"), "utf8"),
    "Preserved pack support\n",
  );
  assert.equal((await verifyPack("legacy-bundle", f.options)).exit, 0);
});

test("a case-only pack rename recovers interrupted publication and preserves canonical spelling", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  const source = f.pack("CaseBundle");
  const destination = f.pack("casebundle");
  await f.file(join(source, "run.sh"), "#!/bin/sh\nprintf preserved\n", 0o755);
  await symlink("../../all-skills/alpha", join(source, "alpha"));
  const original = await lstat(source, { bigint: true });
  const caseFolded = existsSync(destination);
  const options = {
    ...f.options,
    mapping: {
      version: 1,
      packs: { "packs/CaseBundle": { name: "casebundle", version: "1.0.0" } },
    },
  };
  const before = await snapshot(f.root);
  resultIs(await migrate(options), 0);
  assert.deepEqual(await snapshot(f.root), before);
  const interrupted = await migrate({
    ...options,
    apply: true,
    signal: {
      get aborted() {
        try {
          return JSON.parse(readFileSync(registryReceipt(f), "utf8")).data.phase === "ready";
        } catch {
          return false;
        }
      },
    },
  });
  resultIs(interrupted, 130, "E_INTERRUPTED");
  const pending = JSON.parse(await readFile(registryReceipt(f), "utf8"));
  const operation = pending.data.operations[0];
  assert.equal(operation.path, destination);
  assert.ok(operation.after);
  if (caseFolded) {
    // A case-insensitive filesystem aliases the two spellings. Simulate a
    // crash after the original entry was parked but before publication.
    assert.equal(pending.data.operations.length, 1);
    assert.equal(operation.before.root.dev, String(original.dev));
    assert.equal(operation.before.root.ino, String(original.ino));
    assert.ok(operation.parked);
    await rename(operation.path, operation.parked);
  } else {
    // On a case-sensitive filesystem, the independent new destination can
    // publish first. Simulate a crash before the old spelling is retired.
    assert.equal(pending.data.operations.length, 2);
    assert.equal(operation.before, null);
    await rename(operation.stage, operation.path);
  }
  resultIs(await migrate({ ...options, apply: true }), 0);
  assert.deepEqual(await readdir(join(f.registryRoot, "packs")), ["casebundle"]);
  assert.equal(
    await readFile(join(destination, "run.sh"), "utf8"),
    "#!/bin/sh\nprintf preserved\n",
  );
  assert.equal((await lstat(join(destination, "run.sh"))).mode & 0o777, 0o755);
  assert.equal((await verifyPack("casebundle", f.options)).exit, 0);
  assert.equal(JSON.parse(await readFile(registryReceipt(f), "utf8")).data.phase, "complete");
  const converged = await snapshot(f.root);
  assert.deepEqual(resultIs(await migrate({ ...options, apply: true }), 0).applied, []);
  assert.deepEqual(await snapshot(f.root), converged);
});

test("mapped composition renames refuse a distinct existing destination even with identical content", async (t) => {
  const f = await fixture(t);
  const source = f.pack("CaseBundle");
  await f.file(join(source, "README.md"), "Preserved support\n");
  // Two differently cased entries can coexist only on a case-sensitive
  // filesystem; elsewhere use a distinct mapped name for the same refusal.
  const name = existsSync(f.pack("casebundle")) ? "casebundle-other" : "casebundle";
  const destination = f.pack(name);
  await f.file(join(destination, "README.md"), "Preserved support\n");
  const before = await snapshot(f.root);
  const result = await migrate({
    ...f.options,
    apply: true,
    mapping: { version: 1, packs: { "packs/CaseBundle": { name, version: "1.0.0" } } },
  });
  resultIs(result, 3, "E_MIGRATION_COMPOSITION");
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "E_MIGRATION_COMPOSITION" && finding.path === destination,
    ),
  );
  assert.deepEqual(await snapshot(f.root), before);
});

test("explicitly retiring the stale Kurzgesagt creator reference preserves other creator definitions", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("system-skill-creator"), "# Independent creator\n");
  const embedded = await f.skill(
    join(f.set("global"), ".system", "skill-creator"),
    "# Independent creator\n",
  );
  await f.skill(f.canonical("alpha"), "# Alpha\n");
  const legacy = f.pack("Kurzgesagt");
  await mkdir(legacy, { recursive: true });
  await symlink("../../all-skills/alpha", join(legacy, "alpha"));
  await symlink("../../all-skills/skill-creator", join(legacy, "skill-creator"));
  const mapping = {
    version: 1,
    references: { "packs/Kurzgesagt/skill-creator": null },
    packs: { "packs/Kurzgesagt": { name: "kurzgesagt", version: "1.0.0" } },
  };
  resultIs(await migrate({ ...f.options, mapping, apply: true }), 0);
  const raw = parseToml(await readFile(join(f.pack("kurzgesagt"), "pack.toml"), "utf8"));
  assert.deepEqual(raw.freeform.skills, ["alpha"]);
  assert.equal(existsSync(join(f.pack("kurzgesagt"), "skill-creator")), false);
  assert.equal(await realpath(embedded), f.canonical("system-skill-creator"));
  assert.equal(
    await readFile(join(f.canonical("system-skill-creator"), "SKILL.md"), "utf8"),
    "# Independent creator\n",
  );
  assert.equal(existsSync(f.canonical("skill-creator")), false);
});

test("undeclared or real generated pack content is preserved and blocks cutover", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  const path = await pack(f, "bundle", ["alpha"]);
  await f.file(join(path, "skills", "notes.txt"), "Local support\n");
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 3, "E_MIGRATION_PACK_ROOT");
  assert.deepEqual(await snapshot(f.root), before);
});

test("set wrapper ownership is explicit and inline relative routes are checked", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  const path = await f.skill(f.set("hub"), "# Router\nRead `alpha/SKILL.md`.\n");
  await symlink("../../all-skills/alpha", join(path, "alpha"));
  resultIs(await migrate(f.options), 3, "E_MIGRATION_WRAPPER_MAPPING");
  const mapping = {
    version: 1,
    wrappers: { "sets/hub": { name: "hub-router", ownedPaths: ["SKILL.md"] } },
  };
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true, mapping }), 3, "E_MIGRATION_WRAPPER_ROUTES");
  assert.deepEqual(await snapshot(f.root), before);
  await f.file(join(path, "SKILL.md"), "# Router\nRead `../alpha/SKILL.md`.\n");
  resultIs(await migrate({ ...f.options, apply: true, mapping }), 0);
  assert.equal(
    await readFile(join(f.canonical("hub-router"), "SKILL.md"), "utf8"),
    "# Router\nRead `../alpha/SKILL.md`.\n",
  );
  assert.deepEqual((await readdir(path)).sort(), ["alpha", "hub-router"]);
});

test("hidden system definitions are preserved and referenced in place without gaining set membership", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("global"), ".system", "alpha"));
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  // The bytes move to the catalog, because a composition may hold no real definition...
  assert.equal(await realpath(join(f.set("global"), ".system", "alpha")), f.canonical("alpha"));
  assert.ok((await lstat(join(f.set("global"), ".system"))).isDirectory());
  // ...but activation never read a hidden entry as a member, so none is invented at the top.
  assert.equal(existsSync(join(f.set("global"), "alpha")), false);
  const item = data.items.find((entry) => entry.path === f.set("global"));
  assert.ok(item.details.includes("Canonical membership: "), item.details.join("\n"));
});

test("linked external set roots become real compositions while external source content survives", async (t) => {
  const f = await fixture(t);
  const external = join(f.root, "external");
  await f.skill(join(external, "alpha"));
  await f.file(join(external, "README.md"), "External support\n");
  await mkdir(dirname(f.set("linked")), { recursive: true });
  await symlink(external, f.set("linked"));
  const before = await snapshot(external);
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.ok((await lstat(f.set("linked"))).isDirectory());
  assert.equal(await realpath(join(f.set("linked"), "alpha")), f.canonical("alpha"));
  assert.deepEqual(await snapshot(external), before);
});

test("a linked canonical definition is materialized without modifying its external source", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.root, "external"));
  await symlink(source, f.canonical("alpha"));
  const before = await snapshot(source);
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.ok((await lstat(f.canonical("alpha"))).isDirectory());
  assert.deepEqual(await snapshot(source), before);
});

test("an identical canonical alias is retired only after its composition references are normalized", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("canonical"));
  await symlink("canonical", f.canonical("legacy"));
  await mkdir(f.set("tools"), { recursive: true });
  await symlink("../../all-skills/legacy", join(f.set("tools"), "legacy"));
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.deepEqual(await readdir(join(f.registryRoot, "all-skills")), ["canonical"]);
  assert.equal(await realpath(join(f.set("tools"), "canonical")), f.canonical("canonical"));
});

test("explicit absolute source mappings can preserve an unlinked local definition", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.root, "external"));
  const before = await snapshot(source);
  resultIs(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, names: { [source]: "external-skill" } },
    }),
    0,
  );
  assert.ok((await lstat(f.canonical("external-skill"))).isDirectory());
  assert.deepEqual(await snapshot(source), before);
});

test("unsafe support links and malformed metadata preserve affected definitions", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  await f.file(join(f.root, "outside.txt"), "External support\n");
  await symlink(join(f.root, "outside.txt"), join(source, "escape"));
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 3, "E_MIGRATION_CONTENT");
  assert.deepEqual(await snapshot(f.root), before);
  await rm(join(source, "escape"));
  await f.file(join(source, "SKILL.md"), "---\nname: [malformed\n---\n");
  const malformed = await migrate({ ...f.options, apply: true });
  assert.ok(malformed.findings.some((item) => item.code === "E_SKILL_METADATA_INVALID"));
  assert.equal(existsSync(f.canonical("alpha")), false);
});

test("Python runtime caches block candidate imports while preserving source and existing canonical content", async (t) => {
  const f = await fixture(t);
  const canonical = await f.skill(f.canonical("existing"));
  await f.file(join(canonical, "scripts", "__pycache__", "module.pyc"), "Existing cache\n");
  const candidates = [
    ["alpha", join("scripts", "__pycache__"), "marker"],
    ["bravo", join("scripts", "module.pyc")],
    ["charlie", join("scripts", "module.pyo")],
  ];
  for (const [name, runtime, child] of candidates) {
    const source = await f.skill(join(f.set("tools"), name));
    await f.file(join(source, runtime, ...(child ? [child] : [])), "Generated cache\n");
  }
  const before = await snapshot(f.root);
  for (const apply of [false, true]) {
    const result = await migrate({ ...f.options, apply });
    const data = resultIs(result, 3, "E_MIGRATION_RUNTIME_CONTENT");
    for (const [name, runtime] of candidates) {
      const source = join(f.set("tools"), name);
      assert.ok(
        result.findings.some(
          (finding) =>
            finding.code === "E_MIGRATION_RUNTIME_CONTENT" &&
            finding.path === join(source, runtime) &&
            finding.fix.includes("verified generated"),
        ),
      );
      assert.ok(data.items.some((item) => item.path === source && item.state === "blocked"));
      assert.equal(existsSync(f.canonical(name)), false);
    }
    assert.ok(data.items.some((item) => item.path === f.set("tools") && item.state === "blocked"));
    assert.ok(
      data.items.some((item) => item.path === canonical && item.action === "preserve-canonical"),
    );
    assert.deepEqual(data.applied, []);
    assert.deepEqual(await snapshot(f.root), before);
  }
});

const overLimit = 129 * 1024 * 1024;
async function sparse(path, size = overLimit) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  await truncate(path, size);
  const info = await stat(path);
  assert.equal(info.size, size);
  // Sparse: the fixture claims no real disk for its >128 MiB payload.
  assert.ok(info.blocks * 512 < 1024 * 1024, `expected a sparse file, got ${info.blocks} blocks`);
  return path;
}

test("ignored node_modules in a canonical definition never trips the content limit or its digest", async (t) => {
  const f = await fixture(t);
  const canonical = await f.skill(f.canonical("letterifier"));
  await f.file(join(canonical, "remotion", "package.json"), '{"name":"render"}\n');
  const bundled = await sparse(
    join(canonical, "remotion", "node_modules", ".remotion", "chrome-headless-shell"),
  );
  await f.file(
    join(canonical, "remotion", "node_modules", "pkg", "index.js"),
    "module.exports=1\n",
  );
  const before = await snapshot(f.root);
  for (const apply of [false, true]) {
    const result = await migrate({ ...f.options, apply });
    const data = resultIs(result, 0);
    assert.ok(!result.findings.some((item) => item.code === "E_MIGRATION_CONTENT"));
    const item = data.items.find((entry) => entry.path === canonical);
    assert.equal(item?.action, "preserve-canonical");
    assert.equal(item?.state, "preserved");
    assert.equal((await stat(bundled)).size, overLimit);
  }
  assert.deepEqual(await snapshot(f.root), before);

  // The digest is the authored definition only: dropping the generated tree leaves it unchanged.
  const withGenerated = (await migrate(f.options)).data.items.find(
    (entry) => entry.path === canonical,
  ).beforeDigest;
  await rm(join(canonical, "remotion", "node_modules"), { recursive: true });
  const authoredOnly = (await migrate(f.options)).data.items.find(
    (entry) => entry.path === canonical,
  ).beforeDigest;
  assert.equal(withGenerated, authoredOnly);
});

test("an authored file over 128 MiB still blocks its canonical definition", async (t) => {
  const f = await fixture(t);
  const canonical = await f.skill(f.canonical("letterifier"));
  await sparse(join(canonical, "remotion", "node_modules", "huge.bin"));
  const authored = await sparse(join(canonical, "assets", "huge.bin"));
  const before = await snapshot(f.root);
  for (const apply of [false, true]) {
    const result = await migrate({ ...f.options, apply });
    const data = resultIs(result, 3, "E_MIGRATION_CONTENT");
    const content = result.findings.filter((item) => item.code === "E_MIGRATION_CONTENT");
    assert.deepEqual(
      content.map((item) => item.path),
      [authored],
    );
    assert.ok(data.items.some((item) => item.path === canonical && item.state === "blocked"));
    assert.deepEqual(data.applied, []);
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("a composition that migration would replace refuses generated content it cannot remove", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("tools"), "alpha"));
  const generated = join(f.set("tools"), "node_modules");
  await f.file(join(generated, "pkg", "index.js"), "module.exports=1\n");
  const setBefore = await snapshot(f.set("tools"));
  // Apply still imports the clean definition (a copy), so it reports a partial result (4);
  // the composition itself, and its generated tree, are never parked or removed.
  for (const [apply, exit] of [
    [false, 3],
    [true, 4],
  ]) {
    const result = await migrate({ ...f.options, apply });
    const data = resultIs(result, exit, "E_MIGRATION_RUNTIME_CONTENT");
    assert.ok(
      result.findings.some(
        (item) =>
          item.code === "E_MIGRATION_RUNTIME_CONTENT" &&
          item.path === generated &&
          item.fix.includes("verified generated"),
      ),
    );
    assert.ok(data.items.some((item) => item.path === f.set("tools") && item.state === "blocked"));
    assert.deepEqual(await snapshot(f.set("tools")), setBefore);
  }
  // Once the generated tree is gone the same composition migrates cleanly.
  await rm(generated, { recursive: true });
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.equal(await realpath(join(f.set("tools"), "alpha")), f.canonical("alpha"));
});

test("an unchanged composition keeps its generated content without blocking", async (t) => {
  const f = await fixture(t);
  await f.skill(f.canonical("alpha"));
  await mkdir(f.set("tools"), { recursive: true });
  await symlink("../../all-skills/alpha", join(f.set("tools"), "alpha"));
  await f.file(join(f.set("tools"), ".DS_Store"), "finder\n");
  const before = await snapshot(f.root);
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.ok(
    data.items.some(
      (item) => item.path === f.set("tools") && item.action === "preserve-composition",
    ),
  );
  assert.deepEqual(await snapshot(f.root), before);
});

// Import skips secrets, logs and backups by name; migration must not. These are authored files
// (the real catalog tracks n8n-self-hosting/assets/.env.queue.example and
// starship-customization/.logs/subtask2.log), and a legacy composition holding a copy of such a
// skill must migrate byte for byte instead of being refused as "generated" content.
const authoredButImportExcluded = {
  [join("assets", ".env.queue.example")]: "QUEUE=redis\n",
  [join("assets", ".env.single.example")]: "MODE=single\n",
  [join(".logs", "subtask2.log")]: "fixture log\n",
  [join("tests", "fixtures", "app.log")]: "GET / 200\n",
  ".env.local": "LOCAL=1\n",
  [join("docs", "guide.md.orig")]: "original guide\n",
  [join("docs", "notes.bak")]: "backup notes\n",
  [join("docs", "draft~")]: "draft\n",
};

test("authored example, log, backup and env files in a legacy composition migrate byte for byte", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(
    join(f.set("legacy"), "n8n-legacy"),
    "---\nname: n8n-legacy\n---\n# Legacy copy\n",
  );
  for (const [path, bytes] of Object.entries(authoredButImportExcluded))
    await f.file(join(source, path), bytes);
  const before = await snapshot(f.root);
  const preview = await migrate(f.options);
  const data = resultIs(preview, 0);
  assert.ok(!preview.findings.some((item) => item.code === "E_MIGRATION_RUNTIME_CONTENT"));
  const imported = data.items.find(
    (item) => item.action === "import-definition" && item.path === f.canonical("n8n-legacy"),
  );
  assert.equal(imported?.state, "ready", JSON.stringify(data.items));
  assert.ok(imported.details.some((line) => line.startsWith("All captured definition bytes")));
  assert.ok(
    data.items.some(
      (item) =>
        item.path === f.set("legacy") &&
        item.action === "canonicalize-set" &&
        item.state === "ready",
    ),
  );
  assert.deepEqual(await snapshot(f.root), before);

  resultIs(await migrate({ ...f.options, apply: true }), 0);
  for (const [path, bytes] of Object.entries(authoredButImportExcluded))
    assert.equal(await readFile(join(f.canonical("n8n-legacy"), path), "utf8"), bytes, path);
  assert.equal(await realpath(join(f.set("legacy"), "n8n-legacy")), f.canonical("n8n-legacy"));

  // They are evidence too: changing an authored log changes the canonical digest.
  const digest = async () =>
    (await migrate(f.options)).data.items.find((item) => item.path === f.canonical("n8n-legacy"))
      .beforeDigest;
  const first = await digest();
  await f.file(join(f.canonical("n8n-legacy"), "tests", "fixtures", "app.log"), "GET / 500\n");
  assert.notEqual(await digest(), first);
});

test("materializing a linked canonical carries authored files and discloses only the generated ones it skips", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.root, "ext", "logparse"));
  const authored = {
    [join("tests", "fixtures", "app.log")]: "GET / 200\n",
    [join("assets", ".env.prod.example")]: "HOST=example\n",
  };
  for (const [path, bytes] of Object.entries(authored)) await f.file(join(source, path), bytes);
  await f.file(join(source, "scripts", "__pycache__", "parse.cpython-312.pyc"), "bytecode\n");
  await f.file(join(source, "node_modules", "pkg", "index.js"), "module.exports=1\n");
  await symlink(source, f.canonical("logparse"));
  const external = await snapshot(source);
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.ok((await lstat(f.canonical("logparse"))).isDirectory());
  for (const [path, bytes] of Object.entries(authored))
    assert.equal(await readFile(join(f.canonical("logparse"), path), "utf8"), bytes, path);
  assert.equal(existsSync(join(f.canonical("logparse"), "node_modules")), false);
  assert.equal(existsSync(join(f.canonical("logparse"), "scripts", "__pycache__")), false);
  const item = data.items.find(
    (entry) => entry.action === "materialize-canonical" && entry.path === f.canonical("logparse"),
  );
  assert.equal(item?.state, "verified", JSON.stringify(data.items));
  // Never claim every byte was preserved when some were skipped; name exactly what was skipped.
  assert.ok(!item.details.some((line) => line.startsWith("All captured")), item.details.join("\n"));
  const skipped = item.details.filter((line) => line.includes("not copied"));
  assert.equal(skipped.length, 1, item.details.join("\n"));
  assert.ok(skipped[0].includes("node_modules"), skipped[0]);
  assert.ok(skipped[0].includes(join("scripts", "__pycache__")), skipped[0]);
  assert.ok(!skipped[0].includes("app.log") && !skipped[0].includes(".env.prod.example"));
  assert.deepEqual(await snapshot(source), external);
});

async function aliasedLegacy(f, extra) {
  await f.skill(f.canonical("canonical"));
  const legacy = await f.skill(join(f.root, "ext", "legacy"));
  await extra(legacy);
  await symlink(legacy, f.canonical("legacy"));
  await mkdir(f.set("tools"), { recursive: true });
  await symlink("../../all-skills/legacy", join(f.set("tools"), "legacy"));
  return legacy;
}

test("an alias that differs from a canonical only by an authored log is materialized, never retired as identical", async (t) => {
  const f = await fixture(t);
  const legacy = await aliasedLegacy(f, (path) =>
    f.file(join(path, "sample.log"), "authored sample\n"),
  );
  const external = await snapshot(legacy);
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.ok(
    !data.items.some((item) => item.action === "retire-canonical-alias"),
    JSON.stringify(data.items),
  );
  assert.ok((await lstat(f.canonical("legacy"))).isDirectory());
  assert.equal(
    await readFile(join(f.canonical("legacy"), "sample.log"), "utf8"),
    "authored sample\n",
  );
  assert.equal(await realpath(join(f.set("tools"), "legacy")), f.canonical("legacy"));
  assert.deepEqual(await snapshot(legacy), external);
});

test("an alias identical to a canonical except for generated entries is retired and says what stays behind", async (t) => {
  const f = await fixture(t);
  const legacy = await aliasedLegacy(f, (path) =>
    f.file(join(path, "__pycache__", "helper.cpython-312.pyc"), "bytecode\n"),
  );
  const external = await snapshot(legacy);
  const data = resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.deepEqual(await readdir(join(f.registryRoot, "all-skills")), ["canonical"]);
  assert.equal(await realpath(join(f.set("tools"), "canonical")), f.canonical("canonical"));
  for (const action of ["retire-canonical-alias", "reuse-definition"]) {
    const item = data.items.find(
      (entry) => entry.action === action && entry.path === f.canonical("legacy"),
    );
    assert.ok(item, `${action}: ${JSON.stringify(data.items)}`);
    assert.ok(
      item.details.some((line) => line.includes("__pycache__") && line.includes("not carried")),
      `${action}: ${item.details.join("\n")}`,
    );
    assert.ok(
      !item.details.some((line) => line.startsWith("Identical definition content")),
      `${action}: ${item.details.join("\n")}`,
    );
  }
  assert.deepEqual(await snapshot(legacy), external);
});

// Activation never reads dot- or underscore-prefixed set entries (composition.ts setMembers),
// and neither did the legacy projector. The real sets/global/.system is a gitignored,
// Codex-written projection (a marker plus links); promoting it to top-level membership would
// track six new links and widen every activation that inherits the set.
test("hidden and underscore projection entries in a set never become canonical membership", async (t) => {
  const f = await fixture(t);
  for (const name of ["alpha", "bravo", "imagegen", "skill-creator"])
    await f.skill(f.canonical(name));
  const external = await f.skill(join(f.root, "installer", "external-tool"));
  const set = f.set("global");
  await mkdir(join(set, ".system"), { recursive: true });
  await mkdir(join(set, "_archive"), { recursive: true });
  await symlink("../../all-skills/alpha", join(set, "alpha"));
  await f.file(join(set, ".lastagent"), "codex 1789428008\n");
  await f.file(join(set, ".system", ".codex-system-skills.marker"), "codex-managed\n");
  await symlink("../../../all-skills/imagegen", join(set, ".system", "imagegen"));
  await symlink("../../../all-skills/skill-creator", join(set, ".system", "skill-creator"));
  await symlink(external, join(set, ".system", "external-tool"));
  await symlink("../../../all-skills/bravo", join(set, "_archive", "bravo"));
  const before = await snapshot(f.root);
  for (const apply of [false, true]) {
    const result = await migrate({ ...f.options, apply });
    const data = resultIs(result, 0);
    const item = data.items.find((entry) => entry.path === set);
    assert.equal(item?.action, "preserve-composition", JSON.stringify(item));
    assert.equal(item.state, "preserved");
    assert.ok(item.details.includes("Canonical membership: alpha"), item.details.join("\n"));
    // Installer-owned content is never claimed for the catalog.
    assert.equal(existsSync(f.canonical("external-tool")), false);
    assert.ok(!data.items.some((entry) => entry.path === join(set, ".system", "external-tool")));
    assert.deepEqual(data.applied, []);
    assert.deepEqual(await snapshot(f.root), before);
  }
});

test("portable internal support links survive relocation", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  await f.file(join(source, "docs", "guide.md"), "Guide\n");
  await symlink(join(source, "docs", "guide.md"), join(source, "guide.md"));
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.equal(await readlink(join(f.canonical("alpha"), "guide.md")), "docs/guide.md");
  assert.equal(await readFile(join(f.canonical("alpha"), "guide.md"), "utf8"), "Guide\n");
});

test("mutually recursive support directory links are refused without moving source content", async (t) => {
  const f = await fixture(t);
  const source = await f.skill(join(f.set("tools"), "alpha"));
  await mkdir(join(source, "first"));
  await mkdir(join(source, "second"));
  await symlink("../second", join(source, "first", "next"));
  await symlink("../first", join(source, "second", "next"));
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 3, "E_MIGRATION_CONTENT");
  assert.deepEqual(await snapshot(f.root), before);
});

test("a linked versioned pack family never authorizes writes through an external ancestor", async (t) => {
  const f = await fixture(t);
  const external = join(f.root, "external-packs");
  await f.file(
    join(external, "1.0.0", "pack.toml"),
    '[pack]\nname = "bundle"\nversion = "1.0.0"\n[freeform]\nskills = []\n',
  );
  await mkdir(dirname(f.pack("bundle")), { recursive: true });
  await symlink(external, f.pack("bundle"));
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 3, "E_MIGRATION_COMPOSITION");
  assert.deepEqual(await snapshot(f.root), before);
});

test("migration holds the shared catalog lock and never creates state for refused previews", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("tools"), "alpha"));
  const acquired = Promise.withResolvers();
  const release = Promise.withResolvers();
  const holder = withLock(
    `${join(f.registryRoot, "all-skills")}#catalog`,
    async () => {
      acquired.resolve();
      await release.promise;
    },
    f.options,
  );
  await acquired.promise;
  try {
    const before = await snapshot(f.registryRoot);
    resultIs(await migrate({ ...f.options, apply: true, timeoutMs: 0 }), 5, "E_LOCK_BUSY");
    assert.deepEqual(await snapshot(f.registryRoot), before);
  } finally {
    release.resolve();
    await holder;
  }
  resultIs(
    await migrate({ ...f.options, stateHome: join(f.registryRoot, "runtime") }),
    3,
    "E_RECEIPT_UNSAFE_PATH",
  );
  assert.equal(existsSync(join(f.registryRoot, "runtime")), false);
});

for (const kind of ["linked-set", "linked-definition", "mapped-definition"]) {
  test(`state inside an external ${kind} is refused before lock bookkeeping or source onboarding`, async (t) => {
    const f = await fixture(t);
    const source = join(f.root, "external");
    let mapping;
    if (kind === "linked-set") {
      await f.skill(join(source, "alpha"));
      await mkdir(dirname(f.set("linked")), { recursive: true });
      await symlink(source, f.set("linked"));
    } else {
      await f.skill(source);
      if (kind === "linked-definition") await symlink(source, f.canonical("alpha"));
      else mapping = { version: 1, names: { [source]: "alpha" } };
    }
    await f.file(join(f.registryRoot, "docs", "vendoring", "sources.toml"), "version = 1\n");
    const options = {
      ...f.options,
      stateHome: join(source, "runtime"),
      ...(mapping ? { mapping } : {}),
    };
    const before = await snapshot(f.root);
    resultIs(await migrate(options), 3, "E_RECEIPT_UNSAFE_PATH");
    assert.deepEqual(await snapshot(f.root), before);
    resultIs(await migrate({ ...options, apply: true }), 3, "E_RECEIPT_UNSAFE_PATH");
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal(existsSync(join(source, "runtime")), false);
    assert.equal(existsSync(join(f.registryRoot, "all-skills", "sources.toml")), false);
  });
}

test("interrupted publication resumes only recorded trees and converges", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("tools"), "alpha"), "# Alpha\n");
  await f.skill(join(f.set("tools"), "beta"), "# Beta\n");
  const signal = {
    get aborted() {
      return existsSync(f.canonical("alpha"));
    },
  };
  const interrupted = await migrate({ ...f.options, apply: true, signal });
  assert.notEqual(interrupted.exit, 0, JSON.stringify(interrupted));
  assert.ok(interrupted.findings.some((item) => item.code === "E_INTERRUPTED"));
  assert.equal(JSON.parse(await readFile(registryReceipt(f), "utf8")).data.phase, "ready");
  const before = await snapshot(f.root);
  resultIs(await migrate(f.options), 4, "W_MIGRATION_RECOVERY_PENDING");
  assert.deepEqual(await snapshot(f.root), before);
  resultIs(await migrate({ ...f.options, apply: true }), 0);
  assert.equal(await realpath(join(f.set("tools"), "alpha")), f.canonical("alpha"));
  assert.equal(await realpath(join(f.set("tools"), "beta")), f.canonical("beta"));
  assert.equal(JSON.parse(await readFile(registryReceipt(f), "utf8")).data.phase, "complete");
});

test("foreign replacement during recovery is preserved with an actionable refusal", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("tools"), "alpha"), "# Alpha\n");
  await f.skill(join(f.set("tools"), "beta"), "# Beta\n");
  await migrate({
    ...f.options,
    apply: true,
    signal: {
      get aborted() {
        return existsSync(f.canonical("alpha"));
      },
    },
  });
  await f.skill(f.canonical("beta"), "# Foreign content\n");
  const before = await snapshot(f.registryRoot);
  const receiptBefore = await readFile(registryReceipt(f));
  const result = await migrate({ ...f.options, apply: true });
  assert.ok(
    result.findings.some((item) => item.code === "E_MIGRATION_CHANGED"),
    JSON.stringify(result),
  );
  assert.deepEqual(await snapshot(f.registryRoot), before);
  assert.deepEqual(await readFile(registryReceipt(f)), receiptBefore);
});

test("unrecognized staging and malformed or foreign receipts never authorize cleanup", async (t) => {
  const f = await fixture(t);
  const stage = join(f.registryRoot, "all-skills", ".skillex-tmp-migrate-foreign-new");
  await f.file(join(stage, "evidence.txt"), "Unknown staging\n");
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 4, "W_MIGRATION_STAGING_PRESERVED");
  assert.deepEqual(await snapshot(f.root), before);
  await rm(stage, { recursive: true });
  await f.file(registryReceipt(f), "{invalid\n", 0o600);
  const malformed = await migrate(f.options);
  assert.ok(
    malformed.findings.some((item) => item.code === "E_RECEIPT_INVALID"),
    JSON.stringify(malformed),
  );
});

test("preview rejects symlink receipt parents without following or creating state", async (t) => {
  const f = await fixture(t);
  const other = join(f.root, "other-state");
  await mkdir(other);
  await symlink(other, f.stateHome);
  const before = await snapshot(f.root);
  const result = await migrate(f.options);
  assert.notEqual(result.exit, 0);
  assert.ok(result.findings.some((item) => item.code.startsWith("E_RECEIPT_")));
  assert.deepEqual(await snapshot(f.root), before);
});

test("mapping paths reject traversal and source administration is never copied", async (t) => {
  const f = await fixture(t);
  resultIs(
    await migrate({ ...f.options, mapping: { version: 1, names: { "../escape": "alpha" } } }),
    2,
    "E_MIGRATION_CONFIG",
  );
  const source = await f.skill(join(f.set("tools"), "alpha"));
  await f.file(join(source, ".git"), "gitdir: unrelated\n");
  const before = await snapshot(f.root);
  resultIs(await migrate({ ...f.options, apply: true }), 3, "E_MIGRATION_CONTENT");
  assert.deepEqual(await snapshot(f.root), before);
});

test("a replaced canonical destination is never overwritten during a locked replan", async (t) => {
  const f = await fixture(t);
  await f.skill(join(f.set("tools"), "alpha"), "# Source\n");
  resultIs(await migrate(f.options), 0);
  await mkdir(f.canonical("alpha"));
  await f.file(join(f.canonical("alpha"), "foreign.txt"), "foreign\n");
  const before = await snapshot(f.root);
  const result = await migrate({ ...f.options, apply: true });
  assert.ok(
    result.findings.some((item) => item.code === "E_MIGRATION_NAME_CONFLICT"),
    JSON.stringify(result),
  );
  assert.deepEqual(await snapshot(f.root), before);
});
