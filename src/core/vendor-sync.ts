import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withCatalogLock } from "./catalog-lock.js";
import type { ContentEntry } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { isSkillName } from "./manifest.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import { readVendorGitSource, type VendorGitSkill, vendorInterrupted } from "./vendor-git.js";
import {
  digestVendorTree,
  readVendorProvenance,
  serializeVendorProvenance,
} from "./vendor-provenance.js";
import {
  normalizeVendorRepo,
  readVendorSources,
  resolveVendorCheckout,
  selectVendorSources,
} from "./vendor-sources.js";
import {
  assertVendorIdentity,
  assertVendorTree,
  captureVendorTree,
  clearVendorJournal,
  newVendorJournal,
  readVendorJournal,
  removeVendorTree,
  type VendorJournalSnapshot,
  type VendorOperation,
  type VendorTreeEvidence,
  vendorIdentity,
  vendorLstat,
  writeVendorJournal,
} from "./vendor-state.js";
import type {
  VendorChange,
  VendorProvenance,
  VendorSource,
  VendorSourceResolution,
  VendorSourcesManifest,
  VendorSyncOptions,
  VendorSyncResult,
} from "./vendor-types.js";

interface PlannedSkill {
  readonly change: VendorChange;
  readonly before: VendorTreeEvidence | null;
  readonly entries: readonly ContentEntry[];
}

interface PreparedVendor {
  readonly manifest: VendorSourcesManifest;
  readonly result: VendorSyncResult;
  readonly plans: readonly PlannedSkill[];
  readonly findings: readonly Diagnostic[];
  readonly journal: VendorJournalSnapshot;
}

function refuse(code: Diagnostic["code"], message: string, path: string, fix: string): never {
  fail(code, message, { path, fix }, ExitCode.REFUSED);
}

function attributed(provenance: VendorProvenance, source: VendorSource): boolean {
  return (
    provenance.type === "vendored" &&
    provenance.source === source.name &&
    provenance.upstream !== null &&
    normalizeVendorRepo(provenance.upstream) === normalizeVendorRepo(source.repo)
  );
}

function baseline(provenance: VendorProvenance): boolean {
  return (
    provenance.digest !== null &&
    (provenance.digestFormat === null ||
      ["skillex-tree-v1", "skillex-tree-v1+symlinks"].includes(provenance.digestFormat))
  );
}

async function planSkill(
  source: VendorSource,
  skill: VendorGitSkill,
  commit: string,
  extractedAt: string,
  catalog: string,
  options: VendorSyncOptions,
): Promise<PlannedSkill> {
  const path = join(catalog, skill.name);
  const info = await vendorLstat(path);
  let before: VendorTreeEvidence | null = null;
  let provenance: VendorProvenance | null = null;
  let action: VendorChange["action"] = "create";
  if (info) {
    if (info.isSymbolicLink())
      refuse(
        "E_VENDOR_DESTINATION_LINK",
        "Vendor sync will not replace a linked canonical destination.",
        path,
        "Use the explicit migrate workflow to account for this link and its consumers before vendoring.",
      );
    if (!info.isDirectory())
      refuse(
        "E_VENDOR_DESTINATION_TYPE",
        "The canonical destination is not a real skill directory.",
        path,
        "Preserve the conflicting content and move it explicitly before retrying.",
      );
    provenance = await readVendorProvenance(path);
    const digest = await digestVendorTree(path);
    if (provenance?.type === "vendored") {
      if (!attributed(provenance, source))
        refuse(
          "E_VENDOR_FOREIGN_SOURCE",
          "The canonical skill is attributed to a different source.",
          path,
          "Correct the declaration or migrate the existing provenance explicitly; adopt does not transfer another vendor's ownership.",
        );
      if (!baseline(provenance) && !options.discardLocalEdits)
        refuse(
          "E_VENDOR_BASELINE_MISSING",
          "The managed skill has no supported baseline digest proving unchanged content.",
          path,
          "Preserve or commit local content, then explicitly use --discard-local-edits to replace this attributed skill; it cannot be implicitly pruned.",
        );
      if (
        baseline(provenance) &&
        (digest !== provenance.digest || provenance.modifiedLocally) &&
        !options.discardLocalEdits
      )
        refuse(
          "E_VENDOR_LOCAL_EDITS",
          "The vendored skill has local content or executable-mode edits.",
          path,
          "Preserve the local changes, then pass --discard-local-edits if replacing them is intended.",
        );
      action =
        digest === skill.digest &&
        !provenance.modifiedLocally &&
        provenance.digest === skill.digest &&
        provenance.upstreamCommit === commit &&
        provenance.upstreamTree === skill.tree &&
        provenance.upstreamPath === skill.upstreamPath &&
        provenance.upstreamVersion === source.version &&
        provenance.extractedAt !== null &&
        baseline(provenance)
          ? "unchanged"
          : "update";
    } else {
      if (!options.adopt)
        refuse(
          "E_VENDOR_UNMANAGED",
          "The canonical skill is not managed by this vendor source.",
          path,
          "Use --adopt to record ownership; if bytes or modes differ from upstream, also use --discard-local-edits after preserving them.",
        );
      if (digest !== skill.digest && !options.discardLocalEdits)
        refuse(
          "E_VENDOR_LOCAL_EDITS",
          "Adopting this skill would replace local bytes or executable modes.",
          path,
          "Preserve the differences, then explicitly pass both --adopt and --discard-local-edits to replace them.",
        );
      action = "adopt";
    }
    before = await captureVendorTree(path);
    if (before.root.dev !== String((await lstat(catalog, { bigint: true })).dev))
      refuse(
        "E_VENDOR_CROSS_DEVICE",
        "The existing skill is mounted on a different filesystem from catalog staging.",
        path,
        "Move the skill into the catalog filesystem before updating it; vendor replacement requires same-filesystem renames.",
      );
    if (before.root.dev !== String(info.dev) || before.root.ino !== String(info.ino))
      refuse(
        "E_VENDOR_CHANGED",
        "The destination changed during preflight.",
        path,
        "Wait for other catalog writers to finish and retry.",
      );
  }
  const prior = provenance?.raw.previous_provenance;
  const previousProvenance =
    skill.previousProvenance ??
    (provenance?.type !== "vendored"
      ? provenance?.raw
      : prior && typeof prior === "object" && !Array.isArray(prior)
        ? (prior as Readonly<Record<string, unknown>>)
        : undefined);
  const receipt = serializeVendorProvenance({
    source,
    commit,
    tree: skill.tree,
    upstreamPath: skill.upstreamPath,
    digest: skill.digest,
    extractedAt,
    ...(previousProvenance ? { previousProvenance } : {}),
  });
  return {
    change: {
      action,
      name: skill.name,
      source: source.name,
      path,
      commit,
      tree: skill.tree,
      upstreamPath: skill.upstreamPath,
      digest: skill.digest,
    },
    before,
    entries: [
      ...skill.entries,
      { path: ".source.yaml", kind: "file", mode: 0o644, bytes: Buffer.from(receipt) },
    ],
  };
}

async function prepare(options: VendorSyncOptions, extractedAt: string): Promise<PreparedVendor> {
  vendorInterrupted(options);
  const manifest = await readVendorSources(options);
  const catalog = join(manifest.registry.root, "all-skills");
  const journal = await readVendorJournal(manifest.registry, options);
  const selected = selectVendorSources(manifest, options.sources);
  const sources: VendorSourceResolution[] = [];
  const plans: PlannedSkill[] = [];
  const findings: Diagnostic[] = [];
  const enumerated = new Map<string, VendorSource>();
  const names = new Map<string, string>();
  for (const source of selected) {
    const checkout = await resolveVendorCheckout(source, options);
    if (!checkout.root) {
      if (!source.optional)
        refuse(
          "E_SOURCE_CHECKOUT_MISSING",
          `Local checkout ${source.checkout} is unavailable.`,
          manifest.path,
          "Supply --checkout ID=PATH or configure the local source mapping; vendor sync never clones or fetches.",
        );
      sources.push({
        name: source.name,
        checkout: null,
        commit: null,
        refKind: null,
        skipped: true,
      });
      findings.push({
        code: "W_OPTIONAL_SKIPPED",
        severity: "warning",
        message: `Optional source ${source.name} has no available local checkout; its existing skills are preserved.`,
        name: source.name,
        path: manifest.path,
        detail: checkout.searched,
        fix: "Make its local checkout available and run vendor sync again; absence never authorizes pruning.",
      });
      continue;
    }
    const upstream = await readVendorGitSource(source, checkout.root, options);
    sources.push({
      name: source.name,
      checkout: upstream.checkout,
      commit: upstream.commit,
      refKind: upstream.refKind,
      skipped: false,
    });
    enumerated.set(source.name, source);
    if (upstream.refKind === "branch")
      findings.push({
        code: "W_SOURCE_UNPINNED",
        severity: "warning",
        name: source.name,
        message: `Source ${source.name} follows a mutable local branch; this import records ${upstream.commit}.`,
        path: manifest.path,
        fix: "Use a commit ID in sources.toml when a fixed upstream snapshot is required.",
      });
    if (
      upstream.origin &&
      normalizeVendorRepo(upstream.origin) !== normalizeVendorRepo(source.repo)
    )
      findings.push({
        code: "W_SOURCE_REMOTE_MISMATCH",
        severity: "warning",
        message: `Checkout origin differs from declared repository for ${source.name}.`,
        name: source.name,
        path: upstream.checkout,
        fix: "Verify this is the intended local repository and correct its mapping or source declaration.",
      });
    for (const skill of upstream.skills) {
      if (names.has(skill.name))
        refuse(
          "E_VENDOR_DUPLICATE_SKILL",
          `Sources ${names.get(skill.name)} and ${source.name} select the same canonical skill.`,
          manifest.path,
          "Give each canonical name exactly one declared upstream owner.",
        );
      names.set(skill.name, source.name);
      plans.push(await planSkill(source, skill, upstream.commit, extractedAt, catalog, options));
    }
  }
  if (options.prune) {
    for (const name of (await readdir(catalog)).filter(isSkillName).sort()) {
      if (names.has(name)) continue;
      const path = join(catalog, name);
      if (!(await vendorLstat(path))?.isDirectory()) continue;
      let provenance: VendorProvenance | null;
      try {
        provenance = await readVendorProvenance(path);
      } catch (error) {
        if (!(error instanceof SkillexError)) throw error;
        findings.push({
          code: "W_VENDOR_PRUNE_UNVERIFIED",
          severity: "warning",
          message:
            "Preserved a catalog skill whose provenance could not establish a selected owner.",
          name,
          path,
          fix: "Inspect and correct its provenance before considering explicit pruning.",
        });
        continue;
      }
      const source = provenance?.source ? enumerated.get(provenance.source) : undefined;
      if (!provenance || !source || !attributed(provenance, source)) continue;
      if (!baseline(provenance))
        refuse(
          "E_VENDOR_BASELINE_MISSING",
          "An orphaned managed skill has no supported baseline proving it is safe to prune.",
          path,
          "Restore its verified provenance or remove it explicitly after inspection; --discard-local-edits never authorizes pruning unknown content.",
        );
      if (provenance.modifiedLocally || (await digestVendorTree(path)) !== provenance.digest)
        refuse(
          "E_VENDOR_LOCAL_EDITS",
          "An orphaned managed skill has local edits and cannot be pruned.",
          path,
          "Preserve or remove the orphan explicitly; vendor prune only removes unchanged attributed content.",
        );
      plans.push({
        change: { action: "prune", name, source: source.name, path },
        before: await captureVendorTree(path),
        entries: [],
      });
    }
  }
  plans.sort(
    (a, b) =>
      Number(a.change.action === "prune") - Number(b.change.action === "prune") ||
      a.change.name.localeCompare(b.change.name),
  );
  vendorInterrupted(options);
  return {
    manifest,
    journal,
    plans,
    findings,
    result: {
      registry: manifest.registry,
      manifest: manifest.path,
      dryRun: options.dryRun === true,
      sources,
      changes: plans.map((plan) => plan.change),
      applied: [],
    },
  };
}

async function absent(path: string): Promise<void> {
  if (await vendorLstat(path))
    refuse(
      "E_VENDOR_CHANGED",
      "A destination or recovery path appeared after preflight.",
      path,
      "Inspect the conflicting entry and retry after other writers finish; it is never overwritten.",
    );
}

/** Only the selected declaration and local mapping are intent; captured immutable Git objects stay pinned. */
async function assertCurrentIntent(
  prepared: PreparedVendor,
  options: VendorSyncOptions,
): Promise<void> {
  const current = await readVendorSources(options);
  const selected = selectVendorSources(current, options.sources);
  const expected = selectVendorSources(prepared.manifest, options.sources);
  if (
    current.registry.root !== prepared.manifest.registry.root ||
    JSON.stringify(selected) !== JSON.stringify(expected)
  )
    refuse(
      "E_VENDOR_INTENT_CHANGED",
      "The selected vendor declarations changed during staging.",
      prepared.manifest.path,
      "Run vendor sync again to recover staged content and prepare the current source declarations.",
    );
  for (const source of selected) {
    const checkout = await resolveVendorCheckout(source, options);
    const previous = prepared.result.sources.find((entry) => entry.name === source.name);
    if (!previous || checkout.root !== previous.checkout)
      refuse(
        "E_VENDOR_INTENT_CHANGED",
        "A selected local checkout mapping changed during staging.",
        prepared.manifest.path,
        "Verify the current checkout mapping and retry vendor sync to prepare that source again.",
      );
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stage(
  plan: PlannedSkill,
  path: string,
  catalog: string,
  options: VendorSyncOptions,
): Promise<VendorTreeEvidence> {
  await absent(path);
  await mkdir(path, { mode: 0o700 });
  const root = vendorIdentity(await lstat(path, { bigint: true }));
  const parents = new Map([["", root]]);
  for (const entry of plan.entries) {
    vendorInterrupted(options);
    await assertVendorIdentity(path, root);
    const target = join(path, entry.path);
    let parent = dirname(entry.path);
    while (parent !== ".") {
      const identity = parents.get(parent);
      if (!identity) throw new Error(`Unprepared vendor content parent: ${parent}`);
      await assertVendorIdentity(join(path, parent), identity);
      parent = dirname(parent);
    }
    if (entry.kind === "directory") {
      await mkdir(target, { mode: 0o755 });
      await chmod(target, 0o755);
      parents.set(entry.path, vendorIdentity(await lstat(target, { bigint: true })));
    } else if (entry.kind === "file") {
      const handle = await open(target, "wx", entry.mode);
      try {
        await handle.writeFile(entry.bytes);
        await handle.chmod(entry.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else throw new Error("Git extraction must not produce symbolic links.");
  }
  await assertVendorIdentity(path, root);
  await chmod(path, 0o755);
  await syncDirectory(path);
  await syncDirectory(catalog);
  const evidence = await captureVendorTree(path);
  if ((await digestVendorTree(path)) !== plan.change.digest)
    throw new Error("Staged skill digest does not match the pinned committed content.");
  return evidence;
}

async function recover(
  snapshot: VendorJournalSnapshot,
  findings: Diagnostic[],
  options: VendorSyncOptions,
  onWrite: () => void,
): Promise<void> {
  const journal = snapshot.document;
  if (!journal) return;
  vendorInterrupted(options);
  const catalogIdentity = vendorIdentity(await lstat(snapshot.catalog, { bigint: true }));
  if (journal.phase === "preparing") {
    for (const operation of journal.operations) {
      if (!operation.stage || !(await vendorLstat(operation.stage))) continue;
      if (operation.after) {
        onWrite();
        await removeVendorTree(operation.stage, operation.after);
      } else
        findings.push({
          code: "W_VENDOR_STAGING_PRESERVED",
          severity: "warning",
          message:
            "Preserved a staging directory interrupted before complete ownership evidence was recorded.",
          path: operation.stage,
          fix: "Inspect this hidden recovery directory and remove it explicitly when its content is no longer needed.",
        });
    }
  } else {
    // Classify every entry before recovery writes, so foreign interference refuses as a unit.
    const states: { operation: VendorOperation; published: boolean; parked: boolean }[] = [];
    for (const operation of journal.operations) {
      const destination = await vendorLstat(operation.change.path);
      const parked = operation.parked ? await vendorLstat(operation.parked) : null;
      const stageInfo = operation.stage ? await vendorLstat(operation.stage) : null;
      const published =
        !!operation.after &&
        !!destination &&
        String(destination.dev) === operation.after.root.dev &&
        String(destination.ino) === operation.after.root.ino;
      if (published) {
        await assertVendorTree(operation.change.path, operation.after as VendorTreeEvidence);
        if (stageInfo)
          refuse(
            "E_VENDOR_RECOVERY_CONFLICT",
            "Both the staged and published paths exist for one prepared skill.",
            operation.change.path,
            "Inspect both paths and the journal before retrying; foreign content is preserved.",
          );
      } else if (destination) {
        if (!operation.before)
          refuse(
            "E_VENDOR_RECOVERY_CONFLICT",
            "A foreign destination blocks vendor recovery.",
            operation.change.path,
            "Preserve and inspect this destination before retrying vendor sync.",
          );
        await assertVendorTree(operation.change.path, operation.before);
        if (parked)
          refuse(
            "E_VENDOR_RECOVERY_CONFLICT",
            "Both the old destination and its parked path exist.",
            operation.change.path,
            "Inspect the journal and both directories before retrying.",
          );
      } else if (!parked && operation.before) {
        // A fully published prune can have finished cleanup before its journal was cleared.
        if (operation.change.action !== "prune")
          refuse(
            "E_VENDOR_RECOVERY_CONFLICT",
            "The old and new skill directories are both missing.",
            operation.change.path,
            "Restore the retained recovery material before retrying.",
          );
      }
      if (parked && operation.parked && operation.before)
        await assertVendorTree(
          operation.parked,
          operation.before,
          published || operation.change.action === "prune",
        );
      if (stageInfo && operation.stage && operation.after)
        await assertVendorTree(operation.stage, operation.after, true);
      states.push({ operation, published, parked: !!parked });
    }
    for (const { operation, published, parked } of states) {
      vendorInterrupted(options);
      await assertVendorIdentity(snapshot.catalog, catalogIdentity);
      onWrite();
      if (parked && operation.parked && operation.before) {
        if (published) await removeVendorTree(operation.parked, operation.before);
        else if (operation.change.action === "prune") {
          // A partially cleaned prune cannot be restored as a complete skill; finish only exact remnants.
          try {
            await assertVendorTree(operation.parked, operation.before);
          } catch (error) {
            if (!(error instanceof SkillexError)) throw error;
            await removeVendorTree(operation.parked, operation.before);
            continue;
          }
          await absent(operation.change.path);
          await rename(operation.parked, operation.change.path);
        } else {
          await assertVendorTree(operation.parked, operation.before);
          await absent(operation.change.path);
          await rename(operation.parked, operation.change.path);
        }
      }
      if (!published && operation.stage && operation.after)
        await removeVendorTree(operation.stage, operation.after);
    }
  }
  onWrite();
  await clearVendorJournal(snapshot);
  findings.push({
    code: "I_VENDOR_RECOVERED",
    severity: "info",
    message:
      "Recovered the interrupted catalog update; current source declarations will be resolved again.",
    path: snapshot.path,
  });
}

/** Offline canonical-content writer; composition and activation links are owned by their existing APIs. */
export async function syncVendorSources(
  options: VendorSyncOptions = {},
): Promise<ResultEnvelope<VendorSyncResult | null>> {
  let prepared: PreparedVendor | null = null;
  let started = false;
  let applied: VendorChange[] = [];
  let findings: Diagnostic[] = [];
  let registry: RegistrySelection | null = null;
  let fallback: VendorSyncResult | null = null;
  let initiallyPending = false;
  const extractedAt = new Date().toISOString();
  try {
    for (const key of ["dryRun", "adopt", "discardLocalEdits", "prune"] as const)
      if (options[key] !== undefined && typeof options[key] !== "boolean")
        fail("E_VENDOR_OPTIONS", `${key} must be boolean.`, {
          fix: "Pass boolean vendor mutation options.",
        });
    vendorInterrupted(options);
    registry = await discoverRegistry(options);
    const initialJournal = await readVendorJournal(registry, options);
    initiallyPending = initialJournal.document !== null;
    fallback = {
      registry,
      manifest: join(registry.root, "all-skills", "sources.toml"),
      dryRun: options.dryRun === true,
      sources: [],
      changes: [],
      applied: [],
    };
    if (!initiallyPending || options.dryRun) {
      prepared = await prepare(options, extractedAt);
      findings = [...prepared.findings];
    }
    if (options.dryRun) {
      if (initiallyPending)
        findings.push({
          code: "W_VENDOR_RECOVERY_PENDING",
          severity: "warning",
          message:
            "An interrupted vendor update is pending; dry-run leaves its journal and content unchanged.",
          path: initialJournal.path,
          fix: "Run vendor sync without --dry-run to recover, then inspect the fresh plan.",
        });
      return makeResult("vendor sync", (prepared as PreparedVendor).result, {
        findings,
        exit: findings.some(
          (finding) =>
            finding.code === "W_OPTIONAL_SKIPPED" ||
            finding.code === "W_VENDOR_RECOVERY_PENDING" ||
            finding.code === "W_VENDOR_PRUNE_UNVERIFIED",
        )
          ? ExitCode.PARTIAL
          : ExitCode.SUCCESS,
      });
    }
    if (
      prepared &&
      !initiallyPending &&
      prepared.plans.every((plan) => plan.change.action === "unchanged")
    )
      return makeResult("vendor sync", prepared.result, {
        findings,
        exit: findings.some(
          (finding) =>
            finding.code === "W_OPTIONAL_SKIPPED" || finding.code === "W_VENDOR_PRUNE_UNVERIFIED",
        )
          ? ExitCode.PARTIAL
          : ExitCode.SUCCESS,
      });
    const initialRoot = registry.root;
    const result = await withCatalogLock(
      registry,
      { ...options, allowPendingVendor: true },
      async () => {
        vendorInterrupted(options);
        let journal = await readVendorJournal(registry as RegistrySelection, options);
        if (journal.document) {
          await recover(journal, findings, options, () => {
            started = true;
          });
        }
        prepared = await prepare(options, extractedAt);
        if (prepared.manifest.registry.root !== initialRoot)
          refuse(
            "E_CATALOG_CHANGED",
            "Registry discovery changed while waiting for its catalog lock.",
            initialRoot,
            "Select the intended registry explicitly and retry.",
          );
        findings = [
          ...findings.filter(
            (finding) =>
              finding.code === "I_VENDOR_RECOVERED" ||
              finding.code === "W_VENDOR_STAGING_PRESERVED",
          ),
          ...prepared.findings,
        ];
        const plans = prepared.plans.filter((plan) => plan.change.action !== "unchanged");
        if (!plans.length) return prepared.result;
        journal = prepared.journal;
        const catalogIdentity = vendorIdentity(await lstat(journal.catalog, { bigint: true }));
        const operations: VendorOperation[] = plans.map((plan) => {
          const id = randomUUID();
          return {
            change: plan.change,
            before: plan.before,
            after: null,
            stage:
              plan.change.action === "prune"
                ? null
                : join(journal.catalog, `.skillex-tmp-vendor-${id}-new`),
            parked: plan.before ? join(journal.catalog, `.skillex-tmp-vendor-${id}-old`) : null,
          };
        });
        vendorInterrupted(options);
        journal = await writeVendorJournal(journal, newVendorJournal(journal.catalog, operations));
        started = true;
        for (let index = 0; index < operations.length; index++) {
          const operation = operations[index] as VendorOperation;
          if (!operation.stage) continue;
          await assertVendorIdentity(journal.catalog, catalogIdentity);
          const after = await stage(
            plans[index] as PlannedSkill,
            operation.stage,
            journal.catalog,
            options,
          );
          operations[index] = { ...operation, after };
          journal = await writeVendorJournal(
            journal,
            newVendorJournal(journal.catalog, operations),
          );
        }
        vendorInterrupted(options);
        await assertCurrentIntent(prepared, options);
        // Revalidate every destination and every fully staged definition before the first replacement.
        for (const operation of operations) {
          if (operation.before) await assertVendorTree(operation.change.path, operation.before);
          else await absent(operation.change.path);
          if (operation.parked) await absent(operation.parked);
          if (operation.stage && operation.after)
            await assertVendorTree(operation.stage, operation.after);
        }
        journal = await writeVendorJournal(
          journal,
          newVendorJournal(journal.catalog, operations, "ready"),
        );
        for (const operation of operations) {
          vendorInterrupted(options);
          await assertVendorIdentity(journal.catalog, catalogIdentity);
          if (operation.before && operation.parked) {
            await assertVendorTree(operation.change.path, operation.before);
            await absent(operation.parked);
            await rename(operation.change.path, operation.parked);
          }
          if (operation.stage && operation.after) {
            await assertVendorIdentity(journal.catalog, catalogIdentity);
            await assertVendorTree(operation.stage, operation.after);
            await absent(operation.change.path);
            await rename(operation.stage, operation.change.path);
          }
          applied.push(operation.change);
          await syncDirectory(journal.catalog);
        }
        vendorInterrupted(options);
        for (const operation of operations) {
          await assertVendorIdentity(journal.catalog, catalogIdentity);
          if (operation.after) await assertVendorTree(operation.change.path, operation.after);
          if (operation.parked && operation.before)
            await removeVendorTree(operation.parked, operation.before);
        }
        await clearVendorJournal(journal);
        return { ...prepared.result, applied };
      },
    );
    return makeResult("vendor sync", result, {
      findings,
      exit: findings.some((finding) =>
        ["W_OPTIONAL_SKIPPED", "W_VENDOR_PRUNE_UNVERIFIED", "W_VENDOR_STAGING_PRESERVED"].includes(
          finding.code,
        ),
      )
        ? ExitCode.PARTIAL
        : ExitCode.SUCCESS,
    });
  } catch (error) {
    let failure =
      error instanceof SkillexError
        ? error
        : new SkillexError(ExitCode.FAILURE, [
            {
              code: "E_IO",
              severity: "error",
              message: `Vendor update failed: ${error instanceof Error ? error.message : String(error)}`,
              fix: "Check local checkout/catalog/state permissions and retry vendor sync; preserve any journal and recovery directories.",
            },
          ]);
    if (options.signal?.aborted)
      failure = new SkillexError(ExitCode.INTERRUPTED, [
        {
          code: "E_INTERRUPTED",
          severity: "error",
          message: "Vendor operation interrupted.",
          fix: "Run vendor sync again to recover retained state and resolve current declarations.",
        },
      ]);
    if (registry) {
      try {
        const pending = await readVendorJournal(registry, options);
        if (pending.document) {
          if (!initiallyPending) started = true;
          // Observe publication even if an injected I/O error happened immediately after rename.
          applied = [];
          for (const operation of pending.document.operations) {
            const info = await vendorLstat(operation.change.path);
            if (
              operation.after &&
              info &&
              String(info.dev) === operation.after.root.dev &&
              String(info.ino) === operation.after.root.ino
            )
              applied.push(operation.change);
            else if (
              operation.change.action === "prune" &&
              !info &&
              operation.parked &&
              (await vendorLstat(operation.parked))
            )
              applied.push(operation.change);
          }
        }
      } catch {
        /* Keep the original failure; recovery state is preserved for explicit inspection. */
      }
    }
    return makeResult(
      "vendor sync",
      prepared ? { ...prepared.result, applied } : fallback ? { ...fallback, applied } : null,
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
                  code: "E_VENDOR_PARTIAL" as const,
                  severity: "error" as const,
                  message:
                    "Vendor preparation or publication began; the applied list reports observed changes and recovery material is retained.",
                  path: prepared?.journal.path ?? "",
                  fix: "Retry vendor sync using the same catalog and state location to recover safely; it will resolve current source declarations again.",
                },
              ]
            : []),
        ],
      },
    );
  }
}
