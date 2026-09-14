import type { LockOptions } from "./lock.js";
import type { Diagnostic } from "./result.js";
import type { RegistryOptions, SkillOrigin } from "./selection.js";

export interface ProfileOptions extends RegistryOptions, LockOptions {
  readonly hermesRoot?: string;
  readonly project?: string;
  readonly signal?: { readonly aborted: boolean };
}

export interface ProfileSyncOptions extends ProfileOptions {
  readonly project: string;
  readonly dryRun?: boolean;
}

export interface HermesRootSelection {
  /** Expanded absolute spelling selected before following any profile symlink. */
  readonly path: string;
  readonly root: string | null;
  readonly source: "argument" | "environment" | "default";
}

export interface ProfileLocation {
  readonly name: string;
  /** Hermes-visible profile path; root is its canonical directory target. */
  readonly path: string;
  readonly root: string;
  readonly skillsRoot: string;
  readonly rootSymlink: boolean;
  readonly skills: {
    readonly kind: "missing" | "directory" | "symlink" | "file" | "other";
    readonly rawTarget: string | null;
    readonly target: string | null;
  };
}

export interface ProfileDiscovery {
  readonly hermesRoot: HermesRootSelection;
  readonly profiles: readonly ProfileLocation[];
  readonly findings: readonly Diagnostic[];
}

export interface ProfileCandidate {
  readonly name: string;
  readonly path: string;
  readonly target: string;
  readonly origins: readonly SkillOrigin[];
  readonly state: "create" | "update" | "unchanged" | "shadowed";
  readonly winner: "global" | "project" | "profile";
}

export interface ProfileLocalEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly rawTarget: string | null;
  readonly target: string | null;
  readonly shadows: boolean;
}

export interface ProfileChange {
  readonly action:
    | "mkdir"
    | "create"
    | "update"
    | "prune"
    | "release"
    | "write-receipt"
    | "recover";
  readonly name?: string;
  readonly path: string;
  readonly target?: string;
}

export interface ProfileSummary {
  readonly profile: ProfileLocation;
  readonly project: string | null;
  readonly receiptPath: string | null;
  readonly projection: "unmanaged" | "managed" | "pending" | "invalid";
  readonly counts: { readonly managed: number | null; readonly local: number };
}

export interface ProfileListResult {
  readonly hermesRoot: HermesRootSelection;
  readonly profiles: readonly ProfileSummary[];
}

export interface ProfileShowResult {
  readonly profile: ProfileLocation;
  readonly project: string | null;
  readonly receiptPath: string | null;
  readonly managed: readonly ProfileCandidate[] | null;
  readonly preserved: readonly ProfileLocalEntry[];
  readonly changes: readonly ProfileChange[];
  readonly pending: boolean;
}

export interface ProfileSyncResult extends ProfileShowResult {
  readonly project: string;
  readonly dryRun: boolean;
  readonly applied: readonly ProfileChange[];
}
