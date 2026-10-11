import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { build } from "esbuild";
import { createResolutionFixture } from "./resolution-fixture.mjs";

const compiled = mkdtempSync(join(tmpdir(), "skillex-clients-cli-"));
after(() => rmSync(compiled, { recursive: true, force: true }));
const cli = join(compiled, "cli.mjs");
writeFileSync(
  join(compiled, "package.json"),
  JSON.stringify({
    name: "@delorenj/skillex",
    type: "module",
    exports: { "./schemas/skills.schema.json": "./skills.schema.json" },
  }),
);
symlinkSync(
  new URL("../../skills.schema.json", import.meta.url),
  join(compiled, "skills.schema.json"),
);
// Exercise the real command module in isolation; the coordinator owns src/cli.ts registration.
await build({
  stdin: {
    resolveDir: new URL("../../", import.meta.url).pathname,
    contents: `import { Command } from "commander";
import { registerClientCommands } from "./src/commands/clients.ts";
const program = new Command().name("skillex").option("--json").option("--registry-root <path>");
registerClientCommands(program, {
  emit(result, text) { console.log(program.opts().json ? JSON.stringify(result) : text); process.exitCode = result.exit; },
  help(command) { command.outputHelp(); },
});
await program.parseAsync(process.argv);`,
  },
  outfile: cli,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "external-packages",
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: import.meta.resolve(args.path),
          external: true,
        }));
      },
    },
  ],
});

function fixture(t) {
  // Receipt state cannot live under a checkout; this host's TMPDIR can be ~/.claude.
  const previous = process.env.TMPDIR;
  let f;
  try {
    process.env.TMPDIR = "/tmp";
    f = createResolutionFixture(t, () => {});
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  f.skill("alpha");
  f.skill("global-only");
  f.set("team", ["alpha"]);
  f.manifest(f.project, { sets: ["team"] });
  const bin = f.directory(join(f.root, "bin"));
  const calls = join(f.root, "api-calls.jsonl");
  const opencode = f.file(
    join(bin, "opencode"),
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_API_CALLS, JSON.stringify(args) + '\\n');
if (args[0] !== 'api') throw Error('only api permitted');
const [, method, path] = args;
const project = process.env.TEST_PROJECT;
if (method === 'get' && path === '/api/session/ses_probe') {
  console.log(JSON.stringify({data:{id:'ses_probe',location:{directory:project}}}));
} else if (method === 'get' && path.startsWith('/api/skill?')) {
  if (new URL(path,'http://fixture.invalid').searchParams.get('location[directory]') !== project) throw Error('wrong deepObject location');
  console.log(JSON.stringify({location:{directory:project},data:[
    {id:'alpha',path:process.env.TEST_CANONICAL,description:'Selected skill'},
    {id:'global-only',path:'/unused/global/SKILL.md',description:'Global skill'}
  ]}));
} else if (method === 'post' && path === '/api/session/ses_probe/permission' && args[3] === '--data') {
  const body = JSON.parse(args[4]);
  if (body.action !== 'skill' || body.agent !== 'build' || body.resources.length !== 1) throw Error('bad permission request');
  const effect = body.resources[0] === 'alpha' || process.env.TEST_LEAK === '1' ? 'allow' : 'deny';
  console.log(JSON.stringify({data:{id:'perm_probe',effect}}));
} else throw Error('forbidden endpoint: ' + JSON.stringify(args));
`,
  );
  chmodSync(opencode, 0o755);
  const env = {
    PATH: bin,
    HOME: f.home,
    XDG_STATE_HOME: join(f.root, "state"),
    XDG_CONFIG_HOME: join(f.home, ".config"),
    TEST_API_CALLS: calls,
    TEST_PROJECT: f.project,
    TEST_CANONICAL: join(f.registry, "all-skills", "alpha", "SKILL.md"),
  };
  const invoke = (command, args = [], extraEnv = {}) => {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--json",
        "--registry-root",
        f.registry,
        "clients",
        command,
        "--client",
        "opencode",
        "--project",
        f.project,
        ...args,
      ],
      { cwd: f.project, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000 },
    );
    assert.ifError(result.error);
    return { ...result, parsed: result.stdout ? JSON.parse(result.stdout) : null };
  };
  return { ...f, invoke, env, calls, config: join(f.project, "opencode.json") };
}

test("CLI defaults to immutable preview; apply/no-op/cleanup preserve global roots", async (t) => {
  const f = fixture(t);
  const globalManifest = readFileSync(join(f.home, ".agents", "skills.json"));
  const preview = f.invoke("isolate");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(preview.parsed.command, "clients.isolate");
  assert.equal(preview.parsed.data.dryRun, true);
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(join(f.root, "state")), false);
  assert.equal(existsSync(f.calls), false);
  const first = f.invoke("isolate", ["--apply"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const config = readFileSync(f.config, "utf8");
  const inode = lstatSync(f.config).ino;
  const receiptInode = lstatSync(first.parsed.data.receipt).ino;
  const repeat = f.invoke("isolate", ["--apply"]);
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.deepEqual(repeat.parsed.data.changes, []);
  assert.equal(readFileSync(f.config, "utf8"), config);
  assert.equal(lstatSync(f.config).ino, inode);
  assert.equal(lstatSync(first.parsed.data.receipt).ino, receiptInode);
  assert.deepEqual(readFileSync(join(f.home, ".agents", "skills.json")), globalManifest);
  f.manifest(f.project, { skills: [] });
  assert.equal(f.invoke("unisolate").parsed.data.dryRun, true);
  assert.equal(existsSync(f.config), true);
  assert.equal(f.invoke("unisolate", ["--apply"]).status, 0);
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(f.calls), false, "plan/apply/cleanup must never run the client");
});

test("CLI verify uses explicit existing session and real permission transport, including leakage exit", (t) => {
  const f = fixture(t);
  const missing = f.invoke("verify");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /session/);
  assert.equal(existsSync(f.calls), false);
  const verified = f.invoke("verify", ["--session", "ses_probe", "--agent", "build"]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.deepEqual(verified.parsed.data.advertised, ["alpha"]);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(([, method, path]) => method === "get" || path.endsWith("/permission")));
  assert.ok(calls.some((call) => call[2].includes("location%5Bdirectory%5D=")));
  const leakage = f.invoke("verify", ["--session", "ses_probe"], { TEST_LEAK: "1" });
  assert.equal(leakage.status, 6, leakage.stdout + leakage.stderr);
  assert.ok(leakage.parsed.findings.some((finding) => finding.code === "E_CLIENT_VISIBILITY_LEAK"));
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(join(f.root, "state")), false);
});

test("CLI reports conflicting modes, unsupported clients, and missing project options", (t) => {
  const f = fixture(t);
  assert.equal(f.invoke("isolate", ["--apply", "--dry-run"]).status, 2);
  const unsupported = f.invoke("isolate", ["--client", "codex"]);
  assert.equal(unsupported.status, 3);
  assert.equal(unsupported.parsed.findings[0].code, "E_CLIENT_UNSUPPORTED");
  const missing = spawnSync(process.execPath, [cli, "clients", "isolate", "--client", "opencode"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /project/);
  assert.equal(existsSync(f.config), false);
});
