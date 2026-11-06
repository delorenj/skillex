import { execFile } from "node:child_process";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SkillOwner } from "./catalog-types.js";
import { isWithin } from "./content.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { type RegistryRef, registryContext } from "./registry-context.js";
import { ExitCode } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import {
  normalizeVendorRepo,
  parseVendorSourcesText,
  readVendorText,
  resolveVendorCheckout,
} from "./vendor-sources.js";
import type { VendorCheckout, VendorSource } from "./vendor-types.js";

const execute = promisify(execFile);

/** A skill defined in its owning repository's working tree (ADR-0002), never in all-skills/. */
export interface OwnedSkill {
  readonly name: string;
  /** Realpath of <checkout>/<subdir>/<name>: a real directory inside the checkout. */
  readonly path: string;
  readonly source: string;
  readonly repo: string;
  readonly checkout: string;
  readonly checkoutRoot: string;
  /** Realpath of <checkout>/<subdir>: the directory that holds the repository's one hub. */
  readonly skillsRoot: string;
  readonly subdir: string;
}

/** Link-mode declarations from all-skills/sources.toml. Names are known without any checkout. */
export interface OwnedDeclarations {
  readonly path: string;
  readonly sources: readonly VendorSource[];
  readonly owners: ReadonlyMap<string, VendorSource>;
}

export interface OwnedCheckout {
  readonly source: VendorSource;
  readonly checkout: VendorCheckout;
}

const declarationMemo = new WeakMap<RegistrySelection, Promise<OwnedDeclarations>>();
const checkoutMemo = new WeakMap<RegistrySelection, Map<string, Promise<OwnedCheckout>>>();
const scanLimit = 50_000;

async function readDeclarations(root: string): Promise<OwnedDeclarations> {
  const path = join(root, "all-skills", "sources.toml");
  let sources: VendorSource[] = [];
  try {
    const text = await readVendorText(path, "E_SOURCES_MANIFEST_INVALID");
    if (text !== null) {
      sources = parseVendorSourcesText(text, path).filter((source) => source.mode === "link");
    }
  } catch (error) {
    // Catalog and resolution paths never read this manifest before ADR-0002. A manifest that
    // cannot be read or parsed (symlinked, non-UTF-8, oversized, rewritten mid-read by a pull)
    // declares no owned names here; the vendor commands and doctor read it strictly and report.
    if (!(error instanceof SkillexError) && !isErrno(error)) throw error;
  }
  const owners = new Map<string, VendorSource>();
  for (const source of sources) for (const skill of source.skills) owners.set(skill.name, source);
  return { path, sources, owners };
}

function isErrno(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** Bare-root reads are memoized per process, keyed by the manifest's lstat identity. */
const rootMemo = new Map<
  string,
  { readonly stamp: string; readonly pending: Promise<OwnedDeclarations> }
>();

async function manifestStamp(root: string): Promise<string> {
  try {
    const info = await lstat(join(root, "all-skills", "sources.toml"));
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return "absent";
  }
}

async function readDeclarationsMemo(root: string): Promise<OwnedDeclarations> {
  const stamp = await manifestStamp(root);
  const cached = rootMemo.get(root);
  if (cached && cached.stamp === stamp) return cached.pending;
  const pending = readDeclarations(root);
  rootMemo.set(root, { stamp, pending });
  return pending;
}

/** Declared repo-owned names. A selection memoizes them; a bare root reuses an unchanged read. */
export function ownedDeclarations(registry: RegistryRef): Promise<OwnedDeclarations> {
  if (typeof registry === "string") return readDeclarationsMemo(registry);
  let pending = declarationMemo.get(registry);
  if (!pending) {
    pending = readDeclarations(registry.root);
    declarationMemo.set(registry, pending);
  }
  return pending;
}

/** The link source that owns a name, or undefined for catalog and unknown names. */
export async function ownedSource(
  registry: RegistryRef,
  name: string,
): Promise<VendorSource | undefined> {
  return (await ownedDeclarations(registry)).owners.get(name);
}

function gitEnvironment(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(merged)) if (key.startsWith("GIT_")) delete merged[key];
  return {
    ...merged,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function git(
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  try {
    const { stdout } = await execute("git", ["-C", root, ...args], {
      env: gitEnvironment(env),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      fail(
        "E_SOURCE_GIT_UNAVAILABLE",
        "Git is unavailable for verifying a repo-owned source checkout.",
        { path: root, fix: "Install Git; link sources verify their checkout's identity with it." },
        ExitCode.FAILURE,
      );
    return null;
  }
}

/** A link checkout must be the top level of a working tree of the declared repository. */
async function verifyIdentity(
  source: VendorSource,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const marker = join(root, "STALE-CHECKOUT.md");
  if (await inspectPath(marker))
    fail(
      "E_SOURCE_CHECKOUT_STALE",
      `Checkout ${root} for source ${source.name} is marked stale.`,
      {
        path: marker,
        name: source.name,
        fix: `Map checkout ID ${source.checkout} to the live checkout in ~/.config/skillex/sources.local.toml [checkouts], or set ${`SKILLEX_SOURCE_${source.checkout.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`}.`,
      },
      ExitCode.REFUSED,
    );
  const toplevel = await git(root, ["rev-parse", "--show-toplevel"], env);
  let top: string | null = null;
  if (toplevel) {
    try {
      top = await realpath(toplevel);
    } catch {
      top = null;
    }
  }
  if (top !== root)
    fail(
      "E_SOURCE_CHECKOUT_INVALID",
      `Checkout ${root} for source ${source.name} is not the top level of a Git working tree.`,
      {
        path: root,
        name: source.name,
        fix: "Map this checkout ID to the repository's own working tree root; an enclosing repository is never borrowed.",
      },
      ExitCode.REFUSED,
    );
  const origin = await git(root, ["config", "--get", "remote.origin.url"], env);
  if (!origin || normalizeVendorRepo(origin) !== normalizeVendorRepo(source.repo))
    fail(
      "E_SOURCE_IDENTITY_MISMATCH",
      `Checkout ${root} is not a clone of ${source.repo}.`,
      {
        path: root,
        name: source.name,
        detail: [`declared ${source.repo}`, `origin ${origin || "(none)"}`],
        fix: `Map checkout ID ${source.checkout} to a clone of the declared repository, or correct the declaration.`,
      },
      ExitCode.REFUSED,
    );
}

async function resolveCheckout(
  registry: RegistryRef,
  source: VendorSource,
): Promise<OwnedCheckout> {
  const context = registryContext(registry);
  const checkout = await resolveVendorCheckout(source, context);
  if (checkout.root) await verifyIdentity(source, checkout.root, context.env);
  return { source, checkout };
}

/**
 * Resolve and verify one link source's checkout. An absent checkout yields root null; a present
 * checkout of the wrong repository, a stale one, or a non-root one is always refused.
 */
export function ownedCheckout(registry: RegistryRef, source: VendorSource): Promise<OwnedCheckout> {
  if (typeof registry === "string") return resolveCheckout(registry, source);
  let sources = checkoutMemo.get(registry);
  if (!sources) {
    sources = new Map();
    checkoutMemo.set(registry, sources);
  }
  let pending = sources.get(source.name);
  if (!pending) {
    pending = resolveCheckout(registry, source);
    sources.set(source.name, pending);
  }
  return pending;
}

/** Refuse any symbolic link in the skill whose target leaves the owning checkout. */
async function assertContained(path: string, checkoutRoot: string): Promise<void> {
  const pending = [path];
  let seen = 0;
  while (pending.length) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++seen > scanLimit)
        fail(
          "E_OWNED_SKILL_TOO_LARGE",
          `Repo-owned skill ${path} has more than ${scanLimit} entries.`,
          { path, fix: "Keep a hub small; move generated or vendored trees out of the skill." },
          ExitCode.REFUSED,
        );
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(child);
        } catch {
          target = resolve(dirname(child), await readlink(child));
        }
        if (!isWithin(checkoutRoot, target))
          fail(
            "E_OWNED_SKILL_ESCAPE",
            `A link inside repo-owned skill ${path} leaves its checkout.`,
            {
              path: child,
              detail: [`target ${target}`, `checkout ${checkoutRoot}`],
              fix: "Replace the link with real content inside the owning repository.",
            },
            ExitCode.REFUSED,
          );
      } else if (entry.isDirectory() && entry.name !== ".git") pending.push(child);
    }
  }
}

/**
 * Resolve a repo-owned skill, or undefined when no link source declares the name. A declared name
 * whose checkout is unavailable fails: E_SOURCE_CHECKOUT_MISSING for a required source and
 * E_SKILL_MISSING for an optional one. Filesystem checks run on every call.
 */
export async function ownedSkill(
  registry: RegistryRef,
  name: string,
): Promise<OwnedSkill | undefined> {
  const source = await ownedSource(registry, name);
  if (!source) return undefined;
  const { checkout } = await ownedCheckout(registry, source);
  const root = checkout.root;
  if (!root)
    fail(
      source.optional ? "E_SKILL_MISSING" : "E_SOURCE_CHECKOUT_MISSING",
      `Repo-owned skill ${name} needs a local checkout of source ${source.name} (${source.repo}).`,
      {
        name,
        detail: checkout.searched,
        fix: `Clone ${source.repo}, then map checkout ID ${source.checkout} in ~/.config/skillex/sources.local.toml [checkouts] unless it lives at ~/code/${source.checkout}.`,
      },
      ExitCode.REFUSED,
    );
  const declared = join(root, source.subdir, name);
  const info = await inspectPath(declared);
  if (!info)
    fail(
      "E_SKILL_MISSING",
      `Source ${source.name} declares ${name}, but its checkout has no ${join(source.subdir, name)}.`,
      {
        path: declared,
        name,
        fix: "Author the hub in the owning repository, or correct the source declaration.",
      },
      ExitCode.REFUSED,
    );
  if (!info.isDirectory())
    fail(
      "E_NONCANONICAL_REFERENCE",
      `Repo-owned skill ${name} must be a real directory in its checkout.`,
      {
        path: declared,
        name,
        fix: "Replace the link with the hub's real directory in the owning repository.",
      },
      ExitCode.REFUSED,
    );
  const path = await realpath(declared);
  if (!isWithin(root, path) || path === root)
    fail(
      "E_OWNED_SKILL_ESCAPE",
      `Repo-owned skill ${name} resolves outside its checkout.`,
      {
        path: declared,
        name,
        detail: [`resolved ${path}`, `checkout ${root}`],
        fix: "Keep the source subdir and hub as real directories inside the owning repository.",
      },
      ExitCode.REFUSED,
    );
  const definition = join(path, "SKILL.md");
  const entry = await inspectPath(definition);
  if (!entry)
    fail(
      "E_SKILL_MISSING",
      `Repo-owned skill ${name} has no SKILL.md.`,
      { path: definition, name, fix: "Create the hub's SKILL.md in the owning repository." },
      ExitCode.REFUSED,
    );
  if (!entry.isFile())
    fail(
      "E_NONCANONICAL_REFERENCE",
      `SKILL.md must be a real file: ${definition}`,
      {
        path: definition,
        name,
        fix: "Restore SKILL.md as a regular file in the owning repository.",
      },
      ExitCode.REFUSED,
    );
  await assertContained(path, root);
  return {
    name,
    path,
    source: source.name,
    repo: source.repo,
    checkout: source.checkout,
    checkoutRoot: root,
    skillsRoot: dirname(path),
    subdir: source.subdir,
  };
}

/** Every declared repo-owned skill, resolved independently; failures are returned, not thrown. */
export async function ownedSkills(registry: RegistryRef): Promise<
  readonly {
    readonly name: string;
    readonly source: VendorSource;
    readonly skill?: OwnedSkill;
    readonly error?: SkillexError;
  }[]
> {
  const declarations = await ownedDeclarations(registry);
  const results = [];
  for (const [name, source] of [...declarations.owners].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    try {
      const skill = await ownedSkill(registry, name);
      results.push(skill ? { name, source, skill } : { name, source });
    } catch (error) {
      if (!(error instanceof SkillexError)) throw error;
      results.push({ name, source, error });
    }
  }
  return results;
}

/** The owning repository's HEAD, for provenance displays. Null when Git cannot say. */
export async function ownedCommit(
  registry: RegistryRef,
  checkoutRoot: string,
): Promise<string | null> {
  try {
    const commit = await git(checkoutRoot, ["rev-parse", "HEAD"], registryContext(registry).env);
    return commit && /^[a-f0-9]{40,64}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export const catalogOwner: SkillOwner = {
  kind: "catalog",
  source: null,
  repo: null,
  checkout: null,
  commit: null,
};

/** The owner of a resolved definition path: its link source when it is repo-owned. */
export async function skillOwner(
  registry: RegistryRef,
  name: string,
  path: string,
): Promise<SkillOwner> {
  if (!(await ownedSource(registry, name))) return catalogOwner;
  const owned = await ownedSkill(registry, name);
  if (!owned || owned.path !== path) return catalogOwner;
  return {
    kind: "repo",
    source: owned.source,
    repo: owned.repo,
    checkout: owned.checkoutRoot,
    commit: await ownedCommit(registry, owned.checkoutRoot),
  };
}
