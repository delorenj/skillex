import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { inspectVendorStatus, syncVendorSources, withLock } from "@delorenj/skillex";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-vendor-sync-"));
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
  const registry = directory(join(root, "registry"));
  const catalog = directory(join(registry, "all-skills"));
  const upstream = directory(join(root, "upstream"));
  const stateHome = join(root, "state");
  const options = {
    home,
    registryRoot: registry,
    cwd: root,
    stateHome,
    env: {},
    checkouts: { fixture: upstream },
    timeoutMs: 10_000,
  };
  const repo = "https://example.invalid/vendor-core.git";
  function git(...args) {
    return gitInput(undefined, ...args);
  }
  function gitInput(input, ...args) {
    const result = spawnSync("git", ["-C", upstream, ...args], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Vendor fixture");
  git("config", "user.email", "vendor@example.test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", repo);
  function skill(name, body = name, base = "skills") {
    const path = join(upstream, base, name);
    file(
      join(path, "SKILL.md"),
      `---\nname: upstream-${name}\ndescription: committed ${name}\n---\n${body}\n`,
    );
    file(join(path, "references", "a guide.md"), `${body} reference\n`);
    return path;
  }
  skill("alpha");
  skill("beta");
  const script = file(join(upstream, "skills", "alpha", "run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
  file(join(upstream, "skills", "alpha", "bytes.bin"), Buffer.from([0, 255, 127, 1]));
  function commit() {
    git("add", "--all");
    git("commit", "-qm", "Fixture snapshot");
    return git("rev-parse", "HEAD");
  }
  const pin = commit();
  function sources(entries = [{ name: "fixture", repo, version: pin, checkout: "fixture" }]) {
    const value = (item) =>
      Array.isArray(item)
        ? `[${item.map(value).join(", ")}]`
        : item && typeof item === "object"
          ? `{ ${Object.entries(item)
              .map(([key, child]) => `${key} = ${value(child)}`)
              .join(", ")} }`
          : JSON.stringify(item);
    file(
      join(catalog, "sources.toml"),
      `version = 1\n${entries
        .map(
          (entry) =>
            `\n[[source]]\n${Object.entries(entry)
              .map(([key, item]) => `${key} = ${value(item)}\n`)
              .join("")}`,
        )
        .join("")}`,
    );
  }
  sources();
  return {
    root,
    home,
    registry,
    catalog,
    upstream,
    stateHome,
    options,
    repo,
    pin,
    git,
    gitInput,
    skill,
    commit,
    sources,
    file,
    directory,
  };
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.mode,
      info.ino,
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
  assert.equal(result.exit, 0, JSON.stringify(result, null, 2));
  return result.data;
}
function receipt(f, name = "alpha") {
  return parseYaml(readFileSync(join(f.catalog, name, ".source.yaml"), "utf8"));
}
function journals(f) {
  const path = join(f.stateHome, "skillex", "vendor", "v1");
  return existsSync(path)
    ? readdirSync(path)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => join(path, name))
    : [];
}
async function immutable(f, action) {
  const before = snapshot(f.root);
  const result = await action();
  assert.deepEqual(snapshot(f.root), before);
  return result;
}
function child(f, injection, options = {}) {
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs/promises');
const syncfs = require('node:fs');
${injection}
syncBuiltinESMExports();
const { syncVendorSources } = await import('@delorenj/skillex');
const result = await syncVendorSources(${JSON.stringify({ ...f.options, ...options })});
process.stdout.write(JSON.stringify(result));`;
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

it("vendors only pinned committed bytes, binary files, executable modes, and source evidence", async (t) => {
  const f = fixture(t);
  const timestamp = Date.now();
  f.file(join(f.upstream, "skills", "alpha", "SKILL.md"), "dirty uncommitted replacement");
  f.file(join(f.upstream, "skills", "alpha", "untracked.md"), "do not import");
  const data = ok(await syncVendorSources({ ...f.options, env: { GIT_DIR: "/missing/redirect" } }));
  assert.deepEqual(
    data.applied.map((change) => change.name),
    ["alpha", "beta"],
  );
  assert.match(readFileSync(join(f.catalog, "alpha", "SKILL.md"), "utf8"), /committed alpha/);
  assert.equal(existsSync(join(f.catalog, "alpha", "untracked.md")), false);
  assert.deepEqual(
    readFileSync(join(f.catalog, "alpha", "bytes.bin")),
    Buffer.from([0, 255, 127, 1]),
  );
  assert.equal(lstatSync(join(f.catalog, "alpha", "run.sh")).mode & 0o777, 0o755);
  const provenance = receipt(f);
  assert.equal(provenance.origin.upstream_commit, f.pin);
  assert.equal(provenance.origin.upstream_tree, f.git("rev-parse", `${f.pin}:skills/alpha`));
  assert.equal(provenance.origin.upstream_path, "skills/alpha");
  assert.match(provenance.origin.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Date.parse(provenance.origin.extracted_at) >= timestamp);
  assert.equal(journals(f).length, 0);
  ok(await inspectVendorStatus(f.options));
});

it("dry-run and a converged second invocation leave every fixture byte, inode, and state path unchanged", async (t) => {
  const f = fixture(t);
  const dry = ok(await immutable(f, () => syncVendorSources({ ...f.options, dryRun: true })));
  assert.deepEqual(
    dry.changes.map((change) => change.action),
    ["create", "create"],
  );
  assert.equal(existsSync(f.stateHome), false);
  ok(await syncVendorSources(f.options));
  const data = ok(await immutable(f, () => syncVendorSources(f.options)));
  assert.deepEqual(data.applied, []);
  assert.ok(data.changes.every((change) => change.action === "unchanged"));
});

it("resolves local branches and annotated tags while explicit inventory and discovery filters stay bounded", async (t) => {
  const f = fixture(t);
  f.git("tag", "-a", "release", "-m", "Release fixture");
  f.file(join(f.upstream, "skills", "support", "README.md"), "not a skill");
  const pin = f.commit();
  f.sources([
    { name: "fixture", repo: f.repo, version: "main", checkout: "fixture", include: ["alpha"] },
  ]);
  const branch = ok(await syncVendorSources({ ...f.options, dryRun: true }));
  assert.equal(branch.sources[0].commit, pin);
  assert.equal(branch.sources[0].refKind, "branch");
  assert.deepEqual(
    branch.changes.map((change) => change.name),
    ["alpha"],
  );
  f.sources([
    {
      name: "fixture",
      repo: f.repo,
      version: "release",
      checkout: "fixture",
      skills: [{ name: "renamed", dir: "alpha" }],
    },
  ]);
  const tag = ok(await syncVendorSources(f.options));
  assert.equal(tag.sources[0].refKind, "tag");
  assert.deepEqual(
    tag.changes.map((change) => change.name),
    ["renamed"],
  );
  assert.equal(receipt(f, "renamed").origin.upstream_path, "skills/alpha");
});

it("rejects an enclosing Git repository borrowed through a checkout subdirectory", async (t) => {
  const f = fixture(t);
  const result = await immutable(f, () =>
    syncVendorSources({ ...f.options, checkouts: { fixture: join(f.upstream, "skills") } }),
  );
  assert.equal(result.exit, 3);
  assert.ok(result.findings.some((finding) => finding.code === "E_VENDOR_CHECKOUT_ROOT"));
});

it("refuses symlink farms, nested symlinks, gitlinks, malformed metadata, and non-UTF8 committed names before writes", async (t) => {
  for (const kind of ["root-link", "nested-link", "gitlink", "yaml", "utf8"]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      if (kind === "root-link") symlinkSync("alpha", join(f.upstream, "skills", "alias"));
      if (kind === "nested-link")
        symlinkSync("SKILL.md", join(f.upstream, "skills", "alpha", "alias.md"));
      if (kind === "yaml")
        f.file(join(f.upstream, "skills", "alpha", "SKILL.md"), "---\ndescription: [broken\n---\n");
      if (kind === "gitlink")
        f.git("update-index", "--add", "--cacheinfo", `160000,${f.pin},skills/module`);
      let pin;
      if (kind === "utf8") {
        // Git tree names are bytes; APFS cannot materialize an invalid UTF-8 filename.
        const blob = f.git("rev-parse", `${f.pin}:skills/alpha/SKILL.md`);
        const skillTree = f.gitInput(
          Buffer.concat([
            Buffer.from(`100644 blob ${blob}\tSKILL.md\0`),
            Buffer.from(`100644 blob ${blob}\t`),
            Buffer.from([255, 0]),
          ]),
          "mktree",
          "-z",
        );
        const skillsTree = f.gitInput(
          Buffer.from(`040000 tree ${skillTree}\talpha\0`),
          "mktree",
          "-z",
        );
        const rootTree = f.gitInput(
          Buffer.from(`040000 tree ${skillsTree}\tskills\0`),
          "mktree",
          "-z",
        );
        pin = f.git("commit-tree", rootTree, "-p", f.pin, "-m", "Invalid UTF-8 tree fixture");
      } else if (kind === "gitlink") {
        f.git("commit", "-qm", "gitlink fixture");
        pin = f.git("rev-parse", "HEAD");
      } else pin = f.commit();
      f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
      const result = await immutable(f, () => syncVendorSources(f.options));
      assert.ok([2, 3].includes(result.exit), JSON.stringify(result));
      if (kind === "utf8") {
        assert.equal(result.exit, 2);
        assert.ok(result.findings.some((finding) => finding.code === "E_INVALID_UTF8"));
      }
      assert.ok(result.findings.some((finding) => finding.path && finding.fix));
      assert.equal(existsSync(f.stateHome), false);
    });
  }
});

it("explicit missing SKILL.md and duplicate canonical selections refuse all earlier valid work", async (t) => {
  const f = fixture(t);
  f.sources([
    {
      name: "first",
      repo: f.repo,
      version: f.pin,
      checkout: "fixture",
      skills: [{ name: "alpha", dir: "alpha" }],
    },
    {
      name: "second",
      repo: f.repo,
      version: f.pin,
      checkout: "fixture",
      skills: [{ name: "alpha", dir: "beta" }],
    },
  ]);
  const duplicate = await immutable(f, () => syncVendorSources(f.options));
  assert.equal(duplicate.exit, 3);
  assert.ok(duplicate.findings.some((finding) => finding.code === "E_VENDOR_DUPLICATE_SKILL"));
  f.sources([
    {
      name: "fixture",
      repo: f.repo,
      version: f.pin,
      checkout: "fixture",
      subdir: "skills/alpha",
      skills: [{ name: "alpha", dir: "references" }],
    },
  ]);
  const missing = await immutable(f, () => syncVendorSources(f.options));
  assert.equal(missing.exit, 3);
  assert.ok(missing.findings.some((finding) => finding.code === "E_SKILL_MISSING"));
});

it("adoption requires both explicit options for differing content and never replaces catalog links", async (t) => {
  const f = fixture(t);
  cpSync(join(f.upstream, "skills", "alpha"), join(f.catalog, "alpha"), { recursive: true });
  f.file(join(f.catalog, "alpha", "local.txt"), "preserve me");
  const unmanaged = await immutable(f, () => syncVendorSources(f.options));
  assert.equal(unmanaged.exit, 3);
  assert.ok(unmanaged.findings.some((finding) => finding.code === "E_VENDOR_UNMANAGED"));
  const edited = await immutable(f, () => syncVendorSources({ ...f.options, adopt: true }));
  assert.equal(edited.exit, 3);
  assert.ok(edited.findings.some((finding) => finding.code === "E_VENDOR_LOCAL_EDITS"));
  ok(await syncVendorSources({ ...f.options, adopt: true, discardLocalEdits: true }));
  assert.equal(existsSync(join(f.catalog, "alpha", "local.txt")), false);
  rmSync(join(f.catalog, "beta"), { recursive: true });
  symlinkSync(join(f.upstream, "skills", "beta"), join(f.catalog, "beta"));
  const linked = await immutable(f, () =>
    syncVendorSources({ ...f.options, adopt: true, discardLocalEdits: true }),
  );
  assert.equal(linked.exit, 3);
  assert.ok(linked.findings.some((finding) => finding.code === "E_VENDOR_DESTINATION_LINK"));
});

it("preserves original adoption evidence without recursively nesting vendor receipts on updates", async (t) => {
  const f = fixture(t);
  cpSync(join(f.upstream, "skills", "alpha"), join(f.catalog, "alpha"), { recursive: true });
  f.file(
    join(f.catalog, "alpha", ".source.yaml"),
    "origin:\n  type: local\nnote: original evidence\n",
  );
  ok(await syncVendorSources({ ...f.options, adopt: true }));
  const original = receipt(f).previous_provenance;
  assert.equal(original.note, "original evidence");
  for (let index = 0; index < 2; index++) {
    f.file(join(f.upstream, "skills", "alpha", "change.txt"), `version ${index}`);
    const pin = f.commit();
    f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
    ok(await syncVendorSources(f.options));
    assert.deepEqual(receipt(f).previous_provenance, original);
  }
});

it("mode edits and absent baseline cannot be overwritten implicitly or pruned with a discard flag", async (t) => {
  const f = fixture(t);
  ok(await syncVendorSources(f.options));
  chmodSync(join(f.catalog, "alpha", "run.sh"), 0o644);
  const changed = await immutable(f, () => syncVendorSources(f.options));
  assert.equal(changed.exit, 3);
  assert.ok(changed.findings.some((finding) => finding.code === "E_VENDOR_LOCAL_EDITS"));
  ok(await syncVendorSources({ ...f.options, discardLocalEdits: true }));
  const raw = receipt(f);
  delete raw.origin.digest;
  f.file(join(f.catalog, "alpha", ".source.yaml"), stringifyYaml(raw));
  const missing = await immutable(f, () => syncVendorSources(f.options));
  assert.equal(missing.exit, 3);
  assert.ok(missing.findings.some((finding) => finding.code === "E_VENDOR_BASELINE_MISSING"));
  f.sources([{ name: "fixture", repo: f.repo, version: f.pin, checkout: "fixture", skills: [] }]);
  const prune = await immutable(f, () =>
    syncVendorSources({ ...f.options, prune: true, discardLocalEdits: true }),
  );
  assert.equal(prune.exit, 3);
  assert.ok(prune.findings.some((finding) => finding.code === "E_VENDOR_BASELINE_MISSING"));
});

it("prunes only successfully enumerated selected sources and preserves foreign content and optional unavailable owners", async (t) => {
  const f = fixture(t);
  ok(await syncVendorSources(f.options));
  f.file(join(f.catalog, "foreign", "SKILL.md"), "# untouched\n");
  f.sources([
    {
      name: "fixture",
      repo: f.repo,
      version: f.pin,
      checkout: "fixture",
      optional: true,
      skills: [],
    },
  ]);
  const absent = await immutable(f, () =>
    syncVendorSources({
      ...f.options,
      checkouts: { fixture: join(f.root, "missing") },
      prune: true,
    }),
  );
  assert.equal(absent.exit, 4);
  assert.ok(absent.findings.some((finding) => finding.code === "W_OPTIONAL_SKIPPED"));
  const result = ok(await syncVendorSources({ ...f.options, prune: true }));
  assert.deepEqual(
    result.applied.map((change) => change.action),
    ["prune", "prune"],
  );
  assert.equal(existsSync(join(f.catalog, "alpha")), false);
  assert.equal(existsSync(join(f.catalog, "foreign", "SKILL.md")), true);
});

it("stages the whole update before touching old content and reports incomplete staging honestly", async (t) => {
  const f = fixture(t);
  ok(await syncVendorSources(f.options));
  const priorAlpha = snapshot(join(f.catalog, "alpha"));
  const priorBeta = snapshot(join(f.catalog, "beta"));
  f.file(join(f.upstream, "skills", "alpha", "new.txt"), "new");
  const pin = f.commit();
  f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
  const failed = child(
    f,
    `const original = fs.open;
let stages = 0;
fs.open = async (path, ...args) => {
  if (String(path).includes('.skillex-tmp-vendor-') && String(path).endsWith('/SKILL.md') && ++stages === 2) throw Object.assign(new Error('staging fixture'), {code:'EIO'});
  return original(path, ...args);
};`,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.deepEqual(failed.data.applied, []);
  assert.deepEqual(snapshot(join(f.catalog, "alpha")), priorAlpha);
  assert.deepEqual(snapshot(join(f.catalog, "beta")), priorBeta);
  assert.equal(journals(f).length, 1);
  const recovered = await syncVendorSources(f.options);
  assert.equal(recovered.exit, 4, JSON.stringify(recovered));
  const preserved = recovered.findings.find(
    (finding) => finding.code === "W_VENDOR_STAGING_PRESERVED",
  );
  assert.ok(preserved?.path && existsSync(preserved.path));
  assert.ok(recovered.data.applied.some((change) => change.name === "alpha"));
  assert.equal(journals(f).length, 0);
  ok(await syncVendorSources(f.options));
});

it("a publish failure retains old parked bytes and a retry converges after re-resolving current declarations", async (t) => {
  const f = fixture(t);
  ok(await syncVendorSources(f.options));
  f.file(join(f.upstream, "skills", "alpha", "new.txt"), "first update");
  let pin = f.commit();
  f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
  const failed = child(
    f,
    `const original = fs.rename;
fs.rename = async (from, to) => {
  if (String(from).endsWith('-new') && String(to).endsWith('/alpha')) throw Object.assign(new Error('publish fixture'), {code:'EIO'});
  return original(from, to);
};`,
  );
  assert.equal(failed.exit, 4);
  assert.deepEqual(failed.data.applied, []);
  const pending = JSON.parse(readFileSync(journals(f)[0], "utf8"));
  const operation = pending.operations.find((item) => item.change.name === "alpha");
  assert.match(readFileSync(join(operation.parked, "SKILL.md"), "utf8"), /committed alpha/);
  f.file(join(f.upstream, "skills", "alpha", "new.txt"), "current update");
  pin = f.commit();
  f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
  const recovered = ok(await syncVendorSources(f.options));
  assert.equal(readFileSync(join(f.catalog, "alpha", "new.txt"), "utf8"), "current update");
  assert.equal(recovered.sources[0].commit, pin);
  assert.equal(journals(f).length, 0);
});

it("changed declarations during staging preserve all old destinations and the retry follows current intent", async (t) => {
  const f = fixture(t);
  ok(await syncVendorSources(f.options));
  const beforeAlpha = snapshot(join(f.catalog, "alpha"));
  const beforeBeta = snapshot(join(f.catalog, "beta"));
  f.file(join(f.upstream, "skills", "alpha", "new.txt"), "alpha update");
  f.file(join(f.upstream, "skills", "beta", "new.txt"), "beta update");
  const pin = f.commit();
  f.sources([
    { name: "fixture", repo: f.repo, version: pin, checkout: "fixture", skills: ["beta"] },
  ]);
  const newManifest = readFileSync(join(f.catalog, "sources.toml"), "utf8");
  f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
  const failed = child(
    f,
    `const original = fs.open;
let changed = false;
fs.open = async (path, ...args) => {
  if (!changed && String(path).includes('.skillex-tmp-vendor-') && String(path).endsWith('/SKILL.md')) {
    changed = true;
    syncfs.writeFileSync(${JSON.stringify(join(f.catalog, "sources.toml"))}, ${JSON.stringify(newManifest)});
  }
  return original(path, ...args);
};`,
  );
  assert.equal(failed.exit, 4, JSON.stringify(failed));
  assert.ok(failed.findings.some((finding) => finding.code === "E_VENDOR_INTENT_CHANGED"));
  assert.deepEqual(failed.data.applied, []);
  assert.deepEqual(snapshot(join(f.catalog, "alpha")), beforeAlpha);
  assert.deepEqual(snapshot(join(f.catalog, "beta")), beforeBeta);
  ok(await syncVendorSources(f.options));
  assert.deepEqual(snapshot(join(f.catalog, "alpha")), beforeAlpha);
  assert.equal(readFileSync(join(f.catalog, "beta", "new.txt"), "utf8"), "beta update");
  assert.equal(journals(f).length, 0);
});

it("real process termination after parking recovers old content even when the checkout is now unavailable", async (t) => {
  const f = fixture(t);
  ok(await syncVendorSources(f.options));
  const prior = snapshot(join(f.catalog, "alpha"));
  f.file(join(f.upstream, "skills", "alpha", "new.txt"), "update");
  const pin = f.commit();
  f.sources([{ name: "fixture", repo: f.repo, version: pin, checkout: "fixture" }]);
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises');
const original = fs.rename;
fs.rename = async (from, to) => { const result = await original(from,to); if (String(to).endsWith('-old')) process.kill(process.pid, 'SIGKILL'); return result; };
syncBuiltinESMExports();
const { syncVendorSources } = await import('@delorenj/skillex');
await syncVendorSources(${JSON.stringify(f.options)});`;
  const processFixture = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [status, signal] = await new Promise((resolve, reject) => {
    processFixture.on("error", reject);
    processFixture.on("close", (code, signal) => resolve([code, signal]));
  });
  assert.equal(status, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(existsSync(join(f.catalog, "alpha")), false);
  const recovered = await syncVendorSources({
    ...f.options,
    checkouts: { fixture: join(f.root, "missing") },
  });
  assert.equal(recovered.exit, 4, JSON.stringify(recovered));
  assert.ok(recovered.findings.some((finding) => finding.code === "I_VENDOR_RECOVERED"));
  assert.ok(recovered.findings.some((finding) => finding.code === "E_SOURCE_CHECKOUT_MISSING"));
  assert.deepEqual(snapshot(join(f.catalog, "alpha")), prior);
  assert.equal(journals(f).length, 0);
  ok(await syncVendorSources(f.options));
});

it("published-prefix reporting survives an I/O error immediately after rename", async (t) => {
  const f = fixture(t);
  const result = child(
    f,
    `const original = fs.rename;
fs.rename = async (from, to) => {
  const result = await original(from, to);
  if (String(from).endsWith('-new') && String(to).endsWith('/alpha')) throw Object.assign(new Error('after publish'), {code:'EIO'});
  return result;
};`,
  );
  assert.equal(result.exit, 4);
  assert.deepEqual(
    result.data.applied.map((change) => change.name),
    ["alpha"],
  );
  assert.equal(existsSync(join(f.catalog, "alpha", "SKILL.md")), true);
  ok(await syncVendorSources(f.options));
  assert.equal(journals(f).length, 0);
});

it("concurrent selected-source updates serialize without losing either catalog publication", async (t) => {
  const f = fixture(t);
  f.sources([
    {
      name: "one",
      repo: f.repo,
      version: f.pin,
      checkout: "fixture",
      skills: [{ name: "alpha", dir: "alpha" }],
    },
    {
      name: "two",
      repo: f.repo,
      version: f.pin,
      checkout: "fixture",
      skills: [{ name: "beta", dir: "beta" }],
    },
  ]);
  const results = await Promise.all([
    syncVendorSources({ ...f.options, sources: ["one"] }),
    syncVendorSources({ ...f.options, sources: ["two"] }),
  ]);
  for (const result of results) ok(result);
  assert.equal(receipt(f, "alpha").origin.source, "one");
  assert.equal(receipt(f, "beta").origin.source, "two");
  assert.equal(journals(f).length, 0);
});

it("already-aborted calls are immutable and cancellation while waiting wins over lock contention", async (t) => {
  const f = fixture(t);
  const aborted = await immutable(f, () =>
    syncVendorSources({ ...f.options, signal: { aborted: true }, dryRun: true }),
  );
  assert.equal(aborted.exit, 130);
  const controller = new AbortController();
  let release;
  let acquired;
  const ready = new Promise((resolve) => {
    acquired = resolve;
  });
  const held = withLock(
    `${f.catalog}#catalog`,
    async () => {
      acquired();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
    f.options,
  );
  await ready;
  const syncing = syncVendorSources({ ...f.options, signal: controller.signal, timeoutMs: 60 });
  const timer = setTimeout(() => controller.abort(), 20);
  const result = await syncing;
  clearTimeout(timer);
  release();
  await held;
  assert.equal(result.exit, 130, JSON.stringify(result));
  assert.equal(existsSync(join(f.catalog, "alpha")), false);
  assert.equal(journals(f).length, 0);
});
