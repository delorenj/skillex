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

  it("resolves canonical selections through the installed core without Python", () => {
    const result = fixture.runModule(`
      import assert from 'node:assert/strict';
      import { discoverRegistry, parseManifest, resolveSelection, SkillexError } from '${packageName}';
      const manifest = parseManifest({ skills: ['preserved-skill'] }, '/example/skills.json');
      assert.equal(manifest.inheritGlobal, true);
      assert.deepEqual(manifest.skills, [{ name: 'preserved-skill' }]);
      assert.throws(() => parseManifest({ flatten: true }, '/example/skills.json'), SkillexError);
      const result = await resolveSelection({ scope: 'global' });
      assert.equal(result.exit, 0, JSON.stringify(result.findings));
      assert.equal(result.data.scopes[0].bindings[0].name, 'preserved-skill');
      assert.equal(result.data.scopes[0].registry.source, 'environment');
      // An npm install has no catalog. With explicit discovery inputs and no
      // override, it must report that absence rather than claim package assets.
      await assert.rejects(
        discoverRegistry({ home: process.env.HOME, cwd: process.cwd(), env: {} }),
        (error) => error instanceof SkillexError && error.findings[0].code === 'E_REGISTRY_NOT_FOUND',
      );
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
        discoverRegistry, parseManifest, resolveSelection,
        createSkill, importSkill, listSkills, showSkill,
        createSet, addSetSkills, removeSetSkills, listSets, showSet,
        createPack, addPackSkills, removePackSkills, listPacks, showPack, verifyPack,
        withLock, type LockOptions, type CompositionDetails,
        planSync, sync, type SyncOptions, type SyncPlan, type SyncResult,
        readActivationReceipt, writeActivationReceipt, type ReceiptSnapshot,
        aliasPaths, GLOBAL_CLI_ALIASES, PROJECT_CLI_ALIASES,
        initScope, enableSelection, disableSelection, setInheritance,
        type SelectionOptions, type SelectionResult, type SelectionChange,
        readSelectionManifest, writeSelectionManifest, type SelectionManifestSnapshot,
        validateActivationStateLocation,
        inspectStatus, explainSkill, doctor,
        type DiagnosticOptions, type StatusResult, type ExplainResult,
        type DoctorOptions, type DoctorResult,
        listVendorSources, showVendorSource, inspectVendorStatus, syncVendorSources,
        type VendorOptions, type VendorSyncOptions, type VendorSourceListResult,
        type VendorSourceShowResult, type VendorStatusResult, type VendorSyncResult,
        listProfiles, showProfile, syncProfile,
        type ProfileOptions, type ProfileSyncOptions, type ProfileListResult,
        type ProfileShowResult, type ProfileSyncResult, type ProfileLocation,
        type ProfileCandidate, type ProfileLocalEntry, type ProfileChange,
        type Diagnostic, type ResultEnvelope, type Resolution, type ResolveOptions,
        type SkillListData, type SkillShowData,
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
      const options: ResolveOptions = { scope: 'project', registryRoot: '/catalog', env: {} };
      const resolution: Promise<ResultEnvelope<Resolution | null>> = resolveSelection(options);
      const manifest = parseManifest({ skills: ['example'] }, '/example/skills.json');
      const names: readonly { name: string }[] = manifest.skills;
      const discovery = discoverRegistry(options);
      const catalog: Promise<ResultEnvelope<SkillListData | null>> = listSkills({ registryRoot: '/catalog', query: 'example' });
      const detail: Promise<ResultEnvelope<SkillShowData | null>> = showSkill('example', { registryRoot: '/catalog' });
      createSkill('example', { registryRoot: '/catalog', dryRun: true, description: 'Example skill.' });
      importSkill('/source/example', 'imported-example', { registryRoot: '/catalog', dryRun: true });
      createSet('example', { registryRoot: '/catalog', dryRun: true });
      addSetSkills('example', ['one'], { registryRoot: '/catalog', dryRun: true });
      removeSetSkills('example', ['one'], { registryRoot: '/catalog', dryRun: true });
      listSets({ registryRoot: '/catalog' });
      showSet('example', { registryRoot: '/catalog' });
      createPack('example', '1.0.0', { registryRoot: '/catalog', dryRun: true, description: 'Example pack' });
      addPackSkills('example@1.0.0', ['one'], { registryRoot: '/catalog', dryRun: true });
      removePackSkills('example@1.0.0', ['one'], { registryRoot: '/catalog', dryRun: true });
      listPacks({ registryRoot: '/catalog' });
      showPack('example@1.0.0', { registryRoot: '/catalog' });
      verifyPack('example@1.0.0', { registryRoot: '/catalog' });
      const composition: CompositionDetails = { kind: 'set', name: 'example', path: '/catalog/sets/example', skills: [] };
      const lockOptions: LockOptions = { stateHome: '/state', timeoutMs: 200, env: {} };
      const locked: Promise<{ value: number }> = withLock('resource', async () => ({ value: 42 }), lockOptions);
      const syncOptions: SyncOptions = { scope: 'both', registryRoot: '/catalog', home: '/home/example', project: '/project', stateHome: '/state', dryRun: true, exitCode: true, signal: { aborted: false } };
      const preview: Promise<ResultEnvelope<SyncPlan | null>> = planSync(syncOptions);
      const activation: Promise<ResultEnvelope<SyncResult | null>> = sync(syncOptions);
      const receipt: Promise<ReceiptSnapshot<{ generation: number }>> = readActivationReceipt('/project', { stateHome: '/state' });
      receipt.then(snapshot => writeActivationReceipt(snapshot, { generation: 1 }, { stateHome: '/state' }));
      const aliases: readonly string[] = aliasPaths('/project', 'project');
      const globalAliases: readonly string[] = GLOBAL_CLI_ALIASES;
      const projectAliases: readonly string[] = PROJECT_CLI_ALIASES;
      const selectionOptions: SelectionOptions = { scope: 'project', project: '/project', registryRoot: '/catalog', stateHome: '/state', dryRun: true, signal: { aborted: false } };
      const initialization: Promise<ResultEnvelope<SelectionResult | null>> = initScope(selectionOptions);
      const enabled: Promise<ResultEnvelope<SelectionResult | null>> = enableSelection('skill', 'example', selectionOptions);
      disableSelection('set', 'example', selectionOptions);
      setInheritance(false, selectionOptions);
      const selectionChange: SelectionChange = { scope: 'project', action: 'write-manifest', path: '/project/.agents/skills.json' };
      const declaration: Promise<SelectionManifestSnapshot> = readSelectionManifest('/project');
      declaration.then(snapshot => writeSelectionManifest(snapshot, { scope: 'project', inherit_global: true }));
      const stateLocation: Promise<void> = validateActivationStateLocation('/project', { stateHome: '/state' });
      const diagnosticOptions: DiagnosticOptions = { scope: 'both', project: '/project', registryRoot: '/catalog', stateHome: '/state', signal: { aborted: false } };
      const status: Promise<ResultEnvelope<StatusResult | null>> = inspectStatus(diagnosticOptions);
      const explanation: Promise<ResultEnvelope<ExplainResult | null>> = explainSkill('example', diagnosticOptions);
      const doctorOptions: DoctorOptions = { ...diagnosticOptions, sourcesOnly: true, processSnapshot: async () => '' };
      const health: Promise<ResultEnvelope<DoctorResult | null>> = doctor(doctorOptions);
      const vendorOptions: VendorOptions = { registryRoot: '/catalog', sources: ['upstream'], checkouts: { 'repo-id': '/checkout' }, upstream: false, signal: { aborted: false } };
      const vendorList: Promise<ResultEnvelope<VendorSourceListResult | null>> = listVendorSources(vendorOptions);
      const vendorSource: Promise<ResultEnvelope<VendorSourceShowResult | null>> = showVendorSource('upstream', vendorOptions);
      const vendorStatus: Promise<ResultEnvelope<VendorStatusResult | null>> = inspectVendorStatus(vendorOptions);
      const vendorSyncOptions: VendorSyncOptions = { ...vendorOptions, stateHome: '/state', dryRun: true, adopt: true, discardLocalEdits: true, prune: true, timeoutMs: 200 };
      const vendorSync: Promise<ResultEnvelope<VendorSyncResult | null>> = syncVendorSources(vendorSyncOptions);
      const profileOptions: ProfileOptions = { hermesRoot: '/hermes', registryRoot: '/catalog', home: '/home/example', cwd: '/unrelated', stateHome: '/state', signal: { aborted: false }, timeoutMs: 200 };
      const profileList: Promise<ResultEnvelope<ProfileListResult | null>> = listProfiles(profileOptions);
      const profileShow: Promise<ResultEnvelope<ProfileShowResult | null>> = showProfile('builder', { ...profileOptions, project: '/project' });
      const profileSyncOptions: ProfileSyncOptions = { ...profileOptions, project: '/project', dryRun: true };
      const profileSync: Promise<ResultEnvelope<ProfileSyncResult | null>> = syncProfile('builder', profileSyncOptions);
      profileSync.then(result => {
        if (result.data === null) return;
        const location: ProfileLocation = result.data.profile;
        const managed: readonly ProfileCandidate[] | null = result.data.managed;
        const preserved: readonly ProfileLocalEntry[] = result.data.preserved;
        const changes: readonly ProfileChange[] = result.data.changes;
        const applied: readonly ProfileChange[] = result.data.applied;
        const project: string = result.data.project;
      });
      // @ts-expect-error Profile sync requires an explicit project; ambient CWD is insufficient.
      syncProfile('builder', profileOptions);
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
