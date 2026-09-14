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
import { isVersionComponent, parseManifest } from "./manifest.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { PackSelection } from "./selection.js";

interface PackDocument {
  readonly inventory: PackInventory;
  readonly raw: TomlTable;
  readonly bytes: Buffer;
  readonly info: Stats;
  readonly description?: string;
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
    const { inventory } = document;
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

async function preparePack(
  selected: PackSelection,
  names: readonly string[],
  operation: "create" | "add" | "remove",
  options: CompositionOptions,
) {
  const registry = await discoverRegistry(options);
  const requested = await requestedSkills(registry.root, names, `pack ${selected.name}`);
  const createdPath = join(registry.root, "packs", selected.name, selected.version ?? "");
  const existing = operation !== "create" || (await inspectPath(createdPath));
  const text = description(options.description, "pack description");
  let document: PackDocument | undefined;
  if (existing) document = await readPack(registry.root, selected);
  const previous = document?.inventory.names ?? [];
  const desired = [...previous];
  if (operation === "add")
    for (const name of requested.keys()) if (!desired.includes(name)) desired.push(name);
  const namesAfter =
    operation === "remove" ? desired.filter((name) => !requested.has(name)) : desired;
  const targets = await requestedSkills(
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
        skills: [],
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
  if (declarationChanged) {
    const raw: TomlTable = document
      ? { ...document.raw, freeform: { skills: namesAfter } }
      : {
          pack: {
            name: selected.name,
            version: selected.version ?? "",
            ...(text === undefined ? {} : { description: text }),
          },
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
  options: CompositionOptions = {},
): Promise<ResultEnvelope<CompositionMutationData | null>> {
  return mutateComposition("pack create", options, () =>
    preparePack(explicitSelection(name, version), [], "create", options),
  );
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
