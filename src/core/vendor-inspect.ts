import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSkill } from "./composition.js";
import { diagnosticExit } from "./diagnostics.js";
import { SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { isSkillName } from "./manifest.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import { resolveVendorPin } from "./vendor-git.js";
import { digestVendorTree, readVendorProvenance } from "./vendor-provenance.js";
import {
  checkVendorSignal,
  normalizeVendorRepo,
  readVendorSources,
  resolveVendorCheckout,
  selectVendorSources,
} from "./vendor-sources.js";
import { readVendorJournal } from "./vendor-state.js";
import type {
  VendorCheckout,
  VendorOptions,
  VendorProvenance,
  VendorSkillStatus,
  VendorSource,
  VendorSourceListResult,
  VendorSourceShowResult,
  VendorSourcesManifest,
  VendorStatusResult,
} from "./vendor-types.js";

class Observation {
  readonly findings: Diagnostic[] = [];
  readonly exits: ExitCode[] = [];

  report(finding: Diagnostic, exit: ExitCode): void {
    this.findings.push(finding);
    this.exits.push(exit);
  }

  capture(error: unknown, path?: string): void {
    if (error instanceof SkillexError) {
      this.findings.push(...error.findings);
      this.exits.push(error.exit);
    } else
      this.report(
        {
          code: "E_IO",
          severity: "error",
          message: "Vendor content could not be observed.",
          ...(path ? { path } : {}),
          detail: [error instanceof Error ? error.message : String(error)],
          fix: "Check local paths and read permissions, then retry the read-only inspection.",
        },
        ExitCode.FAILURE,
      );
  }

  result<T>(command: string, data: T): ResultEnvelope<T> {
    const findings = [
      ...new Map(this.findings.map((finding) => [JSON.stringify(finding), finding])).values(),
    ];
    return makeResult(command, data, {
      findings,
      exit: diagnosticExit(this.exits, this.exits.includes(ExitCode.DRIFT)),
    });
  }
}

interface Inventory {
  readonly recorded: Map<string, VendorProvenance>;
  readonly failed: Set<string>;
}

async function recordedInventory(
  manifest: VendorSourcesManifest,
  observation: Observation,
  options: VendorOptions,
): Promise<Inventory> {
  const recorded = new Map<string, VendorProvenance>();
  const failed = new Set<string>();
  const catalog = join(manifest.registry.root, "all-skills");
  for (const entry of (await readdir(catalog, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    checkVendorSignal(options);
    if (!isSkillName(entry.name) || !entry.isDirectory()) continue;
    const path = join(catalog, entry.name);
    try {
      const receipt = await readVendorProvenance(path);
      if (receipt) recorded.set(entry.name, receipt);
    } catch (error) {
      failed.add(entry.name);
      observation.capture(error, join(path, ".source.yaml"));
    }
  }
  return { recorded, failed };
}

function members(source: VendorSource, inventory: Inventory): string[] {
  const names = new Set(
    source.membership === "explicit" ? source.skills.map((skill) => skill.name) : [],
  );
  for (const [name, receipt] of inventory.recorded)
    if (receipt.type === "vendored" && receipt.source === source.name) names.add(name);
  return [...names].sort();
}

function emptySkill(
  source: VendorSource,
  manifest: VendorSourcesManifest,
  name: string,
  upstreamCommit: string | null,
): VendorSkillStatus {
  return {
    name,
    source: source.name,
    path: join(manifest.registry.root, "all-skills", name),
    state: "unknown",
    recordedCommit: null,
    upstreamCommit,
    recordedDigest: null,
    digest: null,
  };
}

async function inspectSkill(
  source: VendorSource,
  manifest: VendorSourcesManifest,
  inventory: Inventory,
  name: string,
  upstreamCommit: string | null,
  verify: boolean,
  observation: Observation,
): Promise<VendorSkillStatus> {
  let row = emptySkill(source, manifest, name, upstreamCommit);
  const info = await inspectPath(row.path);
  if (!info) {
    if (verify)
      observation.report(
        {
          code: "E_VENDOR_NOT_VENDORED",
          severity: "error",
          path: row.path,
          name,
          message: "A declared upstream skill is missing from the canonical catalog.",
          fix: `Run skillex vendor sync --source ${source.name} to materialize its committed content.`,
        },
        ExitCode.REFUSED,
      );
    return { ...row, state: "missing" };
  }
  if (!info.isDirectory()) {
    if (verify)
      observation.report(
        {
          code: "E_NONCANONICAL_REFERENCE",
          severity: "error",
          path: row.path,
          name,
          message: "A vendored skill must be a real canonical directory.",
          fix: "Review the conflicting entry and use an explicit adoption or migration operation.",
        },
        ExitCode.REFUSED,
      );
    return { ...row, state: "invalid" };
  }
  if (inventory.failed.has(name)) return { ...row, state: "invalid" };
  const receipt = inventory.recorded.get(name) ?? null;
  if (receipt?.type !== "vendored") {
    if (verify)
      observation.report(
        {
          code: "W_VENDOR_UNRECORDED",
          severity: "warning",
          path: row.path,
          name,
          message: "Canonical content has no vendored ownership record.",
          fix: "Review the existing content before explicitly adopting it with vendor sync --adopt.",
        },
        ExitCode.PARTIAL,
      );
    return { ...row, state: "unrecorded" };
  }
  row = { ...row, recordedCommit: receipt.upstreamCommit, recordedDigest: receipt.digest };
  if (
    receipt.source !== source.name ||
    (receipt.upstream !== null &&
      normalizeVendorRepo(receipt.upstream) !== normalizeVendorRepo(source.repo))
  ) {
    if (verify)
      observation.report(
        {
          code: "E_SOURCE_IDENTITY_MISMATCH",
          severity: "error",
          path: receipt.path,
          name,
          message: "Recorded source ownership differs from this declaration.",
          detail: [
            `declared ${source.name}: ${source.repo}`,
            `recorded ${receipt.source ?? "unknown"}: ${receipt.upstream ?? "unknown"}`,
          ],
          fix: "Correct the declaration or explicitly review ownership before adopting foreign content.",
        },
        ExitCode.REFUSED,
      );
    return { ...row, state: "foreign" };
  }
  const orphaned =
    source.membership === "explicit" && !source.skills.some((skill) => skill.name === name);
  if (!verify) return { ...row, state: orphaned ? "orphaned" : "recorded" };
  if (orphaned)
    observation.report(
      {
        code: "W_VENDOR_ORPHANED",
        severity: "warning",
        path: row.path,
        name,
        message: "Recorded content is no longer in this source's explicit membership.",
        fix: "Restore the declaration or review an explicit vendor sync --prune plan.",
      },
      ExitCode.DRIFT,
    );
  if (receipt.modifiedLocally)
    observation.report(
      {
        code: "W_VENDOR_LOCAL_EDITS",
        severity: "warning",
        path: receipt.path,
        name,
        message: "Recorded provenance marks this skill as locally modified.",
        fix: "Review the local changes before explicitly clearing or discarding their protection.",
      },
      ExitCode.DRIFT,
    );
  const directory =
    source.membership === "explicit"
      ? source.skills.find((skill) => skill.name === name)?.dir
      : name;
  const expectedPath =
    directory === undefined ? null : [source.subdir, directory].filter(Boolean).join("/");
  const declarationChanges: string[] = [];
  if (receipt.upstreamVersion && receipt.upstreamVersion !== source.version)
    declarationChanges.push(
      `recorded version ${receipt.upstreamVersion}; declared ${source.version}`,
    );
  if (expectedPath !== null && receipt.upstreamPath && receipt.upstreamPath !== expectedPath)
    declarationChanges.push(`recorded path ${receipt.upstreamPath}; declared ${expectedPath}`);
  if (declarationChanges.length)
    observation.report(
      {
        code: "W_VENDOR_DECLARATION_DRIFT",
        severity: "warning",
        path: receipt.path,
        name,
        message: "The source declaration differs from the recorded version or upstream path.",
        detail: declarationChanges,
        fix: "Review vendor sync's plan before updating the canonical content to match its declaration.",
      },
      ExitCode.DRIFT,
    );
  try {
    await canonicalSkill(manifest.registry.root, name);
    if (
      receipt.digestFormat !== null &&
      !["skillex-tree-v1", "skillex-tree-v1+symlinks"].includes(receipt.digestFormat)
    ) {
      observation.report(
        {
          code: "W_SKILL_DIGEST_UNSUPPORTED",
          severity: "warning",
          path: receipt.path,
          name,
          message: "This recorded digest format cannot be verified by the CLI.",
          fix: "Inspect the provenance with its producing tool before updating the record.",
        },
        ExitCode.PARTIAL,
      );
      return { ...row, state: "unknown" };
    }
    row = { ...row, digest: await digestVendorTree(row.path) };
  } catch (error) {
    observation.capture(error, row.path);
    return { ...row, state: "invalid" };
  }
  const missing = [
    ["upstream", receipt.upstream],
    ["upstream_version", receipt.upstreamVersion],
    ["upstream_commit", receipt.upstreamCommit],
    ["upstream_tree", receipt.upstreamTree],
    ["upstream_path", receipt.upstreamPath],
    ["digest", receipt.digest],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field ?? "");
  if (missing.length) {
    observation.report(
      {
        code:
          receipt.digest === null ? "W_VENDOR_DIGEST_MISSING" : "W_VENDOR_PROVENANCE_INCOMPLETE",
        severity: "warning",
        path: receipt.path,
        name,
        message: "Recorded provenance is incomplete; unchanged content cannot be established.",
        detail: missing,
        fix: "Recover the original source pin and digest before any replacement; missing evidence is not permission to overwrite.",
      },
      ExitCode.PARTIAL,
    );
  }
  let state: VendorSkillStatus["state"] = missing.length
    ? "unknown"
    : receipt.modifiedLocally
      ? "modified"
      : orphaned
        ? "orphaned"
        : declarationChanges.length
          ? "stale"
          : "ok";
  if (receipt.digest !== null && row.digest !== receipt.digest) {
    state = "modified";
    observation.report(
      {
        code: "W_SKILL_DIGEST_DRIFT",
        severity: "warning",
        path: receipt.path,
        name,
        message: "Current canonical bytes or executable modes differ from the recorded digest.",
        detail: [`recorded ${receipt.digest}`, `actual ${row.digest}`],
        fix: "Review local edits before explicitly discarding them with vendor sync --discard-local-edits.",
      },
      ExitCode.DRIFT,
    );
  }
  if (
    upstreamCommit !== null &&
    receipt.upstreamCommit !== null &&
    upstreamCommit !== receipt.upstreamCommit
  ) {
    if (state === "ok") state = "stale";
    observation.report(
      {
        code: "W_VENDOR_PIN_STALE",
        severity: "warning",
        path: receipt.path,
        name,
        message: "The declared version now resolves to a different local upstream commit.",
        detail: [`recorded ${receipt.upstreamCommit}`, `available ${upstreamCommit}`],
        fix: "Review vendor sync's plan before explicitly updating the committed catalog pin.",
      },
      ExitCode.DRIFT,
    );
  }
  return { ...row, state };
}

export async function listVendorSources(
  options: VendorOptions = {},
): Promise<ResultEnvelope<VendorSourceListResult | null>> {
  const observation = new Observation();
  try {
    const manifest = await readVendorSources(options);
    const sources: { source: VendorSource; checkout: VendorCheckout }[] = [];
    for (const source of selectVendorSources(manifest, options.sources)) {
      checkVendorSignal(options);
      sources.push({ source, checkout: await resolveVendorCheckout(source, options) });
    }
    return observation.result("vendor list", {
      registry: manifest.registry,
      manifest: manifest.path,
      sources,
    });
  } catch (error) {
    observation.capture(error);
    return observation.result("vendor list", null);
  }
}

export async function showVendorSource(
  name: string,
  options: VendorOptions = {},
): Promise<ResultEnvelope<VendorSourceShowResult | null>> {
  const observation = new Observation();
  try {
    const manifest = await readVendorSources(options);
    selectVendorSources(manifest, options.sources);
    const source = selectVendorSources(manifest, [name])[0];
    if (!source) throw new Error("Selected vendor source is missing.");
    const checkout = await resolveVendorCheckout(source, options);
    const inventory = await recordedInventory(manifest, observation, options);
    const skills: VendorSkillStatus[] = [];
    for (const member of members(source, inventory)) {
      checkVendorSignal(options);
      skills.push(
        await inspectSkill(source, manifest, inventory, member, null, false, observation),
      );
    }
    return observation.result("vendor show", {
      registry: manifest.registry,
      manifest: manifest.path,
      source,
      checkout,
      membership: source.membership === "explicit" ? "explicit" : "recorded",
      skills,
    });
  } catch (error) {
    observation.capture(error);
    return observation.result("vendor show", null);
  }
}

export async function inspectVendorStatus(
  options: VendorOptions = {},
): Promise<ResultEnvelope<VendorStatusResult | null>> {
  const observation = new Observation();
  try {
    const manifest = await readVendorSources(options);
    const selected = selectVendorSources(manifest, options.sources);
    try {
      const journal = await readVendorJournal(manifest.registry, options);
      if (journal.document)
        observation.report(
          {
            code: "W_VENDOR_RECOVERY_PENDING",
            severity: "warning",
            path: journal.path,
            message: "An interrupted vendor update has not completed its recorded recovery.",
            fix: "Inspect the pending update with vendor sync using the same state location; status never recovers or modifies it.",
          },
          ExitCode.PARTIAL,
        );
    } catch (error) {
      observation.capture(error);
    }
    const inventory = await recordedInventory(manifest, observation, options);
    const sources: {
      name: string;
      membership: "explicit" | "recorded";
      checkout: VendorCheckout | null;
      upstreamCommit: string | null;
    }[] = [];
    const skills: VendorSkillStatus[] = [];
    for (const source of selected) {
      checkVendorSignal(options);
      let checkout: VendorCheckout | null = null;
      let upstreamCommit: string | null = null;
      if (options.upstream) {
        try {
          checkout = await resolveVendorCheckout(source, options);
          if (!checkout.root)
            observation.report(
              {
                code: source.optional ? "W_SOURCE_OPTIONAL_MISSING" : "E_SOURCE_CHECKOUT_MISSING",
                severity: source.optional ? "warning" : "error",
                name: source.name,
                message:
                  "No local upstream checkout is available for the requested pin observation.",
                detail: checkout.searched,
                fix: "Provide an existing checkout with --checkout ID=PATH; vendor status never clones or fetches.",
              },
              source.optional ? ExitCode.PARTIAL : ExitCode.REFUSED,
            );
          else {
            const pin = await resolveVendorPin(source, checkout.root, options);
            upstreamCommit = pin.commit;
            if (pin.origin && normalizeVendorRepo(pin.origin) !== normalizeVendorRepo(source.repo))
              observation.report(
                {
                  code: "W_SOURCE_REMOTE_MISMATCH",
                  severity: "warning",
                  path: checkout.root,
                  name: source.name,
                  message:
                    "The selected checkout's origin differs from the declared repository identity.",
                  detail: [pin.origin, source.repo],
                  fix: "Review the selected checkout or correct the source declaration before syncing.",
                },
                ExitCode.DRIFT,
              );
          }
        } catch (error) {
          observation.capture(error);
        }
      }
      sources.push({
        name: source.name,
        membership: source.membership === "explicit" ? "explicit" : "recorded",
        checkout,
        upstreamCommit,
      });
      const names = members(source, inventory);
      if (source.membership === "discovery" && !names.length)
        observation.report(
          {
            code: "W_VENDOR_MEMBERSHIP_UNKNOWN",
            severity: "warning",
            path: manifest.path,
            name: source.name,
            message: "No recorded membership exists for this discovered source.",
            fix: "Run an explicit vendor sync to record its committed inventory, or declare explicit skills; offline status cannot infer missing upstream membership.",
          },
          ExitCode.PARTIAL,
        );
      for (const name of names) {
        checkVendorSignal(options);
        const row = await inspectSkill(
          source,
          manifest,
          inventory,
          name,
          upstreamCommit,
          true,
          observation,
        );
        skills.push(
          options.upstream && upstreamCommit === null && row.state === "ok"
            ? { ...row, state: "unknown" }
            : row,
        );
      }
    }
    if (!options.sources?.length) {
      for (const [name, receipt] of inventory.recorded) {
        if (
          receipt.type !== "vendored" ||
          manifest.sources.some((source) => source.name === receipt.source)
        )
          continue;
        observation.report(
          {
            code: "E_SOURCE_DECLARATION_MISSING",
            severity: "error",
            path: receipt.path,
            name,
            message: "Recorded upstream ownership has no source declaration.",
            fix: "Restore the matching source declaration before inspecting or updating its catalog content.",
          },
          ExitCode.REFUSED,
        );
      }
    }
    return observation.result("vendor status", {
      registry: manifest.registry,
      manifest: manifest.path,
      upstream: options.upstream ?? false,
      sources,
      skills,
    });
  } catch (error) {
    observation.capture(error);
    return observation.result("vendor status", null);
  }
}
