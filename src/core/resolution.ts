import { canonicalSkill, packInventory, setMembers, setMemberTarget } from "./composition.js";
import { discoverRegistry, discoverScopes } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { parseManifest, readManifest } from "./manifest.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type {
  ExcludedBinding,
  Resolution,
  ResolvedBinding,
  ResolvedPack,
  ResolvedScope,
  ResolveOptions,
  ScopeLocation,
  SkillOrigin,
  SkillsManifest,
} from "./selection.js";

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
    const selectedPack = manifest.packs[0];
    let pack: ResolvedPack | undefined;
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
    if (selectedPack) {
      try {
        const inventory = await packInventory(registry.root, selectedPack);
        pack = {
          name: inventory.name,
          version: inventory.version,
          path: inventory.path,
          skillsRoot: inventory.skillsRoot,
        };
        for (const name of inventory.names) {
          contribute(bindings, name, await canonicalSkill(registry.root, name), [
            origin("pack", `${inventory.name}@${inventory.version}`),
          ]);
        }
      } catch (error) {
        if (!optionalAbsence(error, selectedPack.optional, findings, location.scope)) throw error;
        // A full loadout cannot degrade to a subset or an ordinary selection.
        bindings.clear();
        pack = undefined;
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
      for (const selectedSet of manifest.sets) {
        const contribution = origin("set", selectedSet.name);
        try {
          const inventory = await setMembers(registry.root, selectedSet.name);
          const omit = new Set(selectedSet.exclude);
          const include =
            selectedSet.include === undefined ? undefined : new Set(selectedSet.include);
          for (const name of inventory.names) {
            if (omit.has(name) || (include && !include.has(name))) {
              excluded.push({
                name,
                origins: [contribution],
                by: "set",
                reference: selectedSet.name,
              });
            }
          }
          const requested =
            selectedSet.include === undefined ? inventory.names : [...new Set(selectedSet.include)];
          for (const name of requested.filter((member) => !omit.has(member))) {
            try {
              if (!inventory.names.includes(name)) {
                fail(
                  "E_SET_MEMBER_MISSING",
                  `Set ${selectedSet.name} has no member named ${name}.`,
                  {
                    path: inventory.path,
                    name,
                    fix: "Correct the set include list or add the canonical reference.",
                  },
                  ExitCode.REFUSED,
                );
              }
              contribute(
                bindings,
                name,
                await setMemberTarget(registry.root, inventory.path, name),
                [contribution],
              );
            } catch (error) {
              if (!optionalAbsence(error, selectedSet.optional, findings, location.scope))
                throw error;
            }
          }
        } catch (error) {
          if (!optionalAbsence(error, selectedSet.optional, findings, location.scope)) throw error;
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
      mode: selectedPack ? "pack" : "composed",
      ...(pack === undefined ? {} : { pack }),
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
  const findings: Diagnostic[] = [];
  try {
    const locations = await discoverScopes(options);
    const projectManifest = locations.project
      ? await readManifest(locations.project.path)
      : undefined;
    const needsGlobal =
      locations.writeScopes.includes("global") ||
      (projectManifest?.inheritGlobal && projectManifest.packs.length === 0);
    const scopes: ResolvedScope[] = [];
    let global: ResolvedScope | undefined;
    const context = { ...options, home: locations.global.root };
    if (needsGlobal) {
      const manifest = locations.global.exists
        ? await readManifest(locations.global.path)
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
