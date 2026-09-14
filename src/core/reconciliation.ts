import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  emptyData,
  entry,
  identity,
  inspectOwnedNode,
  lexicalTarget,
  matches,
  refuse,
  replaceOwnership,
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
import type {
  ActivationData,
  ActivationJournal,
  EntryIdentity,
  OwnedNode,
  SourceRevision,
} from "./activation-types.js";
import { aliasPaths } from "./aliases.js";
import { canonicalSkill } from "./composition.js";
import { fail, SkillexError } from "./error.js";
import { withLock } from "./lock.js";
import { verifyPack } from "./packs.js";
import type {
  SyncChange,
  SyncOptions,
  SyncPlan,
  SyncResult,
  SyncScopePlan,
} from "./reconciliation-types.js";
import { resolveSelection } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { Resolution, ResolvedScope, ScopeName } from "./selection.js";

const runFile = promisify(execFile);
const lockResource = "skillex:activation:v2";

interface Operation {
  readonly path: string;
  readonly previous?: OwnedNode;
  readonly target?: string;
  readonly children?: ReadonlyMap<string, string>;
  readonly changes: readonly SyncChange[];
}

interface Recovery {
  readonly journal: ActivationJournal;
  readonly published: boolean;
  readonly restore: boolean;
  readonly data: ActivationData;
}

interface ScopeWork {
  readonly options: SyncOptions;
  readonly scope: ResolvedScope;
  readonly snapshot: ReceiptSnapshot<ActivationData>;
  readonly receiptOptions: ReceiptOptions;
  readonly data: ActivationData;
  readonly sources: readonly SourceRevision[];
  readonly recovery?: Recovery;
  readonly directories: ReadonlyMap<string, EntryIdentity>;
  readonly missingDirectories: readonly string[];
  readonly operations: readonly Operation[];
  readonly plan: SyncScopePlan;
}

interface ScopeExecution {
  snapshot: ReceiptSnapshot<ActivationData>;
  data: ActivationData;
  readonly directories: Map<string, EntryIdentity>;
}

/** Internal only: create and consume inside the activation ownership lock. */
export interface PreparedSync {
  readonly plan: SyncPlan;
  readonly scopes: readonly ScopeWork[];
  readonly findings: readonly Diagnostic[];
  readonly resolution: Resolution;
}

function errorResult<T>(command: string, error: unknown): ResultEnvelope<T | null> {
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
              fix: "Check the named activation paths and filesystem permissions, then retry sync.",
            },
          ],
  });
}

function checkCancelled(options: SyncOptions, path?: string): void {
  if (options.signal?.aborted)
    fail(
      "E_INTERRUPTED",
      "Sync was interrupted.",
      {
        ...(path === undefined ? {} : { path }),
        fix: "Rerun sync to verify recorded ownership, recover any pending operation, and apply the current manifests.",
      },
      ExitCode.INTERRUPTED,
    );
}

function change(
  scope: ScopeName,
  action: SyncChange["action"],
  path: string,
  target?: string,
): SyncChange {
  return { scope, action, path, ...(target === undefined ? {} : { target }) };
}

async function sourceRevision(kind: SourceRevision["kind"], path: string): Promise<SourceRevision> {
  try {
    const { stdout } = await runFile("git", ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    const commit = stdout.trim();
    if (/^[a-f0-9]{40,64}$/.test(commit)) return { kind, path, commit, reason: null };
  } catch {
    /* An unpacked/offline catalog can have no Git metadata. */
  }
  return {
    kind,
    path,
    commit: null,
    reason: "No readable local Git commit is available for this source directory.",
  };
}

async function verifyResolvedPack(scope: ResolvedScope, options: SyncOptions): Promise<void> {
  if (!scope.pack) return;
  const selected = scope.manifest.packs[0];
  const ref = selected?.version ? `${selected.name}@${selected.version}` : scope.pack.name;
  const verified = await verifyPack(ref, { ...options, registryRoot: scope.registry.root });
  if (!verified.ok) throw new SkillexError(verified.exit, verified.findings);
  if (
    verified.data?.pack.path !== scope.pack.path ||
    JSON.stringify(verified.data.pack.skills.map((skill) => [skill.name, skill.path]).sort()) !==
      JSON.stringify(scope.bindings.map((skill) => [skill.name, skill.path]).sort())
  ) {
    refuse(
      scope.pack.path,
      "Pack membership changed during activation preflight.",
      "E_OWNERSHIP_CHANGED",
    );
  }
}

function withoutPending(data: ActivationData): ActivationData {
  return { version: 1, links: data.links, directories: data.directories, sources: data.sources };
}

async function inspectRecovery(data: ActivationData): Promise<Recovery | undefined> {
  const journal = data.pending;
  if (!journal) return undefined;
  const current = await entry(journal.path);
  const staged = await entry(journal.stage);
  const parked = await entry(journal.parked);
  if (staged) {
    if (!journal.next)
      refuse(
        journal.stage,
        "Unexpected content occupies an unused journal staging path.",
        "E_OWNERSHIP_CHANGED",
      );
    await inspectOwnedNode(journal.stage, journal.next);
  }
  if (parked) {
    if (!journal.previous)
      refuse(
        journal.parked,
        "Unexpected content occupies an unused retired path.",
        "E_OWNERSHIP_CHANGED",
      );
    await inspectOwnedNode(journal.parked, journal.previous);
  }
  if (journal.next && matches(current, journal.next.identity)) {
    return {
      journal,
      published: true,
      restore: false,
      data: replaceOwnership(data, journal.path, journal.next),
    };
  }
  if (journal.previous && matches(current, journal.previous.identity)) {
    return { journal, published: false, restore: false, data: withoutPending(data) };
  }
  if (current)
    refuse(
      journal.path,
      "An interrupted activation operation encountered a foreign replacement.",
      "E_OWNERSHIP_CHANGED",
    );
  if (journal.previous && parked)
    return { journal, published: false, restore: true, data: withoutPending(data) };
  return {
    journal,
    published: !journal.next,
    restore: false,
    data: replaceOwnership(data, journal.path),
  };
}

function physicalPath(path: string, recovery?: Recovery): string {
  return recovery?.restore && within(path, recovery.journal.path)
    ? join(recovery.journal.parked, relative(recovery.journal.path, path))
    : path;
}

async function destinationParents(scope: ResolvedScope, paths: readonly string[]) {
  const directories = new Map<string, EntryIdentity>();
  const missing = new Set<string>();
  const root = await entry(scope.root);
  if (!root?.info.isDirectory())
    refuse(scope.root, "The selected scope root must remain a real directory.");
  directories.set(scope.root, identity(root));
  for (const path of paths) {
    const parent = dirname(path);
    if (!within(parent, scope.root))
      refuse(path, "Activation destination escaped its selected scope.");
    let current = scope.root;
    for (const part of relative(scope.root, parent).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (directories.has(current) || missing.has(current)) continue;
      const found = await entry(current);
      if (found) {
        if (!found.info.isDirectory())
          refuse(
            current,
            "Activation parents must be real directories; redirected or foreign parents are preserved.",
          );
        directories.set(current, identity(found));
      } else missing.add(current);
    }
  }
  return {
    directories,
    missing: [...missing].sort(
      (a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b),
    ),
  };
}

function requireLocalStaging(
  root: string,
  operations: readonly Operation[],
  directories: ReadonlyMap<string, EntryIdentity>,
): void {
  const deviceAt = (path: string): string => {
    let current = path;
    while (!directories.has(current)) {
      const parent = dirname(current);
      if (parent === current)
        refuse(path, "No validated filesystem parent exists for activation staging.");
      current = parent;
    }
    return directories.get(current)?.dev ?? "";
  };
  const stagingDevice = deviceAt(dirname(root));
  for (const operation of operations) {
    if (
      deviceAt(dirname(operation.path)) !== stagingDevice ||
      (operation.previous?.identity.kind === "directory" &&
        operation.previous.identity.dev !== stagingDevice)
    ) {
      fail(
        "E_ACTIVATION_FILESYSTEM",
        "Activation staging and this changed destination are on different filesystems.",
        {
          path: operation.path,
          fix: "Keep .agents staging and each changed activation or CLI alias destination on the same local filesystem, or migrate the mounted layout explicitly before syncing.",
        },
        ExitCode.REFUSED,
      );
    }
  }
}

/** Resolve aliases while treating the planned activation root as the stable anchor. */
async function aliasTarget(path: string, raw: string, root: string): Promise<string> {
  let target = lexicalTarget(path, raw);
  const seen = new Set<string>();
  for (let hop = 0; hop < 40; hop += 1) {
    if (target === root) return root;
    if (seen.has(target))
      refuse(path, "CLI alias contains a symbolic-link cycle.", "E_ACTIVATION_RECURSIVE");
    seen.add(target);
    let current = resolve(target, "/");
    let followed = false;
    const parts = target.slice(current.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index] ?? "");
      if (current === root) return parts.length === index + 1 ? root : target;
      const found = await entry(current);
      if (!found) return target;
      if (found.info.isSymbolicLink()) {
        target = resolve(dirname(current), found.raw ?? "", ...parts.slice(index + 1));
        followed = true;
        break;
      }
    }
    if (!followed) return target;
  }
  refuse(
    path,
    "CLI alias exceeds the safe symbolic-link traversal limit.",
    "E_ACTIVATION_RECURSIVE",
  );
}

async function buildScope(
  scope: ResolvedScope,
  options: SyncOptions,
  forbiddenRoots: readonly string[],
): Promise<ScopeWork> {
  const root = join(scope.root, ".agents", "skills");
  const aliases = aliasPaths(scope.root, scope.scope);
  const receiptOptions = { ...options, forbiddenRoots };
  const snapshot = await readActivationReceipt<ActivationData>(scope.root, receiptOptions);
  const rawData = snapshot.document
    ? validateData(snapshot.document.data, root, aliases, snapshot.path)
    : emptyData();
  const recovery = await inspectRecovery(rawData);
  const data = recovery?.data ?? rawData;
  const parents = await destinationParents(scope, [root, ...aliases]);
  const read = (path: string) => entry(physicalPath(path, recovery));
  const rootEntry = await read(root);
  if (rootEntry?.info.isDirectory()) parents.directories.set(root, identity(rootEntry));
  if (rootEntry && !rootEntry.info.isDirectory() && !rootEntry.info.isSymbolicLink())
    refuse(root, "Activation root collides with a real file or special entry.");
  if (
    rootEntry?.info.isSymbolicLink() &&
    Object.keys(data.links).some((path) => dirname(path) === root)
  )
    refuse(
      root,
      "A symlinked root cannot grant receipt ownership of target children.",
      "E_ACTIVATION_RECEIPT",
    );
  const links = { ...data.links };
  const directories = { ...data.directories };
  for (const [path, expected] of [...Object.entries(directories), ...Object.entries(links)]) {
    const actual = await read(path);
    if (!actual) {
      delete links[path];
      delete directories[path];
    } else if (!matches(actual, expected))
      refuse(path, "The activation receipt does not own the current entry.", "E_OWNERSHIP_CHANGED");
  }
  const currentData: ActivationData = { version: 1, links, directories, sources: data.sources };
  const selected = new Map(scope.bindings.map((binding) => [binding.name, binding.path]));
  for (const target of selected.values()) {
    if (within(target, root) || within(root, target))
      refuse(
        root,
        "A selected skill would recursively contain its activation destination.",
        "E_ACTIVATION_RECURSIVE",
      );
  }
  if (scope.mode === "pack") {
    if (!scope.pack)
      fail(
        "E_INCOMPLETE_RESOLUTION",
        "An optional pack was unavailable; existing activation is preserved.",
        {
          path: scope.manifest.path,
          fix: "Make the selected pack available, or remove its selection before syncing.",
        },
        ExitCode.PARTIAL,
      );
    if (within(scope.pack.skillsRoot, root) || within(root, scope.pack.skillsRoot))
      refuse(root, "Pack activation would create recursive topology.", "E_ACTIVATION_RECURSIVE");
    await verifyResolvedPack(scope, options);
  }
  const operations: Operation[] = [];
  const rootChanges =
    scope.mode === "pack"
      ? [
          change(
            scope.scope,
            rootEntry ? "replace-root" : "create-link",
            root,
            scope.pack?.skillsRoot,
          ),
        ]
      : [
          change(scope.scope, rootEntry ? "replace-root" : "create-directory", root),
          ...[...selected].map(([name, target]) =>
            change(scope.scope, "create-link", join(root, name), target),
          ),
        ];
  const previousRoot = (): OwnedNode => {
    if (!rootEntry) refuse(root, "The activation root disappeared while planning.");
    const owned = rootEntry.info.isDirectory() ? directories[root] : links[root];
    if (!owned)
      refuse(root, "Whole-root switching requires explicit ownership of the existing root.");
    if (owned.kind === "link") return { identity: owned };
    const children: Record<string, EntryIdentity> = {};
    for (const name of awaitableNames) {
      const child = links[join(root, name)];
      if (!child)
        refuse(
          join(root, name),
          "Foreign content prevents a whole-root switch; it will not be removed.",
        );
      children[name] = child;
    }
    return { identity: owned, children };
  };
  const awaitableNames = rootEntry?.info.isDirectory()
    ? await readdir(physicalPath(root, recovery))
    : [];
  if (!rootEntry) {
    operations.push({
      path: root,
      ...(scope.mode === "pack"
        ? { target: scope.pack?.skillsRoot ?? "" }
        : { children: selected }),
      changes: rootChanges,
    });
  } else if (scope.mode === "pack") {
    let correct = false;
    if (rootEntry.info.isSymbolicLink()) {
      try {
        correct = (await realpath(physicalPath(root, recovery))) === scope.pack?.skillsRoot;
      } catch {
        /* Wrong/dangling roots require exact ownership before replacement. */
      }
    }
    if (!correct)
      operations.push({
        path: root,
        previous: previousRoot(),
        target: scope.pack?.skillsRoot ?? "",
        changes: rootChanges,
      });
  } else if (rootEntry.info.isSymbolicLink()) {
    operations.push({
      path: root,
      previous: previousRoot(),
      children: selected,
      changes: rootChanges,
    });
  } else {
    for (const [name, target] of selected) {
      const path = join(root, name);
      const actual = await read(path);
      let correct = false;
      if (actual?.info.isSymbolicLink()) {
        try {
          correct = (await realpath(physicalPath(path, recovery))) === target;
        } catch {
          /* A recorded dangling link can be replaced. */
        }
      }
      if (correct) continue;
      const owned = links[path];
      if (actual && !owned)
        refuse(path, "Selected skill collides with foreign activation content.");
      operations.push({
        path,
        ...(owned ? { previous: { identity: owned } } : {}),
        target,
        changes: [change(scope.scope, actual ? "replace-link" : "create-link", path, target)],
      });
    }
    for (const [path, owned] of Object.entries(links)) {
      if (dirname(path) !== root || selected.has(path.slice(root.length + 1))) continue;
      operations.push({
        path,
        previous: { identity: owned },
        changes: [change(scope.scope, "remove-link", path)],
      });
    }
  }
  for (const path of aliases) {
    const actual = await read(path);
    let correct = false;
    if (actual?.info.isSymbolicLink()) {
      const target = await aliasTarget(path, actual.raw ?? "", root);
      correct = target === root || (scope.mode === "pack" && target === scope.pack?.skillsRoot);
    }
    if (correct) continue;
    const owned = links[path];
    if (actual && !owned)
      refuse(
        path,
        "Supported CLI alias is foreign or would not reach the planned activation root.",
      );
    operations.push({
      path,
      ...(owned ? { previous: { identity: owned } } : {}),
      target: root,
      changes: [change(scope.scope, actual ? "replace-link" : "create-link", path, root)],
    });
  }
  operations.sort(
    (a, b) =>
      Number(a.target === undefined && a.children === undefined) -
      Number(b.target === undefined && b.children === undefined),
  );
  requireLocalStaging(root, operations, parents.directories);
  const catalogPaths = new Set([
    join(scope.registry.root, "all-skills"),
    ...scope.bindings.map((binding) => dirname(binding.path)),
  ]);
  const sources = await Promise.all(
    [...catalogPaths].sort().map((path) => sourceRevision("catalog", path)),
  );
  if (scope.pack) sources.push(await sourceRevision("pack", scope.pack.path));
  const changes: SyncChange[] = [
    ...(recovery ? [change(scope.scope, "recover", root)] : []),
    ...parents.missing.map((path) => change(scope.scope, "create-directory", path)),
    ...operations.flatMap((operation) => operation.changes),
  ];
  if (
    changes.length ||
    (snapshot.document &&
      JSON.stringify({ ...currentData, sources }) !== JSON.stringify(withoutPending(rawData)))
  )
    changes.push(change(scope.scope, "write-receipt", snapshot.path));
  return {
    options,
    scope,
    snapshot,
    receiptOptions,
    data: currentData,
    sources,
    ...(recovery ? { recovery } : {}),
    directories: parents.directories,
    missingDirectories: parents.missing,
    operations,
    plan: {
      scope: scope.scope,
      root: scope.root,
      activationRoot: root,
      mode: scope.mode,
      skills: scope.bindings.map(({ name, path }) => ({ name, path })),
      receiptPath: snapshot.path,
      changes,
    },
  };
}

/** Read-only internal preparation; callers must not retain it across lock acquisitions. */
export async function prepareSyncUnlocked(options: SyncOptions = {}): Promise<PreparedSync> {
  checkCancelled(options);
  const resolved = await resolveSelection(options);
  checkCancelled(options);
  if (!resolved.ok || !resolved.data)
    throw new SkillexError(
      resolved.exit,
      resolved.findings.length
        ? resolved.findings
        : [
            {
              code: "E_INCOMPLETE_RESOLUTION",
              severity: "error",
              message: "Selection is incomplete; activation was preserved.",
              fix: "Correct the selection before syncing.",
            },
          ],
    );
  const resolution = resolved.data;
  const selected = resolution.scopes.filter((scope) =>
    resolution.writeScopes.includes(scope.scope),
  );
  const forbiddenRoots = [
    ...new Set([
      ...resolution.scopes.map((scope) => scope.registry.root),
      ...selected.flatMap((scope) => [
        join(scope.root, ".agents"),
        ...(scope.scope === "project" ? [scope.root] : []),
        ...aliasPaths(scope.root, scope.scope).map(dirname),
      ]),
    ]),
  ];
  const scopes: ScopeWork[] = [];
  for (const scope of selected) {
    checkCancelled(options, scope.root);
    scopes.push(await buildScope(scope, options, forbiddenRoots));
  }
  checkCancelled(options);
  return {
    plan: {
      writeScopes: resolution.writeScopes,
      scopes: scopes.map((scope) => scope.plan),
      changes: scopes.flatMap((scope) => scope.plan.changes),
    },
    scopes,
    findings: resolved.findings,
    resolution,
  };
}

async function removeNode(path: string, node: OwnedNode): Promise<void> {
  if (!(await inspectOwnedNode(path, node, true))) return;
  if (node.identity.kind === "link") {
    await unlink(path);
    return;
  }
  for (const [name, child] of Object.entries(node.children ?? {})) {
    if (await requireIdentity(join(path, name), child, true)) await unlink(join(path, name));
  }
  await requireIdentity(path, node.identity);
  await rmdir(path);
}

async function checkParents(
  work: ScopeWork,
  path: string,
  directories: ReadonlyMap<string, EntryIdentity>,
): Promise<void> {
  let parent = dirname(path);
  while (within(parent, work.scope.root)) {
    const owned = directories.get(parent);
    if (!owned)
      refuse(
        parent,
        "A destination parent was not part of this operation's validated directory chain.",
      );
    await requireIdentity(parent, owned);
    if (parent === work.scope.root) return;
    parent = dirname(parent);
  }
  refuse(path, "Activation destination escaped its selected scope.");
}

async function recover(work: ScopeWork): Promise<void> {
  checkCancelled(work.options, work.plan.activationRoot);
  const recovery = work.recovery;
  if (!recovery) return;
  const { journal } = recovery;
  // Re-read and validate the entire pending boundary immediately before recovery.
  const current = await inspectRecovery(work.snapshot.document?.data ?? emptyData());
  if (!current || current.published !== recovery.published || current.restore !== recovery.restore)
    refuse(
      journal.path,
      "Interrupted activation state changed during recovery preflight.",
      "E_OWNERSHIP_CHANGED",
    );
  for (const [path, expected] of work.directories)
    await requireIdentity(physicalPath(path, recovery), expected);
  if (recovery.restore) {
    if (await entry(journal.path))
      refuse(journal.path, "Foreign content blocks restoration of the parked root.");
    if (journal.previous) await inspectOwnedNode(journal.parked, journal.previous);
    await rename(journal.parked, journal.path);
  }
  if (journal.next && (await entry(journal.stage))) await removeNode(journal.stage, journal.next);
  if (journal.previous && (await entry(journal.parked)))
    await removeNode(journal.parked, journal.previous);
  await writeActivationReceipt(work.snapshot, recovery.data, work.receiptOptions);
}

async function stageNode(
  work: ScopeWork,
  operation: Operation,
  path: string,
): Promise<OwnedNode | undefined> {
  if (operation.children !== undefined) {
    await mkdir(path, { mode: 0o755 });
    const children: Record<string, EntryIdentity> = {};
    for (const [name, target] of operation.children) {
      const destination = join(operation.path, name);
      if ((await canonicalSkill(dirname(dirname(target)), name)) !== target)
        refuse(destination, "Canonical source changed during activation.");
      const child = join(path, name);
      await symlink(relative(dirname(destination), target), child);
      const found = await entry(child);
      if (!found) refuse(child, "Prepared activation link disappeared.");
      children[name] = identity(found);
    }
    const found = await entry(path);
    if (!found) refuse(path, "Prepared activation directory disappeared.");
    return { identity: identity(found), children };
  }
  if (operation.target !== undefined) {
    if (
      dirname(operation.path) === work.plan.activationRoot &&
      (await canonicalSkill(dirname(dirname(operation.target)), basename(operation.path))) !==
        operation.target
    )
      refuse(operation.path, "Canonical source changed during activation.");
    if (operation.path === work.plan.activationRoot && work.scope.mode === "pack")
      await verifyResolvedPack(work.scope, work.receiptOptions);
    await symlink(relative(dirname(operation.path), operation.target), path);
    const found = await entry(path);
    if (!found) refuse(path, "Prepared activation link disappeared.");
    return { identity: identity(found) };
  }
  return undefined;
}

async function verifyOperationSources(work: ScopeWork, operation: Operation): Promise<void> {
  for (const [name, target] of operation.children ?? []) {
    if ((await canonicalSkill(dirname(dirname(target)), name)) !== target)
      refuse(operation.path, "Canonical source changed before activation publication.");
  }
  if (operation.target === undefined) return;
  if (operation.path === work.plan.activationRoot && work.scope.mode === "pack")
    await verifyResolvedPack(work.scope, work.receiptOptions);
  else if (
    dirname(operation.path) === work.plan.activationRoot &&
    (await canonicalSkill(dirname(dirname(operation.target)), basename(operation.path))) !==
      operation.target
  )
    refuse(operation.path, "Canonical source changed before activation publication.");
}

async function executeScope(
  work: ScopeWork,
  state: ScopeExecution,
  phase: "add" | "remove",
  mark: (change?: SyncChange) => void,
): Promise<void> {
  let { snapshot, data } = state;
  const { directories } = state;
  const root = work.plan.activationRoot;
  checkCancelled(work.options, root);
  for (const [path, expected] of directories) await requireIdentity(path, expected);
  for (const path of phase === "add" ? work.missingDirectories : []) {
    checkCancelled(work.options, path);
    await checkParents(work, path, directories);
    if (await entry(path))
      refuse(path, "A previously absent destination parent appeared during sync.");
    await mkdir(path, { mode: 0o755 });
    mark(change(work.scope.scope, "create-directory", path));
    const found = await entry(path);
    if (!found?.info.isDirectory())
      refuse(path, "A created activation parent was replaced.", "E_OWNERSHIP_CHANGED");
    directories.set(path, identity(found));
  }
  const intent = createHash("sha256")
    .update(
      JSON.stringify({
        mode: work.scope.mode,
        bindings: work.scope.bindings.map(({ name, path }) => ({ name, path })),
        pack: work.scope.pack,
      }),
    )
    .digest("hex");
  for (const operation of work.operations.filter(
    (operation) =>
      (operation.target === undefined && operation.children === undefined) === (phase === "remove"),
  )) {
    checkCancelled(work.options, operation.path);
    await checkParents(work, operation.path, directories);
    if (operation.previous) await inspectOwnedNode(operation.path, operation.previous);
    else if (await entry(operation.path))
      refuse(operation.path, "A previously absent activation entry appeared during sync.");
    const id = randomUUID();
    const stage = join(dirname(root), `.skillex-tmp-${id}-new`);
    const parked = join(dirname(root), `.skillex-tmp-${id}-old`);
    if ((await entry(stage)) || (await entry(parked)))
      refuse(stage, "Activation staging paths are already occupied.");
    // Stage first, then journal the actual identities before publishing paths.
    mark();
    const next = await stageNode(work, operation, stage);
    const pending: ActivationJournal = {
      id,
      intent,
      path: operation.path,
      stage,
      parked,
      ...(operation.previous ? { previous: operation.previous } : {}),
      ...(next ? { next } : {}),
    };
    snapshot = await writeActivationReceipt(snapshot, { ...data, pending }, work.receiptOptions);
    // Cancellation begins only after prepared identities are durably journaled.
    checkCancelled(work.options, operation.path);
    await checkParents(work, operation.path, directories);
    await verifyOperationSources(work, operation);
    checkCancelled(work.options, operation.path);
    if (operation.previous) {
      await inspectOwnedNode(operation.path, operation.previous);
      if (await entry(parked)) refuse(parked, "Foreign content occupies the parked-root path.");
      await rename(operation.path, parked);
      await inspectOwnedNode(parked, operation.previous);
    } else if (await entry(operation.path))
      refuse(operation.path, "Foreign content appeared before activation publication.");
    if (next) {
      await inspectOwnedNode(stage, next);
      await verifyOperationSources(work, operation);
      checkCancelled(work.options, operation.path);
      if (await entry(operation.path))
        refuse(operation.path, "Foreign content blocks activation publication.");
      if (next.identity.kind === "link") {
        await link(stage, operation.path);
        await unlink(stage);
      } else await rename(stage, operation.path);
      await requireIdentity(operation.path, next.identity);
    }
    if (operation.previous) await removeNode(parked, operation.previous);
    data = replaceOwnership(data, operation.path, next);
    snapshot = await writeActivationReceipt(snapshot, data, work.receiptOptions);
    if (operation.path === root) {
      directories.delete(root);
      if (next?.identity.kind === "directory") directories.set(root, next.identity);
    }
    for (const completed of operation.changes) mark(completed);
  }
  if (phase === "remove" && work.plan.changes.length) {
    checkCancelled(work.options, root);
    mark();
    snapshot = await writeActivationReceipt(
      snapshot,
      { ...data, sources: work.sources },
      work.receiptOptions,
    );
    mark(change(work.scope.scope, "write-receipt", snapshot.path));
  }
  state.snapshot = snapshot;
  state.data = data;
}

/** Internal C06 boundary: caller holds the activation lock; this function re-resolves intent itself. */
export async function reconcileUnlocked(
  options: SyncOptions = {},
): Promise<ResultEnvelope<SyncResult | null>> {
  let prepared: PreparedSync | undefined;
  let wrote = false;
  const applied: SyncChange[] = [];
  const mark = (completed?: SyncChange) => {
    wrote = true;
    if (completed) applied.push(completed);
  };
  try {
    prepared = await prepareSyncUnlocked(options);
    for (const work of prepared.scopes) {
      if (work.recovery) {
        mark();
        await recover(work);
        mark(change(work.scope.scope, "recover", work.plan.activationRoot));
      }
    }
    if (applied.length) prepared = await prepareSyncUnlocked(options);
    const states = new Map(
      prepared.scopes.map((work) => [
        work,
        { snapshot: work.snapshot, data: work.data, directories: new Map(work.directories) },
      ]),
    );
    // No ordinary stale pruning starts until every selected scope has completed
    // its additions and replacements. A later-scope failure preserves old links.
    for (const phase of ["add", "remove"] as const) {
      for (const work of prepared.scopes) {
        const state = states.get(work);
        if (state && work.plan.changes.length) await executeScope(work, state, phase, mark);
      }
    }
    checkCancelled(options);
    return makeResult(
      "sync",
      { ...prepared.plan, dryRun: false, applied },
      { findings: prepared.findings },
    );
  } catch (error) {
    if (!wrote || !prepared) return errorResult("sync", error);
    const underlying = errorResult("sync", error);
    return makeResult(
      "sync",
      { ...prepared.plan, dryRun: false, applied },
      {
        exit: underlying.exit === ExitCode.INTERRUPTED ? ExitCode.INTERRUPTED : ExitCode.PARTIAL,
        findings: [
          ...underlying.findings,
          {
            code: "E_SYNC_PARTIAL",
            severity: "error",
            message:
              "Activation changes started but did not finish; the receipt journal records published ownership where available.",
            fix: "Rerun sync after correcting the reported error. Recovery verifies exact recorded identities and re-reads current manifests; unjournaled temporary entries require inspection and are never adopted or deleted automatically.",
            detail: applied.map((item) => `${item.action} ${item.path}`),
          },
        ],
      },
    );
  }
}

export async function planSync(
  options: SyncOptions = {},
): Promise<ResultEnvelope<SyncPlan | null>> {
  try {
    const prepared = await prepareSyncUnlocked(options);
    return makeResult("sync plan", prepared.plan, {
      exit: options.exitCode && prepared.plan.changes.length ? ExitCode.DRIFT : ExitCode.SUCCESS,
      findings: prepared.findings,
    });
  } catch (error) {
    return errorResult("sync plan", error);
  }
}

export async function sync(options: SyncOptions = {}): Promise<ResultEnvelope<SyncResult | null>> {
  try {
    checkCancelled(options);
    if (options.exitCode && !options.dryRun)
      fail("E_SYNC_OPTIONS", "--exit-code requires --dry-run when syncing.", {
        fix: "Use sync --dry-run --exit-code to check drift without writing.",
      });
    const initial = await prepareSyncUnlocked(options);
    if (options.dryRun || !initial.plan.changes.length)
      return makeResult(
        "sync",
        { ...initial.plan, dryRun: options.dryRun === true, applied: [] },
        {
          exit: options.exitCode && initial.plan.changes.length ? ExitCode.DRIFT : ExitCode.SUCCESS,
          findings: initial.findings,
        },
      );
    let outcome: ResultEnvelope<SyncResult | null> | undefined;
    try {
      return await withLock(
        lockResource,
        async () => {
          outcome = await reconcileUnlocked(options);
          return outcome;
        },
        options,
      );
    } catch (error) {
      if (error instanceof SkillexError && error.exit === ExitCode.LOCK_BUSY)
        checkCancelled(options);
      if (!outcome?.data) throw error;
      return makeResult("sync", outcome.data, {
        exit: ExitCode.PARTIAL,
        findings: [...outcome.findings, ...errorResult("sync", error).findings],
      });
    }
  } catch (error) {
    return errorResult("sync", error);
  }
}
