import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createResolutionFixture } from "./resolution-fixture.mjs";

// This bounded adapter can be tested before the coordinator adds public entrypoint exports.
const compiled = mkdtempSync(join(tmpdir(), "skillex-client-adapter-"));
after(() => rmSync(compiled, { recursive: true, force: true }));
const modulePath = join(compiled, "client-isolation.mjs");
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
await build({
  entryPoints: [new URL("../../src/core/client-isolation.ts", import.meta.url).pathname],
  outfile: modulePath,
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
const { ClientIsolationCommand, isolateClient, unisolateClient, verifyClientIsolation } =
  await import(pathToFileURL(modulePath));

function snapshot(root) {
  const entries = [];
  function visit(path) {
    const info = lstatSync(path);
    entries.push([
      relative(root, path),
      info.ino,
      info.mode,
      info.mtimeMs,
      info.isSymbolicLink()
        ? readlinkSync(path)
        : info.isDirectory()
          ? "directory"
          : readFileSync(path).toString("base64"),
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return entries;
}

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
  f.skill("beta");
  f.skill("global-only");
  f.set("team", ["alpha", "beta"]);
  f.set("smaller", ["alpha"]);
  f.manifest(f.project, { sets: ["team"] });
  f.manifest(f.home, { skills: ["global-only"] });
  const options = {
    client: "opencode",
    project: f.project,
    cwd: f.project,
    home: f.home,
    registryRoot: f.registry,
    stateHome: join(f.root, "state"),
    env: {},
  };
  const config = join(f.project, "opencode.json");
  const records = ["alpha", "beta", "global-only"].map((id) => ({
    id,
    name: id,
    description: `Description for ${id}`,
    path: join(f.registry, "all-skills", id, "SKILL.md"),
    content: "fixture",
    autoinvoke: true,
  }));
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "get" && path === "/api/session/ses_fixture")
      return { data: { id: "ses_fixture", location: { directory: f.project } } };
    if (method === "get" && path.startsWith("/api/skill?")) {
      assert.equal(
        new URL(path, "http://fixture.invalid").searchParams.get("location[directory]"),
        f.project,
      );
      return { location: { directory: f.project }, data: records };
    }
    assert.equal(method, "post");
    assert.equal(path, "/api/session/ses_fixture/permission");
    assert.equal(body.action, "skill");
    assert.equal(body.agent, "build");
    assert.equal(body.resources.length, 1);
    return {
      data: {
        id: `perm_fixture_${calls.length}`,
        effect: ["alpha", "beta"].includes(body.resources[0]) ? "allow" : "deny",
      },
    };
  };
  return { ...f, options, config, calls, request, records };
}

function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result));
  return result.data;
}

async function refusedWithoutWrites(f, options, code, action = isolateClient) {
  const before = snapshot(f.root);
  const result = await action({ ...f.options, ...options });
  assert.equal(result.exit, 3, JSON.stringify(result));
  assert.ok(
    result.findings.some((finding) => finding.code === code),
    JSON.stringify(result),
  );
  assert.deepEqual(snapshot(f.root), before);
}

test("project set preview is immutable; apply is native V2 and no-op preserves all inode/bytes", async (t) => {
  const f = fixture(t);
  const globalConfig = f.file(
    join(f.home, ".config", "opencode", "opencode.json"),
    '{"shell":"/bin/zsh","permissions":[{"action":"shell","resource":"git push *","effect":"ask"}]}\n',
  );
  const before = snapshot(f.root);
  const plan = await new ClientIsolationCommand(f.options).plan();
  assert.deepEqual(plan.members, ["alpha", "beta"]);
  assert.equal(plan.set, "team");
  assert.deepEqual(plan.changes, [{ path: f.config, action: "create" }]);
  const preview = ok(await isolateClient(f.options));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.runtimeVerified, false);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(join(f.root, "state")), false);
  const homeBefore = snapshot(f.home);
  const registryBefore = snapshot(f.registry);
  const apply = ok(await isolateClient({ ...f.options, apply: true }));
  assert.equal(apply.applied, true);
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")), {
    $schema: "https://opencode.ai/config.json",
    permissions: [
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "alpha", effect: "allow" },
      { action: "skill", resource: "beta", effect: "allow" },
    ],
  });
  assert.ok(apply.receipt.startsWith(join(f.root, "state")));
  assert.equal(existsSync(globalConfig), true);
  assert.deepEqual(snapshot(f.home), homeBefore);
  assert.deepEqual(snapshot(f.registry), registryBefore);
  const after = snapshot(f.root);
  const second = ok(await isolateClient({ ...f.options, apply: true }));
  assert.deepEqual(second.changes, []);
  assert.equal(second.applied, false);
  assert.deepEqual(snapshot(f.root), after);
});

test("preserves JSONC siblings/comments and foreign permissions on refresh and unsetting", async (t) => {
  const f = fixture(t);
  const path = join(f.project, ".opencode", "opencode.jsonc");
  f.file(
    path,
    `{
  // Preserve this URL and provider configuration verbatim, without interpreting it.
  "custom": {"url":"https://fixture.invalid//a/*b*/", "number":1e2},
  "permissions": [
    // The user's shell rule stays in place.
    { "action": "shell", "resource": "git push *", "effect": "deny" },
  ],
  "agents": {"build":{"description":"keep", "permissions":[{"action":"edit","resource":"*","effect":"ask"}]}},
}
`,
  );
  chmodSync(path, 0o640);
  ok(await isolateClient({ ...f.options, apply: true }));
  const original = readFileSync(path, "utf8");
  assert.match(original, /"number":1e2/);
  assert.match(original, /\/\/ The user's shell rule stays in place\./);
  assert.equal(lstatSync(path).mode & 0o777, 0o640);
  f.manifest(f.project, { sets: ["smaller"] });
  ok(await isolateClient({ ...f.options, apply: true }));
  const updated = readFileSync(path, "utf8");
  assert.ok(!updated.includes('"resource":"beta"'));
  assert.ok(updated.includes('{ "action": "shell", "resource": "git push *", "effect": "deny" }'));
  assert.ok(
    updated.includes(
      '"agents": {"build":{"description":"keep", "permissions":[{"action":"edit","resource":"*","effect":"ask"}]}}',
    ),
  );
  f.manifest(f.project, { skills: [] });
  const before = snapshot(f.root);
  assert.equal(ok(await unisolateClient(f.options)).dryRun, true);
  assert.deepEqual(snapshot(f.root), before);
  ok(await unisolateClient({ ...f.options, apply: true }));
  const cleaned = readFileSync(path, "utf8");
  assert.ok(!cleaned.includes('"action":"skill"'));
  assert.match(cleaned, /"number":1e2/);
  const after = snapshot(f.root);
  assert.deepEqual(ok(await unisolateClient({ ...f.options, apply: true })).changes, []);
  assert.deepEqual(snapshot(f.root), after);
});

test("removes untouched created config, but preserves later user siblings and permissions", async (t) => {
  const f = fixture(t);
  ok(await isolateClient({ ...f.options, apply: true }));
  ok(await unisolateClient({ ...f.options, apply: true }));
  assert.equal(existsSync(f.config), false);
  ok(await isolateClient({ ...f.options, apply: true }));
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.shell = "/bin/zsh";
  config.permissions.push({ action: "edit", resource: "*", effect: "ask" });
  writeFileSync(f.config, `${JSON.stringify(config, null, 2)}\n`);
  ok(await unisolateClient({ ...f.options, apply: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")), {
    $schema: "https://opencode.ai/config.json",
    shell: "/bin/zsh",
    permissions: [{ action: "edit", resource: "*", effect: "ask" }],
  });
});

test("JSONC removal handles owned property before/after foreign properties", async (t) => {
  for (const original of ['{"shell":"/bin/zsh"}\n', '{"shell":"/bin/zsh",}\n', "{}\n"]) {
    await t.test(original, async (t) => {
      const f = fixture(t);
      f.file(f.config, original);
      ok(await isolateClient({ ...f.options, apply: true }));
      ok(await unisolateClient({ ...f.options, apply: true }));
      assert.ok(existsSync(f.config));
      assert.ok(!readFileSync(f.config, "utf8").includes("permissions"));
      ok(await isolateClient({ ...f.options, apply: true }));
    });
  }
});

test("requires project resolved set, refuses unsupported clients and conflicting flags without writes", async (t) => {
  const f = fixture(t);
  await refusedWithoutWrites(f, { client: "claude" }, "E_CLIENT_UNSUPPORTED");
  f.manifest(f.project, { skills: ["alpha"] });
  await refusedWithoutWrites(f, {}, "E_CLIENT_SET_REQUIRED");
  f.manifest(f.project, { sets: [{ name: "absent", optional: true }] });
  const result = await isolateClient(f.options);
  assert.equal(result.ok, false);
  assert.equal(existsSync(f.config), false);
  assert.equal((await isolateClient({ ...f.options, apply: true, dryRun: true })).exit, 2);
});

test("never appends selected allow over explicit deny or ask, nor overrides foreign skill allows", async (t) => {
  for (const rule of [
    { action: "skill", resource: "alpha", effect: "deny" },
    { action: "skill", resource: "b?ta", effect: "ask" },
    { action: "*", resource: "*", effect: "deny" },
    { action: "skill", resource: "global-only", effect: "allow" },
    { action: "skill", resource: "*", effect: "allow" },
  ])
    await t.test(JSON.stringify(rule), async (t) => {
      const f = fixture(t);
      f.file(f.config, JSON.stringify({ permissions: [rule] }));
      await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_PERMISSION_CONFLICT");
    });
});

test("explicit permission override is previewed, preserves intent, and requires the flag on repeats", async (t) => {
  const f = fixture(t);
  const rule = { action: "skill", resource: "alpha", effect: "deny" };
  f.file(f.config, JSON.stringify({ permissions: [rule], custom: "untouched" }));
  const before = snapshot(f.root);
  const preview = ok(await isolateClient({ ...f.options, overridePermissions: true }));
  assert.deepEqual(preview.overrides, [{ path: f.config, rule: 0 }]);
  assert.deepEqual(snapshot(f.root), before);
  ok(await isolateClient({ ...f.options, apply: true, overridePermissions: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")).permissions[0], rule);
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_PERMISSION_CONFLICT");
  const applied = snapshot(f.root);
  ok(await isolateClient({ ...f.options, apply: true, overridePermissions: true }));
  assert.deepEqual(snapshot(f.root), applied);
  ok(await unisolateClient({ ...f.options, apply: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")), {
    permissions: [rule],
    custom: "untouched",
  });
});

test("owned rules move after later shared overrides only when explicitly authorized", async (t) => {
  const f = fixture(t);
  ok(await isolateClient({ ...f.options, apply: true }));
  const raw = JSON.parse(readFileSync(f.config, "utf8"));
  const foreign = { action: "skill", resource: "alpha", effect: "deny" };
  raw.permissions.push(foreign);
  f.file(f.config, JSON.stringify(raw));
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_PERMISSION_CONFLICT");
  ok(await isolateClient({ ...f.options, apply: true, overridePermissions: true }));
  const current = JSON.parse(readFileSync(f.config, "utf8"));
  assert.deepEqual(current.permissions[0], foreign);
  assert.deepEqual(current.permissions.at(-1), {
    action: "skill",
    resource: "beta",
    effect: "allow",
  });
  ok(await unisolateClient({ ...f.options, apply: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")).permissions, [foreign]);
});

test("unisolate preserves newly inserted comments and works despite unrelated precedence changes", async (t) => {
  const f = fixture(t);
  ok(await isolateClient({ ...f.options, apply: true }));
  const raw = readFileSync(f.config, "utf8").replace(
    '"permissions": [',
    '"permissions": [ // Keep this comment\n',
  );
  f.file(f.config, raw);
  const other = f.file(join(f.project, ".opencode", "opencode.json"), '{"permission":"allow"}');
  const global = f.file(join(f.home, ".config", "opencode", "opencode.json"), "{invalid");
  ok(
    await unisolateClient({
      ...f.options,
      apply: true,
      env: { OPENCODE_CONFIG_CONTENT: "unknown" },
    }),
  );
  assert.ok(readFileSync(f.config, "utf8").includes("// Keep this comment"));
  assert.equal(readFileSync(other, "utf8"), '{"permission":"allow"}');
  assert.equal(readFileSync(global, "utf8"), "{invalid");
});

test("global deny and agent-specific override are conflicts, never global mutations", async (t) => {
  const f = fixture(t);
  const path = join(f.home, ".config", "opencode", "opencode.json");
  f.file(
    path,
    JSON.stringify({ permissions: [{ action: "skill", resource: "alpha", effect: "deny" }] }),
  );
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_PERMISSION_CONFLICT");
  f.file(
    path,
    JSON.stringify({
      agents: { build: { permissions: [{ action: "skill", resource: "*", effect: "allow" }] } },
    }),
  );
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_AGENT_OVERRIDE");
});

test("config precedence, redirected paths, malformed and legacy config are write-free refusals", async (t) => {
  const f = fixture(t);
  f.file(f.config, "{}");
  const override = f.file(join(f.project, ".opencode", "opencode.jsonc"), "{}");
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_CONFIG_PRECEDENCE");
  rmSync(override);
  const ancestor = f.file(
    join(f.root, ".opencode", "opencode.json"),
    '{"permissions":[{"action":"skill","resource":"*","effect":"allow"}]}',
  );
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_CONFIG_PRECEDENCE");
  rmSync(ancestor);
  for (const text of [
    '{"permissions":{}}',
    '{"permissions":[],"permissions":[]}',
    '{"permission":{"skill":"allow"}}',
    "{/*unterminated",
  ]) {
    f.file(f.config, text);
    const before = snapshot(f.root);
    assert.equal((await isolateClient({ ...f.options, apply: true })).exit, 3);
    assert.deepEqual(snapshot(f.root), before);
  }
  rmSync(f.config);
  f.link(f.config, f.file(join(f.root, "outside.json"), "{}"));
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_CONFIG_PATH");
});

test("foreign replacement or duplicated owned block is never deleted or silently adopted", async (t) => {
  const f = fixture(t);
  const applied = ok(await isolateClient({ ...f.options, apply: true }));
  const initial = readFileSync(f.config, "utf8");
  f.file(f.config, initial.replace('"resource":"alpha"', '"resource":"foreign"'));
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_OWNERSHIP_CHANGED", unisolateClient);
  const config = JSON.parse(initial);
  config.permissions.push(...config.permissions);
  f.file(f.config, JSON.stringify(config));
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_OWNERSHIP_CHANGED");
  rmSync(applied.receipt);
  f.file(f.config, initial);
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_PERMISSION_CONFLICT");
});

test("redirected .opencode parent cannot write outside the project", async (t) => {
  const f = fixture(t);
  const outside = f.directory(join(f.root, "outside"));
  f.file(join(outside, "opencode.json"), "{}");
  f.link(join(f.project, ".opencode"), outside);
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_CONFIG_PATH");
});

test("concurrent apply converges on one owned block", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([
    isolateClient({ ...f.options, apply: true }),
    isolateClient({ ...f.options, apply: true }),
  ]);
  for (const result of results) ok(result);
  assert.equal(JSON.parse(readFileSync(f.config, "utf8")).permissions.length, 3);
  const after = snapshot(f.root);
  ok(await isolateClient({ ...f.options, apply: true }));
  assert.deepEqual(snapshot(f.root), after);
});

test("unsafe state location is refused before any lock/config mutation", async (t) => {
  const f = fixture(t);
  await refusedWithoutWrites(
    f,
    { apply: true, stateHome: join(f.project, "state") },
    "E_RECEIPT_UNSAFE_PATH",
  );
});

test("pending state recovers both sides of interrupted atomic publication without deleting foreign content", async (t) => {
  for (const published of [false, true])
    await t.test(String(published), async (t) => {
      const f = fixture(t);
      const applied = ok(await isolateClient({ ...f.options, apply: true }));
      const final = JSON.parse(readFileSync(applied.receipt, "utf8"));
      const text = readFileSync(f.config, "utf8");
      const active = final.data.active;
      final.data.active = null;
      final.data.pending = {
        before: null,
        after: createHash("sha256").update(text).digest("hex"),
        active,
      };
      writeFileSync(applied.receipt, `${JSON.stringify(final)}\n`);
      if (!published) rmSync(f.config);
      const before = snapshot(f.root);
      assert.equal(ok(await isolateClient(f.options)).recovery, true);
      assert.deepEqual(snapshot(f.root), before);
      const inode = published ? lstatSync(f.config).ino : null;
      ok(await isolateClient({ ...f.options, apply: true }));
      if (published) assert.equal(lstatSync(f.config).ino, inode);
      assert.equal(JSON.parse(readFileSync(applied.receipt, "utf8")).data.pending, undefined);
      assert.equal(readFileSync(f.config, "utf8"), text);
      const after = snapshot(f.root);
      ok(await isolateClient({ ...f.options, apply: true }));
      assert.deepEqual(snapshot(f.root), after);
    });
});

test("interrupted ownership refuses an intervening user edit without rewriting receipt or config", async (t) => {
  const f = fixture(t);
  const applied = ok(await isolateClient({ ...f.options, apply: true }));
  const receipt = JSON.parse(readFileSync(applied.receipt, "utf8"));
  receipt.data.pending = {
    before: null,
    after: createHash("sha256").update(readFileSync(f.config)).digest("hex"),
    active: receipt.data.active,
  };
  f.file(applied.receipt, JSON.stringify(receipt));
  f.file(f.config, `${readFileSync(f.config, "utf8")} // intervening edit\n`);
  await refusedWithoutWrites(f, { apply: true }, "E_CLIENT_RECOVERY");
});

test("native probe uses a regular output file so large registry JSON is not pipe-truncated", async (t) => {
  const f = fixture(t);
  const bin = f.directory(join(f.root, "bin"));
  const executable = join(bin, "opencode");
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs';
const [api,method,path,...args]=process.argv.slice(2);
if(!fs.fstatSync(1).isFile())process.exit(2);
const project=${JSON.stringify(f.project)};
const records=${JSON.stringify(f.records)};
for(const row of records)row.content='x'.repeat(250000);
const body=args[0]==='--data'?JSON.parse(args[1]):null;
const result=method==='get'&&path.startsWith('/api/skill?')?{location:{directory:project},data:records}:method==='get'?{data:{id:'ses_fixture',location:{directory:project}}}:{data:{id:'perm_fixture',effect:['alpha','beta'].includes(body.resources[0])?'allow':'deny'}};
fs.writeFileSync(1,JSON.stringify(result));\n`,
  );
  chmodSync(executable, 0o755);
  const result = await verifyClientIsolation({
    ...f.options,
    session: "ses_fixture",
    env: { PATH: bin },
  });
  ok(result);
  assert.equal(result.data.registryCount, 3);
});

test("verify evaluates every registered and selected skill plus unknown ID, not raw discovery", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = ok(
    await verifyClientIsolation({ ...f.options, session: "ses_fixture" }, f.request),
  );
  assert.equal(result.registryCount, 3);
  assert.equal(result.evidence, "opencode-v2-permission-evaluator");
  assert.deepEqual(result.advertised, ["alpha", "beta"]);
  assert.equal(result.checked.length, 4);
  assert.equal(result.checked.find((item) => item.id === "global-only").effect, "deny");
  assert.ok(f.calls.every((call) => call.method === "get" || call.path.endsWith("/permission")));
  assert.deepEqual(snapshot(f.root), before);
});

test("verify catches agent leakage and asks, and reports pending probe IDs without rejecting unrelated requests", async (t) => {
  const f = fixture(t);
  const result = await verifyClientIsolation(
    { ...f.options, session: "ses_fixture" },
    async (...args) => {
      const response = await f.request(...args);
      if (args[0] === "post")
        response.data.effect = args[2].resources[0] === "beta" ? "ask" : "allow";
      return response;
    },
  );
  assert.equal(result.exit, 6);
  assert.ok(result.findings.some((finding) => finding.code === "E_CLIENT_VISIBILITY_LEAK"));
  assert.ok(result.findings.some((finding) => finding.code === "E_CLIENT_PERMISSION_MISMATCH"));
  assert.ok(result.findings.some((finding) => finding.code === "W_CLIENT_PROBE_PENDING"));
  assert.equal(f.calls.filter((call) => call.method === "post").length, 4);
});

test("verify requires caller's exact-location session and does not create, move, or infer", async (t) => {
  const f = fixture(t);
  const missing = await verifyClientIsolation(f.options, f.request);
  assert.equal(missing.exit, 2);
  assert.equal(f.calls.length, 0);
  const wrong = await verifyClientIsolation(
    { ...f.options, session: "ses_fixture" },
    async (...args) => {
      const result = await f.request(...args);
      result.data.location.directory = f.home;
      return result;
    },
  );
  assert.equal(wrong.exit, 3);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "get");
});

test("verify catches canonical shadowing, missing members, and hidden advertisement metadata", async (t) => {
  const f = fixture(t);
  f.records[0].path = f.records[2].path;
  f.records[1].autoinvoke = false;
  let result = await verifyClientIsolation({ ...f.options, session: "ses_fixture" }, f.request);
  assert.equal(result.exit, 6);
  assert.ok(result.findings.some((finding) => finding.code === "E_CLIENT_SKILL_SHADOWED"));
  assert.ok(result.findings.some((finding) => finding.code === "E_CLIENT_NOT_ADVERTISED"));
  f.records.splice(0, 2);
  result = await verifyClientIsolation({ ...f.options, session: "ses_fixture" }, f.request);
  assert.ok(
    result.findings.filter((finding) => finding.code === "E_CLIENT_SKILL_MISSING").length === 2,
  );
});
