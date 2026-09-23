import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { validateActivationStateLocation } from "./activation-state.js";
import { withCatalogLock } from "./catalog-lock.js";
import { isWithin } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { isSkillName, isVersionComponent } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import {
  assertMigrationAncestors,
  assertMigrationIdentity,
  assertMigrationTree,
  captureMigrationTree,
  type MigrationEntry,
  type MigrationOperation,
  type MigrationTree,
  type MigrationTreeEvidence,
  migrationAncestors,
  migrationLstat,
  migrationParent,
  migrationStage,
  migrationTreeDigest,
  publishMigrationOperation,
  type RegistryMigrationReceipt,
  readRegistryMigrationReceipt,
  removeMigrationTree,
  stageMigrationTree,
  writeRegistryMigrationReceipt,
} from "./migration-registry-state.js";
import type {
  MigrationItem,
  MigrationMapping,
  MigrationOptions,
  MigrationSectionResult,
} from "./migration-types.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";

export interface RegistryMigrationSection extends MigrationSectionResult {
  readonly nameMap: Readonly<Record<string, string>>;
}

interface PlannedOperation {
  readonly item: MigrationItem;
  readonly before: MigrationTreeEvidence | null;
  readonly entries: readonly MigrationEntry[] | null;
}
interface KnownSkill {
  readonly name: string;
  readonly digest: string;
  readonly payloadDigest: string;
  readonly entries: readonly MigrationEntry[];
  readonly dependency?: string;
}
interface Plan {
  readonly registry: RegistrySelection;
  readonly options: MigrationOptions;
  readonly items: MigrationItem[];
  readonly findings: Diagnostic[];
  readonly exits: ExitCode[];
  readonly operations: PlannedOperation[];
  readonly nameMap: Record<string, string>;
  readonly provenance: Record<string, Readonly<Record<string, unknown>>>;
  readonly externalRoots: Set<string>;
  readonly canonical: Map<string, KnownSkill>;
  readonly imported: Map<string, KnownSkill>;
}
interface Member {
  readonly relativePath: string;
  readonly name: string;
  readonly definition: boolean;
  readonly dependency?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pathKey(root: string, path: string): string {
  return isWithin(root, path) ? relative(root, path).split(sep).join("/") : path;
}
function canonicalPath(plan: Plan, name: string): string {
  return join(plan.registry.root, "all-skills", name);
}
function payloadDigest(entries: readonly MigrationEntry[]): string {
  return migrationTreeDigest(entries.filter((entry) => entry.path !== ".source.yaml"));
}
async function sameCaseOnlyEntry(
  source: string,
  destination: string,
  before: MigrationTreeEvidence,
): Promise<boolean> {
  if (
    dirname(source) !== dirname(destination) ||
    basename(source) === basename(destination) ||
    basename(source).toLowerCase() !== basename(destination).toLowerCase()
  )
    return false;
  const names = await readdir(dirname(source));
  // A case-folded lookup must name the existing source directory entry, not
  // a distinct entry with matching content or a hard-linked symbolic link.
  if (!names.includes(basename(source)) || names.includes(basename(destination))) return false;
  const destinationTree = await captureMigrationTree(destination);
  return JSON.stringify(destinationTree?.evidence) === JSON.stringify(before);
}
function externalSource(plan: Plan, source: string): void {
  if (!isWithin(plan.registry.root, source)) plan.externalRoots.add(source);
  if (isWithin(source, plan.registry.root))
    refuse(
      source,
      "E_MIGRATION_CONTENT",
      "An imported source cannot contain the destination registry.",
    );
}
async function validateSourceState(plan: Plan): Promise<void> {
  await validateActivationStateLocation(plan.registry.root, {
    ...plan.options,
    forbiddenRoots: [plan.registry.root, ...plan.externalRoots],
  });
}
function key(plan: Plan, path: string): string {
  return pathKey(plan.registry.root, path);
}
function itemId(area: string, plan: Plan, path: string): string {
  return `${area}:${key(plan, path)}`;
}
function interrupted(options: MigrationOptions): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Migration interrupted.",
      { fix: "Rerun migrate to inspect or resume the recorded migration." },
      ExitCode.INTERRUPTED,
    );
}
function mapped<T>(
  mapping: Readonly<Record<string, T>> | undefined,
  plan: Plan,
  path: string,
): T | undefined {
  const relativeKey = key(plan, path);
  return mapping && Object.hasOwn(mapping, relativeKey) ? mapping[relativeKey] : mapping?.[path];
}
function setName(plan: Plan, path: string, name: string): void {
  plan.nameMap[path] = name;
  plan.nameMap[key(plan, path)] = name;
}
function finding(
  plan: Plan,
  path: string,
  code: Diagnostic["code"],
  message: string,
  fix: string,
  severity: Diagnostic["severity"] = "error",
): void {
  plan.findings.push({ code, severity, message, path, fix });
  if (severity === "error") plan.exits.push(ExitCode.REFUSED);
}
function blocked(
  plan: Plan,
  path: string,
  error: unknown,
  area: MigrationItem["area"] = "composition",
): void {
  const findings =
    error instanceof SkillexError
      ? error.findings
      : [
          {
            code: "E_IO" as const,
            severity: "error" as const,
            message: error instanceof Error ? error.message : String(error),
            path,
            fix: "Inspect the source path and permissions, then rerun migration.",
          },
        ];
  plan.findings.push(...findings);
  plan.exits.push(error instanceof SkillexError ? error.exit : ExitCode.FAILURE);
  plan.items.push({
    id: itemId("blocked", plan, path),
    area,
    action: "preserve-blocked",
    path,
    state: "blocked",
    details: findings.map((item) => item.message),
    dependsOn: [],
  });
}
function refuse(path: string, code: Diagnostic["code"], message: string): never {
  fail(
    code,
    message,
    {
      path,
      fix: "Add an exact choice to the version 1 migration mapping, preserving the original content, then preview again.",
    },
    ExitCode.REFUSED,
  );
}
const runtimeContentFix =
  "Remove only verified generated entries (or move authored ones outside the composition), then rerun the migration preview.";
function runtimeContentMessage(holder: "candidate definition" | "composition"): string {
  return `A ${holder} contains generated, runtime, backup, or secret content that migration never carries or removes.`;
}
/** A composition that migration replaces is removed whole, so it may hold no excluded content. */
function runtimeContent(path: string, holder: "candidate definition" | "composition"): never {
  fail(
    "E_MIGRATION_RUNTIME_CONTENT",
    runtimeContentMessage(holder),
    { path, fix: runtimeContentFix },
    ExitCode.REFUSED,
  );
}
function safeKey(value: string): boolean {
  const parts = value.split("/");
  return (
    !!value &&
    !value.includes("\\") &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    parts.every(
      (part, index) =>
        (isAbsolute(value) && index === 0) || (!!part && part !== "." && part !== ".."),
    )
  );
}
function validateMapping(mapping: MigrationMapping | undefined): void {
  if (mapping === undefined) return;
  if (!record(mapping) || mapping.version !== 1)
    fail("E_MIGRATION_MAPPING", "Migration mappings require version: 1.");
  for (const section of [
    "names",
    "references",
    "digests",
    "packs",
    "wrappers",
    "manifests",
  ] as const) {
    const values = mapping[section];
    if (values === undefined) continue;
    if (!record(values)) fail("E_MIGRATION_MAPPING", `Mapping ${section} must be an object.`);
    for (const [path, value] of Object.entries(values)) {
      if (!safeKey(path)) fail("E_MIGRATION_MAPPING", `Unsafe migration mapping path: ${path}`);
      if (
        (section === "names" || section === "references") &&
        !(section === "references" && value === null) &&
        !isSkillName(value)
      )
        fail("E_MIGRATION_MAPPING", `Invalid canonical name mapped from ${path}.`);
      if (
        section === "digests" &&
        (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
      )
        fail("E_MIGRATION_MAPPING", `Invalid expected migration digest for ${path}.`);
      if (
        section === "packs" &&
        (!record(value) || !isSkillName(value.name) || !isVersionComponent(value.version))
      )
        fail(
          "E_MIGRATION_MAPPING",
          `Pack mapping for ${path} requires canonical name and explicit version.`,
        );
      if (
        section === "wrappers" &&
        (!record(value) ||
          !isSkillName(value.name) ||
          !Array.isArray(value.ownedPaths) ||
          !value.ownedPaths.every(
            (entry) => typeof entry === "string" && safeKey(entry) && !isAbsolute(entry),
          ) ||
          !value.ownedPaths.includes("SKILL.md"))
      )
        fail(
          "E_MIGRATION_MAPPING",
          `Wrapper mapping for ${path} must name its canonical skill and explicitly own SKILL.md plus its support paths.`,
        );
    }
  }
}

async function portableDefinition(source: string, tree: MigrationTree): Promise<MigrationEntry[]> {
  const entries: MigrationEntry[] = [];
  const directoryLinks: { parent: string; target: string }[] = [];
  for (const entry of tree.entries) {
    if (entry.kind !== "link") {
      entries.push(entry);
      continue;
    }
    const path = join(source, entry.path);
    let target: string;
    try {
      target = await realpath(path);
    } catch {
      refuse(
        path,
        "E_MIGRATION_CONTENT",
        "A definition contains a dangling or cyclic support link.",
      );
    }
    if (!isWithin(source, target) || target === source)
      refuse(
        path,
        "E_MIGRATION_CONTENT",
        "A definition support link escapes its owned content or loops to its root.",
      );
    const reltarget = relative(source, target);
    if (!tree.entries.some((item) => item.path === reltarget))
      refuse(
        path,
        "E_MIGRATION_CONTENT",
        "A support link depends on content outside the captured definition.",
      );
    const isDirectory = (await lstat(target)).isDirectory();
    if (isDirectory && isWithin(target, dirname(path)))
      refuse(path, "E_MIGRATION_CONTENT", "A support directory link creates recursive traversal.");
    if (isDirectory)
      directoryLinks.push({
        parent: dirname(entry.path) === "." ? "" : dirname(entry.path),
        target: reltarget,
      });
    entries.push({ ...entry, target: relative(dirname(path), target) || "." });
  }
  const edges = new Map(
    tree.entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => [entry.path, [] as string[]]),
  );
  for (const entry of tree.entries)
    if (entry.kind === "directory" && entry.path)
      edges.get(dirname(entry.path) === "." ? "" : dirname(entry.path))?.push(entry.path);
  for (const link of directoryLinks) edges.get(link.parent)?.push(link.target);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visiting.has(path))
      refuse(
        join(source, path),
        "E_MIGRATION_CONTENT",
        "Support directory links form a recursive cycle.",
      );
    if (visited.has(path)) return;
    visiting.add(path);
    for (const child of edges.get(path) ?? []) visit(child);
    visiting.delete(path);
    visited.add(path);
  };
  visit("");
  return entries;
}

function qualified(plan: Plan, source: string, preferred: string): string {
  const rel = key(plan, source).replace(/^(?:sets|packs|all-skills)\//, "");
  const stem =
    `${rel.includes("/") ? dirname(rel) : basename(dirname(source))}-${preferred}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "migrated-skill";
  if (isSkillName(stem) && !plan.canonical.has(stem)) return stem;
  return `${stem.slice(0, 90)}-${createHash("sha256").update(rel).digest("hex").slice(0, 10)}`;
}

async function importDefinition(
  plan: Plan,
  lexicalSource: string,
  preferred: string,
  selected?: readonly MigrationEntry[],
): Promise<KnownSkill> {
  interrupted(plan.options);
  const source = await realpath(lexicalSource);
  externalSource(plan, source);
  const previous = plan.imported.get(lexicalSource);
  if (previous) return previous;
  const captured = await captureMigrationTree(source);
  if (captured?.evidence.root.kind !== "directory")
    refuse(
      lexicalSource,
      "E_MIGRATION_CONTENT",
      "A canonical definition must come from a real readable skill directory.",
    );
  const metadata = await readSkillMetadata(source);
  if (metadata.provenance) plan.provenance[lexicalSource] = metadata.provenance;
  const tree = selected
    ? {
        entries: selected,
        evidence: { ...captured.evidence, digest: migrationTreeDigest(selected) },
        excluded: captured.excluded,
      }
    : captured;
  // Generated/runtime entries (captured.excluded) are never part of `tree`, so they are never
  // copied into the catalog. A source that migration later removes is refused in composition().
  const expected =
    mapped(plan.options.mapping?.digests, plan, lexicalSource) ??
    mapped(plan.options.mapping?.digests, plan, source);
  if (expected !== undefined && expected !== tree.evidence.digest)
    refuse(
      lexicalSource,
      "E_MIGRATION_DIGEST",
      "The explicitly mapped source digest differs from the current source.",
    );
  const entries = await portableDefinition(source, tree);
  const digest = migrationTreeDigest(entries);
  const contentDigest = payloadDigest(entries);
  const explicit =
    mapped(plan.options.mapping?.names, plan, lexicalSource) ??
    mapped(plan.options.mapping?.names, plan, source) ??
    (selected ? preferred : undefined);
  let name = explicit ?? preferred;
  const known = plan.canonical.get(name);
  let reused = known?.payloadDigest === contentDigest ? known : undefined;
  if (!explicit && !reused)
    reused = [...plan.canonical.values()]
      .filter((item) => item.payloadDigest === contentDigest)
      .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (reused) name = reused.name;
  else if (explicit && known)
    refuse(
      lexicalSource,
      "E_MIGRATION_NAME_CONFLICT",
      `Mapped canonical name ${name} already owns different content.`,
    );
  else if (!isSkillName(name) || known) name = qualified(plan, lexicalSource, preferred);
  if (!isSkillName(name))
    refuse(
      lexicalSource,
      "E_MIGRATION_NAME",
      "The source requires an explicit safe canonical name.",
    );
  const destination = canonicalPath(plan, name);
  if (!reused) {
    const before = await captureMigrationTree(destination);
    if (before && !(before.evidence.root.kind === "link" && destination === lexicalSource))
      refuse(
        destination,
        "E_MIGRATION_NAME_CONFLICT",
        "Canonical destination contains foreign or different content.",
      );
    const id = itemId("catalog", plan, destination);
    const item: MigrationItem = {
      id,
      area: "catalog",
      action: before ? "materialize-canonical" : "import-definition",
      path: destination,
      target: source,
      state: "ready",
      beforeDigest: tree.evidence.digest,
      afterDigest: digest,
      details: [
        `source: ${lexicalSource}`,
        `canonical name: ${name}`,
        "All captured definition bytes, support entries, modes, and provenance are preserved; internal absolute links are made portable.",
        ...(!selected && captured.excluded.length
          ? [
              `Generated/runtime entries are not migrated and stay at the source: ${captured.excluded.join(", ")}`,
            ]
          : []),
      ],
      dependsOn: [],
    };
    plan.items.push(item);
    plan.operations.push({ item, before: before?.evidence ?? null, entries });
    reused = { name, digest, payloadDigest: contentDigest, entries, dependency: id };
    plan.canonical.set(name, reused);
  }
  const dependency = reused.dependency;
  plan.items.push({
    id: itemId("definition", plan, lexicalSource),
    area: "catalog",
    action: dependency ? "preserve-definition" : "reuse-definition",
    path: lexicalSource,
    target: destination,
    state: dependency ? "ready" : "preserved",
    beforeDigest: tree.evidence.digest,
    afterDigest: reused.digest,
    details: [
      dependency
        ? "Definition is retained at its canonical destination before its original composition entry is replaced."
        : "Existing canonical authored payload is identical; differing original provenance is preserved separately in the migration receipt.",
    ],
    dependsOn: dependency ? [dependency] : [],
  });
  setName(plan, lexicalSource, name);
  setName(plan, source, name);
  plan.imported.set(lexicalSource, reused);
  return reused;
}

function removeEntries(entries: MigrationEntry[], path: string): void {
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index];
    if (item && (item.path === path || item.path.startsWith(`${path}${sep}`)))
      entries.splice(index, 1);
  }
}
function put(entries: MigrationEntry[], entry: MigrationEntry): void {
  removeEntries(entries, entry.path);
  entries.push(entry);
}
function memberLink(plan: Plan, destination: string, path: string, name: string): MigrationEntry {
  return {
    path,
    kind: "link",
    mode: 0o777,
    target: relative(dirname(join(destination, path)), canonicalPath(plan, name)),
  };
}
function wrapperRoutes(entries: readonly MigrationEntry[], owned: readonly string[]): string[] {
  const definition =
    entries.find((entry) => entry.path === "SKILL.md")?.bytes?.toString("utf8") ?? "";
  const routes = [
    ...definition.matchAll(
      /(?:\]\(|`|\s)(?:\.\/)?([a-zA-Z0-9_.-]+\/(?:[a-zA-Z0-9_.-]+\/)*SKILL\.md)(?:[)`\s]|$)/g,
    ),
  ].map((match) => match[1] as string);
  return [
    ...new Set(
      routes.filter(
        (route) =>
          !/^\.\.\/[a-z0-9][a-z0-9._-]*\/SKILL\.md$/.test(route) &&
          !owned.some((path) => route === path || route.startsWith(`${path}/`)),
      ),
    ),
  ].sort();
}

async function composition(plan: Plan, path: string, kind: "set" | "pack"): Promise<void> {
  interrupted(plan.options);
  await migrationAncestors(plan.registry.root, path);
  const before = await captureMigrationTree(path);
  if (!before) return;
  const source = await realpath(path);
  externalSource(plan, source);
  const tree = before.evidence.root.kind === "link" ? await captureMigrationTree(source) : before;
  if (tree?.evidence.root.kind !== "directory")
    refuse(path, "E_MIGRATION_COMPOSITION", "Composition source is not a readable directory.");
  let entries = [...tree.entries];
  const members: Member[] = [];
  const details: string[] = [];
  let hasBlocker = false;
  const rawManifest = entries.find((entry) => entry.path === "pack.toml");
  let raw: Record<string, unknown> = {};
  let destination = path;
  let packName = basename(path);
  let packVersion: string | undefined;
  if (kind === "pack") {
    if (rawManifest) {
      if (rawManifest.kind !== "file")
        refuse(join(path, "pack.toml"), "E_MIGRATION_PACK", "Pack manifest must be a real file.");
      try {
        raw = parseToml((rawManifest.bytes as Buffer).toString("utf8"));
      } catch {
        fail("E_MIGRATION_PACK", "Legacy pack manifest is malformed TOML.", {
          path: join(path, "pack.toml"),
          fix: "Correct the legacy TOML before migrating it.",
        });
      }
    }
    const mappedPack = mapped(plan.options.mapping?.packs, plan, path);
    const header = record(raw.pack) ? raw.pack : {};
    packName = mappedPack?.name ?? (typeof header.name === "string" ? header.name : basename(path));
    packVersion =
      mappedPack?.version ?? (typeof header.version === "string" ? header.version : undefined);
    if (!isSkillName(packName) || !packVersion || !isVersionComponent(packVersion)) {
      finding(
        plan,
        path,
        "E_MIGRATION_PACK_MAPPING",
        "Legacy pack needs an explicit canonical name and version.",
        "Provide mapping.packs[legacyPackPath] with name and version.",
      );
      hasBlocker = true;
    }
    if (
      mappedPack &&
      basename(path) !== mappedPack.name &&
      basename(dirname(path)) !== mappedPack.name
    )
      destination = join(plan.registry.root, "packs", mappedPack.name);
    if (
      mappedPack &&
      basename(dirname(path)) === mappedPack.name &&
      basename(path) !== mappedPack.version
    )
      destination = join(dirname(path), mappedPack.version);
  }
  const wrapper = tree.entries.find((entry) => entry.path === "SKILL.md");
  if (wrapper) {
    const mapping = mapped(plan.options.mapping?.wrappers, plan, path);
    if (!mapping) {
      finding(
        plan,
        path,
        "E_MIGRATION_WRAPPER_MAPPING",
        "Composition root owns a SKILL.md wrapper whose support ownership needs an explicit mapping.",
        "Supply mapping.wrappers[path] with name and ownedPaths including SKILL.md.",
      );
      hasBlocker = true;
    } else {
      const selected: MigrationEntry[] = [tree.entries[0] as MigrationEntry];
      for (const owned of mapping.ownedPaths) {
        const actual = tree.entries.filter(
          (entry) => entry.path === owned || entry.path.startsWith(`${owned}${sep}`),
        );
        if (!actual.length)
          refuse(
            join(path, owned),
            "E_MIGRATION_WRAPPER_MAPPING",
            "An explicitly owned wrapper path is absent.",
          );
        selected.push(...actual);
      }
      const missingRoutes = wrapperRoutes(selected, mapping.ownedPaths);
      if (missingRoutes.length) {
        finding(
          plan,
          path,
          "E_MIGRATION_WRAPPER_ROUTES",
          `Wrapper routes would escape their relocated content: ${missingRoutes.join(", ")}`,
          "Correct these authored routes to explicit canonical siblings before migrating the wrapper.",
        );
        hasBlocker = true;
      } else {
        const name = await importDefinition(plan, path, mapping.name, selected);
        members.push({
          relativePath: "",
          name: name.name,
          definition: true,
          ...(name.dependency ? { dependency: name.dependency } : {}),
        });
        for (const owned of mapping.ownedPaths) removeEntries(entries, owned);
        details.push(
          `Wrapper content is preserved as ${name.name}; owned paths: ${mapping.ownedPaths.join(", ")}`,
        );
      }
    }
  }
  const definitionRoots: string[] = [];
  for (const entry of tree.entries) {
    if (entry.kind !== "file" || basename(entry.path) !== "SKILL.md" || entry.path === "SKILL.md")
      continue;
    const definition = dirname(entry.path);
    if (definitionRoots.some((parent) => definition.startsWith(`${parent}${sep}`))) continue;
    definitionRoots.push(definition);
    const lexical = join(path, definition);
    try {
      if (mapped(plan.options.mapping?.references, plan, lexical) === null)
        refuse(
          lexical,
          "E_MIGRATION_REFERENCE",
          "A null reference mapping cannot remove a real definition; name and preserve its content instead.",
        );
      // This source is removed with its composition, and excluded content is never evidence.
      const generated = before.excluded.find((item) => item.startsWith(`${definition}${sep}`));
      if (generated !== undefined) runtimeContent(join(path, generated), "candidate definition");
      const skill = await importDefinition(plan, lexical, basename(definition));
      members.push({
        relativePath: definition,
        name: skill.name,
        definition: true,
        ...(skill.dependency ? { dependency: skill.dependency } : {}),
      });
      removeEntries(entries, definition);
    } catch (error) {
      blocked(plan, lexical, error, "catalog");
      hasBlocker = true;
    }
  }
  for (const entry of tree.entries) {
    if (
      !entry.path ||
      entry.kind !== "link" ||
      definitionRoots.some((parent) => entry.path.startsWith(`${parent}${sep}`))
    )
      continue;
    const lexical = join(path, entry.path);
    const explicitReference = mapped(plan.options.mapping?.references, plan, lexical);
    if (explicitReference === null) {
      removeEntries(entries, entry.path);
      details.push(`Explicitly retire reference ${entry.path}; its referent is untouched.`);
      continue;
    }
    try {
      let target: string | undefined;
      try {
        target = await realpath(join(source, entry.path));
      } catch (error) {
        if (!explicitReference) throw error;
      }
      if (explicitReference) {
        const skill = plan.canonical.get(explicitReference);
        if (!skill)
          refuse(
            lexical,
            "E_MIGRATION_REFERENCE",
            "Explicit reference mapping names an unavailable canonical skill.",
          );
        members.push({
          relativePath: entry.path,
          name: skill.name,
          definition: false,
          ...(skill.dependency ? { dependency: skill.dependency } : {}),
        });
        setName(plan, lexical, skill.name);
      } else if (target && (await inspectPath(join(target, "SKILL.md")))?.isFile()) {
        const canonical =
          dirname(target) === join(plan.registry.root, "all-skills")
            ? plan.canonical.get(basename(target))
            : undefined;
        const skill = canonical ?? (await importDefinition(plan, lexical, basename(entry.path)));
        members.push({
          relativePath: entry.path,
          name: skill.name,
          definition: false,
          ...(skill.dependency ? { dependency: skill.dependency } : {}),
        });
        setName(plan, lexical, skill.name);
      }
    } catch (error) {
      const missing = ["ENOENT", "ENOTDIR", "ELOOP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      );
      if (missing)
        finding(
          plan,
          lexical,
          "E_MIGRATION_REFERENCE",
          "Dangling or cyclic composition reference has no explicit mapping.",
          "Map this exact reference to a proven canonical name, or null to retire only the link.",
        );
      else blocked(plan, lexical, error);
      hasBlocker = true;
    }
  }
  for (const member of members) {
    if (!member.relativePath) continue;
    removeEntries(entries, member.relativePath);
    if (kind === "pack" || dirname(member.relativePath) !== ".")
      entries.push(memberLink(plan, destination, member.relativePath, member.name));
  }
  let selected = members.map((member) => member.name);
  if (kind === "pack") {
    const declared: string[] = [];
    if (
      raw.freeform !== undefined &&
      (!record(raw.freeform) ||
        !Array.isArray(raw.freeform.skills) ||
        !raw.freeform.skills.every((item) => typeof item === "string"))
    )
      refuse(path, "E_MIGRATION_PACK", "Legacy freeform membership is malformed.");
    if (raw.slots !== undefined && !record(raw.slots))
      refuse(path, "E_MIGRATION_PACK", "Legacy slots must be a table.");
    for (const [slot, value] of Object.entries(record(raw.slots) ? raw.slots : {})) {
      if (
        !record(value) ||
        (value.skill !== undefined && value.skill !== null && typeof value.skill !== "string")
      )
        refuse(path, "E_MIGRATION_PACK", `Malformed legacy slot ${slot}.`);
      if (typeof value.skill === "string") declared.push(value.skill);
      details.push(
        `Retired slot ${slot}; ${typeof value.skill === "string" ? `retain assigned skill ${value.skill}` : "no skill was assigned"}.`,
      );
    }
    if (record(raw.freeform)) declared.push(...(raw.freeform.skills as string[]));
    if (rawManifest) {
      selected = [];
      for (const name of declared) {
        const reference = mapped(plan.options.mapping?.references, plan, join(path, name));
        if (reference === null) {
          if (!tree.entries.some((entry) => entry.path === name && entry.kind === "link"))
            refuse(
              join(path, name),
              "E_MIGRATION_REFERENCE",
              "Null reference mappings may retire existing symbolic links only, never a real definition or unaccounted selection.",
            );
          details.push(
            `Explicitly remove ${name} from pack membership; the referent is preserved.`,
          );
          continue;
        }
        if (reference !== undefined) {
          if (!plan.canonical.has(reference))
            refuse(
              join(path, name),
              "E_MIGRATION_REFERENCE",
              "Mapped pack member is not available in the canonical catalog.",
            );
          selected.push(reference);
          continue;
        }
        const matches = members.filter(
          (member) =>
            member.relativePath === name ||
            member.relativePath.startsWith(`${name}${sep}`) ||
            member.relativePath === join("skills", name),
        );
        if (matches.length) selected.push(...matches.map((member) => member.name));
        else if (plan.canonical.has(name)) selected.push(name);
        else {
          finding(
            plan,
            join(path, name),
            "E_MIGRATION_REFERENCE",
            `Declared pack member ${name} has no proven canonical content.`,
            "Provide an exact reference/content mapping; migration will preserve the pack until every member is accounted for.",
          );
          hasBlocker = true;
        }
      }
    }
    const skillRoot = entries.find((entry) => entry.path === "skills");
    if (skillRoot && skillRoot.kind !== "directory") {
      finding(
        plan,
        join(path, "skills"),
        "E_MIGRATION_PACK_ROOT",
        "A non-directory pack skills root requires explicit migration ownership.",
        "Preserve and account for this skills root before regenerating canonical membership.",
      );
      hasBlocker = true;
    } else if (!skillRoot) entries.push({ path: "skills", kind: "directory", mode: 0o755 });
    for (const entry of [...entries]) {
      if (dirname(entry.path) !== "skills" || entry.kind !== "link") continue;
      if (selected.includes(basename(entry.path))) removeEntries(entries, entry.path);
      else {
        finding(
          plan,
          join(path, entry.path),
          "E_MIGRATION_PACK_ROOT",
          "An undeclared reference in the generated skills root needs an explicit membership or retirement decision.",
          "Include this canonical member explicitly, or map its exact link to null before migration.",
        );
        hasBlocker = true;
      }
    }
    for (const name of [...new Set(selected)]) {
      const existing = entries.find((entry) => entry.path === join("skills", name));
      if (existing) {
        finding(
          plan,
          join(path, existing.path),
          "E_MIGRATION_PACK_ROOT",
          "Foreign pack skills content collides with a canonical member.",
          "Account for the preserved content before rebuilding this member.",
        );
        hasBlocker = true;
      } else entries.push(memberLink(plan, destination, join("skills", name), name));
    }
    for (const entry of entries) {
      if (!entry.path.startsWith(`skills${sep}`)) continue;
      if (
        dirname(entry.path) === "skills" &&
        entry.kind === "link" &&
        selected.includes(basename(entry.path))
      )
        continue;
      finding(
        plan,
        join(path, entry.path),
        "E_MIGRATION_PACK_ROOT",
        "Generated pack skills content cannot be discarded or treated as composition support implicitly.",
        "Preserve this content at an explicitly chosen support location before generating the canonical skills root.",
      );
      hasBlocker = true;
    }
    const legacy =
      Object.keys(raw).some((field) => !["pack", "freeform", "source"].includes(field)) ||
      (record(raw.pack) &&
        Object.keys(raw.pack).some((field) => !["name", "version", "description"].includes(field)));
    if (raw.source !== undefined && !record(raw.source))
      refuse(join(path, "pack.toml"), "E_MIGRATION_PACK", "Pack provenance must be a TOML table.");
    const sourceMetadata = record(raw.source) ? raw.source : {};
    const manifest = {
      pack: {
        name: packName,
        version: packVersion ?? "",
        ...(record(raw.pack) && typeof raw.pack.description === "string"
          ? { description: raw.pack.description }
          : {}),
      },
      freeform: { skills: [...new Set(selected)] },
      ...(Object.keys(sourceMetadata).length || legacy
        ? { source: { ...sourceMetadata, ...(legacy ? { legacy_migration: raw } : {}) } }
        : {}),
    };
    if (legacy)
      details.push(
        "Retired runtime policy/slot/payload fields are retained only as inert [source.legacy_migration] provenance.",
      );
    if (
      !rawManifest ||
      legacy ||
      !record(raw.pack) ||
      raw.pack.name !== packName ||
      raw.pack.version !== packVersion ||
      JSON.stringify(record(raw.freeform) ? raw.freeform.skills : null) !==
        JSON.stringify([...new Set(selected)])
    )
      put(entries, {
        path: "pack.toml",
        kind: "file",
        mode: rawManifest?.mode ?? 0o644,
        bytes: Buffer.from(stringifyToml(manifest)),
      });
  } else {
    for (const name of [...new Set(selected)]) {
      const existing = entries.find((entry) => entry.path === name);
      if (existing) {
        finding(
          plan,
          join(path, name),
          "E_MIGRATION_SET_MEMBER",
          "Preserved set support content collides with a canonical member name.",
          "Map the definition to a distinct canonical name or explicitly account for the support content.",
        );
        hasBlocker = true;
      } else entries.push(memberLink(plan, destination, name, name));
    }
  }
  entries = entries.sort((a, b) => a.path.localeCompare(b.path));
  const afterDigest = migrationTreeDigest(entries);
  const changed = destination !== path || before.evidence.digest !== afterDigest;
  // Replacing or retiring a real composition parks and removes it through its evidence;
  // excluded entries outside a candidate definition (reported above) would block that removal.
  if (changed)
    for (const item of before.excluded) {
      if (definitionRoots.some((root) => item.startsWith(`${root}${sep}`))) continue;
      finding(
        plan,
        join(path, item),
        "E_MIGRATION_RUNTIME_CONTENT",
        runtimeContentMessage("composition"),
        runtimeContentFix,
      );
      hasBlocker = true;
    }
  const dependencies = [
    ...new Set(members.flatMap((member) => (member.dependency ? [member.dependency] : []))),
  ];
  const item: MigrationItem = {
    id: itemId("composition", plan, path),
    area: "composition",
    action: changed
      ? kind === "set"
        ? "canonicalize-set"
        : "canonicalize-pack"
      : "preserve-composition",
    path,
    ...(destination !== path ? { target: destination } : {}),
    state: hasBlocker ? "blocked" : changed ? "ready" : "preserved",
    beforeDigest: before.evidence.digest,
    afterDigest,
    details: [
      ...details,
      `Canonical membership: ${[...new Set(selected)].join(", ")}`,
      "Pack/set support assets and existing provenance are retained.",
    ],
    dependsOn: dependencies,
  };
  const itemIndex = plan.items.push(item) - 1;
  if (!hasBlocker && changed) {
    if (destination !== path) {
      const destinationExists = await migrationLstat(destination);
      const caseOnly =
        destinationExists && (await sameCaseOnlyEntry(path, destination, before.evidence));
      if (destinationExists && !caseOnly)
        refuse(
          destination,
          "E_MIGRATION_COMPOSITION",
          "Mapped composition destination already exists.",
        );
      const createItem = {
        ...item,
        id: itemId("composition", plan, destination),
        path: destination,
        target: path,
      };
      if (caseOnly) {
        // The normal staged replacement parks the exact original entry and
        // publishes its replacement with the requested spelling. A separate
        // retirement would resolve to, and could remove, the new entry.
        plan.items[itemIndex] = createItem;
        plan.operations.push({ item: createItem, before: before.evidence, entries });
      } else {
        plan.items.push(createItem);
        plan.operations.push({ item: createItem, before: null, entries });
        plan.operations.push({
          item: {
            ...item,
            action: "retire-legacy-composition",
            dependsOn: [...dependencies, createItem.id],
          },
          before: before.evidence,
          entries: null,
        });
      }
    } else plan.operations.push({ item, before: before.evidence, entries });
  }
}

async function prepare(
  registry: RegistrySelection,
  options: MigrationOptions,
  previousNames: Readonly<Record<string, string>> = {},
  previousProvenance: RegistryMigrationReceipt["provenance"] = {},
  previousExternalRoots: readonly string[] = [],
): Promise<Plan> {
  const plan: Plan = {
    registry,
    options,
    items: [],
    findings: [],
    exits: [],
    operations: [],
    nameMap: { ...previousNames },
    provenance: { ...previousProvenance },
    externalRoots: new Set(previousExternalRoots),
    canonical: new Map(),
    imported: new Map(),
  };
  const catalog = join(registry.root, "all-skills");
  const links: string[] = [];
  const retiredAliases: PlannedOperation[] = [];
  for (const entry of (await readdir(catalog, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    interrupted(options);
    const path = join(catalog, entry.name);
    if (entry.name.startsWith(".skillex-tmp-")) {
      finding(
        plan,
        path,
        "W_MIGRATION_STAGING_PRESERVED",
        "An unrecognized staging artifact is preserved.",
        "Inspect the artifact and its operation receipt before explicitly removing it.",
        "warning",
      );
      continue;
    }
    if (entry.isSymbolicLink()) {
      links.push(path);
      continue;
    }
    if (!entry.isDirectory() || !(await inspectPath(join(path, "SKILL.md")))) continue;
    try {
      if (!isSkillName(entry.name))
        refuse(
          path,
          "E_MIGRATION_NAME",
          "Existing canonical directory has an invalid canonical name.",
        );
      await readSkillMetadata(path);
      const tree = await captureMigrationTree(path);
      if (!tree) continue;
      plan.canonical.set(entry.name, {
        name: entry.name,
        digest: tree.evidence.digest,
        payloadDigest: payloadDigest(tree.entries),
        entries: tree.entries,
      });
      setName(plan, path, entry.name);
      plan.items.push({
        id: itemId("catalog", plan, path),
        area: "catalog",
        action: "preserve-canonical",
        path,
        state: "preserved",
        beforeDigest: tree.evidence.digest,
        afterDigest: tree.evidence.digest,
        details: ["Existing real canonical definition is preserved."],
        dependsOn: [],
      });
    } catch (error) {
      blocked(plan, path, error, "catalog");
    }
  }
  for (const path of links) {
    try {
      const skill = await importDefinition(plan, path, basename(path));
      if (canonicalPath(plan, skill.name) !== path) {
        const before = await captureMigrationTree(path);
        if (before?.evidence.root.kind !== "link")
          refuse(
            path,
            "E_MIGRATION_CHANGED",
            "The legacy canonical alias changed during planning.",
          );
        const item: MigrationItem = {
          id: itemId("catalog-alias", plan, path),
          area: "catalog",
          action: "retire-canonical-alias",
          path,
          target: canonicalPath(plan, skill.name),
          state: "ready",
          beforeDigest: before.evidence.digest,
          afterDigest: skill.digest,
          details: [
            "Identical definition content is retained at the canonical target; retire only this exact alias after composition rewrites.",
          ],
          dependsOn: skill.dependency ? [skill.dependency] : [],
        };
        plan.items.push(item);
        retiredAliases.push({ item, before: before.evidence, entries: null });
      }
    } catch (error) {
      blocked(plan, path, error, "catalog");
    }
  }
  for (const [path, name] of Object.entries(options.mapping?.names ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isAbsolute(path) || isWithin(registry.root, path)) continue;
    try {
      await importDefinition(plan, path, name);
    } catch (error) {
      blocked(plan, path, error, "catalog");
    }
  }
  for (const kind of ["sets", "packs"] as const) {
    const root = join(registry.root, kind);
    const rootInfo = await inspectPath(root);
    if (!rootInfo) continue;
    if (!rootInfo.isDirectory()) {
      blocked(plan, root, new Error("Composition family root must be a real directory."));
      continue;
    }
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(root, entry.name);
      if (entry.name.startsWith(".skillex-tmp-")) {
        finding(
          plan,
          path,
          "W_MIGRATION_STAGING_PRESERVED",
          "An unrecognized composition staging artifact is preserved.",
          "Inspect its migration receipt before explicitly removing it.",
          "warning",
        );
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        if (entry.isSymbolicLink()) externalSource(plan, await realpath(path));
        if (kind === "sets") await composition(plan, path, "set");
        else if (await inspectPath(join(path, "pack.toml"))) await composition(plan, path, "pack");
        else {
          const versions: string[] = [];
          for (const child of await readdir(path, { withFileTypes: true }))
            if (
              (child.isDirectory() || child.isSymbolicLink()) &&
              (await inspectPath(join(path, child.name, "pack.toml")))
            )
              versions.push(child.name);
          if (versions.length)
            for (const version of versions.sort())
              await composition(plan, join(path, version), "pack");
          else await composition(plan, path, "pack");
        }
      } catch (error) {
        blocked(plan, path, error);
      }
    }
  }
  if (!plan.items.some((item) => item.area === "composition" && item.state === "blocked"))
    plan.operations.push(...retiredAliases);
  else
    for (const alias of retiredAliases) {
      const index = plan.items.indexOf(alias.item);
      if (index >= 0)
        plan.items[index] = {
          ...alias.item,
          state: "blocked",
          details: [
            ...alias.item.details,
            "Keep the alias until affected compositions are fully accounted for.",
          ],
        };
    }
  return plan;
}

function section(
  plan: Plan,
  applied: readonly string[] = [],
  receipts: readonly string[] = [],
): RegistryMigrationSection {
  const published = new Set(applied);
  return {
    items: plan.items.map((item) =>
      published.has(item.id) ||
      (item.state === "ready" &&
        item.dependsOn.length > 0 &&
        item.dependsOn.every((id) => published.has(id)) &&
        item.action === "preserve-definition")
        ? { ...item, state: "verified" }
        : item,
    ),
    applied,
    receipts,
    nameMap: plan.nameMap,
  };
}
function exitFor(plan: Plan, applied = false): ExitCode {
  const failure = [
    ExitCode.INTERRUPTED,
    ExitCode.FAILURE,
    ExitCode.CONFIG,
    ExitCode.REFUSED,
    ExitCode.PARTIAL,
    ExitCode.LOCK_BUSY,
  ].find((exit) => plan.exits.includes(exit));
  if (failure !== undefined)
    return applied && failure !== ExitCode.INTERRUPTED ? ExitCode.PARTIAL : failure;
  return plan.findings.some((item) => item.severity === "warning")
    ? ExitCode.PARTIAL
    : ExitCode.SUCCESS;
}

/** Explicit registry migration; previews never create state, staging, catalog, or composition entries. */
export async function migrateRegistry(
  options: MigrationOptions = {},
): Promise<ResultEnvelope<RegistryMigrationSection | null>> {
  let plan: Plan | undefined;
  const applied: string[] = [];
  const receipts: string[] = [];
  let started = false;
  try {
    validateMapping(options.mapping);
    interrupted(options);
    const registry = await discoverRegistry(options);
    let snapshot = await readRegistryMigrationReceipt(registry.root, options);
    const previous = snapshot.document?.data;
    plan = await prepare(
      registry,
      options,
      previous?.nameMap,
      previous?.provenance,
      previous?.externalRoots,
    );
    await validateSourceState(plan);
    const pending = previous && previous.phase !== "complete";
    if (!options.apply) {
      if (pending)
        finding(
          plan,
          snapshot.path,
          "W_MIGRATION_RECOVERY_PENDING",
          "Registry migration has an interrupted transaction; preview leaves it untouched.",
          "Run migrate --apply to recover the exact recorded transaction before a new plan is applied.",
          "warning",
        );
      return makeResult("migrate registry", section(plan, [], previous ? [snapshot.path] : []), {
        findings: plan.findings,
        exit: exitFor(plan),
      });
    }
    if (!pending && !plan.operations.length)
      return makeResult("migrate registry", section(plan, [], previous ? [snapshot.path] : []), {
        findings: plan.findings,
        exit: exitFor(plan),
      });
    return await withCatalogLock(registry, options, async () =>
      withLock(
        `${registry.root}#compositions`,
        async () => {
          snapshot = await readRegistryMigrationReceipt(registry.root, options, [
            ...(plan as Plan).externalRoots,
          ]);
          let value = snapshot.document?.data;
          if (value && value.phase !== "complete") {
            if (value.phase === "preparing") {
              for (const operation of value.operations) {
                if (!operation.stage || !(await migrationLstat(operation.stage))) continue;
                if (!operation.after) {
                  finding(
                    plan as Plan,
                    operation.stage,
                    "W_MIGRATION_STAGING_PRESERVED",
                    "An interrupted staging directory lacks complete ownership evidence and was preserved.",
                    "Inspect the staging directory and remove it explicitly only when its content is accounted for; then rerun migrate --apply.",
                    "warning",
                  );
                  return makeResult(
                    "migrate registry",
                    section(plan as Plan, [], [snapshot.path]),
                    { findings: (plan as Plan).findings, exit: ExitCode.PARTIAL },
                  );
                }
                started = true;
                await assertMigrationAncestors(operation.ancestors);
                await removeMigrationTree(operation.stage, operation.after);
              }
            } else {
              for (const operation of value.operations) {
                interrupted(options);
                started = true;
                await publishMigrationOperation(operation);
                applied.push(operation.item.id);
              }
              for (const operation of value.operations)
                if (operation.parked && (await migrationLstat(operation.parked))) {
                  await assertMigrationAncestors(operation.ancestors);
                  await removeMigrationTree(
                    operation.parked,
                    operation.before as MigrationTreeEvidence,
                  );
                }
            }
            value = {
              ...value,
              phase: "complete",
              operations: [],
              verified: [
                ...value.verified,
                ...value.operations.map((operation) => ({
                  ...operation.item,
                  state: "verified" as const,
                })),
              ],
            };
            snapshot = await writeRegistryMigrationReceipt(snapshot, value, options);
            receipts.push(snapshot.path);
          }
          plan = await prepare(
            registry,
            options,
            value?.nameMap,
            value?.provenance,
            value?.externalRoots,
          );
          await validateSourceState(plan);
          if (!plan.operations.length)
            return makeResult("migrate registry", section(plan, applied, receipts), {
              findings: plan.findings,
              exit: exitFor(plan, started),
            });
          const operations: MigrationOperation[] = [];
          for (const operation of plan.operations) {
            await assertMigrationTree(operation.item.path, operation.before);
            operations.push({
              item: operation.item,
              path: operation.item.path,
              stage: operation.entries ? migrationStage(operation.item.path, "new") : null,
              parked: operation.before ? migrationStage(operation.item.path, "old") : null,
              parent: await migrationParent(operation.item.path),
              ancestors: await migrationAncestors(registry.root, operation.item.path),
              before: operation.before,
              after: null,
            });
          }
          let journal: RegistryMigrationReceipt = {
            version: 1,
            registry: registry.root,
            phase: "preparing",
            operations,
            verified: value?.verified ?? [],
            nameMap: plan.nameMap,
            provenance: plan.provenance,
            externalRoots: [...plan.externalRoots].sort(),
          };
          snapshot = await writeRegistryMigrationReceipt(snapshot, journal, options);
          started = true;
          if (!receipts.includes(snapshot.path)) receipts.push(snapshot.path);
          for (let index = 0; index < operations.length; index++) {
            interrupted(options);
            const operation = operations[index] as MigrationOperation;
            const content = plan.operations[index]?.entries;
            if (!content || !operation.stage) continue;
            const after = await stageMigrationTree(
              operation.stage,
              content,
              operation.parent,
              operation.ancestors,
            );
            operations[index] = { ...operation, after };
            journal = { ...journal, operations: [...operations] };
            snapshot = await writeRegistryMigrationReceipt(snapshot, journal, options);
          }
          for (const operation of operations) {
            await assertMigrationIdentity(dirname(operation.path), operation.parent);
            await assertMigrationAncestors(operation.ancestors);
            await assertMigrationTree(operation.path, operation.before);
          }
          journal = { ...journal, phase: "ready", operations };
          snapshot = await writeRegistryMigrationReceipt(snapshot, journal, options);
          for (const operation of operations) {
            interrupted(options);
            await publishMigrationOperation(operation);
            applied.push(operation.item.id);
          }
          for (const operation of operations)
            if (operation.parked) {
              await assertMigrationAncestors(operation.ancestors);
              await removeMigrationTree(
                operation.parked,
                operation.before as MigrationTreeEvidence,
              );
            }
          journal = {
            ...journal,
            phase: "complete",
            operations: [],
            verified: [
              ...journal.verified,
              ...plan.items
                .filter((item) => item.state !== "blocked")
                .map((item) => ({ ...item, state: "verified" as const })),
            ],
          };
          await writeRegistryMigrationReceipt(snapshot, journal, options);
          return makeResult("migrate registry", section(plan, applied, receipts), {
            findings: plan.findings,
            exit: exitFor(plan, applied.length > 0),
          });
        },
        options,
      ),
    );
  } catch (error) {
    const failures =
      error instanceof SkillexError
        ? error.findings
        : [
            {
              code: "E_IO" as const,
              severity: "error" as const,
              message: error instanceof Error ? error.message : String(error),
              fix: "Inspect the affected paths and migration receipt, then rerun migrate to resume safely.",
            },
          ];
    return makeResult("migrate registry", plan ? section(plan, applied, receipts) : null, {
      findings: [...(plan?.findings ?? []), ...failures],
      exit:
        error instanceof SkillexError && error.exit === ExitCode.INTERRUPTED
          ? ExitCode.INTERRUPTED
          : started
            ? ExitCode.PARTIAL
            : error instanceof SkillexError
              ? error.exit
              : ExitCode.FAILURE,
    });
  }
}
