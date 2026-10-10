import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPackageFixture } from "./package-fixture.mjs";

test("retire-mise CLI previews, applies, converges, and rejects conflicting scope", (t) => {
  const root = mkdtempSync(join(tmpdir(), "skillex-integration-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project);
  const path = join(project, "mise.toml");
  writeFileSync(
    path,
    '[tasks."skills:sync"]\nrun = "skillex sync"\n[tasks.test]\nrun = "npm test"\n',
  );
  const installed = createPackageFixture();
  t.after(installed.cleanup);
  const cli = installed.cli;
  const env = { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state") };
  const invoke = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "--json", "integrations", "retire-mise", ...args], {
        cwd: project,
        env,
        encoding: "utf8",
      }),
    );
  const original = readFileSync(path, "utf8");
  const preview = invoke("--project", project);
  assert.equal(preview.data.dryRun, true);
  assert.deepEqual(preview.data.changes[0].tasks, ["skills:sync"]);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(invoke("--project", project, "--apply").ok, true);
  assert.equal(readFileSync(path, "utf8"), '[tasks.test]\nrun = "npm test"\n');
  assert.deepEqual(invoke("--project", project).data.changes, []);
  try {
    invoke("-g", "--project", project);
    assert.fail("expected refusal");
  } catch (error) {
    assert.equal(error.status, 2);
    assert.equal(JSON.parse(error.stdout).findings[0].code, "E_SCOPE");
  }
});
