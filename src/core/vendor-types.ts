import type { LockOptions } from "./lock.js";
import type { RegistryOptions, RegistrySelection } from "./selection.js";

export interface VendorOptions extends RegistryOptions {
  readonly sources?: readonly string[];
  readonly checkouts?: Readonly<Record<string, string>>;
  readonly signal?: { readonly aborted: boolean };
  readonly upstream?: boolean;
  readonly stateHome?: string;
}

export interface VendorSyncOptions extends VendorOptions, LockOptions {
  readonly dryRun?: boolean;
  readonly adopt?: boolean;
  readonly discardLocalEdits?: boolean;
  readonly prune?: boolean;
}

export interface VendorSourceSkill {
  readonly name: string;
  readonly dir: string;
}

export interface VendorSource {
  readonly name: string;
  readonly repo: string;
  readonly version: string;
  readonly checkout: string;
  readonly subdir: string;
  readonly membership: "explicit" | "discovery";
  readonly skills: readonly VendorSourceSkill[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly optional: boolean;
}

export interface VendorSourcesManifest {
  readonly path: string;
  readonly registry: RegistrySelection;
  readonly version: 1;
  readonly sources: readonly VendorSource[];
}

export interface VendorCheckout {
  readonly id: string;
  readonly root: string | null;
  readonly source: "argument" | "environment" | "mapping" | "default";
  readonly searched: readonly string[];
}

export interface VendorProvenance {
  readonly path: string;
  readonly type: string;
  readonly source: string | null;
  readonly upstream: string | null;
  readonly upstreamVersion: string | null;
  readonly upstreamCommit: string | null;
  readonly upstreamTree: string | null;
  readonly upstreamPath: string | null;
  readonly extractedAt: string | null;
  readonly digest: string | null;
  readonly digestFormat: string | null;
  readonly modifiedLocally: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface VendorProvenanceInput {
  readonly source: VendorSource;
  readonly commit: string;
  readonly tree: string;
  readonly upstreamPath: string;
  readonly digest: string;
  readonly extractedAt: string;
  readonly previousProvenance?: Readonly<Record<string, unknown>>;
}

export interface VendorSkillStatus {
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly state:
    | "ok"
    | "missing"
    | "unrecorded"
    | "invalid"
    | "modified"
    | "stale"
    | "unknown"
    | "recorded"
    | "orphaned"
    | "foreign";
  readonly recordedCommit: string | null;
  readonly upstreamCommit: string | null;
  readonly recordedDigest: string | null;
  readonly digest: string | null;
}

export interface VendorSourceListResult {
  readonly registry: RegistrySelection;
  readonly manifest: string;
  readonly sources: readonly { readonly source: VendorSource; readonly checkout: VendorCheckout }[];
}

export interface VendorSourceShowResult {
  readonly registry: RegistrySelection;
  readonly manifest: string;
  readonly source: VendorSource;
  readonly checkout: VendorCheckout;
  readonly membership: "explicit" | "recorded";
  readonly skills: readonly VendorSkillStatus[];
}

export interface VendorStatusResult {
  readonly registry: RegistrySelection;
  readonly manifest: string;
  readonly upstream: boolean;
  readonly sources: readonly {
    readonly name: string;
    readonly membership: "explicit" | "recorded";
    readonly checkout: VendorCheckout | null;
    readonly upstreamCommit: string | null;
  }[];
  readonly skills: readonly VendorSkillStatus[];
}

export interface VendorSourceResolution {
  readonly name: string;
  readonly checkout: string | null;
  readonly commit: string | null;
  readonly refKind: "branch" | "tag" | "commit" | "unknown" | null;
  readonly skipped: boolean;
}

export interface VendorChange {
  readonly action: "create" | "update" | "adopt" | "prune" | "unchanged";
  readonly name: string;
  readonly source: string;
  readonly path: string;
  readonly commit?: string;
  readonly tree?: string;
  readonly upstreamPath?: string;
  readonly digest?: string;
}

export interface VendorSyncResult {
  readonly registry: RegistrySelection;
  readonly manifest: string;
  readonly dryRun: boolean;
  readonly sources: readonly VendorSourceResolution[];
  readonly changes: readonly VendorChange[];
  readonly applied: readonly VendorChange[];
}
