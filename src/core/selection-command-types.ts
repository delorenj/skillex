import type { SyncChange, SyncOptions } from "./reconciliation-types.js";
import type { ScopeName } from "./selection.js";

export type SelectionKind = "skill" | "set" | "pack";

export interface SelectionOptions extends Omit<SyncOptions, "scope" | "exitCode"> {
  readonly scope?: ScopeName;
}

export interface SelectionChange {
  readonly scope: ScopeName;
  readonly action: "write-manifest" | SyncChange["action"];
  readonly path: string;
  readonly target?: string;
}

export interface SelectionResult {
  readonly scope: ScopeName;
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly saved: boolean;
  readonly changes: readonly SelectionChange[];
  readonly applied: readonly SelectionChange[];
}
