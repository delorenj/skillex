import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
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

export function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function write(path, content) {
  directory(dirname(path));
  writeFileSync(path, content);
  return path;
}

export function link(path, target) {
  directory(dirname(path));
  symlinkSync(relative(dirname(path), target), path);
  return path;
}

export function manifest(root, value) {
  return write(join(root, ".agents", "skills.json"), `${JSON.stringify(value, null, 2)}\n`);
}

export function identity(path) {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

export function snapshot(root) {
  try {
    lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    const id = [stat.mode, stat.ino, stat.dev, stat.mtimeMs];
    const name = relative(root, path);
    if (stat.isSymbolicLink()) entries.push([name, "link", ...id, readlinkSync(path)]);
    else if (stat.isDirectory()) {
      entries.push([name, "directory", ...id]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else
      entries.push([
        name,
        "file",
        ...id,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
  }
  visit(root);
  return entries;
}

export function unchanged(root, action) {
  const before = snapshot(root);
  try {
    return action();
  } finally {
    assert.deepEqual(snapshot(root), before, "read, preview, or refusal changed fixture state");
  }
}

export function protectedSnapshot(world) {
  return {
    content: snapshot(world.root)
      .filter(([name]) => name !== "state" && !name.startsWith("state/"))
      .map((row) => (row[0] === "" ? row.slice(0, -1) : row)),
    receipts: snapshot(world.receipts),
  };
}

export function parsed(result, command, exit = 0) {
  assert.equal(result.status, exit, result.stdout + result.stderr);
  assert.equal(result.stderr, "", "JSON diagnostics must stay inside the envelope");
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "command",
    "data",
    "exit",
    "findings",
    "ok",
    "schema",
  ]);
  assert.equal(value.schema, 2);
  assert.equal(value.command, command);
  assert.equal(value.exit, exit);
  assert.equal(value.ok, exit === 0);
  assert.ok(Array.isArray(value.findings));
  if (exit === 0) assert.ok(value.findings.every(({ severity }) => severity !== "error"));
  return value;
}

export function finding(result, code) {
  const value = result.findings.find((entry) => entry.code === code);
  assert.ok(value, `missing ${code}: ${JSON.stringify(result.findings)}`);
  assert.ok(value.message.length > 0);
  return value;
}

export function assertLinks(world, names, skillsRoot = world.skillsRoot) {
  for (const name of names) {
    const path = join(skillsRoot, name);
    assert.equal(lstatSync(path).isSymbolicLink(), true, `${name} must remain a reference`);
    assert.equal(realpathSync(path), realpathSync(join(world.registry, "all-skills", name)));
  }
}

export function createProfileWorld(context, fixture) {
  // The user's TMPDIR may live inside a Git checkout; receipt state must not.
  const root = realpathSync(mkdtempSync("/tmp/skillex-profile-cli-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = directory(join(root, "home"));
  const project = directory(join(root, "project-a"));
  const otherProject = directory(join(root, "project-b"));
  const cwd = directory(join(otherProject, "src", "nested"));
  const registry = directory(join(root, "registry"));
  const hermesRoot = directory(join(home, ".hermes"));
  const profile = directory(join(hermesRoot, "profiles", "builder"));
  const skillsRoot = directory(join(profile, "skills"));
  const state = join(root, "state");
  directory(join(hermesRoot, "skills"));
  for (const path of [project, otherProject]) directory(join(path, ".git"));
  for (const child of ["all-skills", "sets", "packs"]) directory(join(registry, child));
  for (const name of ["alpha", "beta", "gamma", "shared"]) {
    const path = join(registry, "all-skills", name);
    write(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Canonical profile fixture\n---\n\n# ${name}\n`,
    );
    write(join(path, "references", "guide.md"), `Canonical support content for ${name}.\n`);
    chmodSync(write(join(path, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n"), 0o755);
  }
  manifest(home, { skills: ["alpha"] });
  manifest(project, { inherit_global: false, skills: ["beta"] });
  manifest(otherProject, { inherit_global: false, skills: ["gamma"] });
  const environment = {
    PATH: fixture.runtimeBin,
    HOME: home,
    HERMES_HOME: hermesRoot,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    NO_COLOR: "1",
    TERM: "dumb",
  };
  function module(source) {
    const result = fixture.runModule(source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  function run(args, options = {}) {
    return JSON.parse(
      module(
        [
          "import assert from 'node:assert/strict';",
          "import { spawnSync } from 'node:child_process';",
          "const result = spawnSync(" +
            JSON.stringify(fixture.cli) +
            ", " +
            JSON.stringify(args) +
            ", " +
            JSON.stringify({
              cwd: options.cwd ?? cwd,
              env: { ...environment, ...options.environment },
              encoding: "utf8",
              timeout: 20_000,
              maxBuffer: 2 * 1024 * 1024,
            }) +
            ");",
          "assert.ifError(result.error);",
          "assert.equal(result.signal, null);",
          "process.stdout.write(JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr}));",
        ].join("\n"),
      ),
    );
  }
  function argsFor(args, options = {}) {
    const shared = ["--json"];
    if (options.registryRoot !== null)
      shared.push("--registry-root", options.registryRoot ?? registry);
    const hermes =
      options.hermesRoot === null ? [] : ["--hermes-root", options.hermesRoot ?? hermesRoot];
    if (options.placement === "root") return [...shared, "profile", ...hermes, ...args];
    if (options.placement === "family") return ["profile", ...shared, ...hermes, ...args];
    return ["profile", ...args, ...shared, ...hermes];
  }
  return {
    root,
    home,
    project,
    otherProject,
    cwd,
    registry,
    hermesRoot,
    profile,
    skillsRoot,
    state,
    receipts: join(state, "skillex", "profiles", "v2"),
    environment,
    module,
    run,
    argsFor,
    json(args, options = {}) {
      return parsed(run(argsFor(args, options), options), `profile ${args[0]}`, options.exit ?? 0);
    },
    sync(options = {}) {
      return this.json(["sync", "builder", "--project", project], options);
    },
    set(name, members) {
      const path = directory(join(registry, "sets", name));
      for (const member of members) link(join(path, member), join(registry, "all-skills", member));
      return path;
    },
    pack(name, version, members, materialize = true) {
      const path = join(registry, "packs", name, version);
      write(
        join(path, "pack.toml"),
        "[pack]\nname = " +
          JSON.stringify(name) +
          "\nversion = " +
          JSON.stringify(version) +
          "\n\n[freeform]\nskills = " +
          JSON.stringify(members) +
          "\n",
      );
      write(join(path, "references", "guide.md"), "Preserved pack support.\n");
      if (materialize) {
        directory(join(path, "skills"));
        for (const member of members)
          link(join(path, "skills", member), join(registry, "all-skills", member));
      }
      return path;
    },
  };
}
