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
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const packageName = "@delorenj/skillex";
export const nodeBinary = realpathSync(process.env.SKILLEX_TEST_NODE_BIN ?? process.execPath);

function run(binary, args, options) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${binary} terminated by ${result.signal}`);
  return result;
}

function snapshotTree(root) {
  const entries = [];
  function visit(relative) {
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      entries.push([relative, "link", stat.mtimeMs, readlinkSync(absolute)]);
    } else if (stat.isDirectory()) {
      entries.push([relative, "directory", stat.mode, stat.mtimeMs]);
      for (const name of readdirSync(absolute).sort()) visit(join(relative, name));
    } else {
      entries.push([
        relative,
        "file",
        stat.mode,
        stat.mtimeMs,
        createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      ]);
    }
  }
  visit("");
  return entries;
}

export function createPackageFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillex-package-test-")));
  try {
    const consumer = join(root, "consumer");
    const artifacts = join(root, "artifacts");
    const state = join(root, "state");
    const project = join(state, "project");
    const home = join(state, "home");
    const catalog = join(state, "catalog");
    const runtimeBin = join(root, "runtime-bin");
    const xdg = Object.fromEntries(
      ["CONFIG", "DATA", "STATE", "CACHE"].map((name) => [
        `XDG_${name}_HOME`,
        join(state, `xdg-${name.toLowerCase()}`),
      ]),
    );
    xdg.XDG_RUNTIME_DIR = join(state, "xdg-runtime");
    for (const path of [
      consumer,
      artifacts,
      project,
      home,
      catalog,
      runtimeBin,
      ...Object.values(xdg),
    ]) {
      mkdirSync(path, { recursive: true });
    }
    symlinkSync(nodeBinary, join(runtimeBin, "node"));
    const skill = join(catalog, "all-skills", "preserved-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# Preserved test skill\n");
    for (const scope of [home, project]) {
      for (const agent of [".agents", ".claude", ".codex"]) {
        const activation = join(scope, agent, "skills");
        mkdirSync(activation, { recursive: true });
        symlinkSync(skill, join(activation, "preserved-skill"));
      }
      writeFileSync(join(scope, ".agents", "skills.json"), '{"skills":["preserved-skill"]}\n');
    }

    const userConfig = join(root, "npm-user-config");
    const globalConfig = join(root, "npm-global-config");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const npmEnvironment = {
      PATH: [dirname(nodeBinary), process.env.PATH].filter(Boolean).join(delimiter),
      HOME: join(root, "npm-home"),
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(root, "npm-cache"),
      NO_COLOR: "1",
    };
    const siblingNpm = join(dirname(nodeBinary), "npm");
    const npmBinary = process.env.npm_execpath
      ? nodeBinary
      : existsSync(siblingNpm)
        ? siblingNpm
        : "npm";
    const npmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
    function npm(args, cwd) {
      const result = run(npmBinary, [...npmPrefix, ...args], {
        cwd,
        env: npmEnvironment,
        timeout: 90_000,
      });
      assert.equal(result.status, 0, `npm ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
      return result;
    }
    const packOutput = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], repositoryRoot)
        .stdout,
    );
    const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
    assert.equal(packed.length, 1, "npm pack should produce exactly one package");
    const tarball = join(artifacts, packed[0].filename);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    npm(
      [
        "install",
        tarball,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--loglevel=error",
      ],
      consumer,
    );

    const installedRoot = join(consumer, "node_modules", "@delorenj", "skillex");
    const cli = join(consumer, "node_modules", ".bin", "skillex");
    const environment = {
      PATH: runtimeBin,
      HOME: home,
      ...xdg,
      SKILLEX_REGISTRY_ROOT: catalog,
      PJ_SKILLS_REGISTRY_ROOT: catalog,
      NO_COLOR: "1",
      TERM: "dumb",
    };
    const initialState = snapshotTree(state);
    function runIsolated(binary, args, cwd) {
      try {
        return run(binary, args, { cwd, env: environment });
      } finally {
        assert.deepEqual(
          snapshotTree(state),
          initialState,
          "command changed activation, catalog, or user state",
        );
      }
    }
    return {
      consumer,
      installedRoot,
      cli,
      runtimeBin,
      environment,
      packed: packed[0],
      sourcePackage: JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
      installedPackage: JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")),
      runCli: (args) => runIsolated(cli, args, project),
      runModule: (source) =>
        runIsolated(nodeBinary, ["--input-type=module", "--eval", source], consumer),
      runNode: (args) => runIsolated(nodeBinary, args, consumer),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
