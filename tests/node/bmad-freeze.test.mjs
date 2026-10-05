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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { explainBmadSkill, freezeBmadPack, inspectBmadStatus, verifyPack } from "@delorenj/skillex";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/** Build a self-contained BMAD-enabled project fixture (never touches IdealScenario). */
function bmadSourceFixture(t, version = "6.12.1-next.0", options = {}) {
  const { changed = false, withCommands = true } = options;
  // Use the real /tmp (not TMPDIR): receipt validation forbids state under a
  // source repository, and this machine's TMPDIR lives inside ~/.claude.
  const root = realpathSync(mkdtempSync("/tmp/skillex-bmad-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "_bmad", "_config");
  mkdirSync(config, { recursive: true });
  const skills = [
    { name: "bmad-alpha", module: "core", description: "Alpha workflow" },
    { name: "bmad-beta", module: "bmm", description: "Beta workflow" },
  ];
  const csvRows = [
    "canonicalId,name,description,module,path",
    ...skills.map(
      (skill) =>
        `"${skill.name}","${skill.name}","${skill.description}","${skill.module}","_bmad/${skill.module}/${skill.name}/SKILL.md"`,
    ),
  ];
  writeFileSync(join(config, "skill-manifest.csv"), `${csvRows.join("\n")}\n`);
  const manifest = {
    installation: {
      version,
      installDate: "2026-02-06T07:38:12.789Z",
      lastUpdated: "2026-09-20T06:04:31.608Z",
    },
    modules: [
      { name: "core", version, source: "built-in", npmPackage: null, repoUrl: null },
      {
        name: "bmb",
        version: "main",
        source: "external",
        npmPackage: "bmad-builder",
        repoUrl: "https://github.com/bmad-code-org/bmad-builder",
        channel: "next",
        sha: "4a1422274a2acb0fb0ec0511753da6263948f072",
      },
    ],
    ides: ["claude-code"],
  };
  // Minimal hand-rolled YAML for the installation manifest.
  const yaml = [
    "installation:",
    `  version: "${version}"`,
    '  installDate: "2026-02-06T07:38:12.789Z"',
    '  lastUpdated: "2026-09-20T06:04:31.608Z"',
    "modules:",
    `  - name: core`,
    `    version: "${version}"`,
    "    source: built-in",
    "  - name: bmb",
    "    version: main",
    "    source: external",
    "    repoUrl: https://github.com/bmad-code-org/bmad-builder",
    "    sha: 4a1422274a2acb0fb0ec0511753da6263948f072",
  ].join("\n");
  writeFileSync(join(config, "manifest.yaml"), `${yaml}\n`);
  writeFileSync(
    join(config, "files-manifest.csv"),
    'type,name,module,path,hash\n"yaml","manifest","_config","_config/manifest.yaml","abc"\n',
  );
  // Rendered skills (the only complete bytes).
  for (const skill of skills) {
    const path = join(root, ".agents", "skills", skill.name);
    mkdirSync(path, { recursive: true });
    const suffix = changed ? ` (v${version})` : "";
    writeFileSync(
      join(path, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}${suffix}\n`,
    );
    writeFileSync(join(path, "customize.toml"), `# DO NOT EDIT\n[workflow]\n`);
    mkdirSync(join(path, "references"), { recursive: true });
    writeFileSync(join(path, "references", "guide.md"), `Guide for ${skill.name}${suffix}\n`);
  }
  // Per-client command layouts.
  if (withCommands) {
    const claudeDir = join(root, ".claude", "commands");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "bmad-alpha.agent.md"),
      "---\nname: alpha\n---\nLOAD {project-root}/_bmad/core/workflows/alpha.md\n",
    );
    writeFileSync(
      join(claudeDir, "bmad-beta.agent.md"),
      "---\nname: beta\n---\nLOAD {project-root}/_bmad/bmm/workflows/beta.md\n",
    );
    const opencodeDir = join(root, ".opencode", "commands");
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, "bmad-alpha.md"), "@skills/bmad-alpha\n");
  }
  // A rendered bmad skill NOT declared in the manifest (installer-owned).
  const orphan = join(root, ".agents", "skills", "bmad-orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "SKILL.md"), "---\nname: bmad-orphan\n---\n\n# orphan\n");
  return { root, version, skills: skills.map((skill) => skill.name) };
}

function registryFixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/skillex-bmad-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "registry");
  const stateHome = join(root, "state");
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  const options = {
    registryRoot: registry,
    home: root,
    cwd: root,
    env: { XDG_STATE_HOME: stateHome },
    stateHome,
    timeoutMs: 10_000,
  };
  return { root, registry, stateHome, options };
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const info = lstatSync(path);
    rows.push([
      relative(root, path),
      info.mode,
      info.mtimeMs,
      info.isSymbolicLink()
        ? `link:${readlinkSync(path)}`
        : info.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "directory",
    ]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return rows;
}

function ok(result) {
  assert.equal(result.exit, 0, JSON.stringify(result.findings));
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.ok(result.data);
  return result.data;
}

function finding(result, code, exit = 3) {
  assert.equal(result.exit, exit, JSON.stringify(result.findings));
  assert.equal(result.ok, false);
  const found = result.findings.find((entry) => entry.code === code);
  assert.ok(found, JSON.stringify(result.findings));
  assert.ok(found.fix);
  return found;
}

it("freezes rendered skills into canonical all-skills and a reference-only versioned pack", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  const data = ok(await freezeBmadPack(source.root, registry.options));
  assert.equal(data.pack.name, "bmad");
  assert.equal(data.pack.version, source.version);
  assert.equal(data.skillsDeclared, 2);
  assert.equal(data.skillsImported, 2);
  assert.equal(data.foreignSkills.length, 1);
  assert.equal(data.foreignSkills[0].name, "bmad-orphan");
  // ADR-0001: pack never owns real SKILL.md bodies.
  for (const name of data.skills.map((skill) => skill.name)) {
    const link = join(data.pack.path, "skills", name);
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${link} must be a reference`);
    assert.equal(realpathSync(link), join(registry.registry, "all-skills", name));
    // ADR-0001: the pack member itself must be a link, never a real definition.
    assert.equal(lstatSync(join(data.pack.path, "skills", name)).isSymbolicLink(), true);
  }
  // No real SKILL.md anywhere under the pack.
  const packSkillBodies = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "SKILL.md") packSkillBodies.push(path);
    }
  };
  walk(data.pack.path);
  assert.deepEqual(packSkillBodies, []);
  // Per-client command copies are byte-preserved under their own layouts.
  const claudeCopy = join(data.pack.path, "commands", "claude-code", "bmad-alpha.agent.md");
  assert.equal(
    readFileSync(claudeCopy, "utf8"),
    readFileSync(join(source.root, ".claude", "commands", "bmad-alpha.agent.md"), "utf8"),
  );
  const opencodeCopy = join(data.pack.path, "commands", "opencode-skill", "bmad-alpha.md");
  assert.equal(
    readFileSync(opencodeCopy, "utf8"),
    readFileSync(join(source.root, ".opencode", "commands", "bmad-alpha.md"), "utf8"),
  );
  // Dangling _bmad references are reported, not rewritten.
  assert.equal(data.danglingCommands, 2);
  // Provenance receipts record the BMAD version, digest, and module matrix.
  const receipt = readFileSync(
    join(registry.registry, "all-skills", "bmad-alpha", ".source.yaml"),
    "utf8",
  );
  assert.match(receipt, /type: bmad-freeze/);
  assert.match(receipt, new RegExp(`bmad_version: ${source.version.replaceAll(".", "\\.")}`));
  assert.match(receipt, /digest: sha256:[a-f0-9]{64}/);
  assert.match(receipt, /sha: 4a1422274a2acb0fb0ec0511753da6263948f072/);
  // Pack manifest is reference-only and verified green.
  const manifest = parseToml(readFileSync(join(data.pack.path, "pack.toml"), "utf8"));
  assert.deepEqual(manifest.freeform.skills, ["bmad-alpha", "bmad-beta"]);
  assert.equal(manifest.pack.version, source.version);
  assert.equal(manifest.source.bmad_version, source.version);
  ok(await verifyPack(`bmad@${source.version}`, registry.options));
});

it("re-freezing the same version is idempotent and changes nothing", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const filesOnly = (rows) => rows.filter(([path, , , kind]) => kind !== "directory");
  const before = filesOnly(snapshot(registry.root));
  const again = ok(await freezeBmadPack(source.root, registry.options));
  assert.equal(again.skillsImported, 0);
  assert.equal(again.skillsUnchanged, 2);
  // Only the pack manifest may be rewritten; its content stays identical.
  const after = filesOnly(snapshot(registry.root));
  const changed = after.filter(
    (row, index) => JSON.stringify(row) !== JSON.stringify(before[index]),
  );
  for (const [path] of changed) {
    assert.match(path, /pack\.toml$/, `unexpected change outside the pack manifest: ${path}`);
  }
  const manifest = readFileSync(
    join(registry.registry, "packs", "bmad", source.version, "pack.toml"),
    "utf8",
  );
  assert.match(manifest, /skills = \[ ?"bmad-alpha", ?"bmad-beta" ?\]/);
});

it("dry-run plans without writing", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  const planned = ok(await freezeBmadPack(source.root, { ...registry.options, dryRun: true }));
  assert.equal(planned.dryRun, true);
  assert.equal(planned.skillsImported, 2);
  assert.equal(existsSync(join(registry.registry, "all-skills", "bmad-alpha")), false);
  assert.equal(existsSync(join(planned.pack.path, "pack.toml")), false);
});

it("refuses to overwrite foreign canonical content without provenance", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  const foreign = join(registry.registry, "all-skills", "bmad-alpha");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "# foreign\n");
  finding(await freezeBmadPack(source.root, registry.options), "E_BMAD_FOREIGN_COLLISION");
  assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "# foreign\n");
});

it("refuses a source version switch without --replace and refuses --replace over edited bytes", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1-next.0");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  // A second source install at a different BMAD version, same rendered bytes.
  const upgraded = bmadSourceFixture(t, "6.13.0");
  finding(await freezeBmadPack(upgraded.root, registry.options), "E_BMAD_VERSION_CONFLICT");
  // Same bytes + explicit --replace performs the version switch transaction.
  const replaced = ok(await freezeBmadPack(upgraded.root, { ...registry.options, replace: true }));
  assert.equal(replaced.skillsImported, 2);
  const receipt = readFileSync(
    join(registry.registry, "all-skills", "bmad-alpha", ".source.yaml"),
    "utf8",
  );
  assert.match(receipt, /bmad_version: 6\.13\.0/);
  // A body edited after freezing is foreign to --replace.
  const edited = join(registry.registry, "all-skills", "bmad-beta", "SKILL.md");
  writeFileSync(edited, "# locally edited\n");
  const newer = bmadSourceFixture(t, "6.14.0");
  finding(
    await freezeBmadPack(newer.root, { ...registry.options, replace: true }),
    "E_BMAD_FOREIGN_COLLISION",
  );
});

it("bmad status traces frozen skills and reports drift and undeclared pack children", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const status = ok(await inspectBmadStatus(registry.options));
  assert.equal(status.skills.length, 2);
  assert.equal(status.traced, 2);
  assert.equal(status.pack, `bmad@${source.version}`);
  assert.equal(status.packVerified, true);
  assert.deepEqual(status.untraced, []);
  // Drift: a modified body is detected against the recorded baseline.
  const edited = join(registry.registry, "all-skills", "bmad-alpha", "SKILL.md");
  writeFileSync(edited, "# tampered\n");
  const drifted = await inspectBmadStatus(registry.options);
  assert.equal(drifted.exit, 0);
  const warning = drifted.findings.find((entry) => entry.code === "W_BMAD_DRIFT");
  assert.ok(warning);
  assert.deepEqual(drifted.data.drifted, ["bmad-alpha"]);
  // Undeclared pack child: reported as a traceability gap, not a silent green verify.
  const orphan = join(registry.registry, "packs", "bmad", source.version, "skills", "bmad-ghost");
  mkdirSync(orphan, { recursive: true });
  const untraced = await inspectBmadStatus(registry.options);
  const gap = untraced.findings.find((entry) => entry.code === "W_BMAD_UNDECLARED_MEMBER");
  assert.ok(gap);
  assert.deepEqual(untraced.data.untraced, ["bmad-ghost"]);
});

it("bmad explain reports provenance, baseline agreement, and references", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const data = ok(await explainBmadSkill("bmad-alpha", registry.options));
  assert.equal(data.skill.bmadVersion, source.version);
  assert.equal(data.skill.digest, data.skill.recordedDigest);
  assert.deepEqual(data.skill.references, [
    { kind: "pack", name: "bmad", version: source.version },
  ]);
  const missing = await explainBmadSkill("not-a-skill", registry.options);
  assert.equal(missing.exit, 3);
  assert.equal(missing.data, null);
  assert.equal(missing.findings[0].code, "E_SKILL_MISSING");
});

it("refuses unsafe version overrides and missing source layouts", async (t) => {
  const source = bmadSourceFixture(t);
  const registry = registryFixture(t);
  const traversal = await freezeBmadPack(source.root, {
    ...registry.options,
    version: "../escape",
  });
  assert.equal(traversal.exit, 3);
  assert.equal(traversal.data, null);
  const notBmad = join(registry.root, "not-bmad");
  mkdirSync(notBmad, { recursive: true });
  finding(await freezeBmadPack(notBmad, registry.options), "E_BMAD_SOURCE_LAYOUT");
});

// --- SKRILL-26 spec-gate regressions (all seven HOLD findings) ---

it("finding 1: --replace performs a real version upgrade with changed source bytes on a pristine canonical", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  // BMAD release changes skill content; the canonical is pristine (unmodified).
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  const replaced = ok(await freezeBmadPack(upgraded.root, { ...registry.options, replace: true }));
  assert.equal(replaced.skillsImported, 2);
  const body = readFileSync(
    join(registry.registry, "all-skills", "bmad-alpha", "SKILL.md"),
    "utf8",
  );
  assert.match(body, /\(v6\.13\.0\)/);
  const receipt = readFileSync(
    join(registry.registry, "all-skills", "bmad-alpha", ".source.yaml"),
    "utf8",
  );
  assert.match(receipt, /bmad_version: 6\.13\.0/);
  assert.match(receipt, /modified_locally: false/);
});

it("finding 1b: --replace refuses an edited (locally modified) canonical even at a new version", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  writeFileSync(
    join(registry.registry, "all-skills", "bmad-alpha", "SKILL.md"),
    "# locally edited\n",
  );
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  finding(
    await freezeBmadPack(upgraded.root, { ...registry.options, replace: true }),
    "E_BMAD_FOREIGN_COLLISION",
  );
  // The edited canonical is untouched.
  assert.equal(
    readFileSync(join(registry.registry, "all-skills", "bmad-alpha", "SKILL.md"), "utf8"),
    "# locally edited\n",
  );
});

it("finding 2: pack collision is detected before any registry write; dry-run reports the same refusal", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  // Foreign real skill directory at the NEXT version's pack path (version switch).
  const upgraded = bmadSourceFixture(t, "6.13.0");
  const foreign = join(registry.registry, "packs", "bmad", "6.13.0", "skills", "bmad-alpha");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "# foreign pack content\n");
  // Dry-run must surface the identical refusal without writing anything.
  const planned = await freezeBmadPack(upgraded.root, {
    ...registry.options,
    replace: true,
    dryRun: true,
  });
  finding(planned, "E_BMAD_FOREIGN_COLLISION");
  // The apply path must refuse BEFORE importing anything into all-skills/.
  const applied = await freezeBmadPack(upgraded.root, { ...registry.options, replace: true });
  finding(applied, "E_BMAD_FOREIGN_COLLISION");
  assert.equal(
    existsSync(join(registry.registry, "all-skills", "bmad-alpha", ".source.yaml")),
    true,
    "original receipt must survive",
  );
  assert.match(
    readFileSync(join(registry.registry, "all-skills", "bmad-alpha", ".source.yaml"), "utf8"),
    /bmad_version: 6\.12\.1/,
    "no orphaned canonical with a stamped newer receipt",
  );
  // The foreign pack content is untouched.
  assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "# foreign pack content\n");
});

it("finding 3: --replace retires the old version pack out of discoverable packs and old baselines no longer verify green", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  ok(await freezeBmadPack(upgraded.root, { ...registry.options, replace: true }));
  // The old version dir must not remain discoverable under packs/bmad/.
  assert.equal(
    existsSync(join(registry.registry, "packs", "bmad", "6.12.1", "pack.toml")),
    false,
    "old version pack retired from discoverable packs",
  );
  // The retired pack is preserved outside the discoverable packs tree...
  const archive = join(registry.registry, "packs", ".archived-bmad-6.13.0", "6.12.1");
  assert.equal(existsSync(join(archive, "pack.toml")), true, "retired pack archived, not deleted");
  // ...and a stale pinned reference must NOT verify green against the newer
  // canonical if it is ever restored (baseline mismatch, not silent green).
  renameSync(
    join(registry.registry, "packs", ".archived-bmad-6.13.0", "6.12.1"),
    join(registry.registry, "packs", "bmad", "6.12.1"),
  );
  const oldVerify = await verifyPack("bmad@6.12.1", registry.options);
  assert.equal(oldVerify.exit, 3, JSON.stringify(oldVerify.findings));
  assert.equal(oldVerify.ok, false);
  const baseline = oldVerify.findings.find((entry) => entry.code === "E_BMAD_PACK_BASELINE");
  assert.ok(baseline, JSON.stringify(oldVerify.findings));
  // Status still selects the NEW version semantically and stays green.
  const status = ok(await inspectBmadStatus(registry.options));
  assert.equal(status.pack, "bmad@6.13.0");
  assert.equal(status.packVerified, true);
  // Direct core verify of the new pack is green too.
  ok(await verifyPack("bmad@6.13.0", registry.options));
});

it("finding 4: --no-commands is honored on fresh freeze and preserves existing commands on repeat", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  // Fresh freeze with commands disabled: no command copies, no misleading metadata.
  const data = ok(await freezeBmadPack(source.root, { ...registry.options, commands: false }));
  assert.equal(data.commandFiles, 0);
  assert.equal(existsSync(join(data.pack.path, "commands")), false);
  // Repeat with commands disabled: existing command receipt bytes are preserved.
  const withCommands = bmadSourceFixture(t, "6.12.1");
  ok(await freezeBmadPack(withCommands.root, registry.options));
  const claudeCopy = join(
    registry.registry,
    "packs",
    "bmad",
    "6.12.1",
    "commands",
    "claude-code",
    "bmad-alpha.agent.md",
  );
  const before = readFileSync(claudeCopy, "utf8");
  const repeat = ok(
    await freezeBmadPack(withCommands.root, { ...registry.options, commands: false }),
  );
  assert.equal(repeat.commandFiles, 0);
  assert.equal(readFileSync(claudeCopy, "utf8"), before, "existing command bytes preserved");
});

it("finding 5: replace never destroys pre-existing swap/backup artifacts (unique owned temps)", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  // Pre-existing crash-recovery artifacts beside the canonical.
  const catalog = join(registry.registry, "all-skills");
  const backup = join(catalog, ".skillex-bmad-bmad-alpha.backup");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "old-skill.md"), "precious recovery bytes\n");
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  // The freeze must refuse to clobber the foreign artifact, not silently delete it.
  finding(
    await freezeBmadPack(upgraded.root, { ...registry.options, replace: true }),
    "E_BMAD_FOREIGN_COLLISION",
  );
  assert.equal(
    readFileSync(join(backup, "old-skill.md"), "utf8"),
    "precious recovery bytes\n",
    "crash-recovery artifact preserved",
  );
});

it("finding 6: status picks the semantically highest pack version, not lexical", async (t) => {
  const registry = registryFixture(t);
  // Two existing packs whose lexical order differs from semantic order.
  for (const version of ["6.9.0", "6.10.0"]) {
    const family = join(registry.registry, "packs", "bmad", version, "skills");
    mkdirSync(family, { recursive: true });
    writeFileSync(
      join(registry.registry, "packs", "bmad", version, "pack.toml"),
      [
        "[pack]",
        `name = "bmad"`,
        `version = "${version}"`,
        "",
        "[freeform]",
        "skills = []",
        "",
      ].join("\n"),
    );
  }
  const status = ok(await inspectBmadStatus(registry.options));
  assert.equal(status.pack, "bmad@6.10.0");
});

it("finding 7: status traced is grounded in composition membership; orphaned canonicals are excluded", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  // Remove every composition: the frozen canonical receipts become orphaned.
  rmSync(join(registry.registry, "packs"), { recursive: true, force: true });
  const orphaned = await inspectBmadStatus(registry.options);
  assert.equal(orphaned.data.traced, 0, "orphaned canonicals must not count as traced");
  const orphanFinding = orphaned.findings.find((entry) => entry.code === "W_BMAD_ORPHAN");
  assert.ok(orphanFinding, JSON.stringify(orphaned.findings));
  assert.equal(orphaned.data.skills.length, 2, "skills are still inventoried with their state");
});

// --- SKRILL-26 round-3 quality HOLD defects QF1/QF2/QF3 ---

it("QF1: --version override keeps installation provenance; pack verifies green and status succeeds", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  // Fresh freeze with a custom pack version override: the override names the pack
  // directory only; [source].bmad_version must record the ACTUAL installation version
  // (exactly like every per-skill receipt), or the pack's own verifier calls its own
  // fresh output stale.
  const frozen = ok(
    await freezeBmadPack(source.root, { ...registry.options, version: "custom-9" }),
  );
  assert.equal(frozen.pack.version, "custom-9");
  const manifest = parseToml(readFileSync(join(frozen.pack.path, "pack.toml"), "utf8"));
  assert.equal(manifest.pack.version, "custom-9", "pack directory uses the override");
  assert.equal(
    manifest.source.bmad_version,
    "6.12.1",
    "source provenance must record the actual installation.version, not the override",
  );
  assert.equal(manifest.source.installation_version, "6.12.1");
  // The pack verifies green immediately after the freeze that wrote it.
  ok(await verifyPack("bmad@custom-9", registry.options));
  // bmad status picks the highest pack version (the only one) and stays green.
  const status = ok(await inspectBmadStatus(registry.options));
  assert.equal(status.pack, "bmad@custom-9");
  assert.equal(status.packVerified, true);
  // A same-version repeat with the override is idempotent: nothing changes.
  // (Mirrors the base idempotence test: only the pack manifest may be republished,
  // and its content stays identical — mtime may move, bytes may not.)
  const filesOnly = (rows) => rows.filter(([, , , kind]) => kind !== "directory");
  const before = filesOnly(snapshot(registry.root));
  const again = ok(await freezeBmadPack(source.root, { ...registry.options, version: "custom-9" }));
  assert.equal(again.skillsUnchanged, 2);
  const after = filesOnly(snapshot(registry.root));
  const changed = after.filter(
    (row, index) => JSON.stringify(row) !== JSON.stringify(before[index]),
  );
  for (const [path] of changed) {
    assert.match(path, /pack\.toml$/, `unexpected change outside the pack manifest: ${path}`);
  }
  assert.equal(
    readFileSync(join(frozen.pack.path, "pack.toml"), "utf8"),
    readFileSync(join(registry.registry, "packs", "bmad", "custom-9", "pack.toml"), "utf8"),
    "override repeat must republish identical manifest bytes",
  );
  // An upgrade from a NEW source version still guards: no --replace -> refused,
  // --replace -> real version switch recorded in provenance.
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  finding(await freezeBmadPack(upgraded.root, registry.options), "E_BMAD_VERSION_CONFLICT");
  ok(await freezeBmadPack(upgraded.root, { ...registry.options, replace: true }));
  const receipt = readFileSync(
    join(registry.registry, "all-skills", "bmad-alpha", ".source.yaml"),
    "utf8",
  );
  assert.match(receipt, /bmad_version: 6\.13\.0/);
  const newManifest = parseToml(
    readFileSync(join(registry.registry, "packs", "bmad", "6.13.0", "pack.toml"), "utf8"),
  );
  assert.equal(newManifest.source.bmad_version, "6.13.0");
  assert.equal(newManifest.pack.version, "6.13.0");
  ok(await verifyPack("bmad@6.13.0", registry.options));
});

it("QF2: stamped crash-recovery backup does not brick bmad status; real drift still reported", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const catalog = join(registry.registry, "all-skills");
  // Exactly what replaceTree documents it leaves after a crash mid-rename: a full
  // copy of the replaced skill INCLUDING its .source.yaml receipt, under a stamped
  // owned name beside the catalog.
  const stamped = join(catalog, ".skillex-bmad-bmad-alpha.1234.999.backup");
  mkdirSync(stamped, { recursive: true });
  writeFileSync(
    join(stamped, "SKILL.md"),
    readFileSync(join(catalog, "bmad-alpha", "SKILL.md"), "utf8"),
  );
  writeFileSync(
    join(stamped, ".source.yaml"),
    readFileSync(join(catalog, "bmad-alpha", ".source.yaml"), "utf8"),
  );
  // bmad status must not die on the stamped backup (invalid canonical name with a
  // bmad-freeze receipt); the walk skips hidden/invalid entries.
  const status = ok(await inspectBmadStatus(registry.options));
  assert.deepEqual(
    status.skills.map((skill) => skill.name),
    ["bmad-alpha", "bmad-beta"],
  );
  assert.equal(status.traced, 2);
  // The stamped backup is preserved untouched (crash recovery is never destroyed).
  assert.equal(existsSync(join(stamped, ".source.yaml")), true);
  // Ordinary valid canonical drift is still surfaced.
  writeFileSync(join(catalog, "bmad-beta", "SKILL.md"), "# tampered\n");
  const drifted = await inspectBmadStatus(registry.options);
  assert.equal(drifted.exit, 0);
  assert.ok(drifted.findings.some((entry) => entry.code === "W_BMAD_DRIFT"));
  assert.deepEqual(drifted.data.drifted, ["bmad-beta"]);
});

it("QF3: --no-commands repeat preserves prior source.commands provenance and manifest bytes", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const manifestPath = join(registry.registry, "packs", "bmad", "6.12.1", "pack.toml");
  const before = readFileSync(manifestPath, "utf8");
  assert.match(before, /\[\[source\.commands\]\]/, "fixture freeze records command inventory");
  // A fresh --no-commands freeze still writes zero command inventory.
  const freshSource = bmadSourceFixture(t, "6.12.1");
  const freshRegistry = registryFixture(t);
  const fresh = ok(
    await freezeBmadPack(freshSource.root, { ...freshRegistry.options, commands: false }),
  );
  assert.equal(fresh.commandFiles, 0);
  const freshManifest = readFileSync(
    join(freshRegistry.registry, "packs", "bmad", "6.12.1", "pack.toml"),
    "utf8",
  );
  assert.doesNotMatch(freshManifest, /\[\[source\.commands\]\]/);
  assert.match(freshManifest, /commands = \[\]/);
  // Repeat with --no-commands: the prior command provenance AND manifest bytes are
  // preserved (the docs guarantee identical republished content; nothing is rescanned).
  const repeat = ok(await freezeBmadPack(source.root, { ...registry.options, commands: false }));
  assert.equal(repeat.commandFiles, 0, "no source rescan when commands are skipped");
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    before,
    "--no-commands repeat must republish identical manifest bytes",
  );
  // Command files on disk are untouched and still match the source bytes.
  const claudeCopy = join(
    registry.registry,
    "packs",
    "bmad",
    "6.12.1",
    "commands",
    "claude-code",
    "bmad-alpha.agent.md",
  );
  assert.equal(
    readFileSync(claudeCopy, "utf8"),
    readFileSync(join(source.root, ".claude", "commands", "bmad-alpha.agent.md"), "utf8"),
  );
  // Modules and pins remain the actual installation facts.
  const manifest = parseToml(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.source.installation_version, "6.12.1");
  assert.equal(manifest.source.bmad_version, "6.12.1");
  assert.match(readFileSync(manifestPath, "utf8"), /4a1422274a2acb0fb0ec0511753da6263948f072/);
});

it("QF3b: --no-commands repeat with a corrupted/missing command file falls back to an empty inventory", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const manifestPath = join(registry.registry, "packs", "bmad", "6.12.1", "pack.toml");
  // Someone deleted a command file after the freeze: the manifest must not claim
  // provenance for bytes that are no longer there.
  rmSync(
    join(
      registry.registry,
      "packs",
      "bmad",
      "6.12.1",
      "commands",
      "claude-code",
      "bmad-alpha.agent.md",
    ),
  );
  const repeat = ok(await freezeBmadPack(source.root, { ...registry.options, commands: false }));
  assert.equal(repeat.commandFiles, 0);
  assert.doesNotMatch(readFileSync(manifestPath, "utf8"), /\[\[source\.commands\]\]/);
  assert.match(readFileSync(manifestPath, "utf8"), /commands = \[\]/);
});

// --- SKRILL-26 round-2 HOLD defects D1/D2: exercise the real CLI, not the library ---

const CLI_PATH = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js"),
);

/** Spawn the built dist/cli.js hermetically and parse its --json envelope. */
function runCli(registry, args) {
  const child = spawnSync(process.execPath, [CLI_PATH, "--json", ...args], {
    cwd: registry.root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: registry.root,
      XDG_STATE_HOME: registry.stateHome,
      NO_COLOR: "1",
    },
  });
  assert.ifError(child.error, "cli spawn failed");
  assert.equal(child.signal, null, `cli terminated by ${child.signal}`);
  const envelope = JSON.parse(child.stdout);
  assert.equal(envelope.schema, 2);
  assert.equal(child.status, envelope.exit, `stdout/stderr mismatch: ${child.stderr}`);
  return envelope;
}

it("D1: CLI --no-commands is honored on fresh freeze and preserves bytes on repeat", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  // Fresh freeze via the real CLI with --no-commands: zero command copies.
  const fresh = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
    "--no-commands",
  ]);
  assert.equal(fresh.exit, 0, JSON.stringify(fresh.findings));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.data.commandFiles, 0, "--no-commands must disable command copies");
  assert.equal(
    existsSync(join(fresh.data.pack.path, "commands")),
    false,
    "no commands/ directory may be created",
  );
  // A commands-enabled repeat lands the real bytes...
  const enabled = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(enabled.exit, 0, JSON.stringify(enabled.findings));
  assert.equal(enabled.data.commandFiles, 3);
  const claudeCopy = join(
    registry.registry,
    "packs",
    "bmad",
    "6.12.1",
    "commands",
    "claude-code",
    "bmad-alpha.agent.md",
  );
  const before = readFileSync(claudeCopy, "utf8");
  // ...and a --no-commands repeat preserves them untouched.
  const repeat = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
    "--no-commands",
  ]);
  assert.equal(repeat.exit, 0, JSON.stringify(repeat.findings));
  assert.equal(repeat.data.commandFiles, 0, "repeat --no-commands must not re-copy commands");
  assert.equal(readFileSync(claudeCopy, "utf8"), before, "existing command bytes preserved");
});

it("D2: CLI status stays green after --replace; archived packs are undiscoverable; malformed non-hidden packs still error", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  const base = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(base.exit, 0, JSON.stringify(base.findings));
  // Real upgrade: changed source bytes at a new version via --replace.
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  const replaced = runCli(registry, [
    "bmad",
    "freeze",
    upgraded.root,
    "--registry-root",
    registry.registry,
    "--replace",
  ]);
  assert.equal(replaced.exit, 0, JSON.stringify(replaced.findings));
  assert.equal(replaced.data.pack.version, "6.13.0");
  // The retired version is archived under a dot-prefixed family, not deleted.
  const archive = join(registry.registry, "packs", ".archived-bmad-6.13.0", "6.12.1", "pack.toml");
  assert.equal(existsSync(archive), true, "retired pack archived");
  // Post-replace status must succeed with only the ACTIVE pack as a reference.
  const status = runCli(registry, ["bmad", "status", "--registry-root", registry.registry]);
  assert.equal(status.exit, 0, JSON.stringify(status.findings));
  assert.equal(status.ok, true);
  assert.deepEqual(
    status.findings.filter((entry) => entry.code === "E_BMAD_COMPOSITION_INVALID"),
    [],
    "archived dot-packs must not be discovered by bmad status",
  );
  assert.equal(status.data.pack, "bmad@6.13.0");
  for (const skill of status.data.skills) {
    assert.deepEqual(skill.references, ["bmad@6.13.0"], "only the active pack may be referenced");
  }
  // pack list skips the archive family as well.
  const listed = runCli(registry, ["pack", "list", "--registry-root", registry.registry]);
  assert.equal(listed.exit, 0, JSON.stringify(listed.findings));
  const listedIds = listed.data.packs.map((pack) => `${pack.name}@${pack.version}`);
  assert.deepEqual(listedIds, ["bmad@6.13.0"]);
  // A malformed NON-hidden pack must still surface as E_BMAD_COMPOSITION_INVALID.
  const broken = join(registry.registry, "packs", "broken", "1.0.0");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "pack.toml"), "not [ valid toml [[[\n");
  const errored = runCli(registry, ["bmad", "status", "--registry-root", registry.registry]);
  assert.equal(errored.exit, 4, JSON.stringify(errored.findings));
  assert.equal(errored.ok, false);
  const invalid = errored.findings.find((entry) => entry.code === "E_BMAD_COMPOSITION_INVALID");
  assert.ok(invalid, JSON.stringify(errored.findings));
  assert.match(invalid.message, /broken@1\.0\.0/);
});

it("QF4: CLI regression — fresh freeze with commands, --no-commands repeat keeps exact pack.toml bytes and command files; fresh --no-commands is zero", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  // Fresh freeze WITH commands via the real CLI.
  const frozen = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.findings));
  assert.equal(frozen.data.commandFiles, 3);
  const manifestPath = join(frozen.data.pack.path, "pack.toml");
  const beforeManifest = readFileSync(manifestPath, "utf8");
  assert.match(beforeManifest, /\[\[source\.commands\]\]/);
  const claudeCopy = join(frozen.data.pack.path, "commands", "claude-code", "bmad-alpha.agent.md");
  const beforeCommand = readFileSync(claudeCopy, "utf8");
  // --no-commands repeat: exact manifest bytes and command files preserved.
  const repeat = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
    "--no-commands",
  ]);
  assert.equal(repeat.exit, 0, JSON.stringify(repeat.findings));
  assert.equal(repeat.data.commandFiles, 0);
  assert.equal(
    readFileSync(manifestPath, "utf8"),
    beforeManifest,
    "repeat --no-commands must republish identical pack.toml bytes",
  );
  assert.equal(
    readFileSync(claudeCopy, "utf8"),
    beforeCommand,
    "repeat --no-commands must preserve command files",
  );
  // Source modules/pins remain the actual installation facts.
  assert.match(readFileSync(manifestPath, "utf8"), /4a1422274a2acb0fb0ec0511753da6263948f072/);
  // Fresh --no-commands via the CLI is still zero: no commands dir, empty inventory.
  const freshSource = bmadSourceFixture(t, "6.12.1");
  const freshRegistry = registryFixture(t);
  const fresh = runCli(freshRegistry, [
    "bmad",
    "freeze",
    freshSource.root,
    "--registry-root",
    freshRegistry.registry,
    "--no-commands",
  ]);
  assert.equal(fresh.exit, 0, JSON.stringify(fresh.findings));
  assert.equal(fresh.data.commandFiles, 0);
  assert.equal(existsSync(join(fresh.data.pack.path, "commands")), false);
  const freshManifest = readFileSync(join(fresh.data.pack.path, "pack.toml"), "utf8");
  assert.doesNotMatch(freshManifest, /\[\[source\.commands\]\]/);
  assert.match(freshManifest, /commands = \[\]/);
});

it("QF5: CLI regression — --version override pack verifies green via the real CLI and bmad status stays green", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  const frozen = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
    "--version",
    "custom-9",
  ]);
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.findings));
  const verified = runCli(registry, [
    "pack",
    "verify",
    "bmad@custom-9",
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(verified.exit, 0, JSON.stringify(verified.findings));
  assert.equal(verified.ok, true);
  const status = runCli(registry, ["bmad", "status", "--registry-root", registry.registry]);
  assert.equal(status.exit, 0, JSON.stringify(status.findings));
  assert.equal(status.ok, true);
  assert.equal(status.data.pack, "bmad@custom-9");
  assert.equal(status.data.packVerified, true);
  // Stamped crash-recovery backup beside the catalog does not brick CLI status.
  const catalog = join(registry.registry, "all-skills");
  const stamped = join(catalog, ".skillex-bmad-bmad-alpha.1234.999.backup");
  mkdirSync(stamped, { recursive: true });
  writeFileSync(
    join(stamped, "SKILL.md"),
    readFileSync(join(catalog, "bmad-alpha", "SKILL.md"), "utf8"),
  );
  writeFileSync(
    join(stamped, ".source.yaml"),
    readFileSync(join(catalog, "bmad-alpha", ".source.yaml"), "utf8"),
  );
  const afterCrash = runCli(registry, ["bmad", "status", "--registry-root", registry.registry]);
  assert.equal(afterCrash.exit, 0, JSON.stringify(afterCrash.findings));
  assert.equal(afterCrash.data.skills.length, 2);
  assert.equal(existsSync(join(stamped, ".source.yaml")), true, "backup preserved");
});

// --- SKRILL-26 quality re-review HOLD: pack.toml ownership-safety root cause ---

function foreignManifestText() {
  return [
    "# foreign authored pack declaration",
    "[pack]",
    'name = "other-pack"',
    'version = "9.9.9"',
    "[freeform]",
    'skills = ["bmad-alpha"]',
    "[source]",
    'type = "other"',
    "",
  ].join("\n");
}

it("QF6: fresh freeze refuses to clobber a physically pre-existing FOREIGN pack.toml (with and without commands; dry-run parity; --replace cannot bypass)", async (t) => {
  for (const commandsEnabled of [true, false]) {
    const source = bmadSourceFixture(t, "6.12.1");
    const registry = registryFixture(t);
    const manifestPath = join(registry.registry, "packs", "bmad", "6.12.1", "pack.toml");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, foreignManifestText());
    const extra = commandsEnabled ? [] : ["--no-commands"];
    const tag = commandsEnabled ? "with-commands" : "no-commands";
    // Dry-run must surface the identical refusal (exit 3) and write nothing.
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(
      readFileSync(manifestPath, "utf8"),
      foreignManifestText(),
      `${tag}: dry-run must not touch the foreign manifest`,
    );
    assert.equal(
      existsSync(join(registry.registry, "all-skills", "bmad-alpha")),
      false,
      `${tag}: dry-run must not import canonical skills either`,
    );
    // Apply refuses with the same code, before any write.
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(
      readFileSync(manifestPath, "utf8"),
      foreignManifestText(),
      `${tag}: foreign manifest bytes must survive the refusal`,
    );
    assert.equal(
      existsSync(join(registry.registry, "all-skills", "bmad-alpha")),
      false,
      `${tag}: refusal must happen before any canonical import`,
    );
    // --replace cannot bypass foreign identity.
    const replaced = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--replace",
      ...extra,
    ]);
    finding(replaced, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(readFileSync(manifestPath, "utf8"), foreignManifestText());
  }
});

it("QF6b: malformed prior pack.toml refuses (both modes), never a silent rewrite; full tree digest unchanged under dry-run and apply", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const manifestPath = join(registry.registry, "packs", "bmad", "6.12.1", "pack.toml");
  const malformed = "this is not [ valid toml :::\n";
  writeFileSync(manifestPath, malformed);
  const filesOnly = (rows) => rows.filter(([, , , kind]) => kind !== "directory");
  const digest = () => JSON.stringify(filesOnly(snapshot(registry.root)));
  const before = digest();
  for (const extra of [[], ["--no-commands"]]) {
    const tag = extra.length ? "no-commands" : "with-commands";
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_PACK_MANIFEST");
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_PACK_MANIFEST");
    assert.equal(readFileSync(manifestPath, "utf8"), malformed, `${tag}: malformed bytes kept`);
    assert.equal(digest(), before, `${tag}: no tree change at all`);
  }
});

it("QF6c: owned pack.toml edited after freeze (identity/type/version/source_root) refuses instead of discarding authored edits", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const manifestPath = join(registry.registry, "packs", "bmad", "6.12.1", "pack.toml");
  const owned = readFileSync(manifestPath, "utf8");
  const editedOwned = `${owned}\n# user annotation\n[user]\nnotes = "mine"\n`;
  writeFileSync(manifestPath, editedOwned);
  const filesOnly = (rows) => rows.filter(([, , , kind]) => kind !== "directory");
  const digest = () => JSON.stringify(filesOnly(snapshot(registry.root)));
  const before = digest();
  for (const extra of [[], ["--no-commands"]]) {
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_FOREIGN_COLLISION");
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(
      readFileSync(manifestPath, "utf8"),
      editedOwned,
      "authored annotation/notes must be preserved, never silently discarded",
    );
    assert.equal(digest(), before, "refusal leaves the whole tree untouched");
  }
});

it("QF6e: authored edit INSIDE the command inventory region always refuses — annotation preserved even when the disk diverges (missing file or --replace cannot sweep it)", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  const frozen = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.findings));
  const manifestPath = join(frozen.data.pack.path, "pack.toml");
  // Append an authored annotation: it lands inside the LAST TOML table
  // ([[source.commands]]) — exactly the reviewer's finding 4 probe.
  const edited = `${readFileSync(manifestPath, "utf8")}# user annotation\nnotes = "mine"\n`;
  writeFileSync(manifestPath, edited);
  const annotated = parseToml(edited);
  assert.equal(
    annotated.source.commands.at(-1).notes,
    "mine",
    "fixture: the annotation must land inside the [[source.commands]] region",
  );
  const filesOnly = (rows) => rows.filter(([, , , kind]) => kind !== "directory");
  const digest = () => JSON.stringify(filesOnly(snapshot(registry.root)));
  // Disk unchanged: the inventory delta is authored and must be refused.
  let before = digest();
  for (const extra of [[], ["--no-commands"]]) {
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_FOREIGN_COLLISION");
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(
      readFileSync(manifestPath, "utf8"),
      edited,
      "authored annotation inside the inventory region must survive",
    );
    assert.equal(digest(), before, "refusal leaves the whole tree untouched");
  }
  // SKRILL-26 final correction: disk divergence no longer licenses sweeping
  // the annotation. User-authored metadata preservation wins — a recorded
  // command file going missing must not delete the user's note.
  rmSync(join(frozen.data.pack.path, "commands", "claude-code", "bmad-alpha.agent.md"));
  before = digest();
  for (const extra of [[], ["--no-commands"], ["--replace", "--no-commands"]]) {
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_FOREIGN_COLLISION");
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(
      readFileSync(manifestPath, "utf8"),
      edited,
      "authored annotation must survive even when recorded command files are missing",
    );
    assert.equal(digest(), before, "zero-write refusal: no bytes change anywhere");
  }
});

it("QF6f: foreign non-command file in the pack commands tree is never counted as command reality, never adopted/deleted, and never licenses sweeping authored inventory edits", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  const frozen = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.findings));
  const manifestPath = join(frozen.data.pack.path, "pack.toml");
  // Authored annotation inside [[source.commands]] + a foreign README.md that
  // only the OLD all-files count loop treated as disk divergence.
  const edited = `${readFileSync(manifestPath, "utf8")}# user annotation\nnotes = "mine"\n`;
  writeFileSync(manifestPath, edited);
  const readmePath = join(frozen.data.pack.path, "commands", "claude-code", "README.md");
  writeFileSync(readmePath, "# foreign editor readme\nnot a bmad command\n");
  const filesOnly = (rows) => rows.filter(([, , , kind]) => kind !== "directory");
  const digest = () => JSON.stringify(filesOnly(snapshot(registry.root)));
  const before = digest();
  for (const extra of [[], ["--no-commands"], ["--replace", "--no-commands"]]) {
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_FOREIGN_COLLISION");
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(readFileSync(manifestPath, "utf8"), edited, "authored note preserved");
    assert.equal(
      readFileSync(readmePath, "utf8"),
      "# foreign editor readme\nnot a bmad command\n",
      "foreign file preserved, never deleted",
    );
    assert.equal(digest(), before, "zero-write refusal across the whole tree");
  }
  // Without the authored note, a foreign README alone is NOT disk divergence:
  // the scanner-eligible bmad-* files still match, so the clean manifest is
  // retained byte-for-byte (no rewrite serves any truth purpose). Use a fresh
  // registry because the annotated one above must stay refused forever.
  const cleanRegistry = registryFixture(t);
  const cleanFrozen = runCli(cleanRegistry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    cleanRegistry.registry,
  ]);
  assert.equal(cleanFrozen.exit, 0, JSON.stringify(cleanFrozen.findings));
  const cleanManifestPath = join(cleanFrozen.data.pack.path, "pack.toml");
  const cleanBytes = readFileSync(cleanManifestPath, "utf8");
  writeFileSync(
    join(cleanFrozen.data.pack.path, "commands", "claude-code", "README.md"),
    "# foreign editor readme\nnot a bmad command\n",
  );
  for (const extra of [[], ["--no-commands"]]) {
    const repeat = runCli(cleanRegistry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      cleanRegistry.registry,
      ...extra,
    ]);
    assert.equal(repeat.exit, 0, JSON.stringify(repeat.findings));
    assert.equal(
      readFileSync(cleanManifestPath, "utf8"),
      cleanBytes,
      "foreign file alone must not trigger a manifest rewrite",
    );
  }
  // Legitimate generated update stays permitted on a clean inventory: a
  // recorded command file going missing republishes truthful counts while the
  // foreign README is neither counted, adopted, nor deleted.
  rmSync(join(cleanFrozen.data.pack.path, "commands", "claude-code", "bmad-alpha.agent.md"));
  const republished = runCli(cleanRegistry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    cleanRegistry.registry,
  ]);
  assert.equal(republished.exit, 0, JSON.stringify(republished.findings));
  const after = parseToml(readFileSync(cleanManifestPath, "utf8"));
  const claude = after.source.commands.find((entry) => entry.client === "claude-code");
  assert.equal(claude.files, 2, "clean inventory update reflects on-disk truth");
  assert.equal(
    readFileSync(join(cleanFrozen.data.pack.path, "commands", "claude-code", "README.md"), "utf8"),
    "# foreign editor readme\nnot a bmad command\n",
    "foreign file survives the legitimate republish untouched",
  );
  assert.equal(
    existsSync(join(cleanFrozen.data.pack.path, "commands", "claude-code", "bmad-alpha.agent.md")),
    true,
    "apply re-copies the missing recorded command file from the source",
  );
});

it("QF6g: client-authored field nested inside a [[source.commands]] entry refuses (missing BMAD command file does not license the sweep)", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  const frozen = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.findings));
  const manifestPath = join(frozen.data.pack.path, "pack.toml");
  // A nested hand-edit inside one inventory entry (unknown generated key).
  const document = parseToml(readFileSync(manifestPath, "utf8"));
  document.source.commands[0].note = "hand annotation";
  writeFileSync(manifestPath, stringifyToml(document));
  const edited = readFileSync(manifestPath, "utf8");
  // Recorded command file goes missing: still a refusal — authored metadata
  // inside the inventory is never deleted regardless of disk state.
  rmSync(join(frozen.data.pack.path, "commands", "claude-code", "bmad-alpha.agent.md"));
  const filesOnly = (rows) => rows.filter(([, , , kind]) => kind !== "directory");
  const digest = () => JSON.stringify(filesOnly(snapshot(registry.root)));
  const before = digest();
  for (const extra of [[], ["--no-commands"], ["--replace", "--no-commands"]]) {
    const planned = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      "--dry-run",
      ...extra,
    ]);
    finding(planned, "E_BMAD_FOREIGN_COLLISION");
    const applied = runCli(registry, [
      "bmad",
      "freeze",
      source.root,
      "--registry-root",
      registry.registry,
      ...extra,
    ]);
    finding(applied, "E_BMAD_FOREIGN_COLLISION");
    assert.equal(
      readFileSync(manifestPath, "utf8"),
      edited,
      "nested authored field must survive, missing file or not",
    );
    assert.equal(digest(), before, "zero-write refusal across the whole tree");
  }
});

it("QF6d: owned unmodified same-source repeat stays idempotent (byte-identical manifest) and normal upgrade/custom-version flows still work", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  const frozen = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.findings));
  const manifestPath = join(frozen.data.pack.path, "pack.toml");
  const modeBefore = lstatSync(manifestPath).mode & 0o777;
  const bytesBefore = readFileSync(manifestPath, "utf8");
  // Repeat with commands: still byte-identical manifest, mode preserved.
  const repeat = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(repeat.exit, 0, JSON.stringify(repeat.findings));
  assert.equal(repeat.data.skillsUnchanged, 2);
  assert.equal(readFileSync(manifestPath, "utf8"), bytesBefore, "repeat is byte-identical");
  assert.equal(lstatSync(manifestPath).mode & 0o777, modeBefore, "manifest mode preserved");
  // --no-commands repeat: identical bytes, command files preserved (QF3 contract).
  const quiet = runCli(registry, [
    "bmad",
    "freeze",
    source.root,
    "--registry-root",
    registry.registry,
    "--no-commands",
  ]);
  assert.equal(quiet.exit, 0, JSON.stringify(quiet.findings));
  assert.equal(readFileSync(manifestPath, "utf8"), bytesBefore);
  // Intentional version switch via --replace still works (separate new pack dir).
  const upgraded = bmadSourceFixture(t, "6.13.0", { changed: true });
  const replaced = runCli(registry, [
    "bmad",
    "freeze",
    upgraded.root,
    "--registry-root",
    registry.registry,
    "--replace",
  ]);
  assert.equal(replaced.exit, 0, JSON.stringify(replaced.findings));
  assert.equal(replaced.data.pack.version, "6.13.0");
  ok(await verifyPack("bmad@6.13.0", registry.options));
  // Custom-version override on a fresh registry still verifies green (QF1).
  const customSource = bmadSourceFixture(t, "6.12.1");
  const customRegistry = registryFixture(t);
  const custom = runCli(customRegistry, [
    "bmad",
    "freeze",
    customSource.root,
    "--registry-root",
    customRegistry.registry,
    "--version",
    "custom-9",
  ]);
  assert.equal(custom.exit, 0, JSON.stringify(custom.findings));
  ok(await verifyPack("bmad@custom-9", customRegistry.options));
});

// --- SKRILL-26 round-3: legacy flat pack families contain non-directory files ---

/** A legacy "flat" family (pack.toml directly in the family root, README beside it)
 *  plus sibling files in a versioned family must be skipped by the bmad status /
 *  explain walkers exactly like the generic packs resolver does. */
it("QF7: bmad status/explain survive non-directory files inside pack families; malformed real version directories still error", async (t) => {
  const source = bmadSourceFixture(t, "6.12.1");
  const registry = registryFixture(t);
  ok(await freezeBmadPack(source.root, registry.options));
  const packsRoot = join(registry.registry, "packs");
  // Flat legacy family: pack.toml + README.md + skills/ directly at family root.
  const flat = join(packsRoot, "folder-curator");
  mkdirSync(flat, { recursive: true });
  writeFileSync(
    join(flat, "pack.toml"),
    '[pack]\nname = "folder-curator"\nversion = "0.1.0"\n\n[freeform]\nskills = ["bmad-alpha"]\n',
  );
  writeFileSync(join(flat, "README.md"), "# legacy flat family readme\n");
  // Sibling non-directory files that sort beside and after versions in the bmad
  // family itself (mirrors packs/folder-curator/README.md from the live registry).
  writeFileSync(join(packsRoot, "bmad", "README.md"), "# not a version directory\n");
  // The walker must skip these files, not lstat README.md/pack.toml (ENOTDIR).
  const status = runCli(registry, ["bmad", "status", "--registry-root", registry.registry]);
  assert.equal(status.exit, 0, JSON.stringify(status.findings));
  assert.equal(status.ok, true);
  assert.equal(status.data.traced, 2);
  assert.equal(status.data.pack, "bmad@6.12.1");
  assert.equal(status.data.packVerified, true);
  // bmad-alpha is referenced by the flat family pack.toml too (generic resolver
  // semantics: flat family manifests are readable compositions).
  const explain = runCli(registry, [
    "bmad",
    "explain",
    "bmad-alpha",
    "--registry-root",
    registry.registry,
  ]);
  assert.equal(explain.exit, 0, JSON.stringify(explain.findings));
  const packRefs = explain.data.skill.references.filter(
    (reference) => reference.kind === "pack" && reference.name === "folder-curator",
  );
  assert.deepEqual(packRefs, []);
  // The live crash shape: a file that sorts BEFORE pack.toml siblings in another family.
  const strayFamily = join(packsRoot, "stray");
  mkdirSync(strayFamily, { recursive: true });
  writeFileSync(join(strayFamily, "0.txt"), "not a directory\n");
  // A malformed REAL version directory (pack.toml present but invalid) must still
  // surface as E_BMAD_COMPOSITION_INVALID, never swallowed by the new skip.
  const broken = join(packsRoot, "broken", "1.0.0");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "pack.toml"), "not [ valid toml [[[\n");
  const errored = runCli(registry, ["bmad", "status", "--registry-root", registry.registry]);
  assert.equal(errored.exit, 4, JSON.stringify(errored.findings));
  assert.equal(errored.ok, false);
  const invalid = errored.findings.find((entry) => entry.code === "E_BMAD_COMPOSITION_INVALID");
  assert.ok(invalid, JSON.stringify(errored.findings));
  assert.match(invalid.message, /broken@1\.0\.0/);
  // The stray files are preserved untouched.
  assert.equal(existsSync(join(flat, "README.md")), true);
  assert.equal(existsSync(join(packsRoot, "bmad", "README.md")), true);
});
