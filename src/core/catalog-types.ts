import type { RegistryOptions, RegistrySelection } from "./selection.js";

export interface SkillReference {
  readonly kind: "set" | "pack";
  readonly name: string;
  readonly version?: string;
  readonly path: string;
}

export interface SkillMetadata {
  readonly description: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>> | null;
}

/** Who owns a definition's bytes: the catalog's all-skills/, or a repository (ADR-0002). */
export interface SkillOwner {
  readonly kind: "catalog" | "repo";
  /** The declaring link source; null for catalog definitions. */
  readonly source: string | null;
  readonly repo: string | null;
  /** The resolved checkout root on this machine; null for catalog definitions. */
  readonly checkout: string | null;
  /** The owning checkout's HEAD; null for catalog definitions or when Git cannot say. */
  readonly commit: string | null;
}

export interface SkillDetails extends SkillMetadata {
  readonly name: string;
  readonly path: string;
  readonly owner: SkillOwner;
  readonly references: readonly SkillReference[];
}

export interface ListSkillsOptions extends RegistryOptions {
  readonly query?: string;
}

export interface SkillListData {
  readonly registry: RegistrySelection;
  readonly skills: readonly SkillDetails[];
}

export interface SkillShowData {
  readonly registry: RegistrySelection;
  readonly skill: SkillDetails;
}
