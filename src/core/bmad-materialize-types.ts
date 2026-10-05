/**
 * BMAD materialization specification types (SKRILL-27).
 *
 * A BmadSpecification is a *validated offline pinned installation spec*: it binds a
 * BMAD pack version label to the exact content identity of the pinned inputs that
 * produced it (pack.toml bytes, pack version label + schema, canonical membership,
 * per-client command byte hashes, and the runtime support tree digest). Per ADR-0001
 * (canonical, reference-only), membership is pinned as NAMES only — the sealed
 * per-skill payload inventory that the ADR rejected is never duplicated.
 */
import type { RegistryOptions } from "./selection.js";

/** Where the pinned runtime support assets come from. */
export interface BmadRuntimeSupportSource {
  /** Absolute or ~-expanded local directory containing the runtime tree (e.g. a BMAD-enabled project root whose `_bmad/` is complete). */
  readonly path: string;
  /** Content digest of the entire runtime source tree (types, bytes, modes, link targets). */
  readonly digest: string;
}

/**
 * A runtime path declared by the source installation's files-manifest.csv, or an
 * extra path observed under `_bmad/` (origin `observed`, governed by the explicit
 * `runtimeExtraPolicy`).
 *
 * Canonical skill bodies are NEVER runtime dependencies: a path the source
 * manifests identify as a canonical SKILL.md is bound as a catalog REFERENCE
 * (see `canonical` + `reference`), never copied into the runtime. Only genuine
 * support assets (scripts, templates, module assets, workflows, configs the
 * modules need) may be materialized.
 */
export interface BmadRuntimeDependency {
  /** Relative path under the project's `_bmad/` runtime root, e.g. `scripts/resolve_config.py`. */
  readonly path: string;
  /** `file` | `dir` | `symlink` — the ACTUAL filesystem kind at capture time. */
  readonly kind: "file" | "dir" | "symlink";
  /** sha256 of file bytes, of the link target, or "" for directories/missing. */
  readonly digest: string;
  /**
   * Where this requirement came from. `declared` = recorded in the source install's
   * files-manifest (canonical requirement); `observed` = present under `_bmad/` but
   * NOT declared (installer state, only materialized under an explicit policy).
   */
  readonly origin: "declared" | "observed";
  /**
   * What this entry is. `support` = a genuine runtime support asset.
   * `canonical-support` = an entry the source manifests identify as a canonical
   * skill body location: it is bound as a catalog reference, NOT copied.
   */
  readonly role: "support" | "canonical-support";
  /** The canonical skill NAME when role=canonical-support (exact manifest match). */
  readonly canonical?: string;
  /**
   * For role=canonical-support: true when the declared canonical path maps EXACTLY
   * (path + name) to a member of the pinned pack AND resolves in the catalog.
   * Such entries never produce runtime copies; they prove the reference contract.
   */
  readonly reference?: boolean;
  /** Captured permission mode (files/dirs), preserved byte-stable into the target. */
  readonly mode?: number;
  /** Symlink target when kind=symlink (relative, as captured). */
  readonly target?: string;
  /** Present only when a declared support path is missing from the runtime source. */
  readonly missing?: true;
}

/** A native client adapter explicitly requested by the specification. */
export interface BmadClientSelection {
  /** Client id as known to BMAD_COMMAND_CLIENTS, e.g. `claude-code`, `codex`. */
  readonly client: string;
  /** Layout path relative to project root, e.g. `.claude/commands`. */
  readonly layout: string;
}

/** The canonical composition pin: how the pinned pack hangs on the catalog. */
export interface BmadCompositionPin {
  /** The frozen pack directory name, e.g. `6.12.1-next.0`. */
  readonly packVersion: string;
  /** The exact pack.toml bytes of the frozen pack, sha256-pinned. */
  readonly packTomlSha256: string;
  /**
   * ONE aggregate digest over: the exact pack.toml bytes, the sorted member
   * names the pack declares, and each member's captured canonical content
   * (entry paths, types, bytes, modes, link targets, plus each member root's
   * own mode) — the catalog closure pin. This replaces the sealed per-skill
   * inventory the ADR rejected: membership stays names-only in the document,
   * while content identity is bound aggregate — a single hash, never a
   * per-skill hash array — so byte/mode tampering a member under the same
   * version label refuses.
   */
  readonly membersSha256: string;
}

/**
 * Project configuration C — explicit per-project inputs that are NOT normalized away.
 * Project-specific identity (project_name etc.) lives here, so two projects with
 * different C are expected to have different normalized output (correctly).
 */
export interface BmadProjectConfig {
  /** Project name used by BMAD runtime config (e.g. `[core] project_name`). */
  readonly projectName: string | null;
  /** Extra key/values written into the materialized `_bmad/config.toml` `[core]` section. */
  readonly core: Readonly<Record<string, string>>;
}

export interface BmadSpecificationSources {
  /** Pack family + version label this spec pins (provenance, never identity). */
  readonly pack: { readonly name: string; readonly version: string };
  /**
   * Canonical membership pin (names only, per ADR-0001; no duplicated payloads).
   * Each entry is the skill NAME; content identity is carried by `composition`
   * (one aggregate: exact pack.toml bytes + declared membership), never by a
   * sealed per-skill inventory.
   */
  readonly members: readonly string[];
  /** How the pinned pack hangs on the catalog: version + exact pack.toml bytes. */
  readonly composition: BmadCompositionPin;
  /**
   * Per-client command inventories (requested clients only). `commandsPath` is
   * the pack-relative directory the frozen command bytes were read from;
   * `files` pins each file's name + sha256.
   */
  readonly commands: ReadonlyArray<{
    readonly client: string;
    readonly layout: string;
    readonly commandsPath: string;
    readonly files: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
  }>;
  /** Pinned runtime support source (explicit; no ambient global inheritance). */
  readonly runtime: BmadRuntimeSupportSource;
  /** Runtime closure: validated declared dependencies + governed observed extras. */
  readonly runtimeDeps: readonly BmadRuntimeDependency[];
  /**
   * Explicit policy for paths present under `_bmad/` but NOT declared in the
   * source files-manifest. `declared` (default): only the validated declared
   * closure is materialized; observed extras are reported, never copied.
   * `include`: observed extras are materialized as support assets too (never
   * canonical bodies — those are refused regardless of policy).
   */
  readonly runtimeExtraPolicy: "declared" | "include";
  /** Digest over the canonical serialization of everything above (content identity). */
  readonly inputsDigest: string;
  /** Human-readable label describing the pinned provenance. */
  readonly provenanceLabel: string;
}

export interface BmadSpecification {
  readonly schema: "skillex.bmad-spec/v1";
  readonly bmadVersion: string;
  readonly clients: readonly BmadClientSelection[];
  readonly projectConfig: BmadProjectConfig;
  readonly sources: BmadSpecificationSources;
  /** Digest binding bmadVersion + sources; equal specs => equal digest. */
  readonly digest: string;
}

/** Build options for `skillex bmad spec build`. */
export interface BmadSpecBuildOptions extends RegistryOptions {
  readonly packRef: string;
  readonly runtimeRoot: string;
  readonly clients: readonly string[];
  readonly projectName?: string;
  readonly core?: Readonly<Record<string, string>>;
  readonly specPath?: string;
  readonly includeRuntime?: boolean;
  /** Explicit policy: also materialize runtime paths observed but not declared. */
  readonly includeObservedRuntime?: boolean;
}

export interface BmadSpecBuildData {
  readonly spec: BmadSpecification;
  readonly specPath: string | null;
  readonly written: boolean;
  readonly dryRun: boolean;
  readonly findings: readonly import("./result.js").Diagnostic[];
}

/** Options for plan/apply (materialize). */
export interface BmadMaterializeOptions extends RegistryOptions {
  readonly projectRoot: string;
  readonly specPath: string;
  readonly dryRun?: boolean;
  readonly stateHome?: string;
  readonly timeoutMs?: number;
}

/** One desired-state node in the materialization graph. */
export interface BmadMaterialNode {
  readonly path: string;
  readonly kind: "file" | "symlink" | "dir";
  /** For symlinks: relative target. For files: null. */
  readonly target: string | null;
  /** sha256 of file bytes (files only). */
  readonly digest: string | null;
  /** Desired permission mode (files/dirs) captured from the pinned source before any write. */
  readonly mode?: number;
  /** true when the node belongs to the managed materialization. */
  readonly managed: true;
  /** Owning layer. */
  readonly layer: "runtime" | "activation" | "manifest" | "client";
  /** Absolute source path for file copies (present only for layer=client). */
  readonly source?: string;
  /**
   * EXACT bytes to publish for file nodes — captured at preflight from the pinned
   * source (or generated for config.toml) and NEVER re-read from the source tree
   * after the pin check. Mid-apply source-byte swaps cannot change what is
   * published; concurrently planted foreign content is never adopted.
   */
  readonly bytes?: Uint8Array;
}

export interface BmadMaterialPlan {
  readonly spec: BmadSpecification;
  readonly projectRoot: string;
  readonly nodes: readonly BmadMaterialNode[];
  readonly creates: readonly string[];
  readonly updates: readonly string[];
  readonly unchanged: readonly string[];
  readonly refuses: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly dryRun: boolean;
  readonly findings: readonly import("./result.js").Diagnostic[];
}

export interface BmadMaterializeData extends BmadMaterialPlan {
  readonly applied: boolean;
  /** Receipt path under the project recording ownership of the materialized state. */
  readonly receiptPath: string;
  /** Number of managed changes actually written (apply, second run => 0). */
  readonly changesWritten: number;
}

/** Guarded error types. */
export type BmadSpecErrorCode =
  | "E_BMAD_SPEC_PIN"
  | "E_BMAD_SPEC_SOURCE"
  | "E_BMAD_SPEC_COLLISION"
  | "E_BMAD_SPEC_RUNTIME_MISSING"
  | "E_BMAD_SPEC_RUNTIME_REFUSE"
  | "E_BMAD_SPEC_MANIFEST"
  | "E_BMAD_SPEC_VERSION"
  | "E_BMAD_SPEC_CLIENT";
