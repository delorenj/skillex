import type { LockOptions } from "./lock.js";
import type { ResolveOptions, ScopeName } from "./selection.js";

export interface SyncOptions extends ResolveOptions, LockOptions {
  readonly dryRun?: boolean;
  readonly exitCode?: boolean;
  readonly signal?: { readonly aborted: boolean };
}

export interface SyncChange {
  readonly scope: ScopeName;
  readonly action:
    | "create-directory"
    | "create-link"
    | "replace-link"
    | "remove-link"
    | "replace-root"
    | "write-receipt"
    | "recover";
  readonly path: string;
  readonly target?: string;
}

export interface SyncScopePlan {
  readonly scope: ScopeName;
  readonly root: string;
  readonly activationRoot: string;
  readonly mode: "composed" | "pack";
  readonly skills: readonly { readonly name: string; readonly path: string }[];
  readonly receiptPath: string;
  readonly changes: readonly SyncChange[];
}

export interface SyncPlan {
  readonly writeScopes: readonly ScopeName[];
  readonly scopes: readonly SyncScopePlan[];
  readonly changes: readonly SyncChange[];
}

export interface SyncResult extends SyncPlan {
  readonly dryRun: boolean;
  readonly applied: readonly SyncChange[];
}
