import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { stringify } from "yaml";
import {
  BMAD_PACK_NAME,
  type BmadCommandScan,
  bmadPackPath,
  inspectBmadSource,
  readBmadSkillManifest,
  requireRenderedSkill,
  resolveBmadSource,
  scanBmadCommands,
} from "./bmad-source.js";
import type {
  BmadCommandClient,
  BmadFreezeChange,
  BmadFreezeData,
  BmadFreezeOptions,
  BmadProvenance,
  BmadSkillInventory,
  BmadSkillManifestEntry,
} from "./bmad-types.js";
import { withCatalogLock } from "./catalog-lock.js";
import { type ContentEntry, captureContent, digestContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath, requireDirectory } from "./filesystem.js";
import { isVersionComponent } from "./manifest.js";
import { readSkillMetadata } from "./metadata.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";

interface SkillPlan {
  readonly entry: BmadSkillManifestEntry;
  readonly sourcePath: string;
  readonly action: "create" | "replace" | "unchanged" | "skipped";
  readonly digest: string;
  readonly recordedDigest: string | null;
  readonly entries: readonly ContentEntry[];
  readonly rootMode: number;
  readonly reason: string | null;
}

interface FreezePlan {
  readonly registry: RegistrySelection;
  readonly provenance: BmadProvenance;
  readonly packPath: string;
  readonly version: string;
  readonly dryRun: boolean;
  readonly replace: boolean;
  readonly commandsEnabled: boolean;
  readonly skills: readonly SkillPlan[];
  readonly foreignNames: readonly string[];
  readonly commands: BmadCommandScan;
  readonly priorCommandClients: readonly BmadCommandClient[] | null;
  readonly retiredPacks: readonly string[];
  readonly archivePath: string | null;
  /** Deterministic manifest bytes this freeze would publish (null = no prior ownership). */
  readonly expectedManifest: Buffer | null;
  /** Original on-disk manifest bytes when owned and semantically equal to expected. */
  readonly retainedManifest: { bytes: Buffer; mode: number } | null;
  readonly changes: BmadFreezeChange[];
}

interface OriginFacts {
  readonly bmadVersion: string | null;
  readonly digest: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeError(command: string, error: unknown): ResultEnvelope<BmadFreezeData | null> {
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
        fix: "Check the source and registry paths and their permissions, then retry the freeze.",
      },
    ],
  });
}

function refuse(code: Diagnostic["code"], message: string, path: string, fix: string): never {
  fail(code, message, { path, fix }, ExitCode.REFUSED);
}

function changedDuring(path: string): never {
  refuse(
    "E_BMAD_TARGET_CHANGED",
    `A BMAD destination changed during the freeze: ${path}`,
    path,
    "Inspect the destination and retry; unrelated content is never removed by a freeze.",
  );
}

async function originFacts(target: string): Promise<OriginFacts> {
  const metadata = await readSkillMetadata(target).catch(() => null);
  const origin = metadata?.provenance?.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
    return { bmadVersion: null, digest: null };
  }
  const record = origin as Record<string, unknown>;
  return {
    bmadVersion: typeof record.bmad_version === "string" ? record.bmad_version : null,
    digest: typeof record.digest === "string" ? record.digest : null,
  };
}

/**
 * Compare imported content with the current canonical tree. Relative link targets are
 * re-anchored to each tree's own root, so byte-equal skills compare equal regardless of
 * where they live.
 */
function sameBodies(
  imported: readonly ContentEntry[],
  current: readonly ContentEntry[],
  importedRoot: string,
  currentRoot: string,
): boolean {
  if (imported.length !== current.length) return false;
  for (let index = 0; index < imported.length; index += 1) {
    const left = imported[index] as ContentEntry;
    const right = current[index] as ContentEntry;
    if (left.path !== right.path || left.kind !== right.kind) return false;
    if (left.kind === "file" && right.kind === "file" && !left.bytes.equals(right.bytes))
      return false;
    if (left.kind === "link" && right.kind === "link") {
      const leftTarget = join(importedRoot, dirname(left.path), left.target);
      const rightTarget = join(currentRoot, dirname(right.path), right.target);
      if (leftTarget !== rightTarget) return false;
    }
  }
  return true;
}

function bmadReceipt(provenance: BmadProvenance, digest: string, sourcePath: string): ContentEntry {
  return {
    kind: "file",
    path: ".source.yaml",
    mode: 0o644,
    bytes: Buffer.from(
      `# Provenance recorded by skillex bmad freeze.\n${stringify({
        origin: {
          type: "bmad-freeze",
          bmad_version: provenance.installation.version,
          bmad_source_root: provenance.sourceRoot,
          imported_from: sourcePath,
          extracted_at: new Date().toISOString(),
          digest,
          skill_manifest_sha256: provenance.skillManifestSha256,
          files_manifest_sha256: provenance.filesManifestSha256,
          modules: provenance.modules.map((module) => ({
            name: module.name,
            version: module.version,
            ...(module.sha ? { sha: module.sha } : {}),
          })),
        },
        modified_locally: false,
      })}`,
    ),
  };
}

async function planSkillImport(
  entry: BmadSkillManifestEntry,
  sourceRoot: string,
  registry: RegistrySelection,
  provenance: BmadProvenance,
  replace: boolean,
): Promise<SkillPlan> {
  const sourcePath = await requireRenderedSkill(sourceRoot, entry.name);
  const content = await captureContent(sourcePath);
  const skillEntries = content.entries.filter((item) => item.path !== ".source.yaml");
  const digest = digestContent(skillEntries);
  const target = join(registry.root, "all-skills", entry.name);
  const info = await inspectPath(target);
  const rootMode = (await lstat(sourcePath)).mode & 0o777;
  if (!info) {
    return {
      entry,
      sourcePath,
      action: "create",
      digest,
      recordedDigest: null,
      entries: skillEntries,
      rootMode,
      reason: null,
    };
  }
  if (!info.isDirectory()) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `Canonical destination ${entry.name} exists and is not a real skill directory.`,
      target,
      "Migrate the conflicting content explicitly (skillex migrate) before freezing over this name.",
    );
  }
  const current = await captureContent(target);
  const currentEntries = current.entries.filter((item) => item.path !== ".source.yaml");
  const currentDigest = digestContent(currentEntries);
  const origin = await originFacts(target);
  if (origin.bmadVersion === null) {
    if (sameBodies(skillEntries, currentEntries, sourcePath, target)) {
      // Same bytes from an unknown origin: keep the existing receipt untouched.
      return {
        entry,
        sourcePath,
        action: "skipped",
        digest,
        recordedDigest: origin.digest,
        entries: skillEntries,
        rootMode,
        reason: "existing canonical bytes match but carry no bmad-freeze provenance",
      };
    }
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `Canonical skill ${entry.name} exists with different content and no BMAD freeze provenance.`,
      target,
      "A freeze never overwrites foreign canonical content. Preserve the existing bytes elsewhere before choosing --replace for a version switch.",
    );
  }
  if (
    origin.bmadVersion === provenance.installation.version &&
    sameBodies(skillEntries, currentEntries, sourcePath, target)
  ) {
    return {
      entry,
      sourcePath,
      action: "unchanged",
      digest,
      recordedDigest: origin.digest,
      entries: skillEntries,
      rootMode,
      reason: null,
    };
  }
  if (!replace) {
    refuse(
      "E_BMAD_VERSION_CONFLICT",
      `Canonical skill ${entry.name} is frozen at BMAD ${origin.bmadVersion ?? "unknown"} and the source install is ${provenance.installation.version}.`,
      target,
      "A freeze never silently changes a canonical definition pinned by another version. Re-freeze with --replace to make the explicit version switch, or import the other version under distinct canonical names.",
    );
  }
  // The replace gate compares the CURRENT canonical against its RECORDED baseline,
  // never against the new source bytes: a pristine canonical (unmodified since its
  // freeze) is safe to replace even when the release changed the skill's content.
  // An edited canonical no longer matches its recorded digest and is foreign.
  if (origin.digest === null || currentDigest !== origin.digest) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `--replace was refused for ${entry.name}: the existing canonical body differs from its recorded frozen baseline (locally modified).`,
      target,
      "Preserve the current bytes first, then retry; a freeze replaces only content it previously froze, never arbitrary edits.",
    );
  }
  return {
    entry,
    sourcePath,
    action: "replace",
    digest,
    recordedDigest: origin.digest,
    entries: skillEntries,
    rootMode,
    reason: null,
  };
}

function packManifest(plan: FreezePlan): Buffer {
  const document = {
    pack: {
      name: BMAD_PACK_NAME,
      version: plan.version,
      description: `BMAD ${plan.version} legacy skills/commands frozen from ${plan.provenance.sourceRoot} (reference-only pack; canonical bytes live in all-skills/).`,
    },
    freeform: { skills: plan.skills.map((skill) => skill.entry.name) },
    source: {
      type: "bmad-freeze",
      // Provenance ground truth: the ACTUAL BMAD installation version (identical to
      // every per-skill receipt). The --version override names the pack directory only
      // ([pack].version); recording it here would make the pack's own baseline check
      // flag the artifact the freeze just wrote.
      bmad_version: plan.provenance.installation.version,
      source_root: plan.provenance.sourceRoot,
      installation_version: plan.provenance.installation.version,
      ...(plan.provenance.installation.installDate
        ? { install_date: plan.provenance.installation.installDate }
        : {}),
      ...(plan.provenance.installation.lastUpdated
        ? { last_updated: plan.provenance.installation.lastUpdated }
        : {}),
      ...(plan.provenance.skillManifestSha256
        ? { skill_manifest_sha256: plan.provenance.skillManifestSha256 }
        : {}),
      ...(plan.provenance.filesManifestSha256
        ? { files_manifest_sha256: plan.provenance.filesManifestSha256 }
        : {}),
      files_manifest_declared: plan.provenance.filesManifestDeclared,
      files_manifest_missing: plan.provenance.filesManifestMissing,
      modules: plan.provenance.modules.map((module) => ({
        name: module.name,
        version: module.version,
        ...(module.source ? { source: module.source } : {}),
        ...(module.repoUrl ? { repo_url: module.repoUrl } : {}),
        ...(module.sha ? { sha: module.sha } : {}),
      })),
      commands: (plan.priorCommandClients ?? plan.commands.inventory.clients).map((client) => ({
        client: client.client,
        layout: client.layout,
        files: client.imported,
        dangling: client.dangling,
      })),
      prerequisites: [
        "Project runtime assets under {project-root}/_bmad (scripts, _config, config.toml, custom/) are NOT carried by this pack.",
        "Several frozen skills and commands reference {project-root}/_bmad at runtime; install or restore the matching BMAD tree in the consuming project.",
      ],
    },
  };
  return Buffer.from(stringifyToml(document));
}

function planChanges(plan: FreezePlan): BmadFreezeChange[] {
  const changes: BmadFreezeChange[] = [];
  for (const skill of plan.skills) {
    const target = join(plan.registry.root, "all-skills", skill.entry.name);
    if (skill.action === "create") {
      changes.push({ action: "import-skill", path: target, source: skill.sourcePath });
      for (const item of skill.entries) {
        changes.push({
          action:
            item.kind === "directory"
              ? "create-directory"
              : item.kind === "link"
                ? "create-link"
                : "copy-file",
          path: join(target, item.path),
          source: join(skill.sourcePath, item.path),
        });
      }
      changes.push({ action: "record-provenance", path: join(target, ".source.yaml") });
    } else if (skill.action === "replace") {
      changes.push({ action: "replace-skill", path: target, source: skill.sourcePath });
      changes.push({ action: "record-provenance", path: join(target, ".source.yaml") });
    } else {
      changes.push({
        action: `${skill.action}-skill`,
        path: target,
        source: skill.sourcePath,
      });
    }
    changes.push({
      action:
        skill.action === "create" || skill.action === "replace" ? "create-link" : "ensure-link",
      path: join(plan.packPath, "skills", skill.entry.name),
      source: join(plan.registry.root, "all-skills", skill.entry.name),
    });
  }
  for (const file of plan.commands.inventory.files) {
    changes.push({ action: "copy-command", path: file.path, source: file.sourcePath });
  }
  changes.push({ action: "write-manifest", path: join(plan.packPath, "pack.toml") });
  return changes;
}

function manifestIdentity(plan: FreezePlan): { bytes: Buffer; document: Record<string, unknown> } {
  const bytes = packManifest(plan);
  return {
    bytes,
    document: parseToml(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >,
  };
}

/**
 * Structural equality on parsed TOML values. Comments and key order are ignored;
 * any real value difference (including unknown metadata the user added) is a
 * difference, so authored edits are never silently discarded.
 */
function tomlValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!tomlValueEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) return false;
      if (!tomlValueEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Structural manifest comparison with configurable generated fields ignored.
 * Generated provenance is not authored content:
 * - [source].commands: reflects on-disk reality (dropped when recorded
 *   command files go missing); count-based carry is the honest design.
 * - [source].source_root and [pack].description: record WHERE the original
 *   import ran from (like every per-skill receipt). A same-install repeat
 *   must stay byte-identical even from a new checkout, so the prior values
 *   are carried forward instead of refusing or churning bytes.
 * Any other difference (authored keys, identity fields, membership, module
 * pins) is NOT tolerated.
 */
function manifestsEqualIgnoring(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  ignored: { source: readonly string[]; pack: readonly string[] },
): boolean {
  const strip = (doc: Record<string, unknown>) => {
    const clone: Record<string, unknown> = { ...doc };
    const source = isRecord(clone.source) ? { ...clone.source } : null;
    if (source) {
      for (const key of ignored.source) delete source[key];
      clone.source = source;
    }
    const pack = isRecord(clone.pack) ? { ...clone.pack } : null;
    if (pack) {
      for (const key of ignored.pack) delete pack[key];
      clone.pack = pack;
    }
    return clone;
  };
  return tomlValueEqual(strip(left), strip(right));
}

/**
 * True when the prior manifest's declared command inventory still matches the
 * scanner-eligible command files present under the pack's commands/ directory
 * (bmad-* non-~ real files only, mirroring scanBmadCommands). A foreign
 * non-command file (README.md, editor backup, client drop-in) is NOT disk
 * divergence: the freeze never adopts or deletes it, and it never licenses a
 * manifest republish.
 */
async function declaredInventoryMatchesDisk(
  priorSource: Record<string, unknown>,
  packPath: string,
): Promise<boolean> {
  const declared = Array.isArray(priorSource.commands) ? priorSource.commands : [];
  if (declared.length === 0) return false;
  for (const item of declared) {
    if (!isRecord(item) || typeof item.client !== "string" || typeof item.layout !== "string") {
      return false;
    }
    const files = typeof item.files === "number" ? item.files : 0;
    const directory = join(packPath, "commands", item.client);
    if ((await countEligibleCommandFiles(directory)) !== files) return false;
  }
  return true;
}

/**
 * Command-reality count aligned with the scanner (bmad-source.ts): only real
 * files whose name starts with `bmad-` and does not end with `~` count as
 * command inventory. Foreign files (README.md, editor backups, anything else)
 * inside the pack's commands/<client>/ tree are invisible to the inventory:
 * never counted, never adopted, never deleted, and never mistaken for disk
 * divergence that would license a manifest republish.
 */
async function countEligibleCommandFiles(directory: string): Promise<number> {
  const rootInfo = await inspectPath(directory);
  if (!rootInfo?.isDirectory()) return 0;
  let present = 0;
  for (const name of await readdir(directory)) {
    if (!name.startsWith("bmad-") || name.endsWith("~")) continue;
    const fileInfo = await inspectPath(join(directory, name));
    if (fileInfo?.isFile()) present += 1;
  }
  return present;
}

/**
 * True only when every declared [[source.commands]] entry carries EXCLUSIVELY
 * the keys and value types this freeze itself generates (client, layout,
 * files, dangling). Any unknown/authored field — an annotation, a note, a
 * client-added key — makes the declaration authored content: the freeze
 * refuses rather than sweeping it, regardless of on-disk command reality.
 * No sealed baseline is needed: unknown keys are detectable by shape alone.
 */
function isGeneratedCommandInventory(declared: unknown): boolean {
  if (!Array.isArray(declared)) return false;
  // Sorted so the comparison against Object.keys(item).sort() is exact.
  const expected = ["client", "dangling", "files", "layout"];
  for (const item of declared) {
    if (!isRecord(item)) return false;
    const keys = Object.keys(item).sort();
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
      return false;
    }
    if (
      typeof item.client !== "string" ||
      typeof item.layout !== "string" ||
      typeof item.files !== "number" ||
      typeof item.dangling !== "number"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Ownership preflight for a pre-existing pack.toml. The location under
 * packs/bmad/<version>/ is NOT ownership: other skillex commands can create a
 * physically identical path. Ownership is established only by a parseable
 * declaration carrying this freeze's own identity (pack.name/version,
 * source.type=bmad-freeze) and truthful provenance (the actual installation
 * version and source root this freeze verified from the source manifests).
 *
 * A foreign-identity or malformed declaration is refused here in the plan
 * phase — before ANY canonical/pack/command change — so --dry-run reports the
 * exact same refusal the apply would, and --replace cannot bypass foreign
 * identity (a version switch always lands in a NEW pack directory; the only
 * manifest this freeze may rewrite is its own unmodified one).
 *
 * An owned, identity-matching manifest is then compared against the
 * deterministic manifest this freeze would generate. Authored additions
 * (annotations, extra keys) or value conflicts are refused rather than
 * discarded; a semantically equal manifest is retained byte-for-byte (its
 * comments and formatting survive); only a byte-identical owned repeat is
 * treated as an idempotent no-op for the manifest rewrite.
 */
async function analyzeExistingManifest(
  manifestPath: string,
  plan: FreezePlan,
): Promise<{ expected: Buffer; retained: { bytes: Buffer; mode: number } | null }> {
  const { bytes: expected, document: expectedDoc } = manifestIdentity(plan);
  const info = await inspectPath(manifestPath);
  if (!info) return { expected, retained: null };
  if (!info.isFile()) {
    refuse(
      "E_BMAD_PACK_MANIFEST",
      "The existing BMAD pack manifest is not a real file.",
      manifestPath,
      "Inspect and repair the pack declaration before re-freezing.",
    );
  }
  let raw: Buffer;
  try {
    raw = await readFile(manifestPath);
  } catch {
    refuse(
      "E_BMAD_PACK_MANIFEST",
      "The existing BMAD pack manifest cannot be read.",
      manifestPath,
      "Inspect permissions and repair the pack declaration before re-freezing.",
    );
  }
  let prior: Record<string, unknown>;
  try {
    prior = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<
      string,
      unknown
    >;
  } catch {
    refuse(
      "E_BMAD_PACK_MANIFEST",
      "The existing BMAD pack manifest is malformed TOML; a freeze never rewrites bytes it cannot establish ownership of.",
      manifestPath,
      "Inspect the declaration, preserve it elsewhere, and remove it explicitly before re-freezing.",
    );
  }
  const priorPack = isRecord(prior.pack) ? prior.pack : null;
  const priorSource = isRecord(prior.source) ? prior.source : null;
  if (priorPack?.name !== BMAD_PACK_NAME || priorSource?.type !== "bmad-freeze") {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      "The existing pack declaration at the BMAD pack path is foreign content (not a bmad-freeze manifest this freeze wrote).",
      manifestPath,
      "A freeze never overwrites foreign content. Preserve the existing declaration elsewhere and remove it explicitly, or choose a different pack version.",
    );
  }
  if (priorPack?.version !== plan.version) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `The existing BMAD pack declaration records version ${String(priorPack?.version)} but this freeze publishes ${plan.version}.`,
      manifestPath,
      "A version switch is an explicit --replace transaction that retires the old pack into the archive and publishes a NEW pack directory; this freeze never rewrites a different-version declaration in place.",
    );
  }
  if (priorSource?.bmad_version !== plan.provenance.installation.version) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `The existing BMAD pack declaration records bmad_version ${String(priorSource?.bmad_version)} but the verified source installation is ${plan.provenance.installation.version}.`,
      manifestPath,
      "The declaration was edited after the freeze (or belongs to a different source install). Preserve it elsewhere and remove it explicitly before re-freezing.",
    );
  }
  if (tomlValueEqual(prior, expectedDoc)) {
    // Owned and semantically equal: retain the original bytes so authored
    // comments and formatting survive; the apply path skips the rewrite.
    const stat = await lstat(manifestPath);
    return { expected, retained: { bytes: raw, mode: stat.mode & 0o777 } };
  }
  if (
    manifestsEqualIgnoring(prior, expectedDoc, {
      source: ["commands", "source_root"],
      pack: ["description"],
    })
  ) {
    // Owned; the ONLY deltas are generated provenance fields. source_root and
    // the pack description record the ORIGINAL import location (like every
    // per-skill receipt): a same-install repeat must stay byte-identical even
    // when run from a new checkout, so the prior values are carried forward.
    // The command inventory reflects on-disk reality and is republished when
    // it changed. Authored bytes are never otherwise touched.
    const carried = structuredClone(expectedDoc) as Record<string, unknown>;
    const carriedSource = isRecord(carried.source)
      ? (carried.source as Record<string, unknown>)
      : {};
    if (typeof priorSource?.source_root === "string") {
      carriedSource.source_root = priorSource.source_root;
    }
    carried.source = carriedSource;
    const carriedPack = isRecord(carried.pack) ? (carried.pack as Record<string, unknown>) : {};
    if (typeof priorPack?.description === "string") {
      carriedPack.description = priorPack.description;
    }
    carried.pack = carriedPack;
    if (tomlValueEqual(prior, carried)) {
      const stat = await lstat(manifestPath);
      return { expected, retained: { bytes: raw, mode: stat.mode & 0o777 } };
    }
    // The manifest delta is confined to generated fields. A republish is
    // legitimate ONLY when BOTH hold:
    // 1. The prior [[source.commands]] entries carry exclusively the generated
    //    keys/types (client, layout, files, dangling). Any unknown/authored
    //    field makes the region authored content: user-authored metadata
    //    preservation wins over manifest truthfulness — tests and docs added
    //    by an implementer can never authorize deleting a user's note — so
    //    the freeze refuses regardless of on-disk command reality.
    // 2. On-disk command reality (scanner-eligible bmad-* files only) actually
    //    changed: then the inventory delta is generated truth (QF3b). A
    //    foreign README/backup/non-command file is invisible to this count.
    if (
      isGeneratedCommandInventory(priorSource?.commands) &&
      !(await declaredInventoryMatchesDisk(priorSource ?? {}, plan.packPath))
    ) {
      return { expected: Buffer.from(stringifyToml(carried)), retained: null };
    }
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      "The existing BMAD pack declaration was edited after the freeze (authored content inside or around the command inventory no longer matches what this freeze generates).",
      manifestPath,
      "A freeze never discards authored edits, even when on-disk command files changed. Preserve the edited declaration elsewhere and remove it explicitly before re-freezing, or restore the freeze-generated manifest.",
    );
  }
  refuse(
    "E_BMAD_FOREIGN_COLLISION",
    "The existing BMAD pack declaration was edited after the freeze (authored content no longer matches the manifest this freeze generates).",
    manifestPath,
    "A freeze never discards authored edits. Preserve the edited declaration elsewhere and remove it explicitly before re-freezing, or restore the freeze-generated manifest.",
  );
}

async function planFreeze(source: string, options: BmadFreezeOptions): Promise<FreezePlan> {
  const registry = await discoverRegistry(options);
  const sourceRoot = await resolveBmadSource(source, options);
  const provenance = await inspectBmadSource(sourceRoot);
  const version = options.version ?? provenance.installation.version;
  if (!isVersionComponent(version)) {
    refuse(
      "E_BMAD_VERSION",
      `Unsafe BMAD pack version: ${version}`,
      join(registry.root, "packs", BMAD_PACK_NAME),
      "Use the installation version as recorded in _bmad/_config/manifest.yaml, or pass a safe --version.",
    );
  }
  await requireDirectory(join(registry.root, "all-skills"), "E_NO_REGISTRY");
  const manifest = await readBmadSkillManifest(sourceRoot);
  const packPath = bmadPackPath(registry.root, version);
  const replace = options.replace === true;
  const commandsEnabled = options.commands !== false;
  const skills: SkillPlan[] = [];
  for (const entry of manifest.entries) {
    skills.push(await planSkillImport(entry, sourceRoot, registry, provenance, replace));
  }
  // Rendered bmad-* directories outside the declared manifest are installer-owned and
  // inventoried separately; a freeze never adopts them.
  const rendered: string[] = [];
  for (const name of (await readdir(join(sourceRoot, ".agents", "skills"))).sort()) {
    if (!name.startsWith("bmad-")) continue;
    const path = join(sourceRoot, ".agents", "skills", name);
    const info = await inspectPath(path);
    if (info?.isDirectory() && !info.isSymbolicLink()) rendered.push(name);
  }
  const declared = new Set(manifest.entries.map((entry) => entry.name));
  const foreignNames = rendered.filter((name) => !declared.has(name));
  const commands = commandsEnabled
    ? await scanBmadCommands(sourceRoot, packPath)
    : { inventory: { clients: [], files: [] }, totalFiles: 0, danglingFiles: 0 };
  // --no-commands repeat on an existing pack: the command assets are not rescanned
  // or touched, but the republished manifest must keep the prior command inventory
  // instead of falsely declaring zero captured commands (the idempotence contract
  // requires identical republished content). The prior manifest is accepted only
  // when it is a real file this freeze's pack identity could have written; the
  // declared inventory is carried only while every referenced command file is
  // still present on disk, so the manifest never claims provenance for missing
  // bytes. A fresh --no-commands freeze (no prior manifest) stays zero.
  let priorCommandClients: BmadCommandClient[] | null = null;
  if (!commandsEnabled) {
    const priorManifestPath = join(packPath, "pack.toml");
    const existingManifest = await inspectPath(priorManifestPath);
    if (existingManifest?.isFile()) {
      let prior: Record<string, unknown> = {};
      try {
        prior = parseToml(
          new TextDecoder("utf-8", { fatal: true }).decode(await readFile(priorManifestPath)),
        ) as Record<string, unknown>;
      } catch {
        /* An unreadable prior manifest is revalidated by the manifest preflight. */
      }
      const priorPack = isRecord(prior.pack) ? prior.pack : null;
      const priorSource = isRecord(prior.source) ? prior.source : null;
      if (
        priorPack?.name === BMAD_PACK_NAME &&
        priorPack.version === version &&
        priorSource?.type === "bmad-freeze"
      ) {
        const declared = Array.isArray(priorSource.commands) ? priorSource.commands : [];
        const carried: BmadCommandClient[] = [];
        let intact = declared.length > 0;
        for (const item of declared) {
          if (
            !isRecord(item) ||
            typeof item.client !== "string" ||
            typeof item.layout !== "string"
          ) {
            intact = false;
            break;
          }
          const files = typeof item.files === "number" ? item.files : 0;
          const dangling = typeof item.dangling === "number" ? item.dangling : 0;
          const directory = join(packPath, "commands", item.client);
          // Scanner-aligned eligibility: foreign non-command files inside
          // commands/<client>/ (README, editor backups) are never counted,
          // adopted, or deleted — they cannot mask a missing recorded file.
          if ((await countEligibleCommandFiles(directory)) !== files) {
            intact = false;
            break;
          }
          carried.push({
            client: item.client,
            layout: item.layout,
            directory,
            imported: files,
            dangling,
          });
        }
        if (intact) priorCommandClients = carried;
      }
    }
  }
  // --- Preflight: every destination conflict is detected BEFORE any write, so the
  // apply path can never leave a half-imported registry behind a refusal, and a dry
  // run reports the exact same refusals the apply would.
  const catalog = join(registry.root, "all-skills");
  if (commandsEnabled && replace) {
    // Replace owns its swap/backup parking spots for the duration of the transaction;
    // a pre-existing artifact there is foreign crash recovery, never clobbered.
    for (const skill of skills) {
      if (skill.action !== "replace") continue;
      for (const suffix of ["swap", "backup"]) {
        const artifact = join(catalog, `.skillex-bmad-${skill.entry.name}.${suffix}`);
        const info = await inspectPath(artifact);
        if (info) {
          refuse(
            "E_BMAD_FOREIGN_COLLISION",
            `A pre-existing ${suffix} artifact occupies the replace staging path for ${skill.entry.name}; refusing to delete content the freeze did not create.`,
            artifact,
            "Inspect the artifact (it may be crash recovery from an interrupted replace), move it aside explicitly, then retry.",
          );
        }
      }
    }
  }
  const familyPath = dirname(packPath);
  const familyInfo = await inspectPath(familyPath);
  if (familyInfo && !familyInfo.isDirectory()) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `The BMAD pack family path is not a real directory: ${familyPath}`,
      familyPath,
      "Inspect and migrate the conflicting content before re-freezing.",
    );
  }
  const versionInfo = await inspectPath(packPath);
  if (versionInfo && !versionInfo.isDirectory()) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `The BMAD pack version path is not a real directory: ${packPath}`,
      packPath,
      "Inspect and migrate the conflicting content before re-freezing.",
    );
  }
  // Ownership analysis of any pre-existing declaration happens once the plan is
  // fully determined (below), so dry-run and apply report identical refusals.
  const skillsRoot = join(packPath, "skills");
  const skillsRootInfo = await inspectPath(skillsRoot);
  if (skillsRootInfo && !skillsRootInfo.isDirectory()) {
    refuse(
      "E_BMAD_FOREIGN_COLLISION",
      `The BMAD pack skills root is not a real directory: ${skillsRoot}`,
      skillsRoot,
      "Inspect and migrate the foreign pack content before re-freezing.",
    );
  }
  for (const skill of skills) {
    const path = join(skillsRoot, skill.entry.name);
    const target = join(catalog, skill.entry.name);
    const info = await inspectPath(path);
    if (!info) continue;
    if (!info.isSymbolicLink()) {
      refuse(
        "E_BMAD_FOREIGN_COLLISION",
        `Pack skills entry ${skill.entry.name} exists and is not a canonical reference link.`,
        path,
        "Inspect and migrate the foreign pack content before re-freezing.",
      );
    }
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch {
      resolved = "";
    }
    if (resolved !== target) {
      refuse(
        "E_BMAD_FOREIGN_COLLISION",
        `Pack skills entry ${skill.entry.name} points at a different canonical definition.`,
        path,
        "Repair the pack reference or remove the conflicting link before re-freezing.",
      );
    }
  }
  if (commandsEnabled && commands.totalFiles > 0) {
    const commandsRoot = join(packPath, "commands");
    const commandsRootInfo = await inspectPath(commandsRoot);
    if (commandsRootInfo && !commandsRootInfo.isDirectory()) {
      refuse(
        "E_BMAD_FOREIGN_COLLISION",
        `The BMAD pack commands root is not a real directory: ${commandsRoot}`,
        commandsRoot,
        "Inspect and migrate the foreign pack content before re-freezing.",
      );
    }
    for (const file of commands.inventory.files) {
      const path = join(commandsRoot, file.client, file.name);
      const existingCommand = await inspectPath(path);
      if (!existingCommand) continue;
      if (
        !existingCommand.isFile() ||
        !(await readFile(path)).equals(await readFile(file.sourcePath))
      ) {
        refuse(
          "E_BMAD_FOREIGN_COLLISION",
          `Pack command ${file.client}/${file.name} exists with different bytes than the source.`,
          path,
          "A freeze never rewrites foreign command content. Remove the conflicting file or restore the source bytes, then retry.",
        );
      }
    }
  }
  // --- Retirement: a version switch is one-resident-canonical, never coexistence
  // snapshots. Other bmad version packs are archived OUTSIDE the discoverable packs
  // tree as part of the guarded --replace transaction; their pack.toml moves with
  // them, so a stale baseline can never verify green against the newer canonical.
  const retiredPacks: string[] = [];
  let archivePath: string | null = null;
  if (replace) {
    const family = join(registry.root, "packs", BMAD_PACK_NAME);
    const familyNow = await inspectPath(family);
    if (familyNow?.isDirectory()) {
      for (const entry of await readdir(family, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".")) continue;
        if (entry.name === version) continue;
        if (await inspectPath(join(family, entry.name, "pack.toml"))) {
          retiredPacks.push(entry.name);
        }
      }
    }
    retiredPacks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (retiredPacks.length) {
      archivePath = join(registry.root, "packs", `.archived-bmad-${version}`);
      if (await inspectPath(archivePath)) {
        refuse(
          "E_BMAD_FOREIGN_COLLISION",
          `The retirement archive path already exists: ${archivePath}`,
          archivePath,
          "Inspect the prior archive, move it aside explicitly, then retry the replace.",
        );
      }
    }
  }
  const plan: FreezePlan = {
    registry,
    provenance,
    packPath,
    version,
    dryRun: options.dryRun === true,
    replace,
    commandsEnabled,
    skills,
    foreignNames,
    commands,
    priorCommandClients,
    retiredPacks,
    archivePath,
    expectedManifest: null,
    retainedManifest: null,
    changes: [],
  };
  // Ownership preflight: parse any pre-existing declaration and refuse
  // malformed/foreign/edited content BEFORE any write, with dry-run parity.
  const priorDeclaration = await analyzeExistingManifest(join(packPath, "pack.toml"), plan);
  const finalized: FreezePlan = {
    ...plan,
    expectedManifest: priorDeclaration.expected,
    retainedManifest: priorDeclaration.retained,
  };
  return { ...finalized, changes: planChanges(finalized) };
}

async function writeTree(root: string, entries: readonly ContentEntry[]): Promise<void> {
  for (const item of entries) {
    const path = join(root, item.path);
    if (item.kind === "directory") {
      await mkdir(path, { mode: item.mode });
    } else if (item.kind === "link") {
      await symlink(item.target, path);
    } else if (item.kind === "file") {
      const file = await open(path, "wx", item.mode);
      try {
        await file.writeFile(item.bytes);
        await file.chmod(item.mode);
      } finally {
        await file.close();
      }
    }
  }
}

async function replaceTree(plan: SkillPlan, target: string, receipt: ContentEntry): Promise<void> {
  // Unique, owned staging names per transaction; preflight already refused any
  // pre-existing artifact at these paths, so nothing foreign is ever removed here.
  const stamp = `${process.pid}.${Date.now()}`;
  const swap = join(dirname(target), `.skillex-bmad-${plan.entry.name}.${stamp}.swap`);
  const backup = join(dirname(target), `.skillex-bmad-${plan.entry.name}.${stamp}.backup`);
  await mkdir(swap, { mode: 0o700 });
  try {
    await writeTree(swap, [...plan.entries, receipt]);
    await chmod(swap, plan.rootMode);
    // POSIX rename cannot replace a non-empty directory: park the old tree first,
    // publish the new one, then drop the parked copy. A crash leaves the uniquely
    // named backup beside the catalog for manual inspection; nothing foreign is
    // silently removed and a later replace refuses to clobber it.
    await rename(target, backup);
    try {
      await rename(swap, target);
    } catch (error) {
      await rename(backup, target);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(swap, { recursive: true, force: true });
    throw error;
  }
}

async function applyFreeze(plan: FreezePlan): Promise<void> {
  const catalog = join(plan.registry.root, "all-skills");
  const catalogIdentity = await lstat(catalog);
  for (const skill of plan.skills) {
    const target = join(catalog, skill.entry.name);
    if (skill.action === "create") {
      await mkdir(target, { mode: 0o700 });
      try {
        await writeTree(target, skill.entries);
        const receipt = bmadReceipt(plan.provenance, skill.digest, skill.sourcePath);
        if (receipt.kind !== "file") throw new TypeError("A BMAD receipt must be a file entry.");
        const receiptFile = await open(join(target, ".source.yaml"), "wx", receipt.mode);
        try {
          await receiptFile.writeFile(receipt.bytes);
          await receiptFile.chmod(receipt.mode);
        } finally {
          await receiptFile.close();
        }
        await chmod(target, skill.rootMode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          refuse(
            "E_BMAD_FOREIGN_COLLISION",
            `Canonical destination appeared during the freeze: ${target}`,
            target,
            "Inspect the new content and retry; the freeze never replaces content it did not plan for.",
          );
        }
        throw error;
      }
    } else if (skill.action === "replace") {
      const receipt = bmadReceipt(plan.provenance, skill.digest, skill.sourcePath);
      await replaceTree(skill, target, receipt);
    }
  }
  // Retirement (guarded --replace transaction): move every superseded bmad version
  // pack OUT of the discoverable packs tree into the archive. The pack.toml moves
  // with the pack, so its recorded baseline can never verify green against the
  // newer canonical and pack inventory never sees a stale version.
  if (plan.replace && plan.archivePath && plan.retiredPacks.length) {
    const family = join(plan.registry.root, "packs", BMAD_PACK_NAME);
    await mkdir(plan.archivePath, { mode: 0o755 });
    try {
      for (const retired of plan.retiredPacks) {
        await rename(join(family, retired), join(plan.archivePath, retired));
      }
    } catch (error) {
      // Best-effort recovery: roll back any already-moved retired packs so no
      // version directory is orphaned inside the archive.
      for (const retired of plan.retiredPacks) {
        const moved = join(plan.archivePath, retired);
        const original = join(family, retired);
        if ((await inspectPath(moved)) && !(await inspectPath(original))) {
          await rename(moved, original).catch(() => undefined);
        }
      }
      await rm(plan.archivePath, { recursive: true, force: true });
      throw error;
    }
  }
  const familyPath = dirname(plan.packPath);
  const familyInfo = await inspectPath(familyPath);
  if (!familyInfo) await mkdir(familyPath, { mode: 0o755, recursive: true });
  const versionInfo = await inspectPath(plan.packPath);
  if (!versionInfo) await mkdir(plan.packPath, { mode: 0o755 });
  const manifestPath = join(plan.packPath, "pack.toml");
  // Idempotence + authored-format preservation: an owned, semantically equal
  // declaration is never rewritten — byte-identical OR reordered/recommented
  // bytes both keep the original file exactly as authored (no temp file, no
  // rename, no mtime churn, comments and formatting survive).
  const keepPrior = plan.retainedManifest !== null;
  if (!keepPrior) {
    const existingInfo = await inspectPath(manifestPath);
    if (existingInfo && !existingInfo.isFile()) {
      refuse(
        "E_BMAD_PACK_MANIFEST",
        "The existing BMAD pack manifest is not a real file.",
        manifestPath,
        "Inspect and repair the pack declaration before re-freezing.",
      );
    }
    // planFreeze always computes the deterministic expected manifest.
    const manifestBytes = plan.expectedManifest ?? packManifest(plan);
    const mode = existingInfo?.mode ?? 0o644;
    const temporary = join(plan.packPath, `.pack.toml.${Date.now()}.tmp`);
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(manifestBytes);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await rename(temporary, manifestPath);
    // Parsed once so a malformed on-disk manifest is a refusal, not a silent rewrite.
    const reparsed = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    const declared = (reparsed as Record<string, unknown>).freeform;
    if (
      !declared ||
      typeof declared !== "object" ||
      !Array.isArray((declared as Record<string, unknown>).skills)
    ) {
      refuse(
        "E_BMAD_PACK_MANIFEST",
        "The generated BMAD pack manifest has no [freeform].skills membership.",
        manifestPath,
        "Report this as a skillex bug; the freeze should always write a valid membership manifest.",
      );
    }
  }
  const skillsRoot = join(plan.packPath, "skills");
  const skillsRootInfo = await inspectPath(skillsRoot);
  if (!skillsRootInfo) await mkdir(skillsRoot, { mode: 0o755 });
  for (const skill of plan.skills) {
    const path = join(skillsRoot, skill.entry.name);
    const target = join(catalog, skill.entry.name);
    const info = await inspectPath(path);
    if (info) continue; // Preflight validated existing links; nothing to create.
    await symlink(relative(dirname(path), target), path);
  }
  if (plan.commandsEnabled && plan.commands.totalFiles > 0) {
    const commandsRoot = join(plan.packPath, "commands");
    const commandsRootInfo = await inspectPath(commandsRoot);
    if (!commandsRootInfo) await mkdir(commandsRoot, { mode: 0o755 });
    for (const file of plan.commands.inventory.files) {
      const path = join(commandsRoot, file.client, file.name);
      await mkdir(dirname(path), { mode: 0o755, recursive: true });
      const existingCommand = await inspectPath(path);
      if (existingCommand) continue; // Preflight verified identical bytes.
      const destination = await open(path, "wx", 0o644);
      try {
        await destination.writeFile(await readFile(file.sourcePath));
        await destination.chmod(0o644);
      } finally {
        await destination.close();
      }
    }
  }
  await sameEntry(catalog, catalogIdentity);
}

async function sameEntry(path: string, info: Stats): Promise<void> {
  const current = await inspectPath(path);
  if (!current || current.dev !== info.dev || current.ino !== info.ino) changedDuring(path);
}

function freezeData(plan: FreezePlan): BmadFreezeData {
  const skills: BmadSkillInventory[] = plan.skills.map((skill) => ({
    name: skill.entry.name,
    sourcePath: skill.sourcePath,
    status:
      skill.action === "create" || skill.action === "replace"
        ? "imported"
        : skill.action === "unchanged"
          ? "unchanged"
          : "skipped",
    digest: skill.digest,
    recordedDigest: skill.recordedDigest,
  }));
  return {
    registry: plan.registry,
    pack: { name: BMAD_PACK_NAME, version: plan.version, path: plan.packPath },
    provenance: plan.provenance,
    sourceRoot: plan.provenance.sourceRoot,
    dryRun: plan.dryRun,
    skills,
    foreignSkills: plan.foreignNames.map((name) => ({
      name,
      path: join(plan.provenance.sourceRoot, ".agents", "skills", name),
    })),
    skillsDeclared: plan.skills.length,
    skillsImported: skills.filter((skill) => skill.status === "imported").length,
    skillsUnchanged: skills.filter((skill) => skill.status === "unchanged").length,
    skillsSkipped: skills.filter((skill) => skill.status === "skipped").length,
    skillsFailed: 0,
    commands: plan.commands.inventory,
    commandFiles: plan.commands.totalFiles,
    danglingCommands: plan.commands.danglingFiles,
    changes: plan.changes,
  };
}

/**
 * Freeze the BMAD skills and per-client commands of a BMAD-enabled project into a
 * versioned reference-only registry pack (ADR-0001). Import is offline, idempotent,
 * and guarded: same-version repeats change nothing, and a differing existing canonical
 * body is refused rather than overwritten.
 */
export async function freezeBmadPack(
  source: string,
  options: BmadFreezeOptions = {},
): Promise<ResultEnvelope<BmadFreezeData | null>> {
  const command = "bmad freeze";
  try {
    const initial = await planFreeze(source, options);
    if (initial.dryRun) {
      return makeResult(command, freezeData(initial));
    }
    return await withCatalogLock(initial.registry, options, async () => {
      const current = await planFreeze(source, options);
      if (current.registry.root !== initial.registry.root) {
        refuse(
          "E_BMAD_REGISTRY_CHANGED",
          "Registry discovery changed after the catalog lock was selected.",
          current.registry.root,
          "Choose an explicit registry root and retry.",
        );
      }
      await applyFreeze(current);
      return makeResult(command, freezeData(current));
    });
  } catch (error) {
    return freezeError(command, error);
  }
}
