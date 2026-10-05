/**
 * BMAD desired-state project materializer: `skillex bmad plan` / `apply` (SKRILL-27).
 *
 * Applies a validated BmadSpecification to a project root as three explicit layers:
 *   1. runtime   — `_bmad/` support assets copied from the pinned runtime source,
 *                  plus a materialized `_bmad/config.toml` honoring explicit project
 *                  config C (never importing source project identity silently).
 *   2. activation — `.agents/skills/<name>` canonical reference links created through
 *                  the EXISTING selection-manifest + sync writer (no second writer),
 *                  pinned by the spec's pack membership.
 *   3. manifest  — the project selection manifest declaring the pinned pack, with
 *                  inherit_global=false (no ambient global inheritance).
 *
 * Laws enforced here:
 *  - Preflight validates EVERY collision/pin/runtime before ANY target write.
 *  - Dry-run performs identical validation/decisions with zero writes.
 *  - Second apply is byte-stable: zero managed changes, no volatile rewrites.
 *  - Foreign content at a desired path refuses the whole operation (never adopted).
 *  - Authored edits to owned files refuse (never silently repaired).
 *  - Spec pin integrity: same digest label + changed pinned inputs refuses.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  BmadMaterializeData,
  BmadMaterializeOptions,
  BmadMaterialNode,
  BmadMaterialPlan,
  BmadSpecification,
} from "./bmad-materialize-types.js";
import { aggregateMembersDigest, canonicalJson, sha256Text } from "./bmad-spec.js";
import { withCatalogLock } from "./catalog-lock.js";
import { canonicalSkill, packInventory } from "./composition.js";
import { captureContent, digestContent } from "./content.js";
import { discoverRegistry } from "./discovery.js";
import { fail, SkillexError } from "./error.js";
import { inspectPath } from "./filesystem.js";
import { withLock } from "./lock.js";
import { isSkillName } from "./manifest.js";
import { prepareSyncUnlocked, reconcileUnlocked } from "./reconciliation.js";
import type { SyncOptions } from "./reconciliation-types.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import {
  readSelectionManifest,
  type SelectionManifestSnapshot,
  writeSelectionManifest,
} from "./selection-manifest.js";

const SPEC_SCHEMA = "skillex.bmad-spec/v1";
// The materialization writer serializes on the SHARED activation lock used by
// selection commands and reconciliation — never a second, independent writer.
const LOCK_RESOURCE = "skillex:activation:v2";
const RECEIPT_DIR = ".skillex";
const RECEIPT_NAME = "bmad-materialization.json";
const RECEIPT_SCHEMA = "skillex.bmad-materialization-receipt/v1";
/**
 * Pending-materialization journal. Created EXCLUSIVELY (O_EXCL) before the first
 * data byte is written; APPENDED after each ACTUAL publication (directories,
 * files, links) recording the real published identity; removed on success. An
 * interrupted apply (EIO, crash) leaves the journal behind so a retry can adopt
 * exactly the bytes it previously published (same kind/type/bytes/target) and
 * continue — pre-existing/foreign content is never adopted (no journal claim),
 * and a planted file at a not-yet-published path still refuses.
 */
const JOURNAL_NAME = "bmad-materialization.pending.json";
const JOURNAL_SCHEMA = "skillex.bmad-materialization-pending/v1";
const JOURNAL_SEPARATOR = "\n";
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

interface RuntimeReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly specDigest: string;
  readonly inputsDigest: string;
  readonly bmadVersion: string;
  /** Sorted relative runtime paths owned by this materialization. */
  readonly owned: readonly string[];
}

interface PendingJournalHeader {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly specDigest: string;
  readonly inputsDigest: string;
  readonly bmadVersion: string;
}

interface PendingJournalRecord {
  readonly path: string;
  readonly kind: "file" | "symlink" | "dir";
  /** File bytes sha256 (files only). */
  readonly sha256?: string;
  /** Published permission mode (files/dirs). */
  readonly mode?: number;
  /** Symlink target (links only). */
  readonly target?: string;
  /**
   * ACTUAL published filesystem identity, captured from the opened fd (files) or
   * an lstat right after the exclusive create (dirs/symlinks). Decimal STRINGS so
   * 64-bit dev/ino survive JSON round-trips losslessly. Ownership binds to THIS
   * identity — a byte-identical file on a DIFFERENT dev/ino is foreign and refuses.
   */
  readonly dev?: string;
  readonly ino?: string;
}

/** Split a journal file into its header + one record per line. */
function splitJournal(
  text: string,
): { head: PendingJournalHeader; records: PendingJournalRecord[] } | null {
  const firstBreak = text.indexOf(JOURNAL_SEPARATOR);
  if (firstBreak < 0) return null;
  let head: unknown;
  try {
    head = JSON.parse(text.slice(0, firstBreak));
  } catch {
    return null;
  }
  if (!isRecord(head) || head.schema !== JOURNAL_SCHEMA) return null;
  for (const field of ["specDigest", "inputsDigest", "bmadVersion"] as const) {
    if (typeof head[field] !== "string" || head[field].length === 0) return null;
  }
  const records: PendingJournalRecord[] = [];
  for (const line of text.slice(firstBreak + 1).split(JOURNAL_SEPARATOR)) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(record) || typeof record.path !== "string" || record.path.length === 0)
      return null;
    if (record.kind !== "file" && record.kind !== "symlink" && record.kind !== "dir") return null;
    if (
      record.kind === "file" &&
      (typeof record.sha256 !== "string" || typeof record.mode !== "number")
    )
      return null;
    if (record.kind === "symlink" && typeof record.target !== "string") return null;
    // Files and symlinks MUST carry the actual published filesystem identity
    // (dev/ino as decimal strings). A record without it cannot prove ownership of
    // the current entry and is treated as malformed/unknown — never auto-adopted.
    if (record.kind === "file" || record.kind === "symlink") {
      if (typeof record.dev !== "string" || typeof record.ino !== "string") return null;
    }
    records.push(record as unknown as PendingJournalRecord);
  }
  return { head: head as unknown as PendingJournalHeader, records };
}

/** Refuse a foreign or tampered materialization receipt (never silently adopted). */
function refuseReceipt(receiptPath: string, message: string, detail?: readonly string[]): never {
  fail(
    "E_BMAD_SPEC_COLLISION",
    message,
    {
      path: receiptPath,
      ...(detail ? { detail } : {}),
      fix: "Foreign or edited content occupies the owned receipt path. Move it aside deliberately (accepting re-materialization) or restore its exact bytes.",
    },
    ExitCode.REFUSED,
  );
}

/** Structural validation of an existing receipt: exact schema fields, owned paths. */
function parseReceipt(raw: unknown, receiptPath: string): RuntimeReceipt {
  if (!isRecord(raw)) refuseReceipt(receiptPath, "Materialization receipt is not a JSON object.");
  if (raw.schema !== RECEIPT_SCHEMA)
    refuseReceipt(receiptPath, `Unknown receipt schema at ${receiptPath}`);
  for (const field of ["specDigest", "inputsDigest", "bmadVersion"] as const) {
    if (typeof raw[field] !== "string" || raw[field].length === 0)
      refuseReceipt(receiptPath, `Materialization receipt is missing a valid ${field}.`);
  }
  if (!Array.isArray(raw.owned) || !raw.owned.every((p) => typeof p === "string" && p.length > 0))
    refuseReceipt(receiptPath, "Materialization receipt owned list is malformed.");
  const known = new Set(["schema", "specDigest", "inputsDigest", "bmadVersion", "owned"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length)
    refuseReceipt(
      receiptPath,
      `Materialization receipt carries unknown field(s): ${unknown.join(", ")}.`,
      [
        "Restore the exact receipt bytes or remove the receipt deliberately before re-materializing.",
      ],
    );
  return raw as unknown as RuntimeReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse + structurally validate a spec document; refuses unknown shapes loudly. */
export function parseSpecification(raw: unknown, path: string): BmadSpecification {
  if (!isRecord(raw))
    fail("E_BMAD_SPEC_PIN", "A specification document must be a JSON object.", {
      path,
      fix: "Generate specifications with `skillex bmad spec build`.",
    });
  if (raw.schema !== SPEC_SCHEMA)
    fail("E_BMAD_SPEC_PIN", `Unsupported specification schema: ${String(raw.schema)}`, {
      path,
      fix: `Expected ${SPEC_SCHEMA}; regenerate the spec with the current CLI.`,
    });
  for (const field of ["bmadVersion", "digest", "clients", "projectConfig", "sources"]) {
    if (!(field in raw))
      fail("E_BMAD_SPEC_PIN", `Specification is missing required field: ${field}`, {
        path,
        fix: "Regenerate the specification with `skillex bmad spec build`.",
      });
  }
  const sources = raw.sources as Record<string, unknown>;
  if (!isRecord(sources))
    fail("E_BMAD_SPEC_PIN", "Specification sources must be a JSON object.", {
      path,
      fix: "Regenerate the specification with `skillex bmad spec build`.",
    });
  for (const field of [
    "pack",
    "members",
    "composition",
    "commands",
    "runtime",
    "runtimeDeps",
    "runtimeExtraPolicy",
    "inputsDigest",
  ]) {
    if (!(field in sources))
      fail("E_BMAD_SPEC_PIN", `Specification sources are missing: ${field}`, {
        path,
        fix: "Regenerate the specification with `skillex bmad spec build`.",
      });
  }
  if (!Array.isArray(raw.clients) || !raw.clients.length)
    fail("E_BMAD_SPEC_PIN", "Specification declares no native clients.", {
      path,
      fix: "Rebuild with at least one --client.",
    });
  if (!Array.isArray(sources.members) || !sources.members.length)
    fail("E_BMAD_SPEC_PIN", "Specification pins no canonical members.", {
      path,
      fix: "Rebuild from a pack that declares skills.",
    });
  if (
    !sources.members.every((member: unknown) => typeof member === "string" && isSkillName(member))
  )
    fail("E_BMAD_SPEC_PIN", "Specification members must be plain skill names (strings).", {
      path,
      fix: "Membership is names-only per ADR-0001; regenerate the spec with the current CLI.",
    });
  const composition = sources.composition as Record<string, unknown> | undefined;
  if (
    !isRecord(composition) ||
    typeof composition.packVersion !== "string" ||
    typeof composition.packTomlSha256 !== "string" ||
    typeof composition.membersSha256 !== "string"
  )
    fail(
      "E_BMAD_SPEC_PIN",
      "Specification composition pin must carry packVersion, packTomlSha256, membersSha256.",
      {
        path,
        fix: "Regenerate the specification with `skillex bmad spec build`.",
      },
    );
  if (!Array.isArray(sources.commands))
    fail("E_BMAD_SPEC_PIN", "Specification commands must be an array of per-client inventories.", {
      path,
      fix: "Regenerate the specification with `skillex bmad spec build`.",
    });
  for (const inventory of sources.commands) {
    if (
      !isRecord(inventory) ||
      typeof inventory.client !== "string" ||
      !Array.isArray(inventory.files)
    )
      fail("E_BMAD_SPEC_PIN", "Specification command inventories must declare client and files.", {
        path,
        fix: "Regenerate the specification with `skillex bmad spec build`.",
      });
    for (const file of inventory.files) {
      if (
        !isRecord(file) ||
        typeof file.name !== "string" ||
        typeof file.sha256 !== "string" ||
        file.name.includes("/") ||
        file.name.includes("\\") ||
        file.name === ".." ||
        file.name.includes("\0")
      )
        fail(
          "E_BMAD_SPEC_PIN",
          `Specification command file entries must be plain name+sha256 (got: ${JSON.stringify(file)}).`,
          {
            path,
            fix: "Regenerate the specification; command inventories pin plain file names only.",
          },
        );
    }
  }
  if (sources.runtimeExtraPolicy !== "declared" && sources.runtimeExtraPolicy !== "include")
    fail(
      "E_BMAD_SPEC_PIN",
      `Specification runtimeExtraPolicy must be "declared" or "include" (got: ${JSON.stringify(sources.runtimeExtraPolicy)}).`,
      {
        path,
        fix: "Regenerate the specification with `skillex bmad spec build`; observed-runtime inclusion is an explicit policy, never ambient.",
      },
    );
  if (!Array.isArray(sources.runtimeDeps))
    fail(
      "E_BMAD_SPEC_PIN",
      "Specification runtimeDeps must be the validated runtime closure array.",
      {
        path,
        fix: "Regenerate the specification with `skillex bmad spec build`.",
      },
    );
  for (const dep of sources.runtimeDeps) {
    if (
      !isRecord(dep) ||
      typeof dep.path !== "string" ||
      !dep.path ||
      dep.path.startsWith("/") ||
      dep.path.split("/").some((part) => part === ".." || part === "." || part === "") ||
      (dep.kind !== "file" && dep.kind !== "dir" && dep.kind !== "symlink") ||
      typeof dep.digest !== "string" ||
      (dep.origin !== "declared" && dep.origin !== "observed") ||
      (dep.role !== "support" && dep.role !== "canonical-support")
    )
      fail(
        "E_BMAD_SPEC_PIN",
        `Specification runtime dependency entries must carry a safe path, kind, digest, origin, and role (got: ${JSON.stringify(dep)}).`,
        {
          path,
          fix: "Regenerate the specification; the runtime closure is captured from validated manifests, never hand-edited.",
        },
      );
  }
  return raw as unknown as BmadSpecification;
}

/** Recompute the spec digest from its own inputs; tampering refuses. */
export function verifySpecificationDigest(spec: BmadSpecification, path: string): void {
  const sourcesBody = {
    pack: spec.sources.pack,
    members: spec.sources.members,
    composition: spec.sources.composition,
    commands: spec.sources.commands,
    runtime: { path: "__runtime_relocated__", digest: spec.sources.runtime.digest },
    runtimeDeps: spec.sources.runtimeDeps,
    runtimeExtraPolicy: spec.sources.runtimeExtraPolicy,
  };
  const recomputed = sha256Text(
    canonicalJson({
      schema: spec.schema,
      bmadVersion: spec.bmadVersion,
      clients: spec.clients,
      projectConfig: spec.projectConfig,
      sources: sourcesBody,
    }),
  );
  if (recomputed !== spec.digest)
    fail(
      "E_BMAD_SPEC_PIN",
      `Specification digest mismatch: document says ${spec.digest}, inputs recompute to ${recomputed}.`,
      {
        path,
        fix: "The pinned inputs changed after the spec was generated (or the document was edited). Regenerate the specification; never hand-edit it.",
      },
      ExitCode.REFUSED,
    );
}

/**
 * Resolve and validate every pinned registry input against actual current bytes.
 *
 * Membership is NAMES ONLY (ADR-0001): there is no per-skill sealed inventory to
 * verify. The catalog closure is instead pinned by ONE aggregate — the exact
 * pack.toml bytes + the membership it declares + the per-client command bytes —
 * all reverified against the registry now, before any target write.
 */
async function verifyPinnedInputs(registryRoot: string, spec: BmadSpecification): Promise<void> {
  const { name, version } = spec.sources.pack;
  const packPath = join(registryRoot, "packs", name, version);
  const info = await inspectPath(packPath);
  if (!info?.isDirectory())
    fail(
      "E_BMAD_SPEC_PIN",
      `The pinned pack is missing from the registry: ${packPath}`,
      {
        path: packPath,
        fix: `Restore the frozen ${name}@${version} pack or rebuild the specification.`,
      },
      ExitCode.REFUSED,
    );
  // Aggregate catalog closure pin, part 1: the EXACT pack.toml bytes.
  const packTomlPath = join(packPath, "pack.toml");
  const packTomlInfo = await inspectPath(packTomlPath);
  if (!packTomlInfo?.isFile())
    fail(
      "E_BMAD_SPEC_PIN",
      `The pinned pack manifest is missing: ${packTomlPath}`,
      {
        path: packTomlPath,
        fix: `Restore the frozen ${name}@${version} pack.toml or rebuild the specification.`,
      },
      ExitCode.REFUSED,
    );
  const packTomlBytes = await readFile(packTomlPath);
  const actualPackTomlSha = createHash("sha256").update(packTomlBytes).digest("hex");
  const composition = spec.sources.composition;
  if (!composition || actualPackTomlSha !== composition.packTomlSha256)
    fail(
      "E_BMAD_SPEC_PIN",
      `Pinned pack manifest bytes changed for ${name}@${version}: pinned ${composition?.packTomlSha256 ?? "(none)"}, found ${actualPackTomlSha}.`,
      {
        path: packTomlPath,
        fix: "The frozen pack.toml changed under the same version label. Refusing to install different membership under the old pin; restore the pinned bytes or rebuild the specification.",
      },
      ExitCode.REFUSED,
    );
  if (composition.packVersion !== version)
    fail(
      "E_BMAD_SPEC_PIN",
      `Composition pin version ${composition.packVersion} does not match the pinned pack ${version}.`,
      {
        path: packTomlPath,
        fix: "Rebuild the specification; the composition pin must name the pinned pack version.",
      },
      ExitCode.REFUSED,
    );
  // Aggregate catalog closure pin, part 2: the pinned membership array must equal
  // what the pinned pack.toml actually declares — the spec binds only real pack
  // members, with no silent unlisted skill smuggled into the array.
  const declared = [
    ...new Set((await packInventory(registryRoot, { name, version, optional: false })).names),
  ]
    .filter(isSkillName)
    .sort();
  const pinnedNames = [...spec.sources.members].sort();
  if (declared.length !== pinnedNames.length || declared.some((n, i) => n !== pinnedNames[i]))
    fail(
      "E_BMAD_SPEC_PIN",
      `Pinned membership does not match the pack manifest for ${name}@${version}: spec pins ${pinnedNames.join(", ")}, pack declares ${declared.join(", ")}.`,
      {
        path: packTomlPath,
        fix: "Rebuild the specification; members are exactly what the pinned pack.toml declares.",
      },
      ExitCode.REFUSED,
    );
  // Aggregate catalog closure pin, part 3: declared membership must still resolve
  // in the canonical catalog (names only — no per-skill payload sealing).
  for (const member of spec.sources.members) {
    let canonical: string;
    try {
      canonical = await canonicalSkill(registryRoot, member);
    } catch {
      fail(
        "E_BMAD_SPEC_PIN",
        `Pinned member ${member} is not in the canonical catalog.`,
        {
          path: join(registryRoot, "all-skills", member),
          fix: "Restore the canonical skill or rebuild the specification.",
        },
        ExitCode.REFUSED,
      );
    }
    if (canonical !== join(registryRoot, "all-skills", member))
      fail(
        "E_BMAD_SPEC_PIN",
        `Pinned member ${member} resolves outside the canonical catalog: ${canonical}`,
        {
          path: canonical,
          fix: "The catalog resolution must stay inside all-skills/; rebuild the specification against a sound registry.",
        },
        ExitCode.REFUSED,
      );
  }
  // Aggregate catalog closure pin, part 4: recompute the ONE aggregate digest over
  // pack.toml bytes + sorted member names + each member's captured canonical
  // content (paths/types/bytes/modes/targets + root mode) and compare. A member's
  // SKILL.md bytes or a support-file mode tampered under the same version label
  // changes the recomputed aggregate and refuses here, before any target write.
  const actualMembersSha = await aggregateMembersDigest(
    registryRoot,
    packTomlBytes,
    spec.sources.members,
  );
  if (actualMembersSha !== composition.membersSha256)
    fail(
      "E_BMAD_SPEC_PIN",
      `Pinned canonical member content changed for ${name}@${version}: pinned ${composition.membersSha256}, found ${actualMembersSha}.`,
      {
        path: packTomlPath,
        fix: "A pinned member's canonical content (bytes, modes, types, or link targets) changed under the same version label. Restore the pinned canonical skills or rebuild the specification.",
      },
      ExitCode.REFUSED,
    );
  // Aggregate catalog closure pin, part 5: per-client command bytes reverified.
  for (const inventory of spec.sources.commands) {
    const dir = join(packPath, "commands", inventory.client);
    for (const file of inventory.files) {
      if (
        file.name.includes("/") ||
        file.name.includes("\\") ||
        file.name === ".." ||
        file.name.includes("\0")
      )
        fail(
          "E_BMAD_SPEC_PIN",
          `Pinned command file name is not a plain file name: ${JSON.stringify(file.name)}`,
          {
            path: join(dir, file.name),
            fix: "Rebuild the specification; command inventories pin plain file names only.",
          },
          ExitCode.REFUSED,
        );
      const bytes = await readFile(join(dir, file.name)).catch(() => null);
      if (bytes === null)
        fail(
          "E_BMAD_SPEC_PIN",
          `Pinned command file is missing from the pack: commands/${inventory.client}/${file.name}`,
          {
            path: join(dir, file.name),
            fix: "Restore the frozen pack command bytes or rebuild the specification.",
          },
          ExitCode.REFUSED,
        );
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== file.sha256)
        fail(
          "E_BMAD_SPEC_PIN",
          `Pinned command bytes changed: commands/${inventory.client}/${file.name} pinned ${file.sha256}, found ${actual}.`,
          {
            path: join(dir, file.name),
            fix: "The frozen command bytes changed under the same version label. Restore the pinned bytes or rebuild the specification.",
          },
          ExitCode.REFUSED,
        );
    }
  }
}

/** Guarded materialized config.toml honoring explicit C, never source identity. */
function materializedConfig(spec: BmadSpecification): string {
  const lines = [
    "# skillex bmad materialization (generated; owned receipt under .skillex/)",
    "[core]",
    `project_name = ${JSON.stringify(spec.projectConfig.projectName ?? "unnamed-project")}`,
  ];
  for (const [key, value] of Object.entries(spec.projectConfig.core).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`${key} = ${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Desired runtime node set: the VALIDATED declared closure from the spec —
 * every declared support asset (any module: scripts, _config, core, bmm, bmb,
 * cis, bmad-loop, workflows) plus every intermediate directory INCLUDING the
 * declared roots, with actual kinds/bytes/modes preserved — plus the generated
 * config.toml honoring explicit project config C (never the source's identity).
 *
 * Canonical skill references (role `canonical-support`) produce NO runtime
 * copies: the canonical body lives only in the catalog (ADR-0001) and the
 * activation layer links it. Observed extras are materialized only under the
 * explicit `runtimeExtraPolicy: "include"`.
 */
async function desiredRuntimeNodes(
  _projectRoot: string,
  spec: BmadSpecification,
): Promise<BmadMaterialNode[]> {
  const nodes: BmadMaterialNode[] = [];
  const runtimeRoot = await resolveRuntimeForRead(spec);
  const includeObserved = spec.sources.runtimeExtraPolicy === "include";
  const include = (dep: (typeof spec.sources.runtimeDeps)[number]): boolean => {
    if (dep.role === "canonical-support") return false; // references, never copies
    if (dep.missing === true) return false; // already a build-time refusal
    return dep.origin === "declared" || includeObserved;
  };
  // Directory nodes for every ancestor of every included entry, incl. declared
  // module roots, with the ACTUAL captured source modes (identity preserved).
  const dirPaths = new Set<string>();
  for (const dep of spec.sources.runtimeDeps) {
    if (!include(dep)) continue;
    const parts = dep.path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirPaths.add(parts.slice(0, i).join("/"));
  }
  for (const rel of dirPaths) {
    const entry = await lstatEnoentOk(join(runtimeRoot, "_bmad", rel));
    nodes.push({
      path: `_bmad/${rel}`,
      kind: "dir",
      target: null,
      digest: null,
      managed: true,
      layer: "runtime",
      mode: entry ? Number(entry.mode) & 0o777 : 0o755,
    });
  }
  for (const dep of spec.sources.runtimeDeps) {
    if (!include(dep)) continue;
    const rel = `_bmad/${dep.path}`;
    if (dep.kind === "dir") {
      nodes.push({
        path: rel,
        kind: "dir",
        target: null,
        digest: null,
        managed: true,
        layer: "runtime",
        mode: dep.mode ?? 0o755,
      });
      continue;
    }
    if (dep.kind === "symlink") {
      nodes.push({
        path: rel,
        kind: "symlink",
        target: dep.target ?? null,
        digest: null,
        managed: true,
        layer: "runtime",
      });
      continue;
    }
    // File bytes are read ONCE here at preflight (AFTER the runtime pin check)
    // and pinned into the node: the source tree is never re-read after this
    // capture, so a mid-apply source-byte swap cannot change what is published.
    const bytes = await readFile(join(runtimeRoot, "_bmad", dep.path));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== dep.digest)
      fail(
        "E_BMAD_SPEC_RUNTIME_MISSING",
        `The runtime support file changed between spec build and materialization: _bmad/${dep.path}.`,
        {
          path: join(runtimeRoot, "_bmad", dep.path),
          fix: "Restore the pinned runtime bytes or rebuild the specification; a pinned input is never installed from changed bytes.",
        },
        ExitCode.REFUSED,
      );
    nodes.push({
      path: rel,
      kind: "file",
      target: null,
      digest: dep.digest,
      managed: true,
      layer: "runtime",
      mode: dep.mode ?? 0o644,
      bytes,
    });
  }
  // Generated, project-specific config — explicit C, never the source's identity.
  // The source `_bmad/config.toml` is NEVER copied into the target: importing it
  // would leak the source project identity. The only materialized config is the
  // generated one below.
  nodes.push({
    path: "_bmad/config.toml",
    kind: "file",
    target: null,
    digest: `sha256:${createHash("sha256").update(materializedConfig(spec)).digest("hex")}`,
    managed: true,
    layer: "runtime",
    mode: 0o644,
    bytes: new TextEncoder().encode(materializedConfig(spec)),
  });
  nodes.push({
    path: "_bmad",
    kind: "dir",
    target: null,
    digest: null,
    managed: true,
    layer: "runtime",
  });
  return nodes;
}

async function resolveRuntimeForRead(spec: BmadSpecification): Promise<string> {
  // The spec's runtime digest pins CONTENT identity (relocation-neutral); the
  // READ path is the explicit source root recorded at build time. plan/apply
  // take no runtime override, so the recorded path is the only read locator —
  // validated against the pinned digest before any use.
  const recorded = spec.sources.runtime.path;
  const info = await inspectPath(join(recorded, "_bmad"));
  if (!info?.isDirectory())
    fail(
      "E_BMAD_SPEC_RUNTIME_MISSING",
      `The pinned runtime support root is unavailable: ${recorded}`,
      {
        path: recorded,
        fix: "Restore the runtime source tree referenced by the specification.",
      },
      ExitCode.REFUSED,
    );
  const captured = await captureContent(join(recorded, "_bmad"));
  // The runtime pin binds the WHOLE captured tree — files, links, and directory
  // entries with their modes (including module root modes). A directory-mode
  // tamper under the same version label invalidates the pin here, before any
  // read of pinned bytes for publication.
  const digest = digestContent(captured.entries);
  if (digest !== spec.sources.runtime.digest)
    fail(
      "E_BMAD_SPEC_RUNTIME_MISSING",
      `The runtime support tree changed since the spec was pinned: ${recorded}`,
      {
        path: recorded,
        fix: "Restore the pinned runtime bytes, modes, and layout — or rebuild the specification against the current tree.",
      },
      ExitCode.REFUSED,
    );
  return recorded;
}

export interface Preflight {
  readonly plan: BmadMaterialPlan;
  readonly runtimeReceiptExisting: RuntimeReceipt | null;
  /** Pending journal from an interrupted apply of THIS spec (same pin). */
  readonly pendingJournal: ReadonlyMap<string, PendingJournalRecord> | null;
  readonly registry: RegistrySelection;
  readonly snapshot: SelectionManifestSnapshot;
  readonly rawManifest: Record<string, unknown>;
  readonly manifestPath: string;
  readonly manifestNeedsWrite: boolean;
  /** Readonly activation projection (changes the sync writer would apply). */
  readonly activationChanges: number;
  readonly activationFindings: readonly Diagnostic[];
}

/** lstat a path but only ENOENT may read as absent; anything else is a hard IO refusal. */
async function lstatEnoentOk(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(
      "E_IO",
      `Cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { path, fix: "Check the path and its filesystem permissions, then retry." },
      ExitCode.FAILURE,
    );
  }
}

/** Refuse when any parent of a desired path is a symlink (never follow links). */
async function guardParentSymlinks(projectRoot: string, nodePath: string): Promise<string | null> {
  const absolute = join(projectRoot, nodePath);
  const rel = relative(projectRoot, absolute);
  const parts = rel.split(sep).filter(Boolean);
  let current = projectRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstatEnoentOk(current);
    if (!info) return null; // missing parent: creation handles it exclusively
    if (!info.isDirectory()) {
      return (
        `a parent (${relative(projectRoot, current)}) is not a real directory ` +
        `(symlink or special entries are never followed)`
      );
    }
  }
  return null;
}

/** Full validation pass — identical for dry-run and apply; performs NO writes. */
async function preflight(options: BmadMaterializeOptions): Promise<Preflight> {
  const projectRoot = resolve(options.cwd ?? process.cwd(), options.projectRoot);
  const projectInfo = await inspectPath(projectRoot);
  if (!projectInfo?.isDirectory())
    fail(
      "E_BMAD_SPEC_SOURCE",
      `Project root must be an existing directory: ${projectRoot}`,
      {
        path: projectRoot,
        fix: "Create the project root before materializing.",
      },
      ExitCode.REFUSED,
    );
  const specPath = resolve(options.cwd ?? process.cwd(), options.specPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(specPath, "utf8"));
  } catch (error) {
    fail(
      "E_BMAD_SPEC_PIN",
      `Cannot read specification: ${specPath}`,
      {
        path: specPath,
        detail: [error instanceof Error ? error.message : String(error)],
        fix: "Regenerate the specification with `skillex bmad spec build`.",
      },
      ExitCode.REFUSED,
    );
  }
  const spec = parseSpecification(raw, specPath);
  verifySpecificationDigest(spec, specPath);
  const registry: RegistrySelection = await discoverRegistry(options);
  await verifyPinnedInputs(registry.root, spec);
  // Runtime availability is part of preflight (explicit missing deps => refuse).
  await resolveRuntimeForRead(spec);
  const nodes = await desiredRuntimeNodes(projectRoot, spec);
  // Existing receipt: authored edits / foreign receipts refuse. A symlinked
  // `.skillex` receipt directory would let the receipt write escape the project;
  // it is refused outright (links are never followed into outside trees).
  const receiptDirPath = join(projectRoot, RECEIPT_DIR);
  const receiptDirInfo = await lstatEnoentOk(receiptDirPath);
  if (receiptDirInfo && !receiptDirInfo.isDirectory()) {
    fail(
      "E_BMAD_SPEC_COLLISION",
      `Materialization receipt directory is not a real directory: ${receiptDirPath} (symlinked or special parents are never followed).`,
      {
        path: receiptDirPath,
        fix: "Replace the .skillex symlink with a real directory, or move it aside before materializing.",
      },
      ExitCode.REFUSED,
    );
  }
  const receiptPath = join(projectRoot, RECEIPT_DIR, RECEIPT_NAME);
  let runtimeReceiptExisting: RuntimeReceipt | null = null;
  const receiptInfo = await inspectPath(receiptPath);
  if (receiptInfo) {
    if (!receiptInfo.isFile())
      refuseReceipt(receiptPath, `Materialization receipt is not a file: ${receiptPath}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch (error) {
      refuseReceipt(receiptPath, `Materialization receipt is unreadable: ${receiptPath}`, [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    runtimeReceiptExisting = parseReceipt(parsed, receiptPath);
    if (runtimeReceiptExisting.specDigest !== spec.digest) {
      // A different spec against an owned project: refuse unless the owned state is
      // exactly re-materializable by the new spec (it never is — digests differ).
      fail(
        "E_BMAD_SPEC_COLLISION",
        `Project is materialized with a different specification (${runtimeReceiptExisting.specDigest}); requested ${spec.digest}.`,
        {
          path: receiptPath,
          fix: "Explicitly remove the existing materialization (delete the receipt and owned runtime) before applying a different specification.",
        },
        ExitCode.REFUSED,
      );
    }
  }
  // Pending journal: the residue of an interrupted apply of THIS spec. It records
  // what was ACTUALLY published last time (kind/type/bytes/target/mode) so a
  // retry can adopt exactly those bytes and continue. A journal left by a
  // DIFFERENT spec refuses (explicit cleanup required); a malformed or oversized
  // journal cannot be proven safe and refuses honestly rather than guessing.
  const journalPath = join(projectRoot, RECEIPT_DIR, JOURNAL_NAME);
  let pendingJournal: ReadonlyMap<string, PendingJournalRecord> | null = null;
  const journalInfo = await lstatEnoentOk(journalPath);
  if (journalInfo) {
    if (!journalInfo.isFile() || journalInfo.size > JOURNAL_MAX_BYTES)
      fail(
        "E_BMAD_SPEC_COLLISION",
        `Materialization pending journal is not a regular file within size bounds: ${journalPath}`,
        {
          path: journalPath,
          fix: "Inspect the pending journal; restore its exact bytes or remove it deliberately before re-materializing.",
        },
        ExitCode.REFUSED,
      );
    const journalText = await readFile(journalPath, "utf8");
    const journal = splitJournal(journalText);
    if (!journal)
      fail(
        "E_BMAD_SPEC_COLLISION",
        `Materialization pending journal is unreadable or malformed: ${journalPath}`,
        {
          path: journalPath,
          fix: "A partial state that cannot be proven safe is never guessed at. Inspect the journal; restore its exact bytes or remove it deliberately before re-materializing.",
        },
        ExitCode.REFUSED,
      );
    if (journal.head.specDigest !== spec.digest)
      fail(
        "E_BMAD_SPEC_COLLISION",
        `Pending materialization journal was written for a different specification (${journal.head.specDigest}); requested ${spec.digest}.`,
        {
          path: journalPath,
          fix: "Explicitly remove the stale pending journal and any bytes it owns before applying a different specification.",
        },
        ExitCode.REFUSED,
      );
    pendingJournal = new Map(journal.records.map((record) => [record.path, record]));
  }
  // Per-node collision preflight, BEFORE any write:
  //  - missing desired path            => create (only ENOENT means missing)
  //  - receipt-owned, exact bytes/mode/type => unchanged
  //  - receipt-owned, mismatch         => AUTHORED EDIT => refuse (never repair)
  //  - not receipt-owned, present      => FOREIGN content => refuse (never adopt)
  // Every parent component is guarded against symlinks (never followed).
  const creates: string[] = [];
  const updates: string[] = [];
  const unchanged: string[] = [];
  const refuses: { path: string; reason: string }[] = [];
  const owned = new Set((runtimeReceiptExisting?.owned ?? []).map((p) => p));
  for (const node of nodes) {
    const parentProblem = await guardParentSymlinks(projectRoot, node.path);
    if (parentProblem) {
      refuses.push({ path: node.path, reason: parentProblem });
      continue;
    }
    const absolute = join(projectRoot, node.path);
    const info = await lstatEnoentOk(absolute);
    // Pending-journal adoption: a journal record claims exactly the identity this
    // materialization previously published at this path. Verify the claim against
    // the CURRENT tree: exact kind/type/bytes(/target/mode) match => adopted (the
    // retry continues from it); a missing or diverged claim refuses (the partial
    // state cannot be proven safe). Journaled paths are owned by definition.
    const claim = pendingJournal?.get(node.path);
    if (!info) {
      if (claim) {
        refuses.push({
          path: node.path,
          reason:
            "was published by an interrupted apply but is missing now (partial state cannot be proven safe; recovery bytes are never guessed)",
        });
        continue;
      }
      if (node.kind !== "dir") creates.push(node.path);
      continue;
    }
    const isOwned = owned.has(node.path) || claim !== undefined;
    if (claim) {
      if (node.kind === "file" && info.isFile()) {
        const bytes = await readFile(absolute);
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const mode = Number(info.mode) & 0o777;
        if (digest === node.digest && mode === ((node.mode ?? 0) & 0o777)) {
          // Ownership binds to the ACTUAL published filesystem identity. A
          // byte-identical replacement on a DIFFERENT dev/ino is foreign: it was
          // never published by this materialization, so it must not be adopted.
          if (claim.ino !== undefined && claim.dev !== undefined) {
            if (info.ino.toString() === claim.ino && info.dev.toString() === claim.dev) {
              unchanged.push(node.path);
            } else {
              refuses.push({
                path: node.path,
                reason:
                  "journal-recorded publication was replaced by a byte-identical file on a different filesystem identity (dev/ino); the replacement is foreign and is never auto-owned",
              });
            }
          } else {
            refuses.push({
              path: node.path,
              reason:
                "journal record carries no filesystem identity (dev/ino) for an existing publication; a partial state that cannot be proven safe is never adopted",
            });
          }
        } else {
          refuses.push({
            path: node.path,
            reason:
              "journal-recorded publication no longer matches the pinned identity (partial state was modified; recovery bytes are never silently repaired)",
          });
        }
      } else if (node.kind === "symlink" && info.isSymbolicLink()) {
        if ((await readlink(absolute)) === node.target) {
          if (claim.ino !== undefined && claim.dev !== undefined) {
            if (info.ino.toString() === claim.ino && info.dev.toString() === claim.dev) {
              unchanged.push(node.path);
            } else {
              refuses.push({
                path: node.path,
                reason:
                  "journal-recorded symlink publication was replaced on a different filesystem identity (dev/ino); the replacement is foreign and is never auto-owned",
              });
            }
          } else {
            refuses.push({
              path: node.path,
              reason:
                "journal record carries no filesystem identity (dev/ino) for an existing symlink publication; a partial state that cannot be proven safe is never adopted",
            });
          }
        } else {
          refuses.push({
            path: node.path,
            reason: "journal-recorded symlink publication diverged from the pinned target",
          });
        }
      } else if (node.kind === "dir" && info.isDirectory()) {
        unchanged.push(node.path);
      } else {
        refuses.push({
          path: node.path,
          reason:
            "journal-recorded publication has the wrong filesystem type (partial state cannot be proven safe)",
        });
      }
      continue;
    }
    if (!isOwned) {
      // Even byte-identical content is refused when the receipt does not own it:
      // ownership requires the materialization receipt, never adoption.
      refuses.push({
        path: node.path,
        reason:
          "exists and is not receipt-owned (foreign content is never adopted; matching bytes do not confer ownership)",
      });
      continue;
    }
    if (node.kind === "file" && info.isFile()) {
      const bytes = await readFile(absolute);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const mode = Number(info.mode) & 0o777;
      if (digest === node.digest && (node.mode === undefined || mode === (node.mode & 0o777))) {
        unchanged.push(node.path);
      } else {
        // An owned file whose bytes OR mode diverged from the pinned baseline is an
        // authored edit: refuse rather than silently overwrite or chmod it back.
        refuses.push({
          path: node.path,
          reason: `authored edit of an owned file (bytes ${digest === node.digest ? "match" : "diverge"}, mode ${mode.toString(8)} vs pinned ${(node.mode ?? 0).toString(8)})`,
        });
      }
    } else if (node.kind === "symlink" && info.isSymbolicLink()) {
      if ((await readlink(absolute)) === node.target) unchanged.push(node.path);
      else
        refuses.push({
          path: node.path,
          reason: "authored edit: owned symlink target diverged from the pinned baseline",
        });
    } else if (node.kind === "dir" && info.isDirectory()) {
      // Owned directories compare modes against the pinned captured baseline:
      // an authored chmod of an owned directory is an edit and refuses.
      const mode = Number(info.mode) & 0o777;
      if (node.mode === undefined || mode === (node.mode & 0o777)) {
        unchanged.push(node.path);
      } else {
        refuses.push({
          path: node.path,
          reason: `authored edit of an owned directory (mode ${mode.toString(8)} vs pinned ${(node.mode ?? 0).toString(8)})`,
        });
      }
    } else {
      refuses.push({ path: node.path, reason: "owned path has the wrong filesystem type" });
    }
  }
  // Readonly activation prepare: build the proposed manifest and validate EVERY
  // activation collision through the EXISTING sync planner, for BOTH dry and apply,
  // with ZERO writes. A fresh project (no .agents/skills.json) is planned through
  // the proposed-projection seam — no initScope workaround writes a manifest first.
  const snapshot = await readSelectionManifest(projectRoot);
  const rawManifest: Record<string, unknown> = snapshot.raw
    ? { ...(snapshot.raw as Record<string, unknown>) }
    : {};
  // Authored-selection preservation (F3): an existing manifest's authored policy
  // is NEVER silently replaced. The materializer declares its own pin
  // (inherit_global=false + the bmad pack + the resolved registry), but an
  // authored declaration that conflicts refuses BEFORE any write — the same
  // refusal for dry-run and apply, with the whole tree (manifest bytes
  // included) untouched.
  const bmadPackName = spec.sources.pack.name;
  if (snapshot.exists && snapshot.raw) {
    const authoredRefusals: string[] = [];
    if (rawManifest.inherit_global !== false)
      authoredRefusals.push(
        `inherit_global is authored as ${JSON.stringify(rawManifest.inherit_global)} (materialization requires false; ambient global inheritance is never adopted silently)`,
      );
    const authoredPacks = Array.isArray(rawManifest.packs)
      ? rawManifest.packs.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const foreignPacks = authoredPacks.filter(
      (entry) => entry.name !== bmadPackName || entry.version !== spec.sources.pack.version,
    );
    if (foreignPacks.length)
      authoredRefusals.push(
        `packs declare non-pinned selection(s): ${foreignPacks
          .map((entry) => `${String(entry.name)}@${String(entry.version)}`)
          .join(", ")} (authored selections are never dropped silently)`,
      );
    if (
      options.registryRoot &&
      "registry" in rawManifest &&
      rawManifest.registry !== options.registryRoot
    )
      authoredRefusals.push(
        `registry pointer is authored as ${JSON.stringify(rawManifest.registry)} (resolved registry is ${options.registryRoot})`,
      );
    if (authoredRefusals.length)
      fail(
        "E_BMAD_SPEC_COLLISION",
        `Refusing to materialize: the existing selection manifest carries authored declarations the materializer will not silently replace (first: ${authoredRefusals[0]}).`,
        {
          path: snapshot.path,
          detail: authoredRefusals,
          fix: "Remove the authored selection deliberately (accepting the pinned bmad declaration), or keep the authored manifest and do not materialize. Authored selections and policies are never dropped silently.",
        },
        ExitCode.REFUSED,
      );
  }
  // No ambient global inheritance: the materialized project declares its own pin.
  rawManifest.inherit_global = false;
  if (options.registryRoot) rawManifest.registry = options.registryRoot;
  rawManifest.packs = [
    {
      name: spec.sources.pack.name,
      version: spec.sources.pack.version,
      optional: false,
    },
  ];
  const syncOptions: SyncOptions = {
    ...options,
    project: projectRoot,
    scope: "project",
    ...(options.home === undefined ? {} : { home: options.home }),
  };
  const manifestMap = new Map([[snapshot.path, rawManifest]]);
  const prepared = await prepareSyncUnlocked(syncOptions, manifestMap);
  const manifestNeedsWrite =
    !snapshot.exists || JSON.stringify(snapshot.raw ?? {}) !== JSON.stringify(rawManifest);
  if (refuses.length)
    fail(
      "E_BMAD_SPEC_COLLISION",
      `Refusing to materialize: ${refuses.length} desired path(s) hold unowned or edited content (first: ${refuses[0]?.path}).`,
      {
        path: join(projectRoot, refuses[0]?.path ?? "."),
        detail: refuses.slice(0, 10).map((r) => `${r.path}: ${r.reason}`),
        fix: "Move foreign content away from desired paths, or remove the prior materialization receipt deliberately. Authored edits to owned files are never repaired silently.",
      },
      ExitCode.REFUSED,
    );
  return {
    plan: {
      spec,
      projectRoot,
      nodes,
      creates,
      updates,
      unchanged,
      refuses: [],
      dryRun: options.dryRun === true,
      findings: [],
    },
    runtimeReceiptExisting,
    pendingJournal,
    registry,
    snapshot,
    rawManifest,
    manifestPath: snapshot.path,
    manifestNeedsWrite,
    activationChanges: prepared.plan.changes.length,
    activationFindings: prepared.findings,
  };
}

/**
 * Append ONE record describing an ACTUAL publication to the pending journal.
 * Durable (O_APPEND) BEFORE the corresponding data is considered published, so
 * an interruption is always recoverable or honestly refused — never silently
 * half-owned.
 */
async function appendJournalRecord(
  handle: Awaited<ReturnType<typeof open>>,
  record: PendingJournalRecord,
): Promise<void> {
  await handle.writeFile(`${JSON.stringify(record)}${JOURNAL_SEPARATOR}`, "utf8");
}

async function applyRuntime(
  projectRoot: string,
  spec: BmadSpecification,
  nodes: readonly BmadMaterialNode[],
  createSet: ReadonlySet<string>,
  journal: ReadonlyMap<string, PendingJournalRecord>,
  onProgress: (written: number) => void,
): Promise<{ written: number; journalPath: string }> {
  let written = 0;
  const journalPath = join(projectRoot, RECEIPT_DIR, JOURNAL_NAME);
  // Create the pending journal EXCLUSIVELY: if one already exists, preflight
  // adopted it only for THIS spec and it must be complete/valid (checked there),
  // so we append to it; a foreign journal would already have refused.
  let journalHandle: Awaited<ReturnType<typeof open>>;
  if (journal.size > 0) {
    journalHandle = await open(journalPath, constants.O_WRONLY | constants.O_APPEND);
  } else {
    await mkdir(join(projectRoot, RECEIPT_DIR), { recursive: true });
    const header: PendingJournalHeader = {
      schema: JOURNAL_SCHEMA,
      specDigest: spec.digest,
      inputsDigest: spec.sources.inputsDigest,
      bmadVersion: spec.bmadVersion,
    };
    journalHandle = await open(
      journalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o644,
    );
    await journalHandle.writeFile(`${JSON.stringify(header)}${JOURNAL_SEPARATOR}`, "utf8");
  }
  try {
    // Deterministic order: parents before children, byte-stable across runs.
    const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
    for (const node of sorted) {
      const absolute = join(projectRoot, node.path);
      if (node.kind === "dir") {
        // Directory modes are honored from the captured pinned baseline (input
        // identity preserved); existing owned dirs keep identity.
        const desiredMode = (node.mode ?? 0o755) & 0o7777;
        const existing = await lstatEnoentOk(absolute);
        if (!existing) {
          await mkdir(absolute, { recursive: false, mode: desiredMode });
          const made = await lstatEnoentOk(absolute);
          if (made?.isDirectory()) {
            const mode = (Number(made.mode) & 0o7777) | desiredMode;
            await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY).then(
              async (dirHandle) => {
                try {
                  await dirHandle.chmod(mode);
                } finally {
                  await dirHandle.close();
                }
              },
            );
          }
          written += 1;
          // Bind the journal record to the ACTUAL published identity: lstat the
          // freshly created directory and capture its dev/ino (decimal strings).
          const madeStat = await lstatEnoentOk(absolute);
          await appendJournalRecord(journalHandle, {
            path: node.path,
            kind: "dir",
            mode: desiredMode & 0o777,
            ...(madeStat ? { dev: madeStat.dev.toString(), ino: madeStat.ino.toString() } : {}),
          });
          onProgress(written);
        }
        continue;
      }
      if (!createSet.has(node.path)) continue; // unchanged owned nodes: never rewritten (idempotent)
      // Exclusive publication of the PINNED bytes. The destination was verified
      // absent/owned by preflight; O_EXCL closes the same-iteration TOCTOU window
      // a re-lstat would leave open: a foreign file planted in the
      // lstat->publish gap makes open() fail with EEXIST and the apply refuses
      // rather than clobbering it.
      await mkdir(dirname(absolute), { recursive: true });
      if (node.kind === "file") {
        const body = node.bytes ?? new TextEncoder().encode("");
        const handle = await open(
          absolute,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          node.mode ?? 0o644,
        );
        try {
          await handle.writeFile(body);
          await handle.chmod((node.mode ?? 0o644) & 0o777);
          // Bind the journal record to the ACTUAL published identity: stat the OPEN
          // file descriptor (not a re-lstat) so the recorded dev/ino are exactly the
          // inode this publication created — the ground truth for recovery ownership.
          const published = await handle.stat();
          await appendJournalRecord(journalHandle, {
            path: node.path,
            kind: "file",
            sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
            mode: (node.mode ?? 0o644) & 0o777,
            dev: published.dev.toString(),
            ino: published.ino.toString(),
          });
        } finally {
          await handle.close();
        }
        written += 1;
        onProgress(written);
        continue;
      }
      // symlink() fails with EEXIST when the target exists: an exclusive create.
      await symlink(node.target as string, absolute);
      // Bind the journal record to the ACTUAL published identity: lstat the freshly
      // created symlink (does not follow) and capture its dev/ino.
      const linked = await lstatEnoentOk(absolute);
      written += 1;
      await appendJournalRecord(journalHandle, {
        path: node.path,
        kind: "symlink",
        target: node.target as string,
        ...(linked ? { dev: linked.dev.toString(), ino: linked.ino.toString() } : {}),
      });
      onProgress(written);
    }
  } finally {
    await journalHandle.close();
  }
  return { written, journalPath };
}

async function writeRuntimeReceipt(
  projectRoot: string,
  spec: BmadSpecification,
  nodes: readonly BmadMaterialNode[],
): Promise<string> {
  const receipt: RuntimeReceipt = {
    schema: "skillex.bmad-materialization-receipt/v1",
    specDigest: spec.digest,
    inputsDigest: spec.sources.inputsDigest,
    bmadVersion: spec.bmadVersion,
    owned: nodes.map((node) => node.path).sort(),
  };
  const receiptPath = join(projectRoot, RECEIPT_DIR, RECEIPT_NAME);
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  // Idempotence: a byte-identical receipt is never rewritten (no volatile mtime churn).
  const current = await readFile(receiptPath, "utf8").catch(() => null);
  if (current === body) return receiptPath;
  await mkdir(join(projectRoot, RECEIPT_DIR), { recursive: true });
  await writeFile(receiptPath, body, { encoding: "utf8", mode: 0o644 });
  return receiptPath;
}

/**
 * The activation layer reuses the EXISTING selection/sync writer under the SHARED
 * activation lock. All validation already happened in readonly preflight (both dry
 * and apply); a fresh project never needed an initScope manifest write to plan.
 *
 * Publish order: the selection manifest is written FIRST (its guarded writer owns
 * .agents/ creation), then reconcileUnlocked re-resolves from the saved manifest
 * and is told — via the `expected` map — exactly which declaration it just
 * published, removing the read-after-write race without re-reading the snapshot.
 */
async function applyActivation(
  options: BmadMaterializeOptions,
  prepared: Preflight,
): Promise<{ changes: number; findings: readonly Diagnostic[] }> {
  const { snapshot, rawManifest, manifestPath, manifestNeedsWrite } = prepared;
  const projectRoot = prepared.plan.projectRoot;
  const syncOptions: SyncOptions = {
    ...options,
    project: projectRoot,
    scope: "project",
    ...(options.home === undefined ? {} : { home: options.home }),
  };
  const expectedMap = new Map([[manifestPath, rawManifest]]);
  if (!manifestNeedsWrite) {
    // Declaration already matches the pinned spec: activate directly.
    const reconciled = await reconcileUnlocked(syncOptions, expectedMap);
    const applied = reconciled.data?.applied.length ?? 0;
    return { changes: applied, findings: reconciled.findings };
  }
  await writeSelectionManifest(snapshot, rawManifest);
  const reconciled = await reconcileUnlocked(syncOptions, expectedMap);
  const applied = reconciled.data?.applied.length ?? 0;
  // A manifest publication that activation could not apply is a PARTIAL state.
  if (!reconciled.ok)
    throw new SkillexError(reconciled.exit, [
      ...reconciled.findings,
      {
        code: "E_BMAD_SPEC_PARTIAL",
        severity: "error",
        message: `Selection manifest was published to ${manifestPath}, but activation did not finish applying it.`,
        path: manifestPath,
        fix: "Inspect the reported activation error, correct it, then rerun apply; the saved declaration is preserved.",
      },
    ]);
  return { changes: applied + 1, findings: reconciled.findings };
}

/**
 * IO failure DURING a mutating apply: published work is never hidden behind a null
 * payload and recovery bytes are never deleted. The envelope carries truthful
 * partial state (what was written, where) alongside the error findings.
 */
function ioFailureResult(
  command: string,
  error: unknown,
  partial: BmadMaterializeData | null,
): ResultEnvelope<BmadMaterializeData | null> {
  const issue =
    error instanceof SkillexError
      ? { exit: error.exit, findings: error.findings }
      : {
          exit: ExitCode.FAILURE,
          findings: [
            {
              code: "E_IO" as const,
              severity: "error" as const,
              message: error instanceof Error ? error.message : String(error),
              fix: "Check the project root, spec, registry, and runtime paths, then rerun apply.",
            },
          ],
        };
  if (!partial) return makeResult(command, null, issue);
  return makeResult(command, partial, {
    exit: issue.exit === ExitCode.INTERRUPTED ? ExitCode.INTERRUPTED : ExitCode.PARTIAL,
    findings: [
      ...issue.findings,
      {
        code: "E_BMAD_SPEC_PARTIAL",
        severity: "error" as const,
        message: `Materialization did not finish; ${partial.changesWritten} managed change(s) were already published.`,
        path: partial.receiptPath,
        fix: "Do not delete recovery bytes. Inspect the reported error, correct it, then rerun apply; owned state is verified against the receipt before any further write.",
        detail: [
          `applied=${partial.applied}`,
          `receiptPath=${partial.receiptPath}`,
          `changesWritten=${partial.changesWritten}`,
        ],
      },
    ],
  });
}

export async function materializeBmadProject(
  options: BmadMaterializeOptions,
): Promise<ResultEnvelope<BmadMaterializeData | null>> {
  const command = options.dryRun ? "bmad plan" : "bmad apply";
  let partial: BmadMaterializeData | null = null;
  try {
    const action = async (): Promise<ResultEnvelope<BmadMaterializeData | null>> => {
      // ONE authoritative readonly prepare: manifest + activation are validated
      // fully (identically for dry and apply) BEFORE any runtime/receipt/manifest write.
      const fresh = await preflight(options);
      const receiptPath = join(fresh.plan.projectRoot, RECEIPT_DIR, RECEIPT_NAME);
      const journalPath = join(fresh.plan.projectRoot, RECEIPT_DIR, JOURNAL_NAME);
      if (options.dryRun) {
        return makeResult(
          command,
          {
            ...fresh.plan,
            applied: false,
            receiptPath,
            changesWritten: 0,
          },
          { findings: fresh.activationFindings },
        );
      }
      // Apply: runtime support bytes first (all preflight-validated, each an
      // exclusive create journaled as ACTUAL publication), then the ownership
      // receipt, then the manifest + activation publication. A failure after any
      // publish returns truthful partial data, never a hidden null.
      const createSet = new Set(fresh.plan.creates);
      const journalForApply = fresh.pendingJournal ?? new Map<string, PendingJournalRecord>();
      const { written } = await applyRuntime(
        fresh.plan.projectRoot,
        fresh.plan.spec,
        fresh.plan.nodes,
        createSet,
        journalForApply,
        (count) => {
          // Truthful execution progress from the FIRST publication: if any later
          // step (or the next publication itself) fails, ioFailureResult reports
          // exactly what was ACTUALLY published so far — never null, never a
          // claim about paths not yet published.
          partial = {
            ...fresh.plan,
            dryRun: false,
            applied: true,
            receiptPath,
            changesWritten: count,
          };
        },
      );
      partial = {
        ...fresh.plan,
        dryRun: false,
        applied: true,
        receiptPath,
        changesWritten: written,
      };
      const writtenReceiptPath = await writeRuntimeReceipt(
        fresh.plan.projectRoot,
        fresh.plan.spec,
        fresh.plan.nodes,
      );
      partial = {
        ...fresh.plan,
        dryRun: false,
        applied: true,
        receiptPath: writtenReceiptPath,
        changesWritten: written,
      };
      const activation = await applyActivation(options, fresh);
      // Full validated publication: the runtime journal is superseded by the
      // receipt; remove it only now (exclusive rename), never on failure.
      if (existsSync(journalPath)) {
        const removed = `${journalPath}.removed-${process.pid}`;
        await rename(journalPath, removed);
        await unlink(removed);
      }
      const totalChanges = written + activation.changes;
      const data: BmadMaterializeData = {
        ...fresh.plan,
        dryRun: false,
        applied: true,
        receiptPath: writtenReceiptPath,
        changesWritten: totalChanges,
      };
      partial = data;
      return makeResult(command, data, { findings: activation.findings });
    };
    // The shared activation lock serializes materialization with selection/sync
    // writers; the catalog lock additionally serializes supported registry
    // writers (freeze) with materialization so pinned-input verification and
    // publication cannot interleave with a catalog mutation of the same registry.
    const registry = await discoverRegistry(options);
    const withCatalog = async (): Promise<ResultEnvelope<BmadMaterializeData | null>> =>
      withCatalogLock(
        registry,
        {
          ...(options.home === undefined ? {} : { home: options.home }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
        },
        action,
      );
    const result = await withLock(LOCK_RESOURCE, withCatalog, {
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    return result;
  } catch (error) {
    return ioFailureResult(command, error, partial);
  }
}
