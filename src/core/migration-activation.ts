import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  entry,
  identity,
  lexicalTarget,
  matches,
  requireIdentity,
  validateData,
  within,
} from "./activation-ownership.js";
import {
  type ReceiptOptions,
  type ReceiptSnapshot,
  readActivationReceipt,
  writeActivationReceipt,
} from "./activation-state.js";
import type { ActivationData, EntryIdentity } from "./activation-types.js";
import { aliasPaths } from "./aliases.js";
import { canonicalSkill } from "./composition.js";
import { type ContentEntry, captureContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { withLock } from "./lock.js";
import { isSkillName } from "./manifest.js";
import {
  assertMigrationNode,
  assertMigrationRemainder,
  captureMigrationNode,
  type MigrationActivationState,
  type MigrationNode,
  type MigrationPending,
  migrationAbsolute,
  migrationDigest,
  migrationRefusal,
  readLegacyJson,
  readMigrationActivationState,
  removeMigrationNode,
  writeMigrationActivationState,
} from "./migration-activation-state.js";
import type { MigrationItem, MigrationOptions, MigrationSectionResult } from "./migration-types.js";
import {
  assertProfileIdentity,
  discoverProfile,
  normalizeProfileOptions,
} from "./profile-discovery.js";
import { type ProfileState, readProfileState, writeProfileState } from "./profile-state.js";
import type { ProfileLocation } from "./profile-types.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { ScopeName } from "./selection.js";

interface Target {
  readonly base: string;
  readonly root: string;
  readonly scope: ScopeName;
  readonly registry: string | null;
  readonly aliases: readonly string[];
  readonly profile?: ProfileLocation;
  readonly project?: string;
  readonly options: MigrationOptions;
  readonly receiptOptions: ReceiptOptions;
  readonly baseIdentity: EntryIdentity;
  readonly parents: Map<string, EntryIdentity | null>;
}
type Owner =
  | {
      readonly kind: "scope";
      readonly snapshot: ReceiptSnapshot<ActivationData>;
      readonly data: ActivationData;
    }
  | { readonly kind: "profile"; readonly state: ProfileState };
interface Operation {
  readonly item: MigrationItem;
  readonly previous?: MigrationNode;
  readonly target?: string;
  readonly children?: Readonly<Record<string, string>>;
  readonly claimRoot: boolean;
  readonly claimNames: readonly string[];
  readonly adopt?: boolean;
  readonly proofs: readonly { path: string; node: MigrationNode }[];
}
interface Prepared {
  readonly target: Target;
  readonly items: MigrationItem[];
  readonly operations: Operation[];
  readonly findings: Diagnostic[];
  readonly owner: Owner;
  readonly state: MigrationActivationState;
}
interface Legacy {
  readonly files: readonly { path: string; node: MigrationNode }[];
  readonly entries: ReadonlyMap<string, string>;
  readonly ambiguous: ReadonlySet<string>;
  readonly aliasTarget: string | null;
}

function check(options: MigrationOptions): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Activation migration was interrupted.",
      {
        fix: "Apply migration again to verify retained evidence and resume the selected target.",
      },
      ExitCode.INTERRUPTED,
    );
}
function failure(error: unknown): SkillexError {
  return error instanceof SkillexError
    ? error
    : new SkillexError(ExitCode.FAILURE, [
        {
          code: "E_IO",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          fix: "Inspect the selected migration paths and retry after correcting the filesystem error.",
        },
      ]);
}
function item(
  target: Target,
  action: string,
  path: string,
  state: MigrationItem["state"],
  details: readonly string[],
  destination?: string,
): MigrationItem {
  return {
    id: `${target.profile ? "profile" : target.scope}:${action}:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
    area: target.profile ? "profile" : "activation",
    action,
    path,
    state,
    details,
    dependsOn: [],
    ...(destination ? { target: destination } : {}),
  };
}
function issue(path: string, message: string): Diagnostic {
  return {
    code: "E_MIGRATION_ACTIVATION",
    severity: "error",
    path,
    message,
    fix: "Supply an explicit, content-verified mapping or relocate the named local content while preserving its active path, then preview migration again.",
  };
}
function blocked(plan: Prepared, action: string, path: string, message: string): void {
  plan.items.push(item(plan.target, action, path, "blocked", [message]));
  plan.findings.push(issue(path, message));
}
function ownEntry(node: MigrationNode): EntryIdentity {
  if (node.identity.kind !== "directory" && node.identity.kind !== "link")
    migrationRefusal("", "Only real containers and exact links may gain Node ownership.");
  return {
    kind: node.identity.kind,
    dev: node.identity.dev,
    ino: node.identity.ino,
    ...(node.identity.kind === "link" ? { raw: node.identity.raw as string } : {}),
  };
}
function existingClaim(owner: Owner, target: Target, path: string): EntryIdentity | undefined {
  if (owner.kind === "scope") {
    const source = path === target.root ? owner.data.directories : owner.data.links;
    return Object.hasOwn(source, path)
      ? source[path]
      : Object.hasOwn(owner.data.links, path)
        ? owner.data.links[path]
        : undefined;
  }
  if (path === target.root) return owner.state.data.root ?? undefined;
  const name = relative(target.root, path);
  return Object.hasOwn(owner.state.data.links, name) ? owner.state.data.links[name] : undefined;
}
async function targetFor(input: MigrationOptions, recoveryOnly = false): Promise<Target | null> {
  if (!input.scope && !input.project && !input.profile) return null;
  const options = { ...input, ...normalizeProfileOptions(input) };
  if (options.scope && !["global", "project"].includes(options.scope))
    fail("E_SCOPE", "Migration accepts only explicit global or project scope.");
  if (options.scope === "global" && options.project && !options.profile)
    fail("E_SCOPE", "Choose global scope or an explicit project, not both.");
  if ((options.scope === "project" || options.profile) && !options.project)
    fail("E_PROJECT", "Project and profile migration require --project PATH.");
  // Recovery consumes recorded objects only. A currently unavailable catalog must
  // not strand a parked activation root, but explicit source locations remain
  // forbidden state destinations before any lock or receipt write.
  const registry = recoveryOnly ? null : (await discoverRegistry(options)).root;
  const sourceInput = options.registryRoot ?? (options.env ?? process.env).PJ_SKILLS_REGISTRY_ROOT;
  const sourceRoots = registry
    ? [registry]
    : sourceInput
      ? [migrationAbsolute(sourceInput, options.home, options.cwd)]
      : [];
  const project = options.project
    ? await realpath(migrationAbsolute(options.project, options.home, options.cwd))
    : undefined;
  if (project && (project === (await realpath(options.home)) || project === parse(project).root))
    fail("E_PROJECT_ROOT", "HOME and the filesystem root cannot be project migration targets.");
  const profile = options.profile ? await discoverProfile(options.profile, options) : undefined;
  const base = profile?.root ?? (project || (await realpath(options.home)));
  const current = await entry(base);
  if (!current?.info.isDirectory())
    migrationRefusal(base, "The selected migration scope must be an existing real directory.");
  const root = profile?.skillsRoot ?? join(base, ".agents", "skills");
  const scope = project ? "project" : "global";
  const aliases = profile ? [] : aliasPaths(base, scope);
  for (const protectedRoot of [
    ...sourceRoots,
    ...(profile ? [join(options.home, ".agents"), ...(project ? [project] : [])] : []),
  ])
    if (within(root, protectedRoot) || within(protectedRoot, root))
      migrationRefusal(root, "A migration target overlaps a selected source or project.");
  const receiptOptions = {
    ...options,
    forbiddenRoots: [
      ...sourceRoots,
      ...(profile || project ? [base] : [join(base, ".agents")]),
      ...(project ? [project] : []),
      ...aliases.map(dirname),
    ],
  };
  return {
    base,
    root,
    scope,
    registry,
    aliases,
    ...(profile ? { profile } : {}),
    ...(project ? { project } : {}),
    options,
    receiptOptions,
    baseIdentity: identity(current),
    parents: new Map(),
  };
}
async function guard(target: Target, path = target.root): Promise<void> {
  await requireIdentity(target.base, target.baseIdentity);
  if (target.profile) await assertProfileIdentity(target.profile);
  for (let current = dirname(path); current !== target.base; current = dirname(current)) {
    if (!within(current, target.base))
      migrationRefusal(path, "A migration destination leaves the selected scope.");
    const found = await entry(current);
    if (found && !found.info.isDirectory())
      migrationRefusal(
        current,
        "Migration refuses a symlink or non-directory in its destination parent chain.",
      );
    if (target.parents.has(current)) {
      const expected = target.parents.get(current);
      if (expected ? !matches(found, expected) : found !== undefined)
        migrationRefusal(current, "A migration destination parent changed after inventory.");
    } else target.parents.set(current, found ? identity(found) : null);
  }
}
async function ensureParents(target: Target, path: string): Promise<void> {
  await guard(target, path);
  const missing: string[] = [];
  for (let current = dirname(path); current !== target.base; current = dirname(current))
    if (!(await entry(current))) missing.unshift(current);
  for (const current of missing) {
    await guard(target, join(current, "child"));
    await mkdir(current, { mode: 0o755 });
    const created = await entry(current);
    if (!created?.info.isDirectory())
      migrationRefusal(current, "A newly created migration parent changed.");
    target.parents.set(current, identity(created));
  }
}
async function ownerFor(target: Target, replacing?: string): Promise<Owner> {
  if (target.profile) {
    const state = await readProfileState(target.profile, target.receiptOptions);
    if (state.data.pending)
      migrationRefusal(
        state.snapshot.path,
        "A normal profile operation is pending; resolve its exact recovery evidence before migration.",
      );
    return { kind: "profile", state };
  }
  const snapshot = await readActivationReceipt<ActivationData>(target.base, target.receiptOptions);
  const data = snapshot.document
    ? validateData(snapshot.document.data, target.root, target.aliases, snapshot.path)
    : { version: 1 as const, links: {}, directories: {}, sources: [] };
  if (data.pending)
    migrationRefusal(
      snapshot.path,
      "A normal activation operation is pending; resolve its exact recovery evidence before migration.",
    );
  for (const [path, expected] of [
    ...Object.entries(data.links),
    ...Object.entries(data.directories),
  ])
    if (path !== replacing && !(replacing === target.root && dirname(path) === target.root))
      await requireIdentity(path, expected, true);
  return { kind: "scope", snapshot, data };
}
async function recordOwnership(
  target: Target,
  path: string,
  node: MigrationNode,
  claimRoot: boolean,
  claimNames: readonly string[],
): Promise<void> {
  await assertMigrationNode(path, node);
  const owner = await ownerFor(target, path);
  if (owner.kind === "scope") {
    const links = { ...owner.data.links };
    const directories = { ...owner.data.directories };
    if (path === target.root) {
      delete links[path];
      delete directories[path];
      for (const child of Object.keys(links)) {
        const name = relative(path, child);
        const observed = Object.hasOwn(node.children, name) ? node.children[name] : undefined;
        if (
          dirname(child) === path &&
          !(
            node.identity.kind === "directory" &&
            observed?.identity.kind === "link" &&
            isDeepStrictEqual(links[child], ownEntry(observed))
          )
        )
          delete links[child];
      }
    }
    if (claimRoot) {
      if (node.identity.kind === "directory") directories[path] = ownEntry(node);
      else links[path] = ownEntry(node);
    }
    for (const name of claimNames) {
      const child = node.children[name];
      if (!isSkillName(name) || child?.identity.kind !== "link")
        migrationRefusal(
          path,
          "A proposed child ownership claim is not an observed canonical link.",
        );
      links[join(path, name)] = ownEntry(child);
    }
    const data = { ...owner.data, links, directories };
    validateData(data, target.root, target.aliases, owner.snapshot.path);
    if (!isDeepStrictEqual(data, owner.data)) await writeActivationReceipt(owner.snapshot, data);
  } else {
    const links = { ...owner.state.data.links };
    if (path === target.root) {
      if (node.identity.kind !== "directory")
        migrationRefusal(path, "A profile can own only a real skills directory.");
      for (const name of Object.keys(links))
        if (!Object.hasOwn(node.children, name)) delete links[name];
      for (const name of claimNames) {
        const child = node.children[name];
        if (!isSkillName(name) || child?.identity.kind !== "link")
          migrationRefusal(path, "A profile child claim lacks exact canonical link evidence.");
        links[name] = ownEntry(child);
      }
      const data = {
        ...owner.state.data,
        root: ownEntry(node),
        project: target.project ?? null,
        links,
      };
      if (!isDeepStrictEqual(data, owner.state.data)) await writeProfileState(owner.state, data);
    } else {
      const name = relative(target.root, path);
      if (claimRoot && isSkillName(name) && node.identity.kind === "link")
        links[name] = ownEntry(node);
      const data = { ...owner.state.data, links };
      if (!isDeepStrictEqual(data, owner.state.data)) await writeProfileState(owner.state, data);
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
async function pythonRootKey(root: string): Promise<string> {
  let resolved = root;
  try {
    resolved = await realpath(root);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const node = await entry(root);
    if (node?.raw) resolved = lexicalTarget(root, node.raw);
  }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}
async function legacyFor(target: Target, plan: Prepared): Promise<Legacy> {
  const key = await pythonRootKey(target.root);
  const options = target.options;
  const home = options.home as string;
  const stateHome = migrationAbsolute(
    options.stateHome ??
      (options.env ?? process.env).XDG_STATE_HOME ??
      join(home, ".local", "state"),
    home,
    home,
  );
  const directory = join(stateHome, "skillex", "projections");
  const legacyDirectory = await entry(directory);
  if (legacyDirectory && !legacyDirectory.info.isDirectory())
    migrationRefusal(
      directory,
      "Legacy receipt discovery refuses a symlink or non-directory projections path.",
    );
  const files: { path: string; node: MigrationNode }[] = [];
  const entries = new Map<string, string>();
  const ambiguous = new Set<string>();
  let aliasTarget: string | null = null;
  let invalid = false;
  for (const suffix of [".json", ".pending.json"]) {
    const path = join(directory, `${key}${suffix}`);
    try {
      const found = await readLegacyJson(path);
      if (!found) continue;
      files.push({ path, node: found.node });
      const raw = found.raw;
      const fields = [
        "version",
        "root",
        "scope",
        "mode",
        "alias_target",
        "entries",
        "manifests",
        "registry_roots",
        "written_at",
        "generator",
      ];
      if (
        !object(raw) ||
        Object.keys(raw).some((field) => !fields.includes(field)) ||
        raw.version !== 1 ||
        raw.root !== target.root ||
        (raw.scope !== undefined && raw.scope !== "" && raw.scope !== target.scope) ||
        (raw.mode !== undefined && !["composed", "alias"].includes(String(raw.mode))) ||
        !object(raw.entries) ||
        (raw.alias_target !== undefined &&
          raw.alias_target !== null &&
          (typeof raw.alias_target !== "string" ||
            !isAbsolute(raw.alias_target) ||
            raw.alias_target.includes("\0"))) ||
        (raw.registry_roots !== undefined &&
          (!Array.isArray(raw.registry_roots) ||
            !raw.registry_roots.every(
              (path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"),
            ))) ||
        (raw.manifests !== undefined &&
          (!Array.isArray(raw.manifests) ||
            !raw.manifests.every(
              (value) =>
                object(value) && Object.values(value).every((field) => typeof field === "string"),
            ))) ||
        ["written_at", "generator"].some(
          (field) =>
            raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== "string",
        )
      )
        migrationRefusal(
          path,
          "The Python receipt has an unsupported version, wrong root/scope, or malformed fields.",
        );
      const candidate = new Map<string, string>();
      for (const [name, value] of Object.entries(raw.entries)) {
        if (!isSkillName(name))
          migrationRefusal(
            path,
            `Python ownership name ${name} is outside the canonical child namespace.`,
          );
        if (
          !(
            typeof value === "string" ||
            (object(value) &&
              Object.keys(value).every((field) => ["target", "origin", "stage"].includes(field)) &&
              typeof value.target === "string" &&
              ["origin", "stage"].every(
                (field) => value[field] === undefined || typeof value[field] === "string",
              ))
          )
        )
          migrationRefusal(path, `Python receipt entry ${name} is malformed.`);
        const linkTarget = typeof value === "string" ? value : (value.target as string);
        if (linkTarget && (!isAbsolute(linkTarget) || linkTarget.includes("\0")))
          migrationRefusal(
            path,
            `Python receipt entry ${name} requires an absolute recorded target.`,
          );
        if (!linkTarget) {
          ambiguous.add(name);
          blocked(
            plan,
            "validate-receipt-entry",
            join(target.root, name),
            "A Python pending/name-only claim has no target evidence and cannot be adopted.",
          );
        } else candidate.set(name, resolve(linkTarget));
      }
      if (raw.mode === "alias") {
        if (
          typeof raw.alias_target !== "string" ||
          !raw.alias_target ||
          candidate.size ||
          ambiguous.size
        )
          migrationRefusal(
            path,
            "An alias-mode Python receipt must name one target and claim no target-directory children.",
          );
        if (aliasTarget && aliasTarget !== raw.alias_target)
          migrationRefusal(path, "Committed and pending Python alias targets disagree.");
        aliasTarget = resolve(raw.alias_target);
      }
      for (const [name, value] of candidate) {
        if (entries.has(name) && entries.get(name) !== value) {
          ambiguous.add(name);
          blocked(
            plan,
            "validate-receipt-entry",
            join(target.root, name),
            "Committed and pending Python targets disagree; neither claim was imported.",
          );
        } else entries.set(name, value);
      }
      plan.items.push(
        item(target, "validate-python-receipt", path, "verified", [
          "Version/root/scope and typed targets validated; current object evidence is still required.",
        ]),
      );
    } catch (error) {
      invalid = true;
      const bad = failure(error);
      plan.findings.push(...bad.findings);
      plan.items.push(
        item(
          target,
          "validate-python-receipt",
          path,
          "blocked",
          bad.findings.map((finding) => finding.message),
        ),
      );
    }
  }
  for (const name of ambiguous) entries.delete(name);
  return {
    files,
    entries: invalid ? new Map() : entries,
    ambiguous,
    aliasTarget: invalid ? null : aliasTarget,
  };
}

async function canonicalMapping(
  target: Target,
  path: string,
): Promise<{
  name: string;
  target: string;
  proofs: readonly { path: string; node: MigrationNode }[];
} | null> {
  const references = target.options.mapping?.references;
  if (!references || !Object.hasOwn(references, path)) return null;
  const name = references[path];
  if (name === null)
    migrationRefusal(
      path,
      "A null mapping never authorizes removing activation or profile content.",
    );
  if (!isSkillName(name))
    migrationRefusal(path, "An activation mapping must identify a safe canonical skill name.");
  if (!target.registry)
    migrationRefusal(path, "Canonical mappings require an available selected catalog.");
  const canonical = await canonicalSkill(target.registry, name);
  const source = await realpath(path);
  if (source !== canonical) {
    const [before, after] = await Promise.all([captureContent(source), captureContent(canonical)]);
    const comparable = (entries: readonly ContentEntry[]) =>
      entries
        .filter((entry) => entry.path !== ".source.yaml")
        .map((entry) =>
          entry.kind === "link"
            ? { path: entry.path, kind: entry.kind, target: entry.target }
            : entry,
        );
    if (
      before.excluded.length ||
      after.excluded.length ||
      !isDeepStrictEqual(comparable(before.entries), comparable(after.entries))
    )
      migrationRefusal(
        path,
        "The explicitly mapped activation content differs from its canonical definition or contains excluded content.",
      );
  }
  const proofs: { path: string; node: MigrationNode }[] = [];
  for (const selected of new Set([source, canonical])) {
    const node = await captureMigrationNode(selected);
    if (node?.identity.kind !== "directory")
      migrationRefusal(
        selected,
        "A mapped definition changed before its content evidence could be recorded.",
      );
    proofs.push({ path: selected, node });
  }
  return { name, target: canonical, proofs };
}
function addOperation(plan: Prepared, operation: Operation): void {
  if (plan.operations.some((other) => other.item.path === operation.item.path)) return;
  const selected = {
    ...operation,
    item: {
      ...operation.item,
      ...(operation.previous ? { beforeDigest: migrationDigest(operation.previous) } : {}),
    },
  };
  plan.items.push(selected.item);
  plan.operations.push(selected);
}
async function collectArtifacts(plan: Prepared): Promise<void> {
  const pending = plan.state.data.pending;
  const parents = new Set([plan.target.root, ...plan.target.aliases].map(dirname));
  const root = await entry(plan.target.root);
  if (root?.info.isDirectory()) parents.add(plan.target.root);
  for (const parent of parents) {
    await guard(plan.target, join(parent, "child"));
    const current = await entry(parent);
    if (!current) continue;
    for (const name of await readdir(parent)) {
      if (!/^\.skillex-tmp-migration-[a-f0-9-]+-(?:new|old)$/.test(name)) continue;
      const path = join(parent, name);
      if (path === pending?.stage || path === pending?.parked) continue;
      if (
        plan.findings.some(
          (finding) => finding.code === "W_MIGRATION_RECOVERY_PRESERVED" && finding.path === path,
        )
      )
        continue;
      plan.items.push(
        item(plan.target, "preserve-recovery", path, "preserved", [
          "No exact migration journal owns this temporary entry; it is preserved until explicitly inspected and removed.",
        ]),
      );
      plan.findings.push({
        code: "W_MIGRATION_RECOVERY_PRESERVED",
        severity: "warning",
        path,
        message: "Unrecognized migration recovery content was preserved.",
        fix: "Inspect this exact path. Remove it explicitly only when its content is no longer needed; its presence remains a partial migration result.",
      });
    }
  }
}
function planExit(plan: Prepared, applied = false): ExitCode {
  if (plan.items.some((item) => item.state === "blocked"))
    return applied ? ExitCode.PARTIAL : ExitCode.REFUSED;
  return plan.state.data.pending ||
    plan.findings.some((finding) => finding.code === "W_MIGRATION_RECOVERY_PRESERVED")
    ? ExitCode.PARTIAL
    : ExitCode.SUCCESS;
}
async function prepare(target: Target): Promise<Prepared> {
  check(target.options);
  await guard(target);
  const state = await readMigrationActivationState(
    target.base,
    target.root,
    target.aliases,
    !!target.profile,
    target.receiptOptions,
  );
  const owner = await ownerFor(target, state.data.pending?.path);
  const plan: Prepared = { target, owner, state, items: [], operations: [], findings: [] };
  await collectArtifacts(plan);
  if (state.data.pending) {
    plan.items.push(
      item(target, "recover", state.data.pending.path, "ready", [
        "Exact recorded migration objects must be recovered before a current plan can be completed.",
      ]),
    );
    plan.findings.push({
      code: "W_MIGRATION_RECOVERY_PENDING",
      severity: "warning",
      path: state.snapshot.path,
      message: "An activation migration item is pending; preview leaves it unchanged.",
      fix: "Apply migration again to recover the recorded item before planning current input.",
    });
    return plan;
  }
  const legacy = target.profile
    ? {
        files: [],
        entries: new Map<string, string>(),
        ambiguous: new Set<string>(),
        aliasTarget: null,
      }
    : await legacyFor(target, plan);
  const root = await captureMigrationNode(target.root);
  if (root?.identity.kind === "file" || root?.identity.kind === "other") {
    blocked(
      plan,
      "inspect-root",
      target.root,
      "The activation root is a real file or special object; migration preserves it.",
    );
    return plan;
  }
  if (root?.identity.kind === "link") {
    if (
      !target.profile &&
      legacy.aliasTarget &&
      lexicalTarget(target.root, root.identity.raw as string) === legacy.aliasTarget
    ) {
      const claimed = existingClaim(owner, target, target.root);
      const ready = !claimed || !isDeepStrictEqual(claimed, ownEntry(root));
      const current = item(
        target,
        "adopt-root",
        target.root,
        ready ? "ready" : "verified",
        ["The current whole-root link exactly matches the validated Python alias target."],
        legacy.aliasTarget,
      );
      if (ready)
        addOperation(plan, {
          item: current,
          previous: root,
          claimRoot: true,
          claimNames: [],
          adopt: true,
          proofs: legacy.files,
        });
      else plan.items.push(current);
    } else {
      try {
        let shared: string;
        try {
          shared = await realpath(target.root);
        } catch (error) {
          if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
            migrationRefusal(
              target.root,
              "The legacy whole-root alias has a missing or cyclic target; restore its content before migration.",
            );
          throw error;
        }
        if (within(shared, target.root) || within(target.root, shared))
          migrationRefusal(
            target.root,
            "The old whole-root alias would create recursive migration topology.",
          );
        const contents = await captureMigrationNode(shared);
        if (contents?.identity.kind !== "directory")
          migrationRefusal(
            shared,
            "A whole-root migration requires an existing real directory target.",
          );
        if (Object.hasOwn(contents.children, "SKILL.md"))
          migrationRefusal(
            shared,
            "The old alias points at one skill definition rather than a collection root.",
          );
        const children: Record<string, string> = {};
        const claimNames: string[] = [];
        const proofs = [{ path: shared, node: contents }];
        for (const name of Object.keys(contents.children)) {
          const path = join(target.root, name);
          const mapped = await canonicalMapping(target, path);
          const output = mapped?.name ?? name;
          if (Object.hasOwn(children, output))
            migrationRefusal(path, "Two original children map to the same resulting name.");
          Object.defineProperty(children, output, {
            value: mapped?.target ?? join(shared, name),
            enumerable: true,
          });
          if (mapped) claimNames.push(output);
          if (mapped) proofs.push(...mapped.proofs);
          plan.items.push(
            item(
              target,
              mapped ? "map-child" : "preserve-child",
              path,
              mapped ? "ready" : "preserved",
              [
                mapped
                  ? "The mapped canonical content is verified."
                  : "The original child remains reachable through a foreign forwarding link; its shared target is untouched.",
              ],
              children[output],
            ),
          );
        }
        addOperation(plan, {
          item: item(target, "materialize-root", target.root, "ready", [
            "Replace only the old root symlink with a real directory; preserve every inventoried child and leave the shared target untouched.",
          ]),
          previous: root,
          children,
          claimRoot: true,
          claimNames,
          proofs,
        });
      } catch (error) {
        const bad = failure(error);
        plan.findings.push(...bad.findings);
        plan.items.push(
          item(
            target,
            "materialize-root",
            target.root,
            "blocked",
            bad.findings.map((finding) => finding.message),
          ),
        );
      }
    }
  } else if (root) {
    const rootClaim = existingClaim(owner, target, target.root);
    const claims: string[] = [];
    const ownershipProofs = [...legacy.files];
    for (const [name, node] of Object.entries(root.children)) {
      const path = join(target.root, name);
      try {
        const mapped = await canonicalMapping(target, path);
        if (mapped) ownershipProofs.push(...mapped.proofs);
        const recorded = legacy.entries.get(name);
        const matched =
          node.identity.kind === "link" &&
          !!recorded &&
          lexicalTarget(path, node.identity.raw as string) === recorded;
        const oldClaim = existingClaim(owner, target, path);
        if (recorded && !matched && !oldClaim) {
          blocked(
            plan,
            "adopt-child",
            path,
            "The current object does not match its Python receipt target; it remains foreign.",
          );
          continue;
        }
        if (mapped && (mapped.name !== name || node.identity.kind !== "link")) {
          blocked(
            plan,
            "map-child",
            path,
            "Canonical renaming or a real definition needs an explicit content relocation before this child can become a managed link.",
          );
          continue;
        }
        if (matched || mapped) {
          if (!oldClaim) claims.push(name);
          if (mapped && lexicalTarget(path, node.identity.raw as string) !== mapped.target) {
            addOperation(plan, {
              item: item(
                target,
                "relink-child",
                path,
                "ready",
                [
                  "Explicit mapping and equal authored content authorize this canonical link replacement.",
                ],
                mapped.target,
              ),
              previous: node,
              target: mapped.target,
              claimRoot: true,
              claimNames: [],
              proofs: [...legacy.files, ...mapped.proofs, { path, node }],
            });
          } else
            plan.items.push(
              item(
                target,
                "adopt-child",
                path,
                oldClaim ? "verified" : "ready",
                [
                  "Exact observed link evidence will be recorded; target containment alone grants no ownership.",
                ],
                mapped?.target ?? recorded,
              ),
            );
        } else
          plan.items.push(
            item(target, "preserve-child", path, "preserved", [
              "Foreign or installer-owned content remains in place without a pruning claim.",
            ]),
          );
      } catch (error) {
        const bad = failure(error);
        plan.findings.push(...bad.findings);
        plan.items.push(
          item(
            target,
            "map-child",
            path,
            "blocked",
            bad.findings.map((finding) => finding.message),
          ),
        );
      }
    }
    if (!rootClaim || claims.length)
      addOperation(plan, {
        item: item(target, "adopt-root", target.root, "ready", [
          "Keep the real root inode; claim only the individually verified child links.",
        ]),
        previous: root,
        claimRoot: true,
        claimNames: claims,
        adopt: true,
        proofs: ownershipProofs,
      });
    else
      plan.items.push(
        item(target, "adopt-root", target.root, "verified", [
          "The real root and existing exact claims are already recorded.",
        ]),
      );
  } else
    plan.items.push(
      item(target, "inspect-root", target.root, "preserved", [
        "The activation root is absent. Ordinary sync can create the selected projection after migration.",
      ]),
    );

  for (const path of target.aliases) {
    await guard(target, path);
    const alias = await captureMigrationNode(path);
    if (!alias) {
      if (root)
        addOperation(plan, {
          item: item(
            target,
            "create-alias",
            path,
            "ready",
            ["Create the missing supported CLI alias to the stable activation root."],
            target.root,
          ),
          target: target.root,
          claimRoot: true,
          claimNames: [],
          proofs: [],
        });
      else
        plan.items.push(
          item(target, "preserve-alias", path, "preserved", [
            "The shared activation root is absent; no dangling alias is created.",
          ]),
        );
    } else if (alias.identity.kind === "link") {
      const lexical = lexicalTarget(path, alias.identity.raw as string);
      let same = lexical === target.root;
      if (!same)
        try {
          same = (await realpath(path)) === (await realpath(target.root));
        } catch {
          /* A dangling or foreign link is not equivalent. */
        }
      if (lexical === target.root)
        plan.items.push(
          item(
            target,
            "inspect-alias",
            path,
            "verified",
            ["The correct existing CLI alias remains unchanged and unadopted."],
            target.root,
          ),
        );
      else if (same)
        addOperation(plan, {
          item: item(
            target,
            "stabilize-alias",
            path,
            "ready",
            [
              "Current reachability is identical; explicitly retarget this alias through the scope root before later pack changes.",
            ],
            target.root,
          ),
          previous: alias,
          target: target.root,
          claimRoot: true,
          claimNames: [],
          proofs: [],
        });
      else
        blocked(
          plan,
          "convert-alias",
          path,
          "The foreign or dangling CLI link has no verified equivalent activation target; it was preserved.",
        );
    } else if (alias.identity.kind === "directory") {
      const proofs: { path: string; node: MigrationNode }[] = [];
      let allowed = !!root;
      for (const [name, child] of Object.entries(alias.children)) {
        const childPath = join(path, name);
        try {
          const mapped = await canonicalMapping(target, childPath);
          if (child.identity.kind !== "link" || !mapped) {
            allowed = false;
            blocked(
              plan,
              "account-cli-child",
              childPath,
              "This local/installer entry needs an inode-preserving, collision-free relocation with equivalent active visibility before the CLI root can become an alias.",
            );
            continue;
          }
          const common = join(target.root, mapped.name);
          const counterpart = await captureMigrationNode(common);
          if (counterpart?.identity.kind !== "link" || (await realpath(common)) !== mapped.target) {
            allowed = false;
            blocked(
              plan,
              "account-cli-child",
              childPath,
              `The mapped canonical child is not yet available at ${common}; preserve this CLI directory until that counterpart exists.`,
            );
            continue;
          }
          proofs.push({ path: common, node: counterpart });
          proofs.push(...mapped.proofs);
          plan.items.push(
            item(
              target,
              "account-cli-child",
              childPath,
              "ready",
              [
                "Explicitly mapped canonical link has an equivalent, verified counterpart in the common root.",
              ],
              common,
            ),
          );
        } catch (error) {
          allowed = false;
          const bad = failure(error);
          plan.findings.push(...bad.findings);
          plan.items.push(
            item(
              target,
              "account-cli-child",
              childPath,
              "blocked",
              bad.findings.map((finding) => finding.message),
            ),
          );
        }
      }
      if (allowed)
        addOperation(plan, {
          item: item(
            target,
            "convert-alias",
            path,
            "ready",
            [
              "All former children are accounted for before the empty or mapped-link-only CLI directory is retired.",
            ],
            target.root,
          ),
          previous: alias,
          target: target.root,
          claimRoot: true,
          claimNames: [],
          proofs,
        });
      else if (!Object.keys(alias.children).length)
        blocked(
          plan,
          "convert-alias",
          path,
          "The shared activation root is absent; this CLI directory is preserved until a destination exists.",
        );
    } else
      blocked(
        plan,
        "convert-alias",
        path,
        "A real file or special entry occupies this CLI root; migration preserves it.",
      );
  }
  await guard(target);
  return plan;
}

async function flush(target: Target, path: string): Promise<void> {
  await guard(target, join(path, "child"));
  const before = await entry(path);
  if (!before?.info.isDirectory())
    migrationRefusal(path, "The migration parent is no longer a real directory.");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!matches({ path, info: await handle.stat({ bigint: true }) }, identity(before)))
      migrationRefusal(path, "The migration directory changed before fsync.");
    await handle.sync();
    await requireIdentity(path, identity(before));
  } finally {
    await handle.close();
  }
}
async function pendingEvidence(target: Target, pending: MigrationPending) {
  await guard(target, pending.path);
  const current = await captureMigrationNode(pending.path);
  const parked = await captureMigrationNode(pending.parked);
  const stage = await captureMigrationNode(pending.stage);
  if (stage) await assertMigrationRemainder(pending.stage, pending.next);
  if (parked) {
    if (!pending.previous)
      migrationRefusal(pending.parked, "Unexpected content occupies a migration recovery path.");
    await assertMigrationRemainder(pending.parked, pending.previous);
  }
  if (!isDeepStrictEqual(current, pending.next)) {
    if (pending.previous) {
      if (
        !(
          (!current && isDeepStrictEqual(parked, pending.previous)) ||
          (isDeepStrictEqual(current, pending.previous) && !parked)
        )
      )
        migrationRefusal(
          pending.path,
          "Migration recovery refuses to overwrite changed or ambiguous content.",
        );
    } else if (current || parked)
      migrationRefusal(pending.path, "A foreign object appeared during migration recovery.");
  }
  return { current, parked, stage };
}
async function finishPending(
  target: Target,
  state: MigrationActivationState,
  begin: () => void = () => {},
): Promise<MigrationActivationState> {
  const pending = state.data.pending;
  if (!pending) return state;
  const { current, parked, stage } = await pendingEvidence(target, pending);
  if (isDeepStrictEqual(current, pending.next)) {
    begin();
    await recordOwnership(
      target,
      pending.path,
      pending.next,
      pending.claimRoot,
      pending.claimNames,
    );
    if (parked) {
      if (!pending.previous)
        migrationRefusal(pending.parked, "Unexpected content occupies a migration recovery path.");
      await guard(target, pending.parked);
      await removeMigrationNode(pending.parked, pending.previous);
    }
    if (stage) {
      await guard(target, pending.stage);
      await removeMigrationNode(pending.stage, pending.next);
    }
    await flush(target, dirname(pending.path));
    const verified = {
      ...state.data.verified,
      [pending.item]: { path: pending.path, digest: migrationDigest(pending.next) },
    };
    return writeMigrationActivationState(state, { version: 1, root: target.root, verified });
  }
  if (pending.previous) {
    if (!current && isDeepStrictEqual(parked, pending.previous)) {
      await guard(target, pending.path);
      await assertMigrationNode(pending.parked, pending.previous);
      if (await entry(pending.path))
        migrationRefusal(pending.path, "A foreign object appeared during migration recovery.");
      begin();
      await rename(pending.parked, pending.path);
    } else if (!isDeepStrictEqual(current, pending.previous) || parked)
      migrationRefusal(
        pending.path,
        "Migration recovery refuses to overwrite changed or ambiguous content.",
      );
  } else if (current || parked)
    migrationRefusal(pending.path, "A foreign object appeared during migration recovery.");
  begin();
  if (stage) {
    await guard(target, pending.stage);
    await removeMigrationNode(pending.stage, pending.next);
  }
  await flush(target, dirname(pending.path));
  return writeMigrationActivationState(state, {
    version: 1,
    root: target.root,
    verified: state.data.verified,
  });
}
async function execute(
  target: Target,
  operation: Operation,
  state: MigrationActivationState,
  mark: (id: string) => void,
  begin: () => void,
): Promise<MigrationActivationState> {
  check(target.options);
  await guard(target, operation.item.path);
  for (const proof of operation.proofs) await assertMigrationNode(proof.path, proof.node);
  if (operation.previous) await assertMigrationNode(operation.item.path, operation.previous);
  else if (await entry(operation.item.path))
    migrationRefusal(operation.item.path, "An entry appeared after migration preflight.");
  if (operation.adopt) {
    const node = operation.previous as MigrationNode;
    begin();
    await recordOwnership(
      target,
      operation.item.path,
      node,
      operation.claimRoot,
      operation.claimNames,
    );
    mark(operation.item.id);
    return writeMigrationActivationState(state, {
      ...state.data,
      verified: {
        ...state.data.verified,
        [operation.item.id]: { path: operation.item.path, digest: migrationDigest(node) },
      },
    });
  }
  begin();
  await ensureParents(target, operation.item.path);
  const id = randomUUID();
  const stage = join(dirname(operation.item.path), `.skillex-tmp-migration-${id}-new`);
  const parked = join(dirname(operation.item.path), `.skillex-tmp-migration-${id}-old`);
  if (operation.children) {
    await mkdir(stage, { mode: 0o755 });
    const created = await entry(stage);
    if (!created?.info.isDirectory())
      migrationRefusal(
        stage,
        "The prepared migration directory changed before its children were created.",
      );
    target.parents.set(stage, identity(created));
    for (const [name, destination] of Object.entries(operation.children)) {
      await guard(target, join(stage, name));
      await symlink(destination, join(stage, name));
    }
  } else await symlink(operation.target as string, stage);
  const next = await captureMigrationNode(stage);
  if (!next) migrationRefusal(stage, "The prepared migration object disappeared.");
  const pending: MigrationPending = {
    id,
    item: operation.item.id,
    path: operation.item.path,
    stage,
    parked,
    ...(operation.previous ? { previous: operation.previous } : {}),
    next,
    claimRoot: operation.claimRoot,
    claimNames: operation.claimNames,
  };
  try {
    state = await writeMigrationActivationState(state, { ...state.data, pending });
  } catch (error) {
    try {
      const latest = await readMigrationActivationState(
        target.base,
        target.root,
        target.aliases,
        !!target.profile,
        target.receiptOptions,
      );
      if (latest.data.pending?.stage !== stage) {
        await guard(target, stage);
        await removeMigrationNode(stage, next);
      }
    } catch {
      /* Unknown or published recovery material remains for explicit inspection. */
    }
    throw error;
  }
  check(target.options);
  for (const proof of operation.proofs) await assertMigrationNode(proof.path, proof.node);
  await guard(target, operation.item.path);
  if (operation.previous) {
    await assertMigrationNode(operation.item.path, operation.previous);
    if (await entry(parked))
      migrationRefusal(parked, "A foreign object occupies the parking path.");
    await rename(operation.item.path, parked);
  }
  if (await entry(operation.item.path))
    migrationRefusal(operation.item.path, "A foreign entry appeared before migration publication.");
  await assertMigrationNode(stage, next);
  await guard(target, operation.item.path);
  await rename(stage, operation.item.path);
  mark(operation.item.id);
  await flush(target, dirname(operation.item.path));
  return finishPending(target, state);
}

/** Recover recorded objects before current source or manifest validation; never plan new intent. */
export async function recoverActivationMigration(
  options: MigrationOptions = {},
): Promise<ResultEnvelope<MigrationSectionResult | null>> {
  let target: Target | null = null;
  let state: MigrationActivationState | null = null;
  const items: MigrationItem[] = [];
  const applied: string[] = [];
  let started = false;
  const section = (): MigrationSectionResult => ({
    items,
    applied,
    receipts: state?.data.pending || applied.length ? [state?.snapshot.path ?? ""] : [],
  });
  try {
    check(options);
    target = await targetFor(options, true);
    if (!target) return makeResult("migrate", section());
    await guard(target);
    state = await readMigrationActivationState(
      target.base,
      target.root,
      target.aliases,
      !!target.profile,
      target.receiptOptions,
    );
    await guard(target);
    if (!state.data.pending) return makeResult("migrate", section());
    const pending = state.data.pending;
    items.push(
      item(target, "recover", pending.path, "ready", [
        "Recover the exact recorded migration operation before validating current source or manifest intent.",
      ]),
    );
    if (!options.apply)
      return makeResult("migrate", section(), {
        exit: ExitCode.PARTIAL,
        findings: [
          {
            code: "W_MIGRATION_RECOVERY_PENDING",
            severity: "warning",
            path: state.snapshot.path,
            message: "An activation migration item is pending; preview leaves it unchanged.",
            fix: "Apply migration to recover this exact item before validating current intent.",
          },
        ],
      });
    await ownerFor(target, pending.path);
    await pendingEvidence(target, pending);
    const selected = target;
    await withLock(
      selected.profile ? `skillex:profiles:v2:${selected.root}` : "skillex:activation:v2",
      async () => {
        check(options);
        // The acquired lock starts a fresh plan; another cooperative writer may
        // have created supported parent directories while this caller waited.
        selected.parents.clear();
        await guard(selected);
        state = await readMigrationActivationState(
          selected.base,
          selected.root,
          selected.aliases,
          !!selected.profile,
          selected.receiptOptions,
        );
        if (!state.data.pending) {
          items.length = 0;
          return;
        }
        const current = state.data.pending;
        await ownerFor(selected, current.path);
        state = await finishPending(selected, state, () => {
          started = true;
        });
        const id = `recover:${current.item}`;
        applied.push(id);
        items.splice(0, items.length, {
          ...item(selected, "recover", current.path, "verified", [
            "The recorded migration operation was recovered without applying current intent.",
          ]),
          id,
        });
      },
      target.options,
    );
    return makeResult("migrate", section());
  } catch (error) {
    const bad = options.signal?.aborted
      ? new SkillexError(ExitCode.INTERRUPTED, [
          {
            code: "E_INTERRUPTED",
            severity: "error",
            message: "Activation migration recovery was interrupted.",
            fix: "Apply migration with the same explicit target again to resume exact recorded recovery.",
          },
        ])
      : failure(error);
    return makeResult("migrate", target ? section() : null, {
      exit: bad.exit === ExitCode.INTERRUPTED ? bad.exit : started ? ExitCode.PARTIAL : bad.exit,
      findings: [
        ...bad.findings,
        ...(started
          ? [
              {
                code: "W_MIGRATION_PARTIAL" as const,
                severity: "warning" as const,
                ...(target ? { path: target.root } : {}),
                message:
                  "Recovery writes began; exact journal evidence and original content remain available.",
                fix: "Apply migration again to finish recorded recovery before validating current intent.",
              },
            ]
          : []),
      ],
    });
  }
}

/** A migration section never selects an ambient scope and never invokes ordinary sync. */
export async function migrateActivation(
  options: MigrationOptions = {},
): Promise<ResultEnvelope<MigrationSectionResult | null>> {
  let target: Target | null = null;
  let plan: Prepared | null = null;
  const applied: string[] = [];
  const completed = new Map<string, MigrationItem>();
  let started = false;
  try {
    check(options);
    target = await targetFor(options);
    if (!target) return makeResult("migrate", { items: [], applied, receipts: [] });
    plan = await prepare(target);
    const section = () => ({
      items: [
        ...new Map([
          ...(plan?.items ?? []).map((item) => [item.id, item] as const),
          ...completed,
        ]).values(),
      ],
      applied,
      receipts: [
        plan?.state.snapshot.path ?? "",
        ...(plan?.owner.kind === "scope"
          ? [plan.owner.snapshot.path]
          : plan
            ? [plan.owner.state.snapshot.path]
            : []),
      ].filter(Boolean),
    });
    if (!options.apply)
      return makeResult("migrate", section(), {
        findings: plan.findings,
        exit: planExit(plan),
      });
    if (!plan.operations.length && !plan.state.data.pending)
      return makeResult("migrate", section(), {
        findings: plan.findings,
        exit: planExit(plan),
      });
    const selected = target;
    await withLock(
      selected.profile ? `skillex:profiles:v2:${selected.root}` : "skillex:activation:v2",
      async () => {
        check(options);
        selected.parents.clear();
        await guard(selected);
        let state = await readMigrationActivationState(
          selected.base,
          selected.root,
          selected.aliases,
          !!selected.profile,
          selected.receiptOptions,
        );
        if (state.data.pending) {
          const id = state.data.pending.item;
          const path = state.data.pending.path;
          state = await finishPending(selected, state, () => {
            started = true;
          });
          applied.push(`recover:${id}`);
          completed.set(`recover:${id}`, {
            ...item(selected, "recover", path, "verified", [
              "The recorded migration operation was safely recovered.",
            ]),
            id: `recover:${id}`,
          });
        }
        plan = await prepare(selected);
        // Re-plan after every independently verified item because earlier root changes alter later observations.
        const attempted = new Set<string>();
        for (;;) {
          check(options);
          const current = await prepare(selected);
          const operation = current.operations[0];
          if (!operation) break;
          if (attempted.has(operation.item.id) || attempted.size >= 10_000)
            migrationRefusal(
              operation.item.path,
              "The migration item did not converge after publication.",
            );
          attempted.add(operation.item.id);
          state = await execute(
            selected,
            operation,
            current.state,
            (id) => {
              applied.push(id);
              completed.set(id, { ...operation.item, state: "verified" });
            },
            () => {
              started = true;
            },
          );
          const verified = state.data.verified[operation.item.id];
          if (verified)
            completed.set(operation.item.id, {
              ...operation.item,
              state: "verified",
              afterDigest: verified.digest,
            });
        }
        plan = await prepare(selected);
      },
      target.options,
    );
    return makeResult("migrate", section(), {
      findings: plan.findings,
      exit: planExit(plan, applied.length > 0),
    });
  } catch (error) {
    if (target && plan) {
      try {
        const latest = await readMigrationActivationState(
          target.base,
          target.root,
          target.aliases,
          !!target.profile,
          target.receiptOptions,
        );
        plan = { ...plan, state: latest };
        const pending = latest.data.pending;
        if (
          pending &&
          isDeepStrictEqual(await captureMigrationNode(pending.path), pending.next) &&
          !applied.includes(pending.item)
        ) {
          applied.push(pending.item);
          const original = plan.items.find((item) => item.id === pending.item);
          if (original)
            completed.set(pending.item, {
              ...original,
              state: "verified",
              afterDigest: migrationDigest(pending.next),
            });
        }
        await collectArtifacts(plan);
      } catch {
        /* Report the original error without discarding inaccessible recovery evidence. */
      }
    }
    const bad = options.signal?.aborted
      ? new SkillexError(ExitCode.INTERRUPTED, [
          {
            code: "E_INTERRUPTED",
            severity: "error",
            message: "Activation migration was interrupted.",
            fix: "Apply the same explicit migration target again to recover recorded objects before planning current intent.",
          },
        ])
      : failure(error);
    return makeResult(
      "migrate",
      plan
        ? {
            items: [
              ...new Map([
                ...plan.items.map((item) => [item.id, item] as const),
                ...completed,
              ]).values(),
            ],
            applied,
            receipts: [plan.state.snapshot.path],
          }
        : null,
      {
        exit: bad.exit === ExitCode.INTERRUPTED ? bad.exit : started ? ExitCode.PARTIAL : bad.exit,
        findings: [
          ...(plan?.findings ?? []),
          ...bad.findings,
          ...(started
            ? [
                {
                  code: "W_MIGRATION_PARTIAL" as const,
                  severity: "warning" as const,
                  message:
                    "Some migration writes began. Exact recovery evidence and unmodified foreign content are retained.",
                  ...(target ? { path: target.root } : {}),
                  fix: "Apply migration again; inspect any unjournaled temporary objects explicitly rather than assuming they are owned.",
                },
              ]
            : []),
        ],
      },
    );
  }
}
