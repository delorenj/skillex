import assert from "node:assert/strict";
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
import { dirname, join } from "node:path";
import test from "node:test";
import { createSkill, importSkill, withLock } from "@delorenj/skillex";
import { parse } from "yaml";

async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/skillex-catalog-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryRoot = join(root, "registry");
  const source = join(root, "source");
  const home = join(root, "home");
  const cwd = join(root, "work");
  for (const path of [join(registryRoot, "all-skills"), source, home, cwd]) {
    await mkdir(path, { recursive: true });
  }
  const file = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return path;
  };
  await file(
    join(source, "SKILL.md"),
    "---\nname: original\ndescription: Local fixture\n---\n# Instructions\n",
  );
  return {
    root,
    registryRoot,
    source,
    file,
    destination: (name) => join(registryRoot, "all-skills", name),
    options: { registryRoot, home, cwd, env: {}, installedRoot: join(root, "no-install") },
  };
}

async function snapshot(root) {
  const entries = [];
  const walk = async (path, relative) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) entries.push([relative, "link", await readlink(path), info.mtimeMs]);
    else if (info.isDirectory()) {
      entries.push([relative, "directory", info.mode, info.mtimeMs]);
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name), join(relative, name));
    } else
      entries.push([
        relative,
        "file",
        (await readFile(path)).toString("base64"),
        info.mode,
        info.mtimeMs,
      ]);
  };
  await walk(root, ".");
  return entries;
}

function success(result) {
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.exit, 0);
  assert.equal(result.schema, 2);
  assert.deepEqual(result.findings, []);
  return result.data;
}

function failure(result, code) {
  assert.equal(result.ok, false);
  assert.notEqual(result.exit, 0);
  assert.ok(
    result.findings.some((finding) => finding.code === code),
    JSON.stringify(result.findings),
  );
  assert.ok(result.findings.every((finding) => finding.fix));
}

async function provenance(path) {
  return parse(await readFile(join(path, ".source.yaml"), "utf8"));
}

test("catalog create and import honor the same catalog writer lock", async (t) => {
  const f = await fixture(t);
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
    for (const run of [
      () => createSkill("blocked", { ...f.options, timeoutMs: 0 }),
      () => importSkill(f.source, "blocked", { ...f.options, timeoutMs: 0 }),
    ]) {
      const result = await run();
      assert.equal(result.exit, 5, JSON.stringify(result));
      failure(result, "E_LOCK_BUSY");
      assert.deepEqual(await snapshot(f.registryRoot), before);
    }
  } finally {
    release.resolve();
    await holder;
  }
  success(await createSkill("unblocked", f.options));
});

test("catalog writes refuse state inside source repositories and honor interruption before writes", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const unsafe = { ...f.options, stateHome: join(f.registryRoot, "state") };
  failure(await createSkill("unsafe", unsafe), "E_RECEIPT_UNSAFE_PATH");
  failure(await importSkill(f.source, "unsafe", unsafe), "E_RECEIPT_UNSAFE_PATH");
  for (const run of [
    () => createSkill("cancelled", { ...f.options, signal: { aborted: true } }),
    () => importSkill(f.source, "cancelled", { ...f.options, signal: { aborted: true } }),
  ]) {
    const result = await run();
    assert.equal(result.exit, 130, JSON.stringify(result));
    failure(result, "E_INTERRUPTED");
  }
  assert.deepEqual(await snapshot(f.root), before);
});

test("create scaffolds a real canonical skill with valid quoted metadata and provenance", async (t) => {
  const f = await fixture(t);
  const description = 'Use this: describe "quoted" input\nand a second line.';
  const result = success(await createSkill("new-skill", { ...f.options, description }));
  assert.equal(result.path, f.destination("new-skill"));
  assert.equal(result.registry.root, f.registryRoot);
  assert.equal(result.dryRun, false);
  const body = await readFile(join(result.path, "SKILL.md"), "utf8");
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter);
  assert.deepEqual(parse(frontmatter[1]), { name: "new-skill", description });
  assert.match(body, /required inputs, and expected output/);
  assert.ok((await lstat(result.path)).isDirectory());
  assert.ok((await lstat(join(result.path, "SKILL.md"))).isFile());
  const record = await provenance(result.path);
  assert.equal(record.origin.type, "local");
  assert.match(record.origin.digest, /^sha256:[a-f0-9]{64}$/);
});

test("create supplies a useful default description and a complete immutable dry-run plan", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const result = success(await createSkill("dry-skill", { ...f.options, dryRun: true }));
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.changes.map((change) => change.path),
    [
      f.destination("dry-skill"),
      join(f.destination("dry-skill"), "SKILL.md"),
      join(f.destination("dry-skill"), ".source.yaml"),
    ],
  );
  assert.deepEqual(await snapshot(f.root), before);
  success(await createSkill("real-skill", f.options));
  assert.match(
    await readFile(join(f.destination("real-skill"), "SKILL.md"), "utf8"),
    /documented workflow/,
  );
});

test("invalid names and empty descriptions fail before creating anything", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  for (const name of ["../escape", "Uppercase", "bad/child", "space name", "trailing-", ""]) {
    failure(await createSkill(name, f.options), "E_SKILL_NAME");
    failure(await importSkill(f.source, name, f.options), "E_SKILL_NAME");
  }
  failure(
    await createSkill("empty", { ...f.options, description: " " }),
    "E_SKILL_METADATA_INVALID",
  );
  assert.deepEqual(await snapshot(f.root), before);
});

for (const kind of ["directory", "file", "symlink", "broken-link"]) {
  test(`create and import preserve an existing destination ${kind}`, async (t) => {
    const f = await fixture(t);
    const destination = f.destination("existing");
    if (kind === "directory") await mkdir(destination);
    else if (kind === "file") await writeFile(destination, "foreign content");
    else await symlink(kind === "symlink" ? f.source : join(f.root, "missing"), destination);
    const before = await snapshot(f.root);
    for (const dryRun of [true, false]) {
      failure(await createSkill("existing", { ...f.options, dryRun }), "E_SKILL_EXISTS");
      failure(await importSkill(f.source, "existing", { ...f.options, dryRun }), "E_SKILL_EXISTS");
    }
    assert.deepEqual(await snapshot(f.root), before);
  });
}

test("import preserves complete support bytes, modes, empty directories, and the source", async (t) => {
  const f = await fixture(t);
  const script = await f.file(join(f.source, "scripts", "run.sh"), "#!/bin/sh\nprintf done\n");
  await chmod(script, 0o751);
  await chmod(join(f.source, "scripts"), 0o750);
  const binary = Buffer.from([0, 1, 2, 127, 128, 255]);
  await f.file(join(f.source, "assets", "image.bin"), binary);
  await f.file(join(f.source, ".editorconfig"), "root = true\n");
  await mkdir(join(f.source, "empty"));
  const old = {
    origin: {
      type: "vendored",
      upstream: "https://example.test/source.git",
      upstream_commit: "a".repeat(40),
      upstream_path: "skills/original",
    },
    modified_locally: true,
    notes: "Keep this evidence.",
  };
  await f.file(join(f.source, ".source.yaml"), JSON.stringify(old));
  const before = await snapshot(f.source);
  const result = success(await importSkill(f.source, "renamed", f.options));
  assert.deepEqual(await readFile(join(result.path, "assets", "image.bin")), binary);
  assert.equal((await lstat(join(result.path, "scripts", "run.sh"))).mode & 0o777, 0o751);
  assert.equal((await lstat(join(result.path, "scripts"))).mode & 0o777, 0o750);
  assert.ok((await lstat(join(result.path, "empty"))).isDirectory());
  assert.deepEqual(
    await readFile(join(result.path, "SKILL.md")),
    await readFile(join(f.source, "SKILL.md")),
  );
  assert.equal(await readFile(join(result.path, ".editorconfig"), "utf8"), "root = true\n");
  const record = await provenance(result.path);
  assert.equal(record.origin.type, "adhoc");
  assert.equal(record.origin.imported_from, f.source);
  assert.ok(Number.isFinite(Date.parse(record.origin.extracted_at)));
  assert.equal(record.modified_locally, false);
  assert.deepEqual(record.previous_provenance, old);
  assert.deepEqual(await snapshot(f.source), before);
});

test("import digest matches the Python wire contract including owner execute and nested provenance", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "SKILL.md"), "# Wire fixture\n");
  await f.file(join(f.source, "references", ".source.yaml"), "example: true\n");
  const script = await f.file(join(f.source, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(script, 0o755);
  await f.file(join(f.source, ".source.yaml"), "origin:\n  type: local\n");
  const result = success(await importSkill(f.source, "wire", f.options));
  // Computed independently with Python's existing sorted mode/hash/path contract.
  assert.equal(
    (await provenance(result.path)).origin.digest,
    "sha256:190b65d72471c0f78c49569a4eb17b44a182d7e802a65060744846e0ca80a4ca",
  );
});

test("digest path ordering matches Python for supplementary Unicode filenames", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "SKILL.md"), "# Unicode fixture\n");
  await f.file(join(f.source, "\ue000.md"), "private\n");
  await f.file(join(f.source, "\u{10000}.md"), "astral\n");
  const result = success(await importSkill(f.source, "unicode", f.options));
  assert.equal(
    (await provenance(result.path)).origin.digest,
    "sha256:6aafec0d9ac7e96b2889e8bdf798684631598b231deed2833117af542b756ada",
  );
});

test("import excludes VCS and runtime content explicitly while preserving authored support assets", async (t) => {
  const f = await fixture(t);
  for (const path of [
    ".git/config",
    ".cache/state",
    "__pycache__/cache.pyc",
    "node_modules/dependency/index.js",
    "running.pid",
    "process.sock",
    "app.log",
    "old.md.bak",
    ".env",
  ]) {
    await f.file(join(f.source, path), "runtime fixture\n");
  }
  for (const path of [
    "dist/runtime.js",
    "build/instructions.md",
    ".env.example",
    "references/guide.md",
  ]) {
    await f.file(join(f.source, path), "authored support fixture\n");
  }
  const sourceBefore = await snapshot(f.source);
  const result = success(await importSkill(f.source, "filtered", f.options));
  const exclusions = result.changes
    .filter((change) => change.action === "exclude-runtime")
    .map((change) => change.path);
  for (const path of [
    ".git",
    ".cache",
    "__pycache__",
    "node_modules",
    "running.pid",
    "process.sock",
    "app.log",
    "old.md.bak",
    ".env",
  ]) {
    assert.ok(exclusions.includes(join(f.source, path)), path);
    await assert.rejects(lstat(join(result.path, path)), { code: "ENOENT" });
  }
  for (const path of [
    "dist/runtime.js",
    "build/instructions.md",
    ".env.example",
    "references/guide.md",
  ]) {
    assert.equal(await readFile(join(result.path, path), "utf8"), "authored support fixture\n");
  }
  assert.deepEqual(await snapshot(f.source), sourceBefore);
});

test("import dry-run validates the whole source and reports all planned writes without mutation", async (t) => {
  const f = await fixture(t);
  await f.file(join(f.source, "references", "guide.md"), "A guide\n");
  await f.file(join(f.source, ".git", "config"), "fixture\n");
  const before = await snapshot(f.root);
  const result = success(await importSkill("../source", "preview", { ...f.options, dryRun: true }));
  assert.equal(result.dryRun, true);
  assert.ok(
    result.changes.some(
      (change) =>
        change.path === join(f.destination("preview"), "references", "guide.md") &&
        change.action === "copy-file",
    ),
  );
  assert.ok(result.changes.some((change) => change.action === "record-provenance"));
  assert.ok(result.changes.some((change) => change.action === "exclude-runtime"));
  assert.deepEqual(await snapshot(f.root), before);
});

for (const [file, content, code] of [
  ["SKILL.md", "---\ndescription: [broken\n---\n", "E_SKILL_METADATA_INVALID"],
  [".source.yaml", "origin: [invalid]\n", "E_SKILL_PROVENANCE_INVALID"],
]) {
  test(`invalid ${file} prevents import even during dry-run`, async (t) => {
    const f = await fixture(t);
    await f.file(join(f.source, file), content);
    const before = await snapshot(f.root);
    for (const dryRun of [true, false])
      failure(await importSkill(f.source, "invalid", { ...f.options, dryRun }), code);
    assert.deepEqual(await snapshot(f.root), before);
  });
}

test("import requires a real source directory and a real SKILL.md", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.source, alias);
  for (const source of ["", join(f.root, "absent"), join(f.source, "SKILL.md"), alias]) {
    failure(await importSkill(source, "invalid", f.options), "E_IMPORT_SOURCE");
  }
  await rm(join(f.source, "SKILL.md"));
  await symlink(join(f.root, "absent-definition"), join(f.source, "SKILL.md"));
  const before = await snapshot(f.root);
  failure(await importSkill(f.source, "invalid", f.options), "E_IMPORT_CONTENT");
  assert.deepEqual(await snapshot(f.root), before);
});

test("a portable internal link still cannot replace the owned SKILL.md definition", async (t) => {
  const f = await fixture(t);
  await rm(join(f.source, "SKILL.md"));
  await f.file(join(f.source, "references", "definition.md"), "# Real elsewhere\n");
  await symlink("references/definition.md", join(f.source, "SKILL.md"));
  const before = await snapshot(f.root);
  failure(await importSkill(f.source, "linked-definition", f.options), "E_NONCANONICAL_REFERENCE");
  assert.deepEqual(await snapshot(f.root), before);
});

test("recursive source/destination topology is refused before any destination appears", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  failure(await importSkill(f.root, "recursive", f.options), "E_IMPORT_RECURSIVE");
  failure(await importSkill(f.registryRoot, "recursive", f.options), "E_IMPORT_RECURSIVE");
  assert.deepEqual(await snapshot(f.root), before);
});

for (const kind of ["external", "dangling", "cycle", "directory-cycle", "excluded"]) {
  test(`an unsafe ${kind} support link refuses the whole import before writes`, async (t) => {
    const f = await fixture(t);
    const link = join(f.source, "support-link");
    if (kind === "external") {
      await f.file(join(f.root, "external.md"), "outside\n");
      await symlink(join(f.root, "external.md"), link);
    } else if (kind === "dangling") await symlink("missing.md", link);
    else if (kind === "cycle") {
      await symlink("other-link", link);
      await symlink("support-link", join(f.source, "other-link"));
    } else if (kind === "directory-cycle") await symlink(".", link);
    else {
      await f.file(join(f.source, ".cache", "state"), "runtime\n");
      await symlink(".cache/state", link);
    }
    const before = await snapshot(f.root);
    for (const dryRun of [true, false])
      failure(await importSkill(f.source, "unsafe", { ...f.options, dryRun }), "E_IMPORT_CONTENT");
    assert.deepEqual(await snapshot(f.root), before);
  });
}

test("safe internal file and directory links are relocated portably without copying targets twice", async (t) => {
  const f = await fixture(t);
  const target = await f.file(join(f.source, "references", "guide.md"), "Guide contents\n");
  await symlink("references/guide.md", join(f.source, "relative-guide"));
  await symlink(target, join(f.source, "absolute-guide"));
  await symlink("references", join(f.source, "docs"));
  const before = await snapshot(f.source);
  const result = success(await importSkill(f.source, "portable", f.options));
  for (const name of ["relative-guide", "absolute-guide"]) {
    assert.equal(await readlink(join(result.path, name)), "references/guide.md");
    assert.equal(await readFile(join(result.path, name), "utf8"), "Guide contents\n");
    assert.equal(
      await realpath(join(result.path, name)),
      join(result.path, "references", "guide.md"),
    );
  }
  assert.equal(await readlink(join(result.path, "docs")), "references");
  assert.ok(
    result.changes.some(
      (change) =>
        change.action === "relocate-link" && change.path === join(result.path, "absolute-guide"),
    ),
  );
  assert.equal((await provenance(result.path)).origin.digest_format, "skillex-tree-v1+symlinks");
  assert.deepEqual(await snapshot(f.source), before);
});

test("mutually linked support directories are a cycle even though each link resolves", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, "a"));
  await mkdir(join(f.source, "b"));
  await symlink("../b", join(f.source, "a", "next"));
  await symlink("../a", join(f.source, "b", "next"));
  const before = await snapshot(f.root);
  failure(await importSkill(f.source, "cyclic", f.options), "E_IMPORT_CONTENT");
  assert.deepEqual(await snapshot(f.root), before);
});

test("concurrent creators refuse the losing claim and preserve the winner", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    createSkill("concurrent", { ...f.options, description: "First creator" }),
    createSkill("concurrent", { ...f.options, description: "Second creator" }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  failure(
    results.find((result) => !result.ok),
    "E_SKILL_EXISTS",
  );
  const body = await readFile(join(f.destination("concurrent"), "SKILL.md"), "utf8");
  assert.match(body, /First creator|Second creator/);
  assert.equal((await provenance(f.destination("concurrent"))).origin.type, "local");
});

test("concurrent imports retain one complete source and leave both originals untouched", async (t) => {
  const f = await fixture(t);
  const other = join(f.root, "other-source");
  await f.file(join(other, "SKILL.md"), "# Other source\n");
  await f.file(join(other, "other-only.md"), "Other support\n");
  await f.file(join(f.source, "first-only.md"), "First support\n");
  const firstBefore = await snapshot(f.source);
  const otherBefore = await snapshot(other);
  const results = await Promise.all([
    importSkill(f.source, "race", f.options),
    importSkill(other, "race", f.options),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  failure(
    results.find((result) => !result.ok),
    "E_SKILL_EXISTS",
  );
  const imported = (await provenance(f.destination("race"))).origin.imported_from;
  assert.ok([f.source, other].includes(imported));
  assert.deepEqual(
    await readFile(join(f.destination("race"), "SKILL.md")),
    await readFile(join(imported, "SKILL.md")),
  );
  const children = await readdir(f.destination("race"));
  assert.equal(children.includes("first-only.md"), imported === f.source);
  assert.equal(children.includes("other-only.md"), imported === other);
  assert.deepEqual(await snapshot(f.source), firstBefore);
  assert.deepEqual(await snapshot(other), otherBefore);
});
