import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from "smol-toml";
import { canonicalSkill, type PackInventory, packInventory } from "./composition.js";
import {
  collectedError,
  compositionError,
  conflict,
  listOutcome,
  mutateComposition,
  newPlan,
  planDirectory,
  planLink,
  planUnlink,
  requestedSkills,
} from "./composition-mutation.js";
import type {
  CompositionDetails,
  CompositionMutationData,
  CompositionOptions,
  PackListData,
  PackShowData,
} from "./composition-types.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import {
  executeImports,
  planSourceMembers,
  provenanceFrom,
  releaseInventory,
  resolveMemberTargets,
  type SourceMembershipPlan,
} from "./import-sources.js";
import { isVersionComponent, parseManifest } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { PackSelection } from "./selection.js";

interface PackDocument {
  readonly inventory: PackInventory;
  readonly raw: TomlTable;
  readonly bytes: Buffer;
  readonly info: Stats;
  readonly description?: string;
}

export interface CreatePackOptions extends CompositionOptions {
  /** Existing local skill root whose entries become member references. */
  readonly fromRoot?: string;
  /** Repeatable explicit sources: existing paths or Git remotes. */
  readonly from?: readonly string[];
  /** Import source skills that have no canonical definition instead of refusing. */
  readonly import?: boolean;
}

function selection(ref: string): PackSelection {
  const selected = parseManifest({ packs: [ref] }, "pack reference").packs[0];
  if (!selected)
    fail("E_PACK_NAME", "A pack reference is required.", { fix: "Pass NAME or NAME@VERSION." });
  return selected;
}

function explicitSelection(name: string, version: string): PackSelection {
  const selected = parseManifest({ packs: [{ name, version }] }, "pack name/version").packs[0];
  if (!selected?.version)
    fail("E_PACK_VERSION_REQUIRED", "Creating a pack requires an explicit version.", {
      fix: "Pass both the pack name and version.",
    });
  return selected;
}

function description(value: unknown, path: string): string | undefined {
  if (value !== undefined && typeof value !== "string") {
    fail("E_PACK_MANIFEST_INVALID", "Pack description must be text.", {
      path,
      fix: "Use a TOML string for [pack].description.",
    });
  }
  return value;
}

async function readPack(registry: string, selected: PackSelection): Promise<PackDocument> {
  const first = await packInventory(registry, selected);
  const path = join(first.path, "pack.toml");
  const info = await lstat(path);
  if (!info.isFile()) conflict(path, "Pack manifests must be real files.");
  const bytes = await readFile(path);
  let raw: TomlTable;
  try {
    raw = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail(
      "E_PACK_MANIFEST_INVALID",
      `Cannot read pack manifest: ${error instanceof Error ? error.message : String(error)}`,
      { path, fix: "Correct the UTF-8 TOML membership manifest." },
    );
  }
  // Validate the same captured document with the shared resolver authority.
  // A second inspection also refuses changing version selection during a read.
  const inventory = await packInventory(registry, selected);
  const after = await lstat(path);
  if (
    inventory.path !== first.path ||
    !after.isFile() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    !(await readFile(path)).equals(bytes)
  )
    conflict(path, "The pack declaration changed during inspection.");
  const header = raw.pack as TomlTable;
  const text = description(header.description, path);
  if (
    raw.source !== undefined &&
    (typeof raw.source !== "object" || raw.source === null || Array.isArray(raw.source))
  ) {
    fail("E_PACK_MANIFEST_INVALID", "Pack source provenance must be a TOML table.", {
      path,
      fix: "Keep provenance fields within the optional [source] table.",
    });
  }
  return { inventory, raw, bytes, info, ...(text === undefined ? {} : { description: text }) };
}

async function packDetails(registry: string, document: PackDocument): Promise<CompositionDetails> {
  const { inventory } = document;
  const targets = await requestedSkills(
    registry,
    inventory.names,
    join(inventory.path, "pack.toml"),
  );
  return details(document, targets);
}

function details(document: PackDocument, targets: ReadonlyMap<string, string>): CompositionDetails {
  return {
    kind: "pack",
    name: document.inventory.name,
    version: document.inventory.version,
    path: document.inventory.path,
    skills: [...targets]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, path]) => ({ name, path })),
    ...(document.description === undefined ? {} : { description: document.description }),
  };
}

export async function listPacks(
  options: CompositionOptions = {},
): Promise<ResultEnvelope<PackListData | null>> {
  const command = "pack list";
  try {
    const registry = await discoverRegistry(options);
    const root = join(registry.root, "packs");
    const packs: CompositionDetails[] = [];
    const failures: SkillexError[] = [];
    const inspect = async (selected: PackSelection, path: string) => {
      try {
        packs.push(await packDetails(registry.root, await readPack(registry.root, selected)));
      } catch (error) {
        failures.push(collectedError(error, path));
      }
    };
    if (await inspectPath(root)) {
      await requireDirectory(root, "E_PACK_MISSING");
      for (const family of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (
          family.name.startsWith(".") ||
          family.name.startsWith("_") ||
          (!family.isDirectory() && !family.isSymbolicLink())
        )
          continue;
        const path = join(root, family.name);
        try {
          const named = parseManifest({ packs: [{ name: family.name }] }, path).packs[0];
          if (!named) continue;
          await requireDirectory(path, "E_PACK_MISSING");
          const direct = await inspectPath(join(path, "pack.toml"));
          let inspected = 0;
          if (direct) {
            await inspect(named, path);
            inspected += 1;
          }
          for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          )) {
            if (
              entry.name.startsWith(".") ||
              entry.name.startsWith("_") ||
              (!entry.isDirectory() && !entry.isSymbolicLink())
            )
              continue;
            const child = join(path, entry.name);
            if (direct && !(await inspectPath(join(child, "pack.toml")))) continue;
            inspected += 1;
            if (!isVersionComponent(entry.name)) {
              failures.push(
                new SkillexError(ExitCode.CONFIG, [
                  {
                    code: "E_PACK_VERSION",
                    severity: "error",
                    message: `Unsafe pack version directory: ${entry.name}`,
                    path: child,
                    fix: "Rename this version directory to a safe single path component and update [pack].version to match.",
                  },
                ]),
              );
              continue;
            }
            await inspect({ name: family.name, version: entry.name, optional: false }, child);
          }
          if (!inspected) await inspect(named, path);
        } catch (error) {
          failures.push(collectedError(error, path));
        }
      }
    }
    return listOutcome(command, { registry, packs }, failures, packs.length);
  } catch (error) {
    return compositionError(command, error);
  }
}

export async function showPack(
  ref: string,
  options: CompositionOptions = {},
): Promise<ResultEnvelope<PackShowData | null>> {
  const command = "pack show";
  try {
    const selected = selection(ref);
    const registry = await discoverRegistry(options);
    return makeResult(command, {
      registry,
      pack: await packDetails(registry.root, await readPack(registry.root, selected)),
    });
  } catch (error) {
    return compositionError(command, error);
  }
}

export async function verifyPack(
  ref: string,
  options: CompositionOptions = {},
): Promise<ResultEnvelope<PackShowData | null>> {
  const command = "pack verify";
  try {
    const selected = selection(ref);
    const registry = await discoverRegistry(options);
    const document = await readPack(registry.root, selected);
    const { inventory, raw } = document;
    const targets = new Map<string, string>();
    const findings: Diagnostic[] = [];
    const report = (code: Diagnostic["code"], message: string, path: string) =>
      findings.push({
        code,
        severity: "error",
        message,
        path,
        fix: "Use pack add/remove to repair declared canonical links; migrate conflicting foreign content before retrying.",
      });
    for (const name of new Set(inventory.names)) {
      try {
        targets.set(name, await canonicalSkill(registry.root, name));
      } catch (error) {
        findings.push(...collectedError(error, join(registry.root, "all-skills", name)).findings);
      }
    }
    const root = await inspectPath(inventory.skillsRoot);
    if (!root)
      report(
        "E_PACK_SKILLS_MISSING",
        "Pack generated skills directory is missing.",
        inventory.skillsRoot,
      );
    else if (!root.isDirectory())
      report(
        "E_PACK_SKILLS_ROOT",
        "Pack skills root must be a real directory.",
        inventory.skillsRoot,
      );
    else {
      // Version-baseline grounding for bmad-freeze packs: a pack records the BMAD
      // installation version it froze ([source].bmad_version). The canonical skills
      // it references carry their own recorded bmad_version in their receipts. If
      // the versions diverge, the canonical was replaced by a different BMAD
      // release and this pack must not verify green against bytes it never froze.
      const packSource = raw.source as TomlTable | undefined;
      const packBmadVersion =
        packSource &&
        typeof packSource === "object" &&
        typeof (packSource as Record<string, unknown>).bmad_version === "string"
          ? ((packSource as Record<string, unknown>).bmad_version as string)
          : null;
      const recordedVersions = new Map<string, string>();
      if (packBmadVersion !== null) {
        for (const name of new Set(inventory.names)) {
          try {
            const metadata = await readSkillMetadata(targets.get(name) as string);
            const origin = metadata.provenance?.origin;
            if (
              origin &&
              typeof origin === "object" &&
              !Array.isArray(origin) &&
              typeof (origin as Record<string, unknown>).bmad_version === "string"
            ) {
              recordedVersions.set(
                name,
                (origin as Record<string, unknown>).bmad_version as string,
              );
            }
          } catch {
            /* Missing/unreadable canonicals are already reported above. */
          }
        }
      }
      const names = new Set(inventory.names);
      const entries = await readdir(inventory.skillsRoot, { withFileTypes: true });
      const present = new Set(entries.map((entry) => entry.name));
      for (const name of names)
        if (!present.has(name))
          report(
            "E_PACK_LINK_MISSING",
            `Pack is missing its declared ${name} link.`,
            join(inventory.skillsRoot, name),
          );
      for (const entry of entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const path = join(inventory.skillsRoot, entry.name);
        if (!names.has(entry.name)) {
          report("E_PACK_LINK_EXTRA", `Pack has undeclared generated content: ${entry.name}`, path);
          continue;
        }
        if (!entry.isSymbolicLink()) {
          report(
            "E_PACK_LINK_TARGET",
            `Pack member ${entry.name} must be a canonical directory link.`,
            path,
          );
          continue;
        }
        let target: string | undefined;
        try {
          target = await realpath(path);
        } catch {
          /* A dangling link is a verification finding. */
        }
        if (!target || !targets.has(entry.name) || target !== targets.get(entry.name))
          report(
            "E_PACK_LINK_TARGET",
            `Pack member ${entry.name} does not resolve to its matching canonical definition.`,
            path,
          );
      }
      // Baseline mismatch: this pack froze skills at a different BMAD version than
      // the canonical currently records, so the pack is stale.
      if (packBmadVersion !== null) {
        for (const name of new Set(inventory.names)) {
          const recorded = recordedVersions.get(name);
          if (recorded === undefined) continue;
          if (recorded !== packBmadVersion) {
            report(
              "E_BMAD_PACK_BASELINE",
              `Pack bmad member ${name} is frozen at BMAD ${packBmadVersion} but the canonical now records BMAD ${recorded} (stale after a version switch).`,
              targets.get(name) ?? inventory.skillsRoot,
            );
          }
        }
      }
    }
    return makeResult(
      command,
      { registry, pack: details(document, targets) },
      { exit: findings.length ? ExitCode.REFUSED : ExitCode.SUCCESS, findings },
    );
  } catch (error) {
    return compositionError(command, error);
  }
}

/** Order-insensitive comparison for TOML-round-tripped provenance tables. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Destination admission for source-backed pack creation: the requested name
 * and version must be valid, and an existing version must be fully explained
 * by the sources — every declared member claimed, recorded [source]
 * provenance agreeing. Runs unlocked before any catalog write and again
 * inside composition planning under the lock.
 */
async function packAdmission(
  registry: string,
  selected: PackSelection,
  source: SourceMembershipPlan,
): Promise<void> {
  const createdPath = join(registry, "packs", selected.name, selected.version ?? "");
  if (!(await inspectPath(createdPath))) return;
  // A repeated source-backed create must be a write-free no-op (or finish
  // links an interrupted run left missing); members the sources do not
  // explain are a named refusal, never a silent edit.
  const current = await readPack(registry, selected);
  const wanted = new Set(source.members);
  const unexpected = current.inventory.names.filter((name) => !wanted.has(name));
  if (unexpected.length)
    conflict(
      createdPath,
      `Source-backed creation found existing members outside the sources (${unexpected.join(", ")}); use pack remove or a new version.`,
    );
  if (
    source.provenance !== undefined &&
    current.raw.source !== undefined &&
    // Only the source list is identity; the first run's `imported` outcome
    // must not make an importing repeat look like a different provenance.
    stableStringify((current.raw.source as Record<string, unknown>).sources) !==
      stableStringify(source.provenance.sources)
  )
    conflict(
      join(createdPath, "pack.toml"),
      "The existing pack version records different source provenance than the requested sources.",
    );
}

async function preparePack(
  selected: PackSelection,
  names: readonly string[],
  operation: "create" | "add" | "remove",
  options: CompositionOptions,
  source?: SourceMembershipPlan,
) {
  const registry = await discoverRegistry(options);
  const createdPath = join(registry.root, "packs", selected.name, selected.version ?? "");
  if (source !== undefined) await packAdmission(registry.root, selected, source);
  const exists = await inspectPath(createdPath);
  const requested =
    source !== undefined
      ? await resolveMemberTargets(
          registry.root,
          source.members,
          `pack ${selected.name}`,
          source.pending,
        )
      : await requestedSkills(registry.root, names, `pack ${selected.name}`);
  const existing = operation !== "create" || exists;
  const text = description(options.description, "pack description");
  let document: PackDocument | undefined;
  if (existing) document = await readPack(registry.root, selected);
  const previous = document?.inventory.names ?? [];
  const desired = [...previous];
  if (operation === "add" || source !== undefined)
    for (const name of requested.keys()) if (!desired.includes(name)) desired.push(name);
  const namesAfter =
    operation === "remove" ? desired.filter((name) => !requested.has(name)) : desired;
  const targets =
    source !== undefined
      ? requested
      : await requestedSkills(
          registry.root,
          namesAfter,
          document ? join(document.inventory.path, "pack.toml") : createdPath,
        );
  const composition: CompositionDetails = document
    ? details(document, targets)
    : {
        kind: "pack",
        name: selected.name,
        version: selected.version ?? "",
        path: createdPath,
        skills: [...targets]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([skillName, skillPath]) => ({ name: skillName, path: skillPath })),
        ...(text === undefined ? {} : { description: text }),
      };
  const plan = await newPlan(registry, composition, options.dryRun === true);
  const root = join(composition.path, "skills");
  await planDirectory(plan, root);
  if (await inspectPath(root)) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      const target = targets.get(entry.name);
      if (target) await planLink(plan, path, target);
      else if (operation === "remove" && requested.has(entry.name)) {
        const removed = requested.get(entry.name);
        if (removed) await planUnlink(plan, path, removed);
      } else
        conflict(
          path,
          `Pack generated content ${entry.name} is not declared or explicitly requested for removal.`,
        );
    }
  }
  for (const [name, target] of targets) {
    const path = join(root, name);
    if (!(await inspectPath(path))) await planLink(plan, path, target);
  }
  const declarationChanged =
    !document ||
    previous.length !== namesAfter.length ||
    previous.some((name, index) => name !== namesAfter[index]);
  // Adopting provenance onto an unattributed pack whose membership the sources
  // explain exactly is an honest metadata gain, so it rewrites the manifest.
  const provenanceAdopted =
    document !== undefined && document.raw.source === undefined && source?.provenance !== undefined;
  if (declarationChanged || provenanceAdopted) {
    const raw: TomlTable = document
      ? {
          ...document.raw,
          freeform: { skills: namesAfter },
          ...(source?.provenance === undefined ? {} : { source: source.provenance as TomlTable }),
        }
      : {
          pack: {
            name: selected.name,
            version: selected.version ?? "",
            ...(text === undefined ? {} : { description: text }),
          },
          // provenanceFrom emits JSON-safe values (strings, arrays, records),
          // which stringify as the [source] TOML table.
          ...(source?.provenance === undefined ? {} : { source: source.provenance as TomlTable }),
          freeform: { skills: namesAfter },
        };
    const path = join(composition.path, "pack.toml");
    plan.manifest = {
      path,
      bytes: Buffer.from(stringifyToml(raw)),
      ...(document ? { before: { bytes: document.bytes, info: document.info } } : {}),
    };
    plan.changes.push({ action: "write-manifest", path });
  }
  return plan;
}

export async function createPack(
  name: string,
  version: string,
  options: CreatePackOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  const command = "pack create";
  if (options.fromRoot === undefined && (options.from?.length ?? 0) === 0)
    return mutateComposition(command, options, () =>
      preparePack(explicitSelection(name, version), [], "create", options),
    );
  try {
    const registry = await discoverRegistry(options);
    // Phase 1 — acquire everything and validate every import write-free.
    const planned = await planSourceMembers(registry.root, options);
    try {
      if (planned.findings.some((finding) => finding.severity === "error"))
        return makeResult(command, null, { exit: ExitCode.REFUSED, findings: planned.findings });
      // Phase 2 — preflight the destination before any catalog write: the
      // pack name/version and any existing membership/provenance must admit
      // this composition, or we refuse without having imported anything.
      const selected = explicitSelection(name, version);
      const provisional: SourceMembershipPlan = {
        members: planned.names,
        pending: planned.pending,
        provenance: await provenanceFrom(planned.inventories, [...planned.pending.keys()].sort()),
      };
      await packAdmission(registry.root, selected, provisional);
      // Phase 3 — execute the imports for real, disclosing partial survival
      // truthfully instead of rolling back or hiding it.
      const executed: string[] = [];
      if (options.dryRun !== true && planned.imports.length > 0) {
        const outcome = await executeImports(planned.imports, options);
        if (outcome.findings.length > 0)
          return makeResult(command, null, {
            exit: ExitCode.REFUSED,
            findings: [...planned.findings, ...outcome.findings],
          });
        executed.push(...outcome.executed.map((item) => item.name));
      }
      // Phase 4 — compose. Dry-run keeps planned destinations; a real run
      // resolves every member against the catalog it just wrote.
      const source: SourceMembershipPlan = {
        members: planned.names,
        pending: options.dryRun === true ? planned.pending : new Map(),
        provenance: await provenanceFrom(
          planned.inventories,
          options.dryRun === true ? [...planned.pending.keys()].sort() : executed,
        ),
      };
      return await mutateComposition(command, options, () =>
        preparePack(selected, [], "create", options, source),
      ).then((result) =>
        result.ok ? makeResult(command, result.data, { findings: planned.findings }) : result,
      );
    } finally {
      for (const inventory of planned.inventories) await releaseInventory(inventory);
    }
  } catch (error) {
    return compositionError(command, error);
  }
}

export async function addPackSkills(
  ref: string,
  names: readonly string[],
  options: CompositionOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  return mutateComposition("pack add", options, () =>
    preparePack(selection(ref), names, "add", options),
  );
}

export async function removePackSkills(
  ref: string,
  names: readonly string[],
  options: CompositionOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  return mutateComposition("pack remove", options, () =>
    preparePack(selection(ref), names, "remove", options),
  );
}
