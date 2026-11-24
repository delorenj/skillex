import { lstat, readdir, readlink, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { GLOBAL_CLI_ALIASES } from "./aliases.js";
import type { SyncChange } from "./reconciliation-types.js";
import type { Diagnostic } from "./result.js";

/**
 * Global agent skill roots that hold per-skill links INTO the canonical root instead of
 * aliasing it, relative to HOME.
 *
 * They are never aliased. Pi reads `~/.agents/skills` natively and keeps the first of two
 * same-named skills, so aliasing its root would list every skill twice. Antigravity's roots are
 * filled by installers such as `npx skills add`. Skillex adds nothing to these roots and never
 * touches a real directory or a live link in them. It removes only a link that dangles and
 * whose target lies in the canonical root or a global CLI alias: the link an installer left
 * behind when that skill was later deselected.
 */
export const GLOBAL_DOWNSTREAM_ROOTS = Object.freeze([
  ".pi/agent/skills",
  ".gemini/antigravity/skills",
  ".gemini/antigravity-cli/skills",
] as const);

export interface DanglingDownstreamLink {
  readonly root: string;
  readonly path: string;
  readonly target: string;
}

const MISSING = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function missing(error: unknown): boolean {
  return MISSING.has((error as NodeJS.ErrnoException).code ?? "");
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function managedRoots(home: string): string[] {
  return [join(home, ".agents", "skills"), ...GLOBAL_CLI_ALIASES.map((alias) => join(home, alias))];
}

/** A link skillex may remove: still a symlink, same body, still dangling, into a managed root. */
async function prunable(path: string, managed: readonly string[]): Promise<string | undefined> {
  let target: string;
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
    target = await readlink(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const lexical = resolve(dirname(path), target);
  if (!managed.some((root) => within(lexical, root))) return undefined;
  try {
    await stat(path);
    return undefined;
  } catch (error) {
    if (missing(error)) return target;
    throw error;
  }
}

/** Read-only: every dangling skillex-owned-target link in the global downstream roots. */
export async function danglingDownstreamLinks(home: string): Promise<DanglingDownstreamLink[]> {
  const managed = managedRoots(home);
  const found: DanglingDownstreamLink[] = [];
  for (const relativeRoot of GLOBAL_DOWNSTREAM_ROOTS) {
    const root = join(home, relativeRoot);
    let names: string[];
    try {
      // A root that is itself a link is someone's alias; its entries are not ours to judge here.
      if (!(await lstat(root)).isDirectory()) continue;
      names = (await readdir(root)).sort();
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = join(root, name);
      const target = await prunable(path, managed);
      if (target !== undefined) found.push({ root, path, target });
    }
  }
  return found;
}

export function downstreamChanges(links: readonly DanglingDownstreamLink[]): SyncChange[] {
  return links.map(({ path, target }) => ({
    scope: "global",
    action: "prune-downstream-link",
    path,
    target,
  }));
}

export function downstreamFindings(links: readonly DanglingDownstreamLink[]): Diagnostic[] {
  const byRoot = new Map<string, string[]>();
  for (const link of links) byRoot.set(link.root, [...(byRoot.get(link.root) ?? []), link.path]);
  return [...byRoot].map(([root, paths]) => ({
    code: "W_DOWNSTREAM_LINK_DANGLING",
    severity: "warning" as const,
    scope: "global" as const,
    path: root,
    message: `${paths.length} skill link(s) in this agent root point at skills no longer selected.`,
    fix: "Run skillex sync; it removes only these dangling links and leaves live links and real directories alone.",
    detail: paths,
  }));
}

/** Remove each link that is still dangling with the same body; re-checked just before unlink. */
export async function pruneDownstreamLinks(home: string): Promise<SyncChange[]> {
  const managed = managedRoots(home);
  const removed: DanglingDownstreamLink[] = [];
  for (const link of await danglingDownstreamLinks(home)) {
    if ((await prunable(link.path, managed)) !== link.target) continue;
    try {
      await unlink(link.path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    removed.push(link);
  }
  return downstreamChanges(removed);
}
