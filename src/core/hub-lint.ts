import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { canonicalSkill } from "./composition.js";
import { isWithin } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { isSkillName } from "./manifest.js";
import { parseSkillMetadata } from "./metadata.js";
import { ownedSkill, ownedSource } from "./owned-sources.js";
import type { RegistryRef } from "./registry-context.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions } from "./selection.js";

/**
 * Hub lint (ADR-0002 §6). Every rule is structural or an exact syntax match, so prose never
 * produces a finding:
 *
 * - Links are Markdown inline links and reference definitions (`[x](path)`, `![x](path)`,
 *   `[id]: path`) outside fenced code blocks and inline code spans. URLs (any `scheme:`), `//`
 *   links and pure `#anchors` are ignored; `#fragment` and `?query` suffixes are stripped. An
 *   absolute target (`/...` or `~...`) or one that resolves outside the hub is an escape; a
 *   relative target that does not exist is missing. Paths written in prose or backticks are never
 *   checked for existence.
 * - Scanned files are every `*.md` in the hub except under its top-level `examples/`,
 *   `templates/` and `assets/` directories, which may quote foreign Markdown.
 * - Orphans are Markdown files under `references/` or `subskills/` that no scanned file links to
 *   or names by path in an inline code span (relative to that file or to the hub root).
 * - Skill references are the exact phrase "load the `name` hub" or "load the `name` skill"
 *   (load/loads/loaded/loading, "the" optional), whose name must be a valid skill name that
 *   resolves in all-skills/ or is declared by a link source. Other backticked words are prose.
 */

export interface HubLintOptions {
  /** Line budget for SKILL.md before W_HUB_SIZE. */
  readonly maxLines?: number;
  /** Decide whether a skill name is known; omit to skip E_HUB_SKILL_REF_UNKNOWN. */
  readonly knownSkill?: (name: string) => Promise<boolean>;
}

export interface HubLintTarget {
  /** The hub directory. */
  readonly path: string;
  /** The name a link source declares for this hub, when there is one. */
  readonly declaredName?: string;
  readonly source?: string;
  readonly checkout?: string;
}

export interface HubLintData {
  readonly name: string;
  readonly path: string;
  readonly source: string | null;
  readonly checkout: string | null;
  readonly lines: number | null;
  readonly files: number;
  readonly links: number;
}

export interface HubLintReport {
  readonly data: HubLintData;
  readonly findings: readonly Diagnostic[];
}

export const HUB_SIZE_LIMIT = 500;
const scanLimit = 20_000;
const unscanned = new Set(["examples", "templates", "assets"]);
const loadPhrase = /\bload(?:s|ed|ing)?\s+(?:the\s+)?`([^`\s]+)`\s+(?:hub|skill)\b/gi;
const inlineLink =
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const referenceDefinition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/;

interface Entry {
  readonly path: string;
  readonly relative: string;
  readonly kind: "file" | "directory" | "link" | "other";
}

interface Line {
  readonly number: number;
  /** Line text with inline code spans blanked out. */
  readonly prose: string;
  /** Line text with code spans intact (for the explicit load phrase). */
  readonly raw: string;
  readonly spans: readonly string[];
}

function finding(
  code: Diagnostic["code"],
  message: string,
  path: string,
  name: string,
  fix: string,
  detail?: readonly string[],
): Diagnostic {
  return {
    code,
    severity: code.startsWith("E_") ? "error" : code.startsWith("W_") ? "warning" : "info",
    message,
    path,
    name,
    ...(detail === undefined ? {} : { detail }),
    fix,
  };
}

async function walk(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, item.name);
      const kind = item.isSymbolicLink()
        ? "link"
        : item.isDirectory()
          ? "directory"
          : item.isFile()
            ? "file"
            : "other";
      entries.push({ path, relative: relative(root, path), kind });
      if (entries.length > scanLimit)
        fail(
          "E_OWNED_SKILL_TOO_LARGE",
          `Hub ${root} has more than ${scanLimit} entries.`,
          { path: root, fix: "Keep a hub small; move generated trees out of the skill." },
          ExitCode.REFUSED,
        );
      if (kind === "directory" && item.name !== ".git") pending.push(path);
    }
  }
  return entries;
}

/** Split Markdown into prose lines, skipping fenced code blocks and blanking inline code. */
export function markdownLines(text: string): Line[] {
  const lines: Line[] = [];
  let fence: { char: string; length: number } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (marker?.[1]?.[0] === fence.char && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (marker?.[1]) {
      fence = { char: marker[1][0] ?? "`", length: marker[1].length };
      return;
    }
    const spans: string[] = [];
    const prose = raw.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (whole, _ticks, body) => {
      spans.push(String(body).trim());
      return " ".repeat(whole.length);
    });
    lines.push({ number: index + 1, prose, raw, spans });
  });
  return lines;
}

/** Markdown link targets on one prose line. */
export function linkTargets(line: string): string[] {
  const targets: string[] = [];
  for (const match of line.matchAll(inlineLink)) if (match[1]) targets.push(match[1]);
  const definition = referenceDefinition.exec(line);
  if (definition?.[1]) targets.push(definition[1]);
  return targets;
}

/** A local path from a link target, or null for URLs, anchors and empty targets. */
export function localTarget(target: string): string | null {
  let value = target.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  value = value.replace(/[#?].*$/, "");
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** Lint one hub directory. Structural failures are findings; only an absent hub throws. */
export async function lintHub(
  target: HubLintTarget,
  options: HubLintOptions = {},
): Promise<HubLintReport> {
  const hub = resolve(target.path);
  const name = basename(hub);
  const findings: Diagnostic[] = [];
  const add = (
    code: Diagnostic["code"],
    message: string,
    path: string,
    fix: string,
    detail?: readonly string[],
  ) => findings.push(finding(code, message, path, name, fix, detail));
  const root = await inspectPath(hub);
  if (!root)
    fail(
      "E_SKILL_MISSING",
      `No hub directory exists at ${hub}.`,
      { path: hub, name, fix: "Point skill lint at an existing hub directory." },
      ExitCode.REFUSED,
    );
  if (root.isSymbolicLink()) {
    add(
      "E_HUB_SYMLINK",
      "The hub directory itself is a symbolic link.",
      hub,
      "Keep the hub as a real directory in its owning repository.",
    );
  } else if (!root.isDirectory())
    fail(
      "E_NONCANONICAL_REFERENCE",
      `The hub is not a directory: ${hub}`,
      { path: hub, name, fix: "Point skill lint at a hub directory." },
      ExitCode.REFUSED,
    );
  const directory = root.isSymbolicLink() ? await realpathOrSelf(hub) : hub;

  // E_HUB_COUNT: <repo>/skills/ holds exactly one top-level skill.
  const parent = dirname(hub);
  const hubs: string[] = [];
  for (const item of await readdir(parent, { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    try {
      if ((await stat(join(parent, item.name, "SKILL.md"))).isFile()) hubs.push(item.name);
    } catch {
      /* Not a skill directory. */
    }
  }
  if (hubs.length !== 1)
    add(
      "E_HUB_COUNT",
      `${parent} holds ${hubs.length} skills; a repository has exactly one hub.`,
      parent,
      "Keep one hub per repository and route to components inside it (subskills/<name>/SUBSKILL.md).",
      hubs.sort(),
    );

  // E_HUB_FRONTMATTER / E_HUB_NAME / W_HUB_SIZE.
  const skillFile = join(directory, "SKILL.md");
  let lines: number | null = null;
  const skillInfo = await inspectPath(skillFile);
  if (!skillInfo?.isFile()) {
    add(
      "E_HUB_FRONTMATTER",
      "The hub has no regular SKILL.md.",
      skillFile,
      "Create SKILL.md with name and description frontmatter.",
    );
  } else {
    const text = await readFile(skillFile, "utf8");
    lines = lineCount(text);
    const limit = options.maxLines ?? HUB_SIZE_LIMIT;
    if (lines > limit)
      add(
        "W_HUB_SIZE",
        `SKILL.md has ${lines} lines; the lint budget is ${limit} (target 200).`,
        skillFile,
        "Move facts that need more than a route row into references/ and route to them.",
      );
    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = parseSkillMetadata(text, skillFile);
    } catch (error) {
      add(
        "E_HUB_FRONTMATTER",
        error instanceof SkillexError
          ? (error.findings[0]?.message ?? "Invalid frontmatter.")
          : "Invalid frontmatter.",
        skillFile,
        "Start SKILL.md with a YAML frontmatter block holding name and description.",
      );
    }
    if (metadata) {
      const problems: string[] = [];
      const declared = metadata.name;
      if (typeof declared !== "string" || !declared.trim()) problems.push("name is missing");
      else if (!isSkillName(declared) || declared.length > 64)
        problems.push("name must be a canonical skill name of at most 64 characters");
      const description = metadata.description;
      if (typeof description !== "string" || !description.trim())
        problems.push("description is missing");
      else if (description.length > 1024)
        problems.push(`description has ${description.length} characters; the limit is 1024`);
      if (problems.length)
        add(
          "E_HUB_FRONTMATTER",
          "SKILL.md frontmatter is incomplete or invalid.",
          skillFile,
          "Give the hub a canonical name (at most 64 characters) and a description of at most 1024 characters.",
          problems,
        );
      const names = [
        `directory ${name}`,
        ...(target.declaredName === undefined ? [] : [`declared ${target.declaredName}`]),
        ...(typeof declared === "string" ? [`frontmatter ${declared}`] : []),
      ];
      if (
        (target.declaredName !== undefined && target.declaredName !== name) ||
        (typeof declared === "string" && declared.trim() && declared !== name)
      )
        add(
          "E_HUB_NAME",
          "The hub's directory, declared and frontmatter names differ.",
          skillFile,
          "Use one name everywhere: the directory, the source declaration and frontmatter name.",
          names,
        );
    }
  }

  // Tree checks: symlinks, nested SKILL.md, stray provenance.
  const entries = await walk(directory);
  for (const entry of entries) {
    if (entry.kind === "link")
      add(
        "E_HUB_SYMLINK",
        "The hub tree contains a symbolic link.",
        entry.path,
        "Replace the link with real content; a hub is plain files in its owning repository.",
      );
    else if (
      entry.kind === "file" &&
      basename(entry.path) === "SKILL.md" &&
      entry.path !== skillFile
    )
      add(
        "E_HUB_NESTED_SKILL",
        "A SKILL.md below the hub root would be listed as a separate skill by recursive scanners.",
        entry.path,
        "Rename it to SUBSKILL.md under subskills/<name>/ and route to it from the hub.",
      );
    else if (entry.kind === "file" && basename(entry.path) === ".source.yaml")
      add(
        "W_HUB_PROVENANCE",
        "A repo-owned skill carries a .source.yaml; its provenance is the repository itself.",
        entry.path,
        "Delete the stale provenance receipt from the hub.",
      );
  }

  // Links and orphans.
  const markdown = entries.filter(
    (entry) =>
      entry.kind === "file" &&
      entry.path.endsWith(".md") &&
      !unscanned.has(entry.relative.split(sep)[0] ?? ""),
  );
  const exists = new Set(entries.map((entry) => entry.path));
  const referenced = new Set<string>();
  let links = 0;
  const unknownChecks: { name: string; path: string; line: number }[] = [];
  for (const file of markdown) {
    const text = await readFile(file.path, "utf8");
    const base = dirname(file.path);
    for (const line of markdownLines(text)) {
      for (const span of line.spans) {
        const local = span.replace(/^\.\//, "");
        if (!local || /[\s*<>{}$]/.test(local) || !(local.includes("/") || local.endsWith(".md")))
          continue;
        for (const candidate of [resolve(base, local), resolve(directory, local)])
          if (isWithin(directory, candidate)) referenced.add(candidate.replace(/\/+$/, ""));
      }
      for (const match of line.raw.matchAll(loadPhrase))
        if (match[1] && isSkillName(match[1]) && match[1] !== name)
          unknownChecks.push({ name: match[1], path: file.path, line: line.number });
      for (const raw of linkTargets(line.prose)) {
        const local = localTarget(raw);
        if (local === null) continue;
        links += 1;
        const detail = [`line ${line.number}`, `target ${raw}`];
        if (local.startsWith("/") || local.startsWith("~")) {
          add(
            "E_HUB_REFERENCE_ESCAPE",
            "A hub link uses an absolute path.",
            file.path,
            "Link to files inside the hub with a relative path; name other skills instead of linking to them.",
            detail,
          );
          continue;
        }
        const resolved = resolve(base, local);
        if (!isWithin(directory, resolved)) {
          add(
            "E_HUB_REFERENCE_ESCAPE",
            "A relative link leaves the hub directory.",
            file.path,
            "Keep links inside the hub; refer to another skill by name (load the `name` hub).",
            detail,
          );
          continue;
        }
        referenced.add(resolved.replace(/\/+$/, ""));
        if (!exists.has(resolved.replace(/\/+$/, "")) && resolved !== directory) {
          try {
            await lstat(resolved);
          } catch {
            add(
              "E_HUB_REFERENCE_MISSING",
              "A relative link does not resolve to a file in the hub.",
              file.path,
              "Correct the link or restore the file it routes to.",
              detail,
            );
          }
        }
      }
    }
  }
  for (const entry of markdown) {
    const top = entry.relative.split(sep)[0];
    if (top !== "references" && top !== "subskills") continue;
    let covered = false;
    for (let current = entry.path; isWithin(directory, current) && current !== directory; ) {
      if (referenced.has(current)) {
        covered = true;
        break;
      }
      current = dirname(current);
    }
    if (!covered)
      add(
        "W_HUB_ORPHAN",
        "Nothing in the hub links to this file, so no route can load it.",
        entry.path,
        "Route to it from the hub or a sibling reference, or delete it.",
      );
  }

  // E_HUB_SKILL_REF_UNKNOWN: only the explicit load phrase.
  if (options.knownSkill) {
    const checked = new Map<string, boolean>();
    for (const check of unknownChecks) {
      let known = checked.get(check.name);
      if (known === undefined) {
        known = await options.knownSkill(check.name);
        checked.set(check.name, known);
      }
      if (!known)
        add(
          "E_HUB_SKILL_REF_UNKNOWN",
          `The hub tells agents to load ${check.name}, which resolves nowhere.`,
          check.path,
          "Use the canonical name of a catalog skill or a declared repo-owned hub.",
          [`line ${check.line}`, `skill ${check.name}`],
        );
    }
  } else if (unknownChecks.length)
    add(
      "I_HUB_SKILL_REF_UNCHECKED",
      "No registry was available, so skill references were not checked.",
      skillFile,
      "Run skill lint inside a catalog checkout or pass --registry-root.",
    );

  return {
    data: {
      name,
      path: directory,
      source: target.source ?? null,
      checkout: target.checkout ?? null,
      lines,
      files: markdown.length,
      links,
    },
    findings,
  };
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Exit for lint findings: errors refuse, warnings are drift, info is clean. */
export function hubLintExit(findings: readonly Diagnostic[]): ExitCode {
  if (findings.some((item) => item.severity === "error")) return ExitCode.REFUSED;
  if (findings.some((item) => item.severity === "warning")) return ExitCode.DRIFT;
  return ExitCode.SUCCESS;
}

/** Whether a name resolves in all-skills/ or is declared by any link source. */
export function knownSkillIn(registry: RegistryRef): (name: string) => Promise<boolean> {
  return async (name) => {
    if (await ownedSource(registry, name)) return true;
    try {
      await canonicalSkill(registry, name);
      return true;
    } catch {
      return false;
    }
  };
}

/** Lint the hub of one repo-owned skill, using its declaration and resolved checkout. */
export async function lintOwnedSkill(
  registry: RegistryRef,
  name: string,
  options: HubLintOptions = {},
): Promise<HubLintReport> {
  const owned = await ownedSkill(registry, name);
  if (!owned)
    fail(
      "E_SKILL_NOT_REPO_OWNED",
      `Skill ${name} is not declared by a link source.`,
      {
        name,
        fix: 'Declare the hub with mode = "link" in all-skills/sources.toml, or lint a directory with skill lint --path.',
      },
      ExitCode.CONFIG,
    );
  return lintHub(
    {
      path: join(owned.skillsRoot, owned.name),
      declaredName: owned.name,
      source: owned.source,
      checkout: owned.checkoutRoot,
    },
    { knownSkill: knownSkillIn(registry), ...options },
  );
}

export interface LintSkillOptions extends RegistryOptions {
  readonly path?: string;
  readonly maxLines?: number;
}

/** `skillex skill lint <name>` or `skillex skill lint --path <hub>`. */
export async function lintSkill(
  name: string | undefined,
  options: LintSkillOptions = {},
): Promise<ResultEnvelope<HubLintData | null>> {
  try {
    if ((name === undefined) === (options.path === undefined))
      fail("E_USAGE", "Lint either a declared hub name or a --path, not both or neither.", {
        fix: "Run skillex skill lint <name> or skillex skill lint --path <hub-directory>.",
      });
    const lintOptions = options.maxLines === undefined ? {} : { maxLines: options.maxLines };
    let report: HubLintReport;
    if (name !== undefined) {
      const registry = await discoverRegistry(options);
      report = await lintOwnedSkill(registry, name, lintOptions);
    } else {
      const cwd = resolve(options.cwd ?? process.cwd());
      const path = resolve(cwd, options.path ?? ".");
      let knownSkill: ((name: string) => Promise<boolean>) | undefined;
      try {
        knownSkill = knownSkillIn(await discoverRegistry(options));
      } catch {
        knownSkill = undefined;
      }
      report = await lintHub({ path }, { ...lintOptions, ...(knownSkill ? { knownSkill } : {}) });
    }
    return makeResult("skill lint", report.data, {
      exit: hubLintExit(report.findings),
      findings: report.findings,
    });
  } catch (error) {
    if (error instanceof SkillexError)
      return makeResult("skill lint", null, { exit: error.exit, findings: error.findings });
    return makeResult("skill lint", null, {
      exit: ExitCode.FAILURE,
      findings: [
        {
          code: "E_IO",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          fix: "Check the hub path and its permissions, then retry.",
        },
      ],
    });
  }
}
