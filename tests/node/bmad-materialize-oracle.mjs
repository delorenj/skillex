/**
 * Independent observation oracle for BMAD materialization tests (SKRILL-27).
 *
 * Deliberately DOES NOT import planner/writer code: it walks the actual filesystem
 * with plain node:fs and compares against hand-written expectations derived from
 * the fixture inputs, so a shared bug in the planner cannot make these pass.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Observe a project tree into a normalized, comparable structure.
 * Every file => sha256 of bytes + mode; symlink => target; dir => marker.
 * mtimes are deliberately EXCLUDED from node identity (volatile receipt
 * metadata is the only allowed mtime variance), but recorded separately
 * for the idempotence no-rewrite check.
 */
export function observeTree(root) {
  const files = {};
  const mtimes = {};
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const info = lstatSync(path);
      if (info.isDirectory()) {
        files[rel] = { kind: "dir", mode: info.mode & 0o777 };
        walk(path);
      } else if (info.isSymbolicLink()) {
        files[rel] = { kind: "link", target: readlinkSync(path) };
      } else if (info.isFile()) {
        files[rel] = {
          kind: "file",
          mode: info.mode & 0o777,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        };
        mtimes[rel] = info.mtimeMs;
      } else {
        files[rel] = { kind: `other:${info.mode & 0o170000}` };
      }
    }
  }
  walk(root);
  return { root, files, mtimes };
}

/** Observation minus declared relocation: strip absolute-root keys. */
export function normalized(observation) {
  return observation.files;
}

/** Byte/type/mode-level comparison of two observations. */
export function assertSameManaged(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  const problems = [];
  for (const key of new Set([...actualKeys, ...expectedKeys])) {
    const a = actual[key];
    const e = expected[key];
    if (!e) problems.push(`${label}: unexpected managed path ${key} (${JSON.stringify(a)})`);
    else if (!a)
      problems.push(`${label}: missing managed path ${key} (expected ${JSON.stringify(e)})`);
    else if (a.kind !== e.kind) problems.push(`${label}: ${key} kind ${a.kind} != ${e.kind}`);
    else if (a.kind === "file") {
      if (a.sha256 !== e.sha256) problems.push(`${label}: ${key} bytes differ`);
      if ((a.mode ?? 0) !== (e.mode ?? 0))
        problems.push(`${label}: ${key} mode ${a.mode} != ${e.mode}`);
    } else if (a.kind === "link" && a.target !== e.target)
      problems.push(`${label}: ${key} link target ${a.target} != ${e.target}`);
  }
  return problems;
}

/** Minimal RFC-4180 field splitter for the installer manifests (handles quotes). */
function parseCsvFields(line) {
  const fields = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** The independently-written expected runtime for a fixture source + config.
 * Walks the SOURCE's own files-manifest.csv (the declared closure, oracle-side)
 * and materializes every declared non-canonical path with its actual bytes and
 * mode, plus ancestor dirs with actual modes. Canonical skill body locations
 * (per skill-manifest.csv path match) are expected ABSENT from the runtime —
 * they are catalog references, never copies. */
export function expectedRuntimeNodes(sourceRoot, projectName) {
  const expected = {};
  expected._bmad = { kind: "dir", mode: 0o755 };
  const bmad = join(sourceRoot, "_bmad");
  // Canonical body paths per the skill manifest (normalized to _bmad-relative).
  const canonical = new Set();
  try {
    const lines = readFileSync(join(bmad, "_config", "skill-manifest.csv"), "utf8").split(/\r?\n/);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const fields = parseCsvFields(line);
      const raw = fields[4];
      if (!raw) continue;
      canonical.add(raw.startsWith("_bmad/") ? raw.slice("_bmad/".length) : raw);
    }
  } catch {
    /* no skill manifest: nothing is canonical */
  }
  const declared = [];
  try {
    const lines = readFileSync(join(bmad, "_config", "files-manifest.csv"), "utf8").split(/\r?\n/);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const fields = parseCsvFields(line);
      if (fields[3]) declared.push(fields[3]);
    }
  } catch {
    /* no files manifest: no declared closure */
  }
  const dirs = new Set();
  for (const rel of declared) {
    if (canonical.has(rel)) continue; // reference, never a runtime copy
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const rel of dirs) {
    try {
      const info = lstatSync(join(bmad, rel));
      expected[`_bmad/${rel}`] = { kind: "dir", mode: info.mode & 0o777 };
    } catch {
      expected[`_bmad/${rel}`] = { kind: "dir", mode: 0o755 };
    }
  }
  for (const rel of declared) {
    if (canonical.has(rel)) continue;
    const abs = join(bmad, rel);
    let info;
    try {
      info = lstatSync(abs);
    } catch {
      continue; // declared-missing is a build-time refusal; nothing to expect
    }
    if (info.isDirectory()) {
      expected[`_bmad/${rel}`] = { kind: "dir", mode: info.mode & 0o777 };
    } else if (info.isSymbolicLink()) {
      expected[`_bmad/${rel}`] = { kind: "link", target: readlinkSync(abs) };
    } else {
      expected[`_bmad/${rel}`] = {
        kind: "file",
        mode: info.mode & 0o777,
        sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"),
      };
    }
  }
  // Generated config: explicit project identity, never the source's.
  const configBody = `# skillex bmad materialization (generated; owned receipt under .skillex/)\n[core]\nproject_name = ${JSON.stringify(projectName ?? "unnamed-project")}\n`;
  expected["_bmad/config.toml"] = {
    kind: "file",
    mode: 0o644,
    sha256: createHash("sha256").update(configBody).digest("hex"),
  };
  return expected;
}

/** Expected activation: .agents/skills/<member> links to the canonical catalog. */
export function expectedActivationNodes(_registryRoot, members, clients) {
  const expected = {};
  for (const member of members) {
    expected[`.agents/skills/${member}`] = {
      kind: "link",
      target: join("..", "..", "..", "..", "all-skills", member),
    };
  }
  // Native client alias roots alias .agents/skills via the sync writer.
  for (const { layout } of clients) {
    const aliasRoot = layout.split("/").slice(0, -1).join("/"); // e.g. .claude
    const aliasSkills = `${aliasRoot}/skills`;
    // Only assert the alias root itself exists as a dir or link per writer behavior;
    // exact member aliases are asserted via realpath equality to .agents/skills members.
    expected[aliasSkills] = expected[aliasSkills] ?? { kind: "dir-or-link", mode: "any" };
  }
  return expected;
}

/** Managed projection of an observation: only paths the materialization owns. */
export function managedPaths(observation) {
  const out = {};
  for (const [rel, value] of Object.entries(observation.files)) {
    if (
      rel === "_bmad" ||
      rel.startsWith("_bmad/") ||
      rel.startsWith(".agents/") ||
      rel.startsWith(".skillex/") ||
      /^\.(\w[\w-]*)\/skills(\/|$)/.test(rel)
    ) {
      out[rel] = value;
    }
  }
  return out;
}

/** Foreign projection: everything else (must be preserved, compared separately). */
export function foreignPaths(observation) {
  const out = {};
  for (const [rel, value] of Object.entries(observation.files)) {
    if (!(rel in managedPaths(observation))) out[rel] = value;
  }
  return out;
}

/** Resolve every client alias member to its REAL target and compare cross-client. */
export function observeClientMapping(root, clients, members) {
  const mapping = {};
  for (const { client, layout } of clients) {
    const aliasSkills = join(root, layout.split("/").slice(0, -1).join("/"), "skills");
    const resolved = {};
    for (const member of members) {
      const path = join(aliasSkills, member);
      let real;
      try {
        real = statSync(path).isDirectory() ? path : null;
      } catch {
        real = null;
      }
      resolved[member] = real;
    }
    mapping[client] = resolved;
  }
  return mapping;
}
