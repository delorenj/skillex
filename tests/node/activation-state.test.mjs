import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readActivationReceipt, withLock, writeActivationReceipt } from "@delorenj/skillex";

const moduleUrl = import.meta.resolve("@delorenj/skillex");

async function fixture(t) {
  // os.tmpdir() may itself be inside a source repository on an operator's host.
  const root = await realpath(await mkdtemp("/tmp/skillex-receipt-"));
  const home = join(root, "home");
  const scope = join(root, "project");
  const stateHome = join(root, "state");
  const children = [];
  await mkdir(home);
  await mkdir(scope);
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, scope, stateHome, children, options: { home, stateHome, env: {} } };
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function rejected(promise, code, exit = 3) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "SkillexError");
    assert.equal(error.exit, exit);
    assert.equal(error.findings[0].code, code);
    assert.equal(typeof error.findings[0].fix, "string");
    return true;
  });
}

function document(snapshot, data = { generation: 1 }) {
  return {
    schema: 2,
    scopeRoot: snapshot.scopeRoot,
    activationRoot: snapshot.activationRoot,
    host: hostname(),
    uid: process.getuid?.() ?? null,
    data,
  };
}

async function placeDocument(snapshot, value) {
  await mkdir(dirname(snapshot.path), { recursive: true });
  await writeFile(
    snapshot.path,
    typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
}

async function persist(f, snapshot, data, options = f.options) {
  return withLock(
    "activation-state-tests",
    () => writeActivationReceipt(snapshot, data, options),
    f.options,
  );
}

test("first and repeated reads discover a stable path without creating state", async (t) => {
  const f = await fixture(t);
  const first = await readActivationReceipt(f.scope, f.options);
  const second = await readActivationReceipt(f.scope, f.options);
  const activation = join(f.scope, ".agents", "skills");
  const key = createHash("sha256").update(activation).digest("hex");
  assert.equal(first.path, join(f.stateHome, "skillex", "activations", "v2", `${key}.json`));
  assert.equal(first.scopeRoot, f.scope);
  assert.equal(first.activationRoot, activation);
  assert.equal(first.document, undefined);
  assert.deepEqual(second, first);
  await absent(f.stateHome);
  assert.deepEqual(await readdir(f.scope), []);
});

test("writes return fresh complete snapshots, replace atomically, and retain mode 600", async (t) => {
  const f = await fixture(t);
  const initial = await readActivationReceipt(f.scope, f.options);
  const data = { generation: 1, nested: [null, false, "snowman ☃", { count: 3 }] };
  const first = await persist(f, initial, data);
  assert.deepEqual(first.document, document(first, data));
  assert.equal(initial.document, undefined);
  const original = await lstat(first.path);
  assert.equal(original.mode & 0o777, 0o600);
  const second = await persist(f, first, { generation: 2 });
  const next = await lstat(second.path);
  assert.notEqual(next.ino, original.ino);
  assert.equal(next.mode & 0o777, 0o600);
  assert.deepEqual(second.document.data, { generation: 2 });
  assert.deepEqual((await readActivationReceipt(f.scope, f.options)).document, second.document);
  assert.deepEqual(await readdir(dirname(second.path)), [basename(second.path)]);
  assert.deepEqual(await readdir(f.scope), []);
});

test("an omitted write location reuses the snapshot's selected state home", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  const written = await withLock(
    "activation-state-tests",
    () => writeActivationReceipt(snapshot, 42),
    f.options,
  );
  assert.equal(written.path, snapshot.path);
  assert.equal(written.document.data, 42, "payload schema belongs to the reconciliation caller");
});

test("receipt identity ignores pack target changes and canonicalizes the scope base", async (t) => {
  const f = await fixture(t);
  const scopeAlias = join(f.root, "scope-alias");
  await symlink(f.scope, scopeAlias);
  const first = await readActivationReceipt(scopeAlias, f.options);
  const written = await persist(f, first, { ownership: "stable" });
  await mkdir(join(f.scope, ".agents"));
  for (const name of ["pack-a", "pack-b"]) {
    const target = join(f.root, name, "skills");
    await mkdir(target, { recursive: true });
    await symlink(target, first.activationRoot);
    const read = await readActivationReceipt(scopeAlias, f.options);
    assert.equal(read.path, first.path);
    assert.equal(read.scopeRoot, f.scope);
    assert.deepEqual(read.document, written.document);
    await unlink(first.activationRoot);
  }
  await mkdir(first.activationRoot);
  assert.equal((await readActivationReceipt(f.scope, f.options)).path, first.path);
});

test("state selection honors explicit, environment, and injected-home precedence", async (t) => {
  const f = await fixture(t);
  const fromEnvironment = join(f.root, "environment");
  const explicit = await readActivationReceipt(f.scope, {
    ...f.options,
    env: { XDG_STATE_HOME: fromEnvironment },
  });
  assert.ok(explicit.path.startsWith(`${f.stateHome}/`));
  const environment = await readActivationReceipt(f.scope, {
    home: f.home,
    env: { XDG_STATE_HOME: fromEnvironment },
  });
  assert.ok(environment.path.startsWith(`${fromEnvironment}/`));
  const fallback = await readActivationReceipt(f.scope, { home: f.home, env: {} });
  assert.ok(fallback.path.startsWith(`${join(f.home, ".local", "state")}/`));
  const relativePath = await readActivationReceipt(f.scope, {
    ...f.options,
    stateHome: relative(process.cwd(), f.stateHome),
  });
  assert.equal(relativePath.path, explicit.path);
  const expanded = await readActivationReceipt(f.scope, {
    home: f.home,
    stateHome: "~/state",
    env: {},
  });
  assert.ok(expanded.path.startsWith(`${join(f.home, "state")}/`));
  for (const path of [f.stateHome, fromEnvironment, join(f.home, ".local"), join(f.home, "state")])
    await absent(path);
});

test("invalid explicit or environment locations never fall through", async (t) => {
  const f = await fixture(t);
  await rejected(
    readActivationReceipt(f.scope, {
      ...f.options,
      stateHome: "",
      env: { XDG_STATE_HOME: f.stateHome },
    }),
    "E_RECEIPT_CONFIG",
    2,
  );
  await rejected(
    readActivationReceipt(f.scope, { home: f.home, env: { XDG_STATE_HOME: "" } }),
    "E_RECEIPT_CONFIG",
    2,
  );
  await rejected(readActivationReceipt("", f.options), "E_RECEIPT_CONFIG", 2);
  await absent(f.stateHome);
});

test("a stale absence cannot overwrite a receipt created after its read", async (t) => {
  const f = await fixture(t);
  const stale = await readActivationReceipt(f.scope, f.options);
  const first = await persist(f, stale, { generation: 1 });
  const bytes = await readFile(first.path);
  await rejected(persist(f, stale, { generation: 2 }), "E_RECEIPT_CHANGED");
  assert.deepEqual(await readFile(first.path), bytes);
});

test("changed bytes in the same receipt inode refuse replacement", async (t) => {
  const f = await fixture(t);
  const first = await persist(f, await readActivationReceipt(f.scope, f.options), {
    generation: 1,
  });
  const inode = (await lstat(first.path)).ino;
  const replacement = JSON.stringify(document(first, { foreign: true }));
  await writeFile(first.path, replacement);
  assert.equal((await lstat(first.path)).ino, inode);
  await rejected(persist(f, first, { generation: 2 }), "E_RECEIPT_CHANGED");
  assert.equal(await readFile(first.path, "utf8"), replacement);
});

test("identical bytes in a replaced receipt inode do not retain authority", async (t) => {
  const f = await fixture(t);
  const first = await persist(f, await readActivationReceipt(f.scope, f.options), {
    generation: 1,
  });
  const bytes = await readFile(first.path);
  await rename(first.path, join(f.root, "retained-original"));
  await writeFile(first.path, bytes, { mode: 0o600 });
  await rejected(persist(f, first, { generation: 2 }), "E_RECEIPT_CHANGED");
  assert.deepEqual(await readFile(first.path), bytes);
});

test("replaced receipt parents refuse even when document bytes still match", async (t) => {
  const f = await fixture(t);
  const first = await persist(f, await readActivationReceipt(f.scope, f.options), {
    generation: 1,
  });
  const bytes = await readFile(first.path);
  const parent = dirname(first.path);
  await rename(parent, join(dirname(parent), "retained-parent"));
  await mkdir(parent);
  await writeFile(first.path, bytes, { mode: 0o600 });
  await rejected(persist(f, first, { generation: 2 }), "E_RECEIPT_CHANGED");
  assert.deepEqual(await readFile(first.path), bytes);
});

test("replaced scope bases and reconstructed snapshots require a fresh read", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  await rejected(persist(f, { ...snapshot }, {}), "E_RECEIPT_CHANGED");
  await rename(f.scope, join(f.root, "retained-scope"));
  await mkdir(f.scope);
  await rejected(persist(f, snapshot, {}), "E_RECEIPT_CHANGED");
  await absent(snapshot.path);
});

test("write options cannot redirect a previous snapshot into another state home", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  const other = join(f.root, "other-state");
  await rejected(persist(f, snapshot, {}, { ...f.options, stateHome: other }), "E_RECEIPT_CHANGED");
  await absent(other);
  await absent(snapshot.path);
});

test("malformed, legacy, mismatched, and foreign envelopes refuse without rewriting", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  const valid = document(snapshot);
  const { data: _data, ...missingData } = valid;
  const cases = [
    "{",
    "[]",
    { ...valid, schema: 1 },
    { ...valid, scopeRoot: f.home },
    { ...valid, activationRoot: join(f.root, "pack", "skills") },
    { ...valid, host: `${hostname()}-foreign` },
    { ...valid, uid: valid.uid === null ? 1234 : valid.uid + 1 },
    { ...valid, extra: "unsupported" },
    missingData,
  ];
  for (const value of cases) {
    await placeDocument(snapshot, value);
    const bytes = await readFile(snapshot.path);
    await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_INVALID");
    assert.deepEqual(await readFile(snapshot.path), bytes);
  }
  const encoded = Buffer.from(JSON.stringify({ ...valid, data: "sentinel" }));
  encoded[encoded.indexOf("sentinel")] = 0xff;
  await placeDocument(snapshot, encoded);
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_INVALID");
});

test("legacy Python projection receipts are neither read nor adopted", async (t) => {
  const f = await fixture(t);
  const legacy = join(f.stateHome, "skillex", "projections", "legacy.json");
  await mkdir(dirname(legacy), { recursive: true });
  const bytes = '{"version":1,"entries":{"unrelated":{"target":"catalog"}}}\n';
  await writeFile(legacy, bytes);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  assert.equal(snapshot.document, undefined);
  await absent(join(f.stateHome, "skillex", "activations"));
  assert.equal(await readFile(legacy, "utf8"), bytes);
});

test("receipt symlinks and real-directory collisions are preserved", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  await mkdir(dirname(snapshot.path), { recursive: true });
  const target = join(f.root, "foreign.json");
  await writeFile(target, JSON.stringify(document(snapshot)));
  await symlink(target, snapshot.path);
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
  await rejected(persist(f, snapshot, {}), "E_RECEIPT_UNSAFE_PATH");
  assert.equal((await lstat(snapshot.path)).isSymbolicLink(), true);
  await unlink(snapshot.path);
  await mkdir(snapshot.path);
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
  assert.equal((await lstat(snapshot.path)).isDirectory(), true);
});

test("symlink state parents are rejected before missing descendants are created", async (t) => {
  const f = await fixture(t);
  const real = join(f.root, "real-state");
  await mkdir(real);
  await symlink(real, f.stateHome);
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
  assert.deepEqual(await readdir(real), []);
  await unlink(f.stateHome);
  await mkdir(f.stateHome);
  await symlink(real, join(f.stateHome, "skillex"));
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
  assert.deepEqual(await readdir(real), []);
});

test("a regular file in the parent chain is an unsafe path rather than absence", async (t) => {
  const f = await fixture(t);
  await writeFile(f.stateHome, "foreign state file");
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
  assert.equal(await readFile(f.stateHome, "utf8"), "foreign state file");
});

test("permission failures remain IO errors rather than missing state", {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const f = await fixture(t);
  const blocked = join(f.root, "blocked");
  await mkdir(blocked, { mode: 0o700 });
  await chmod(blocked, 0o000);
  try {
    await rejected(
      readActivationReceipt(f.scope, { ...f.options, stateHome: join(blocked, "state") }),
      "E_IO",
      1,
    );
  } finally {
    await chmod(blocked, 0o700);
  }
  assert.deepEqual(await readdir(blocked), []);
});

test("filesystem ownership is checked on receipts and managed directories", {
  skip: process.getuid?.() !== 0,
}, async (t) => {
  const f = await fixture(t);
  const first = await persist(f, await readActivationReceipt(f.scope, f.options), {});
  await chown(first.path, 12345, 12345);
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
  await chown(first.path, 0, 0);
  await chown(f.stateHome, 12345, 12345);
  await rejected(readActivationReceipt(f.scope, f.options), "E_RECEIPT_UNSAFE_PATH");
});

for (const marker of ["directory", "file"]) {
  test(`Git ${marker} ancestors forbid state even when target directories do not exist`, async (t) => {
    const f = await fixture(t);
    const git = join(f.scope, ".git");
    if (marker === "directory") await mkdir(git);
    else await writeFile(git, "gitdir: /external/worktree-metadata\n");
    const stateHome = join(f.scope, "uncreated", "state");
    await rejected(
      readActivationReceipt(f.scope, { ...f.options, stateHome }),
      "E_RECEIPT_UNSAFE_PATH",
    );
    await absent(join(f.scope, "uncreated"));
  });
}

test("forbidden roots cover canonical aliases and nonexistent future roots", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "project-alias");
  await symlink(f.scope, alias);
  await rejected(
    readActivationReceipt(f.scope, {
      ...f.options,
      stateHome: join(f.scope, "state"),
      forbiddenRoots: [alias],
    }),
    "E_RECEIPT_UNSAFE_PATH",
  );
  const future = join(f.root, "future-source");
  await rejected(
    readActivationReceipt(f.scope, {
      ...f.options,
      stateHome: join(future, "state"),
      forbiddenRoots: [future],
    }),
    "E_RECEIPT_UNSAFE_PATH",
  );
  await absent(future);
  await absent(join(f.scope, "state"));
});

test("dangling forbidden-root aliases cannot become allowed through state creation", async (t) => {
  const f = await fixture(t);
  const future = join(f.root, "future-source");
  const alias = join(f.root, "future-alias");
  await symlink(future, alias);
  for (const forbidden of [alias, join(alias, "nested")]) {
    await rejected(
      readActivationReceipt(f.scope, {
        ...f.options,
        stateHome: join(future, "nested", "state"),
        forbiddenRoots: [forbidden],
      }),
      "E_RECEIPT_UNSAFE_PATH",
    );
    await absent(future);
  }
});

test("new repository markers or stricter forbidden roots are rechecked before writes", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  await mkdir(join(f.root, ".git"));
  await rejected(writeActivationReceipt(snapshot, {}, f.options), "E_RECEIPT_UNSAFE_PATH");
  await absent(f.stateHome);
  await rm(join(f.root, ".git"), { recursive: true });
  await rejected(
    writeActivationReceipt(snapshot, {}, { ...f.options, forbiddenRoots: [f.root] }),
    "E_RECEIPT_UNSAFE_PATH",
  );
  await absent(f.stateHome);
});

test("unserializable payloads cannot create or alter a receipt", async (t) => {
  const f = await fixture(t);
  const snapshot = await readActivationReceipt(f.scope, f.options);
  const circular = {};
  circular.self = circular;
  for (const value of [circular, 1n, undefined]) {
    await rejected(writeActivationReceipt(snapshot, value, f.options), "E_RECEIPT_INVALID");
    await absent(f.stateHome);
  }
});

test("readers in another Node process observe only complete atomically published documents", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const first = await persist(f, await readActivationReceipt(f.scope, f.options), {
    sequence: 0,
    body: "x".repeat(100000),
  });
  const source = `
    import { readActivationReceipt, writeActivationReceipt, withLock } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.argv[1]);
    for (let sequence = 1; sequence <= 24; sequence++) {
      await withLock('activation-state-tests', async () => {
        const previous = await readActivationReceipt(input.scope, input.options);
        await writeActivationReceipt(previous, {sequence, body:'x'.repeat(100000)}, input.options);
      }, input.options);
    }
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      JSON.stringify({ scope: f.scope, options: f.options }),
    ],
    { cwd: f.scope, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let done = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      done = true;
      resolve(code);
    });
  });
  f.children.push(child);
  let observations = 0;
  while (!done) {
    const value = JSON.parse(await readFile(first.path, "utf8"));
    assert.equal(value.schema, 2);
    assert.ok(value.data.sequence >= 0 && value.data.sequence <= 24);
    assert.equal(value.data.body, "x".repeat(100000));
    observations++;
    await delay(1);
  }
  assert.equal(await child.exited, 0, output);
  assert.equal(output, "");
  assert.ok(observations > 1);
  assert.equal(JSON.parse(await readFile(first.path, "utf8")).data.sequence, 24);
  assert.deepEqual(await readdir(dirname(first.path)), [basename(first.path)]);
  assert.deepEqual(await readdir(f.scope), []);
});
