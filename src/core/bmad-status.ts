import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { rcompare, valid } from "semver";
import type {
  BmadCanonicalStatus,
  BmadExplainData,
  BmadExplainOptions,
  BmadReference,
  BmadStatusData,
  BmadStatusOptions,
} from "./bmad-types.js";
import { canonicalSkill, packInventory, setMembers } from "./composition.js";
import { captureContent, digestContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import { isSkillName } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { verifyPack } from "./packs.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";

/** Semantic version ordering consistent with the existing packs resolver (rcompare). */
function highestVersion(versions: readonly string[]): string | null {
  const validVersions = versions.filter((version) => valid(version) !== null);
  if (validVersions.length) return [...validVersions].sort(rcompare)[0] ?? null;
  return [...versions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).at(-1) ?? null;
}

function bmadError<T>(command: string, error: unknown): ResultEnvelope<T | null> {
  if (error instanceof SkillexError) {
    return makeResult(command, null, { exit: error.exit, findings: error.findings });
  }
  return makeResult(command, null, {
    exit: ExitCode.FAILURE,
    findings: [
      {
        code: "E_IO",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        fix: "Check the registry paths and their permissions, then retry.",
      },
    ],
  });
}

async function isFrozenBmad(registryRoot: string, name: string): Promise<boolean> {
  const path = join(registryRoot, "all-skills", name);
  const info = await inspectPath(path);
  if (!info?.isDirectory()) return false;
  const metadata = await readSkillMetadata(path).catch(() => null);
  const origin = metadata?.provenance?.origin;
  return (
    !!origin &&
    typeof origin === "object" &&
    !Array.isArray(origin) &&
    (origin as Record<string, unknown>).type === "bmad-freeze"
  );
}

async function compositionReferences(registryRoot: string, name: string): Promise<BmadReference[]> {
  const references: BmadReference[] = [];
  const sets = await inspectPath(join(registryRoot, "sets"));
  if (sets?.isDirectory()) {
    for (const entry of (await readdir(join(registryRoot, "sets"), { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      if (!entry.isDirectory()) continue;
      try {
        const members = await setMembers(registryRoot, entry.name);
        if (members.names.includes(name)) references.push({ kind: "set", name: entry.name });
      } catch {
        /* Unreadable compositions stay out of the explanation; status reports them. */
      }
    }
  }
  const packs = await inspectPath(join(registryRoot, "packs"));
  if (packs?.isDirectory()) {
    for (const entry of (await readdir(join(registryRoot, "packs"), { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      // Same discovery policy as the packs resolver: hidden/internal families
      // (e.g. .archived-bmad-* retirement archives) are not pack compositions.
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      if (!entry.isDirectory()) continue;
      const familyPath = join(registryRoot, "packs", entry.name);
      for (const version of (await readdir(familyPath, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (version.name.startsWith(".") || version.name.startsWith("_")) continue;
        // Flat legacy families keep README.md (and their root pack.toml/skills)
        // beside real version directories; those files are not version candidates.
        // Skip them BEFORE joining pack.toml — lstat on README.md/pack.toml fails
        // with ENOTDIR. Mirrors the generic packs resolver's discovery policy.
        if (!version.isDirectory() && !version.isSymbolicLink()) continue;
        const versionPath = join(familyPath, version.name);
        const manifest = await inspectPath(join(versionPath, "pack.toml"));
        if (!manifest?.isFile()) continue;
        try {
          const inventory = await packInventory(registryRoot, {
            name: entry.name,
            version: version.name,
            optional: false,
          });
          if (inventory.names.includes(name))
            references.push({ kind: "pack", name: entry.name, version: version.name });
        } catch {
          /* Invalid packs are surfaced by pack verify, not hidden here. */
        }
      }
    }
  }
  return references;
}

/**
 * Read-only traceability for the BMAD canonical skills present in a registry. Every
 * frozen BMAD skill is traced against its recorded baseline digest; undeclared pack
 * children are reported as traceability gaps instead of a misleading green verify.
 */
export async function inspectBmadStatus(
  options: BmadStatusOptions = {},
): Promise<ResultEnvelope<BmadStatusData | null>> {
  const command = "bmad status";
  try {
    const registry = await discoverRegistry(options);
    const catalog = join(registry.root, "all-skills");
    await requireDirectory(catalog, "E_NO_REGISTRY");
    const names: string[] = [];
    for (const entry of (await readdir(catalog, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      // Skip hidden owned artifacts (replace staging/crash-recovery backups like
      // .skillex-bmad-<name>.<pid>.<ts>.backup) and any name that is not a valid
      // canonical skill name. Their copied .source.yaml receipts would otherwise
      // qualify them as frozen BMAD and then die on canonicalSkill/isSkillName,
      // bricking the very inspection tool the crash-recovery path points users at.
      if (entry.name.startsWith(".") || !isSkillName(entry.name)) continue;
      if (await isFrozenBmad(registry.root, entry.name)) names.push(entry.name);
    }
    const skills: BmadCanonicalStatus[] = [];
    const drifted: string[] = [];
    const findings: Diagnostic[] = [];
    // Composition grounding is computed once: a canonical skill only counts as
    // traced when a set or pack manifest actually references it. Orphaned frozen
    // receipts (no composition membership) are reported, never silently green.
    const referenceSets = new Set<string>();
    const setsInfo = await inspectPath(join(registry.root, "sets"));
    if (setsInfo?.isDirectory()) {
      for (const entry of await readdir(join(registry.root, "sets"), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        try {
          const members = await setMembers(registry.root, entry.name);
          for (const name of members.names) referenceSets.add(name);
        } catch {
          findings.push({
            code: "E_BMAD_COMPOSITION_INVALID",
            severity: "error",
            path: join(registry.root, "sets", entry.name),
            message: `Set ${entry.name} cannot be read; its BMAD membership is unknown.`,
            fix: "Repair or remove the malformed set composition, then re-run bmad status.",
          });
        }
      }
    }
    const malformedPacks: string[] = [];
    const packsInfo = await inspectPath(join(registry.root, "packs"));
    if (packsInfo?.isDirectory()) {
      for (const family of await readdir(join(registry.root, "packs"), {
        withFileTypes: true,
      })) {
        // Same discovery policy as the packs resolver: hidden/internal families
        // (e.g. .archived-bmad-* retirement archives) are not pack compositions.
        if (family.name.startsWith(".") || family.name.startsWith("_")) continue;
        if (!family.isDirectory()) continue;
        const familyPath = join(registry.root, "packs", family.name);
        for (const version of await readdir(familyPath, { withFileTypes: true })) {
          if (version.name.startsWith(".") || version.name.startsWith("_")) continue;
          // Same as compositionReferences: non-directory entries in a family
          // (README.md, flat root manifests) are not version directories; skip
          // them before lstat of pack.toml or it fails with ENOTDIR.
          if (!version.isDirectory() && !version.isSymbolicLink()) continue;
          const manifestInfo = await inspectPath(join(familyPath, version.name, "pack.toml"));
          if (!manifestInfo) continue;
          try {
            const inventory = await packInventory(registry.root, {
              name: family.name,
              version: version.name,
              optional: false,
            });
            const memberSet = new Set(inventory.names);
            if (family.name === "bmad") {
              for (const name of memberSet) referenceSets.add(name);
            }
          } catch {
            malformedPacks.push(`${family.name}@${version.name}`);
          }
        }
      }
    }
    if (malformedPacks.length) {
      findings.push({
        code: "E_BMAD_COMPOSITION_INVALID",
        severity: "error",
        path: join(registry.root, "packs"),
        message: `BMAD-relevant pack compositions are malformed or unreadable: ${malformedPacks.sort().join(", ")}.`,
        fix: "Repair the pack manifests, then re-run bmad status for an honest trace.",
      });
    }
    for (const name of names) {
      const path = await canonicalSkill(registry.root, name);
      const metadata = await readSkillMetadata(path);
      const origin = metadata.provenance?.origin;
      const originRecord =
        origin && typeof origin === "object" && !Array.isArray(origin)
          ? (origin as Record<string, unknown>)
          : null;
      const recordedDigest =
        originRecord && typeof originRecord.digest === "string" ? originRecord.digest : null;
      const references = await compositionReferences(registry.root, name);
      const referenceNames = references
        .map((reference) => `${reference.name}${reference.version ? `@${reference.version}` : ""}`)
        .sort();
      const referenced = referenceSets.has(name);
      let state: BmadCanonicalStatus["state"] = "ok";
      let digest: string | null = null;
      try {
        const content = await captureContent(path);
        const entries = content.entries.filter((item) => item.path !== ".source.yaml");
        digest = digestContent(entries);
        if (recordedDigest !== digest) {
          state = "modified";
          drifted.push(name);
          findings.push({
            code: "W_BMAD_DRIFT",
            severity: "warning",
            name,
            path,
            message: `Frozen BMAD skill ${name} no longer matches its recorded baseline digest.`,
            fix: "Re-run skillex bmad freeze for the matching source install, or restore the recorded bytes.",
          });
        }
      } catch (error) {
        state = "foreign";
        findings.push({
          code: "E_BMAD_CONTENT_INVALID",
          severity: "error",
          name,
          path,
          message: `Cannot digest frozen BMAD skill ${name}: ${error instanceof Error ? error.message : String(error)}`,
          fix: "Inspect the canonical directory; restore real skill content before selecting it.",
        });
      }
      if (!referenced) {
        findings.push({
          code: "W_BMAD_ORPHAN",
          severity: "warning",
          name,
          path,
          message: `Frozen BMAD skill ${name} is not referenced by any set or pack manifest; it is excluded from the traced count.`,
          fix: "Reference it from a set or pack, re-freeze with --replace, or remove the orphaned canonical definition.",
        });
      }
      skills.push({
        name,
        path,
        state,
        digest,
        recordedDigest,
        references: referenceNames,
        provenance: metadata.provenance,
      });
    }
    // Pack membership traceability: a green pack verify must not hide undeclared members.
    const packRef = "bmad";
    let pack: string | null = null;
    let packMembers: readonly string[] = [];
    let packVerified: boolean | null = null;
    const untraced: string[] = [];
    const family = await inspectPath(join(registry.root, "packs", packRef));
    if (family?.isDirectory()) {
      const versions: string[] = [];
      for (const entry of await readdir(join(registry.root, "packs", packRef), {
        withFileTypes: true,
      })) {
        if (
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          (await inspectPath(join(registry.root, "packs", packRef, entry.name, "pack.toml")))
        ) {
          versions.push(entry.name);
        }
      }
      const selected = highestVersion(versions);
      if (selected) {
        pack = `${packRef}@${selected}`;
        const inventory = await packInventory(registry.root, {
          name: packRef,
          version: selected,
          optional: false,
        });
        packMembers = inventory.names;
        const declared = new Set(inventory.names);
        const present = new Set<string>();
        const skillsRoot = join(registry.root, "packs", packRef, selected, "skills");
        const rootInfo = await inspectPath(skillsRoot);
        if (rootInfo?.isDirectory()) {
          for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
            present.add(entry.name);
          }
        }
        for (const name of present) {
          if (!declared.has(name)) untraced.push(name);
        }
        for (const name of declared) {
          if (!present.has(name)) untraced.push(name);
        }
        const verified = await verifyPack(pack, { registryRoot: registry.root });
        packVerified = verified.ok;
        if (untraced.length) {
          findings.push({
            code: "W_BMAD_UNDECLARED_MEMBER",
            severity: "warning",
            path: skillsRoot,
            message: `BMAD pack ${pack} has members without a manifest declaration or links without a rendered member: ${untraced.sort().join(", ")}.`,
            fix: "Re-run skillex bmad freeze for the matching source install to reconcile membership.",
          });
        }
        if (verified.ok === false) {
          for (const finding of verified.findings) {
            if (!findings.some((existing) => existing.code === finding.code)) {
              findings.push(finding);
            }
          }
        }
      }
    }
    // A skill is traced only when its baseline digest matches AND a real set or
    // pack composition references it; orphaned receipts never count as traced.
    const traced = skills.filter(
      (skill) => skill.state === "ok" && referenceSets.has(skill.name),
    ).length;
    return makeResult(
      command,
      {
        registry,
        skills,
        traced,
        drifted,
        untraced,
        pack,
        packMembers,
        packVerified,
        findings: [],
      },
      {
        exit: findings.some((finding) => finding.severity === "error")
          ? ExitCode.PARTIAL
          : ExitCode.SUCCESS,
        findings,
      },
    );
  } catch (error) {
    return bmadError(command, error);
  }
}

/** Read-only explanation of one canonical BMAD skill: provenance, baseline, references. */
export async function explainBmadSkill(
  name: string,
  options: BmadExplainOptions = {},
): Promise<ResultEnvelope<BmadExplainData | null>> {
  const command = "bmad explain";
  try {
    if (!isSkillName(name)) {
      return makeResult(command, null, {
        exit: ExitCode.CONFIG,
        findings: [
          {
            code: "E_SKILL_NAME",
            severity: "error",
            message: `Invalid canonical skill name: ${name}`,
            fix: "Use a lowercase single-component canonical name.",
          },
        ],
      });
    }
    const registry = await discoverRegistry(options);
    const path = await canonicalSkill(registry.root, name);
    const metadata = await readSkillMetadata(path);
    const origin = metadata.provenance?.origin;
    const originRecord =
      origin && typeof origin === "object" && !Array.isArray(origin)
        ? (origin as Record<string, unknown>)
        : null;
    const bmadVersion =
      originRecord && typeof originRecord.bmad_version === "string"
        ? originRecord.bmad_version
        : null;
    const findings: Diagnostic[] = [];
    if (originRecord?.type !== "bmad-freeze") {
      findings.push({
        code: "I_BMAD_NOT_FROZEN",
        severity: "info",
        name,
        path,
        message: `Skill ${name} is not a BMAD freeze import; explain treats it as an ordinary canonical skill.`,
        fix: "Use skillex skill show for non-BMAD canonical definitions.",
      });
    }
    const content = await captureContent(path);
    const entries = content.entries.filter((item) => item.path !== ".source.yaml");
    const digest = digestContent(entries);
    const recordedDigest =
      originRecord && typeof originRecord.digest === "string" ? originRecord.digest : null;
    if (recordedDigest !== null && recordedDigest !== digest) {
      findings.push({
        code: "W_BMAD_DRIFT",
        severity: "warning",
        name,
        path,
        message: `Skill ${name} no longer matches its recorded baseline digest.`,
        fix: "Re-run skillex bmad freeze for the matching source install, or restore the recorded bytes.",
      });
    }
    const references = await compositionReferences(registry.root, name);
    if (!references.length) {
      findings.push({
        code: "I_BMAD_UNREFERENCED",
        severity: "info",
        name,
        path,
        message: `Skill ${name} is not referenced by any set or pack manifest.`,
        fix: "Reference it from a set or pack, or remove the unused canonical definition.",
      });
    }
    return makeResult(
      command,
      {
        registry,
        skill: {
          name,
          canonicalPath: path,
          digest,
          recordedDigest,
          modifiedLocally:
            typeof metadata.provenance?.modified_locally === "boolean"
              ? metadata.provenance.modified_locally
              : null,
          bmadVersion,
          references,
          findings: [],
        },
      },
      { exit: ExitCode.SUCCESS, findings },
    );
  } catch (error) {
    return bmadError(command, error);
  }
}
