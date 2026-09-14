import type { LockOptions } from "./lock.js";
import type { RegistryOptions, RegistrySelection } from "./selection.js";

/** Explicit choices for inputs whose names or selections cannot be inferred from content. */
export interface MigrationMapping {
  readonly version: 1;
  readonly names?: Readonly<Record<string, string>>;
  /** Null explicitly retires a composition reference, never a real skill tree or activation entry. */
  readonly references?: Readonly<Record<string, string | null>>;
  readonly digests?: Readonly<Record<string, string>>;
  readonly packs?: Readonly<Record<string, { readonly name: string; readonly version: string }>>;
  readonly wrappers?: Readonly<
    Record<string, { readonly name: string; readonly ownedPaths: readonly string[] }>
  >;
  readonly manifests?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface MigrationOptions extends RegistryOptions, LockOptions {
  /** Preview is the default. Only true authorizes publication. */
  readonly apply?: boolean;
  /** No scope is selected from the current working directory. */
  readonly scope?: "global" | "project";
  readonly project?: string;
  readonly profile?: string;
  readonly hermesRoot?: string;
  readonly mapping?: MigrationMapping;
  readonly sourcesFile?: string;
  readonly signal?: { readonly aborted: boolean };
}

export interface MigrationItem {
  readonly id: string;
  readonly area: "catalog" | "composition" | "manifest" | "activation" | "profile" | "sources";
  readonly action: string;
  readonly path: string;
  readonly target?: string;
  readonly state: "ready" | "blocked" | "verified" | "preserved";
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly details: readonly string[];
  readonly dependsOn: readonly string[];
}

/** Shared internal section result; the public result also identifies the selected registry. */
export interface MigrationSectionResult {
  readonly items: readonly MigrationItem[];
  readonly applied: readonly string[];
  readonly receipts: readonly string[];
}

export interface MigrationResult extends MigrationSectionResult {
  readonly registry: RegistrySelection | null;
  readonly apply: boolean;
  readonly targets: readonly string[];
}
