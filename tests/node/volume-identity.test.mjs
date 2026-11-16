import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, it } from "node:test";
import {
  planSync,
  resolveVolumeUuid,
  setVolumeResolver,
  showProfile,
  sync,
  syncProfile,
} from "@delorenj/skillex";

const APFS = "7E5B2C1A-0D3F-4A6B-9C8E-112233445566";
const OTHER = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const plist = (uuid) =>
  `<dict><key>VolumeName</key><string>Data</string><key>VolumeUUID</key>\n\t<string>${uuid}</string></dict>`;

afterEach(() => setVolumeResolver(undefined));

it("macOS: df names the device, diskutil reads its APFS VolumeUUID, upper-cased", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return command === "/bin/df"
      ? "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1942700360 897724248 996205024 48% /System/Volumes/Data\n"
      : plist(APFS.toLowerCase());
  };
  assert.equal(resolveVolumeUuid("/Users/x/.agents", { platform: "darwin", run }), APFS);
  assert.deepEqual(calls, [
    ["/bin/df", "-P", "/Users/x/.agents"],
    ["/usr/sbin/diskutil", "info", "-plist", "/dev/disk3s5"],
  ]);
  for (const bad of [() => null, () => "Filesystem\nmap auto_home 0 0 0 0% /home\n"])
    assert.equal(
      resolveVolumeUuid("/x", { platform: "darwin", run: bad }),
      undefined,
      "an unreadable volume falls back to st_dev",
    );
  assert.equal(
    resolveVolumeUuid("/x", {
      platform: "darwin",
      run: (command) => (command === "/bin/df" ? "h\n/dev/disk1s1 1 1 1 1% /\n" : "<dict></dict>"),
    }),
    undefined,
  );
});

it("Linux: findmnt UUID, then blkid on the mount source, then st_dev", () => {
  const fsUuid = "0a1b2c3d-1111-2222-3333-444455556666";
  assert.equal(
    resolveVolumeUuid("/home/x", {
      platform: "linux",
      run: (command, args) =>
        command === "findmnt" && args.includes("UUID") ? `${fsUuid}\n` : null,
    }),
    fsUuid,
  );
  const calls = [];
  assert.equal(
    resolveVolumeUuid("/home/x", {
      platform: "linux",
      run: (command, args) => {
        calls.push(command);
        if (command === "findmnt") return args.includes("SOURCE") ? "/dev/nvme0n1p2\n" : "\n";
        return `${fsUuid}\n`;
      },
    }),
    fsUuid,
  );
  assert.deepEqual(calls, ["findmnt", "findmnt", "blkid"]);
  // tmpfs/overlay: no UUID, no /dev source -> undefined, callers compare st_dev.
  assert.equal(
    resolveVolumeUuid("/tmp/x", {
      platform: "linux",
      run: (_command, args) => (args.includes("SOURCE") ? "tmpfs\n" : "\n"),
    }),
    undefined,
  );
  assert.equal(resolveVolumeUuid("/x", { platform: "win32", run: () => APFS }), undefined);
});

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-volume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, value) => {
    directory(dirname(path));
    writeFileSync(path, value);
    return path;
  };
  const home = directory(join(root, "home"));
  const project = directory(join(root, "project"));
  const registry = directory(join(root, "registry"));
  const hermesRoot = directory(join(root, "hermes"));
  const profile = directory(join(hermesRoot, "profiles", "work"));
  directory(join(profile, "skills"));
  directory(join(project, ".git"));
  for (const name of ["alpha", "beta", "gamma"])
    file(join(registry, "all-skills", name, "SKILL.md"), `# ${name}\n`);
  file(join(home, ".agents", "skills.json"), JSON.stringify({ skills: ["alpha"] }));
  file(
    join(project, ".agents", "skills.json"),
    JSON.stringify({ inherit_global: true, skills: ["beta"] }),
  );
  const options = {
    home,
    project,
    cwd: project,
    registryRoot: registry,
    hermesRoot,
    stateHome: join(root, "state"),
    env: {},
    timeoutMs: 10_000,
  };
  return { root, home, project, profile, options };
}

function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result.findings ?? result, null, 2));
  return result.data ?? result;
}

const devOf = (path) => String(lstatSync(path, { bigint: true }).dev);

/** Profile receipt: every identity rewritten by `edit(identity)`. */
function rewriteProfileReceipt(path, edit) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  edit(doc.data.root);
  for (const link of Object.values(doc.data.links)) edit(link);
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
  return doc;
}

it("a new profile receipt records volumeUuid next to dev and ino", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => APFS);
  ok(await syncProfile("work", f.options));
  const shown = await showProfile("work", f.options);
  const doc = JSON.parse(readFileSync(shown.data.receiptPath, "utf8"));
  assert.equal(doc.data.root.volumeUuid, APFS);
  for (const link of Object.values(doc.data.links)) assert.equal(link.volumeUuid, APFS);
  assert.deepEqual(ok(await syncProfile("work", { ...f.options, dryRun: true })).changes, []);
  assert.equal((await showProfile("work", f.options)).exit, 0);
});

/** A real selection change, so the next sync has a reason to write the receipt. */
function selectGamma(f) {
  writeFileSync(
    join(f.project, ".agents", "skills.json"),
    JSON.stringify({ inherit_global: true, skills: ["beta", "gamma"] }),
  );
}

it("renumbered dev on the same volume UUID is accepted and is not drift; a real write refreshes it", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => APFS);
  ok(await syncProfile("work", f.options));
  const path = (await showProfile("work", f.options)).data.receiptPath;
  const real = devOf(join(f.profile, "skills"));
  const renumbered = String(BigInt(real) + 1n);
  rewriteProfileReceipt(path, (identity) => {
    if (identity) identity.dev = renumbered;
  });
  const before = readFileSync(path, "utf8");
  // Read-only and idle: no refusal, no drift, no write.
  const shown = await showProfile("work", f.options);
  assert.equal(shown.exit, 0, JSON.stringify(shown.findings));
  assert.equal(readFileSync(path, "utf8"), before, "show must not upgrade the receipt");
  assert.deepEqual(ok(await syncProfile("work", { ...f.options, dryRun: true })).changes, []);
  assert.equal(readFileSync(path, "utf8"), before, "dry run must not upgrade the receipt");
  // A real change writes the receipt with the refreshed identities for every entry.
  selectGamma(f);
  const preview = ok(await syncProfile("work", { ...f.options, dryRun: true }));
  assert.ok(preview.changes.some((c) => c.action === "write-receipt"));
  assert.equal(readFileSync(path, "utf8"), before, "preview never writes");
  ok(await syncProfile("work", f.options));
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.data.root.dev, real);
  assert.equal(doc.data.root.volumeUuid, APFS);
  for (const link of Object.values(doc.data.links)) assert.equal(link.dev, real);
  assert.deepEqual(ok(await syncProfile("work", { ...f.options, dryRun: true })).changes, []);
  assert.equal((await showProfile("work", f.options)).exit, 0);
});

it("a different volume UUID is a genuine ownership change and is refused", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => APFS);
  ok(await syncProfile("work", f.options));
  const path = (await showProfile("work", f.options)).data.receiptPath;
  rewriteProfileReceipt(path, (identity) => {
    if (identity) identity.volumeUuid = OTHER;
  });
  const before = readFileSync(path, "utf8");
  const refused = await syncProfile("work", f.options);
  assert.equal(refused.exit, 3, JSON.stringify(refused.findings));
  assert.equal((await showProfile("work", f.options)).exit, 3);
  assert.equal(readFileSync(path, "utf8"), before);
  // Even when the device number was reused unchanged, the UUID decides.
  setVolumeResolver(() => OTHER);
  assert.equal((await syncProfile("work", f.options)).exit, 0, "receipt UUID now matches again");
});

it("a legacy dev-only receipt with a stale dev is accepted and upgraded to carry volumeUuid on the next write", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => APFS);
  ok(await syncProfile("work", f.options));
  const path = (await showProfile("work", f.options)).data.receiptPath;
  const real = devOf(join(f.profile, "skills"));
  rewriteProfileReceipt(path, (identity) => {
    if (!identity) return;
    identity.dev = String(BigInt(real) + 1n);
    delete identity.volumeUuid;
  });
  const before = readFileSync(path, "utf8");
  assert.equal((await showProfile("work", f.options)).exit, 0);
  assert.equal(readFileSync(path, "utf8"), before, "show never upgrades");
  assert.deepEqual(ok(await syncProfile("work", { ...f.options, dryRun: true })).changes, []);
  selectGamma(f);
  ok(await syncProfile("work", f.options));
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.data.root.volumeUuid, APFS);
  assert.equal(doc.data.root.dev, real);
  for (const link of Object.values(doc.data.links)) assert.equal(link.volumeUuid, APFS);
  assert.equal((await showProfile("work", f.options)).exit, 0);
});

it("a legacy receipt with a different inode is still refused", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => APFS);
  ok(await syncProfile("work", f.options));
  const path = (await showProfile("work", f.options)).data.receiptPath;
  rewriteProfileReceipt(path, (identity) => {
    if (!identity) return;
    identity.dev = String(BigInt(identity.dev) + 1n);
    identity.ino = String(BigInt(identity.ino) + 1n);
    delete identity.volumeUuid;
  });
  assert.equal((await showProfile("work", f.options)).exit, 3);
});

it("Linux fallback: with no resolvable volume id, dev is recorded and compared as before", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => undefined);
  ok(await syncProfile("work", f.options));
  const path = (await showProfile("work", f.options)).data.receiptPath;
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.data.root.volumeUuid, undefined);
  assert.equal(doc.data.root.dev, devOf(join(f.profile, "skills")));
  assert.deepEqual(ok(await syncProfile("work", { ...f.options, dryRun: true })).changes, []);
  assert.equal((await showProfile("work", f.options)).exit, 0);
});

it("global activation receipts renumber the same way (sync and planSync)", async (t) => {
  const f = fixture(t);
  setVolumeResolver(() => APFS);
  const first = ok(await sync(f.options));
  const receiptPath = first.scopes.find((item) => item.scope === "global").receiptPath;
  const doc = JSON.parse(readFileSync(receiptPath, "utf8"));
  const records = [...Object.values(doc.data.links), ...Object.values(doc.data.directories)];
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record.volumeUuid, APFS);
    record.dev = String(BigInt(record.dev) + 7n);
  }
  writeFileSync(receiptPath, `${JSON.stringify(doc)}\n`);
  const before = readFileSync(receiptPath, "utf8");
  assert.deepEqual(ok(await planSync(f.options)).changes, [], "a stale dev alone is not drift");
  assert.deepEqual(ok(await sync(f.options)).changes, []);
  assert.equal(readFileSync(receiptPath, "utf8"), before, "an idle sync stays write-free");
  // A real change writes the receipt, carrying every refreshed identity.
  writeFileSync(
    join(f.home, ".agents", "skills.json"),
    JSON.stringify({ skills: ["alpha", "gamma"] }),
  );
  ok(await sync(f.options));
  const after = JSON.parse(readFileSync(receiptPath, "utf8"));
  for (const record of [
    ...Object.values(after.data.links),
    ...Object.values(after.data.directories),
  ])
    assert.equal(record.dev, devOf(join(f.home, ".agents")), "dev refreshed");
  assert.notEqual(JSON.stringify(after.data.links), JSON.stringify(doc.data.links));
  assert.deepEqual(ok(await planSync(f.options)).changes, []);
  // Different volume: refused.
  setVolumeResolver(() => OTHER);
  const refused = await planSync(f.options);
  assert.equal(refused.exit, 3, JSON.stringify(refused.findings));
});
