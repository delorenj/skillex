import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

function snapshot(root) {
  const entries = [];
  function visit(path) {
    const metadata = lstatSync(path);
    const name = relative(root, path);
    if (metadata.isSymbolicLink()) {
      entries.push([name, "link", metadata.mtimeMs, readlinkSync(path)]);
    } else if (metadata.isDirectory()) {
      entries.push([name, "directory", metadata.mode, metadata.mtimeMs]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      entries.push([
        name,
        "file",
        metadata.mode,
        metadata.mtimeMs,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
    }
  }
  visit(root);
  return entries;
}

export function createResolutionFixture(context, resolveSelection) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-resolution-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const registry = join(root, "registry");

  function directory(path) {
    mkdirSync(path, { recursive: true });
    return path;
  }
  function file(path, text) {
    directory(dirname(path));
    writeFileSync(path, text);
    return path;
  }
  function link(path, target) {
    directory(dirname(path));
    symlinkSync(relative(dirname(path), target), path);
    return path;
  }
  function manifest(scopeRoot, value) {
    return file(join(scopeRoot, ".agents", "skills.json"), `${JSON.stringify(value)}\n`);
  }
  function createRegistry(path) {
    for (const child of ["all-skills", "sets", "packs"]) directory(join(path, child));
    return path;
  }
  function skill(name, sourceRegistry = registry) {
    const path = directory(join(sourceRegistry, "all-skills", name));
    file(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Resolver fixture\n---\n`);
    return path;
  }
  function set(name, members = [], sourceRegistry = registry) {
    const path = directory(join(sourceRegistry, "sets", name));
    for (const member of members)
      link(join(path, member), join(sourceRegistry, "all-skills", member));
    return path;
  }
  function pack(name, version, members, sourceRegistry = registry) {
    const path = directory(join(sourceRegistry, "packs", name, version));
    file(
      join(path, "pack.toml"),
      `[pack]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\n\n[freeform]\nskills = ${JSON.stringify(members)}\n`,
    );
    return path;
  }
  function cachedRegistry(url) {
    return createRegistry(
      join(home, ".agents", ".cache", "registries", url.replace(/[^a-zA-Z0-9]/g, "_")),
    );
  }

  createRegistry(registry);
  directory(join(project, ".git"));
  for (const scopeRoot of [home, project]) {
    manifest(scopeRoot, { skills: [] });
    file(join(scopeRoot, ".agents", "skills", "foreign-file.txt"), "Preserve this content.\n");
    link(join(scopeRoot, ".claude", "skills"), join(scopeRoot, ".agents", "skills"));
  }

  return {
    root,
    home,
    project,
    registry,
    directory,
    file,
    link,
    manifest,
    createRegistry,
    skill,
    set,
    pack,
    cachedRegistry,
    async resolve(options = {}) {
      const before = snapshot(root);
      try {
        return await resolveSelection({
          home,
          cwd: project,
          scope: "project",
          env: {},
          registryRoot: registry,
          installedRoot: join(root, "absent-installed-registry"),
          ...options,
        });
      } finally {
        assert.deepEqual(
          snapshot(root),
          before,
          "resolution changed fixture source or activation state",
        );
      }
    },
  };
}

export function resolvedScope(result, scope = "project") {
  assert.ok(result.data, JSON.stringify(result.findings));
  const value = result.data.scopes.find((entry) => entry.scope === scope);
  assert.ok(value, `missing ${scope} scope: ${JSON.stringify(result)}`);
  return value;
}

export function assertSuccess(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
}

export function assertFailure(result, code) {
  assert.equal(result.schema, 2);
  assert.equal(result.ok, false);
  assert.notEqual(result.exit, 0);
  const finding = result.findings.find(
    (entry) => entry.severity === "error" && (!code || entry.code === code),
  );
  assert.ok(finding, `missing ${code ?? "error"} finding: ${JSON.stringify(result.findings)}`);
  assert.ok(finding.message.length > 0);
  if (finding.path !== undefined) assert.equal(typeof finding.path, "string");
  assert.ok(finding.fix, "failure must explain the corrective action");
}

export function assertOptionalSkip(result) {
  assert.equal(result.schema, 2);
  assert.equal(result.exit, 4, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some(
      (entry) => entry.code === "W_OPTIONAL_SKIPPED" && entry.severity === "warning",
    ),
  );
  assert.ok(result.findings.every((entry) => entry.severity !== "error"));
}
