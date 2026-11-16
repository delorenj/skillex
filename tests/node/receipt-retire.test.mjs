import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hostIdentity, listReceipts, retireReceipts } from "../../dist/index.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-receipt-retire-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateHome = join(root, "state");
  mkdirSync(stateHome);
  return { root, stateHome, home: join(root, "home") };
}

function identity(path) {
  const info = lstatSync(path, { bigint: true });
  return { kind: "directory", dev: String(info.dev), ino: String(info.ino) };
}

/** Write a receipt for `scope` exactly where skillex would, recording `recorded` for the root. */
function receipt(env, namespace, scope, { recorded, pending, host } = {}) {
  const activationRoot =
    namespace === "profiles" ? join(scope, "skills") : join(scope, ".agents", "skills");
  const key = createHash("sha256").update(activationRoot).digest("hex");
  const directory = join(env.stateHome, "skillex", namespace, "v2");
  mkdirSync(directory, { recursive: true });
  const data =
    namespace === "profiles"
      ? { version: 1, root: recorded ?? null, project: null, sources: [], links: {} }
      : {
          version: 1,
          links: {},
          directories: recorded ? { [activationRoot]: recorded } : {},
          sources: [],
        };
  if (pending) data.pending = { id: "x" };
  const path = join(directory, `${key}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: 2,
      scopeRoot: scope,
      activationRoot,
      host: host ?? hostIdentity(),
      uid: process.getuid(),
      data,
    })}\n`,
  );
  return { path, id: key, activationRoot };
}

function skills(scope) {
  const dir = join(scope, ".agents", "skills");
  mkdirSync(join(dir, "real-skill"), { recursive: true });
  writeFileSync(join(dir, "real-skill", "SKILL.md"), "# real BMAD content\n");
  return dir;
}

function listing(dir) {
  const out = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      out.push(`${path}:${lstatSync(path).isDirectory() ? "d" : readFileSync(path, "utf8")}`);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  visit(dir);
  return out;
}

function fixtures(env) {
  const live = join(env.root, "live");
  const recreated = join(env.root, "recreated");
  const gone = join(env.root, "gone");
  const liveRoot = skills(live);
  const recreatedRoot = skills(recreated);
  return {
    live,
    recreated,
    gone,
    liveRoot,
    recreatedRoot,
    valid: receipt(env, "activations", live, { recorded: identity(liveRoot) }),
    stale: receipt(env, "activations", recreated, {
      recorded: { ...identity(recreatedRoot), ino: "1" },
    }),
    orphan: receipt(env, "activations", gone, {
      recorded: { kind: "directory", dev: "1", ino: "2" },
    }),
  };
}

test("list classifies valid, stale and orphan receipts without writing", async (t) => {
  const env = world(t);
  const f = fixtures(env);
  const before = readFileSync(f.valid.path, "utf8");
  const result = await listReceipts({ stateHome: env.stateHome, home: env.home });
  assert.equal(result.ok, true);
  const states = Object.fromEntries(result.data.receipts.map((r) => [r.id, r.state]));
  assert.deepEqual(states, {
    [f.valid.id]: "valid",
    [f.stale.id]: "stale",
    [f.orphan.id]: "orphan",
  });
  assert.deepEqual(
    { valid: 1, stale: 1, orphan: 1 },
    {
      valid: result.data.counts.valid,
      stale: result.data.counts.stale,
      orphan: result.data.counts.orphan,
    },
  );
  assert.equal(readFileSync(f.valid.path, "utf8"), before);
  const only = await listReceipts({ stateHome: env.stateHome, home: env.home, state: "orphan" });
  assert.equal(only.data.receipts.length, 1);
});

test("retire previews by default and --apply backs up then removes only receipt JSON", async (t) => {
  const env = world(t);
  const f = fixtures(env);
  const before = [...listing(f.live), ...listing(f.recreated)];
  const options = { stateHome: env.stateHome, home: env.home, targets: [f.stale.id, f.orphan.id] };
  const preview = await retireReceipts(options);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.dryRun, true);
  assert.deepEqual(
    preview.data.entries.map((e) => e.action),
    ["retire", "retire"],
  );
  assert.ok(existsSync(f.stale.path) && existsSync(f.orphan.path), "preview wrote");

  const backupDir = join(env.root, "backups", "run");
  const applied = await retireReceipts({ ...options, apply: true, backupDir });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  assert.equal(applied.data.retired.length, 2);
  assert.ok(!existsSync(f.stale.path) && !existsSync(f.orphan.path));
  assert.ok(existsSync(f.valid.path), "the valid receipt is untouched");
  assert.equal(
    readFileSync(join(backupDir, "activations", `${f.stale.id}.json`), "utf8").includes(
      '"ino":"1"',
    ),
    true,
  );
  assert.ok(existsSync(join(backupDir, "receipt-retire.json")));
  const after = [...listing(f.live), ...listing(f.recreated)];
  assert.deepEqual(after, before, "skill roots were touched");
  const again = await retireReceipts({ ...options, apply: true, backupDir });
  assert.equal(again.exit, 2, "retired receipts are gone");
});

test("a currently valid receipt is refused without --force and nothing is half-retired", async (t) => {
  const env = world(t);
  const f = fixtures(env);
  const base = { stateHome: env.stateHome, home: env.home, apply: true };
  const refused = await retireReceipts({ ...base, targets: [f.stale.id, f.valid.id] });
  assert.equal(refused.exit, 3);
  assert.equal(refused.findings[0].code, "E_RECEIPT_RETIRE_REFUSED");
  assert.ok(
    existsSync(f.valid.path) && existsSync(f.stale.path),
    "a refusal must not retire anything",
  );
  assert.ok(
    !existsSync(join(env.stateHome, "skillex", "retired-receipts")),
    "no backup dir on refusal",
  );

  const forced = await retireReceipts({ ...base, targets: [f.valid.id], force: true });
  assert.equal(forced.ok, true);
  assert.ok(!existsSync(f.valid.path));
  assert.ok(existsSync(f.liveRoot), "forcing never touches the skill root");
  const backups = join(env.stateHome, "skillex", "retired-receipts");
  assert.equal(readdirSync(backups).length, 1);
  assert.match(readdirSync(backups)[0], /^\d{8}T\d{6}Z-receipt-retire$/);
});

test("--all-stale selects stale and orphan receipts and leaves valid, pending and foreign ones", async (t) => {
  const env = world(t);
  const f = fixtures(env);
  const pendingScope = join(env.root, "pending-gone");
  const pending = receipt(env, "activations", pendingScope, { pending: true });
  const foreign = receipt(env, "activations", join(env.root, "foreign-gone"), {
    host: "some-other-host",
  });
  const profile = receipt(env, "profiles", join(env.root, "profile-gone"));
  const base = { stateHome: env.stateHome, home: env.home, allStale: true };
  const preview = await retireReceipts(base);
  assert.equal(preview.ok, true);
  const chosen = preview.data.entries
    .filter((e) => e.action === "retire")
    .map((e) => e.id)
    .sort();
  assert.deepEqual(chosen, [f.stale.id, f.orphan.id, profile.id].sort());
  const applied = await retireReceipts({ ...base, apply: true });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  for (const gone of [f.stale, f.orphan, profile]) assert.ok(!existsSync(gone.path));
  for (const kept of [f.valid, pending, foreign]) assert.ok(existsSync(kept.path));
  const none = await retireReceipts(base);
  assert.deepEqual(
    none.data.entries.map((e) => [e.id, e.action]),
    [[pending.id, "refuse"]],
    "only the pending-journal receipt remains, and it is kept",
  );
  assert.equal(none.ok, true);
});

test("an unknown target and a missing selector are usage errors", async (t) => {
  const env = world(t);
  fixtures(env);
  const base = { stateHome: env.stateHome, home: env.home };
  assert.equal((await retireReceipts({ ...base, targets: ["deadbeef"] })).exit, 2);
  assert.equal((await retireReceipts(base)).exit, 2);
  assert.equal(
    (await retireReceipts({ ...base, targets: ["deadbeef"], apply: true, dryRun: true })).exit,
    2,
  );
});

test("receipts are selectable by project path and skill root", async (t) => {
  const env = world(t);
  const f = fixtures(env);
  const byScope = await retireReceipts({
    stateHome: env.stateHome,
    home: env.home,
    targets: [f.gone],
  });
  assert.deepEqual(
    byScope.data.entries.map((e) => e.id),
    [f.orphan.id],
  );
  const byRoot = await retireReceipts({
    stateHome: env.stateHome,
    home: env.home,
    targets: [f.recreatedRoot],
  });
  assert.deepEqual(
    byRoot.data.entries.map((e) => e.id),
    [f.stale.id],
  );
});

test("CLI: preview exits 0, --apply retires, JSON envelope is stable", (t) => {
  const env = world(t);
  const f = fixtures(env);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, "--json", "receipt", ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: env.home, XDG_STATE_HOME: env.stateHome },
    });
    return { status: result.status, json: JSON.parse(result.stdout) };
  };
  const listed = run("list", "--state", "orphan");
  assert.equal(listed.status, 0);
  assert.equal(listed.json.data.receipts.length, 1);
  const preview = run("retire", "--all-stale");
  assert.equal(preview.status, 0);
  assert.equal(preview.json.data.dryRun, true);
  assert.ok(existsSync(f.orphan.path));
  const refused = run("retire", f.valid.id, "--apply");
  assert.equal(refused.status, 3);
  assert.ok(existsSync(f.valid.path));
  const backups = join(env.root, "bk");
  const applied = run("retire", "--all-stale", "--apply", "--backup-dir", backups);
  assert.equal(applied.status, 0);
  assert.equal(applied.json.data.retired.length, 2);
  assert.ok(!existsSync(f.orphan.path) && !existsSync(f.stale.path) && existsSync(f.valid.path));
  assert.ok(existsSync(join(backups, "activations", `${f.stale.id}.json`)));
});
