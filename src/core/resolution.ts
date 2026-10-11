import { isDeepStrictEqual } from "node:util";
import { canonicalSkill, packInventory, setMembers, setMemberTarget } from "./composition.js";
import { verifyDerivedMembers } from "./derivation.js";
import { discoverRegistry, discoverScopes } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { parseManifest, readManifest } from "./manifest.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type {
  ExcludedBinding,
  Resolution,
  ResolvedBinding,
  ResolvedScope,
  ResolvedSet,
  ResolveOptions,
  ScopeLocation,
  SkillOrigin,
  SkillsManifest,
} from "./selection.js";
import { readSetOrigin } from "./set-origin.js";

const OPTIONAL_ABSENCE = new Set([
  "E_SET_MISSING",
  "E_SET_MEMBER_MISSING",
  "E_SKILL_MISSING",
  "E_PACK_MISSING",
]);

function optionalAbsence(
  error: unknown,
  optional: boolean,
  findings: Diagnostic[],
  scope: string,
): boolean {
  if (
    !optional ||
    !(error instanceof SkillexError) ||
    !error.findings.every((finding) => OPTIONAL_ABSENCE.has(finding.code))
  )
    return false;
  for (const finding of error.findings) {
    findings.push({ ...finding, scope, code: "W_OPTIONAL_SKIPPED", severity: "warning" });
  }
  return true;
}

function contribute(
  bindings: Map<string, ResolvedBinding>,
  name: string,
  path: string,
  origins: readonly SkillOrigin[],
): void {
  const existing = bindings.get(name);
  if (existing && existing.path !== path) {
    fail(
      "E_DIVERGENT_CANONICAL_NAME",
      `Canonical name ${name} resolves to different definitions.`,
      {
        name,
        path,
        detail: [`earlier ${existing.path}`, `later ${path}`],
        fix: "Use one canonical catalog definition for this name; migrate or rename the conflicting selection.",
      },
      ExitCode.REFUSED,
    );
  }
  bindings.set(name, { name, path, origins: [...(existing?.origins ?? []), ...origins] });
}

async function resolveScope(
  location: ScopeLocation,
  manifest: SkillsManifest,
  inherited: ResolvedScope | undefined,
  options: ResolveOptions,
  findings: Diagnostic[],
): Promise<ResolvedScope> {
  try {
    // Both relative overrides and checkout discovery use the invocation cwd.
    // Scope-specific registry identities still select their own cache first.
    const registry = await discoverRegistry({
      ...options,
      ...(manifest.registry === undefined ? {} : { registry: manifest.registry }),
    });
    const bindings = new Map<string, ResolvedBinding>();
    const excluded: ExcludedBinding[] = [];
    const origin = (kind: SkillOrigin["kind"], reference: string): SkillOrigin => ({
      scope: location.scope,
      manifest: manifest.path,
      kind,
      reference,
    });
    const selectedSet = manifest.sets[0];
    let set: ResolvedSet | undefined;
    if (manifest.scope && manifest.scope !== location.scope) {
      findings.push({
        code: "W_SCOPE_MISMATCH",
        severity: "warning",
        message: `Manifest labels itself ${manifest.scope}; its location selects ${location.scope}.`,
        path: manifest.path,
        scope: location.scope,
        fix: "Correct the advisory scope label to match the manifest's location.",
      });
    }
    if (selectedSet) {
      // A set exclusively replaces this scope's root: inheritance is replaced,
      // and competing selectors are refused unless this scope owns a derived
      // set whose materialization already includes them.
      try {
        const inventory = await setMembers(registry.root, selectedSet.name);
        set = { name: selectedSet.name, path: inventory.path };
        const derived = (await readSetOrigin(inventory.path))?.derived;
        const owned =
          derived !== undefined &&
          derived.owner.scope === location.scope &&
          derived.owner.root === location.root;
        if (owned) {
          const declared = {
            packs: [...derived.packs],
            skills: [...derived.skills],
            removed: [...derived.removed],
          };
          const selected = {
            packs: manifest.packs.map((pack) =>
              pack.version === undefined ? pack.name : `${pack.name}@${pack.version}`,
            ),
            skills: manifest.skills.map((skill) => skill.name),
            removed: [...manifest.exclude],
          };
          if (!isDeepStrictEqual(declared, selected)) {
            fail(
              "E_SET_DRIFT",
              `Set ${selectedSet.name} was derived from a different selection than this manifest declares.`,
              {
                path: inventory.path,
                detail: [
                  `origin metadata: ${JSON.stringify(declared)}`,
                  `manifest: ${JSON.stringify(selected)}`,
                ],
                fix: "Re-run the skillex enable/disable command that owns this derived set, or run skillex normalize --dry-run to plan the repair.",
              },
              ExitCode.REFUSED,
            );
          }
        } else {
          const competing =
            manifest.packs.length > 0 || manifest.skills.length > 0 || manifest.exclude.length > 0;
          if (competing)
            fail(
              "E_SET_CONFLICT",
              `Set ${selectedSet.name} exclusively replaces this scope's root; packs, skills, and exclusions cannot be added through it.`,
              {
                path: manifest.path,
                fix: `Run skillex enable pack or skillex enable skill to derive a scope-owned set from ${selectedSet.name}, or remove the competing selections. skillex normalize --dry-run plans this repair.`,
              },
              ExitCode.REFUSED,
            );
        }
        // Even another scope's derived set must be a complete projection of
        // its own sidecar. Only comparison to this manifest is owner-specific.
        if (derived) await verifyDerivedMembers(registry.root, inventory, derived);
        for (const name of inventory.names) {
          contribute(bindings, name, await setMemberTarget(registry.root, inventory.path, name), [
            origin("set", selectedSet.name),
          ]);
        }
      } catch (error) {
        // An optional absent set skips its whole root replacement; a root that a
        // full set cannot honor is never degraded to a partial activation.
        if (!optionalAbsence(error, selectedSet.optional, findings, location.scope)) throw error;
        bindings.clear();
        set = undefined;
      }
    } else {
      if (manifest.inheritGlobal && inherited) {
        for (const binding of inherited.bindings) {
          contribute(bindings, binding.name, binding.path, [
            ...binding.origins,
            origin("inherit", "global"),
          ]);
        }
      }
      for (const selectedPack of manifest.packs) {
        try {
          const inventory = await packInventory(registry.root, selectedPack);
          const reference = `${inventory.name}@${inventory.version}`;
          for (const name of inventory.names) {
            contribute(bindings, name, await canonicalSkill(registry.root, name), [
              origin("pack", reference),
            ]);
          }
        } catch (error) {
          if (!optionalAbsence(error, selectedPack.optional, findings, location.scope)) throw error;
        }
      }
      for (const skill of manifest.skills) {
        contribute(bindings, skill.name, await canonicalSkill(registry.root, skill.name), [
          origin("skill", skill.name),
        ]);
      }
      for (const name of new Set(manifest.exclude)) {
        excluded.push({
          name,
          origins: bindings.get(name)?.origins ?? [],
          by: "scope",
          reference: manifest.path,
        });
        bindings.delete(name);
      }
    }
    return {
      scope: location.scope,
      root: location.root,
      manifest,
      registry,
      mode: selectedSet ? "set" : "composed",
      ...(set === undefined ? {} : { set }),
      bindings: [...bindings.values()],
      excluded,
    };
  } catch (error) {
    if (error instanceof SkillexError)
      throw new SkillexError(
        error.exit,
        error.findings.map((finding) => ({ ...finding, scope: location.scope })),
      );
    throw error;
  }
}

/** Resolve intent offline. No manifests, catalog definitions, or activation paths are written. */
export async function resolveSelection(
  options: ResolveOptions = {},
): Promise<ResultEnvelope<Resolution | null>> {
  return resolveSelectionWithManifests(options);
}

/** Internal read-only preview: substitute only named manifests in discovered scopes. */
export async function resolveSelectionWithManifests(
  options: ResolveOptions = {},
  proposed: ReadonlyMap<string, unknown> = new Map(),
  expected: ReadonlyMap<string, unknown> = new Map(),
): Promise<ResultEnvelope<Resolution | null>> {
  const findings: Diagnostic[] = [];
  try {
    if (options.inheritGlobal !== undefined && typeof options.inheritGlobal !== "boolean")
      fail("E_MANIFEST", "inheritGlobal must be boolean.", {
        fix: "Supply a boolean inheritance override or omit it to use the manifest.",
      });
    const locations = await discoverScopes(options);
    const read = async (path: string): Promise<SkillsManifest> => {
      const manifest = proposed.has(path)
        ? parseManifest(proposed.get(path), path)
        : await readManifest(path);
      if (
        expected.has(path) &&
        !isDeepStrictEqual(manifest, parseManifest(expected.get(path), path))
      )
        fail(
          "E_MANIFEST_CHANGED",
          "The saved selection changed before activation could read it.",
          {
            path,
            fix: "Preserve the current declaration, inspect the intervening edit, and run sync to apply the intended selection.",
          },
          ExitCode.REFUSED,
        );
      return manifest;
    };
    const savedProjectManifest = locations.project ? await read(locations.project.path) : undefined;
    const projectManifest =
      savedProjectManifest && options.inheritGlobal !== undefined
        ? { ...savedProjectManifest, inheritGlobal: options.inheritGlobal }
        : savedProjectManifest;
    const needsGlobal =
      locations.writeScopes.includes("global") ||
      (projectManifest?.inheritGlobal && projectManifest.sets.length === 0);
    const scopes: ResolvedScope[] = [];
    let global: ResolvedScope | undefined;
    const context = { ...options, home: locations.global.root };
    if (needsGlobal) {
      const manifest =
        locations.global.exists || expected.has(locations.global.path)
          ? await read(locations.global.path)
          : parseManifest({}, locations.global.path);
      global = await resolveScope(locations.global, manifest, undefined, context, findings);
      scopes.push(global);
    }
    if (locations.project && projectManifest) {
      scopes.push(
        await resolveScope(locations.project, projectManifest, global, context, findings),
      );
    }
    return makeResult(
      "resolve",
      { scopes, writeScopes: locations.writeScopes },
      {
        exit: findings.some((finding) => finding.code === "W_OPTIONAL_SKIPPED")
          ? ExitCode.PARTIAL
          : ExitCode.SUCCESS,
        findings,
      },
    );
  } catch (error) {
    if (error instanceof SkillexError) {
      return makeResult("resolve", null, {
        exit: error.exit,
        findings: [...findings, ...error.findings],
      });
    }
    return makeResult("resolve", null, {
      exit: ExitCode.FAILURE,
      findings: [
        ...findings,
        {
          code: "E_IO",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          fix: "Check the referenced files and permissions, then retry.",
        },
      ],
    });
  }
}
