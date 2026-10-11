import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = fileURLToPath(new URL("../../", import.meta.url));

function snapshot(root) {
  const rows = [];
  const walk = (path) => {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.ino,
      info.mode,
      info.mtimeMs,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isFile()
          ? readFileSync(path).toString("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return rows;
}

test("root adopt Commander registration previews/applies before normalization without global manifest resolution", async (t) => {
  // Receipt state cannot be below ~/.claude (a Git checkout on this host).
  const base = mkdtempSync(
    join(process.platform === "linux" ? "/tmp" : tmpdir(), "skillex-root-cli-"),
  );
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const home = join(base, "home");
  const project = join(base, "project");
  const registry = join(base, "registry");
  const root = join(project, ".agents", "skills");
  const state = join(base, "state");
  mkdirSync(root, { recursive: true });
  file(join(home, ".agents", "skills.json"), '{"sets":["general","developer"]}\n');
  file(join(project, ".agents", "skills.json"), "{ not even valid project JSON\n");
  for (const name of ["alpha", "liam-dev"])
    file(join(registry, "all-skills", name, "SKILL.md"), `# ${name}\n`);
  symlinkSync(join(registry, "all-skills", "alpha"), join(root, "alpha"));
  symlinkSync("/missing/liam", join(root, "liam"));
  mkdirSync(join(base, "node_modules", "@delorenj"), { recursive: true });
  symlinkSync(repository, join(base, "node_modules", "@delorenj", "skillex"));
  for (const dependency of Object.keys(
    JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).dependencies,
  ))
    symlinkSync(
      join(repository, "node_modules", dependency),
      join(base, "node_modules", dependency),
    );
  const cli = join(base, "cli.mjs");
  // Only this command is registered: coordinator owns src/cli.ts integration.
  await build({
    stdin: {
      contents: `import {Command} from 'commander';
import {registerRootCommands} from './src/commands/roots.ts';
const program = new Command().name('skillex').option('--json').option('--registry-root <path>').enablePositionalOptions().exitOverride();
const emit = (result,text) => { process.stdout.write(program.opts().json ? JSON.stringify(result)+'\\n' : text ?? ''); process.exitCode=result.exit; };
registerRootCommands(program,{emit,help:(command)=>emit({exit:0,data:{help:command.helpInformation()}},command.helpInformation())});
try { await program.parseAsync(process.argv); } catch(error) { process.stdout.write(JSON.stringify({exit:2,findings:[{code:'E_CLI',message:error.message}]})+'\\n'); process.exitCode=2; }`,
      resolveDir: repository,
      sourcefile: "root-command-fixture.ts",
      loader: "ts",
    },
    outfile: cli,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const invoke = (...args) => {
    const result = spawnSync(
      process.execPath,
      [cli, "--json", "--registry-root", registry, "root", ...args],
      {
        env: { ...process.env, HOME: home, XDG_STATE_HOME: state },
        cwd: project,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    return { status: result.status, result: JSON.parse(result.stdout) };
  };
  assert.match(invoke().result.data.help, /adopt/);
  const before = snapshot(base);
  const missing = invoke("adopt", "--project", project, "--apply");
  assert.equal(missing.status, 3, JSON.stringify(missing));
  assert.ok(missing.result.findings.some((finding) => finding.code === "E_ROOT_MAPPING_REQUIRED"));
  assert.deepEqual(snapshot(base), before);
  const preview = invoke(
    "adopt",
    "--project",
    project,
    "--map",
    "alpha=alpha",
    "--map",
    "liam=liam-dev",
    "--dry-run",
  );
  assert.equal(preview.status, 0, JSON.stringify(preview));
  assert.equal(preview.result.data.dryRun, true);
  assert.deepEqual(snapshot(base), before);
  assert.equal(existsSync(state), false);
  const applied = invoke(
    "adopt",
    "--project",
    project,
    "--map",
    "alpha=alpha",
    "--map",
    "liam=liam-dev",
    "--apply",
  );
  assert.equal(applied.status, 0, JSON.stringify(applied));
  assert.deepEqual(readdirSync(root).sort(), ["alpha", "liam-dev"]);
  assert.equal(readlinkSync(join(applied.result.data.quarantine, "liam")), "/missing/liam");
  assert.equal(
    readFileSync(join(project, ".agents", "skills.json"), "utf8"),
    "{ not even valid project JSON\n",
  );
  assert.equal(
    readFileSync(join(home, ".agents", "skills.json"), "utf8"),
    '{"sets":["general","developer"]}\n',
  );
  const after = snapshot(base);
  const repeated = invoke("adopt", "--project", project, "--apply");
  assert.equal(repeated.status, 0, JSON.stringify(repeated));
  assert.deepEqual(repeated.result.data.changes, []);
  assert.deepEqual(snapshot(base), after);
  assert.equal(invoke("adopt", "--project", project, "--apply", "--dry-run").status, 2);
  assert.equal(invoke("adopt", "--apply").status, 2);
  assert.equal(invoke("adopt", "--project", project, "--global").status, 2);
  const invalidProject = invoke("adopt", "--project", join(base, "project-typo"), "--apply");
  assert.equal(invalidProject.status, 2);
  assert.ok(invalidProject.result.findings.some((finding) => finding.code === "E_PROJECT"));
  assert.deepEqual(snapshot(base), after);

  const replacementProject = join(base, "replacement-project");
  const replacementRoot = join(replacementProject, ".agents", "skills");
  const pack = join(registry, "packs", "bmad", "6.12.1-next.1");
  const members = ["bmad-build", "bmad-help", "bmad-new"];
  file(
    join(pack, "pack.toml"),
    `[pack]\nname="bmad"\nversion="6.12.1-next.1"\n[freeform]\nskills=${JSON.stringify(members)}\n`,
  );
  mkdirSync(join(pack, "skills"), { recursive: true });
  for (const name of members) {
    const canonical = join(registry, "all-skills", name);
    file(join(canonical, "SKILL.md"), `---\nname: ${name}\n---\ncanonical next.1\n`);
    symlinkSync(canonical, join(pack, "skills", name));
  }
  for (const name of ["bmad-build", "bmad-help", "bmad-old-stub"])
    file(join(replacementRoot, name, "SKILL.md"), `---\nname: ${name}\n---\ninstaller next.0\n`);
  symlinkSync(join(registry, "all-skills", "alpha"), join(replacementRoot, "alpha"));
  symlinkSync("/missing/liam", join(replacementRoot, "liam"));
  file(join(replacementProject, "_bmad", "_config", "manifest.yaml"), "version: 6.12.1-next.0\n");
  const replacementArgs = [
    "adopt",
    "--project",
    replacementProject,
    "--map",
    "liam=liam-dev",
    "--replace-pack",
    "bmad@6.12.1-next.1",
    "--replace-prefix",
    "bmad-",
  ];
  const replacementBefore = snapshot(base);
  const originalRoot = snapshot(replacementRoot);
  const unpaired = invoke(
    "adopt",
    "--project",
    replacementProject,
    "--replace-pack",
    "bmad@6.12.1-next.1",
    "--apply",
  );
  assert.equal(unpaired.status, 3, JSON.stringify(unpaired));
  assert.ok(
    unpaired.result.findings.some((finding) => finding.code === "E_ROOT_REPLACEMENT_POLICY"),
  );
  const packPreview = invoke(...replacementArgs, "--dry-run");
  assert.equal(packPreview.status, 0, JSON.stringify(packPreview));
  assert.deepEqual(
    packPreview.result.data.inventory.map((item) => [item.name, item.action]).sort(),
    [
      ["alpha", "adopt"],
      ["bmad-build", "replace"],
      ["bmad-help", "replace"],
      ["bmad-new", "add"],
      ["bmad-old-stub", "retire"],
      ["liam", "map"],
    ],
  );
  const textInvoke = (...args) => {
    const result = spawnSync(
      process.execPath,
      [cli, "--registry-root", registry, "root", ...args],
      {
        env: { ...process.env, HOME: home, XDG_STATE_HOME: state },
        cwd: project,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const textPreview = textInvoke(...replacementArgs, "--dry-run");
  for (const action of [
    "replace: bmad-build",
    "retire: bmad-old-stub",
    "add: bmad-new",
    "map: liam",
  ])
    assert.ok(textPreview.includes(action));
  assert.match(textPreview, /authored originals, not disposable state/);
  assert.deepEqual(snapshot(base), replacementBefore);
  const packApplied = invoke(...replacementArgs, "--apply");
  assert.equal(packApplied.status, 0, JSON.stringify(packApplied));
  assert.equal(packApplied.result.data.archiveStatus, "verified");
  assert.deepEqual(snapshot(packApplied.result.data.quarantine), originalRoot);
  assert.deepEqual(readdirSync(replacementRoot).sort(), ["alpha", ...members, "liam-dev"]);
  assert.equal(
    readFileSync(join(replacementProject, "_bmad", "_config", "manifest.yaml"), "utf8"),
    "version: 6.12.1-next.0\n",
  );
  renameSync(packApplied.result.data.quarantine, join(base, "operator-kept-original"));
  const missingBefore = snapshot(base);
  const archiveMissing = invoke(...replacementArgs, "--apply");
  assert.equal(archiveMissing.status, 0, JSON.stringify(archiveMissing));
  assert.equal(archiveMissing.result.data.archiveStatus, "missing");
  assert.deepEqual(archiveMissing.result.data.changes, []);
  assert.ok(
    archiveMissing.result.findings.some((finding) => finding.code === "W_ROOT_ARCHIVE_MISSING"),
  );
  const textMissing = textInvoke(...replacementArgs, "--apply");
  assert.match(textMissing, /original archive MISSING/);
  assert.match(textMissing, /original preservation is NOT verified/);
  assert.doesNotMatch(
    textMissing,
    /Original root preserved at|Original root verified at|authored differences are retained/,
  );
  assert.deepEqual(snapshot(base), missingBefore);
});
