import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { valid } from "semver";
import {
  emptyData,
  entry,
  identity,
  matches,
  replaceOwnership,
  requireIdentity,
  validateData,
  within,
} from "./activation-ownership.js";
import {
  type ReceiptOptions,
  type ReceiptSnapshot,
  readActivationReceipt,
  readBoundReceipt,
  validateActivationStateLocation,
  writeActivationReceipt,
  writeBoundReceipt,
} from "./activation-state.js";
import type { ActivationData, EntryIdentity, OwnedNode } from "./activation-types.js";
import { aliasPaths } from "./aliases.js";
import { canonicalSkill, packInventory } from "./composition.js";
import { captureContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { type LockOptions, withLock } from "./lock.js";
import { isSkillName, isVersionComponent } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import {
  assertMigrationNode,
  captureMigrationNode,
  type MigrationNode,
  migrationAbsolute,
  readMigrationActivationState,
} from "./migration-activation-state.js";
import { verifyPack } from "./packs.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions } from "./selection.js";

export interface RootAdoptOptions extends RegistryOptions, LockOptions {
  readonly project?: string;
  /** Explicit OLD=NEW canonical identities; never inferred for broken or foreign entries. */
  readonly map?: readonly string[];
  /** Paired with replacePrefix: explicit pinned replacement authority, never inferred. */
  readonly replacePack?: string;
  readonly replacePrefix?: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly signal?: { readonly aborted: boolean };
}

export interface RootAdoptEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: MigrationNode["identity"]["kind"] | "absent";
  readonly raw?: string;
  readonly canonical?: string;
  readonly target?: string;
  readonly source?: string;
  /** Original resolution, absent for broken links, new pack members, or refused entries. */
  readonly resolved?: string;
  readonly action: "adopt" | "map" | "replace" | "retire" | "add" | "refuse";
  readonly reason?: string;
}

export interface RootReplacementPolicy {
  readonly pack: string;
  readonly prefix: string;
}
interface Replacement extends RootReplacementPolicy {
  readonly path: string;
  readonly names: readonly string[];
}

export interface RootAdoptResult {
  readonly project: string;
  readonly root: string;
  readonly dryRun: boolean;
  readonly inventory: readonly RootAdoptEntry[];
  readonly changes: readonly string[];
  readonly applied: boolean;
  readonly recovery: boolean;
  /** Durable authored-content archive location, including when a completed archive is missing. */
  readonly quarantine: string | null;
  readonly archiveStatus: "none" | "planned" | "pending" | "verified" | "missing";
  readonly receipt: string;
  readonly journal: string;
  readonly preservedStages: readonly string[];
  readonly replacement: RootReplacementPolicy | null;
}

interface Proof {
  readonly path: string;
  readonly node: MigrationNode;
}
interface Journal {
  readonly version: 1;
  readonly id: string;
  readonly phase: "preparing" | "prepared" | "complete";
  readonly registry: string;
  readonly projectIdentity: EntryIdentity;
  readonly agentsIdentity: EntryIdentity;
  readonly original: MigrationNode;
  readonly next?: MigrationNode;
  readonly inventory: readonly RootAdoptEntry[];
  readonly mappings: Readonly<Record<string, string>>;
  readonly replacement?: Replacement;
  readonly proofs: readonly Proof[];
  /** Unpublished stages without exact journal evidence are preserved, never adopted or removed. */
  readonly preservedStages: readonly string[];
}
interface Context {
  readonly options: RootAdoptOptions;
  readonly project: string;
  readonly root: string;
  readonly registry: string;
  readonly aliases: readonly string[];
  readonly receiptOptions: ReceiptOptions;
  readonly projectIdentity: EntryIdentity;
  readonly agentsIdentity: EntryIdentity;
  readonly mappings: Readonly<Record<string, string>>;
  readonly replacement?: RootReplacementPolicy;
}
interface Plan {
  readonly original: MigrationNode;
  readonly owner: ReceiptSnapshot<ActivationData>;
  readonly ownership: ActivationData;
  readonly inventory: RootAdoptEntry[];
  readonly proofs: Proof[];
  readonly findings: Diagnostic[];
  readonly replace: boolean;
  readonly replacement?: Replacement;
  readonly changes: string[];
}

const binding = { namespace: "migrations", targetParts: [".agents", "root-adoption"] } as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function refuse(path: string, message: string, code: Diagnostic["code"] = "E_ROOT_ADOPT"): never {
  fail(
    code,
    message,
    {
      path,
      fix: "Preserve the named content. Import foreign definitions first, then preview root adopt with explicit --map OLD=NEW choices. Pending cutovers must be retried with the same project and catalog.",
    },
    ExitCode.REFUSED,
  );
}
function check(options: RootAdoptOptions): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Root adoption was interrupted; retry the same project to recover.",
      {},
      ExitCode.INTERRUPTED,
    );
}
function errorFindings(error: unknown): readonly Diagnostic[] {
  return error instanceof SkillexError
    ? error.findings
    : [
        {
          code: "E_IO",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
}
function mappings(input: readonly string[] = []): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const value of input) {
    const parts = value.split("=");
    const old = parts[0];
    const name = parts[1];
    if (parts.length !== 2 || !isSkillName(old) || !isSkillName(name) || Object.hasOwn(result, old))
      refuse(
        value,
        "Each mapping must be one unique, safe OLD=NEW skill name pair.",
        "E_ROOT_MAPPING",
      );
    Object.defineProperty(result, old, { value: name, enumerable: true });
  }
  return result;
}

function replacementPolicy(
  options: Pick<RootAdoptOptions, "replacePack" | "replacePrefix">,
): RootReplacementPolicy | undefined {
  const { replacePack: pack, replacePrefix: prefix } = options;
  if (pack === undefined && prefix === undefined) return undefined;
  const parts = typeof pack === "string" ? pack.split("@") : [];
  const name = parts[0];
  const version = parts[1];
  if (
    parts.length !== 2 ||
    !isSkillName(name) ||
    name.length < 3 ||
    !isVersionComponent(version) ||
    !valid(version) ||
    prefix !== `${name}-`
  )
    refuse(
      String(pack ?? prefix ?? ""),
      "Replacement requires BOTH --replace-pack NAME@VERSION (an exact release) and --replace-prefix NAME-. The family must have at least three characters; empty, broad, unrelated, and wildcard prefixes are refused.",
      "E_ROOT_REPLACEMENT_POLICY",
    );
  return { pack: pack as string, prefix: prefix as string };
}
async function replacementFor(
  context: Context,
): Promise<{ policy: Replacement; proofs: Proof[] } | undefined> {
  const policy = context.replacement;
  if (!policy) return undefined;
  const [name, version] = policy.pack.split("@") as [string, string];
  const path = join(context.registry, "packs", name, version);
  const node = await captureMigrationNode(path);
  if (node?.identity.kind !== "directory" || !validNode(node))
    refuse(
      path,
      "Replacement requires an existing real, reference-only pinned pack.",
      "E_ROOT_REPLACEMENT_PACK",
    );
  const inventory = await packInventory(context.registry, { name, version, optional: false });
  if (
    inventory.path !== path ||
    !inventory.names.length ||
    new Set(inventory.names).size !== inventory.names.length ||
    inventory.names.some((member) => !member.startsWith(policy.prefix) || member === policy.prefix)
  )
    refuse(
      path,
      "Replacement pack membership must be nonempty, unique, and entirely inside the selected family prefix.",
      "E_ROOT_REPLACEMENT_PACK",
    );
  const proofs: Proof[] = [{ path, node }];
  for (const member of inventory.names) {
    const target = await canonicalSkill(context.registry, member);
    const captured = await captureMigrationNode(target);
    if (captured?.identity.kind !== "directory" || !validNode(captured))
      refuse(target, "Replacement member has unsupported canonical content.");
    proofs.push({ path: target, node: captured });
  }
  const verified = await verifyPack(policy.pack, {
    ...context.options,
    registryRoot: context.registry,
  });
  if (!verified.ok || !verified.data) throw new SkillexError(verified.exit, verified.findings);
  for (const proof of proofs) await assertMigrationNode(proof.path, proof.node);
  return { policy: { ...policy, path, names: [...inventory.names].sort() }, proofs };
}
async function verifyReplacementCandidate(
  path: string,
  name: string,
  node: MigrationNode,
): Promise<void> {
  if (node.identity.kind !== "directory" || node.children["SKILL.md"]?.identity.kind !== "file")
    refuse(
      path,
      "Replacement authority applies only to real skill directories with a real SKILL.md.",
      "E_ROOT_REPLACEMENT_IDENTITY",
    );
  const metadata = await readSkillMetadata(path);
  if (metadata.metadata.name !== name)
    refuse(
      path,
      "Replacement requires SKILL.md frontmatter name to exactly match its prefixed directory; a filename alone grants no retirement authority.",
      "E_ROOT_REPLACEMENT_IDENTITY",
    );
  await assertMigrationNode(path, node);
}

async function contextFor(options: RootAdoptOptions): Promise<Context> {
  check(options);
  if (options.dryRun && options.apply)
    fail("E_ROOT_MODE", "Choose --dry-run or --apply, not both.");
  if (!options.project) fail("E_PROJECT", "Root adoption requires an explicit --project PATH.");
  const replacement = replacementPolicy(options);
  const home = await realpath(resolve(options.home ?? homedir()));
  const cwd = options.cwd ?? process.cwd();
  const requested = migrationAbsolute(options.project, home, cwd);
  let project: string;
  try {
    project = await realpath(requested);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
    fail("E_PROJECT", "--project must resolve to an existing project directory.", {
      path: requested,
      fix: "Correct --project PATH to the existing project containing the .agents/skills root; no directory was created.",
    });
  }
  if (!(await entry(project))?.info.isDirectory())
    fail("E_PROJECT", "--project must name a directory, not a file.", {
      path: project,
      fix: "Pass the existing project directory containing .agents/skills.",
    });
  if (project === home || project === parse(project).root)
    refuse(project, "HOME and the filesystem root cannot be project adoption targets.");
  const registry = (await discoverRegistry({ ...options, home, cwd })).root;
  const root = join(project, ".agents", "skills");
  const globalRoots = [join(home, ".agents", "skills"), ...aliasPaths(home, "global")];
  const protectedRoots = [
    ...(project === registry
      ? ["all-skills", "sets", "packs"].map((name) => join(registry, name))
      : [registry]),
    join(home, ".agents"),
    ...globalRoots,
  ];
  for (const protectedRoot of protectedRoots) {
    let target = protectedRoot;
    try {
      target = await realpath(protectedRoot);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
    if (
      within(root, protectedRoot) ||
      within(protectedRoot, root) ||
      within(root, target) ||
      within(target, root)
    )
      refuse(root, "The project root overlaps a catalog source or global discovery root.");
  }
  const base = await entry(project);
  const agents = await entry(dirname(root));
  if (!base?.info.isDirectory() || !agents?.info.isDirectory())
    refuse(
      dirname(root),
      "Adoption requires a real project/.agents directory; symlink parents are refused.",
    );
  const aliases = aliasPaths(project, "project");
  const receiptOptions = {
    ...options,
    home,
    forbiddenRoots: [
      registry,
      project,
      join(home, ".agents"),
      ...globalRoots,
      ...aliases.map(dirname),
    ],
  };
  return {
    options,
    project,
    root,
    registry,
    aliases,
    receiptOptions,
    projectIdentity: identity(base),
    agentsIdentity: identity(agents),
    mappings: mappings(options.map),
    ...(replacement ? { replacement } : {}),
  };
}
async function guard(context: Context, journal?: Journal): Promise<void> {
  await requireIdentity(context.project, journal?.projectIdentity ?? context.projectIdentity);
  await requireIdentity(dirname(context.root), journal?.agentsIdentity ?? context.agentsIdentity);
}
function paths(snapshot: ReceiptSnapshot<Journal>, id: string) {
  const prefix = join(
    dirname(snapshot.path),
    `${basename(snapshot.path, ".json")}.root-cutover-${id}`,
  );
  return { archive: `${prefix}-old`, stage: `${prefix}-new` };
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validIdentity(value: unknown): value is EntryIdentity {
  return (
    record(value) &&
    value.kind === "directory" &&
    typeof value.dev === "string" &&
    /^\d+$/.test(value.dev) &&
    typeof value.ino === "string" &&
    /^\d+$/.test(value.ino) &&
    Object.keys(value).every((key) => ["kind", "dev", "ino"].includes(key))
  );
}
function validNode(value: unknown, depth = 0): value is MigrationNode {
  if (depth > 64 || !record(value) || !record(value.identity) || !record(value.children))
    return false;
  const i = value.identity;
  return (
    Object.keys(value).every((key) => ["identity", "hash", "children"].includes(key)) &&
    Object.keys(i).every((key) => ["kind", "dev", "ino", "mode", "raw"].includes(key)) &&
    ["directory", "link", "file"].includes(String(i.kind)) &&
    typeof i.dev === "string" &&
    /^\d+$/.test(i.dev) &&
    typeof i.ino === "string" &&
    /^\d+$/.test(i.ino) &&
    typeof i.mode === "number" &&
    Number.isInteger(i.mode) &&
    i.mode >= 0 &&
    i.mode <= 0o7777 &&
    (i.kind === "link"
      ? typeof i.raw === "string" && !!i.raw && !i.raw.includes("\0")
      : i.raw === undefined) &&
    (i.kind === "file"
      ? typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash)
      : value.hash === null) &&
    (i.kind === "directory" || !Object.keys(value.children).length) &&
    Object.entries(value.children).every(
      ([name, node]) =>
        !!name &&
        ![".", ".."].includes(name) &&
        !/[\0/\\]/.test(name) &&
        validNode(node, depth + 1),
    )
  );
}
function journalData(snapshot: ReceiptSnapshot<Journal>, context: Context): Journal | undefined {
  const raw: unknown = snapshot.document?.data;
  if (raw === undefined) return undefined;
  if (
    !record(raw) ||
    raw.version !== 1 ||
    typeof raw.id !== "string" ||
    !uuid.test(raw.id) ||
    !["preparing", "prepared", "complete"].includes(String(raw.phase)) ||
    raw.registry !== context.registry ||
    !validIdentity(raw.projectIdentity) ||
    !validIdentity(raw.agentsIdentity) ||
    !validNode(raw.original) ||
    raw.original.identity.kind !== "directory" ||
    (raw.phase === "preparing"
      ? raw.next !== undefined
      : !validNode(raw.next) || raw.next.identity.kind !== "directory") ||
    !record(raw.mappings) ||
    Object.entries(raw.mappings).some(([old, name]) => !isSkillName(old) || !isSkillName(name)) ||
    !Array.isArray(raw.inventory) ||
    !Array.isArray(raw.proofs) ||
    !Array.isArray(raw.preservedStages) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "version",
          "id",
          "phase",
          "registry",
          "projectIdentity",
          "agentsIdentity",
          "original",
          "next",
          "inventory",
          "mappings",
          "replacement",
          "proofs",
          "preservedStages",
        ].includes(key),
    )
  )
    refuse(snapshot.path, "The root cutover journal is malformed or bound to another catalog.");
  let replacement: Replacement | undefined;
  if (raw.replacement !== undefined) {
    const value = raw.replacement;
    if (
      !record(value) ||
      typeof value.pack !== "string" ||
      typeof value.prefix !== "string" ||
      Object.keys(value).some((key) => !["pack", "prefix", "path", "names"].includes(key))
    )
      refuse(snapshot.path, "The journal replacement policy is malformed.");
    replacementPolicy({ replacePack: value.pack, replacePrefix: value.prefix });
    const [name, version] = value.pack.split("@");
    if (
      value.path !== join(context.registry, "packs", name as string, version as string) ||
      !Array.isArray(value.names) ||
      !value.names.length ||
      new Set(value.names).size !== value.names.length ||
      value.names.some(
        (member) => !isSkillName(member) || !member.startsWith(value.prefix as string),
      )
    )
      refuse(snapshot.path, "The journal replacement pack has invalid paths or members.");
    replacement = value as unknown as Replacement;
  }
  if (
    context.replacement &&
    (!replacement ||
      context.replacement.pack !== replacement.pack ||
      context.replacement.prefix !== replacement.prefix)
  )
    refuse(
      snapshot.path,
      "Recorded replacement intent differs from the selected policy; no new intent can override a cutover journal.",
      "E_ROOT_REPLACEMENT_POLICY",
    );
  const outputs = new Set<string>();
  const inputs = new Set<string>();
  for (const item of raw.inventory) {
    if (
      !record(item) ||
      !isSkillName(item.name) ||
      item.path !== join(context.root, item.name) ||
      !["adopt", "map", "replace", "retire", "add"].includes(String(item.action)) ||
      (item.resolved !== undefined &&
        (typeof item.resolved !== "string" ||
          !item.resolved.startsWith("/") ||
          item.resolved.includes("\0"))) ||
      (item.source !== undefined && (item.source !== item.resolved || item.kind !== "link"))
    )
      refuse(snapshot.path, "The cutover inventory has invalid canonical paths.");
    const addition = item.action === "add";
    if (
      addition
        ? item.kind !== "absent" ||
          Object.hasOwn(raw.original.children, item.name) ||
          item.raw !== undefined ||
          item.resolved !== undefined
        : !["directory", "link"].includes(String(item.kind)) ||
          !Object.hasOwn(raw.original.children, item.name) ||
          raw.original.children[item.name]?.identity.kind !== item.kind ||
          raw.original.children[item.name]?.identity.raw !== item.raw ||
          inputs.has(item.name)
    )
      refuse(
        snapshot.path,
        "The cutover inventory does not match every original entry exactly once.",
      );
    if (!addition) inputs.add(item.name);
    if (["replace", "retire", "add"].includes(String(item.action))) {
      if (
        !replacement ||
        !item.name.startsWith(replacement.prefix) ||
        (!addition && item.kind !== "directory") ||
        item.source !== undefined ||
        (item.action === "retire"
          ? replacement.names.includes(item.name)
          : !replacement.names.includes(item.name)) ||
        (!addition &&
          raw.original.children[item.name]?.children["SKILL.md"]?.identity.kind !== "file")
      )
        refuse(
          snapshot.path,
          "A replacement/retirement/addition lacks its explicit pack and real-skill evidence.",
        );
    }
    if (item.action === "retire") {
      if (item.canonical !== undefined || item.target !== undefined)
        refuse(snapshot.path, "A retirement cannot publish a canonical link.");
    } else {
      if (
        !isSkillName(item.canonical) ||
        item.target !== join(context.registry, "all-skills", item.canonical) ||
        outputs.has(item.canonical) ||
        (["replace", "add"].includes(String(item.action)) && item.canonical !== item.name)
      )
        refuse(snapshot.path, "The cutover inventory has invalid or colliding canonical outputs.");
      outputs.add(item.canonical);
    }
  }
  if (
    inputs.size !== Object.keys(raw.original.children).length ||
    replacement?.names.some((name) => !outputs.has(name))
  )
    refuse(
      snapshot.path,
      "The journal does not account for every original entry and replacement pack member.",
    );
  for (const proof of raw.proofs) {
    if (
      !record(proof) ||
      typeof proof.path !== "string" ||
      !validNode(proof.node) ||
      proof.node.identity.kind !== "directory" ||
      !(
        replacement?.path === proof.path ||
        raw.inventory.some(
          (item) => record(item) && (item.target === proof.path || item.source === proof.path),
        )
      )
    )
      refuse(
        snapshot.path,
        "A cutover source proof is outside the selected canonical definitions.",
      );
  }
  if (replacement && !raw.proofs.some((proof) => record(proof) && proof.path === replacement?.path))
    refuse(snapshot.path, "The journal lacks its replacement pack's exact evidence.");
  for (const name of outputs)
    if (
      !raw.proofs.some(
        (proof) => record(proof) && proof.path === join(context.registry, "all-skills", name),
      )
    )
      refuse(snapshot.path, "The journal lacks a canonical definition proof for every output.");
  if (
    raw.next &&
    (!validNode(raw.next) ||
      Object.keys(raw.next.children).length !== outputs.size ||
      Object.entries(raw.next.children).some(
        ([name, child]) =>
          !outputs.has(name) ||
          child.identity.kind !== "link" ||
          child.identity.raw !== join(context.registry, "all-skills", name),
      ))
  )
    refuse(snapshot.path, "The staged root does not match its canonical inventory.");
  for (const stage of raw.preservedStages) {
    const prefix = `${basename(snapshot.path, ".json")}.root-cutover-`;
    if (
      typeof stage !== "string" ||
      dirname(stage) !== dirname(snapshot.path) ||
      !basename(stage).startsWith(prefix) ||
      !uuid.test(basename(stage).slice(prefix.length, -4)) ||
      !stage.endsWith("-new")
    )
      refuse(snapshot.path, "A preserved stage has an invalid quarantine path.");
  }
  const data = raw as unknown as Journal;
  if (Object.keys(context.mappings).length && !isDeepStrictEqual(context.mappings, data.mappings))
    refuse(
      snapshot.path,
      "Recorded cutover intent differs from --map. Retry without new mappings or with the original choices.",
      "E_ROOT_MAPPING",
    );
  return data;
}
async function ownerFor(context: Context, allowed?: readonly MigrationNode[]) {
  const snapshot = await readActivationReceipt<ActivationData>(
    context.project,
    context.receiptOptions,
  );
  const data = snapshot.document
    ? validateData(snapshot.document.data, context.root, context.aliases, snapshot.path)
    : emptyData();
  if (data.pending)
    refuse(
      snapshot.path,
      "Ordinary activation recovery is pending; root adoption cannot replace that operation.",
    );
  const migration = await readMigrationActivationState(
    context.project,
    context.root,
    context.aliases,
    false,
    context.receiptOptions,
  );
  if (migration.data.pending)
    refuse(
      migration.snapshot.path,
      "An activation migration is pending; recover it before root adoption.",
    );
  for (const [path, expected] of [
    ...Object.entries(data.links),
    ...Object.entries(data.directories),
  ]) {
    if (allowed && (path === context.root || dirname(path) === context.root)) {
      const candidates = allowed.map((node) =>
        path === context.root ? node : node.children[basename(path)],
      );
      if (
        !candidates.some(
          (node) =>
            node &&
            ["link", "directory"].includes(node.identity.kind) &&
            isDeepStrictEqual(nodeIdentity(node), expected),
        )
      )
        refuse(path, "Activation ownership differs from both recorded cutover roots.");
    } else
      await requireIdentity(
        path,
        expected,
        path !== context.root && dirname(path) !== context.root,
      );
  }
  return { snapshot, data };
}
function nodeIdentity(node: MigrationNode): EntryIdentity {
  const i = node.identity;
  if (i.kind !== "directory" && i.kind !== "link")
    refuse("", "Only verified link-only roots can be adopted.");
  return {
    kind: i.kind,
    dev: i.dev,
    ino: i.ino,
    ...(i.kind === "link" ? { raw: i.raw as string } : {}),
  };
}
function owned(node: MigrationNode): OwnedNode {
  const i = node.identity;
  return {
    identity: nodeIdentity(node),
    ...(i.kind === "directory"
      ? {
          children: Object.fromEntries(
            Object.entries(node.children).map(([name, child]) => [name, owned(child).identity]),
          ),
        }
      : {}),
  };
}
async function sameContent(source: string, target: string): Promise<boolean> {
  const before = await captureContent(source);
  const after = await captureContent(target);
  const authored = (entries: typeof before.entries) =>
    entries.map((item) =>
      item.kind === "link"
        ? { path: item.path, kind: item.kind, raw: item.originalTarget, target: item.target }
        : item,
    );
  return (
    !before.excluded.length &&
    !after.excluded.length &&
    isDeepStrictEqual(authored(before.entries), authored(after.entries))
  );
}
async function prepare(context: Context): Promise<Plan> {
  await guard(context);
  const original = await captureMigrationNode(context.root);
  if (original?.identity.kind !== "directory" || !validNode(original))
    refuse(
      context.root,
      "This bounded command adopts existing real roots only; absent, aliased, or special roots are preserved.",
    );
  if (original.identity.dev !== context.agentsIdentity.dev)
    refuse(
      context.root,
      "A separately mounted skill root cannot be parked with an atomic directory rename.",
    );
  const owner = await ownerFor(context);
  const inventory: RootAdoptEntry[] = [];
  const findings: Diagnostic[] = [];
  const replacement = await replacementFor(context);
  const proofs: Proof[] = replacement ? [...replacement.proofs] : [];
  const members = new Set(replacement?.policy.names ?? []);
  const outputs = new Set<string>();
  let replace = false;
  for (const [name, node] of Object.entries(original.children)) {
    const path = join(context.root, name);
    const base = {
      name,
      path,
      kind: node.identity.kind,
      ...(node.identity.raw ? { raw: node.identity.raw } : {}),
    };
    try {
      check(context.options);
      if (!isSkillName(name))
        refuse(path, "Non-skill entries cannot be adopted or silently removed from discovery.");
      const explicit = Object.hasOwn(context.mappings, name);
      const selectedForReplacement =
        !!replacement &&
        node.identity.kind === "directory" &&
        name.startsWith(replacement.policy.prefix);
      if (selectedForReplacement && explicit)
        refuse(
          path,
          "A replacement-class real skill cannot also have --map intent; remove the overlapping choice.",
          "E_ROOT_REPLACEMENT_POLICY",
        );
      if (selectedForReplacement) {
        await verifyReplacementCandidate(path, name, node);
        if (!members.has(name)) {
          replace = true;
          inventory.push({
            ...base,
            resolved: path,
            action: "retire",
            reason: `Verified real ${replacement.policy.prefix} skill is absent from ${replacement.policy.pack}; retain its complete original tree in quarantine only.`,
          });
          continue;
        }
      }
      const canonical = explicit ? (context.mappings[name] as string) : name;
      if (outputs.has(canonical))
        refuse(
          path,
          `Multiple entries would become ${canonical}; collision resolution must be explicit.`,
          "E_ROOT_MAPPING",
        );
      if (
        !selectedForReplacement &&
        node.identity.kind !== "link" &&
        (!explicit || node.identity.kind !== "directory")
      )
        refuse(
          path,
          "Foreign real content requires an explicit mapping to an imported, byte-equivalent canonical definition.",
        );
      let source: string | undefined;
      try {
        source = await realpath(path);
      } catch (error) {
        if (
          node.identity.kind !== "link" ||
          !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
        )
          throw error;
        if (!explicit)
          refuse(
            path,
            "Broken skill links require an explicit --map OLD=NEW; no rename is guessed.",
            "E_ROOT_MAPPING_REQUIRED",
          );
      }
      const target = await canonicalSkill(context.registry, canonical);
      const proof = await captureMigrationNode(target);
      if (proof?.identity.kind !== "directory" || !validNode(proof))
        refuse(target, "Canonical content changed or contains unsupported special/deep entries.");
      let sourceProof: Proof | undefined;
      if (source && source !== target && !selectedForReplacement) {
        if (!explicit)
          refuse(
            path,
            "A foreign link requires an explicit content-verified canonical mapping.",
            "E_ROOT_MAPPING_REQUIRED",
          );
        if (node.identity.kind === "link") {
          if (within(source, context.root) || within(context.root, source))
            refuse(
              path,
              "Foreign forwarding links into or above this root require a separate relocation before adoption.",
            );
          const observed = await captureMigrationNode(source);
          if (observed?.identity.kind !== "directory" || !validNode(observed))
            refuse(source, "A mapped definition must be a real supported skill directory.");
          sourceProof = { path: source, node: observed };
        }
        if (!(await sameContent(source, target)))
          refuse(
            path,
            "The mapped content is not byte-equivalent to its canonical definition.",
            "E_ROOT_CONTENT_MISMATCH",
          );
        await assertMigrationNode(target, proof);
        if (sourceProof) await assertMigrationNode(sourceProof.path, sourceProof.node);
      }
      const mapped = canonical !== name || node.identity.kind !== "link" || source !== target;
      replace ||= mapped;
      outputs.add(canonical);
      proofs.push({ path: target, node: proof });
      if (sourceProof) proofs.push(sourceProof);
      inventory.push({
        ...base,
        canonical,
        target,
        ...(source ? { resolved: source } : {}),
        ...(sourceProof ? { source: sourceProof.path } : {}),
        action: selectedForReplacement ? "replace" : mapped ? "map" : "adopt",
        ...(selectedForReplacement
          ? {
              reason: `Explicit ${replacement.policy.pack} replacement; authored differences are retained in the quarantined original, not discarded.`,
            }
          : {}),
      });
    } catch (error) {
      if (context.options.signal?.aborted) throw error;
      inventory.push({ ...base, action: "refuse" });
      findings.push(...errorFindings(error));
    }
  }
  for (const name of members) {
    if (Object.hasOwn(original.children, name)) {
      if (
        !outputs.has(name) &&
        !inventory.some((item) => item.name === name && item.action === "refuse")
      )
        findings.push({
          code: "E_ROOT_REPLACEMENT_COLLISION",
          severity: "error",
          path: join(context.root, name),
          message: `The original ${name} does not retain this required replacement-pack identity.`,
        });
      continue;
    }
    if (outputs.has(name)) {
      findings.push({
        code: "E_ROOT_REPLACEMENT_COLLISION",
        severity: "error",
        path: join(context.root, name),
        message: `A mapping already occupies new pack member ${name}; explicit addition cannot silently merge identities.`,
      });
      continue;
    }
    try {
      const target = await canonicalSkill(context.registry, name);
      const node = await captureMigrationNode(target);
      if (node?.identity.kind !== "directory" || !validNode(node))
        refuse(target, "Replacement member has unsupported canonical content.");
      proofs.push({ path: target, node });
      inventory.push({
        name,
        path: join(context.root, name),
        kind: "absent",
        canonical: name,
        target,
        action: "add",
        reason: `Missing member explicitly supplied by ${replacement?.policy.pack}.`,
      });
      outputs.add(name);
      replace = true;
    } catch (error) {
      inventory.push({ name, path: join(context.root, name), kind: "absent", action: "refuse" });
      findings.push(...errorFindings(error));
    }
  }
  for (const old of Object.keys(context.mappings))
    if (!Object.hasOwn(original.children, old))
      findings.push({
        code: "E_ROOT_MAPPING",
        severity: "error",
        path: context.root,
        message: `Mapping source ${old} is absent; a stale mapping cannot authorize a rename.`,
      });
  await assertMigrationNode(context.root, original);
  if (!findings.length) await assertInputs(context.root, inventory);
  await guard(context);
  const complete =
    !findings.length &&
    !replace &&
    isDeepStrictEqual(replaceOwnership(owner.data, context.root, owned(original)), owner.data);
  return {
    original,
    owner: owner.snapshot,
    ownership: owner.data,
    inventory,
    proofs,
    findings,
    replace,
    ...(replacement ? { replacement: replacement.policy } : {}),
    changes: complete
      ? []
      : [...(replace ? ["quarantine-original-root", "publish-canonical-links"] : []), "adopt-root"],
  };
}
async function validateQuarantine(
  context: Context,
  snapshot: ReceiptSnapshot<Journal>,
  id: string,
): Promise<void> {
  const { archive, stage } = paths(snapshot, id);
  for (const path of [archive, stage])
    if (await entry(path)) refuse(path, "A foreign object occupies a new quarantine path.");
  let parent = dirname(snapshot.path);
  while (!(await entry(parent))) parent = dirname(parent);
  const info = await entry(parent);
  if (!info?.info.isDirectory() || String(info.info.dev) !== context.agentsIdentity.dev)
    refuse(
      parent,
      "Quarantine and project must be on the same filesystem for inode-preserving cutover; no copy/delete fallback is supported.",
    );
}
async function flush(path: string): Promise<void> {
  const before = await entry(path);
  if (!before?.info.isDirectory()) refuse(path, "A cutover parent is no longer a real directory.");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!matches({ path, info: await handle.stat({ bigint: true }) }, identity(before)))
      refuse(path, "A cutover parent changed before fsync.");
    await handle.sync();
    await requireIdentity(path, identity(before));
  } finally {
    await handle.close();
  }
}
async function evidence(context: Context, snapshot: ReceiptSnapshot<Journal>, data: Journal) {
  await guard(context, data);
  const locations = paths(snapshot, data.id);
  const root = await captureMigrationNode(context.root);
  const archiveNode = await captureMigrationNode(locations.archive);
  const stageNode = await captureMigrationNode(locations.stage);
  if (data.phase === "preparing") {
    if (!isDeepStrictEqual(root, data.original) || archiveNode)
      refuse(context.root, "An unprepared cutover changed; preserve all recovery objects.");
  } else {
    const original =
      isDeepStrictEqual(root, data.original) &&
      !archiveNode &&
      isDeepStrictEqual(stageNode, data.next);
    const parked =
      !root &&
      isDeepStrictEqual(archiveNode, data.original) &&
      isDeepStrictEqual(stageNode, data.next);
    const published =
      isDeepStrictEqual(root, data.next) &&
      isDeepStrictEqual(archiveNode, data.original) &&
      !stageNode;
    if (!(original || parked || published) || (data.phase === "complete" && !published))
      refuse(
        context.root,
        "Cutover recovery objects changed or are ambiguous; nothing was overwritten.",
        "E_ROOT_RECOVERY",
      );
  }
  return { ...locations, root, archiveNode, stageNode };
}
async function completedOwnership(
  context: Context,
  snapshot: ReceiptSnapshot<Journal>,
  data: Journal,
) {
  if (data.phase !== "complete") return undefined;
  await guard(context, data);
  const locations = paths(snapshot, data.id);
  if (await entry(locations.stage))
    refuse(locations.stage, "A stage appeared after completed adoption.");
  // Ordinary sync may legitimately replace the adopted root later. Its exact receipt
  // is authority for that newer root; a completed cutover must never replay old intent.
  const owner = await ownerFor(context);
  if (!owner.snapshot.document)
    fail(
      "E_ROOT_RECEIPT_MISSING",
      "Adoption completed, but the activation ownership receipt is missing. The journal alone cannot authorize ownership or replay.",
      {
        path: owner.snapshot.path,
        detail: [
          `Cutover journal: ${snapshot.path}`,
          `Durable original archive: ${locations.archive}`,
        ],
        fix: "Restore the matching activation receipt from backup at this path and retry. Preserve the journal, archive, and current root; do not delete the journal or replay old adoption intent to bypass lost ownership.",
      },
      ExitCode.REFUSED,
    );
  const root = await captureMigrationNode(context.root);
  if (!root || !["directory", "link"].includes(root.identity.kind))
    refuse(context.root, "The completed root is absent or no longer a managed root.");
  if (
    root.identity.kind === "directory" &&
    Object.values(root.children).some((node) => node.identity.kind !== "link")
  )
    refuse(
      context.root,
      "New real content appeared after adoption; it remains unowned and unchanged.",
    );
  if (!isDeepStrictEqual(replaceOwnership(owner.data, context.root, owned(root)), owner.data))
    refuse(
      context.root,
      "New unowned entries appeared after completed adoption; old intent will not be replayed.",
    );
  const findings: Diagnostic[] = [];
  if (!isDeepStrictEqual(root, data.next))
    findings.push({
      code: "I_ROOT_ADOPT_SUPERSEDED",
      severity: "info",
      message:
        "Adoption is complete; a later receipt-owned activation supersedes its root. Saved adoption intent was not replayed.",
    });
  const archive = await captureMigrationNode(locations.archive);
  if (archive && !isDeepStrictEqual(archive, data.original))
    fail(
      "E_ROOT_ARCHIVE_CHANGED",
      "The completed adoption's existing original archive differs from its recorded inode/content evidence; it was not overwritten or declared preserved.",
      {
        path: locations.archive,
        detail: [`Cutover journal: ${snapshot.path}`],
        fix: "Preserve and inspect this archive against the journal before retrying. Restore the exact recorded object if it was moved; retain the journal and do not delete or replace authored content to silence this finding.",
      },
      ExitCode.REFUSED,
    );
  if (!archive)
    findings.push({
      code: "W_ROOT_ARCHIVE_MISSING",
      severity: "warning",
      path: locations.archive,
      message:
        "Adoption is complete and current activation ownership is verified, but the durable original archive is missing at its recorded location. No preservation claim is made; this no-op neither recreates it nor replays adoption.",
      fix: "Locate the moved original or recover authored content from backup. Keep this journal and receipt, back up the recovered archive, and restore its recorded location when possible. Quarantine contains authored originals, not disposable state; no deletion is authorized.",
    });
  return { owner, archiveStatus: archive ? ("verified" as const) : ("missing" as const), findings };
}
async function assertInputs(root: string, inventory: readonly RootAdoptEntry[]): Promise<void> {
  for (const item of inventory) {
    let resolved: string | undefined;
    try {
      resolved = await realpath(join(root, item.name));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (item.action === "add" && (await entry(join(root, item.name))))
      refuse(
        item.path,
        "An entry appeared at a planned pack addition; nothing may overwrite it.",
        "E_ROOT_INPUT_CHANGED",
      );
    if (resolved !== item.resolved)
      refuse(
        item.path,
        "A source link's resolution changed after inventory; retry a fresh preview.",
        "E_ROOT_INPUT_CHANGED",
      );
  }
}
function validateStage(
  path: string,
  node: MigrationNode,
  inventory: readonly RootAdoptEntry[],
): void {
  const outputs = inventory.filter((item) => item.action !== "retire");
  if (
    node.identity.kind !== "directory" ||
    Object.keys(node.children).length !== outputs.length ||
    outputs.some((item) => {
      const child = node.children[item.canonical as string];
      return child?.identity.kind !== "link" || child.identity.raw !== item.target;
    })
  )
    refuse(
      path,
      "The staged root contains changed or unplanned entries; the original root remains preserved.",
      "E_ROOT_RECOVERY",
    );
}
async function commit(
  context: Context,
  snapshot: ReceiptSnapshot<Journal>,
  data: Journal,
): Promise<ReceiptSnapshot<Journal>> {
  const current = await evidence(context, snapshot, data);
  const next = data.next;
  if (!next) refuse(snapshot.path, "The cutover has no verified staged root.");
  validateStage(current.stage, next, data.inventory);
  const owner = await ownerFor(context, [data.original, next]);
  check(context.options);
  for (const proof of data.proofs) await assertMigrationNode(proof.path, proof.node);
  await guard(context, data);
  await validateActivationStateLocation(context.project, context.receiptOptions);
  if (isDeepStrictEqual(current.root, data.original)) {
    await assertInputs(context.root, data.inventory);
    await assertMigrationNode(context.root, data.original);
    if (await entry(current.archive))
      refuse(current.archive, "Quarantine appeared before publication.");
    await rename(context.root, current.archive);
    await flush(dirname(context.root));
    await flush(dirname(current.archive));
  }
  if (!isDeepStrictEqual(current.root, next)) {
    check(context.options);
    await guard(context, data);
    if (await entry(context.root))
      refuse(context.root, "An entry appeared before publishing the staged root.");
    await assertMigrationNode(current.archive, data.original);
    await assertMigrationNode(current.stage, next);
    await rename(current.stage, context.root);
    await flush(dirname(context.root));
    await flush(dirname(current.stage));
  }
  await guard(context, data);
  await assertMigrationNode(context.root, next);
  const adopted = replaceOwnership(owner.data, context.root, owned(next));
  if (!isDeepStrictEqual(adopted, owner.data))
    await writeActivationReceipt(owner.snapshot, adopted);
  return writeBoundReceipt(snapshot, { ...data, phase: "complete" });
}

/** Project-only adoption. No selection resolver, manifest writer, alias writer, or registry migration runs. */
export async function adoptRoot(
  options: RootAdoptOptions = {},
): Promise<ResultEnvelope<RootAdoptResult | null>> {
  let result: RootAdoptResult | null = null;
  let started = false;
  let findings: readonly Diagnostic[] = [];
  try {
    const context = await contextFor(options);
    let snapshot = await readBoundReceipt<Journal>(
      context.project,
      binding,
      context.receiptOptions,
    );
    let saved = journalData(snapshot, context);
    const describe = (
      inventory: readonly RootAdoptEntry[],
      changes: readonly string[],
      quarantine: string | null,
      recovery: boolean,
      stages: readonly string[] = [],
    ): RootAdoptResult => ({
      project: context.project,
      root: context.root,
      dryRun: !options.apply,
      inventory,
      changes,
      applied: false,
      recovery,
      quarantine,
      archiveStatus: quarantine
        ? "pending"
        : changes.includes("quarantine-original-root")
          ? "planned"
          : "none",
      receipt: "",
      journal: snapshot.path,
      preservedStages: stages,
      replacement: saved?.replacement
        ? { pack: saved.replacement.pack, prefix: saved.replacement.prefix }
        : (context.replacement ?? null),
    });
    let plan: Plan | undefined;
    if (saved) {
      const completed = await completedOwnership(context, snapshot, saved);
      if (completed) {
        result = {
          ...describe(
            saved.inventory,
            [],
            paths(snapshot, saved.id).archive,
            false,
            saved.preservedStages,
          ),
          receipt: completed.owner.snapshot.path,
          archiveStatus: completed.archiveStatus,
        };
        return makeResult("root adopt", result, { findings: completed.findings });
      }
      await evidence(context, snapshot, saved);
      const owner = await ownerFor(context, [saved.original, ...(saved.next ? [saved.next] : [])]);
      result = {
        ...describe(
          saved.inventory,
          ["recover-root-adoption"],
          paths(snapshot, saved.id).archive,
          true,
          saved.preservedStages,
        ),
        receipt: owner.snapshot.path,
      };
      if (saved.phase !== "preparing") {
        for (const proof of saved.proofs) await assertMigrationNode(proof.path, proof.node);
      } else {
        for (const proof of saved.proofs) await assertMigrationNode(proof.path, proof.node);
        plan = await prepare({
          ...context,
          mappings: saved.mappings,
          ...(saved.replacement ? { replacement: saved.replacement } : {}),
        });
        if (plan.findings.length)
          return makeResult("root adopt", result, {
            exit: ExitCode.REFUSED,
            findings: plan.findings,
          });
        await validateQuarantine(context, snapshot, randomUUID());
      }
    } else {
      plan = await prepare(context);
      result = { ...describe(plan.inventory, plan.changes, null, false), receipt: plan.owner.path };
      if (plan.findings.length)
        return makeResult("root adopt", result, {
          exit: ExitCode.REFUSED,
          findings: plan.findings,
        });
      if (plan.replace) await validateQuarantine(context, snapshot, randomUUID());
    }
    if (!options.apply || !result.changes.length) return makeResult("root adopt", result);
    await withLock(
      "skillex:activation:v2",
      async () => {
        check(options);
        await guard(context);
        snapshot = await readBoundReceipt<Journal>(
          context.project,
          binding,
          context.receiptOptions,
        );
        saved = journalData(snapshot, context);
        let preservedStages: readonly string[] = [];
        if (saved) {
          const completed = await completedOwnership(context, snapshot, saved);
          if (completed) {
            result = {
              ...describe(
                saved.inventory,
                [],
                paths(snapshot, saved.id).archive,
                false,
                saved.preservedStages,
              ),
              receipt: completed.owner.snapshot.path,
              archiveStatus: completed.archiveStatus,
            };
            findings = completed.findings;
            return;
          }
          const observed = await evidence(context, snapshot, saved);
          if (saved.phase !== "preparing") {
            const owner = await ownerFor(context, [saved.original, saved.next as MigrationNode]);
            for (const proof of saved.proofs) await assertMigrationNode(proof.path, proof.node);
            started = true;
            snapshot = await commit(context, snapshot, saved);
            result = {
              ...describe(
                saved.inventory,
                ["recover-root-adoption"],
                observed.archive,
                true,
                saved.preservedStages,
              ),
              receipt: owner.snapshot.path,
              archiveStatus: "verified",
              applied: true,
            };
            return;
          }
          for (const proof of saved.proofs) await assertMigrationNode(proof.path, proof.node);
          preservedStages = [
            ...saved.preservedStages,
            ...(observed.stageNode ? [observed.stage] : []),
          ];
        }
        const selected = saved
          ? {
              ...context,
              mappings: saved.mappings,
              ...(saved.replacement ? { replacement: saved.replacement } : {}),
            }
          : context;
        plan = await prepare(selected);
        if (plan.findings.length) throw new SkillexError(ExitCode.REFUSED, plan.findings);
        await guard(context);
        for (const proof of plan.proofs) await assertMigrationNode(proof.path, proof.node);
        await assertMigrationNode(context.root, plan.original);
        await assertInputs(context.root, plan.inventory);
        check(options);
        if (!plan.replace) {
          const adopted = replaceOwnership(plan.ownership, context.root, owned(plan.original));
          if (!isDeepStrictEqual(adopted, plan.ownership)) {
            started = true;
            await writeActivationReceipt(plan.owner, adopted);
          }
          result = {
            ...describe(plan.inventory, plan.changes, null, false),
            receipt: plan.owner.path,
            applied: started,
          };
          return;
        }
        const id = randomUUID();
        await validateQuarantine(context, snapshot, id);
        const data: Journal = {
          version: 1,
          id,
          phase: "preparing",
          registry: context.registry,
          projectIdentity: context.projectIdentity,
          agentsIdentity: context.agentsIdentity,
          original: plan.original,
          inventory: plan.inventory,
          mappings: selected.mappings,
          ...(plan.replacement ? { replacement: plan.replacement } : {}),
          proofs: plan.proofs,
          preservedStages,
        };
        started = true;
        snapshot = await writeBoundReceipt(snapshot, data);
        const { archive, stage } = paths(snapshot, id);
        result = {
          ...describe(plan.inventory, plan.changes, archive, false, preservedStages),
          receipt: plan.owner.path,
        };
        await guard(context);
        const stateParent = await entry(dirname(stage));
        if (!stateParent?.info.isDirectory())
          refuse(dirname(stage), "The quarantine parent disappeared.");
        await mkdir(stage, { mode: plan.original.identity.mode });
        const staging = await entry(stage);
        if (!staging?.info.isDirectory())
          refuse(stage, "The staging directory changed after creation.");
        for (const item of plan.inventory) {
          if (item.action === "retire") continue;
          check(options);
          await requireIdentity(dirname(stage), identity(stateParent));
          await requireIdentity(stage, identity(staging));
          await symlink(item.target as string, join(stage, item.canonical as string));
        }
        await requireIdentity(dirname(stage), identity(stateParent));
        await requireIdentity(stage, identity(staging));
        await flush(stage);
        await flush(dirname(stage));
        const next = await captureMigrationNode(stage);
        if (!next) refuse(stage, "The staged root disappeared before journaling.");
        validateStage(stage, next, plan.inventory);
        const prepared: Journal = { ...data, phase: "prepared", next };
        snapshot = await writeBoundReceipt(snapshot, prepared);
        await commit(context, snapshot, prepared);
        result = { ...result, archiveStatus: "verified", applied: true };
      },
      context.receiptOptions,
    );
    return makeResult("root adopt", result, { findings });
  } catch (error) {
    return makeResult("root adopt", result, {
      exit: options.signal?.aborted
        ? ExitCode.INTERRUPTED
        : started
          ? ExitCode.PARTIAL
          : error instanceof SkillexError
            ? error.exit
            : ExitCode.FAILURE,
      findings: [
        ...errorFindings(error),
        ...(started
          ? [
              {
                code: "W_ROOT_RECOVERY" as const,
                severity: "warning" as const,
                message:
                  "Cutover writes began. The original root and exact journal evidence are preserved; retry root adopt for this project. Unverified stages are never deleted.",
              },
            ]
          : []),
      ],
    });
  }
}
