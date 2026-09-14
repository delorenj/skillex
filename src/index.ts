export { listSkills, showSkill } from "./core/catalog.js";
export type {
  ListSkillsOptions,
  SkillDetails,
  SkillListData,
  SkillMetadata,
  SkillReference,
  SkillShowData,
} from "./core/catalog-types.js";
export {
  type CatalogChange,
  type CatalogWriteOptions,
  type CatalogWriteResult,
  type CreateSkillOptions,
  createSkill,
  importSkill,
} from "./core/catalog-write.js";
export { discoverRegistry, discoverScopes } from "./core/discovery.js";
export { SkillexError } from "./core/error.js";
export { isSkillName, isVersionComponent, parseManifest, readManifest } from "./core/manifest.js";
export { resolveSelection } from "./core/resolution.js";
export {
  type Diagnostic,
  ExitCode,
  JSON_SCHEMA_VERSION,
  makeResult,
  type ResultEnvelope,
  type ResultOptions,
} from "./core/result.js";
export type {
  DiscoveryOptions,
  ExcludedBinding,
  PackSelection,
  RegistryOptions,
  RegistrySelection,
  Resolution,
  ResolvedBinding,
  ResolvedPack,
  ResolvedScope,
  ResolveOptions,
  ScopeDiscovery,
  ScopeLocation,
  ScopeName,
  SetSelection,
  SkillOrigin,
  SkillSelection,
  SkillsManifest,
  WriteScope,
} from "./core/selection.js";
export { VERSION } from "./version.js";
