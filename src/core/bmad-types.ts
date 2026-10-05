import type { CatalogLockOptions } from "./catalog-lock.js";
import type { RegistryOptions, RegistrySelection } from "./selection.js";

/** Freeze operates only on real local directories; registry URLs are never fetched. */
export interface BmadFreezeOptions extends RegistryOptions, CatalogLockOptions {
  readonly version?: string;
  readonly dryRun?: boolean;
  readonly replace?: boolean;
  readonly commands?: boolean;
}

export interface BmadSourceModule {
  readonly name: string;
  readonly version: string;
  readonly source: string | null;
  readonly repoUrl: string | null;
  readonly sha: string | null;
}

export interface BmadSourceInstallation {
  readonly version: string;
  readonly installDate: string | null;
  readonly lastUpdated: string | null;
}

/** Evidence captured offline from the source install's own manifests. */
export interface BmadProvenance {
  readonly sourceRoot: string;
  readonly installation: BmadSourceInstallation;
  readonly modules: readonly BmadSourceModule[];
  readonly skillManifestSha256: string | null;
  readonly filesManifestSha256: string | null;
  readonly filesManifestDeclared: number;
  readonly filesManifestMissing: number;
}

export type BmadInventoryStatus = "imported" | "unchanged" | "skipped" | "failed";

export interface BmadSkillInventory {
  readonly name: string;
  readonly sourcePath: string;
  readonly status: BmadInventoryStatus;
  readonly digest: string | null;
  readonly recordedDigest: string | null;
}

/** Skills installed by the source but outside the frozen manifest, inventoried separately. */
export interface BmadForeignSkill {
  readonly name: string;
  readonly path: string;
}

export interface BmadSkillManifestEntry {
  readonly canonicalId: string;
  readonly name: string;
  readonly description: string | null;
  readonly module: string | null;
  readonly path: string | null;
}

export interface BmadCommandClient {
  readonly client: string;
  readonly layout: string;
  readonly directory: string;
  readonly imported: number;
  readonly dangling: number;
}

export interface BmadCommandFile {
  readonly name: string;
  readonly client: string;
  readonly layout: string;
  readonly path: string;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly bmadRefs: readonly string[];
  readonly danglingRefs: readonly string[];
}

export interface BmadCommandInventory {
  readonly clients: readonly BmadCommandClient[];
  readonly files: readonly BmadCommandFile[];
}

export interface BmadFreezeChange {
  readonly action: string;
  readonly path: string;
  readonly source?: string;
}

export interface BmadFreezeData {
  readonly registry: RegistrySelection;
  readonly pack: { readonly name: string; readonly version: string; readonly path: string };
  readonly provenance: BmadProvenance;
  readonly sourceRoot: string;
  readonly dryRun: boolean;
  readonly skills: readonly BmadSkillInventory[];
  readonly foreignSkills: readonly BmadForeignSkill[];
  readonly skillsDeclared: number;
  readonly skillsImported: number;
  readonly skillsUnchanged: number;
  readonly skillsSkipped: number;
  readonly skillsFailed: number;
  readonly commands: BmadCommandInventory;
  readonly commandFiles: number;
  readonly danglingCommands: number;
  readonly changes: readonly BmadFreezeChange[];
}

export interface BmadStatusOptions extends RegistryOptions {
  readonly signal?: { readonly aborted: boolean };
}

export type BmadCanonicalState = "ok" | "missing" | "foreign" | "modified";

export interface BmadCanonicalStatus {
  readonly name: string;
  readonly path: string;
  readonly state: BmadCanonicalState;
  readonly digest: string | null;
  readonly recordedDigest: string | null;
  readonly references: readonly string[];
  readonly provenance: Readonly<Record<string, unknown>> | null;
}

export interface BmadStatusData {
  readonly registry: RegistrySelection;
  readonly skills: readonly BmadCanonicalStatus[];
  readonly traced: number;
  readonly drifted: readonly string[];
  readonly untraced: readonly string[];
  readonly pack: string | null;
  readonly packMembers: readonly string[];
  readonly packVerified: boolean | null;
  readonly findings: readonly import("./result.js").Diagnostic[];
}

export interface BmadExplainOptions extends RegistryOptions {
  readonly signal?: { readonly aborted: boolean };
}

export interface BmadReference {
  readonly kind: "pack" | "set" | "skill";
  readonly name: string;
  readonly version?: string;
}

export interface BmadSkillExplanation {
  readonly name: string;
  readonly canonicalPath: string | null;
  readonly digest: string | null;
  readonly recordedDigest: string | null;
  readonly modifiedLocally: boolean | null;
  readonly bmadVersion: string | null;
  readonly references: readonly BmadReference[];
  readonly findings: readonly import("./result.js").Diagnostic[];
}

export interface BmadExplainData {
  readonly registry: RegistrySelection;
  readonly skill: BmadSkillExplanation;
}
