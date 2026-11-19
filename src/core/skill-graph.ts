import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { listSkills } from "./catalog.js";
import type { SkillDetails } from "./catalog-types.js";
import { SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { type HubLintReport, lintHub, lintOwnedSkill, markdownLines } from "./hub-lint.js";
import { isSkillName } from "./manifest.js";
import { parseSkillMetadata } from "./metadata.js";
import { ownedCheckout } from "./owned-sources.js";
import type { RegistryRef } from "./registry-context.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions, RegistrySelection } from "./selection.js";
import { parseVendorSourcesText, readVendorText } from "./vendor-sources.js";
import type { VendorSource } from "./vendor-types.js";

/**
 * The skill graph: every definition, where its bytes live, what composes it and what it routes to,
 * with hub lint attached per node so a violation is visible where it lives.
 *
 * Nodes
 * - `hub`       repo-owned skill (link source, ADR-0002)
 * - `vendored`  catalog copy whose provenance names an upstream source
 * - `wild`      catalog skill no repository owns
 * - `subskill`  `subskills/<name>/SUBSKILL.md` inside any skill
 * - `set`, `pack` compositions that reference skills
 * - `source`    a sources.toml repository (link or vendor), with the hubs its skills root holds
 *
 * Edges
 * - `owns`      source -> hub (link mode)
 * - `vendors`   source -> vendored skill (provenance origin.source)
 * - `routes`    skill -> its sub-skill
 * - `member`    set/pack -> skill
 * - `loads`     skill/sub-skill -> skill, the explicit "load the `x` hub|skill" phrase
 * - `mentions`  skill/sub-skill -> skill, a backticked span that is exactly a known skill name
 */

export type SkillGraphNodeKind =
  | "hub"
  | "vendored"
  | "wild"
  | "subskill"
  | "set"
  | "pack"
  | "source";
export type SkillGraphEdgeKind = "owns" | "vendors" | "routes" | "member" | "loads" | "mentions";
export type SkillGraphHealth = "ok" | "warning" | "error";

export interface SkillGraphNode {
  readonly id: string;
  readonly kind: SkillGraphNodeKind;
  readonly name: string;
  readonly path: string | null;
  readonly description: string | null;
  /** The sources.toml source that owns or vendors it. */
  readonly source: string | null;
  /** Upstream repository URL (sources and their skills). */
  readonly repo: string | null;
  /**
   * The repository directory on this machine that holds the skills root (for 33GOD components,
   * the component directory). Lets a consumer such as the 33GOD Atlas join a skill to a repo.
   */
  readonly root: string | null;
  /** Catalog provenance type for non-hub skills (vendored, local, adhoc, bmad-freeze, ...). */
  readonly origin: string | null;
  /** Source nodes: the skill directories on disk under the source's skills root. */
  readonly hubs?: readonly string[];
  readonly mode?: "link" | "vendor";
  readonly health: SkillGraphHealth;
  readonly findings: readonly Diagnostic[];
}

export interface SkillGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: SkillGraphEdgeKind;
  readonly detail?: string;
}

export interface SkillGraphSummary {
  readonly nodes: Readonly<Record<SkillGraphNodeKind, number>>;
  readonly edges: Readonly<Record<SkillGraphEdgeKind, number>>;
  readonly health: Readonly<Record<SkillGraphHealth, number>>;
}

export interface SkillGraphData {
  readonly registry: RegistrySelection;
  readonly summary: SkillGraphSummary;
  readonly nodes: readonly SkillGraphNode[];
  readonly edges: readonly SkillGraphEdge[];
}

export interface SkillGraphOptions extends RegistryOptions {
  /** Skip per-node hub lint (structure only). */
  readonly lint?: boolean;
  /**
   * Also lint wild skills. Off by default: the hub standard governs hubs (and their vendored
   * copies); a catalog of wild and frozen skills would bury hub health under unrelated findings.
   */
  readonly lintWild?: boolean;
}

const unscanned = new Set(["examples", "templates", "assets", "node_modules", ".git"]);
const fileLimit = 2_000;
const loadPhrase = /\bload(?:s|ed|ing)?\s+(?:the\s+)?`([^`\s]+)`\s+(?:hub|skill)\b/gi;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function graphHealth(findings: readonly Diagnostic[]): SkillGraphHealth {
  if (findings.some((item) => item.severity === "error")) return "error";
  if (findings.some((item) => item.severity === "warning")) return "warning";
  return "ok";
}

function asDiagnostics(error: unknown, path: string, name: string): Diagnostic[] {
  if (error instanceof SkillexError) return [...error.findings];
  return [
    {
      code: "E_IO",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      path,
      name,
    },
  ];
}

/** Markdown files of one skill, minus quoted-content directories. */
async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length && files.length < fileLimit) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directory === root ? !unscanned.has(entry.name) : entry.name !== ".git")
          pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  }
  return files.sort(compare);
}

/** The repository directory that holds a skills root: drop a trailing skills/ (and .agents/). */
function repoRoot(skillsRoot: string): string {
  let root = skillsRoot;
  if (basename(root) === "skills") root = dirname(root);
  if (basename(root) === ".agents") root = dirname(root);
  return root;
}

async function skillDirectories(skillsRoot: string): Promise<string[]> {
  const hubs: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return hubs;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if ((await inspectPath(join(skillsRoot, entry.name, "SKILL.md")))?.isFile())
      hubs.push(entry.name);
  }
  return hubs.sort(compare);
}

async function readSources(
  root: string,
): Promise<{ sources: readonly VendorSource[]; findings: Diagnostic[] }> {
  const path = join(root, "all-skills", "sources.toml");
  try {
    const text = await readVendorText(path, "E_SOURCES_MANIFEST_INVALID");
    return { sources: text === null ? [] : parseVendorSourcesText(text, path), findings: [] };
  } catch (error) {
    return { sources: [], findings: asDiagnostics(error, path, "sources.toml") };
  }
}

function originOf(skill: SkillDetails): {
  type: string | null;
  source: string | null;
  upstream: string | null;
} {
  const origin = skill.provenance?.origin;
  if (!origin || typeof origin !== "object") return { type: null, source: null, upstream: null };
  const record = origin as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null);
  return { type: text("type"), source: text("source"), upstream: text("upstream") };
}

/** Build the skill graph for one registry. Per-node lint failures are node findings, never fatal. */
export async function skillGraph(
  options: SkillGraphOptions = {},
): Promise<ResultEnvelope<SkillGraphData | null>> {
  const listed = await listSkills(options);
  if (!listed.data)
    return makeResult("graph", null, { exit: listed.exit, findings: listed.findings });
  const registry: RegistrySelection = listed.data.registry;
  const ref: RegistryRef = registry;
  const lint = options.lint !== false;
  const skills = listed.data.skills;
  const known = new Set(skills.map((skill) => skill.name));
  const knownSkill = async (name: string) => known.has(name);

  const nodes = new Map<string, SkillGraphNode>();
  const edges: SkillGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const edge = (from: string, to: string, kind: SkillGraphEdgeKind, detail?: string) => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(detail === undefined ? { from, to, kind } : { from, to, kind, detail });
  };

  // Sources: every sources.toml repository, with its checkout and the hubs on disk.
  const { sources, findings: sourceFindings } = await readSources(registry.root);
  const sourceRoots = new Map<string, string>();
  for (const source of sources) {
    const findings: Diagnostic[] = [];
    let root: string | null = null;
    let hubs: string[] = [];
    try {
      const { checkout } = await ownedCheckout(ref, source);
      if (checkout.root) {
        const skillsRoot = join(checkout.root, source.subdir);
        root = repoRoot(skillsRoot);
        hubs = await skillDirectories(skillsRoot);
        sourceRoots.set(source.name, root);
        if (hubs.length > 1)
          findings.push({
            code: source.mode === "link" ? "E_HUB_COUNT" : "W_SOURCE_HUB_COUNT",
            severity: source.mode === "link" ? "error" : "warning",
            message: `${skillsRoot} holds ${hubs.length} skills; a repository has exactly one hub.`,
            path: skillsRoot,
            name: source.name,
            detail: hubs,
            fix: "Fold the extra skills into the repository's hub as routes or subskills/<name>/SUBSKILL.md.",
          });
      } else if (!source.optional)
        findings.push({
          code: "W_SOURCE_CHECKOUT_ABSENT",
          severity: "warning",
          message: `Source ${source.name} has no checkout on this machine.`,
          name: source.name,
          detail: checkout.searched,
        });
    } catch (error) {
      findings.push(...asDiagnostics(error, source.checkout, source.name));
    }
    const id = `source:${source.name}`;
    if (nodes.has(id)) continue;
    nodes.set(id, {
      id,
      kind: "source",
      name: source.name,
      path: root,
      description: null,
      source: source.name,
      repo: source.repo,
      root,
      origin: null,
      hubs,
      mode: source.mode,
      health: graphHealth(findings),
      findings,
    });
  }

  // Skills, their sub-skills, compositions and text edges.
  for (const skill of skills) {
    const origin = originOf(skill);
    const repoOwned = skill.owner.kind === "repo";
    const kind: SkillGraphNodeKind = repoOwned
      ? "hub"
      : origin.type === "vendored"
        ? "vendored"
        : "wild";
    const sourceName = repoOwned ? skill.owner.source : origin.source;
    const id = `skill:${skill.name}`;
    let findings: Diagnostic[] = [];
    if (lint && (kind !== "wild" || options.lintWild === true)) {
      try {
        const report: HubLintReport = repoOwned
          ? await lintOwnedSkill(ref, skill.name, { knownSkill })
          : await lintHub({ path: skill.path }, { knownSkill, wild: true });
        findings = [...report.findings];
      } catch (error) {
        findings = asDiagnostics(error, skill.path, skill.name);
      }
    }
    nodes.set(id, {
      id,
      kind,
      name: skill.name,
      path: skill.path,
      description: skill.description,
      source: sourceName,
      repo: repoOwned ? skill.owner.repo : origin.upstream,
      root: repoOwned
        ? skill.owner.checkout === null
          ? null
          : repoRoot(dirname(skill.path))
        : sourceName === null
          ? null
          : (sourceRoots.get(sourceName) ?? null),
      origin: repoOwned ? null : origin.type,
      health: graphHealth(findings),
      findings,
    });
    if (sourceName !== null && nodes.has(`source:${sourceName}`))
      edge(`source:${sourceName}`, id, repoOwned ? "owns" : "vendors");

    for (const reference of skill.references) {
      const compositionId =
        reference.kind === "set"
          ? `set:${reference.name}`
          : `pack:${reference.name}${reference.version ? `@${reference.version}` : ""}`;
      if (!nodes.has(compositionId))
        nodes.set(compositionId, {
          id: compositionId,
          kind: reference.kind,
          name: reference.version ? `${reference.name}@${reference.version}` : reference.name,
          path: reference.path,
          description: null,
          source: null,
          repo: null,
          root: null,
          origin: null,
          health: "ok",
          findings: [],
        });
      edge(compositionId, id, "member");
    }

    // Text edges, attributed to the skill or to the sub-skill whose directory holds the file.
    for (const file of await markdownFiles(skill.path)) {
      const parts = relative(skill.path, file).split(sep);
      let owner = id;
      if (parts[0] === "subskills" && parts.length >= 3 && parts[1]) {
        const subName = parts[1];
        owner = `subskill:${skill.name}/${subName}`;
        if (!nodes.has(owner)) {
          const subPath = join(skill.path, "subskills", subName);
          let description: string | null = null;
          try {
            const text = await readFile(join(subPath, "SUBSKILL.md"), "utf8");
            const meta = parseSkillMetadata(text, join(subPath, "SUBSKILL.md"));
            description = typeof meta.description === "string" ? meta.description : null;
          } catch {
            description = null;
          }
          nodes.set(owner, {
            id: owner,
            kind: "subskill",
            name: `${skill.name}/${subName}`,
            path: subPath,
            description,
            source: sourceName,
            repo: null,
            root: null,
            origin: null,
            health: graphHealth(findings.filter((item) => item.path?.startsWith(subPath + sep))),
            findings: findings.filter((item) => item.path?.startsWith(subPath + sep)),
          });
          edge(id, owner, "routes");
        }
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const line of markdownLines(text)) {
        for (const match of line.raw.matchAll(loadPhrase)) {
          const target = match[1];
          if (target && target !== skill.name && known.has(target))
            edge(owner, `skill:${target}`, "loads");
        }
        for (const span of line.spans)
          if (span !== skill.name && isSkillName(span) && known.has(span))
            edge(owner, `skill:${span}`, "mentions");
      }
    }
  }
  // A loads edge supersedes a mentions edge between the same pair.
  const loads = new Set(
    edges.filter((e) => e.kind === "loads").map((e) => `${e.from}\u0000${e.to}`),
  );
  const finalEdges = edges
    .filter((e) => e.kind !== "mentions" || !loads.has(`${e.from}\u0000${e.to}`))
    .sort((a, b) => compare(`${a.from}|${a.to}|${a.kind}`, `${b.from}|${b.to}|${b.kind}`));
  const finalNodes = [...nodes.values()].sort((a, b) => compare(a.id, b.id));

  const count = <K extends string>(keys: readonly K[], values: readonly K[]) => {
    const totals = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
    for (const value of values) totals[value] += 1;
    return totals;
  };
  const summary: SkillGraphSummary = {
    nodes: count(
      ["hub", "vendored", "wild", "subskill", "set", "pack", "source"] as const,
      finalNodes.map((node) => node.kind),
    ),
    edges: count(
      ["owns", "vendors", "routes", "member", "loads", "mentions"] as const,
      finalEdges.map((e) => e.kind),
    ),
    health: count(
      ["ok", "warning", "error"] as const,
      finalNodes.map((node) => node.health),
    ),
  };
  const findings = [...listed.findings, ...sourceFindings];
  return makeResult(
    "graph",
    { registry, summary, nodes: finalNodes, edges: finalEdges },
    { exit: findings.length ? ExitCode.PARTIAL : ExitCode.SUCCESS, findings },
  );
}
