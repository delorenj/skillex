import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import { type ContentEntry, digestContent } from "./content.js";
import { fail, SkillexError } from "./error.js";
import { isSkillName } from "./manifest.js";
import { parseProvenanceMetadata, parseSkillMetadata } from "./metadata.js";
import { ExitCode } from "./result.js";
import type { VendorOptions, VendorSource } from "./vendor-types.js";

const execute = promisify(execFile);
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface VendorPin {
  readonly commit: string;
  readonly refKind: "branch" | "tag" | "commit" | "unknown";
  readonly committedAt: string;
  readonly origin?: string;
}

export interface VendorGitSkill {
  readonly name: string;
  readonly upstreamPath: string;
  readonly tree: string;
  readonly digest: string;
  readonly entries: readonly ContentEntry[];
  readonly previousProvenance?: Readonly<Record<string, unknown>>;
}

export interface VendorGitSource extends VendorPin {
  readonly source: VendorSource;
  readonly checkout: string;
  readonly skills: readonly VendorGitSkill[];
}

interface TreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

export function vendorInterrupted(options: Pick<VendorOptions, "signal">): void {
  if (options.signal?.aborted) {
    fail(
      "E_INTERRUPTED",
      "Vendor operation interrupted.",
      { fix: "Inspect the applied changes and retry vendor sync to recover any pending update." },
      ExitCode.INTERRUPTED,
    );
  }
}

function gitEnvironment(options: VendorOptions): NodeJS.ProcessEnv {
  const env = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function git(
  root: string,
  args: readonly string[],
  options: VendorOptions,
  missingRef = false,
  allowAbsent = false,
): Promise<Buffer> {
  vendorInterrupted(options);
  try {
    const result = await execute(
      "git",
      ["--no-lazy-fetch", "-c", "protocol.allow=never", "-C", root, ...args],
      {
        env: gitEnvironment(options),
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    vendorInterrupted(options);
    return result.stdout;
  } catch (error) {
    vendorInterrupted(options);
    if (error instanceof SkillexError) throw error;
    if (allowAbsent && (error as { code?: unknown }).code === 1) return Buffer.alloc(0);
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    fail(
      absent ? "E_VENDOR_GIT_UNAVAILABLE" : missingRef ? "E_VENDOR_REF" : "E_VENDOR_GIT",
      absent
        ? "Git is unavailable for reading the selected local checkout."
        : missingRef
          ? "The declared version does not resolve to an available local commit."
          : "Git could not read the required local committed objects without fetching.",
      {
        path: root,
        fix: absent
          ? "Install Git with --no-lazy-fetch support and retry."
          : missingRef
            ? "Correct the declared version or make its complete commit available in this local checkout; vendor sync never fetches."
            : "Check the local repository and object availability with a Git version supporting --no-lazy-fetch; prepare missing objects explicitly before retrying.",
      },
      absent ? ExitCode.FAILURE : missingRef ? ExitCode.CONFIG : ExitCode.REFUSED,
    );
  }
}

function text(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("E_INVALID_UTF8", "Committed names and skill metadata must be valid UTF-8.", {
      path,
      fix: "Correct the upstream filename or metadata encoding and commit the change before retrying.",
    });
  }
}

function safePath(path: string, context: string): void {
  if (
    !path ||
    path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || /^(?:\.git|\.hg|\.svn)$/i.test(part),
      ) ||
    path.includes("\\") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    posix.isAbsolute(path)
  ) {
    fail(
      "E_VENDOR_UNSAFE_PATH",
      "A committed source entry has an unsafe or reserved path.",
      {
        path: context,
        fix: "Rename the upstream entry to a portable relative path and commit it.",
      },
      ExitCode.REFUSED,
    );
  }
}

async function treeEntries(
  root: string,
  tree: string,
  options: VendorOptions,
  recursive = false,
): Promise<TreeEntry[]> {
  const bytes = await git(root, ["ls-tree", "-z", ...(recursive ? ["-r"] : []), tree], options);
  const entries: TreeEntry[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue;
    const record = bytes.subarray(start, index);
    const separator = record.indexOf(9);
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^([0-9]{6}) (blob|tree|commit) ([a-f0-9]+)$/.exec(header);
    if (separator < 0 || !match || !oidPattern.test(match[3] ?? "")) {
      fail(
        "E_VENDOR_GIT",
        "Git returned a malformed tree record.",
        { path: root },
        ExitCode.REFUSED,
      );
    }
    const name = text(record.subarray(separator + 1), root);
    safePath(name, `${root}:${name}`);
    entries.push({
      name,
      mode: match[1] as string,
      type: match[2] as string,
      oid: match[3] as string,
    });
    start = index + 1;
  }
  if (start !== bytes.length) {
    fail(
      "E_VENDOR_GIT",
      "Git returned an unterminated tree record.",
      { path: root },
      ExitCode.REFUSED,
    );
  }
  return entries;
}

function requireTree(entry: TreeEntry | undefined, path: string): string {
  if (!entry) {
    fail("E_VENDOR_SOURCE_MISSING", "A declared skill directory is absent from the pinned tree.", {
      path,
      fix: "Correct subdir/skills in sources.toml or select a commit containing the skill directory.",
    });
  }
  if (entry.mode === "120000") {
    fail(
      "E_SOURCE_ENTRY_IS_LINK",
      "A source skill directory is a committed symlink.",
      { path, fix: "Declare the upstream repository containing the real skill definition." },
      ExitCode.REFUSED,
    );
  }
  if (entry.mode !== "040000" || entry.type !== "tree") {
    fail(
      "E_VENDOR_SOURCE_TYPE",
      "A source skill must be a committed tree, not a file or submodule.",
      { path, fix: "Point the declaration at a real committed skill directory." },
      ExitCode.REFUSED,
    );
  }
  return entry.oid;
}

async function treeAt(
  root: string,
  tree: string,
  path: string,
  options: VendorOptions,
): Promise<string> {
  let current = tree;
  for (const part of path ? path.split("/") : []) {
    current = requireTree(
      (await treeEntries(root, current, options)).find((entry) => entry.name === part),
      `${root}:${path}`,
    );
  }
  return current;
}

/** Resolve a local commit without checking out files, fetching, or consulting replacement objects. */
export async function resolveVendorPin(
  source: VendorSource,
  checkoutRoot: string,
  options: VendorOptions = {},
): Promise<VendorPin> {
  const root = await realpath(checkoutRoot);
  const bare =
    text(await git(root, ["rev-parse", "--is-bare-repository"], options), root).trim() === "true";
  const declaredRoot = text(
    await git(root, ["rev-parse", bare ? "--absolute-git-dir" : "--show-toplevel"], options),
    root,
  ).trim();
  if ((await realpath(declaredRoot)) !== root) {
    fail(
      "E_VENDOR_CHECKOUT_ROOT",
      "The mapped checkout is not the root of its Git repository.",
      {
        path: root,
        fix: "Map this checkout ID to the actual worktree or bare repository root; an enclosing repository is never borrowed.",
      },
      ExitCode.REFUSED,
    );
  }
  const commit = text(
    await git(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${source.version}^{commit}`],
      options,
      true,
    ),
    root,
  ).trim();
  if (!oidPattern.test(commit)) {
    fail("E_VENDOR_REF", "The declared version did not resolve to one commit.", { path: root });
  }
  const ref = text(
    await git(
      root,
      ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", source.version],
      options,
      true,
    ),
    root,
  ).trim();
  const committedAt = text(
    await git(root, ["show", "-s", "--format=%cI", commit, "--"], options),
    root,
  ).trim();
  if (!Number.isFinite(Date.parse(committedAt))) {
    fail("E_VENDOR_GIT", "The selected commit has an invalid commit timestamp.", { path: root });
  }
  const origin = text(
    await git(root, ["config", "--get", "remote.origin.url"], options, false, true),
    root,
  ).trim();
  return {
    commit,
    refKind:
      ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/")
        ? "branch"
        : ref.startsWith("refs/tags/")
          ? "tag"
          : /^[a-f0-9]{7,64}$/i.test(source.version)
            ? "commit"
            : "unknown",
    committedAt,
    ...(origin ? { origin } : {}),
  };
}

async function extractSkill(
  root: string,
  name: string,
  upstreamPath: string,
  tree: string,
  options: VendorOptions,
): Promise<VendorGitSkill> {
  const entries: ContentEntry[] = [];
  const directories = new Set<string>();
  let previousProvenance: Readonly<Record<string, unknown>> | undefined;
  const files = await treeEntries(root, tree, options, true);
  const skill = files.find((entry) => entry.name === "SKILL.md");
  if (!skill) {
    fail(
      "E_SKILL_MISSING",
      "The pinned source skill is missing SKILL.md.",
      {
        path: `${root}:${upstreamPath}/SKILL.md`,
        fix: "Point sources.toml at a complete skill or commit its missing SKILL.md.",
      },
      ExitCode.REFUSED,
    );
  }
  for (const file of files) {
    const path = `${root}:${upstreamPath}/${file.name}`;
    if (file.type !== "blob" || !["100644", "100755"].includes(file.mode)) {
      fail(
        "E_VENDOR_CONTENT",
        "Vendored content must contain only regular committed files; symlinks and submodules are refused.",
        {
          path,
          fix: "Replace the upstream link/submodule with skill-owned regular content and commit it.",
        },
        ExitCode.REFUSED,
      );
    }
    const bytes = await git(root, ["cat-file", "blob", file.oid], options);
    if (file.name === "SKILL.md") parseSkillMetadata(text(bytes, path), path);
    if (file.name === ".source.yaml") {
      previousProvenance = parseProvenanceMetadata(text(bytes, path), path);
      continue;
    }
    let directory = posix.dirname(file.name);
    while (directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
    entries.push({
      path: file.name,
      kind: "file",
      mode: file.mode === "100755" ? 0o755 : 0o644,
      bytes,
    });
  }
  entries.unshift(
    ...[...directories].sort().map((path) => ({ path, kind: "directory" as const, mode: 0o755 })),
  );
  return {
    name,
    upstreamPath,
    tree,
    digest: digestContent(entries),
    entries,
    ...(previousProvenance ? { previousProvenance } : {}),
  };
}

/** Read skill bytes by immutable blob OID; dirty checkout bytes and index state are irrelevant. */
export async function readVendorGitSource(
  source: VendorSource,
  checkoutRoot: string,
  options: VendorOptions = {},
): Promise<VendorGitSource> {
  const checkout = await realpath(checkoutRoot);
  const pin = await resolveVendorPin(source, checkout, options);
  const rootTree = text(
    await git(checkout, ["rev-parse", "--verify", `${pin.commit}^{tree}`], options),
    checkout,
  ).trim();
  const base = await treeAt(checkout, rootTree, source.subdir, options);
  const children = await treeEntries(checkout, base, options);
  const declarations =
    source.membership === "explicit"
      ? source.skills
      : children
          .filter(
            (entry) =>
              !entry.name.startsWith(".") &&
              !entry.name.startsWith("_") &&
              (entry.type === "tree" || entry.mode === "120000" || entry.mode === "160000"),
          )
          .map((entry) => ({ name: entry.name, dir: entry.name }));
  const selected = declarations.filter(
    (entry) =>
      (!source.include.length || source.include.includes(entry.name)) &&
      !source.exclude.includes(entry.name),
  );
  for (const name of source.include) {
    if (!declarations.some((entry) => entry.name === name)) {
      fail("E_VENDOR_SOURCE_MISSING", `Included skill ${name} is absent from the pinned source.`, {
        name,
        path: checkout,
        fix: "Correct the include list or make the skill available in the selected commit.",
      });
    }
  }
  const skills: VendorGitSkill[] = [];
  for (const declaration of selected.sort((a, b) => a.name.localeCompare(b.name))) {
    const tree = await treeAt(checkout, base, declaration.dir, options);
    if (
      source.membership === "discovery" &&
      !source.include.includes(declaration.name) &&
      !(await treeEntries(checkout, tree, options)).some((entry) => entry.name === "SKILL.md")
    )
      continue;
    if (!isSkillName(declaration.name)) {
      fail("E_VENDOR_SKILL_NAME", "A discovered upstream skill needs a canonical lowercase name.", {
        name: declaration.name,
        path: checkout,
        fix: "Declare an explicit {name, dir} mapping with a safe lowercase canonical name.",
      });
    }
    const upstreamPath = posix.join(source.subdir, declaration.dir);
    skills.push(await extractSkill(checkout, declaration.name, upstreamPath, tree, options));
  }
  return { source, checkout, ...pin, skills };
}
