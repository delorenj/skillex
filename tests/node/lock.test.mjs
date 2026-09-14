import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withLock } from "@delorenj/skillex";

const moduleUrl = import.meta.resolve("@delorenj/skillex");
const resourceHash = (resource) => createHash("sha256").update(resource).digest("hex");
const childSource = `
import { withLock } from ${JSON.stringify(moduleUrl)};
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const input = JSON.parse(process.argv[1]);
process.send({event:'ready'});
await new Promise(resolve => process.once('message', resolve));
try {
  if (input.mode === 'race') {
    for (let i=0; i<input.iterations; i++) {
      await withLock(input.resource, async () => {
        await mkdir(input.critical);
        try {
          const count = Number(await readFile(input.counter, 'utf8'));
          await delay(3);
          await writeFile(input.counter, String(count + 1));
        } finally { await rm(input.critical, {recursive:true}); }
      }, input.options);
    }
  } else {
    const result = await withLock(input.resource, async () => {
      process.send({event:'entered'});
      if (input.mode === 'hold') await new Promise(resolve => process.once('message', resolve));
      if (input.mode === 'throw') throw new Error('callback sentinel');
      return 'callback value';
    }, input.options);
    process.send({event:'value', value:result});
  }
  process.send({event:'done'});
} catch (error) {
  process.send({event:'failure', code:error.findings?.[0]?.code, exit:error.exit, message:error.message});
}
process.disconnect();
`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skillex-lock-")));
  const stateHome = join(root, "state");
  const home = join(root, "home");
  const project = join(root, "project");
  for (const path of [home, join(project, ".git")]) await mkdir(path, { recursive: true });
  await writeFile(join(project, "README.md"), "Repository source stays untouched.\n");
  const children = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    assert.deepEqual((await readdir(project)).sort(), [".git", "README.md"]);
    assert.deepEqual(await readdir(join(project, ".git")), []);
    assert.equal(
      await readFile(join(project, "README.md"), "utf8"),
      "Repository source stays untouched.\n",
    );
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    project,
    stateHome,
    children,
    options: { home, stateHome, env: {}, timeoutMs: 5000 },
  };
}

async function child(f, input, start = true) {
  const process = spawn(
    globalThis.process.execPath,
    [
      "--input-type=module",
      "--eval",
      childSource,
      JSON.stringify({ ...input, options: { ...f.options, ...input.options } }),
    ],
    {
      cwd: f.project,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  f.children.push(process);
  let output = "";
  process.stdout.on("data", (data) => {
    output += data;
  });
  process.stderr.on("data", (data) => {
    output += data;
  });
  const messages = [];
  const listeners = new Set();
  let closed = false;
  process.on("message", (message) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  process.exited = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", () => {
      closed = true;
      for (const listener of listeners) listener();
      try {
        assert.equal(output, "", "lock process must not print diagnostics or progress");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  const wait = (event) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Child did not report ${event}: ${JSON.stringify(messages)}`));
      }, 10000);
      const check = () => {
        const message = messages.find((message) => message.event === event);
        const failure = messages.find((message) => message.event === "failure");
        if (!message && !failure && !closed) return;
        clearTimeout(timer);
        listeners.delete(check);
        if (message) resolve(message);
        else
          reject(
            new Error(`Child stopped before ${event}: ${JSON.stringify(failure ?? messages)}`),
          );
      };
      listeners.add(check);
      check();
    });
  await wait("ready");
  if (start) process.send("go");
  return { process, wait, messages, release: () => process.send("release") };
}

const lockDirectory = (f, resource) =>
  join(f.stateHome, "skillex", "locks", resourceHash(resource));

async function ownerClaim(f, resource) {
  const directory = lockDirectory(f, resource);
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  return join(directory, names[0]);
}

test("real Node processes serialize repeated critical sections without losing updates", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const counter = join(f.root, "counter");
  const critical = join(f.root, "critical");
  await writeFile(counter, "0");
  const workers = await Promise.all(
    Array.from({ length: 6 }, () =>
      child(f, { mode: "race", resource: "shared", counter, critical, iterations: 12 }, false),
    ),
  );
  for (const worker of workers) worker.process.send("go");
  await Promise.all(workers.map((worker) => worker.wait("done")));
  await Promise.all(workers.map((worker) => worker.process.exited));
  assert.equal(await readFile(counter, "utf8"), "72");
  assert.deepEqual(await readdir(lockDirectory(f, "shared")), []);
});

test("a timed-out contender never runs its callback and preserves the live owner", async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "busy" });
  await owner.wait("entered");
  const path = await ownerClaim(f, "busy");
  const before = await readFile(join(path, "ticket.json"));
  const contender = await child(f, { resource: "busy", options: { timeoutMs: 80 } });
  const result = await contender.wait("failure");
  assert.equal(result.code, "E_LOCK_BUSY");
  assert.equal(result.exit, 5);
  assert.ok(!contender.messages.some((message) => message.event === "entered"));
  assert.deepEqual(await readFile(join(path, "ticket.json")), before);
  assert.equal(await ownerClaim(f, "busy"), path);
  owner.release();
  await owner.wait("done");
});

test("multiple real contenders safely reap one dead owner's unique claim", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "dead" });
  await owner.wait("entered");
  const oldClaim = await ownerClaim(f, "dead");
  owner.process.kill("SIGKILL");
  await owner.process.exited;
  const counter = join(f.root, "counter");
  await writeFile(counter, "0");
  const workers = await Promise.all(
    Array.from({ length: 4 }, () =>
      child(
        f,
        {
          mode: "race",
          resource: "dead",
          counter,
          critical: join(f.root, "critical"),
          iterations: 4,
        },
        false,
      ),
    ),
  );
  for (const worker of workers) worker.process.send("go");
  await Promise.all(workers.map((worker) => worker.wait("done")));
  assert.equal(await readFile(counter, "utf8"), "16");
  await assert.rejects(readFile(join(oldClaim, "ticket.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(lockDirectory(f, "dead")), []);
});

test("callback failure is rethrown and releases the claim for another process", async (t) => {
  const f = await fixture(t);
  const failing = await child(f, { mode: "throw", resource: "callback-failure" });
  const result = await failing.wait("failure");
  assert.equal(result.message, "callback sentinel");
  assert.equal(result.code, undefined);
  assert.deepEqual(await readdir(lockDirectory(f, "callback-failure")), []);
  const next = await child(f, { resource: "callback-failure", options: { timeoutMs: 0 } });
  assert.equal((await next.wait("value")).value, "callback value");
  await next.wait("done");
});

test("distinct resources can be held by separate processes simultaneously", async (t) => {
  const f = await fixture(t);
  const first = await child(f, { mode: "hold", resource: "one" });
  await first.wait("entered");
  const second = await child(f, { mode: "hold", resource: "two", options: { timeoutMs: 0 } });
  await second.wait("entered");
  assert.notEqual(lockDirectory(f, "one"), lockDirectory(f, "two"));
  first.release();
  second.release();
  await Promise.all([first.wait("done"), second.wait("done")]);
});

test("EPERM cannot be used as evidence that a live owner died", async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "permission" });
  await owner.wait("entered");
  const path = await ownerClaim(f, "permission");
  const kill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === owner.process.pid && signal === 0)
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    return kill(pid, signal);
  };
  try {
    await assert.rejects(
      withLock("permission", async () => assert.fail("callback must not run"), {
        ...f.options,
        timeoutMs: 40,
      }),
      (error) => error.exit === 5 && error.findings[0].code === "E_LOCK_BUSY",
    );
    assert.equal(await ownerClaim(f, "permission"), path);
  } finally {
    process.kill = kill;
  }
  owner.release();
  await owner.wait("done");
});

test("foreign-host claims remain busy even when their PID is dead locally", async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "foreign" });
  await owner.wait("entered");
  const old = await ownerClaim(f, "foreign");
  const ticket = JSON.parse(await readFile(join(old, "ticket.json"), "utf8"));
  owner.process.kill("SIGKILL");
  await owner.process.exited;
  await rm(old, { recursive: true });
  ticket.host = "foreign-test-host.invalid";
  const foreign = join(
    lockDirectory(f, "foreign"),
    `${resourceHash(ticket.host)}.${ticket.pid}.${ticket.id}.claim`,
  );
  await mkdir(foreign);
  await writeFile(join(foreign, "ticket.json"), JSON.stringify(ticket));
  const contender = await child(f, { resource: "foreign", options: { timeoutMs: 40 } });
  assert.equal((await contender.wait("failure")).code, "E_LOCK_BUSY");
  assert.deepEqual(JSON.parse(await readFile(join(foreign, "ticket.json"), "utf8")), ticket);
});

for (const shape of ["malformed", "directory", "symlink"]) {
  test(`a ${shape} ticket gets an actionable refusal without deleting foreign state`, async (t) => {
    const f = await fixture(t);
    const owner = await child(f, { mode: "hold", resource: "bad-ticket" });
    await owner.wait("entered");
    const path = join(await ownerClaim(f, "bad-ticket"), "ticket.json");
    await unlink(path);
    if (shape === "malformed") await writeFile(path, "not JSON\n");
    else if (shape === "directory") await mkdir(path);
    else {
      const foreign = join(f.root, "foreign-data");
      await writeFile(foreign, "preserve this\n");
      await symlink(foreign, path);
    }
    const contender = await child(f, { resource: "bad-ticket", options: { timeoutMs: 500 } });
    assert.equal((await contender.wait("failure")).code, "E_LOCK_STATE");
    assert.ok(!contender.messages.some((message) => message.event === "entered"));
    if (shape === "malformed") assert.equal(await readFile(path, "utf8"), "not JSON\n");
    if (shape === "directory") assert.deepEqual(await readdir(path), []);
    if (shape === "symlink") assert.equal(await readFile(path, "utf8"), "preserve this\n");
  });
}

test("release refuses a replaced ticket and preserves its replacement", async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "release" });
  await owner.wait("entered");
  const path = join(await ownerClaim(f, "release"), "ticket.json");
  await writeFile(path, "foreign replacement\n");
  owner.release();
  assert.equal((await owner.wait("failure")).code, "E_LOCK_STATE");
  assert.equal(await readFile(path, "utf8"), "foreign replacement\n");
});

test("release preserves an unrelated file even when its name resembles preparation state", async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "release-extra" });
  await owner.wait("entered");
  const path = join(await ownerClaim(f, "release-extra"), "ticket.preparing");
  await writeFile(path, "foreign support content\n");
  owner.release();
  assert.equal((await owner.wait("failure")).code, "E_LOCK_STATE");
  assert.equal(await readFile(path, "utf8"), "foreign support content\n");
});

test("a dead chooser's incomplete unpublished ticket can be recovered", async (t) => {
  const f = await fixture(t);
  const owner = await child(f, { mode: "hold", resource: "dead-chooser" });
  await owner.wait("entered");
  const path = await ownerClaim(f, "dead-chooser");
  owner.process.kill("SIGKILL");
  await owner.process.exited;
  // Reproduce the state after mkdir + a partial write, before atomic publication.
  await unlink(join(path, "ticket.json"));
  await writeFile(join(path, "ticket.preparing"), '{"schema":');
  const next = await child(f, { resource: "dead-chooser", options: { timeoutMs: 0 } });
  await next.wait("done");
  assert.deepEqual(await readdir(lockDirectory(f, "dead-chooser")), []);
});

test("explicit state home outranks XDG and normal defaults stay outside the repository", async (t) => {
  const f = await fixture(t);
  const unused = join(f.root, "unused-env");
  assert.equal(
    await withLock("explicit", async () => 42, { ...f.options, env: { XDG_STATE_HOME: unused } }),
    42,
  );
  await assert.rejects(readdir(unused), { code: "ENOENT" });
  await withLock("env", async () => {}, { home: f.home, env: { XDG_STATE_HOME: unused } });
  assert.deepEqual(await readdir(join(unused, "skillex", "locks", resourceHash("env"))), []);
  await withLock("default", async () => {}, { home: f.home, env: {} });
  assert.deepEqual(
    await readdir(join(f.home, ".local", "state", "skillex", "locks", resourceHash("default"))),
    [],
  );
});

test("invalid explicit state and timeout values never fall through or run the action", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { ...f.options, stateHome: "" },
    { ...f.options, timeoutMs: -1 },
    { ...f.options, timeoutMs: Number.POSITIVE_INFINITY },
  ]) {
    await assert.rejects(
      withLock("invalid", async () => assert.fail("must not run"), options),
      (error) => error.findings[0].code === "E_LOCK_CONFIG",
    );
  }
  await assert.rejects(readdir(f.stateHome), { code: "ENOENT" });
});

test("filesystem errors and symlinked state paths fail without invoking child callbacks", async (t) => {
  const f = await fixture(t);
  const blocker = join(f.root, "blocker");
  await writeFile(blocker, "foreign file\n");
  const broken = await child(f, { resource: "io", options: { stateHome: join(blocker, "state") } });
  assert.equal((await broken.wait("failure")).code, "E_IO");
  assert.ok(!broken.messages.some((message) => message.event === "entered"));
  const real = join(f.root, "real-state");
  await mkdir(real);
  const alias = join(f.root, "state-alias");
  await symlink(real, alias);
  const linked = await child(f, { resource: "io", options: { stateHome: alias } });
  assert.equal((await linked.wait("failure")).code, "E_LOCK_STATE");
  assert.deepEqual(await readdir(real), []);
  assert.equal(await readFile(blocker, "utf8"), "foreign file\n");
});
