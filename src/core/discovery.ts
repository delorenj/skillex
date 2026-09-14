import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./error.js";
import { type Diagnostic, ExitCode } from "./result.js";
import type {
  DiscoveryOptions,
  RegistryOptions,
  RegistrySelection,
  ScopeDiscovery,
  ScopeLocation,
  ScopeName,
} from "./selection.js";

const manifestParts = [".agents", "skills.json"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ioFailure(path: string, error: unknown): never {
  return fail(
    "E_PATH_READ",
    `Cannot inspect ${path}: ${errorMessage(error)}`,
    { path, fix: "Check the path and its permissions, then retry." },
    ExitCode.FAILURE,
  );
}

/** Only an absent path is a miss. Broken parents and access errors are failures. */
async function entry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return ioFailure(path, error);
  }
}

async function followedEntry(path: string, found: Stats): Promise<Stats> {
  if (!found.isSymbolicLink()) return found;
  try {
    return await stat(path);
  } catch (error) {
    return ioFailure(path, error);
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    return ioFailure(path, error);
  }
}

function absolutePath(
  value: string,
  cwd: string,
  home: string,
  code: Diagnostic["code"],
  label: string,
): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    fail(code, `${label} requires a nonempty filesystem path.`, {
      fix: `Set ${label} to an existing directory.`,
    });
  }
  const expanded =
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  return resolve(cwd, expanded);
}

async function requiredDirectory(
  path: string,
  code: Diagnostic["code"],
  label: string,
): Promise<string> {
  const found = await entry(path);
  if (!found || !(await followedEntry(path, found)).isDirectory()) {
    fail(code, `${label} is not an existing directory: ${path}`, {
      path,
      fix: `Choose an existing directory for ${label}.`,
    });
  }
  return canonical(path);
}

async function location(scope: ScopeName, root: string): Promise<ScopeLocation> {
  const path = join(root, ...manifestParts);
  if (scope === "global") {
    // The project may disable inheritance or select an exclusive pack. Defer
    // global validation until the resolver knows whether this source is needed.
    // An uninspectable path must still be read if required, rather than treated
    // as an absent optional manifest and silently replaced by empty selections.
    let exists = true;
    try {
      await lstat(path);
    } catch (error) {
      exists = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    return { scope, root, path, exists };
  }
  const found = await entry(path);
  if (found && !(await followedEntry(path, found)).isFile()) {
    fail("E_MANIFEST_PATH", `The ${scope} manifest is not a file: ${path}`, {
      path,
      scope,
      fix: "Restore .agents/skills.json as a readable JSON file.",
    });
  }
  return { scope, root, path, exists: found !== undefined };
}

async function nearestProject(cwd: string, home: string): Promise<ScopeLocation | undefined> {
  let current = cwd;
  while (current !== home && current !== parse(current).root) {
    const candidate = await location("project", current);
    if (candidate.exists) return candidate;
    // A worktree's .git is a file; either shape stops discovery at this checkout.
    if (await entry(join(current, ".git"))) return undefined;
    current = dirname(current);
  }
  return undefined;
}

/** Discover read sources separately from the activation scopes selected for writes. */
export async function discoverScopes(options: DiscoveryOptions = {}): Promise<ScopeDiscovery> {
  const scope = options.scope ?? "auto";
  if (!["auto", "global", "project", "both"].includes(scope)) {
    fail("E_SCOPE", `Unknown write scope: ${scope}`, {
      fix: "Choose --scope auto, global, project, or both.",
    });
  }
  const home = await requiredDirectory(
    absolutePath(options.home ?? homedir(), process.cwd(), homedir(), "E_HOME", "home"),
    "E_HOME",
    "home",
  );
  const global = await location("global", home);
  // Global-only operations must not inspect an unrelated or malformed project.
  if (scope === "global") return { global, writeScopes: ["global"] };

  const cwd = await requiredDirectory(
    absolutePath(options.cwd ?? process.cwd(), process.cwd(), home, "E_CWD", "cwd"),
    "E_CWD",
    "cwd",
  );
  let project: ScopeLocation | undefined;
  if (options.project !== undefined) {
    const root = await requiredDirectory(
      absolutePath(options.project, cwd, home, "E_PROJECT_ROOT", "--project"),
      "E_PROJECT_ROOT",
      "--project",
    );
    if (root === home || root === parse(root).root) {
      fail("E_PROJECT_ROOT", `This directory cannot be a project scope: ${root}`, {
        path: root,
        fix: "Choose a project directory, or use --scope global for your home manifest.",
      });
    }
    project = await location("project", root);
    if (!project.exists) {
      fail("E_NO_PROJECT_MANIFEST", `No project manifest exists at ${project.path}`, {
        path: project.path,
        fix: "Create .agents/skills.json in that project, or select the intended --project directory.",
      });
    }
  } else {
    project = await nearestProject(cwd, home);
  }
  if (!project && (scope === "project" || scope === "both")) {
    fail("E_NO_PROJECT_MANIFEST", `No project manifest was found from ${cwd}`, {
      path: cwd,
      fix: "Run inside the intended project, create its .agents/skills.json, or pass --project PATH.",
    });
  }
  const writeScopes: ScopeName[] = scope === "project" ? [] : ["global"];
  if (project) writeScopes.push("project");
  return { global, ...(project ? { project } : {}), writeScopes };
}

async function installedPackageRoot(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const found = await entry(join(current, "package.json"));
    if (found && (await followedEntry(join(current, "package.json"), found)).isFile()) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function catalogRoot(path: string, required: boolean): Promise<string | undefined> {
  const found = await entry(path);
  if (!found) {
    if (!required) return undefined;
    fail("E_REGISTRY_ROOT", `The selected registry directory does not exist: ${path}`, {
      path,
      fix: "Point --registry-root or PJ_SKILLS_REGISTRY_ROOT at a local Skillex catalog checkout.",
    });
  }
  if (!(await followedEntry(path, found)).isDirectory()) {
    fail("E_REGISTRY_ROOT", `The registry candidate is not a directory: ${path}`, {
      path,
      fix: "Choose a local checkout with a real all-skills/ directory.",
    });
  }
  const root = await canonical(path);
  const catalog = join(root, "all-skills");
  const contents = await entry(catalog);
  if (!contents) {
    if (!required) return undefined;
    fail("E_REGISTRY_ROOT", `The selected registry has no all-skills/ catalog: ${root}`, {
      path: catalog,
      fix: "Choose a complete local catalog checkout; the installed npm package contains no catalog.",
    });
  }
  if (!contents.isDirectory() || contents.isSymbolicLink()) {
    fail("E_REGISTRY_ROOT", `The catalog must be a real all-skills/ directory: ${catalog}`, {
      path: catalog,
      fix: "Select the owning catalog checkout, or run skillex migrate to repair its topology.",
    });
  }
  return root;
}

/** Select one offline checkout. Explicit inputs are exclusive, including invalid ones. */
export async function discoverRegistry(options: RegistryOptions = {}): Promise<RegistrySelection> {
  const home = absolutePath(options.home ?? homedir(), process.cwd(), homedir(), "E_HOME", "home");
  const cwd = absolutePath(options.cwd ?? process.cwd(), process.cwd(), home, "E_CWD", "cwd");
  const env = options.env ?? process.env;
  const searched: string[] = [];
  const tryCandidate = async (
    value: string,
    source: RegistrySelection["source"],
    required = false,
  ): Promise<RegistrySelection | undefined> => {
    const path = absolutePath(value, cwd, home, "E_REGISTRY_ROOT", "registry root");
    if (searched.includes(path)) return undefined;
    searched.push(path);
    const root = await catalogRoot(path, required);
    return root ? { root, source, searched: [...searched] } : undefined;
  };
  if (options.registryRoot !== undefined) {
    // A required candidate either returns a selection or throws a named failure.
    const selected = await tryCandidate(options.registryRoot, "argument", true);
    if (selected) return selected;
  } else if (env.PJ_SKILLS_REGISTRY_ROOT !== undefined) {
    const selected = await tryCandidate(env.PJ_SKILLS_REGISTRY_ROOT, "environment", true);
    if (selected) return selected;
  } else {
    if (options.registry !== undefined) {
      if (!options.registry.trim()) {
        fail("E_REGISTRY_URL", "The registry URL must not be empty.", {
          fix: "Set registry to its declared repository URL or remove it for local checkout discovery.",
        });
      }
      // Shared cache wire format from sync-skills.py and PJangler: do not change.
      const cacheName = options.registry.replace(/[^a-zA-Z0-9]/g, "_");
      const selected = await tryCandidate(
        join(home, ".agents", ".cache", "registries", cacheName),
        "cache",
      );
      if (selected) return selected;
    }
    let current = await requiredDirectory(cwd, "E_CWD", "cwd");
    while (true) {
      const selected = await tryCandidate(current, "checkout");
      if (selected) return selected;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const installed = await tryCandidate(
      options.installedRoot ?? (await installedPackageRoot()),
      "installed",
    );
    if (installed) return installed;
    const fallback = await tryCandidate(join(home, "code", "skillex"), "fallback");
    if (fallback) return fallback;
  }
  fail("E_REGISTRY_NOT_FOUND", "No usable local Skillex catalog checkout was found.", {
    detail: searched,
    fix: "Set --registry-root or PJ_SKILLS_REGISTRY_ROOT to a checkout containing all-skills/. Discovery never clones or fetches repositories.",
  });
}
