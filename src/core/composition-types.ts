import type { RegistryOptions, RegistrySelection } from "./selection.js";

export interface CompositionOptions extends RegistryOptions {
  readonly dryRun?: boolean;
  readonly description?: string;
  readonly stateHome?: string;
  readonly timeoutMs?: number;
}

export interface CompositionDetails {
  readonly kind: "set" | "pack";
  readonly name: string;
  readonly version?: string;
  readonly path: string;
  readonly skills: readonly { readonly name: string; readonly path: string }[];
  readonly description?: string;
}

export interface CompositionChange {
  readonly action: "create-directory" | "create-link" | "remove-link" | "write-manifest";
  readonly path: string;
  readonly target?: string;
}

export interface CompositionMutationData {
  readonly registry: RegistrySelection;
  readonly composition: CompositionDetails;
  readonly dryRun: boolean;
  readonly changes: readonly CompositionChange[];
}

export interface SetListData {
  readonly registry: RegistrySelection;
  readonly sets: readonly CompositionDetails[];
}

export interface SetShowData {
  readonly registry: RegistrySelection;
  readonly set: CompositionDetails;
}

export interface PackListData {
  readonly registry: RegistrySelection;
  readonly packs: readonly CompositionDetails[];
}

export interface PackShowData {
  readonly registry: RegistrySelection;
  readonly pack: CompositionDetails;
}
