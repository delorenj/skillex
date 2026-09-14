import type { SyncChange, SyncOptions } from "./reconciliation-types.js";
import type { Diagnostic } from "./result.js";
import type { ExcludedBinding, Resolution, ScopeName, SkillOrigin } from "./selection.js";

export interface DiagnosticOptions extends Omit<SyncOptions, "dryRun" | "exitCode"> {}

export interface PathObservation {
  readonly path: string;
  readonly kind: "missing" | "directory" | "link" | "file" | "other" | "unreadable";
  readonly rawTarget: string | null;
  readonly target: string | null;
  readonly reachable: boolean;
  readonly ownership: "owned" | "foreign" | "changed" | "pack" | "none";
}

export interface SkillObservation extends PathObservation {
  readonly name: string;
}

export interface AliasObservation extends PathObservation {
  readonly reachesRoot: boolean;
}

export interface ReceiptObservation {
  readonly path: string | null;
  readonly state: "missing" | "valid" | "pending" | "invalid";
  readonly pending: {
    readonly path: string;
    readonly stage: string;
    readonly parked: string;
  } | null;
}

export interface StatusScope {
  readonly scope: ScopeName;
  readonly root: string;
  readonly manifestPath: string;
  readonly mode: "composed" | "pack" | null;
  readonly desired: readonly string[] | null;
  readonly actual: {
    readonly root: PathObservation;
    readonly entries: readonly SkillObservation[];
  };
  readonly counts: {
    readonly desired: number | null;
    readonly actual: number;
    readonly owned: number;
    readonly foreign: number;
    readonly pack: number;
    readonly missing: number | null;
  };
  readonly aliases: readonly AliasObservation[];
  readonly receipt: ReceiptObservation;
}

export interface StatusResult {
  readonly resolution: Resolution | null;
  readonly writeScopes: readonly ScopeName[];
  readonly scopes: readonly StatusScope[];
  readonly changes: readonly SyncChange[];
}

export interface SkillExplanation {
  readonly scope: ScopeName;
  readonly root: string;
  readonly manifestPath: string;
  readonly state: "effective" | "excluded" | "dormant" | "unselected" | "blocked";
  readonly canonical: string | null;
  readonly origins: readonly SkillOrigin[];
  readonly exclusions: readonly ExcludedBinding[];
  readonly dormant: readonly SkillOrigin[];
  readonly actual: PathObservation;
  readonly aliases: readonly { readonly path: string; readonly reachable: boolean }[];
  readonly blockers: readonly Diagnostic[];
}

export interface ExplainResult {
  readonly name: string;
  readonly canonical: string | null;
  readonly scopes: readonly SkillExplanation[];
}
