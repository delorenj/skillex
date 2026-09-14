import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  type ReceiptOptions,
  type ReceiptSnapshot,
  readBoundReceipt,
  writeBoundReceipt,
} from "./activation-state.js";
import { canonicalSkill, packInventory, setMembers, setMemberTarget } from "./composition.js";
import { captureContent, digestContent, isWithin } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { withLock } from "./lock.js";
import { isSkillName, isVersionComponent, parseManifest } from "./manifest.js";
import {
  assertMigrationIdentity,
  assertMigrationTree,
  captureMigrationTree,
  type MigrationEntry,
  type MigrationIdentity,
  type MigrationTree,
  type MigrationTreeEvidence,
  migrationLstat,
  migrationParent,
  migrationStage,
  migrationTreeDigest,
  removeMigrationTree,
  stageMigrationTree,
} from "./migration-registry-state.js";
import type { MigrationItem, MigrationOptions, MigrationSectionResult } from "./migration-types.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";

type Json = Record<string, unknown>;
interface Source {
  readonly path: string;
  readonly evidence: MigrationTreeEvidence;
}
interface Parent {
  readonly path: string;
  readonly identity: MigrationIdentity;
}
interface Context {
  readonly root: string;
  readonly lexicalRoot: string;
  readonly home: string;
  readonly cwd: string;
  readonly scope: "global" | "project";
  readonly target: string;
  readonly configs: readonly string[];
  readonly registry: string;
  readonly options: MigrationOptions;
  readonly receiptOptions: ReceiptOptions;
}
interface ManifestReceipt {
  readonly version: 1;
  readonly section: "manifest";
  readonly phase: "preparing" | "published" | "verified";
  readonly target: string;
  readonly before: MigrationTreeEvidence | null;
  readonly after: MigrationTreeEvidence | null;
  readonly afterDigest: string;
  readonly stage: string | null;
  readonly parked: string | null;
  readonly parents: readonly Parent[];
  readonly retire: readonly Source[];
  readonly retired: readonly string[];
  readonly inputs: readonly { readonly path: string; readonly digest: string }[];
  readonly decisions: readonly string[];
}
interface Plan {
  readonly context: Context;
  readonly before: MigrationTree | null;
  readonly entries: readonly MigrationEntry[];
  readonly sources: readonly Source[];
  readonly trees: readonly Source[];
  readonly retire: readonly Source[];
  readonly parents: readonly Parent[];
  readonly decisions: readonly string[];
  readonly dependencies: readonly string[];
  readonly changed: boolean;
}

const binding = { namespace: "migrations", targetParts: [".agents", "skills.json"] } as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const stagePattern = /^\.skillex-tmp-migrate-[a-f0-9-]{36}-(?:new|old)$/;
const modernFields = [
  "$schema",
  "scope",
  "inherit_global",
  "registry",
  "sets",
  "packs",
  "skills",
  "exclude",
];

function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Json, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function own<T>(value: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}
function blocked(
  path: string,
  message: string,
  code: Diagnostic["code"] = "E_MIGRATION_MANIFEST_MAPPING",
): never {
  fail(
    code,
    message,
    {
      path,
      fix: "Preserve this manifest. Supply mapping.manifests for this exact path with an explicitly authored current-schema replacement, or correct the exact source mapping and rerun migrate.",
    },
    ExitCode.REFUSED,
  );
}
function changed(path: string, message: string): never {
  blocked(path, message, "E_MIGRATION_CHANGED");
}
function cancelled(options: MigrationOptions): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Manifest migration was interrupted.",
      {
        fix: "Rerun migrate with the same explicit target to inspect or resume its recorded transaction.",
      },
      ExitCode.INTERRUPTED,
    );
}
function expand(value: string, home: string, cwd: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail("E_MIGRATION_TARGET", "Migration requires a nonempty explicit path.", {
      fix: "Select --scope global or an existing --project directory.",
    });
  return resolve(
    cwd,
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}
async function contextFor(options: MigrationOptions): Promise<Context> {
  if (
    (!options.scope && !options.project) ||
    (options.scope === "project" && !options.project) ||
    (options.scope === "global" && options.project !== undefined) ||
    (options.scope !== undefined && !["global", "project"].includes(options.scope))
  )
    fail(
      "E_MIGRATION_TARGET",
      "Manifest migration requires --scope global or an explicit --project.",
      {
        fix: "Select exactly one global or project manifest; the current directory never selects a migration target.",
      },
    );
  const home = await realpath(expand(options.home ?? homedir(), homedir(), process.cwd()));
  const cwd = expand(options.cwd ?? process.cwd(), home, process.cwd());
  const scope = options.project !== undefined ? "project" : "global";
  const lexicalRoot = scope === "global" ? home : expand(options.project as string, home, cwd);
  let root: string;
  try {
    root = await realpath(lexicalRoot);
  } catch {
    fail("E_MIGRATION_TARGET", "The selected migration scope does not exist.", {
      path: lexicalRoot,
      fix: "Select an existing explicit scope directory.",
    });
  }
  if (
    !(await lstat(root)).isDirectory() ||
    (scope === "project" && (root === home || dirname(root) === root))
  )
    fail("E_MIGRATION_TARGET", "The selected migration scope is not a project directory.", {
      path: root,
      fix: "Select a project directory or use --scope global.",
    });
  const normalized = { ...options, home, cwd };
  const registry = (await discoverRegistry(normalized)).root;
  const target = join(root, ".agents", "skills.json");
  const configs =
    scope === "global"
      ? [join(home, ".config", "skillex", "skillex.toml")]
      : [join(root, "skillex.toml"), join(home, ".config", "skillex", "skillex.toml")];
  return {
    root,
    lexicalRoot,
    home,
    cwd,
    scope,
    target,
    configs,
    registry,
    options: normalized,
    receiptOptions: {
      ...normalized,
      forbiddenRoots: [
        registry,
        scope === "project" ? root : join(home, ".agents"),
        ...configs.map((path) => dirname(path)),
      ],
    },
  };
}
async function parentsFor(paths: readonly string[]): Promise<Parent[]> {
  const parents = new Map<string, MigrationIdentity>();
  for (const path of paths) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const info = await migrationLstat(parent);
      if (info) {
        if (!info.isDirectory())
          blocked(
            parent,
            "Manifest migration requires real parent directories.",
            "E_MIGRATION_MANIFEST_PATH",
          );
        parents.set(parent, await migrationParent(join(parent, "entry")));
      }
      if (dirname(parent) === parent) break;
    }
  }
  return [...parents].map(([path, identity]) => ({ path, identity }));
}
async function protectSources(
  context: Context,
  sources: readonly { readonly path: string }[],
): Promise<Context> {
  const protectedContext = {
    ...context,
    receiptOptions: {
      ...context.receiptOptions,
      forbiddenRoots: [
        ...(context.receiptOptions.forbiddenRoots ?? []),
        ...sources.map(({ path }) => path),
      ],
    },
  };
  // Validate before the shared lock can create any state inside an authored source.
  await readBoundReceipt(context.root, binding, protectedContext.receiptOptions);
  return protectedContext;
}
async function assertParents(context: Context, parents: readonly Parent[]): Promise<void> {
  if ((await realpath(context.lexicalRoot)) !== context.root)
    changed(context.lexicalRoot, "The selected scope was redirected during migration.");
  for (const parent of parents) await assertMigrationIdentity(parent.path, parent.identity);
}
async function manifestFile(path: string): Promise<MigrationTree | null> {
  const info = await migrationLstat(path);
  if (!info) return null;
  if (!info.isFile())
    blocked(
      path,
      "Selection sources must be regular files, not linked or special entries.",
      "E_MIGRATION_MANIFEST_PATH",
    );
  if (info.size > 1024n * 1024n)
    blocked(
      path,
      "A selection source exceeds the 1 MiB migration limit.",
      "E_MIGRATION_MANIFEST_PATH",
    );
  return captureMigrationTree(path);
}
function textOf(tree: MigrationTree, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(tree.entries[0]?.bytes);
  } catch {
    fail("E_INVALID_UTF8", "The legacy selection is not valid UTF-8.", {
      path,
      fix: "Save the declaration as UTF-8 or provide an explicit authored replacement.",
    });
  }
}
function jsonOf(tree: MigrationTree, path: string): Json {
  let raw: unknown;
  try {
    raw = JSON.parse(textOf(tree, path));
  } catch (error) {
    if (error instanceof SkillexError) throw error;
    fail("E_MANIFEST_PARSE", "The legacy selection is not valid JSON.", {
      path,
      fix: "Correct its syntax or provide mapping.manifests for this exact file.",
    });
  }
  if (!record(raw)) blocked(path, "A selection manifest must be an object.");
  return raw;
}
function pin(
  context: Context,
  path: string,
  tree: MigrationTree,
  aliases: readonly string[] = [],
): void {
  for (const key of [path, ...aliases]) {
    const expected = own(context.options.mapping?.digests, key);
    if (
      expected !== undefined &&
      (!digestPattern.test(expected) || expected !== tree.evidence.digest)
    )
      blocked(
        path,
        "The selected source does not match its explicitly pinned migration digest.",
        "E_MIGRATION_DIGEST",
      );
  }
}
function sourcePath(value: unknown, context: Context, registryRelative: boolean): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    blocked(context.target, "An external reference must identify one exact local source path.");
  if (registryRelative) {
    if (
      isAbsolute(value) ||
      value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      blocked(context.target, "A legacy registry_path is not a safe registry-relative path.");
    return join(context.registry, value);
  }
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      blocked(context.target, "The external file URL is malformed.");
    }
  }
  if (!isAbsolute(value) && !value.startsWith("~/"))
    blocked(
      context.target,
      "Remote or relative external sources need an explicit authored replacement.",
    );
  return expand(value, context.home, context.cwd);
}
function mappedName(
  context: Context,
  path: string,
  canonical: string,
  nameMap: Readonly<Record<string, string>>,
): string | undefined {
  const keys = [path, canonical, relative(context.registry, path).split("\\").join("/")];
  const choices = new Set(
    keys
      .flatMap((key) => [own(nameMap, key), own(context.options.mapping?.names, key)])
      .filter((value) => value !== undefined),
  );
  if (choices.size > 1)
    blocked(path, "Exact source mappings disagree about the canonical skill name.");
  const name = [...choices][0];
  if (name !== undefined && !isSkillName(name))
    blocked(path, "The mapped canonical skill name is invalid.");
  return name;
}
async function translatedSkill(
  entry: unknown,
  context: Context,
  nameMap: Readonly<Record<string, string>>,
  trees: Source[],
  decisions: string[],
  dependencies: Set<string>,
): Promise<string> {
  let declared: string;
  let path: string;
  if (typeof entry === "string") {
    declared = entry.includes("/") ? basename(entry) : entry;
    path = entry.includes("/")
      ? sourcePath(entry, context, true)
      : join(context.registry, "all-skills", entry);
  } else {
    if (!record(entry) || typeof entry.name !== "string")
      blocked(context.target, "A legacy skill entry has no unambiguous name.");
    if (
      Object.keys(entry).some((key) => !["name", "source", "registry_path"].includes(key)) ||
      (entry.source !== undefined && entry.registry_path !== undefined)
    )
      blocked(
        context.target,
        "Legacy skill options have semantics that require an authored replacement.",
      );
    declared = entry.name;
    path =
      entry.source !== undefined
        ? sourcePath(entry.source, context, false)
        : entry.registry_path !== undefined
          ? sourcePath(entry.registry_path, context, true)
          : join(context.registry, "all-skills", declared);
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    const converted =
      own(nameMap, path) ?? own(nameMap, relative(context.registry, path).split("\\").join("/"));
    if (converted && isSkillName(converted)) {
      await canonicalSkill(context.registry, converted);
      dependencies.add(`catalog:all-skills/${converted}`);
      decisions.push(
        `Use the exact source conversion from catalog:all-skills/${converted} for ${path}`,
      );
      return converted;
    }
    blocked(
      path,
      "A selected legacy skill source is missing; migration cannot invent its content.",
      "E_MIGRATION_SOURCE_MISSING",
    );
  }
  const source = await captureMigrationTree(canonical);
  if (
    source?.evidence.root.kind !== "directory" ||
    !(await migrationLstat(join(canonical, "SKILL.md")))?.isFile()
  )
    blocked(path, "A selected source is not one real skill definition.");
  pin(context, canonical, source, [path]);
  const explicit = mappedName(context, path, canonical, nameMap);
  const directName =
    dirname(canonical) === join(context.registry, "all-skills") && basename(canonical) === declared
      ? declared
      : undefined;
  const name = explicit ?? directName;
  if (!name || !isSkillName(name))
    blocked(path, "This exact external source has no canonical name mapping.");
  const target = join(context.registry, "all-skills", name);
  const destination = await migrationLstat(target);
  if (!destination && context.options.apply !== true && explicit) {
    dependencies.add(`catalog:all-skills/${name}`);
  } else {
    await canonicalSkill(context.registry, name);
    if (canonical !== target) {
      const destination = await captureMigrationTree(target);
      if (!destination) changed(target, "The mapped canonical definition disappeared.");
      trees.push({ path: target, evidence: destination.evidence });
    }
    if (
      canonical !== target &&
      digestContent((await captureContent(canonical)).entries) !==
        digestContent((await captureContent(target)).entries)
    )
      blocked(
        path,
        "The mapped canonical definition does not preserve the selected source bytes and executable modes.",
        "E_MIGRATION_DIGEST",
      );
  }
  trees.push({ path: canonical, evidence: source.evidence });
  if (path !== canonical) {
    const lexical = await captureMigrationTree(path);
    if (!lexical) changed(path, "The authored source path disappeared during translation.");
    trees.push({ path, evidence: lexical.evidence });
  }
  decisions.push(
    `skills reference ${declared} -> canonical ${name}; source digest ${source.evidence.digest}`,
  );
  return name;
}
function mappedPack(
  context: Context,
  path: string,
): { readonly name: string; readonly version: string } | undefined {
  const mapped =
    own(context.options.mapping?.packs, path) ??
    own(context.options.mapping?.packs, relative(context.registry, path).split("\\").join("/"));
  if (mapped && (!isSkillName(mapped.name) || !isVersionComponent(mapped.version)))
    blocked(path, "The explicit pack mapping is not a safe canonical name and version.");
  return mapped;
}
async function translateJson(
  raw: Json,
  context: Context,
  nameMap: Readonly<Record<string, string>>,
  trees: Source[],
  decisions: string[],
  dependencies: Set<string>,
  legacy = true,
): Promise<Json> {
  if (Object.keys(raw).some((key) => !modernFields.includes(key)))
    blocked(
      context.target,
      "Unknown, slot, payload, or adapter fields cannot be silently discarded.",
    );
  for (const key of ["skills", "sets", "packs"])
    if (raw[key] !== undefined && !Array.isArray(raw[key]))
      blocked(context.target, `${key} must be an array.`);
  const packs = (raw.packs ?? []) as unknown[];
  if (
    legacy &&
    (packs.length > 1 ||
      (packs.length &&
        (((raw.skills ?? []) as unknown[]).length || ((raw.sets ?? []) as unknown[]).length)))
  )
    blocked(
      context.target,
      "Legacy additive packs cannot be converted to an exclusive loadout without an authored replacement.",
    );
  if (legacy && packs.length && context.scope === "project" && raw.inherit_global !== false)
    blocked(
      context.target,
      "A legacy project pack may include inherited global skills. Supply an authored replacement that accounts for the modern exclusive loadout, or explicitly disable inheritance before migration.",
    );
  const output: Json = { ...raw };
  if (raw.skills !== undefined) {
    const names: string[] = [];
    for (const entry of raw.skills as unknown[])
      names.push(await translatedSkill(entry, context, nameMap, trees, decisions, dependencies));
    output.skills = [...new Set(names)];
  }
  if (raw.sets !== undefined) {
    const sets: unknown[] = [];
    for (const entry of raw.sets as unknown[]) {
      if (typeof entry === "string") {
        sets.push(entry);
        continue;
      }
      if (
        !record(entry) ||
        typeof entry.name !== "string" ||
        Object.keys(entry).some(
          (key) =>
            !["name", "source", "registry_path", "include", "exclude", "optional"].includes(key),
        ) ||
        (entry.source !== undefined && entry.registry_path !== undefined)
      )
        blocked(
          context.target,
          "A legacy set has unsupported options or ambiguous source semantics.",
        );
      const next = { ...entry };
      if (entry.source !== undefined || entry.registry_path !== undefined) {
        const path =
          entry.source !== undefined
            ? sourcePath(entry.source, context, false)
            : sourcePath(entry.registry_path, context, true);
        const expected = join(context.registry, "sets", entry.name);
        let actual: string;
        try {
          actual = await realpath(path);
        } catch {
          blocked(path, "The selected external set is missing.", "E_MIGRATION_SOURCE_MISSING");
        }
        if ((await realpath(expected).catch(() => "")) !== actual)
          blocked(
            path,
            "An external set needs an explicitly authored replacement naming its verified canonical composition.",
          );
        delete next.source;
        delete next.registry_path;
        decisions.push(
          `Retire external set locator for ${entry.name} after exact path verification.`,
        );
      }
      if (legacy && Array.isArray(next.include) && next.include.length === 0) {
        delete next.include;
        decisions.push(
          "sets[].include: [] meant all legacy members; omit include to retain that meaning.",
        );
      }
      for (const key of ["include", "exclude"]) {
        if (!Array.isArray(next[key])) continue;
        next[key] = next[key].map((name: unknown) => {
          if (typeof name !== "string") return name;
          const member = join(context.registry, "sets", entry.name as string, name);
          return own(nameMap, member) ?? own(nameMap, `sets/${entry.name}/${name}`) ?? name;
        });
      }
      sets.push(next);
    }
    output.sets = sets;
  }
  if (packs.length) {
    const entry = packs[0];
    if (typeof entry === "string") output.packs = [entry];
    else {
      if (
        !record(entry) ||
        typeof entry.name !== "string" ||
        Object.keys(entry).some(
          (key) =>
            ![
              "name",
              "version",
              "optional",
              "source",
              "registry_path",
              "flatten",
              "sealed",
              "include",
              "exclude",
            ].includes(key),
        ) ||
        (entry.source !== undefined && entry.registry_path !== undefined)
      )
        blocked(context.target, "A legacy pack has unknown runtime semantics.");
      if (
        (Array.isArray(entry.include) && entry.include.length) ||
        (Array.isArray(entry.exclude) && entry.exclude.length)
      )
        blocked(
          context.target,
          "Filtered legacy packs need an authored set or complete-pack replacement.",
        );
      const path =
        entry.source !== undefined
          ? sourcePath(entry.source, context, false)
          : entry.registry_path !== undefined
            ? sourcePath(entry.registry_path, context, true)
            : join(
                context.registry,
                "packs",
                entry.name,
                ...(typeof entry.version === "string" ? [entry.version] : []),
              );
      const mapped = mappedPack(context, path);
      if (
        (entry.source !== undefined ||
          entry.registry_path !== undefined ||
          entry.flatten === true ||
          entry.sealed === true) &&
        !mapped
      )
        blocked(
          path,
          "The legacy pack requires an exact canonical pack mapping before its runtime fields can retire.",
        );
      for (const key of ["flatten", "sealed"])
        if (entry[key] !== undefined && typeof entry[key] !== "boolean")
          blocked(context.target, "A legacy pack policy is malformed.");
      for (const key of ["include", "exclude"])
        if (entry[key] !== undefined && !Array.isArray(entry[key]))
          blocked(context.target, "A legacy pack filter is malformed.");
      output.packs = [
        {
          ...(mapped ?? {
            name: entry.name,
            ...(entry.version === undefined ? {} : { version: entry.version }),
          }),
          ...(entry.optional === undefined ? {} : { optional: entry.optional }),
        },
      ];
      decisions.push(
        "Retire source, registry_path, flatten, sealed, and empty legacy pack filters after canonical pack mapping.",
      );
    }
  }
  parseManifest(output, context.target);
  return output;
}
async function translateToml(
  tree: MigrationTree,
  path: string,
  context: Context,
  decisions: string[],
): Promise<Json | null> {
  let raw: unknown;
  try {
    raw = parseToml(textOf(tree, path));
  } catch (error) {
    if (error instanceof SkillexError) throw error;
    fail("E_MIGRATION_TOML_PARSE", "The legacy skillex.toml is malformed.", {
      path,
      fix: "Correct its TOML syntax or provide mapping.manifests for this exact file.",
    });
  }
  if (
    !record(raw) ||
    Object.keys(raw).some((key) => !["skillex", "scopes", "cli"].includes(key)) ||
    !record(raw.skillex) ||
    !record(raw.scopes ?? {})
  )
    blocked(path, "The legacy TOML contains unknown configuration semantics.");
  const settings = raw.skillex;
  if (
    Object.keys(settings).some(
      (key) => !["skills_root", "packs_root", "log_format"].includes(key),
    ) ||
    typeof settings.skills_root !== "string" ||
    typeof settings.packs_root !== "string" ||
    (settings.log_format !== undefined &&
      !["console", "json"].includes(String(settings.log_format)))
  )
    blocked(path, "Legacy source roots or logging configuration are not understood.");
  const scopes = (raw.scopes ?? {}) as Json;
  if (
    context.scope === "project" &&
    path !== join(context.root, "skillex.toml") &&
    scopes.project === undefined
  )
    return null;
  const selected = scopes[context.scope] ?? {};
  if (
    !record(selected) ||
    Object.keys(selected).some((key) => key !== "active_pack") ||
    (selected.active_pack !== undefined &&
      selected.active_pack !== null &&
      typeof selected.active_pack !== "string")
  )
    blocked(path, "The selected legacy scope cannot be translated unambiguously.");
  for (const [name, value] of Object.entries(scopes))
    if (
      name !== context.scope &&
      (!record(value) ||
        Object.keys(value).some((key) => key !== "active_pack") ||
        value.active_pack)
    )
      blocked(
        path,
        "Retiring this TOML would discard another scope's selection; supply an explicit replacement decision.",
      );
  if (raw.cli !== undefined) {
    if (!record(raw.cli)) blocked(path, "The legacy adapter configuration is malformed.");
    const roots: Readonly<Record<string, string>> = {
      claude: ".claude",
      codex: ".codex",
      gemini: ".gemini",
      copilot: ".copilot",
      "kimi-code": ".kimi-code",
    };
    for (const [name, value] of Object.entries(raw.cli)) {
      const folder = own(roots, name);
      if (
        !folder ||
        !record(value) ||
        Object.keys(value).some(
          (key) => !["enabled", "global_root", "project_root"].includes(key),
        ) ||
        (value.enabled !== undefined && value.enabled !== true) ||
        typeof value.global_root !== "string" ||
        typeof value.project_root !== "string" ||
        expand(value.global_root, context.home, context.cwd) !== join(context.home, folder) ||
        value.project_root !== folder
      )
        blocked(path, "A legacy adapter override has no target-equivalent canonical alias policy.");
      decisions.push(`Retire target-equivalent cli.${name} adapter configuration.`);
    }
  }
  const output: Json = { scope: context.scope };
  if (selected.active_pack) {
    const source = join(
      expand(settings.packs_root, context.home, context.cwd),
      selected.active_pack as string,
    );
    const mapped = mappedPack(context, source);
    if (mapped) output.packs = [mapped];
    else if (
      dirname(source) === join(context.registry, "packs") &&
      isSkillName(selected.active_pack)
    )
      output.packs = [selected.active_pack];
    else
      blocked(
        path,
        "The legacy active_pack needs an exact source-path mapping to a canonical pack version.",
      );
    decisions.push(
      `Translate scopes.${context.scope}.active_pack into the canonical packs selection.`,
    );
  }
  decisions.push(
    "Retire skillex.skills_root, skillex.packs_root, and log_format after the selected registry is verified.",
  );
  return output;
}
async function verifySelection(
  raw: Json,
  context: Context,
  nameMap: Readonly<Record<string, string>>,
  dependencies: Set<string>,
): Promise<void> {
  const manifest = parseManifest(raw, context.target);
  const mappedValues = new Set(Object.values(nameMap));
  const skill = async (name: string) => {
    if (
      context.options.apply !== true &&
      mappedValues.has(name) &&
      !(await migrationLstat(join(context.registry, "all-skills", name)))
    )
      dependencies.add(`catalog:all-skills/${name}`);
    else await canonicalSkill(context.registry, name);
  };
  if (manifest.packs[0]) {
    const pack = manifest.packs[0];
    const planned = Object.values(context.options.mapping?.packs ?? {}).some(
      (value) => value.name === pack.name && (!pack.version || value.version === pack.version),
    );
    if (context.options.apply !== true && planned) {
      dependencies.add(`composition:packs/${pack.name}${pack.version ? `/${pack.version}` : ""}`);
      return;
    }
    for (const name of (await packInventory(context.registry, pack)).names) await skill(name);
    return;
  }
  for (const set of manifest.sets) {
    const prefix = `sets/${set.name}/`;
    if (
      context.options.apply !== true &&
      Object.keys(nameMap).some((key) => key.startsWith(prefix))
    ) {
      dependencies.add(`composition:sets/${set.name}`);
      continue;
    }
    const members = await setMembers(context.registry, set.name);
    for (const name of set.include ?? members.names) {
      if (set.exclude.includes(name)) continue;
      if (!members.names.includes(name))
        blocked(
          context.target,
          "A selected set member is missing; preserve the declaration until its mapping is complete.",
        );
      await setMemberTarget(context.registry, members.path, name);
    }
  }
  for (const selected of manifest.skills) await skill(selected.name);
}
async function plan(context: Context, nameMap: Readonly<Record<string, string>>): Promise<Plan> {
  const parents = await parentsFor([context.target, ...context.configs]);
  const before = await manifestFile(context.target);
  const sources: Source[] = [];
  const trees: Source[] = [];
  const retire: Source[] = [];
  const decisions: string[] = [];
  const dependencies = new Set<string>();
  let proposed: Json | null = null;
  if (before) {
    sources.push({ path: context.target, evidence: before.evidence });
    pin(context, context.target, before);
    const replacement = own(context.options.mapping?.manifests, context.target);
    if (replacement !== undefined) {
      proposed = { ...replacement };
      decisions.push(
        "Use explicitly authored mapping.manifests replacement; retire all unsupported source fields.",
      );
    } else {
      const raw = jsonOf(before, context.target);
      let legacy = false;
      try {
        parseManifest(raw, context.target);
      } catch (error) {
        if (!(error instanceof SkillexError)) throw error;
        legacy = true;
      }
      const mapped = Object.entries(nameMap).some(
        ([path, name]) =>
          (path.startsWith("all-skills/") ||
            path.startsWith(`${join(context.registry, "all-skills")}/`) ||
            path.startsWith("sets/") ||
            path.startsWith(`${join(context.registry, "sets")}/`)) &&
          basename(path) !== name,
      );
      proposed =
        legacy || mapped
          ? await translateJson(raw, context, nameMap, trees, decisions, dependencies, legacy)
          : raw;
    }
  }
  for (const path of context.configs) {
    const legacy = await manifestFile(path);
    if (!legacy) continue;
    const replacement = own(context.options.mapping?.manifests, path);
    const translated =
      replacement === undefined
        ? await translateToml(legacy, path, context, decisions)
        : { ...replacement };
    if (translated === null) continue;
    if (replacement !== undefined)
      decisions.push(
        "Use the explicitly authored replacement for every retired legacy TOML field.",
      );
    pin(context, path, legacy);
    parseManifest(translated, context.target);
    if (proposed) {
      const left = { ...parseManifest(proposed, context.target) };
      const right = { ...parseManifest(translated, context.target) };
      delete left.scope;
      delete right.scope;
      if (!isDeepStrictEqual(left, right))
        blocked(
          path,
          "TOML and JSON select different intent; author one consistent replacement for both source paths.",
        );
    }
    proposed ??= translated;
    sources.push({ path, evidence: legacy.evidence });
    retire.push({ path, evidence: legacy.evidence });
    decisions.push(
      `Retire exact legacy TOML only after canonical JSON and verification receipt are durable: ${path}`,
    );
  }
  if (!proposed) {
    const replacement = own(context.options.mapping?.manifests, context.target);
    if (replacement !== undefined) proposed = { ...replacement };
  }
  if (!proposed)
    fail(
      "E_MANIFEST_MISSING",
      "No selection declaration exists for the explicit migration scope.",
      {
        path: context.target,
        fix: "Select the legacy manifest's scope, or run init if there is no selection to migrate.",
      },
    );
  await verifySelection(proposed, context, nameMap, dependencies);
  let sameRaw = false;
  if (before) {
    try {
      sameRaw = isDeepStrictEqual(jsonOf(before, context.target), proposed);
    } catch (error) {
      if (!(error instanceof SkillexError)) throw error;
    }
  }
  const entries: readonly MigrationEntry[] =
    sameRaw && before
      ? before.entries
      : [
          {
            path: "",
            kind: "file",
            mode: before?.entries[0]?.mode ?? 0o644,
            bytes: Buffer.from(`${JSON.stringify(proposed, null, 2)}\n`),
          },
        ];
  await assertParents(context, parents);
  return {
    context,
    before,
    entries,
    sources,
    trees,
    retire,
    parents,
    decisions,
    dependencies: [...dependencies],
    changed: !sameRaw,
  };
}
function itemsFor(
  target: string,
  before: MigrationTreeEvidence | null,
  afterDigest: string,
  retire: readonly Source[],
  decisions: readonly string[],
  dependencies: readonly string[],
  verified: boolean,
  changedIntent: boolean,
): MigrationItem[] {
  const id = `manifest:${target}`;
  return [
    {
      id,
      area: "manifest",
      action: changedIntent ? "write-manifest" : "preserve-manifest",
      path: target,
      state: verified ? "verified" : changedIntent ? "ready" : "preserved",
      ...(before ? { beforeDigest: before.digest } : {}),
      afterDigest,
      details: decisions,
      dependsOn: dependencies,
    },
    ...retire.map(
      (source): MigrationItem => ({
        id: `manifest-retire:${source.path}`,
        area: "manifest",
        action: "retire-legacy-manifest",
        path: source.path,
        target,
        state: verified ? "verified" : "ready",
        beforeDigest: source.evidence.digest,
        details: [
          "Retire only this exact legacy file after the translated manifest and receipt are verified.",
        ],
        dependsOn: [id],
      }),
    ),
  ];
}
function validEvidence(value: unknown): value is MigrationTreeEvidence {
  if (
    !record(value) ||
    !exact(value, ["root", "entries", "digest"]) ||
    !record(value.root) ||
    !Array.isArray(value.entries) ||
    value.entries.length !== 1 ||
    typeof value.digest !== "string" ||
    !digestPattern.test(value.digest)
  )
    return false;
  const entry = value.entries[0];
  const validIdentity = (identity: unknown): identity is MigrationIdentity =>
    record(identity) &&
    exact(identity, ["kind", "dev", "ino", "uid", "mode"]) &&
    identity.kind === "file" &&
    typeof identity.dev === "string" &&
    /^\d+$/.test(identity.dev) &&
    typeof identity.ino === "string" &&
    /^\d+$/.test(identity.ino) &&
    typeof identity.uid === "string" &&
    /^\d+$/.test(identity.uid) &&
    typeof identity.mode === "number" &&
    Number.isInteger(identity.mode) &&
    identity.mode >= 0 &&
    identity.mode <= 0o777;
  return (
    validIdentity(value.root) &&
    record(entry) &&
    exact(entry, ["path", "identity", "hash", "target"]) &&
    entry.path === "" &&
    validIdentity(entry.identity) &&
    isDeepStrictEqual(value.root, entry.identity) &&
    typeof entry.hash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.hash) &&
    entry.target === null
  );
}
function receiptData(
  snapshot: ReceiptSnapshot<ManifestReceipt>,
  context: Context,
): ManifestReceipt | undefined {
  const value: unknown = snapshot.document?.data;
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    !exact(value, [
      "version",
      "section",
      "phase",
      "target",
      "before",
      "after",
      "afterDigest",
      "stage",
      "parked",
      "parents",
      "retire",
      "retired",
      "inputs",
      "decisions",
    ]) ||
    value.version !== 1 ||
    value.section !== "manifest" ||
    !["preparing", "published", "verified"].includes(String(value.phase)) ||
    value.target !== context.target ||
    !(value.before === null || validEvidence(value.before)) ||
    !(value.after === null || validEvidence(value.after)) ||
    typeof value.afterDigest !== "string" ||
    !digestPattern.test(value.afterDigest) ||
    !Array.isArray(value.retire) ||
    !Array.isArray(value.retired) ||
    !Array.isArray(value.parents) ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.decisions) ||
    value.decisions.some((entry) => typeof entry !== "string") ||
    (value.after !== null && value.afterDigest !== value.after.digest)
  )
    blocked(
      snapshot.path,
      "The manifest migration receipt is malformed.",
      "E_MIGRATION_MANIFEST_RECEIPT",
    );
  if (
    (value.phase !== "preparing" && value.after === null) ||
    (value.stage === null &&
      (!value.before || !value.after || !isDeepStrictEqual(value.before, value.after))) ||
    (value.parked === null && value.before !== null && value.stage !== null) ||
    (value.parked !== null && value.before === null) ||
    (value.phase !== "verified" && value.retired.length !== 0)
  )
    blocked(
      snapshot.path,
      "The migration receipt has an impossible publication state.",
      "E_MIGRATION_MANIFEST_RECEIPT",
    );
  for (const key of ["stage", "parked"]) {
    const path = value[key];
    if (
      path !== null &&
      (typeof path !== "string" ||
        dirname(path) !== dirname(context.target) ||
        !stagePattern.test(basename(path)))
    )
      blocked(
        snapshot.path,
        "The migration receipt contains an unsafe temporary path.",
        "E_MIGRATION_MANIFEST_RECEIPT",
      );
  }
  if (value.stage === value.parked && value.stage !== null)
    blocked(
      snapshot.path,
      "The migration receipt aliases its temporary paths.",
      "E_MIGRATION_MANIFEST_RECEIPT",
    );
  for (const source of value.retire)
    if (
      !record(source) ||
      !exact(source, ["path", "evidence"]) ||
      typeof source.path !== "string" ||
      !context.configs.includes(source.path) ||
      !validEvidence(source.evidence)
    )
      blocked(
        snapshot.path,
        "The migration receipt cannot authorize this legacy retirement.",
        "E_MIGRATION_MANIFEST_RECEIPT",
      );
  for (const path of value.retired)
    if (
      typeof path !== "string" ||
      !value.retire.some((source) => record(source) && source.path === path)
    )
      blocked(
        snapshot.path,
        "The migration receipt has an unknown retired source.",
        "E_MIGRATION_MANIFEST_RECEIPT",
      );
  for (const source of value.inputs)
    if (
      !record(source) ||
      !exact(source, ["path", "digest"]) ||
      typeof source.path !== "string" ||
      !isAbsolute(source.path) ||
      typeof source.digest !== "string" ||
      !digestPattern.test(source.digest)
    )
      blocked(
        snapshot.path,
        "The migration receipt has invalid source digest evidence.",
        "E_MIGRATION_MANIFEST_RECEIPT",
      );
  for (const parent of value.parents) {
    if (
      !record(parent) ||
      !exact(parent, ["path", "identity"]) ||
      typeof parent.path !== "string" ||
      !isAbsolute(parent.path) ||
      ![context.target, ...context.configs].some((path) =>
        isWithin(parent.path as string, dirname(path)),
      ) ||
      !record(parent.identity) ||
      !exact(parent.identity, ["kind", "dev", "ino", "uid", "mode"]) ||
      parent.identity.kind !== "directory" ||
      !["dev", "ino", "uid"].every(
        (key) =>
          typeof (parent.identity as Json)[key] === "string" &&
          /^\d+$/.test((parent.identity as Json)[key] as string),
      ) ||
      typeof parent.identity.mode !== "number"
    )
      blocked(
        snapshot.path,
        "The migration receipt has invalid parent identities.",
        "E_MIGRATION_MANIFEST_RECEIPT",
      );
  }
  return value as unknown as ManifestReceipt;
}
async function flush(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function complete(
  context: Context,
  snapshot: ReceiptSnapshot<ManifestReceipt>,
  initial: ManifestReceipt,
  entries: readonly MigrationEntry[] | undefined,
  nameMap: Readonly<Record<string, string>>,
  applied: string[],
): Promise<ReceiptSnapshot<ManifestReceipt>> {
  let data = initial;
  const retirementPreviouslyVerified = initial.phase === "verified";
  const save = async (next: ManifestReceipt) => {
    snapshot = await writeBoundReceipt(snapshot, next, context.receiptOptions);
    data = next;
  };
  await assertParents(context, data.parents);
  cancelled(context.options);
  const target = await manifestFile(context.target);
  const published =
    data.after !== null && target !== null && isDeepStrictEqual(target.evidence, data.after);
  if (!published) {
    if (data.phase !== "preparing")
      changed(
        context.target,
        "The verified manifest was replaced before migration retirement completed.",
      );
    await assertMigrationTree(context.target, data.before);
    for (const source of data.retire) await assertMigrationTree(source.path, source.evidence);
    for (const source of data.inputs)
      if ((await captureMigrationTree(source.path))?.evidence.digest !== source.digest)
        changed(source.path, "A selected source changed before manifest publication.");
    const agents = dirname(context.target);
    if (!(await migrationLstat(agents))) {
      await mkdir(agents, { mode: 0o755 });
      await flush(context.root);
    }
    const parent = await migrationParent(context.target);
    const parents = [
      ...data.parents.filter((entry) => entry.path !== agents),
      { path: agents, identity: parent },
    ];
    if (!isDeepStrictEqual(parents, data.parents)) await save({ ...data, parents });
    if (!data.after) {
      if (!entries || migrationTreeDigest(entries) !== data.afterDigest)
        blocked(
          snapshot.path,
          "Resume needs the same authored mapping to reconstruct this unpublished manifest.",
          "E_MIGRATION_MANIFEST_PENDING",
        );
      if (!data.stage) changed(snapshot.path, "A pending migration has no staging path.");
      if (await migrationLstat(data.stage))
        blocked(
          data.stage,
          "An unverified staged file is preserved; inspect and account for it before retrying.",
          "E_MIGRATION_MANIFEST_PENDING",
        );
      const after = await stageMigrationTree(data.stage, entries, parent);
      await save({ ...data, after });
    }
    if (!data.stage || !data.after)
      changed(snapshot.path, "The prepared manifest evidence is incomplete.");
    await assertParents(context, data.parents);
    await assertMigrationTree(data.stage, data.after);
    const staged = await manifestFile(data.stage);
    if (!staged) changed(data.stage, "The staged manifest disappeared.");
    await verifySelection(
      jsonOf(staged, context.target),
      { ...context, options: { ...context.options, apply: true } },
      nameMap,
      new Set(),
    );
    for (const source of data.inputs)
      if ((await captureMigrationTree(source.path))?.evidence.digest !== source.digest)
        changed(
          source.path,
          "A selected source changed while the canonical declaration was staged.",
        );
    cancelled(context.options);
    if (data.before && data.parked) {
      if (!(await migrationLstat(data.parked))) {
        await assertMigrationTree(context.target, data.before);
        await link(context.target, data.parked);
      }
      await assertMigrationTree(data.parked, data.before);
    }
    await assertParents(context, data.parents);
    await assertMigrationTree(context.target, data.before);
    if (data.before) await rename(data.stage, context.target);
    else {
      await link(data.stage, context.target);
      await removeMigrationTree(data.stage, data.after);
    }
    applied.push(`manifest:${context.target}`);
    await flush(agents);
    await assertMigrationTree(context.target, data.after);
    await save({ ...data, phase: "published" });
  }
  cancelled(context.options);
  if (!data.after) changed(snapshot.path, "The published manifest lacks exact ownership evidence.");
  await assertParents(context, data.parents);
  await assertMigrationTree(context.target, data.after);
  const current = await manifestFile(context.target);
  if (!current) changed(context.target, "The translated manifest disappeared before verification.");
  await verifySelection(
    jsonOf(current, context.target),
    { ...context, options: { ...context.options, apply: true } },
    nameMap,
    new Set(),
  );
  // Verify every retained object before deleting any member of the transaction.
  // In particular, edited staged/parked evidence must not be hidden by cleanup.
  for (const [path, expected] of [
    [data.stage, data.after],
    [data.parked, data.before],
  ] as const) {
    if (!path || !(await migrationLstat(path))) continue;
    if (!expected) changed(path, "A temporary file has no exact migration evidence.");
    await assertMigrationTree(path, expected);
  }
  for (const source of data.retire) {
    if (data.retired.includes(source.path)) continue;
    if (await migrationLstat(source.path)) await assertMigrationTree(source.path, source.evidence);
    else if (!retirementPreviouslyVerified)
      changed(source.path, "The legacy source disappeared before its retirement was verified.");
  }
  if (data.phase !== "verified") await save({ ...data, phase: "verified" });
  for (const source of data.retire) {
    cancelled(context.options);
    await assertParents(context, data.parents);
    if (data.retired.includes(source.path)) {
      if (await migrationLstat(source.path))
        changed(
          source.path,
          "A new legacy file appeared after retirement; it is not owned by this receipt.",
        );
      continue;
    }
    if (await migrationLstat(source.path)) {
      await removeMigrationTree(source.path, source.evidence);
      applied.push(`manifest-retire:${source.path}`);
    }
    await save({ ...data, retired: [...data.retired, source.path] });
  }
  if (data.parked && (await migrationLstat(data.parked))) {
    await assertParents(context, data.parents);
    if (!data.before) changed(data.parked, "A foreign parked file cannot be removed.");
    await removeMigrationTree(data.parked, data.before);
  }
  if (data.stage && (await migrationLstat(data.stage))) {
    await assertParents(context, data.parents);
    await removeMigrationTree(data.stage, data.after);
  }
  return snapshot;
}

/** Translate only an explicitly selected declaration; no activation paths are managed here. */
export async function migrateManifest(
  options: MigrationOptions,
  nameMap: Readonly<Record<string, string>> = {},
): Promise<ResultEnvelope<MigrationSectionResult | null>> {
  let context: Context | undefined;
  let items: MigrationItem[] = [];
  const applied: string[] = [];
  const receipts: string[] = [];
  try {
    cancelled(options);
    context = await contextFor(options);
    let selected = context;
    let receipt = await readBoundReceipt<ManifestReceipt>(
      selected.root,
      binding,
      selected.receiptOptions,
    );
    const pending = receiptData(receipt, selected);
    if (pending) selected = await protectSources(selected, pending.inputs);
    const stillRetiring =
      pending &&
      (pending.phase !== "verified" ||
        pending.retired.length !== pending.retire.length ||
        (pending.stage !== null && (await migrationLstat(pending.stage))) ||
        (pending.parked !== null && (await migrationLstat(pending.parked))));
    let prepared: Plan | undefined;
    if (stillRetiring) {
      items = itemsFor(
        selected.target,
        pending.before,
        pending.afterDigest,
        pending.retire,
        pending.decisions,
        [],
        false,
        true,
      );
      receipts.push(receipt.path);
      if (options.apply !== true)
        return makeResult(
          "migrate manifest",
          { items, applied, receipts },
          {
            exit: ExitCode.PARTIAL,
            findings: [
              {
                code: "W_MIGRATION_MANIFEST_PENDING",
                severity: "warning",
                message: "An interrupted manifest migration requires explicit --apply to resume.",
                path: receipt.path,
                fix: "Review the recorded manifest and source identities, then rerun the same explicit target with --apply.",
              },
            ],
          },
        );
      if (!pending.after) prepared = await plan(selected, nameMap);
    } else {
      prepared = await plan(selected, nameMap);
      selected = await protectSources(selected, prepared.trees);
      const digest = migrationTreeDigest(prepared.entries);
      items = itemsFor(
        selected.target,
        prepared.before?.evidence ?? null,
        digest,
        prepared.retire,
        [
          ...prepared.decisions,
          `Proposed canonical declaration: ${new TextDecoder().decode(prepared.entries[0]?.bytes)}`,
        ],
        prepared.dependencies,
        false,
        prepared.changed,
      );
      if (options.apply !== true || (!prepared.changed && prepared.retire.length === 0))
        return makeResult("migrate manifest", {
          items,
          applied,
          receipts: receipt.document ? [receipt.path] : [],
        });
    }
    await withLock(
      "skillex:activation:v2",
      async () => {
        cancelled(selected.options);
        if (prepared) {
          await assertParents(selected, prepared.parents);
          for (const source of [...prepared.sources, ...prepared.trees])
            await assertMigrationTree(source.path, source.evidence);
          await assertMigrationTree(selected.target, prepared.before?.evidence ?? null);
        }
        receipt = await readBoundReceipt<ManifestReceipt>(
          selected.root,
          binding,
          selected.receiptOptions,
        );
        const existing = receiptData(receipt, selected);
        let transaction: ManifestReceipt;
        if (stillRetiring) {
          if (!isDeepStrictEqual(existing, pending))
            changed(
              receipt.path,
              "The pending manifest transaction changed while waiting for its lock.",
            );
          transaction = pending;
        } else {
          if (!prepared) throw new Error("Migration preparation is unavailable.");
          if (!isDeepStrictEqual(existing, pending))
            changed(
              receipt.path,
              "Manifest migration evidence changed while waiting for its lock.",
            );
          transaction = {
            version: 1,
            section: "manifest",
            phase: "preparing",
            target: selected.target,
            before: prepared.before?.evidence ?? null,
            after: prepared.changed ? null : (prepared.before?.evidence ?? null),
            afterDigest: migrationTreeDigest(prepared.entries),
            stage: prepared.changed ? migrationStage(selected.target, "new") : null,
            parked:
              prepared.changed && prepared.before ? migrationStage(selected.target, "old") : null,
            parents: prepared.parents,
            retire: prepared.retire,
            retired: [],
            inputs: prepared.trees.map((source) => ({
              path: source.path,
              digest: source.evidence.digest,
            })),
            decisions: prepared.decisions,
          };
          receipt = await writeBoundReceipt(receipt, transaction, selected.receiptOptions);
        }
        if (!receipts.includes(receipt.path)) receipts.push(receipt.path);
        receipt = await complete(
          selected,
          receipt,
          transaction,
          prepared?.entries,
          nameMap,
          applied,
        );
        const verified = receiptData(receipt, selected);
        if (!verified) throw new Error("Manifest verification receipt disappeared.");
        items = itemsFor(
          selected.target,
          verified.before,
          verified.afterDigest,
          verified.retire,
          verified.decisions,
          [],
          true,
          prepared?.changed ?? true,
        );
      },
      selected.options,
    );
    return makeResult("migrate manifest", { items, applied, receipts });
  } catch (error) {
    const problem =
      error instanceof SkillexError
        ? error
        : new SkillexError(ExitCode.FAILURE, [
            {
              code: "E_IO",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              ...(context ? { path: context.target } : {}),
              fix: "Preserve the affected files and migration receipt; check filesystem access before retrying.",
            },
          ]);
    if (!items.length && context)
      items = [
        {
          id: `manifest:${context.target}`,
          area: "manifest",
          action: "map-manifest",
          path: context.target,
          state: "blocked",
          details: problem.findings.map((finding) => finding.message),
          dependsOn: [],
        },
      ];
    return makeResult("migrate manifest", context ? { items, applied, receipts } : null, {
      exit: problem.exit,
      findings: problem.findings,
    });
  }
}
