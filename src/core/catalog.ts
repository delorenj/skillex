import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ListSkillsOptions,
  SkillDetails,
  SkillListData,
  SkillReference,
  SkillShowData,
} from "./catalog-types.js";
import { canonicalSkill, packInventory, setMembers, setMemberTarget } from "./composition.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import { isVersionComponent, parseManifest } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistryOptions } from "./selection.js";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function report(error: unknown, path: string, findings: Diagnostic[]): void {
  if (error instanceof SkillexError) {
    findings.push(...error.findings.map((finding) => ({ ...finding, path: finding.path ?? path })));
  } else {
    findings.push({
      code: "E_IO",
      severity: "error",
      message: `Cannot inspect catalog content: ${error instanceof Error ? error.message : String(error)}`,
      path,
      fix: "Check this source path and its permissions, then retry.",
    });
  }
}

function failure<T>(command: string, error: unknown, path: string): ResultEnvelope<T | null> {
  const findings: Diagnostic[] = [];
  report(error, path, findings);
  return makeResult(command, null, {
    exit: error instanceof SkillexError ? error.exit : ExitCode.FAILURE,
    findings,
  });
}

function compositionName(name: string, kind: "set" | "pack", path: string): void {
  try {
    parseManifest(kind === "set" ? { sets: [name] } : { packs: [{ name }] }, path);
  } catch {
    fail("E_COMPOSITION_NAME", `Invalid ${kind} directory name: ${name}`, {
      path,
      name,
      fix: "Rename the composition to a safe single path component before referencing it.",
    });
  }
}

async function compositionReferences(
  registry: string,
  findings: Diagnostic[],
): Promise<Map<string, SkillReference[]>> {
  const references = new Map<string, SkillReference[]>();
  const add = (name: string, reference: SkillReference) => {
    const existing = references.get(name) ?? [];
    if (!existing.some((entry) => entry.kind === reference.kind && entry.path === reference.path)) {
      existing.push(reference);
      references.set(name, existing);
    }
  };
  const inspectSet = async (name: string, path: string) => {
    try {
      compositionName(name, "set", path);
      const inventory = await setMembers(registry, name);
      for (const member of inventory.names) {
        try {
          await setMemberTarget(registry, inventory.path, member);
          add(member, { kind: "set", name, path: inventory.path });
        } catch (error) {
          report(error, join(inventory.path, member), findings);
        }
      }
    } catch (error) {
      report(error, path, findings);
    }
  };
  const inspectPack = async (name: string, path: string, version?: string) => {
    try {
      const inventory = await packInventory(registry, {
        name,
        ...(version === undefined ? {} : { version }),
        optional: false,
      });
      for (const member of new Set(inventory.names)) {
        try {
          await canonicalSkill(registry, member);
          add(member, {
            kind: "pack",
            name,
            version: inventory.version,
            path: inventory.path,
          });
        } catch (error) {
          report(error, path, findings);
        }
      }
    } catch (error) {
      report(error, path, findings);
    }
  };
  const inspectFamily = async (name: string, path: string) => {
    try {
      compositionName(name, "pack", path);
      await requireDirectory(path, "E_PACK_MISSING");
      const direct = await inspectPath(join(path, "pack.toml"));
      let inspected = 0;
      if (direct) {
        await inspectPack(name, path);
        inspected += 1;
      }
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        compare(a.name, b.name),
      )) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        const versionPath = join(path, entry.name);
        if (entry.isSymbolicLink()) {
          // A direct pack may contain canonical skill or support links. A
          // version-family child must itself be an owned directory.
          if (!direct) {
            try {
              await requireDirectory(versionPath, "E_PACK_MISSING");
            } catch (error) {
              report(error, versionPath, findings);
            }
          }
          continue;
        }
        if (!entry.isDirectory() || !(await inspectPath(join(versionPath, "pack.toml")))) continue;
        if (!isVersionComponent(entry.name)) {
          report(
            new SkillexError(ExitCode.CONFIG, [
              {
                code: "E_PACK_VERSION",
                severity: "error",
                message: `Unsafe pack version directory: ${entry.name}`,
                path: versionPath,
                fix: "Rename this version to a safe single path component.",
              },
            ]),
            versionPath,
            findings,
          );
          continue;
        }
        await inspectPack(name, versionPath, entry.name);
        inspected += 1;
      }
      if (!inspected) await inspectPack(name, path);
    } catch (error) {
      report(error, path, findings);
    }
  };

  for (const kind of ["set", "pack"] as const) {
    const path = join(registry, kind === "set" ? "sets" : "packs");
    try {
      if (!(await inspectPath(path))) continue;
      await requireDirectory(path, kind === "set" ? "E_SET_MISSING" : "E_PACK_MISSING");
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        compare(a.name, b.name),
      );
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const child = join(path, entry.name);
        if (kind === "set") await inspectSet(entry.name, child);
        else await inspectFamily(entry.name, child);
      }
    } catch (error) {
      report(error, path, findings);
    }
  }
  for (const entries of references.values()) {
    entries.sort((a, b) =>
      compare(
        `${a.kind}/${a.name}/${a.version ?? ""}/${a.path}`,
        `${b.kind}/${b.name}/${b.version ?? ""}/${b.path}`,
      ),
    );
  }
  return references;
}

/** Browse valid canonical definitions while keeping incomplete inspection visible. */
export async function listSkills(
  options: ListSkillsOptions = {},
): Promise<ResultEnvelope<SkillListData | null>> {
  try {
    if (options.query !== undefined && typeof options.query !== "string") {
      fail("E_QUERY", "The catalog query must be text.", {
        fix: "Pass --query followed by a name or description substring.",
      });
    }
    const registry = await discoverRegistry(options);
    const findings: Diagnostic[] = [];
    const skills: SkillDetails[] = [];
    const validationExits: ExitCode[] = [];
    let validDefinitions = 0;
    const catalog = join(registry.root, "all-skills");
    const query = options.query?.trim().toLowerCase();
    for (const entry of (await readdir(catalog, { withFileTypes: true })).sort((a, b) =>
      compare(a.name, b.name),
    )) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const path = await canonicalSkill(registry.root, entry.name);
        const metadata = await readSkillMetadata(path);
        validDefinitions += 1;
        if (
          query &&
          !entry.name.toLowerCase().includes(query) &&
          !(metadata.description?.toLowerCase().includes(query) ?? false)
        )
          continue;
        skills.push({ name: entry.name, path, ...metadata, references: [] });
      } catch (error) {
        validationExits.push(error instanceof SkillexError ? error.exit : ExitCode.FAILURE);
        report(error, join(catalog, entry.name), findings);
      }
    }
    const references = await compositionReferences(registry.root, findings);
    // A completely invalid catalog has failed validation, rather than produced
    // a partial report. Count valid definitions before applying the search query.
    const exit =
      validDefinitions === 0 && validationExits.length > 0
        ? validationExits.includes(ExitCode.FAILURE)
          ? ExitCode.FAILURE
          : validationExits.includes(ExitCode.REFUSED)
            ? ExitCode.REFUSED
            : (validationExits[0] ?? ExitCode.CONFIG)
        : findings.length
          ? ExitCode.PARTIAL
          : ExitCode.SUCCESS;
    return makeResult(
      "skill list",
      {
        registry,
        skills: skills.map((skill) => ({ ...skill, references: references.get(skill.name) ?? [] })),
      },
      { exit, findings },
    );
  } catch (error) {
    return failure("skill list", error, options.registryRoot ?? options.cwd ?? process.cwd());
  }
}

/** Inspect one canonical identity; frontmatter names never redirect its lookup. */
export async function showSkill(
  name: string,
  options: RegistryOptions = {},
): Promise<ResultEnvelope<SkillShowData | null>> {
  try {
    const registry = await discoverRegistry(options);
    const path = await canonicalSkill(registry.root, name);
    const metadata = await readSkillMetadata(path);
    const findings: Diagnostic[] = [];
    const references = await compositionReferences(registry.root, findings);
    return makeResult(
      "skill show",
      { registry, skill: { name, path, ...metadata, references: references.get(name) ?? [] } },
      { exit: findings.length ? ExitCode.PARTIAL : ExitCode.SUCCESS, findings },
    );
  } catch (error) {
    return failure("skill show", error, options.registryRoot ?? options.cwd ?? process.cwd());
  }
}
