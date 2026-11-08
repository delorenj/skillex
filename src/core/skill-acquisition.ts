import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CatalogLockOptions } from "./catalog-lock.js";
import { type CatalogChange, importSkill } from "./catalog-write.js";
import { canonicalSkill } from "./composition.js";
import { captureContent, digestContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { sanitizeSourceLabel } from "./import-sources.js";
import { isSkillName } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions } from "./selection.js";
import type { SelectionChange, SelectionOptions } from "./selection-command-types.js";
import {
  enableSelection,
  initScope,
  type ScopeTarget,
  selectScopeTarget,
} from "./selection-commands.js";
import { readSelectionManifest } from "./selection-manifest.js";

const run = promisify(execFile);

/** One Git invocation the acquisition pipeline needs. */
export interface GitRunnerCall {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Seam for Git access. The default runs the real git binary; callers and
 * tests can substitute their own runner (for example one that delegates to
 * the real binary against a local remote) without patching the module.
 */
export interface GitRunner {
  exec(args: readonly string[], call?: GitRunnerCall): Promise<string>;
}

const defaultGitRunner: GitRunner = {
  async exec(args, call) {
    const { stdout } = await run("git", [...args], {
      encoding: "utf8",
      timeout: call?.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(call?.cwd === undefined ? {} : { cwd: call.cwd }),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  },
};

/**
 * Deny every Git transport by default and explicitly allow only the one the
 * URL names, so an explicitly requested clone cannot be widened by redirects.
 * Byte-for-byte parity with the private helper in import-sources.ts; keep the
 * two in sync (import-sources is owned elsewhere and cannot be imported from).
 */
function transportConfig(url: string): string[] {
  const scheme = /^(https?|git|ssh|file):\/\//i.exec(url)?.[1]?.toLowerCase();
  return [
    "protocol.allow=never",
    `protocol.${scheme ?? "ssh"}.allow=always`,
    // Nothing inside an acquired source is ever executed; neutralize hooks
    // in the ephemeral checkout for every later git command run against it.
    "core.hooksPath=/dev/null",
  ];
}

function configFlags(url: string): string[] {
  return transportConfig(url).flatMap((value) => ["--config", value]);
}

/** Global -c form for git plumbing (ls-remote) that has no --config option. */
function globalConfigArgs(url: string): string[] {
  return transportConfig(url).flatMap((value) => ["-c", value]);
}

function acquisitionTransportFailure(url: string, error: unknown): SkillexError {
  // Git echoes the full URL (credentials included) on transport errors.
  const raw = error instanceof Error ? error.message : String(error);
  return new SkillexError(ExitCode.REFUSED, [
    {
      code: "E_SOURCE_ACQUIRE",
      severity: "error",
      message: `Cannot acquire the requested Git source: ${sanitizeSourceLabel(url)}`,
      detail: [sanitizeSourceLabel(raw)],
      fix: "Check the URL, your network access, and Git credentials; acquisition only happens for explicitly passed sources.",
    },
  ]);
}

/** Where a source string points: a GitHub tree URL, a Git remote, or a local path. */
export type SourceLocation =
  | {
      readonly kind: "github-tree";
      readonly url: string;
      readonly owner: string;
      readonly repo: string;
      /** Segments after /tree/: ref components followed by subtree components. */
      readonly segments: readonly string[];
    }
  | { readonly kind: "git"; readonly url: string; readonly repoName: string }
  | { readonly kind: "path"; readonly input: string };

function looksLikeRemote(source: string): boolean {
  // Same shape test as import-sources.ts; keep the two in sync.
  return /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(source);
}

/**
 * Drop transport credentials before URL-shape matching. The original URL is
 * still used for the clone (that is what the credentials are for); everything
 * persisted or reported goes through sanitizeSourceLabel instead.
 */
function withoutCredentials(source: string): string {
  return source.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/@\s'"]+@/, "$1");
}

function repoNameFromUrl(url: string): string {
  const cleaned = url
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const last = cleaned.split("/").filter(Boolean).at(-1) ?? cleaned;
  // An scp-like remote (user@host:owner/repo) ends with the repository name.
  return last.split(":").at(-1) ?? last;
}

/**
 * Decode and validate one tree-path segment. Ref and path components are used
 * decoded (a clone's checkout holds decoded names); traversal, encoded
 * separators, and encoded dot components are refused, never cleaned.
 */
function safeTreeSegment(segment: string): string {
  if (segment.includes("\\") || segment.includes("\0"))
    fail("E_IMPORT_SOURCE", `Unsafe tree path component: ${segment}`, {
      fix: "Point at a real subdirectory; backslashes and NUL are refused.",
    });
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    fail("E_IMPORT_SOURCE", `Malformed percent-encoding in tree path component: ${segment}`, {
      fix: "Point at a real subdirectory URL.",
    });
  }
  if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/"))
    fail("E_IMPORT_SOURCE", `Unsafe tree path component: ${segment}`, {
      fix: "Point at a real subdirectory; traversal and encoded separators are refused.",
    });
  return decoded;
}

function safeTreeSegments(raw: string): readonly string[] {
  return raw
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => safeTreeSegment(segment));
}

function githubName(value: string, what: string): string {
  if (!/^[\w.-]+$/.test(value) || value === "." || value === "..")
    fail("E_IMPORT_SOURCE", `Unsafe GitHub ${what}: ${value}`, {
      fix: "Use a plain owner/repository name.",
    });
  return value;
}

/** Classify a source string. GitHub tree URLs keep their segments unresolved. */
export function parseSourceLocation(source: string): SourceLocation {
  if (!looksLikeRemote(source)) return { kind: "path", input: source };
  // Match GitHub shapes on the credential-free form so an authenticated URL
  // behaves exactly like its public form.
  const bare = withoutCredentials(source);
  const github = /^https:\/\/(?:[a-z0-9-]+\.)*github\.com\//i;
  if (github.test(bare)) {
    const bareRepo =
      /^https:\/\/(?:[a-z0-9-]+\.)*github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(bare);
    if (bareRepo)
      return {
        kind: "git",
        url: source,
        repoName: githubName(bareRepo[2] ?? "", "repository name"),
      };
    if (/\/blob\//i.test(bare))
      fail("E_IMPORT_SOURCE", "The GitHub URL points at a single file, not a skill directory.", {
        fix: "Use the /tree/ URL of the directory that carries SKILL.md.",
      });
    const tree =
      /^https:\/\/(?:[a-z0-9-]+\.)*github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/tree\/([^?#]+)\/?$/i.exec(
        bare,
      );
    if (tree) {
      const segments = safeTreeSegments(tree[3] ?? "");
      if (segments.length === 0)
        fail("E_IMPORT_SOURCE", "The GitHub tree URL names no ref after /tree/.", {
          fix: "Point at /tree/<branch-or-tag>/<subdirectory>, or use the bare repository URL.",
        });
      return {
        kind: "github-tree",
        url: source,
        owner: githubName(tree[1] ?? "", "owner"),
        repo: githubName(tree[2] ?? "", "repository name"),
        segments,
      };
    }
    fail("E_IMPORT_SOURCE", "Unsupported GitHub URL shape.", {
      fix: "Use /<owner>/<repo>, /<owner>/<repo>/tree/<ref>/<subdirectory>, or a plain Git remote URL.",
    });
  }
  return { kind: "git", url: source, repoName: repoNameFromUrl(source) };
}

/**
 * The Git transport URL for a GitHub web URL: the repository endpoint with a
 * .git suffix, keeping any transport credentials. Only git ever sees this;
 * provenance and receipts keep the original tree URL (sanitized).
 */
export function githubTransportUrl(location: {
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
}): string {
  const userinfo = /^https:\/\/([^/@]+)@/i.exec(location.url)?.[1];
  return `https://${userinfo ? `${userinfo}@` : ""}github.com/${location.owner}/${location.repo}.git`;
}

/**
 * Canonical name a source implies before any ref resolution: the last tree
 * path segment for GitHub tree URLs with a path, the repository name for
 * remotes and path-shaped tree URLs, and the directory name for local paths.
 * An explicit --name always overrides this.
 */
export function provisionalSkillName(location: SourceLocation): string {
  switch (location.kind) {
    case "github-tree":
      return location.segments.length > 1
        ? (location.segments.at(-1) ?? location.repo)
        : location.repo;
    case "git":
      return location.repoName;
    case "path":
      return basename(location.input.replace(/\/+$/, "")) || location.input;
  }
}

interface RemoteRef {
  readonly name: string;
  readonly kind: "branch" | "tag";
  readonly commit: string;
}

interface LsRemoteListing {
  readonly refs: readonly RemoteRef[];
  readonly head: string | undefined;
  readonly headSymref: string | undefined;
}

function parseLsRemote(stdout: string): LsRemoteListing {
  const refs: RemoteRef[] = [];
  const peeled = new Map<string, string>();
  let head: string | undefined;
  let headSymref: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("ref: ")) {
      const symref = /^ref: (refs\/\S+)\tHEAD$/.exec(trimmed);
      if (symref?.[1]) headSymref = symref[1];
      continue;
    }
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const commit = trimmed.slice(0, tab);
    const ref = trimmed.slice(tab + 1);
    if (ref === "HEAD") {
      head = commit;
      continue;
    }
    if (ref.endsWith("^{}")) {
      // The commit an annotated tag peels to; a clone of the tag checks out
      // this commit, so resolution must compare against it.
      peeled.set(ref.slice("refs/tags/".length, ref.length - 3), commit);
      continue;
    }
    if (ref.startsWith("refs/heads/"))
      refs.push({ name: ref.slice("refs/heads/".length), kind: "branch", commit });
    else if (ref.startsWith("refs/tags/"))
      refs.push({ name: ref.slice("refs/tags/".length), kind: "tag", commit });
  }
  for (const [index, ref] of refs.entries())
    if (ref.kind === "tag" && peeled.has(ref.name))
      refs[index] = { ...ref, commit: peeled.get(ref.name) ?? ref.commit };
  return { refs, head, headSymref };
}

/** A resolved GitHub/Git tree location: which ref, which commit, which subtree. */
export interface TreeResolution {
  readonly ref: string;
  readonly commit: string;
  /** Subtree path inside the repository ("" for the root). */
  readonly path: string;
}

/**
 * Resolve the ref/path boundary of a tree URL through ls-remote. Slash-bearing
 * refs (release/1.0) make the boundary ambiguous: every prefix that names a
 * real ref is collected, and the URL is accepted only when all candidates
 * agree on the same commit AND the same remaining path — otherwise the source
 * is refused explicitly. The longest matching prefix claims the least path.
 */
export async function resolveTreeLocation(
  runner: GitRunner,
  url: string,
  segments: readonly string[],
  options: { readonly ref?: string; readonly label?: string } = {},
): Promise<TreeResolution> {
  // `url` is the Git transport URL; `label` keeps the human-facing source.
  const label = options.label ?? sanitizeSourceLabel(url);
  let stdout: string;
  try {
    stdout = await runner.exec([...globalConfigArgs(url), "ls-remote", "--symref", url], {
      timeoutMs: 30_000,
    });
  } catch (error) {
    throw acquisitionTransportFailure(url, error);
  }
  const listed = parseLsRemote(stdout);
  const matches = (name: string): readonly RemoteRef[] =>
    listed.refs.filter((ref) => ref.name === name);

  if (options.ref !== undefined) {
    const exact = matches(options.ref);
    if (exact.length === 0)
      fail(
        "E_IMPORT_REF_NOT_FOUND",
        `The source has no branch or tag named ${options.ref}: ${label}`,
        {
          detail: listed.refs.map((ref) => `${ref.kind} ${ref.name} -> ${ref.commit}`).slice(0, 50),
          fix: "Check the ref spelling, or omit --ref to let the tree URL resolve it.",
        },
      );
    const commits = [...new Set(exact.map((ref) => ref.commit))];
    if (commits.length > 1)
      fail(
        "E_IMPORT_REF_AMBIGUOUS",
        `The ref ${options.ref} names both a branch and a tag at different commits: ${label}`,
        {
          detail: exact.map((ref) => `${ref.kind} ${ref.name} -> ${ref.commit}`),
          fix: "Point --ref at an unambiguous branch or tag name.",
        },
      );
    const parts = options.ref.split("/");
    const prefixed =
      parts.length <= segments.length && parts.every((part, index) => segments[index] === part);
    if (!prefixed)
      fail("E_IMPORT_SOURCE", `--ref ${options.ref} is not a prefix of the URL's tree path.`, {
        fix: "Use a --ref the tree URL also names, or drop the tree path and use --ref on the bare repository URL.",
      });
    return {
      ref: options.ref,
      commit: commits[0] ?? "",
      path: segments.slice(parts.length).join("/"),
    };
  }

  if (segments.length === 0) {
    if (!listed.head)
      fail("E_IMPORT_REF_NOT_FOUND", `The source repository advertises no HEAD: ${label}`, {
        fix: "Point at a repository with at least one branch.",
      });
    const name = listed.headSymref?.replace(/^refs\/(?:heads|tags)\//, "");
    return { ref: name ?? "HEAD", commit: listed.head, path: "" };
  }

  const candidates: { ref: string; commit: string; path: string }[] = [];
  for (let length = segments.length; length >= 1; length -= 1) {
    const name = segments.slice(0, length).join("/");
    for (const ref of matches(name))
      candidates.push({ ref: name, commit: ref.commit, path: segments.slice(length).join("/") });
  }
  if (candidates.length === 0)
    fail(
      "E_IMPORT_REF_NOT_FOUND",
      `No branch or tag of ${label} matches a prefix of ${segments.join("/")}.`,
      {
        detail: listed.refs.map((ref) => `${ref.kind} ${ref.name} -> ${ref.commit}`).slice(0, 50),
        fix: "Check the ref spelling in the tree URL, or pass --ref with the exact branch or tag.",
      },
    );
  const interpretations = [...new Set(candidates.map((item) => `${item.commit}:${item.path}`))];
  if (interpretations.length > 1)
    fail("E_IMPORT_REF_AMBIGUOUS", `The tree URL matches several ref/path readings of ${label}.`, {
      detail: candidates.map(
        (item) => `${item.ref} -> ${item.commit} leaves ${item.path || "(root)"}`,
      ),
      fix: "Pass --ref with the exact branch or tag to fix the boundary.",
    });
  const [longest] = candidates;
  if (!longest)
    fail("E_INTERNAL", "Ref resolution produced no candidate.", { fix: "Report this bug." });
  return longest;
}

/** Structured provenance for one acquisition, safe to persist (no credentials). */
export interface AcquisitionSourceInfo {
  readonly kind: "github-tree" | "git" | "path";
  /** Sanitized URL (credentials redacted) or absolute local source path. */
  readonly label: string;
  readonly repo?: string;
  readonly ref?: string;
  /** Subtree path inside the repository ("" for the root). */
  readonly subtree?: string;
  readonly commit?: string;
}

/** A source that has been fetched and is ready to import. Owns its temp clone. */
export interface AcquiredSkillSource {
  readonly info: AcquisitionSourceInfo;
  readonly importPath: string;
  readonly temporary: string | undefined;
}

export async function releaseAcquired(acquired: AcquiredSkillSource): Promise<void> {
  if (acquired.temporary) await rm(acquired.temporary, { recursive: true, force: true });
}

/**
 * Acquire one skill source: read a local path in place, or resolve the remote
 * ref, clone it ephemerally (depth 1, transport-locked, hooks disabled), pin
 * the resolved commit, and select only the requested subtree. Nothing from the
 * acquired tree is ever executed and no clone outlives the call's consumer.
 */
export async function acquireSkillSource(
  source: string,
  options: SkillAcquisitionOptions = {},
): Promise<AcquiredSkillSource> {
  const runner = options.git ?? defaultGitRunner;
  const location = parseSourceLocation(source);
  if (location.kind === "path") {
    const home = options.home ?? homedir();
    const expanded =
      location.input === "~"
        ? home
        : location.input.startsWith("~/")
          ? join(home, location.input.slice(2))
          : location.input;
    const path = resolve(options.cwd ?? process.cwd(), expanded);
    const info = await inspectPath(path);
    if (!info?.isDirectory())
      fail(
        "E_IMPORT_SOURCE",
        `Import requires a real source directory: ${path}`,
        { path, fix: "Pass a local skill directory, or a Git/GitHub URL." },
        ExitCode.CONFIG,
      );
    return {
      info: { kind: "path", label: await realpath(path) },
      importPath: path,
      temporary: undefined,
    };
  }
  // Git speaks to the repository endpoint; people and receipts see the tree URL.
  const label = sanitizeSourceLabel(location.url);
  const transport = location.kind === "github-tree" ? githubTransportUrl(location) : location.url;
  const segments = location.kind === "github-tree" ? location.segments : [];
  const resolution = await resolveTreeLocation(runner, transport, segments, {
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    label,
  });
  const temporary = await mkdtemp(join(tmpdir(), "skillex-acquire-"));
  try {
    // The clone is pinned to the commit ls-remote resolved: a ref that moves
    // between resolution and clone is a refusal, never a silent mix.
    await runner.exec(
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        ...(resolution.ref === "HEAD" ? [] : ["--branch", resolution.ref]),
        ...configFlags(transport),
        transport,
        temporary,
      ],
      { timeoutMs: 120_000 },
    );
    const commit = (
      await runner.exec(["-C", temporary, "rev-parse", "HEAD"], { timeoutMs: 15_000 })
    ).trim();
    if (commit !== resolution.commit)
      fail(
        "E_SOURCE_CHANGED",
        `Git source ${label} moved to ${commit} after resolution pinned ${resolution.commit}.`,
        { fix: "Retry the command to acquire the new commit." },
        ExitCode.REFUSED,
      );
    const subtree = resolution.path ? join(temporary, ...resolution.path.split("/")) : temporary;
    const subtreeInfo = await inspectPath(subtree);
    if (!subtreeInfo?.isDirectory())
      fail(
        "E_IMPORT_SUBTREE_MISSING",
        `The resolved tree path does not exist in the source: ${resolution.path || "(repository root)"}`,
        {
          path: subtree,
          detail: [`${label}#${resolution.commit}`],
          fix: "Check the directory part of the tree URL at the resolved ref.",
        },
        ExitCode.REFUSED,
      );
    if (!(await inspectPath(join(subtree, "SKILL.md"))))
      fail(
        "E_IMPORT_SUBTREE_SKILL",
        `The selected directory has no SKILL.md: ${resolution.path || "(repository root)"}`,
        {
          path: join(subtree, "SKILL.md"),
          detail: [`${label}#${resolution.commit}`],
          fix: "Point the tree URL at the directory that carries SKILL.md.",
        },
        ExitCode.REFUSED,
      );
    return {
      info: {
        kind: location.kind === "github-tree" ? "github-tree" : "git",
        label,
        ...(location.kind === "github-tree" ? { repo: `${location.owner}/${location.repo}` } : {}),
        ref: resolution.ref,
        commit: resolution.commit,
        subtree: resolution.path,
      },
      importPath: subtree,
      temporary,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    // Git echoes the full transport URL (credentials included) on failures;
    // named SkillexError refusals pass through, anything else is sanitized.
    throw error instanceof SkillexError ? error : acquisitionTransportFailure(transport, error);
  }
}

/** Options shared by import and add. */
export interface SkillAcquisitionOptions extends RegistryOptions, CatalogLockOptions {
  readonly dryRun?: boolean;
  /** Canonical name override; the default is derived from the source. */
  readonly name?: string;
  /** Explicit ref for remote sources; skips tree-URL boundary inference. */
  readonly ref?: string;
  /** Git access seam; the default runs the real git binary. */
  readonly git?: GitRunner;
}

/** Options for add: acquisition plus scope selection. */
export interface SkillAddOptions extends SkillAcquisitionOptions {
  readonly project?: string;
  readonly global?: boolean;
}

function requireCanonicalName(name: string): string {
  if (!isSkillName(name))
    fail("E_SKILL_NAME", `Invalid canonical skill name for this source: ${name}`, {
      name,
      fix: "Pass --name with a lowercase single-component canonical name (letters, digits, dots, dashes, underscores).",
    });
  return name;
}

function registryOptions(options: SkillAcquisitionOptions): RegistryOptions {
  return {
    ...(options.registryRoot === undefined ? {} : { registryRoot: options.registryRoot }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.installedRoot === undefined ? {} : { installedRoot: options.installedRoot }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
}

function catalogOptions(options: SkillAcquisitionOptions) {
  return {
    ...registryOptions(options),
    ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function selectionOptions(options: SkillAddOptions): SelectionOptions {
  return {
    ...registryOptions(options),
    ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.global === true ? { scope: "global" as const } : {}),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  };
}

function checkInterrupted(options: SkillAcquisitionOptions): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Skill acquisition was interrupted.",
      {
        fix: "Retry the import or add command; partial catalog imports are disclosed, not rolled back.",
      },
      ExitCode.INTERRUPTED,
    );
}

/** The catalog outcome of an import or add, before any activation facts. */
export interface SkillImportData {
  readonly name: string;
  readonly path: string;
  readonly dryRun: boolean;
  /** The catalog definition was written by this run. */
  readonly imported: boolean;
  /** A valid canonical definition already existed and was kept as-is. */
  readonly reused: boolean;
  readonly source: AcquisitionSourceInfo | undefined;
  readonly changes: readonly CatalogChange[];
}

function sourceInfoOf(location: SourceLocation): AcquisitionSourceInfo {
  switch (location.kind) {
    case "github-tree":
      return {
        kind: "github-tree",
        label: sanitizeSourceLabel(location.url),
        repo: `${location.owner}/${location.repo}`,
      };
    case "git":
      return { kind: "git", label: sanitizeSourceLabel(location.url) };
    case "path":
      return { kind: "path", label: location.input };
  }
}

/**
 * A canonical definition with this name must be a real directory carrying a
 * real SKILL.md whose metadata parses; anything else is refused, never
 * repaired or overwritten.
 */
async function validateExistingCanonical(registryRoot: string, name: string): Promise<void> {
  const path = await canonicalSkill(registryRoot, name);
  await readSkillMetadata(path);
}

async function contentDigestOf(path: string): Promise<string> {
  const content = await captureContent(path);
  return digestContent(content.entries);
}

function acquisitionFailure<T>(command: string, error: unknown): ResultEnvelope<T | null> {
  return makeResult(command, null, {
    exit: error instanceof SkillexError ? error.exit : ExitCode.FAILURE,
    findings:
      error instanceof SkillexError
        ? error.findings
        : [
            {
              code: "E_IO",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              fix: "Check the source, registry, and filesystem permissions, then retry.",
            },
          ],
  });
}

/**
 * Copy one skill (with its support files) from a GitHub tree URL, a Git
 * remote, or a local directory into the registry's all-skills/ catalog under
 * one canonical name. Delegates the guarded write to the standing
 * `skill import` machinery: no fork, no gitlink, no permanent clone, and a
 * same-named canonical is never overwritten — identical content is a
 * disclosed no-op, different content an explicit refusal.
 */
export async function importSkillFromSource(
  source: string,
  options: SkillAcquisitionOptions = {},
): Promise<ResultEnvelope<SkillImportData | null>> {
  const command = "import";
  try {
    checkInterrupted(options);
    const registry = await discoverRegistry(registryOptions(options));
    const name = requireCanonicalName(
      options.name ?? provisionalSkillName(parseSourceLocation(source)),
    );
    const canonicalPath = join(registry.root, "all-skills", name);
    const existing = await inspectPath(canonicalPath);
    const acquired = await acquireSkillSource(source, options);
    try {
      const info = acquired.info;
      if (existing) {
        await validateExistingCanonical(registry.root, name);
        const [sourceDigest, canonicalDigest] = await Promise.all([
          contentDigestOf(acquired.importPath),
          contentDigestOf(canonicalPath),
        ]);
        if (sourceDigest === canonicalDigest)
          return makeResult(
            command,
            {
              name,
              path: canonicalPath,
              dryRun: options.dryRun === true,
              imported: false,
              reused: true,
              source: info,
              changes: [],
            },
            {
              findings: [
                {
                  code: "I_IMPORT_REUSED",
                  severity: "info",
                  message: `Canonical ${name} already matches the source; nothing was imported.`,
                  path: canonicalPath,
                  fix: "Enable it with skillex add or skillex enable skill.",
                },
              ],
            },
          );
        fail(
          "E_IMPORT_NAME_CONFLICT",
          `Canonical ${name} exists with different content; import never overwrites it.`,
          {
            path: canonicalPath,
            name,
            detail: [`source: ${sourceDigest}`, `canonical: ${canonicalDigest}`],
            fix: "Import under a new --name, or update the canonical definition explicitly.",
          },
          ExitCode.REFUSED,
        );
      }
      // Receipts must outlive the ephemeral clone: record the sanitized label.
      const label = info.commit ? `${info.label}#${info.commit}` : undefined;
      const result = await importSkill(acquired.importPath, name, {
        ...catalogOptions(options),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(label === undefined ? {} : { importedFrom: label }),
      });
      if (!result.ok || !result.data)
        return makeResult(command, null, { exit: result.exit, findings: result.findings });
      return makeResult(command, {
        name,
        path: result.data.path,
        dryRun: result.data.dryRun,
        imported: !result.data.dryRun,
        reused: false,
        source: info,
        changes: result.data.changes,
      });
    } finally {
      await releaseAcquired(acquired);
    }
  } catch (error) {
    return acquisitionFailure(command, error);
  }
}

/** What happened to the activation half of an add. */
export interface SkillActivationSummary {
  readonly status: "applied" | "up-to-date" | "planned" | "deferred" | "failed";
  /** Activation stages in order ("init" only when the scope had no manifest). */
  readonly stages: readonly ("init" | "enable")[];
  readonly changes: readonly SelectionChange[];
  readonly applied: readonly SelectionChange[];
  readonly reason?: "canonical-not-imported" | "manifest-missing";
}

/** The full outcome of an add: catalog facts plus activation facts. */
export interface SkillAddData extends SkillImportData {
  readonly scope: "global" | "project";
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestCreated: boolean;
  readonly activation: SkillActivationSummary;
}

function reuseFinding(data: SkillImportData): Diagnostic {
  return {
    code: "I_ADD_REUSED",
    severity: "info",
    message: `Canonical ${data.name} was already present; it was enabled without fetching or changing it.`,
    path: data.path,
    fix: "Update the canonical definition explicitly when you want a new version.",
  };
}

function addPartialFinding(data: SkillAddData): Diagnostic {
  return {
    code: "E_ADD_PARTIAL",
    severity: "error",
    message: `The skill ${data.name} is imported in the catalog, but activating it in the ${data.scope} scope did not finish.`,
    path: data.path,
    fix: "Retry the same add command; the imported definition is reused without fetching it again. No rollback was attempted.",
  };
}

function activationOf(
  stages: readonly ("init" | "enable")[],
  summary: Partial<SkillActivationSummary> & { readonly status: SkillActivationSummary["status"] },
): SkillActivationSummary {
  return { stages, changes: [], applied: [], ...summary };
}

/**
 * Import a skill if (and only if) it has no canonical definition yet, then
 * enable it in one scope through the standing selection machinery. The scope
 * and its manifest are preflighted before any acquisition so a wrong-scope
 * request never durably changes anything: the current project is the default
 * (initialized from its checkout root when it has no manifest yet), -p/--project
 * selects a project explicitly, -g/--global selects the global scope, and a
 * run outside any project or checkout falls back to global.
 */
export async function addSkillFromSource(
  source: string,
  options: SkillAddOptions = {},
): Promise<ResultEnvelope<SkillAddData | null>> {
  const command = "add";
  try {
    checkInterrupted(options);
    if (options.project !== undefined && options.global === true)
      fail("E_SCOPE", "--global conflicts with an explicit project selector.", {
        fix: "Use -g/--global alone, or -p/--project without --global.",
      });
    // Preflight the scope and its manifest before any acquisition or catalog
    // write, so a refused scope selection leaves no durable trace anywhere.
    const selection = selectionOptions(options);
    const target: ScopeTarget = await selectScopeTarget(selection, { operation: "init" });
    const snapshot = await readSelectionManifest(target.root, { tolerant: true });
    if (snapshot.exists && (!snapshot.manifest || (snapshot.parseFindings?.length ?? 0) > 0)) {
      // A tolerant read recovered a declaration the selection machinery cannot
      // consume (legacy fields, invalid content). Refuse here — before any
      // acquisition — instead of importing into a scope that cannot enable.
      fail(
        "E_MANIFEST_INVALID",
        `The ${target.scope} manifest is not valid for selections: ${snapshot.path}`,
        {
          path: snapshot.path,
          detail: (snapshot.parseFindings ?? []).map(
            (finding) => `${finding.code}: ${finding.message}`,
          ),
          fix: "Run skillex normalize --dry-run, then --apply for this scope, and retry the add.",
        },
      );
    }
    const manifestMissing = !snapshot.exists;
    const stages: ("init" | "enable")[] = [...(manifestMissing ? ["init" as const] : []), "enable"];
    // Pin the preflighted scope for every later selection call: the network
    // fetch and the catalog import happen between preflight and activation,
    // and the enable must land in the root that was preflighted, never in a
    // root that discovery could pick afresh afterwards.
    const pinned: SelectionOptions = {
      ...selection,
      scope: target.scope,
      ...(target.scope === "project" ? { project: target.root } : {}),
    };

    const registry = await discoverRegistry(registryOptions(options));
    const name = requireCanonicalName(
      options.name ?? provisionalSkillName(parseSourceLocation(source)),
    );
    const canonicalPath = join(registry.root, "all-skills", name);
    const existing = await inspectPath(canonicalPath);
    const dryRun = options.dryRun === true;

    let imported = false;
    let reused = false;
    let changes: readonly CatalogChange[] = [];
    let info: AcquisitionSourceInfo | undefined = sourceInfoOf(parseSourceLocation(source));

    if (existing) {
      // The user asked to import only if absent: a valid canonical definition
      // is activated as-is, with no network access and no silent update.
      await validateExistingCanonical(registry.root, name);
      reused = true;
    } else {
      const acquired = await acquireSkillSource(source, options);
      try {
        info = acquired.info;
        const label = acquired.info.commit
          ? `${acquired.info.label}#${acquired.info.commit}`
          : undefined;
        const result = await importSkill(acquired.importPath, name, {
          ...catalogOptions(options),
          ...(dryRun ? { dryRun: true } : {}),
          ...(label === undefined ? {} : { importedFrom: label }),
        });
        if (!result.ok || !result.data)
          return makeResult(command, null, { exit: result.exit, findings: result.findings });
        changes = result.data.changes;
        imported = !result.data.dryRun;
      } finally {
        await releaseAcquired(acquired);
      }
    }

    const base: SkillImportData = {
      name,
      path: canonicalPath,
      dryRun,
      imported,
      reused,
      source: info,
      changes,
    };
    const scopeFacts = {
      scope: target.scope,
      root: target.root,
      manifestPath: snapshot.path,
    };

    if (dryRun && !existing) {
      // The import is only planned, so activation cannot be preflighted
      // against a canonical that is not there yet: stage an honest plan
      // instead of a fabricated final one. Planning the would-be init is
      // safe (dry-run writes nothing); the enable stage stays deferred.
      const init = manifestMissing ? await initScope(pinned) : undefined;
      const data: SkillAddData = {
        ...base,
        ...scopeFacts,
        manifestCreated: false,
        activation: activationOf(stages, {
          status: "deferred",
          reason: "canonical-not-imported",
          ...(init?.data ? { changes: init.data.changes } : {}),
        }),
      };
      return makeResult(command, data, {
        findings: [
          ...(init?.findings ?? []),
          {
            code: "W_ADD_ACTIVATION_DEFERRED",
            severity: "warning",
            message: `Dry-run cannot preflight enabling ${name} before it is imported.`,
            path: canonicalPath,
            fix: "Re-run without --dry-run to import and enable, then re-run with --dry-run to verify the activation plan.",
          },
        ],
      });
    }

    if (dryRun) {
      if (manifestMissing) {
        const init = await initScope(pinned);
        const data: SkillAddData = {
          ...base,
          ...scopeFacts,
          manifestCreated: false,
          activation: activationOf(stages, {
            status: "deferred",
            reason: "manifest-missing",
            ...(init.data ? { changes: init.data.changes } : {}),
          }),
        };
        if (!init.ok)
          return makeResult(command, data, { exit: init.exit, findings: init.findings });
        return makeResult(command, data, {
          findings: [
            ...init.findings,
            {
              code: "W_ADD_ACTIVATION_DEFERRED",
              severity: "warning",
              message: `The ${target.scope} scope has no manifest yet; enabling ${name} is planned only after it is initialized.`,
              path: snapshot.path,
              fix: "Re-run without --dry-run to initialize the scope and enable the skill.",
            },
            reuseFinding(base),
          ],
        });
      }
      const enable = await enableSelection("skill", name, pinned);
      const data: SkillAddData = {
        ...base,
        ...scopeFacts,
        manifestCreated: false,
        activation: activationOf(stages, {
          status: !enable.ok
            ? "failed"
            : enable.data && enable.data.changes.length === 0
              ? "up-to-date"
              : "planned",
          ...(enable.data ? { changes: enable.data.changes } : {}),
        }),
      };
      if (!enable.ok)
        return makeResult(command, data, { exit: enable.exit, findings: enable.findings });
      return makeResult(command, data, {
        findings: [...enable.findings, ...(reused ? [reuseFinding(base)] : [])],
      });
    }

    // Real run: initialize the scope when needed, then enable the skill.
    let manifestCreated = false;
    if (manifestMissing) {
      const init = await initScope(pinned);
      if (!init.ok) {
        const data: SkillAddData = {
          ...base,
          ...scopeFacts,
          manifestCreated: false,
          activation: activationOf(stages, { status: "failed", reason: "manifest-missing" }),
        };
        if (imported)
          return makeResult(command, data, {
            exit: ExitCode.PARTIAL,
            findings: [...init.findings, addPartialFinding(data)],
          });
        return makeResult(command, data, { exit: init.exit, findings: init.findings });
      }
      manifestCreated = init.data?.saved === true;
    }
    const enable = await enableSelection("skill", name, pinned);
    const applied = enable.data?.applied ?? [];
    const data: SkillAddData = {
      ...base,
      ...scopeFacts,
      manifestCreated,
      activation: activationOf(stages, {
        status: enable.ok ? (applied.length > 0 ? "applied" : "up-to-date") : "failed",
        ...(enable.data ? { changes: enable.data.changes, applied } : {}),
      }),
    };
    if (!enable.ok) {
      if (imported || manifestCreated)
        return makeResult(command, data, {
          exit: ExitCode.PARTIAL,
          findings: [...enable.findings, addPartialFinding(data)],
        });
      return makeResult(command, data, { exit: enable.exit, findings: enable.findings });
    }
    return makeResult(command, data, {
      findings: [...enable.findings, ...(reused ? [reuseFinding(base)] : [])],
    });
  } catch (error) {
    return acquisitionFailure(command, error);
  }
}
