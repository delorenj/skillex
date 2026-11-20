import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { inspectStatus } from "./diagnostics.js";
import { fail, SkillexError } from "./error.js";
import { parseSkillMetadata } from "./metadata.js";
import { discoverProfile, discoverProfileRoot } from "./profile-discovery.js";
import { showProfile } from "./profiles.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions, SkillOrigin } from "./selection.js";
import {
  finishEdges,
  graphHealth,
  type SkillContextEntry,
  type SkillContextStatus,
  type SkillGraphContextInfo,
  type SkillGraphContextKind,
  type SkillGraphData,
  type SkillGraphEdge,
  type SkillGraphNode,
  type SkillGraphOptions,
  scanSkillText,
  skillGraph,
  summarizeGraph,
} from "./skill-graph.js";

/**
 * Context graphs: the skill graph restricted to what one agent context can load right now.
 *
 * Nothing here is stored. Every call reads the context's skill roots from disk, through the
 * runtime's own resolver where one exists (Hermes profiles are read by Hermes' skill catalog,
 * so tiers, trust, quarantine, disabled names and nested skills match what the agent sees),
 * and through `skillex status` for the canonical roots that Claude Code, Codex, Gemini and
 * OpenCode alias.
 *
 * Context spellings (`--context`, `?context=`):
 * - `auto`            detect from the directory (default)
 * - `catalog`         every definition, no context
 * - `global`          ~/.agents/skills
 * - `project:<dir>`   the project at <dir>: its bound PM when .project.json names one
 * - `profile:<name>`  a Hermes profile, from its configured working directory
 */

export interface SkillGraphContextOptions extends SkillGraphOptions {
  readonly context?: string;
  readonly hermesRoot?: string;
  /** The hermes-agent checkout whose resolver reads profiles (default <hermes root>/hermes-agent). */
  readonly hermesAgent?: string;
  readonly focus?: readonly string[];
  readonly depth?: number;
}

type ContextSpec =
  | { readonly kind: "auto" }
  | { readonly kind: "catalog" }
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "profile"; readonly name: string; readonly project?: string };

export const contextStatuses: readonly SkillContextStatus[] = [
  "loaded",
  "shadowed",
  "ambiguous",
  "disabled",
  "quarantined",
  "broken",
  "missing",
  "unavailable",
];

/** One skill a context resolves, before it is joined to the catalog. */
interface ContextSkill {
  readonly name: string;
  /** Canonical directory of the skill (null when missing or dangling). */
  readonly dir: string | null;
  readonly entry: string | null;
  readonly tier: string | null;
  readonly status: SkillContextStatus;
  readonly detail?: string;
}

interface ContextView {
  readonly info: Omit<SkillGraphContextInfo, "counts">;
  readonly skills: readonly ContextSkill[];
  /** set/pack references the context's manifests select (`name` or `name@version`). */
  readonly compositions: readonly string[];
  readonly findings: readonly Diagnostic[];
}

function usage(message: string, fix: string): never {
  return fail("E_CONTEXT", message, { fix }, ExitCode.CONFIG);
}

export function parseContextSpec(spec: string | undefined, cwd: string): ContextSpec {
  const text = (spec ?? "auto").trim();
  if (text === "" || text === "auto") return { kind: "auto" };
  if (text === "catalog") return { kind: "catalog" };
  if (text === "global") return { kind: "global" };
  const colon = text.indexOf(":");
  const kind = colon === -1 ? text : text.slice(0, colon);
  const value = colon === -1 ? "" : text.slice(colon + 1);
  if (kind === "project" && value) return { kind: "project", path: resolve(cwd, value) };
  if (kind === "profile" && value) return { kind: "profile", name: value };
  return usage(
    `Unknown context: ${text}`,
    "Use auto, catalog, global, project:<dir> or profile:<hermes profile>.",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path (following links) is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** pjangler's rule: the nearest ancestor holding .project.json, never HOME or the filesystem root. */
async function nearestPjProject(start: string, home: string): Promise<string | null> {
  let current = resolve(start);
  while (current !== home && current !== parse(current).root) {
    if (await exists(join(current, ".project.json"))) return current;
    current = dirname(current);
  }
  return null;
}

/** pjangler's readProjectPm: agents with role "pm", preferring <slug>-pm. */
async function boundPm(root: string): Promise<{ pm: string | null; finding?: Diagnostic }> {
  const path = join(root, ".project.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return {
      pm: null,
      finding: {
        code: "W_CONTEXT_PROJECT_MANIFEST",
        severity: "warning",
        message: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      },
    };
  }
  const slug =
    (typeof manifest.project_id === "string" && manifest.project_id) ||
    (typeof manifest.project_slug === "string" && manifest.project_slug) ||
    basename(root);
  const agents =
    manifest.agents && typeof manifest.agents === "object"
      ? (manifest.agents as Record<string, unknown>)
      : {};
  const pms = Object.entries(agents)
    .filter(
      ([, value]) =>
        value && typeof value === "object" && (value as Record<string, unknown>).role === "pm",
    )
    .map(([name]) => name);
  return { pm: pms.find((name) => name === `${slug}-pm`) ?? pms[0] ?? null };
}

async function profileExists(name: string, options: SkillGraphContextOptions): Promise<boolean> {
  try {
    await discoverProfile(name, profileOptions(options));
    return true;
  } catch {
    return false;
  }
}

function profileOptions(options: SkillGraphContextOptions) {
  return {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.registryRoot === undefined ? {} : { registryRoot: options.registryRoot }),
    ...(options.hermesRoot === undefined ? {} : { hermesRoot: options.hermesRoot }),
  };
}

/** The Hermes profile a shell runs inside (HERMES_HOME=<root>/profiles/<name>), if any. */
function sessionProfile(env: Readonly<Record<string, string | undefined>>): string | null {
  const home = env.HERMES_HOME;
  if (!home) return null;
  const path = resolve(home);
  return basename(dirname(path)) === "profiles" ? basename(path) : null;
}

/**
 * Resolve a spec to a concrete context. `auto` and `project:<dir>` follow the bound-PM rule:
 * a Hermes session's own profile, else the PM a .project.json names, else the skillex project
 * manifest, else global.
 */
async function concreteSpec(
  spec: ContextSpec,
  options: SkillGraphContextOptions,
  findings: Diagnostic[],
): Promise<{ spec: Exclude<ContextSpec, { kind: "auto" }>; detectedFrom: string | null }> {
  if (spec.kind !== "auto" && spec.kind !== "project") return { spec, detectedFrom: null };
  const home = resolve(options.home ?? homedir());
  const start = spec.kind === "project" ? spec.path : resolve(options.cwd ?? process.cwd());
  if (spec.kind === "project" && !(await isDirectory(spec.path)))
    usage(
      `${spec.path} is not a directory.`,
      "Point project:<dir> at an existing project directory.",
    );
  if (spec.kind === "auto") {
    const session = sessionProfile(options.env ?? process.env);
    if (session && (await profileExists(session, options)))
      return {
        spec: { kind: "profile", name: session, project: start },
        detectedFrom: `HERMES_HOME (${session})`,
      };
  }
  const pjRoot = await nearestPjProject(start, home);
  if (pjRoot) {
    const { pm, finding } = await boundPm(pjRoot);
    if (finding) findings.push(finding);
    if (pm) {
      if (await profileExists(pm, options))
        return {
          spec: { kind: "profile", name: pm, project: pjRoot },
          detectedFrom: `${join(pjRoot, ".project.json")} (bound PM ${pm})`,
        };
      findings.push({
        code: "W_CONTEXT_PM_PROFILE_MISSING",
        severity: "warning",
        message: `${join(pjRoot, ".project.json")} binds PM ${pm}, but no Hermes profile ${pm} exists.`,
        name: pm,
        fix: "Provision the PM's Hermes profile, or correct agents.<name> in .project.json.",
      });
    }
  }
  try {
    const status = await inspectStatus({ ...registryOnly(options), cwd: start, scope: "auto" });
    const project = status.data?.scopes.find((scope) => scope.scope === "project");
    if (project)
      return {
        spec: { kind: "project", path: project.root },
        detectedFrom: join(project.root, ".agents", "skills.json"),
      };
  } catch {
    // No project manifest: fall through to global.
  }
  if (spec.kind === "project")
    usage(
      `No project with skills was found at ${spec.path}.`,
      "Point project:<dir> at a directory with .project.json (bound PM) or .agents/skills.json.",
    );
  return { spec: { kind: "global" }, detectedFrom: pjRoot ?? start };
}

function registryOnly(options: SkillGraphContextOptions): RegistryOptions {
  return {
    ...(options.registryRoot === undefined ? {} : { registryRoot: options.registryRoot }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.installedRoot === undefined ? {} : { installedRoot: options.installedRoot }),
  };
}

function compositionRefs(origins: readonly SkillOrigin[]): string[] {
  return origins
    .filter((origin) => origin.kind === "set" || origin.kind === "pack")
    .map((origin) => `${origin.kind}:${origin.reference}`);
}

/** Canonical roots (global, and a project scope when there is one): what `skillex status` sees. */
async function rootsView(
  spec: { kind: "global" } | { kind: "project"; path: string },
  detectedFrom: string | null,
  options: SkillGraphContextOptions,
): Promise<ContextView> {
  const status = await inspectStatus({
    ...registryOnly(options),
    cwd: spec.kind === "project" ? spec.path : (options.cwd ?? process.cwd()),
    scope: spec.kind === "project" ? "both" : "global",
  });
  if (!status.data) {
    if (status.findings.length) throw new SkillexError(status.exit, status.findings);
    fail("E_CONTEXT", "skillex status returned no data.", {}, status.exit);
  }
  const skills: ContextSkill[] = [];
  const compositions = new Set<string>();
  for (const scope of status.data.resolution?.scopes ?? []) {
    if (scope.set) compositions.add(`set:${scope.set.name}`);
    for (const binding of scope.bindings)
      for (const ref of compositionRefs(binding.origins)) compositions.add(ref);
  }
  // Project scope first: it is the higher-precedence tier.
  const scopes = [...status.data.scopes].sort((a, b) =>
    a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1,
  );
  const loadedNames = new Map<string, string | null>();
  for (const scope of scopes) {
    const seen = new Set<string>();
    for (const entry of scope.actual.entries) {
      if (entry.name.startsWith(".")) continue;
      seen.add(entry.name);
      const dir = entry.target ?? (entry.kind === "directory" ? entry.path : null);
      if (dir === null || !(await isFile(join(dir, "SKILL.md")))) {
        // A plain directory without SKILL.md is not a skill (support folders, stubs); a link
        // that resolves nowhere, or to a directory with no SKILL.md, is a broken entry.
        if (entry.kind === "link")
          skills.push({
            name: entry.name,
            dir,
            entry: entry.path,
            tier: scope.scope,
            status: "broken",
            detail:
              dir === null
                ? `dangling link to ${entry.rawTarget ?? "?"}`
                : `${dir} has no SKILL.md`,
          });
        continue;
      }
      const earlier = loadedNames.get(entry.name);
      const shadowed = loadedNames.has(entry.name);
      if (!shadowed) loadedNames.set(entry.name, dir);
      skills.push({
        name: entry.name,
        dir,
        entry: entry.path,
        tier: scope.scope,
        status: shadowed ? "shadowed" : "loaded",
        ...(shadowed && earlier !== dir ? { detail: `the project copy ${earlier} wins` } : {}),
      });
    }
    for (const name of scope.desired ?? [])
      if (!seen.has(name) && !loadedNames.has(name))
        skills.push({
          name,
          dir: null,
          entry: null,
          tier: scope.scope,
          status: "missing",
          detail: `selected by ${scope.manifestPath}`,
        });
  }
  const project = spec.kind === "project" ? spec.path : null;
  return {
    info: {
      kind: spec.kind,
      id: project ? `project:${project}` : "global",
      label: project ? `project ${basename(project)}` : "global (~/.agents/skills)",
      profile: null,
      project,
      detectedFrom,
      resolver: "skillex status: the canonical roots Claude Code, Codex, Gemini and OpenCode alias",
      roots: scopes.map((scope) => ({ tier: scope.scope, path: scope.actual.root.path })),
    },
    skills,
    compositions: [...compositions],
    findings: status.findings.filter((finding) => finding.severity === "error"),
  };
}

/**
 * Asks Hermes' own skill catalog what a profile loads, so tiers, trust, quarantine, disabled
 * names and nested skills are Hermes' answer rather than a copy of its rules.
 */
const HERMES_PROBE = `
import json, logging, os, sys
real_stdout = sys.stdout
sys.stdout = sys.stderr
logging.disable(logging.CRITICAL)
agent_dir, cwd = sys.argv[1], sys.argv[2]
sys.path.insert(0, agent_dir)
if not cwd:
    try:
        from hermes_cli.config import load_config
        cwd = str(((load_config() or {}).get("terminal") or {}).get("cwd") or "")
    except Exception:
        cwd = ""
if cwd:
    os.environ["TERMINAL_CWD"] = cwd
from agent import skill_utils as su
from tools import skills_tool as st
roots, _ = st.skill_search_dirs()
everything = st._skill_catalog(skip_disabled=True, include_hidden=True)
shown = {str(s["path"]) for s in st._skill_catalog(skip_disabled=True)}
enabled = {str(s["path"]) for s in st._skill_catalog(include_hidden=True)}
# What skill_view(name) would do, without reading or rendering the skill: Hermes' own locate_skill
# (precedence, same-tier refusal, identical-copy dedupe, quarantine gate).
locate = getattr(st, "locate_skill", None)
looked = {}
# One probe reads one snapshot, so the loader's per-name rescans can share their reads (this keeps
# a few hundred lookups under a second instead of re-parsing every SKILL.md for every name).
_frontmatter, _fm_cache = st._safe_frontmatter, {}
def _cached_frontmatter(path=None, *, content=None):
    if content is not None:
        return _frontmatter(content=content)
    key = str(path)
    if key not in _fm_cache:
        _fm_cache[key] = _frontmatter(path)
    return _fm_cache[key]
_index, _index_cache = su.iter_skill_index_files, {}
def _cached_index(*args):
    key = tuple(str(a) for a in args)
    if key not in _index_cache:
        _index_cache[key] = list(_index(*args))
    return iter(_index_cache[key])
if locate is not None:
    st._safe_frontmatter = _cached_frontmatter
    su.iter_skill_index_files = _cached_index
def lookup(name):
    if locate is None:
        return None
    if name not in looked:
        try:
            error, _sd, md = locate(name, None, roots)
            if error is None:
                looked[name] = {"ok": True, "path": str(md), "error": None}
            else:
                try:
                    message = json.loads(error).get("error") or str(error)
                except Exception:
                    message = str(error)
                looked[name] = {"ok": False, "path": None, "error": str(message)}
        except Exception as e:
            looked[name] = {"ok": False, "path": None, "error": f"{type(e).__name__}: {e}"}
    return looked[name]
rows = []
for s in everything:
    p = str(s["path"])
    load = s.get("load_name") or str(s["name"])
    rows.append({"name": str(s["name"]), "load_name": s.get("load_name"), "status": s.get("status"),
                 "tier": int(s["tier"]), "root": str(s["root"]), "path": p,
                 "hidden": p not in shown, "disabled": p not in enabled, "lookup": lookup(load)})
quarantined = []
for tier, d in roots:
    if tier != su.TIER_PROJECT:
        continue
    allowed = {str(p) for p in su.iter_project_skill_files(d)}
    for p in su.iter_skill_index_files(d, "SKILL.md"):
        if any(part in su.EXCLUDED_SKILL_DIRS for part in p.parts):
            continue
        if str(p) not in allowed:
            quarantined.append({"path": str(p), "root": str(d), "tier": int(tier)})
real_stdout.write(json.dumps({"cwd": cwd or None, "roots": [{"tier": int(t), "path": str(d)} for t, d in roots],
                              "rows": rows, "quarantined": quarantined}))
`;

interface HermesProbe {
  readonly cwd: string | null;
  readonly roots: readonly { tier: number; path: string }[];
  readonly rows: readonly {
    name: string;
    load_name: string | null;
    status: "unique" | "ambiguous" | "shadowed";
    tier: number;
    root: string;
    path: string;
    hidden: boolean;
    disabled: boolean;
    /** Hermes' locate_skill for the name an agent loads this row by; null on an older Hermes. */
    lookup?: { ok: boolean; path: string | null; error: string | null } | null;
  }[];
  readonly quarantined: readonly { path: string; root: string; tier: number }[];
}

const hermesTiers = ["project", "profile", "create_dir", "external"];

function runProbe(
  python: string,
  agent: string,
  profileHome: string,
  cwd: string,
): Promise<string> {
  return new Promise((done, failed) => {
    execFile(
      python,
      ["-I", "-c", HERMES_PROBE, agent, cwd],
      {
        env: { ...process.env, HERMES_HOME: profileHome },
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) failed(new Error(`${error.message}\n${String(stderr).slice(-800)}`));
        else done(String(stdout));
      },
    );
  });
}

async function skillName(skillMd: string): Promise<string> {
  try {
    const meta = parseSkillMetadata(await readFile(skillMd, "utf8"), skillMd);
    if (typeof meta.name === "string" && meta.name) return meta.name;
  } catch {
    // Fall back to the directory name, as Hermes does.
  }
  return basename(dirname(skillMd));
}

async function profileView(
  spec: { kind: "profile"; name: string; project?: string },
  detectedFrom: string | null,
  options: SkillGraphContextOptions,
): Promise<ContextView> {
  const profile = await discoverProfile(spec.name, profileOptions(options));
  const hermesRoot = await discoverProfileRoot(profileOptions(options));
  const env = options.env ?? process.env;
  const agent = resolve(
    options.hermesAgent ??
      env.HERMES_AGENT_DIR ??
      join(hermesRoot.root ?? hermesRoot.path, "hermes-agent"),
  );
  const python = join(agent, "venv", "bin", "python");
  if (!(await exists(python)))
    fail(
      "E_HERMES_AGENT",
      `Hermes' resolver is not available: ${python} does not exist.`,
      {
        path: python,
        fix: "Pass --hermes-agent <hermes-agent checkout> (or set HERMES_AGENT_DIR); a profile view is read by Hermes itself, never guessed.",
      },
      ExitCode.CONFIG,
    );
  let probe: HermesProbe;
  try {
    probe = JSON.parse(
      await runProbe(python, agent, profile.root, spec.project ?? ""),
    ) as HermesProbe;
  } catch (error) {
    fail(
      "E_HERMES_PROBE",
      `Hermes' skill catalog could not be read for ${spec.name}: ${error instanceof Error ? error.message : String(error)}`,
      { name: spec.name },
      ExitCode.FAILURE,
    );
  }
  const skills: ContextSkill[] = [];
  const loadable = new Set<string>();
  for (const row of probe.rows) {
    const loadName = row.load_name ?? row.name;
    const dir = await canonical(dirname(row.path));
    let status: SkillContextStatus;
    let detail: string | undefined;
    if (row.disabled || row.hidden) {
      status = "disabled";
      detail = row.hidden
        ? "hidden by a platform, environment or app gate"
        : "listed in skills.disabled";
    } else if (row.lookup) {
      // Loadable means Hermes' loader serves this very file for the name, nothing less.
      // Compared as Hermes names it: an identical copy in another root is not the one it serves.
      const served = row.lookup.ok && row.lookup.path ? resolve(dirname(row.lookup.path)) : null;
      if (row.lookup.ok && served === resolve(dirname(row.path))) status = "loaded";
      else if (row.lookup.ok) {
        status = "shadowed";
        detail = `${loadName} resolves to ${row.lookup.path}`;
      } else if (/ambiguous|share this name/i.test(row.lookup.error ?? "")) {
        status = "ambiguous";
        detail = "another same-tier skill shares this name";
      } else if (/quarantined/i.test(row.lookup.error ?? "")) {
        status = "shadowed";
        detail = `a quarantined project copy owns the name ${loadName}, so Hermes refuses it`;
      } else {
        status = "broken";
        detail = row.lookup.error ?? "Hermes cannot load it";
      }
    } else {
      // An older Hermes without locate_skill: its catalog status is the best evidence.
      status =
        row.status === "shadowed"
          ? "shadowed"
          : row.status === "ambiguous"
            ? "ambiguous"
            : "loaded";
      if (status === "ambiguous") detail = "another same-tier skill shares this name";
    }
    if (status === "loaded") loadable.add(loadName);
    skills.push({
      name: loadName,
      dir,
      entry: dirname(row.path),
      tier: hermesTiers[row.tier] ?? String(row.tier),
      status,
      ...(detail ? { detail } : {}),
    });
  }
  for (const item of probe.quarantined) {
    const name = await skillName(item.path);
    skills.push({
      name,
      dir: await canonical(dirname(item.path)),
      entry: dirname(item.path),
      tier: hermesTiers[item.tier] ?? String(item.tier),
      status: "quarantined",
      detail: loadable.has(name)
        ? "Hermes' scanner refused this project copy; another tier still provides the name"
        : "Hermes' scanner refused this project copy and nothing else provides the name",
    });
  }
  // What skillex selected for this profile but has not reached it yet.
  const compositions = new Set<string>();
  const findings: Diagnostic[] = [];
  const project = spec.project ?? probe.cwd ?? null;
  const shown = await showProfile(spec.name, {
    ...profileOptions(options),
    ...(project ? { project } : {}),
  });
  for (const candidate of shown.data?.managed ?? []) {
    for (const ref of compositionRefs(candidate.origins)) compositions.add(ref);
    if (candidate.state === "create" && !loadable.has(candidate.name))
      skills.push({
        name: candidate.name,
        dir: await canonical(candidate.target),
        entry: candidate.path,
        tier: "profile",
        status: "missing",
        detail: `selected by ${candidate.origins.map((origin) => origin.manifest).join(", ")}; run skillex profile sync ${spec.name}`,
      });
  }
  if (shown.data === null)
    findings.push(
      ...shown.findings.map((finding) => ({
        ...finding,
        severity: "warning" as const,
        message: `skillex profile show: ${finding.message}`,
      })),
    );
  return {
    info: {
      kind: "profile",
      id: `profile:${spec.name}`,
      label: `${spec.name}${project ? ` @ ${basename(project)}` : ""}`,
      profile: spec.name,
      project,
      detectedFrom,
      resolver: `Hermes skill catalog (${agent})`,
      roots: probe.roots.map((root) => ({
        tier: hermesTiers[root.tier] ?? String(root.tier),
        path: root.path,
      })),
    },
    skills,
    compositions: [...compositions],
    findings,
  };
}

const contextFinding: Partial<
  Record<SkillContextStatus, { code: string; severity: Diagnostic["severity"]; message: string }>
> = {
  broken: { code: "E_CONTEXT_BROKEN", severity: "error", message: "The entry cannot be loaded" },
  missing: {
    code: "E_CONTEXT_MISSING",
    severity: "error",
    message: "Selected, but not on disk in this context",
  },
  ambiguous: {
    code: "E_CONTEXT_AMBIGUOUS",
    severity: "error",
    message: "Two different same-tier skills share this name; the agent refuses both",
  },
  quarantined: {
    code: "W_CONTEXT_QUARANTINED",
    severity: "warning",
    message: "The runtime's scanner refused this copy",
  },
  disabled: { code: "I_CONTEXT_DISABLED", severity: "info", message: "Present but switched off" },
  shadowed: {
    code: "I_CONTEXT_SHADOWED",
    severity: "info",
    message: "A higher-precedence copy owns this name",
  },
};

/** A node's headline status: loadable first, then the most actionable problem. */
const nodeStatusOrder: readonly SkillContextStatus[] = [
  "loaded",
  "ambiguous",
  "broken",
  "missing",
  "quarantined",
  "disabled",
  "shadowed",
  "unavailable",
];
const statusRank = (status: SkillContextStatus) => nodeStatusOrder.indexOf(status);

/** Join a context's skills to the catalog graph: only what the context can see, plus what it points at. */
export async function applyContext(
  catalog: SkillGraphData,
  view: ContextView,
): Promise<SkillGraphData> {
  const catalogNodes = new Map(catalog.nodes.map((node) => [node.id, node]));
  const skillKinds = new Set(["hub", "vendored", "wild"]);
  const byPath = new Map<string, SkillGraphNode>();
  const catalogByName = new Map<string, SkillGraphNode>();
  for (const node of catalog.nodes) {
    if (!skillKinds.has(node.kind)) continue;
    catalogByName.set(node.name, node);
    const key = node.path === null ? null : await canonical(node.path);
    if (key) byPath.set(key, node);
  }

  interface Building {
    node: SkillGraphNode;
    entries: SkillContextEntry[];
    findings: Diagnostic[];
  }
  const included = new Map<string, Building>();
  const localIds = new Map<string, string>();
  const locals: { id: string; dir: string; name: string }[] = [];
  for (const skill of view.skills) {
    let id: string;
    const matched = skill.dir === null ? undefined : byPath.get(skill.dir);
    if (matched) id = matched.id;
    else if (skill.dir === null && catalogByName.has(skill.name))
      id = (catalogByName.get(skill.name) as SkillGraphNode).id;
    else {
      const key = skill.dir ?? `${skill.tier}:${skill.entry ?? skill.name}`;
      let local = localIds.get(key);
      if (!local) {
        local = `local:${skill.name}`;
        for (let n = 2; [...localIds.values()].includes(local); n += 1)
          local = `local:${skill.name}#${n}`;
        localIds.set(key, local);
      }
      id = local;
    }
    let building = included.get(id);
    if (!building) {
      const base = catalogNodes.get(id);
      const copyOf = base ? null : catalogByName.get(skill.name);
      building = {
        node: base ?? {
          id,
          kind: "local",
          name: skill.name,
          path: skill.dir ?? skill.entry,
          description: null,
          source: null,
          repo: null,
          root: null,
          origin: null,
          health: "ok",
          findings: [],
        },
        entries: [],
        findings: [...(base?.findings ?? [])],
      };
      if (copyOf)
        building.findings.push({
          code: "I_CONTEXT_COPY",
          severity: "info",
          message: `A copy of the catalog skill ${skill.name}, not a link to it; the copy can drift.`,
          name: skill.name,
          ...((skill.dir ?? skill.entry) ? { path: (skill.dir ?? skill.entry) as string } : {}),
          ...(copyOf.path ? { detail: [copyOf.path] } : {}),
          fix: "Link the catalog definition instead of copying it, or rename the local skill.",
        });
      if (!base && skill.dir) locals.push({ id, dir: skill.dir, name: skill.name });
      included.set(id, building);
    }
    building.entries.push({
      name: skill.name,
      status: skill.status,
      tier: skill.tier,
      entry: skill.entry,
    });
  }

  // Context findings, judged per node once every entry is known.
  for (const building of included.values()) {
    const statuses = new Set(building.entries.map((entry) => entry.status));
    const seen = new Set<string>();
    const ambiguous = building.entries.filter((entry) => entry.status === "ambiguous");
    for (const skill of view.skills) {
      if (
        !building.entries.some((entry) => entry.entry === skill.entry && entry.name === skill.name)
      )
        continue;
      const finding = contextFinding[skill.status];
      if (!finding) continue;
      // An identical copy losing to the same skill elsewhere hides nothing.
      if (skill.status === "shadowed" && [...statuses].some((status) => status !== "shadowed"))
        continue;
      let code = finding.code;
      let severity = finding.severity;
      let message = `${finding.message}${skill.tier ? ` (${skill.tier} tier)` : ""}${skill.detail ? `: ${skill.detail}` : ""}.`;
      if (skill.status === "quarantined" && !skill.detail?.includes("nothing else")) {
        code = "I_CONTEXT_QUARANTINED";
        severity = "info";
      } else if (skill.status === "quarantined") {
        code = "E_CONTEXT_QUARANTINED";
        severity = "error";
      } else if (skill.status === "ambiguous" && ambiguous.length > 1) {
        message = `The same skill is reachable under ${ambiguous.length} entries in the ${skill.tier} tier (${ambiguous.map((entry) => entry.entry).join(", ")}); the runtime refuses an ambiguous name, so ${[...new Set(ambiguous.map((entry) => entry.name))].join(" and ")} cannot be loaded by name.`;
      }
      const key = `${code}\u0000${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      building.findings.push({
        code,
        severity,
        message,
        name: skill.name,
        ...(skill.entry ? { path: skill.entry } : {}),
        ...(skill.status === "ambiguous"
          ? { fix: "Keep one entry per skill in that root; remove the duplicate link." }
          : {}),
      } as Diagnostic);
    }
  }

  // Descriptions for local skills.
  for (const local of locals) {
    const building = included.get(local.id) as Building;
    try {
      const file = join(local.dir, "SKILL.md");
      const meta = parseSkillMetadata(await readFile(file, "utf8"), file);
      if (typeof meta.description === "string")
        building.node = { ...building.node, description: meta.description };
    } catch {
      // A local skill without readable frontmatter keeps a null description.
    }
  }

  // The name an agent loads resolves to the node it actually gets.
  const loadedByName = new Map<string, string>();
  const presentByName = new Map<string, string>();
  for (const [id, building] of included)
    for (const entry of building.entries) {
      if (entry.status === "loaded" && !loadedByName.has(entry.name))
        loadedByName.set(entry.name, id);
      if (!presentByName.has(entry.name)) presentByName.set(entry.name, id);
    }
  const ghosts = new Map<string, SkillGraphNode>();
  const target = (name: string): string | null => {
    const id = loadedByName.get(name) ?? presentByName.get(name);
    if (id) return id;
    const node = catalogByName.get(name);
    if (!node) return null;
    if (included.has(node.id)) return node.id;
    if (!ghosts.has(node.id))
      ghosts.set(node.id, {
        ...node,
        health: "ok",
        findings: [],
        context: { status: "unavailable", entries: [] },
      });
    return node.id;
  };

  const edges: SkillGraphEdge[] = [];
  const subskills = new Map<string, SkillGraphNode>();
  const subOwner = new Map<string, string>();
  for (const e of catalog.edges)
    if (e.kind === "routes" && included.has(e.from)) subOwner.set(e.to, e.from);
  // Catalog edges out of included skills (and their sub-skills), retargeted by name.
  const ownerOf = (id: string): string | null =>
    included.has(id) ? id : (subOwner.get(id) ?? null);
  for (const e of catalog.edges) {
    const owner = ownerOf(e.from);
    if (!owner) continue;
    if (e.kind === "routes") {
      const sub = catalogNodes.get(e.to);
      if (sub) subskills.set(sub.id, sub);
      edges.push(e);
    } else if (e.kind === "loads" || e.kind === "mentions") {
      const to = target(e.to.slice("skill:".length));
      if (to) edges.push({ ...e, to });
    }
  }
  // Local skills are scanned fresh: they are not in the catalog.
  const known = new Set<string>([...catalogByName.keys(), ...presentByName.keys()]);
  for (const local of locals) {
    const building = included.get(local.id) as Building;
    const scanned = await scanSkillText(local.dir, building.node.name, local.id, known);
    // Two copies of a name each own their sub-skills: key them by the owning node.
    const subId = (id: string) =>
      id.startsWith("subskill:") ? `subskill:${local.id}/${id.slice(id.indexOf("/") + 1)}` : id;
    for (const sub of scanned.subskills) {
      subOwner.set(subId(sub.id), local.id);
      subskills.set(subId(sub.id), {
        id: subId(sub.id),
        kind: "subskill",
        name: sub.name,
        path: sub.path,
        description: sub.description,
        source: null,
        repo: null,
        root: null,
        origin: null,
        health: "ok",
        findings: [],
      });
    }
    for (const e of scanned.edges) {
      if (e.kind === "routes") edges.push({ ...e, to: subId(e.to) });
      else {
        const to = target(e.to.slice("skill:".length));
        if (to) edges.push({ ...e, from: subId(e.from), to });
      }
    }
  }
  const statusOf = new Map<string, SkillContextStatus>();
  for (const [id, building] of included)
    statusOf.set(
      id,
      building.entries
        .map((entry) => entry.status)
        .sort((a, b) => statusRank(a) - statusRank(b))[0] as SkillContextStatus,
    );
  // A loads edge to something this context cannot load is a routing hole.
  const holes = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "loads") continue;
    const status = ghosts.has(e.to) ? "unavailable" : statusOf.get(e.to);
    if (!status || status === "loaded") continue;
    const owner = ownerOf(e.from) ?? e.from;
    const building = included.get(owner);
    if (!building || holes.has(`${owner}\u0000${e.to}`)) continue;
    holes.add(`${owner}\u0000${e.to}`);
    const name = (ghosts.get(e.to) ?? included.get(e.to)?.node)?.name ?? e.to;
    building.findings.push({
      code: "W_CONTEXT_LOADS_UNAVAILABLE",
      severity: "warning",
      message: `Loads ${name}, which this context cannot load (${status}).`,
      name: building.node.name,
      detail: [name],
      fix: `Make ${name} loadable in this context, or route around it.`,
    });
  }

  // Ownership and composition context for what is included.
  const nodes = new Map<string, SkillGraphNode>();
  for (const [id, building] of included) {
    const status = statusOf.get(id) as SkillContextStatus;
    nodes.set(id, {
      ...building.node,
      findings: building.findings,
      health: graphHealth(building.findings),
      context: { status, entries: building.entries },
    });
  }
  for (const [id, sub] of subskills) if (!nodes.has(id)) nodes.set(id, sub);
  for (const [id, ghost] of ghosts) if (!nodes.has(id)) nodes.set(id, ghost);
  const selected = new Set(view.compositions);
  for (const e of catalog.edges) {
    if (!nodes.has(e.to) || ghosts.has(e.to)) continue;
    const from = catalogNodes.get(e.from);
    if (!from) continue;
    if (e.kind === "owns" || e.kind === "vendors") {
      nodes.set(from.id, from);
      edges.push(e);
    } else if (e.kind === "member") {
      const ref = `${from.kind}:${from.name}`;
      const bare = `${from.kind}:${from.name.split("@")[0]}`;
      if (selected.has(ref) || selected.has(bare)) {
        nodes.set(from.id, from);
        edges.push(e);
      }
    }
  }
  const finalNodes = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const finalEdges = finishEdges(edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)));
  const counts = Object.fromEntries(contextStatuses.map((status) => [status, 0])) as Record<
    SkillContextStatus,
    number
  >;
  for (const skill of view.skills) counts[skill.status] += 1;
  counts.unavailable = ghosts.size;
  return {
    registry: catalog.registry,
    summary: summarizeGraph(finalNodes, finalEdges),
    nodes: finalNodes,
    edges: finalEdges,
    context: { ...view.info, counts },
  };
}

/** Restrict a graph to the named skills and their neighbourhood. */
export function focusGraph(
  data: SkillGraphData,
  names: readonly string[],
  depth = 1,
): { data: SkillGraphData; findings: Diagnostic[] } {
  const findings: Diagnostic[] = [];
  const skillish = new Set(["hub", "vendored", "wild", "local", "subskill"]);
  const pattern = (name: string) =>
    new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const seeds = new Set<string>();
  for (const name of names) {
    const match = pattern(name);
    const hits = data.nodes.filter(
      (node) =>
        (skillish.has(node.kind) || node.kind === "set" || node.kind === "pack") &&
        (node.id === name ||
          match.test(node.name) ||
          (node.context?.entries ?? []).some((entry) => match.test(entry.name))),
    );
    if (!hits.length) {
      findings.push({
        code: "E_FOCUS_UNKNOWN",
        severity: "error",
        message: `No skill, hub, set or pack named ${name} in this ${data.context?.label ?? "catalog"} graph.`,
        name,
        fix: "Check the name with skillex skill list, or choose a context that loads it (--context).",
      });
      continue;
    }
    for (const hit of hits) seeds.add(hit.id);
  }
  // A hub's sub-skills are part of it.
  for (const e of data.edges) if (e.kind === "routes" && seeds.has(e.from)) seeds.add(e.to);
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = neighbours.get(a);
    if (!set) {
      set = new Set();
      neighbours.set(a, set);
    }
    set.add(b);
  };
  for (const e of data.edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  // Sets, packs, sources and unavailable skills are leaves: following them reaches everything.
  const leaf = (id: string) => {
    const node = byId.get(id);
    return (
      !node ||
      (!seeds.has(id) &&
        (node.kind === "set" ||
          node.kind === "pack" ||
          node.kind === "source" ||
          node.context?.status === "unavailable"))
    );
  };
  const keep = new Set(seeds);
  let frontier = [...seeds];
  for (let hop = 0; frontier.length && (depth === 0 || hop < depth); hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (leaf(id)) continue;
      for (const other of neighbours.get(id) ?? [])
        if (!keep.has(other)) {
          keep.add(other);
          next.push(other);
        }
    }
    frontier = next;
  }
  // Keep each kept skill's own sub-skills so a hub never appears gutted.
  for (const e of data.edges) if (e.kind === "routes" && keep.has(e.from)) keep.add(e.to);
  const nodes = data.nodes.filter((node) => keep.has(node.id));
  const edges = data.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return {
    data: {
      ...data,
      summary: summarizeGraph(nodes, edges),
      nodes,
      edges,
      focus: { names: [...names], depth, seeds: [...seeds].sort() },
    },
    findings,
  };
}

/**
 * The skill graph for a context, read from disk now: `catalog` is every definition; any other
 * context is what that agent context can load, joined to the catalog for ownership and lint.
 */
export async function contextSkillGraph(
  options: SkillGraphContextOptions = {},
): Promise<ResultEnvelope<SkillGraphData | null>> {
  const findings: Diagnostic[] = [];
  let resolved: Awaited<ReturnType<typeof concreteSpec>>;
  try {
    const spec = parseContextSpec(options.context, resolve(options.cwd ?? process.cwd()));
    resolved = await concreteSpec(spec, options, findings);
  } catch (error) {
    if (!(error instanceof SkillexError)) throw error;
    return makeResult("graph", null, {
      exit: error.exit,
      findings: [...findings, ...error.findings],
    });
  }
  const [catalog, view] = await Promise.all([
    skillGraph(options),
    (async (): Promise<ContextView | SkillexError | null> => {
      try {
        const spec = resolved.spec;
        if (spec.kind === "catalog") return null;
        if (spec.kind === "profile") return await profileView(spec, resolved.detectedFrom, options);
        return await rootsView(spec, resolved.detectedFrom, options);
      } catch (error) {
        if (error instanceof SkillexError) return error;
        throw error;
      }
    })(),
  ]);
  if (!catalog.data) return catalog;
  if (view instanceof SkillexError)
    return makeResult("graph", null, {
      exit: view.exit,
      findings: [...findings, ...view.findings],
    });
  let data: SkillGraphData =
    view === null
      ? {
          ...catalog.data,
          context: {
            kind: "catalog" as SkillGraphContextKind,
            id: "catalog",
            label: "catalog (every definition)",
            profile: null,
            project: null,
            detectedFrom: null,
            resolver: "skillex skill list + all-skills/sources.toml",
            roots: [{ tier: "catalog", path: join(catalog.data.registry.root, "all-skills") }],
            counts: Object.fromEntries(contextStatuses.map((status) => [status, 0])) as Record<
              SkillContextStatus,
              number
            >,
          },
        }
      : await applyContext(catalog.data, view);
  findings.push(...catalog.findings, ...(view?.findings ?? []));
  if (options.focus?.length) {
    const focused = focusGraph(data, options.focus, options.depth ?? 1);
    findings.push(...focused.findings);
    if (focused.data.focus?.seeds.length === 0)
      return makeResult("graph", null, { exit: ExitCode.CONFIG, findings });
    data = focused.data;
  }
  const unique = [
    ...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values(),
  ];
  return makeResult("graph", data, {
    exit: unique.some((finding) => finding.severity !== "info")
      ? ExitCode.PARTIAL
      : ExitCode.SUCCESS,
    findings: unique,
  });
}

/** Contexts a viewer can pick from: catalog, global, and every Hermes profile on this machine. */
export async function listGraphContexts(
  options: SkillGraphContextOptions = {},
): Promise<{ id: string; label: string }[]> {
  const contexts = [
    { id: "global", label: "global (~/.agents/skills)" },
    { id: "catalog", label: "catalog (every definition)" },
  ];
  try {
    const root = await discoverProfileRoot(profileOptions(options));
    const entries = await readdir(join(root.root ?? root.path, "profiles"), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)
      )
        contexts.push({ id: `profile:${entry.name}`, label: `profile ${entry.name}` });
  } catch {
    // No Hermes installation: catalog and global only.
  }
  return contexts;
}
