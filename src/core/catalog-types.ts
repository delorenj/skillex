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

export interface SkillDetails extends SkillMetadata {
  readonly name: string;
  readonly path: string;
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
