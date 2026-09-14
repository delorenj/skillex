import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Entry,
  entry,
  identity,
  lexicalTarget,
  matches,
  requireIdentity,
  within,
} from "./activation-ownership.js";
import type { ReceiptOptions } from "./activation-state.js";
import type { EntryIdentity, SourceRevision } from "./activation-types.js";
import { canonicalSkill } from "./composition.js";
import { diagnosticExit } from "./diagnostics.js";
import { fail, SkillexError } from "./error.js";
import { withLock } from "./lock.js";
import {
  assertProfileIdentity,
  checkProfileSignal,
  discoverProfile,
  normalizeProfileOptions,
} from "./profile-discovery.js";
import {
  type ProfileData,
  type ProfileJournal,
  type ProfileState,
  readProfileState,
  writeProfileState,
} from "./profile-state.js";
import type {
  ProfileCandidate,
  ProfileChange,
  ProfileLocalEntry,
  ProfileLocation,
  ProfileOptions,
  ProfileShowResult,
  ProfileSyncOptions,
  ProfileSyncResult,
} from "./profile-types.js";
import { sourceRevision } from "./reconciliation.js";
import { resolveSelection } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { ResolvedScope, SkillOrigin } from "./selection.js";

interface Desired {
  readonly name: string;
  readonly target: string;
  readonly registry: string;
  readonly origins: readonly SkillOrigin[];
  readonly winner: "global" | "project";
}
interface Projection {
  readonly project: string;
  readonly desired: readonly Desired[];
  readonly scopes: readonly ResolvedScope[];
  readonly sources: readonly SourceRevision[];
  readonly findings: readonly Diagnostic[];
}
interface ProfileWork {
  readonly profile: ProfileLocation;
  readonly state: ProfileState;
  readonly root: Entry | undefined;
  readonly projection: Projection;
  readonly next: ProfileData;
  readonly result: ProfileShowResult;
  readonly options: ProfileOptions;
}
export interface ProfileInspection {
  readonly result: ProfileShowResult;
  readonly findings: readonly Diagnostic[];
  readonly exit: ExitCode;
  readonly state: ProfileState | null;
  readonly work: ProfileWork | null;
}

function refused(code: Diagnostic["code"], message: string, path: string, fix: string): never {
  fail(code, message, { path, fix }, ExitCode.REFUSED);
}
function asFailure(error: unknown): SkillexError {
  return error instanceof SkillexError
    ? error
    : new SkillexError(ExitCode.FAILURE, [
        {
          code: "E_IO",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          fix: "Inspect the profile and state permissions, then retry the explicit profile command.",
        },
      ]);
}
function receiptOptions(
  profile: ProfileLocation,
  options: ProfileOptions,
  scopes: readonly ResolvedScope[] = [],
): ReceiptOptions {
  const normalized = normalizeProfileOptions(options);
  const { home, cwd } = normalized;
  const expanded = (value: string) =>
    resolve(
      cwd,
      value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
    );
  return {
    ...normalized,
    forbiddenRoots: [
      ...new Set([
        profile.root,
        join(home, ".agents"),
        ...(options.project ? [expanded(options.project)] : []),
        ...(options.registryRoot ? [expanded(options.registryRoot)] : []),
        ...scopes.flatMap((scope) => [
          scope.registry.root,
          ...(scope.scope === "project" ? [scope.root] : []),
        ]),
      ]),
    ],
  };
}

async function resolveProjection(
  options: ProfileOptions & { project: string },
): Promise<Projection> {
  checkProfileSignal(options);
  const global = await resolveSelection({ ...options, scope: "global" });
  const project = await resolveSelection({ ...options, scope: "project" });
  const findings = [...global.findings, ...project.findings].filter(
    (finding, index, all) => all.findIndex((other) => isDeepStrictEqual(other, finding)) === index,
  );
  if (!global.ok || !project.ok || !global.data || !project.data)
    throw new SkillexError(
      diagnosticExit([global.exit, project.exit]),
      findings.length
        ? findings
        : [
            {
              code: "E_PROFILE_RESOLUTION",
              severity: "error",
              message: "Profile selection could not be resolved completely.",
              fix: "Correct the global and explicit project manifests before syncing the profile.",
            },
          ],
    );
  const globalScope = global.data.scopes.find((scope) => scope.scope === "global");
  const projectScope = project.data.scopes.find((scope) => scope.scope === "project");
  if (!globalScope || !projectScope)
    fail("E_PROJECT", "Profile sync requires an explicit project manifest.", {
      fix: "Pass --project PATH for the intended project containing .agents/skills.json.",
    });
  const scopes = [globalScope, projectScope];
  const desired = new Map<string, Desired>();
  for (const scope of scopes)
    for (const binding of scope.bindings) {
      const previous = desired.get(binding.name);
      if (previous && previous.target !== binding.path)
        refused(
          "E_DIVERGENT_CANONICAL_NAME",
          `Canonical name ${binding.name} resolves to different global and project definitions.`,
          binding.path,
          "Use one canonical definition for this name; profile-local shadows do not resolve canonical divergence.",
        );
      const origins = [...(previous?.origins ?? []), ...binding.origins].filter(
        (origin, index, all) =>
          all.findIndex((other) => isDeepStrictEqual(other, origin)) === index,
      );
      const winner =
        [...origins].reverse().find((origin) => origin.kind !== "inherit")?.scope ?? scope.scope;
      desired.set(binding.name, {
        name: binding.name,
        target: binding.path,
        registry: scope.registry.root,
        origins,
        winner,
      });
    }
  const locations = new Map<string, SourceRevision["kind"]>();
  for (const scope of scopes) {
    locations.set(join(scope.registry.root, "all-skills"), "catalog");
    if (scope.pack) locations.set(scope.pack.path, "pack");
  }
  const sources: SourceRevision[] = [];
  for (const [path, kind] of locations) sources.push(await sourceRevision(kind, path));
  checkProfileSignal(options);
  return {
    project: projectScope.root,
    scopes,
    desired: [...desired.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sources,
    findings,
  };
}

async function observations(
  profile: ProfileLocation,
  state: ProfileState | null,
): Promise<{ root: Entry | undefined; entries: Map<string, Entry>; local: ProfileLocalEntry[] }> {
  const root = await entry(profile.skillsRoot);
  const entries = new Map<string, Entry>();
  const local: ProfileLocalEntry[] = [];
  if (root && !root.info.isDirectory())
    refused(
      "E_PROFILE_SKILLS_ROOT",
      "The profile skills root must remain a real directory.",
      profile.skillsRoot,
      "Use the explicit migrate workflow to replace this whole-root alias or conflicting file while preserving profile content.",
    );
  if (root)
    for (const name of (await readdir(profile.skillsRoot)).sort()) {
      const path = join(profile.skillsRoot, name);
      const actual = await entry(path);
      if (!actual) continue;
      entries.set(name, actual);
      const pending = state?.data.pending;
      if (
        (pending?.stage === path && pending.next && matches(actual, pending.next)) ||
        (pending?.parked === path && pending.previous && matches(actual, pending.previous)) ||
        (pending?.name === name && pending.next && matches(actual, pending.next))
      )
        continue;
      if (owned(actual, state ? claim(state.data.links, name) : undefined)) continue;
      let target: string | null = null;
      if (actual.info.isSymbolicLink()) {
        try {
          target = await realpath(path);
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
        }
      }
      local.push({
        name,
        path,
        kind: actual.info.isDirectory()
          ? "directory"
          : actual.info.isFile()
            ? "file"
            : actual.info.isSymbolicLink()
              ? "symlink"
              : "other",
        rawTarget: actual.raw ?? null,
        target,
        shadows: false,
      });
    }
  if (root) await requireIdentity(profile.skillsRoot, identity(root));
  return { root, entries, local };
}

function owned(actual: Entry | undefined, claim: EntryIdentity | undefined): boolean {
  return !!claim && matches(actual, claim);
}
function claim(
  links: Readonly<Record<string, EntryIdentity>>,
  name: string,
): EntryIdentity | undefined {
  return Object.hasOwn(links, name) ? links[name] : undefined;
}

function recoveryArtifacts(local: readonly ProfileLocalEntry[]): Diagnostic[] {
  return local
    .filter((item) => /^\.skillex-tmp-profile-[a-f0-9-]+-(?:new|old)$/.test(item.name))
    .map((item) => ({
      code: "W_PROFILE_RECOVERY_PRESERVED",
      severity: "warning",
      path: item.path,
      message:
        "An unrecognized profile recovery artifact was preserved; no ownership was inferred from its name or target.",
      fix: "Inspect this exact entry and remove it explicitly when its content is no longer needed. Its presence remains a partial result until resolved.",
    }));
}
function readExit(findings: readonly Diagnostic[], pending = false): ExitCode {
  return pending || findings.some((finding) => finding.code === "W_PROFILE_RECOVERY_PRESERVED")
    ? ExitCode.PARTIAL
    : ExitCode.SUCCESS;
}

async function buildWork(
  profile: ProfileLocation,
  state: ProfileState,
  options: ProfileOptions & { project: string },
): Promise<ProfileWork> {
  const projection = await resolveProjection(options);
  for (const scope of projection.scopes) {
    for (const protectedRoot of [
      scope.registry.root,
      ...(scope.scope === "project" ? [scope.root] : [join(scope.root, ".agents")]),
    ])
      if (within(profile.skillsRoot, protectedRoot) || within(protectedRoot, profile.skillsRoot))
        refused(
          "E_PROFILE_DESTINATION_SOURCE",
          "The profile skills directory overlaps a selected source or activation directory.",
          profile.skillsRoot,
          "Select a profile whose real skills directory is separate from catalogs and global/project activation roots.",
        );
  }
  for (const desired of projection.desired)
    if (within(desired.target, profile.skillsRoot) || within(profile.skillsRoot, desired.target))
      refused(
        "E_PROFILE_RECURSIVE",
        "A projected canonical skill would create a recursive profile topology.",
        desired.target,
        "Move the profile skills directory outside canonical definitions before syncing.",
      );
  state = await readProfileState(profile, receiptOptions(profile, options, projection.scopes));
  const observed = await observations(profile, state);
  const links = { ...state.data.links };
  const changes: ProfileChange[] = [];
  if (!observed.root) changes.push({ action: "mkdir", path: profile.skillsRoot });
  for (const [name, claim] of Object.entries(links))
    if (!owned(observed.entries.get(name), claim)) {
      delete links[name];
      changes.push({ action: "release", name, path: join(profile.skillsRoot, name) });
    }
  const candidates: ProfileCandidate[] = [];
  const desiredNames = new Set(projection.desired.map((desired) => desired.name));
  for (const desired of projection.desired) {
    const path = join(profile.skillsRoot, desired.name);
    const actual = observed.entries.get(desired.name);
    const recorded = claim(links, desired.name);
    const state = actual
      ? recorded
        ? lexicalTarget(path, actual.raw ?? "") === desired.target
          ? "unchanged"
          : "update"
        : "shadowed"
      : "create";
    candidates.push({
      name: desired.name,
      path,
      target: desired.target,
      origins: desired.origins,
      state,
      winner: state === "shadowed" ? "profile" : desired.winner,
    });
    if (state === "create" || state === "update")
      changes.push({ action: state, name: desired.name, path, target: desired.target });
  }
  for (const name of Object.keys(links).sort())
    if (!desiredNames.has(name))
      changes.push({ action: "prune", name, path: join(profile.skillsRoot, name) });
  const next: ProfileData = {
    version: 1,
    root: observed.root ? identity(observed.root) : null,
    project: projection.project,
    sources: projection.sources,
    links,
  };
  if (changes.length || !isDeepStrictEqual(next, state.data))
    changes.push({ action: "write-receipt", path: state.snapshot.path });
  const result: ProfileShowResult = {
    profile,
    project: projection.project,
    receiptPath: state.snapshot.path,
    managed: candidates,
    preserved: observed.local.map((local) => ({ ...local, shadows: desiredNames.has(local.name) })),
    changes,
    pending: state.data.pending !== undefined,
  };
  await assertProfileIdentity(profile);
  return { profile, state, root: observed.root, projection, next, result, options };
}

/** Inspect existing profile content even when its source declarations cannot be resolved. */
export async function inspectProfile(
  profile: ProfileLocation,
  options: ProfileOptions = {},
): Promise<ProfileInspection> {
  const findings: Diagnostic[] = [];
  const exits: ExitCode[] = [];
  let state: ProfileState | null = null;
  let preserved: ProfileLocalEntry[] = [];
  try {
    options = normalizeProfileOptions(options);
    await assertProfileIdentity(profile);
    state = await readProfileState(profile, receiptOptions(profile, options));
  } catch (error) {
    const failure = asFailure(error);
    findings.push(...failure.findings);
    exits.push(failure.exit);
  }
  try {
    preserved = (await observations(profile, state)).local;
  } catch (error) {
    const failure = asFailure(error);
    findings.push(...failure.findings);
    exits.push(failure.exit);
  }
  const project = options.project ?? state?.data.project ?? null;
  let result: ProfileShowResult = {
    profile,
    project,
    receiptPath: state?.snapshot.path ?? null,
    managed: null,
    preserved,
    changes: state?.data.pending ? [{ action: "recover", path: profile.skillsRoot }] : [],
    pending: state?.data.pending !== undefined,
  };
  let work: ProfileWork | null = null;
  if (!exits.length && state && !state.data.pending && project) {
    try {
      work = await buildWork(profile, state, { ...options, project });
      result = work.result;
      findings.push(...work.projection.findings);
    } catch (error) {
      const failure = asFailure(error);
      findings.push(...failure.findings);
      exits.push(failure.exit);
    }
  }
  if (result.pending) {
    exits.push(ExitCode.PARTIAL);
    findings.push({
      code: "W_PROFILE_RECOVERY_PENDING",
      severity: "warning",
      message:
        "An interrupted profile update is pending; inspection leaves all content and state unchanged.",
      path: result.receiptPath ?? profile.skillsRoot,
      fix: "Run profile sync NAME --project PATH to recover recorded child operations and resolve current intent.",
    });
  }
  const artifacts = recoveryArtifacts(result.preserved);
  findings.push(...artifacts);
  if (artifacts.length) exits.push(ExitCode.PARTIAL);
  try {
    await assertProfileIdentity(profile);
  } catch (error) {
    const failure = asFailure(error);
    findings.push(...failure.findings);
    exits.push(failure.exit);
  }
  return { result, findings, exit: diagnosticExit(exits, result.changes.length > 0), state, work };
}

async function flush(path: string, expected: EntryIdentity): Promise<void> {
  await requireIdentity(path, expected);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!matches({ path, info: await handle.stat({ bigint: true }) }, expected))
      refused(
        "E_PROFILE_ROOT_CHANGED",
        "A profile directory changed before it could be synced.",
        path,
        "Inspect the real profile directory before retrying.",
      );
    await handle.sync();
    await requireIdentity(path, expected);
  } finally {
    await handle.close();
  }
}
async function absent(path: string): Promise<void> {
  if (await entry(path))
    refused(
      "E_PROFILE_CONTENT_CHANGED",
      "A profile entry appeared after preflight; it was preserved.",
      path,
      "Inspect the local entry and retry; profile-owned content always takes precedence.",
    );
}
async function rootGuard(profile: ProfileLocation, root: EntryIdentity): Promise<void> {
  await assertProfileIdentity(profile);
  if (!matches(await entry(profile.skillsRoot), root))
    refused(
      "E_PROFILE_ROOT_CHANGED",
      "The real profile skills directory changed during sync.",
      profile.skillsRoot,
      "Restore the recorded directory before retrying; profile sync never replaces it.",
    );
}
async function removeExact(
  path: string,
  expected: EntryIdentity,
  profile: ProfileLocation,
  root: EntryIdentity,
): Promise<void> {
  await rootGuard(profile, root);
  if (await requireIdentity(path, expected, true)) await unlink(path);
}

/** Recover only receipt-owned child links, never overwrite a local replacement or replay stale intent. */
async function recoverProfile(
  profile: ProfileLocation,
  state: ProfileState,
  options: ProfileOptions,
  mark: (change: ProfileChange) => void,
  findings: Diagnostic[],
): Promise<ProfileState> {
  const pending = state.data.pending;
  const root = state.data.root;
  if (!pending || !root) return state;
  checkProfileSignal(options);
  await rootGuard(profile, root);
  const path = join(profile.skillsRoot, pending.name);
  let current = await entry(path);
  const parked = await entry(pending.parked);
  const staged = await entry(pending.stage);
  const links = { ...state.data.links };
  delete links[pending.name];
  if (pending.next && matches(current, pending.next)) links[pending.name] = pending.next;
  else if (pending.previous && matches(current, pending.previous))
    links[pending.name] = pending.previous;
  else if (!current && pending.previous && matches(parked, pending.previous)) {
    await rootGuard(profile, root);
    await requireIdentity(pending.parked, pending.previous);
    await absent(path);
    await rename(pending.parked, path);
    current = await entry(path);
    links[pending.name] = pending.previous;
  }
  if (current && !claim(links, pending.name))
    findings.push({
      code: "W_PROFILE_LOCAL_OVERRIDE",
      severity: "warning",
      message:
        "A local profile replacement was preserved and its former managed claim was relinquished.",
      name: pending.name,
      path,
      fix: "Keep this local override or remove it explicitly before projecting that name again.",
    });
  for (const [temporary, expected, actual] of [
    [pending.stage, pending.next, staged],
    [pending.parked, pending.previous, await entry(pending.parked)],
  ] as const) {
    if (expected && matches(actual, expected))
      await removeExact(temporary, expected, profile, root);
    else if (actual)
      findings.push({
        code: "W_PROFILE_RECOVERY_PRESERVED",
        severity: "warning",
        message: "Unrecognized content at a recovery path was preserved.",
        path: temporary,
        fix: "Inspect this local recovery entry and remove it explicitly when it is no longer needed.",
      });
  }
  const data: ProfileData = {
    version: 1,
    root,
    project: state.data.project,
    sources: state.data.sources,
    links,
  };
  await flush(profile.skillsRoot, root);
  state = await writeProfileState(state, data);
  mark({ action: "recover", path: profile.skillsRoot });
  return state;
}

async function verifyIntent(work: ProfileWork): Promise<void> {
  const current = await resolveProjection({ ...work.options, project: work.projection.project });
  if (
    current.project !== work.projection.project ||
    !isDeepStrictEqual(
      current.scopes.map((scope) => [scope.registry.root, scope.manifest]),
      work.projection.scopes.map((scope) => [scope.registry.root, scope.manifest]),
    ) ||
    !isDeepStrictEqual(current.desired, work.projection.desired)
  )
    refused(
      "E_PROFILE_INTENT_CHANGED",
      "Global or project selection changed during profile preflight.",
      work.projection.project,
      "Retry profile sync to prepare the current declarations before writing any profile entry.",
    );
  await assertProfileIdentity(work.profile);
  if (work.root) await rootGuard(work.profile, identity(work.root));
  else await absent(work.profile.skillsRoot);
}

async function apply(
  work: ProfileWork,
  mark: (change: ProfileChange) => void,
  begin: () => void,
): Promise<ProfileState> {
  const { profile, options } = work;
  let state = work.state;
  let data = work.next;
  await verifyIntent(work);
  checkProfileSignal(options);
  if (!work.root) {
    await mkdir(profile.skillsRoot, { mode: 0o755 });
    mark({ action: "mkdir", path: profile.skillsRoot });
    const created = await entry(profile.skillsRoot);
    if (!created?.info.isDirectory())
      refused(
        "E_PROFILE_ROOT_CHANGED",
        "The newly created profile skills root changed unexpectedly.",
        profile.skillsRoot,
        "Inspect the profile skills root and retry.",
      );
    data = { ...data, root: identity(created) };
    await assertProfileIdentity(profile);
    const parent = await entry(profile.root);
    if (!parent?.info.isDirectory())
      refused(
        "E_PROFILE_ROOT_CHANGED",
        "The profile root is no longer a real directory.",
        profile.root,
        "Restore the profile root before retrying.",
      );
    await flush(profile.root, identity(parent));
  }
  const root = data.root;
  if (!root) throw new Error("Profile mutation requires a real skills directory.");
  let unpublishedStage: { path: string; identity: EntryIdentity } | undefined;
  try {
    // Record observed root/context and relinquish replaced children before publishing any new child claim.
    await rootGuard(profile, root);
    begin();
    state = await writeProfileState(state, data);
    for (const change of work.result.changes.filter((change) => change.action === "release"))
      mark(change);
    for (const change of work.result.changes.filter((change) =>
      ["create", "update", "prune"].includes(change.action),
    )) {
      checkProfileSignal(options);
      await rootGuard(profile, root);
      const name = change.name as string;
      const previous = claim(data.links, name);
      const actual = await entry(change.path);
      if (previous ? !matches(actual, previous) : actual !== undefined) {
        if (actual) {
          refused(
            "E_PROFILE_CONTENT_CHANGED",
            "A local profile entry appeared or replaced a managed child after preflight; it was preserved.",
            change.path,
            "Inspect this local override and retry profile sync to relinquish the former claim and report its winning origin.",
          );
        }
      }
      const id = randomUUID();
      const stage = join(profile.skillsRoot, `.skillex-tmp-profile-${id}-new`);
      const parked = join(profile.skillsRoot, `.skillex-tmp-profile-${id}-old`);
      await absent(stage);
      await absent(parked);
      let next: EntryIdentity | undefined;
      if (change.target) {
        const desired = work.projection.desired.find((item) => item.name === name);
        if (!desired || (await canonicalSkill(desired.registry, name)) !== change.target)
          refused(
            "E_PROFILE_SOURCE_CHANGED",
            "A canonical definition changed before profile publication.",
            change.target,
            "Restore the source definition and retry profile sync.",
          );
        await symlink(change.target, stage);
        const staged = await entry(stage);
        if (!staged?.info.isSymbolicLink() || staged.raw !== change.target)
          refused(
            "E_PROFILE_CONTENT_CHANGED",
            "The staged profile link changed unexpectedly.",
            stage,
            "Preserve this entry and retry after inspecting the profile.",
          );
        next = identity(staged);
        unpublishedStage = { path: stage, identity: next };
      }
      const pending: ProfileJournal = {
        id,
        name,
        stage,
        parked,
        ...(previous ? { previous } : {}),
        ...(next ? { next } : {}),
      };
      state = await writeProfileState(state, { ...data, pending });
      unpublishedStage = undefined;
      // Cancellation is safe only after the exact prepared inode is in the journal.
      checkProfileSignal(options);
      await rootGuard(profile, root);
      if (previous && (await requireIdentity(change.path, previous, true))) {
        await absent(parked);
        await rename(change.path, parked);
      }
      if (next) {
        const desired = work.projection.desired.find((item) => item.name === name) as Desired;
        if ((await canonicalSkill(desired.registry, name)) !== change.target)
          refused(
            "E_PROFILE_SOURCE_CHANGED",
            "The canonical skill is no longer valid at publication.",
            change.target as string,
            "Restore the canonical definition and retry profile sync.",
          );
        await requireIdentity(stage, next);
        await absent(change.path);
        await rootGuard(profile, root);
        await rename(stage, change.path);
      }
      mark(change);
      await flush(profile.skillsRoot, root);
      if (previous) await removeExact(parked, previous, profile, root);
      const links = { ...data.links };
      delete links[name];
      if (next) links[name] = next;
      data = { ...data, links };
      state = await writeProfileState(state, data);
    }
    checkProfileSignal(options);
    mark({ action: "write-receipt", path: state.snapshot.path });
    return state;
  } catch (error) {
    if (unpublishedStage) {
      try {
        const latest = await readProfileState(
          profile,
          receiptOptions(profile, options, work.projection.scopes),
        );
        const recorded = latest.data.pending;
        if (
          recorded?.stage !== unpublishedStage.path ||
          !isDeepStrictEqual(recorded.next, unpublishedStage.identity)
        )
          await removeExact(unpublishedStage.path, unpublishedStage.identity, profile, root);
      } catch {
        /* Keep unknown or journal-owned recovery material for explicit inspection. */
      }
    }
    throw error;
  }
}

export async function runProfileSync(
  name: string,
  options: ProfileSyncOptions,
): Promise<ResultEnvelope<ProfileSyncResult | null>> {
  let profile: ProfileLocation | null = null;
  let result: ProfileShowResult | null = null;
  let state: ProfileState | null = null;
  let started = false;
  const applied: ProfileChange[] = [];
  const findings: Diagnostic[] = [];
  const mark = (change: ProfileChange) => {
    started = true;
    applied.push(change);
  };
  try {
    checkProfileSignal(options);
    const normalized = normalizeProfileOptions(options);
    options = { ...options, home: normalized.home, cwd: normalized.cwd };
    if (typeof options.project !== "string" || !options.project.trim())
      fail("E_PROJECT", "Profile sync requires an explicit project path.", {
        fix: "Pass --project PATH; a recorded project or current working directory is never chosen implicitly for sync.",
      });
    if (options.dryRun !== undefined && typeof options.dryRun !== "boolean")
      fail("E_PROFILE_OPTIONS", "dryRun must be boolean.");
    profile = await discoverProfile(name, options);
    state = await readProfileState(profile, receiptOptions(profile, options));
    const observed = await observations(profile, state);
    let work: ProfileWork | null = null;
    if (state.data.pending) {
      result = {
        profile,
        project: state.data.project ?? options.project,
        receiptPath: state.snapshot.path,
        managed: null,
        preserved: observed.local,
        changes: [{ action: "recover", path: profile.skillsRoot }],
        pending: true,
      };
      findings.push(...recoveryArtifacts(observed.local));
      await assertProfileIdentity(profile);
    } else {
      work = await buildWork(profile, state, options);
      result = work.result;
      findings.push(...work.projection.findings, ...recoveryArtifacts(result.preserved));
    }
    if (options.dryRun) {
      if (state.data.pending)
        findings.push({
          code: "W_PROFILE_RECOVERY_PENDING",
          severity: "warning",
          message:
            "A recorded profile operation is pending; dry-run leaves its links and receipt unchanged.",
          path: state.snapshot.path,
          fix: "Run the explicit profile sync without --dry-run to recover and resolve current selections.",
        });
      return makeResult(
        "profile sync",
        {
          ...(result as ProfileShowResult),
          project: (result as ProfileShowResult).project as string,
          dryRun: true,
          applied,
        },
        { findings, exit: readExit(findings, state.data.pending !== undefined) },
      );
    }
    if (work && !work.result.changes.length)
      return makeResult(
        "profile sync",
        { ...work.result, project: work.projection.project, dryRun: false, applied },
        { findings, exit: readExit(findings) },
      );
    const selected = profile;
    const output = await withLock(
      `skillex:profiles:v2:${profile.skillsRoot}`,
      async () => {
        checkProfileSignal(options);
        await assertProfileIdentity(selected);
        state = await readProfileState(selected, receiptOptions(selected, options));
        if (state.data.pending)
          state = await recoverProfile(selected, state, options, mark, findings);
        work = await buildWork(selected, state, options);
        result = work.result;
        findings.push(
          ...[...work.projection.findings, ...recoveryArtifacts(work.result.preserved)].filter(
            (finding) => !findings.some((other) => isDeepStrictEqual(other, finding)),
          ),
        );
        if (work.result.changes.length) {
          state = await apply(work, mark, () => {
            started = true;
          });
        }
        await assertProfileIdentity(selected);
        const currentProfile = await discoverProfile(name, options);
        if (
          currentProfile.root !== selected.root ||
          currentProfile.skillsRoot !== selected.skillsRoot
        )
          refused(
            "E_PROFILE_ROOT_CHANGED",
            "The profile root changed after publication.",
            selected.root,
            "Inspect the profile root and retained receipt before retrying.",
          );
        return {
          ...work.result,
          profile: currentProfile,
          project: work.projection.project,
          pending: state.data.pending !== undefined,
          dryRun: false,
          applied,
        };
      },
      options,
    );
    return makeResult("profile sync", output, {
      findings,
      exit: findings.some((finding) => finding.code === "W_PROFILE_RECOVERY_PRESERVED")
        ? ExitCode.PARTIAL
        : ExitCode.SUCCESS,
    });
  } catch (error) {
    const failure = options.signal?.aborted
      ? new SkillexError(ExitCode.INTERRUPTED, [
          {
            code: "E_INTERRUPTED",
            severity: "error",
            message: "Profile operation interrupted.",
            fix: "Retry the explicit profile sync to recover recorded child operations and resolve current selections.",
          },
        ])
      : asFailure(error);
    if (profile) {
      try {
        const latest = await readProfileState(profile, receiptOptions(profile, options));
        const pending = latest.data.pending;
        if (pending) {
          const current = await entry(join(profile.skillsRoot, pending.name));
          if (
            pending.next &&
            matches(current, pending.next) &&
            !applied.some((change) => change.path === current?.path)
          )
            applied.push({
              action: pending.previous ? "update" : "create",
              name: pending.name,
              path: join(profile.skillsRoot, pending.name),
              target: pending.next.raw as string,
            });
          if (
            !pending.next &&
            !current &&
            pending.previous &&
            matches(await entry(pending.parked), pending.previous) &&
            !applied.some(
              (change) =>
                change.path === join((profile as ProfileLocation).skillsRoot, pending.name),
            )
          )
            applied.push({
              action: "prune",
              name: pending.name,
              path: join(profile.skillsRoot, pending.name),
            });
        }
        state = latest;
      } catch {
        /* Preserve the original failure and any inaccessible recovery evidence. */
      }
      if (!result)
        result = {
          profile,
          project: options.project,
          receiptPath: state?.snapshot.path ?? null,
          managed: null,
          preserved: [],
          changes: [],
          pending: state?.data.pending !== undefined,
        };
      try {
        const observed = await observations(profile, state);
        const desiredNames = new Set(result.managed?.map((candidate) => candidate.name) ?? []);
        const localNames = new Set(observed.local.map((local) => local.name));
        result = {
          ...result,
          preserved: observed.local.map((local) => ({
            ...local,
            shadows: desiredNames.has(local.name),
          })),
          managed:
            result.managed?.map((candidate) =>
              localNames.has(candidate.name)
                ? { ...candidate, state: "shadowed", winner: "profile" }
                : candidate,
            ) ?? null,
        };
        findings.push(
          ...recoveryArtifacts(result.preserved).filter(
            (finding) =>
              !findings.some((other) => other.code === finding.code && other.path === finding.path),
          ),
        );
      } catch {
        /* Keep the last safe observations if the profile topology is no longer inspectable. */
      }
    }
    return makeResult(
      "profile sync",
      result
        ? {
            ...result,
            project: result.project ?? options.project,
            pending: state?.data.pending !== undefined,
            dryRun: options.dryRun === true,
            applied,
          }
        : null,
      {
        exit:
          failure.exit === ExitCode.INTERRUPTED
            ? ExitCode.INTERRUPTED
            : started
              ? ExitCode.PARTIAL
              : failure.exit,
        findings: [
          ...findings,
          ...failure.findings,
          ...(started
            ? [
                {
                  code: "E_PROFILE_PARTIAL" as const,
                  severity: "error" as const,
                  message:
                    "Profile writes began; the applied list reports completed child operations and recovery evidence is retained.",
                  path: state?.snapshot.path ?? profile?.skillsRoot ?? "",
                  fix: "Retry profile sync NAME --project PATH. Local replacements are preserved, and recovery does not replay stale selections.",
                },
              ]
            : []),
        ],
      },
    );
  }
}
