export type ScopeName = "global" | "project";
export type WriteScope = "auto" | ScopeName | "both";

export interface SkillSelection {
  readonly name: string;
}

export interface SetSelection {
  readonly name: string;
  readonly include?: readonly string[];
  readonly exclude: readonly string[];
  readonly optional: boolean;
}

export interface PackSelection {
  readonly name: string;
  readonly version?: string;
  readonly optional: boolean;
}

export interface SkillsManifest {
  readonly path: string;
  readonly scope?: ScopeName;
  readonly inheritGlobal: boolean;
  readonly registry?: string;
  readonly skills: readonly SkillSelection[];
  readonly sets: readonly SetSelection[];
  readonly packs: readonly PackSelection[];
  readonly exclude: readonly string[];
}

export interface ScopeLocation {
  readonly scope: ScopeName;
  readonly root: string;
  readonly path: string;
  readonly exists: boolean;
}

export interface ScopeDiscovery {
  readonly global: ScopeLocation;
  readonly project?: ScopeLocation;
  readonly writeScopes: readonly ScopeName[];
}

export interface DiscoveryOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly project?: string;
  readonly scope?: WriteScope;
}

export interface RegistryOptions {
  readonly registryRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly cwd?: string;
  readonly registry?: string;
  readonly installedRoot?: string;
}

export interface RegistrySelection {
  readonly root: string;
  readonly source: "argument" | "environment" | "cache" | "checkout" | "installed" | "fallback";
  readonly searched: readonly string[];
}

export interface ResolveOptions extends DiscoveryOptions {
  readonly registryRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly installedRoot?: string;
}

export interface SkillOrigin {
  readonly scope: ScopeName;
  readonly manifest: string;
  readonly kind: "skill" | "set" | "pack" | "inherit";
  readonly reference: string;
}

export interface ResolvedBinding {
  readonly name: string;
  readonly path: string;
  readonly origins: readonly SkillOrigin[];
}

export interface ExcludedBinding {
  readonly name: string;
  readonly origins: readonly SkillOrigin[];
  readonly by: "scope" | "set";
  readonly reference: string;
}

export interface ResolvedPack {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly skillsRoot: string;
}

export interface ResolvedScope {
  readonly scope: ScopeName;
  readonly root: string;
  readonly manifest: SkillsManifest;
  readonly registry: RegistrySelection;
  readonly mode: "composed" | "pack";
  readonly pack?: ResolvedPack;
  readonly bindings: readonly ResolvedBinding[];
  readonly excluded: readonly ExcludedBinding[];
}

export interface Resolution {
  readonly scopes: readonly ResolvedScope[];
  readonly writeScopes: readonly ScopeName[];
}
