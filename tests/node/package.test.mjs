import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPackageFixture, packageName, repositoryRoot } from "./package-fixture.mjs";

describe("published Node package", () => {
  let fixture;
  before(() => {
    fixture = createPackageFixture();
  });
  after(() => {
    fixture?.cleanup();
  });

  it("ships the ESM runtime, declarations and schemas without source or runtime state", () => {
    const metadata = fixture.installedPackage;
    assert.equal(metadata.name, packageName);
    assert.equal(metadata.version, fixture.sourcePackage.version);
    assert.equal(metadata.type, "module");
    assert.equal(metadata.engines.node, ">=24");
    assert.equal(metadata.bin.skillex, "dist/cli.js");
    assert.equal(metadata.main, "dist/index.js");
    assert.equal(metadata.types, "dist/index.d.ts");

    const paths = fixture.packed.files.map(({ path }) => path);
    for (const required of [
      "package.json",
      "dist/cli.js",
      "dist/index.js",
      "dist/index.d.ts",
      "skills.schema.json",
      "schemas/result.schema.json",
    ])
      assert.ok(paths.includes(required), `package is missing ${required}`);
    for (const path of paths) {
      assert.match(
        path,
        /^(?:dist\/|schemas\/result\.schema\.json$|skills\.schema\.json$|package\.json$|(?:README|LICENSE|LICENCE|CHANGELOG|NOTICE)(?:\.[^/]+)?$|docs\/)/i,
      );
      assert.doesNotMatch(
        path,
        /(?:^|\/)(?:all-skills|packs|sets|node_modules|__pycache__|\.venv|\.git|\.agents|\.claude|\.codex|\.codegraph|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache)(?:\/|$)/,
      );
      assert.doesNotMatch(
        path,
        /(?:^|\/)(?:\.env(?:\.[^/]*)?|uv\.lock|pyproject\.toml|SKILL\.md)$|\.(?:py|pyc|bak|log|pid|sock|db-wal|db-shm)$/i,
      );
    }
    assert.equal(realpathSync(fixture.cli), join(fixture.installedRoot, "dist", "cli.js"));
    assert.ok(statSync(fixture.cli).mode & 0o111, "installed bin must be executable");
    assert.match(readFileSync(fixture.cli, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
  });

  it("isolates the installed executable from Python and uv", () => {
    assert.deepEqual(readdirSync(fixture.runtimeBin), ["node"]);
    for (const command of ["python", "python3", "uv"]) {
      const result = spawnSync(command, ["--version"], {
        env: fixture.environment,
        encoding: "utf8",
      });
      assert.equal(
        result.error?.code,
        "ENOENT",
        `${command} must be unavailable in the CLI environment`,
      );
    }
  });

  for (const args of [[], ["--help"]]) {
    it(`prints usable help for ${JSON.stringify(args)}`, () => {
      const result = fixture.runCli(args);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Usage:.*skillex/i);
      for (const option of ["--help", "--version", "--json"])
        assert.ok(result.stdout.includes(option));
    });
  }

  it("prints the installed package version", () => {
    const result = fixture.runCli(["--version"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), fixture.installedPackage.version);
  });

  function envelopeFor(args, command, exit) {
    const result = fixture.runCli(args);
    assert.equal(result.status, exit);
    assert.equal(result.stderr, "", "JSON commands must reserve diagnostics for the envelope");
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(envelope).sort(), [
      "command",
      "data",
      "exit",
      "findings",
      "ok",
      "schema",
    ]);
    assert.equal(envelope.schema, 2);
    assert.equal(envelope.command, command);
    assert.equal(envelope.ok, exit === 0);
    assert.equal(envelope.exit, exit);
    assert.ok(Array.isArray(envelope.findings));
    return envelope;
  }

  for (const args of [["--json"], ["--json", "--help"], ["--help", "--json"]]) {
    it(`returns one help envelope for ${JSON.stringify(args)}`, () => {
      const envelope = envelopeFor(args, "help", 0);
      assert.match(envelope.data.help, /Usage:.*skillex/i);
      assert.deepEqual(envelope.findings, []);
    });
  }

  for (const args of [
    ["--json", "--version"],
    ["--version", "--json"],
  ]) {
    it(`returns one version envelope for ${JSON.stringify(args)}`, () => {
      const envelope = envelopeFor(args, "version", 0);
      assert.deepEqual(envelope.data, { version: fixture.installedPackage.version });
      assert.deepEqual(envelope.findings, []);
    });
  }

  for (const args of [["unknown-command"], ["--unknown-option"], ["--json=invalid"]]) {
    it(`reports invalid arguments with usage exit 2 for ${JSON.stringify(args)}`, () => {
      const result = fixture.runCli(args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /E_USAGE/);
      assert.equal(result.stdout, "");
    });
  }

  for (const args of [
    ["--json", "unknown-command"],
    ["unknown-command", "--json"],
    ["--json", "--unknown-option"],
    ["--unknown-option", "--json"],
  ]) {
    it(`reports a usage error envelope for ${JSON.stringify(args)}`, () => {
      const envelope = envelopeFor(args, "cli", 2);
      assert.ok(
        envelope.findings.some(
          (finding) => finding.code === "E_USAGE" && finding.severity === "error",
        ),
      );
      assert.ok(
        envelope.findings.every(
          (finding) => typeof finding.message === "string" && finding.message.length > 0,
        ),
      );
    });
  }

  it("imports the installed core without launching the CLI or printing", () => {
    const result = fixture.runModule(`await import('${packageName}');`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("exports the result contract and enforces successful-result invariants", () => {
    const result = fixture.runModule(`
      import assert from 'node:assert/strict';
      import { ExitCode, JSON_SCHEMA_VERSION, VERSION, makeResult } from '${packageName}';
      assert.deepEqual(ExitCode, {
        SUCCESS: 0, FAILURE: 1, CONFIG: 2, REFUSED: 3, PARTIAL: 4,
        LOCK_BUSY: 5, DRIFT: 6, INTERRUPTED: 130,
      });
      assert.equal(JSON_SCHEMA_VERSION, 2);
      assert.equal(VERSION, ${JSON.stringify(fixture.installedPackage.version)});
      assert.deepEqual(makeResult('version', { version: VERSION }), {
        schema: 2, command: 'version', ok: true, exit: 0,
        data: { version: VERSION }, findings: [],
      });
      const error = { code: 'E_EXAMPLE', severity: 'error', message: 'Example failure' };
      for (const exit of [1, 2, 3, 4, 5, 6, 130]) {
        const envelope = makeResult('example', null, { exit, findings: [error] });
        assert.equal(envelope.ok, false);
        assert.equal(envelope.exit, exit);
        assert.deepEqual(envelope.findings, [error]);
      }
      const warning = { code: 'W_EXAMPLE', severity: 'warning', message: 'Example warning' };
      assert.equal(makeResult('example', null, { findings: [warning] }).ok, true);
      assert.throws(() => makeResult('example', null, { findings: [error] }), TypeError);
      assert.throws(() => makeResult('example', null, { exit: ExitCode.SUCCESS, findings: [error] }), TypeError);
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("exports both packaged JSON schemas", () => {
    const result = fixture.runModule(`
      import assert from 'node:assert/strict';
      import resultSchema from '${packageName}/schemas/result.schema.json' with { type: 'json' };
      import skillsSchema from '${packageName}/schemas/skills.schema.json' with { type: 'json' };
      assert.equal(resultSchema.type, 'object');
      assert.equal(resultSchema.properties.schema.const, 2);
      for (const field of ['schema', 'command', 'ok', 'exit', 'data', 'findings']) {
        assert.ok(resultSchema.required.includes(field));
      }
      assert.equal(skillsSchema.type, 'object');
      assert.ok(skillsSchema.properties.skills);
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("provides usable public declarations to an isolated TypeScript consumer", () => {
    const consumerFile = join(fixture.consumer, "consumer.mts");
    writeFileSync(
      consumerFile,
      `
      import {
        ExitCode, JSON_SCHEMA_VERSION, VERSION, makeResult,
        type Diagnostic, type ResultEnvelope,
      } from '${packageName}';
      const diagnostic: Diagnostic = {
        code: 'E_EXAMPLE', severity: 'error', message: 'Example failure',
        path: '/example', fix: 'Correct the example', scope: 'project',
        name: 'example', detail: ['More context'],
      };
      const result: ResultEnvelope<{ version: string }> = makeResult('version', { version: VERSION });
      const schema: 2 = JSON_SCHEMA_VERSION;
      const success: 0 = ExitCode.SUCCESS;
      const findings: readonly Diagnostic[] = result.findings;
      const version: string = result.data.version;
      makeResult('example', null, { exit: ExitCode.CONFIG, findings: [diagnostic] });
      // @ts-expect-error Public result types must preserve the data payload shape.
      result.data.missing;
      // @ts-expect-error Diagnostic severity is a fixed vocabulary.
      const invalidSeverity: Diagnostic = { code: 'E_EXAMPLE', severity: 'fatal', message: 'Example' };
      // @ts-expect-error Finding codes require a severity prefix.
      const invalidCode: Diagnostic = { code: 'EXAMPLE', severity: 'error', message: 'Example' };
    `,
    );
    const result = fixture.runNode([
      join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      consumerFile,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
  });
});
