import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { migrate, readActivationReceipt, showProfile, sync } from "@delorenj/skillex";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-migration-activation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = (path) => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path, bytes) => {
    directory(dirname(path));
    writeFileSync(path, bytes);
    return path;
  };
  const home = directory(join(root, "home"));
  const project = directory(join(root, "project"));
  const registry = directory(join(root, "registry"));
  const activation = directory(join(project, ".agents", "skills"));
  const global = directory(join(home, ".agents", "skills"));
  const stateHome = join(root, "state");
  file(
    join(project, ".agents", "skills.json"),
    JSON.stringify({ inherit_global: false, skills: ["alpha"] }),
  );
  file(join(home, ".agents", "skills.json"), JSON.stringify({ inherit_global: false }));
  directory(join(registry, "sets"));
  directory(join(registry, "packs"));
  const skill = (name) => {
    const path = join(registry, "all-skills", name);
    file(join(path, "SKILL.md"), `# ${name}\n`);
    return path;
  };
  const alpha = skill("alpha");
  const beta = skill("beta");
  file(join(registry, "all-skills", "sources.toml"), "version = 1\n");
  const options = {
    home,
    project,
    registryRoot: registry,
    stateHome,
    cwd: root,
    env: {},
    timeoutMs: 10_000,
  };
  return {
    root,
    home,
    project,
    registry,
    activation,
    global,
    stateHome,
    alpha,
    beta,
    options,
    directory,
    file,
  };
}
function snapshot(root) {
  const out = [];
  const visit = (path) => {
    const info = lstatSync(path);
    out.push([
      relative(root, path),
      info.ino,
      info.mode,
      info.mtimeMs,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return out;
}
async function immutable(f, action) {
  const before = snapshot(f.root);
  const result = await action();
  assert.deepEqual(snapshot(f.root), before);
  return result;
}
function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result, null, 2));
  return result.data;
}
function legacy(f, raw = {}, pending = false, root = f.activation) {
  const key = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
  const path = join(
    f.stateHome,
    "skillex",
    "projections",
    `${key}${pending ? ".pending" : ""}.json`,
  );
  f.file(
    path,
    typeof raw === "string"
      ? raw
      : JSON.stringify({
          version: 1,
          root,
          scope: root === f.global ? "global" : "project",
          mode: "composed",
          alias_target: null,
          entries: {},
          ...raw,
        }),
  );
  return path;
}
function migrationReceipt(f, root = f.activation) {
  const path = join(
    f.stateHome,
    "skillex",
    "migrations",
    "v2",
    `${createHash("sha256").update(root).digest("hex")}.json`,
  );
  return { path, document: JSON.parse(readFileSync(path, "utf8")) };
}
function child(f, injection, options = {}) {
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url); const fs = require('node:fs/promises'); const syncfs = require('node:fs');
${injection}
syncBuiltinESMExports(); const {migrate} = await import('@delorenj/skillex');
const options = ${JSON.stringify({ ...f.options, apply: true, ...options })};
if (typeof fixtureSignal !== 'undefined') options.signal = fixtureSignal;
process.stdout.write(JSON.stringify(await migrate(options)));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

it("migration has no ambient activation target and preview is entirely immutable", async (t) => {
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  legacy(f, { entries: { alpha: f.alpha } });
  const { project, ...withoutTarget } = f.options;
  assert.ok(project);
  const ambient = ok(await immutable(f, () => migrate({ ...withoutTarget, cwd: f.project })));
  assert.equal(
    ambient.items.some((item) => item.area === "activation"),
    false,
  );
  const planned = ok(await immutable(f, () => migrate(f.options)));
  assert.ok(planned.items.some((item) => item.action === "adopt-root" && item.state === "ready"));
  assert.deepEqual(planned.applied, []);
});

it("validated Python claims become exact v2 ownership while real and foreign entries retain their inode and bytes", async (t) => {
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  symlinkSync(join(f.root, "removed-source"), join(f.activation, "stale"));
  symlinkSync(f.beta, join(f.activation, "foreign"));
  f.file(join(f.activation, ".system", "installer-owned"), "installer content\n");
  f.file(join(f.activation, "_bmad", "SKILL.md"), "# installer-owned BMAD\n");
  legacy(f, {
    entries: {
      alpha: { target: f.alpha, origin: "skills[0]", stage: "source" },
      stale: join(f.root, "removed-source"),
    },
  });
  const rootInode = lstatSync(f.activation).ino;
  const preserved = [
    snapshot(join(f.activation, "foreign")),
    snapshot(join(f.activation, ".system")),
    snapshot(join(f.activation, "_bmad")),
  ];
  const sources = snapshot(f.registry);
  ok(await migrate({ ...f.options, apply: true }));
  const data = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(data.directories[f.activation].ino, String(rootInode));
  assert.deepEqual(
    Object.keys(data.links)
      .filter((path) => dirname(path) === f.activation)
      .sort(),
    [join(f.activation, "alpha"), join(f.activation, "stale")],
  );
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(existsSync(join(f.activation, "stale")), false);
  assert.equal(lstatSync(f.activation).ino, rootInode);
  assert.deepEqual(
    [
      snapshot(join(f.activation, "foreign")),
      snapshot(join(f.activation, ".system")),
      snapshot(join(f.activation, "_bmad")),
    ],
    preserved,
  );
  assert.deepEqual(snapshot(f.registry), sources);
});

it("legacy parser refuses wrong roots, scopes, versions, malformed targets, and duplicate keys without preview writes", async (t) => {
  for (const [name, mutation] of [
    ["wrong root", { root: "/another/project/.agents/skills" }],
    ["wrong scope", { scope: "global" }],
    ["unknown version", { version: 2 }],
    ["target type", { entries: { alpha: { target: [] } } }],
    ["unknown fields", { owner: "guessed" }],
  ])
    await t.test(name, async (t) => {
      const f = fixture(t);
      symlinkSync(f.alpha, join(f.activation, "alpha"));
      legacy(f, { entries: { alpha: f.alpha }, ...mutation });
      const result = await immutable(f, () => migrate(f.options));
      assert.equal(result.exit, 3, JSON.stringify(result));
      assert.ok(
        result.data.items.some(
          (item) => item.action === "validate-python-receipt" && item.state === "blocked",
        ),
      );
      assert.equal(existsSync(join(f.stateHome, "skillex", "activations")), false);
    });
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  legacy(
    f,
    `{"version":1,"root":${JSON.stringify(f.activation)},"entries":{},"entries":{"alpha":${JSON.stringify(f.alpha)}}}`,
  );
  assert.equal((await immutable(f, () => migrate(f.options))).exit, 3);
});

it("pending-only empty targets and replaced links never become pruning claims", async (t) => {
  const f = fixture(t);
  symlinkSync(f.beta, join(f.activation, "alpha"));
  symlinkSync(f.beta, join(f.activation, "beta"));
  legacy(f, { entries: { alpha: f.alpha } });
  legacy(f, { entries: { beta: { target: "", origin: "", stage: "" } } }, true);
  const result = await migrate({ ...f.options, apply: true });
  assert.equal(result.exit, 4, JSON.stringify(result));
  const data = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(Object.hasOwn(data.links, join(f.activation, "alpha")), false);
  assert.equal(Object.hasOwn(data.links, join(f.activation, "beta")), false);
  assert.equal(readlinkSync(join(f.activation, "alpha")), f.beta);
  assert.equal(readlinkSync(join(f.activation, "beta")), f.beta);
});

it("an alias-mode Python receipt adopts only the actual whole-root link and preserves the shared target", async (t) => {
  const f = fixture(t);
  const shared = f.directory(join(f.root, "shared"));
  symlinkSync(f.alpha, join(shared, "alpha"));
  rmSync(f.activation, { recursive: true });
  symlinkSync(shared, f.activation);
  legacy(f, { mode: "alias", alias_target: shared, entries: {} });
  const inode = lstatSync(f.activation).ino;
  const original = snapshot(shared);
  ok(await migrate({ ...f.options, apply: true }));
  const data = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(data.links[f.activation].ino, String(inode));
  assert.equal(lstatSync(f.activation).ino, inode);
  assert.deepEqual(snapshot(shared), original);
  ok(await sync({ ...f.options, scope: "project" }));
  assert.equal(lstatSync(f.activation).isDirectory(), true);
  assert.deepEqual(snapshot(shared), original);
});

it("a shared pack receipt cannot be borrowed by a second scope with the same Python hash", async (t) => {
  const f = fixture(t);
  const shared = f.directory(join(f.root, "shared"));
  symlinkSync(f.alpha, join(shared, "alpha"));
  rmSync(f.activation, { recursive: true });
  symlinkSync(shared, f.activation);
  rmSync(f.global, { recursive: true });
  symlinkSync(shared, f.global);
  legacy(f, { mode: "alias", alias_target: shared }, false, f.global);
  const result = await immutable(f, () => migrate(f.options));
  assert.equal(result.exit, 3);
  assert.ok(
    result.data.items.some(
      (item) => item.action === "validate-python-receipt" && item.state === "blocked",
    ),
  );
});

it("explicit equivalent-content mapping relinks a foreign pointer and records its actual new inode", async (t) => {
  const f = fixture(t);
  const source = f.directory(join(f.root, "external", "alpha"));
  f.file(join(source, "SKILL.md"), "# alpha\n");
  const path = join(f.activation, "alpha");
  symlinkSync(source, path);
  const original = snapshot(source);
  ok(
    await migrate({
      ...f.options,
      apply: true,
      mapping: { version: 1, references: { [path]: "alpha" } },
    }),
  );
  assert.equal(readlinkSync(path), f.alpha);
  assert.deepEqual(snapshot(source), original);
  const data = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(data.links[path].ino, String(lstatSync(path).ino));
  const changed = f.directory(join(f.root, "other", "alpha"));
  f.file(join(changed, "SKILL.md"), "# alpha\n");
  chmodSync(join(changed, "SKILL.md"), 0o600);
  unlinkSync(path);
  symlinkSync(changed, path);
  const refused = await immutable(f, () =>
    migrate({ ...f.options, mapping: { version: 1, references: { [path]: "alpha" } } }),
  );
  assert.equal(refused.exit, 3);
});

it("mapped link-only CLI directories convert after counterparts are verified, while installer directories block only their own alias", async (t) => {
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  const cli = f.directory(join(f.project, ".claude", "skills"));
  symlinkSync(f.alpha, join(cli, "alpha"));
  const installer = f.directory(join(f.project, ".codex", "skills"));
  f.file(join(installer, ".system", "marker"), "installer-owned\n");
  const before = snapshot(installer);
  const result = await migrate({
    ...f.options,
    apply: true,
    mapping: { version: 1, references: { [join(cli, "alpha")]: "alpha" } },
  });
  assert.equal(result.exit, 4, JSON.stringify(result));
  assert.equal(lstatSync(cli).isSymbolicLink(), true);
  assert.equal(realpathSync(cli), f.activation);
  assert.deepEqual(snapshot(installer), before);
  const data = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(Object.hasOwn(data.links, installer), false);
  assert.equal(Object.hasOwn(data.links, join(f.activation, ".system")), false);
  const repeated = await immutable(f, () => migrate({ ...f.options, apply: true }));
  assert.equal(repeated.exit, 3);
  assert.deepEqual(repeated.data.applied, []);
});

it("null activation mappings preserve the original link and block that item", async (t) => {
  const f = fixture(t);
  const path = join(f.activation, "alpha");
  symlinkSync(f.alpha, path);
  const before = snapshot(path);
  const result = await migrate({
    ...f.options,
    apply: true,
    mapping: { version: 1, references: { [path]: null } },
  });
  assert.equal(result.exit, 4, JSON.stringify(result));
  assert.deepEqual(snapshot(path), before);
  assert.equal(
    Object.hasOwn((await readActivationReceipt(f.project, f.options)).document.data.links, path),
    false,
  );
});

it("named profile whole-root conversion preserves shared content and gives claims only to mapped canonical children", async (t) => {
  const f = fixture(t);
  const hermesRoot = f.directory(join(f.root, "hermes"));
  const profile = f.directory(join(hermesRoot, "profiles", "work"));
  const shared = f.directory(join(f.root, "profile-source"));
  symlinkSync(f.alpha, join(shared, "alpha"));
  f.file(join(shared, "overlay", "SKILL.md"), "# local overlay\n");
  const skills = join(profile, "skills");
  symlinkSync(shared, skills);
  const source = snapshot(shared);
  const profileInode = lstatSync(profile).ino;
  const options = {
    ...f.options,
    profile: "work",
    hermesRoot,
    mapping: { version: 1, references: { [join(skills, "alpha")]: "alpha" } },
  };
  ok(await immutable(f, () => migrate(options)));
  ok(await migrate({ ...options, apply: true }));
  assert.equal(lstatSync(skills).isDirectory(), true);
  assert.equal(lstatSync(profile).ino, profileInode);
  assert.equal(realpathSync(join(skills, "overlay")), join(shared, "overlay"));
  assert.deepEqual(snapshot(shared), source);
  const shown = await showProfile("work", options);
  assert.ok(shown.data.preserved.some((entry) => entry.name === "overlay"));
  const profileReceipt = JSON.parse(readFileSync(shown.data.receiptPath, "utf8"));
  assert.deepEqual(Object.keys(profileReceipt.data.links), ["alpha"]);
  const second = ok(await immutable(f, () => migrate({ ...options, apply: true })));
  assert.deepEqual(second.applied, []);
});

it("publication failures retain exact directory recovery evidence and report the completed prefix before retry", async (t) => {
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  const alias = f.directory(join(f.project, ".claude", "skills"));
  const failed = child(
    f,
    `const original = fs.rename;
fs.rename = async (from,to) => { const result = await original(from,to); if(String(from).includes('.skillex-tmp-migration-') && String(from).endsWith('-new') && String(to) === ${JSON.stringify(alias)}) throw Object.assign(new Error('after publication'),{code:'EIO'}); return result; };`,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.ok(failed.data.applied.some((id) => id.includes("convert-alias")));
  assert.equal(migrationReceipt(f).document.data.pending.path, alias);
  const preview = await immutable(f, () => migrate(f.options));
  assert.equal(preview.exit, 4);
  assert.ok(preview.findings.some((finding) => finding.code === "W_MIGRATION_RECOVERY_PENDING"));
  ok(await migrate({ ...f.options, apply: true }));
  assert.equal(migrationReceipt(f).document.data.pending, undefined);
  assert.equal(realpathSync(alias), f.activation);
});

it("real process termination after parking a legacy root recovers before invalid current intent is checked", async (t) => {
  const f = fixture(t);
  const shared = f.directory(join(f.root, "shared"));
  symlinkSync(f.alpha, join(shared, "alpha"));
  rmSync(f.activation, { recursive: true });
  symlinkSync(shared, f.activation);
  const originalRootInode = lstatSync(f.activation).ino;
  const source = snapshot(shared);
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises'); const original = fs.rename;
fs.rename = async (from,to) => { const result = await original(from,to); if(String(to).includes('.skillex-tmp-migration-') && String(to).endsWith('-old')) process.kill(process.pid,'SIGKILL'); return result; };
syncBuiltinESMExports(); const {migrate} = await import('@delorenj/skillex'); await migrate(${JSON.stringify({ ...f.options, apply: true })});`;
  const processFixture = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [status, signal] = await new Promise((resolve, reject) => {
    processFixture.on("error", reject);
    processFixture.on("close", (status, signal) => resolve([status, signal]));
  });
  assert.equal(status, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(existsSync(f.activation), false);
  f.file(join(f.project, ".agents", "skills.json"), "{ invalid current intent\n");
  const recovered = await migrate({ ...f.options, apply: true });
  assert.equal(recovered.exit, 4, JSON.stringify(recovered));
  assert.ok(recovered.data.applied.some((id) => id.startsWith("recover:")));
  assert.equal(lstatSync(f.activation).ino, originalRootInode);
  assert.equal(readlinkSync(f.activation), shared);
  assert.equal(migrationReceipt(f).document.data.pending, undefined);
  f.file(
    join(f.project, ".agents", "skills.json"),
    JSON.stringify({ inherit_global: false, skills: ["alpha"] }),
  );
  ok(await migrate({ ...f.options, apply: true }));
  assert.equal(lstatSync(f.activation).isDirectory(), true);
  assert.deepEqual(snapshot(shared), source);
  assert.equal(migrationReceipt(f).document.data.pending, undefined);
});

it("unrecorded staging artifacts stay visible and immutable instead of silently gaining ownership", async (t) => {
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  const path = join(
    f.project,
    ".agents",
    ".skillex-tmp-migration-11111111-1111-4111-8111-111111111111-new",
  );
  f.file(path, "unrecorded content\n");
  const before = snapshot(path);
  const result = await migrate({ ...f.options, apply: true });
  assert.equal(result.exit, 4, JSON.stringify(result));
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "W_MIGRATION_RECOVERY_PRESERVED" && finding.path === path,
    ),
  );
  assert.deepEqual(snapshot(path), before);
  assert.equal((await immutable(f, () => migrate({ ...f.options, apply: true }))).exit, 4);
});

it("a child stage created before journal publication remains visible and unowned on every retry", async (t) => {
  const f = fixture(t);
  const source = f.directory(join(f.root, "upstream-alpha"));
  f.file(join(source, "SKILL.md"), "# alpha\n");
  const path = join(f.activation, "alpha");
  symlinkSync(source, path);
  const original = snapshot(path);
  const options = { mapping: { version: 1, references: { [path]: "alpha" } } };
  const failed = child(
    f,
    `const original = fs.symlink;
fs.symlink = async (target,path,...rest) => { const result = await original(target,path,...rest); if(String(path).startsWith(${JSON.stringify(`${f.activation}/.skillex-tmp-migration-`)}) && String(path).endsWith('-new')) throw Object.assign(new Error('after unjournaled child stage'),{code:'EIO'}); return result; };`,
    options,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.deepEqual(snapshot(path), original);
  const name = readdirSync(f.activation).find((name) => name.startsWith(".skillex-tmp-migration-"));
  assert.ok(name);
  const artifact = join(f.activation, name);
  assert.ok(
    failed.findings.some(
      (finding) => finding.code === "W_MIGRATION_RECOVERY_PRESERVED" && finding.path === artifact,
    ),
  );
  const retained = snapshot(artifact);
  const retried = await migrate({ ...f.options, ...options, apply: true });
  assert.equal(retried.exit, 4, JSON.stringify(retried));
  assert.deepEqual(snapshot(artifact), retained);
  const receipt = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(Object.hasOwn(receipt.links, artifact), false);
  assert.equal(
    (await immutable(f, () => migrate({ ...f.options, ...options, apply: true }))).exit,
    4,
  );
  unlinkSync(artifact);
  ok(await immutable(f, () => migrate({ ...f.options, ...options, apply: true })));
});

it("concurrent migration serializes the same scope and cancellation before planning is write-free", async (t) => {
  const f = fixture(t);
  symlinkSync(f.alpha, join(f.activation, "alpha"));
  legacy(f, { entries: { alpha: f.alpha } });
  assert.equal(
    (await immutable(f, () => migrate({ ...f.options, apply: true, signal: { aborted: true } })))
      .exit,
    130,
  );
  for (const result of await Promise.all([
    migrate({ ...f.options, apply: true }),
    migrate({ ...f.options, apply: true }),
  ]))
    ok(result);
  const data = (await readActivationReceipt(f.project, f.options)).document.data;
  assert.equal(
    data.links[join(f.activation, "alpha")].ino,
    String(lstatSync(join(f.activation, "alpha")).ino),
  );
  assert.deepEqual(
    ok(await immutable(f, () => migrate({ ...f.options, apply: true }))).applied,
    [],
  );
});
