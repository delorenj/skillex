export {
  type ReceiptDocument,
  type ReceiptOptions,
  type ReceiptSnapshot,
  readActivationReceipt,
  validateActivationStateLocation,
  writeActivationReceipt,
} from "./core/activation-state.js";
export {
  aliasPaths,
  GLOBAL_CLI_ALIASES,
  NEVER_TOUCH,
  PROJECT_CLI_ALIASES,
} from "./core/aliases.js";
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
export type {
  CompositionChange,
  CompositionDetails,
  CompositionMutationData,
  CompositionOptions,
  PackListData,
  PackShowData,
  SetListData,
  SetShowData,
} from "./core/composition-types.js";
export { explainSkill, inspectStatus } from "./core/diagnostics.js";
export type {
  AliasObservation,
  DiagnosticOptions,
  ExplainResult,
  PathObservation,
  ReceiptObservation,
  SkillExplanation,
  SkillObservation,
  StatusResult,
  StatusScope,
} from "./core/diagnostics-types.js";
export { discoverRegistry, discoverScopes } from "./core/discovery.js";
export { doctor } from "./core/doctor.js";
export type {
  ConfiguredLegacyWriter,
  DoctorOptions,
  DoctorResult,
  DoctorSourceInspection,
  DoctorWriterInspection,
  RunningLegacyWriter,
} from "./core/doctor-types.js";
export { SkillexError } from "./core/error.js";
export { type LockOptions, withLock } from "./core/lock.js";
export { isSkillName, isVersionComponent, parseManifest, readManifest } from "./core/manifest.js";
export {
  addPackSkills,
  createPack,
  listPacks,
  removePackSkills,
  showPack,
  verifyPack,
} from "./core/packs.js";
export { planSync, sync } from "./core/reconciliation.js";
export type {
  SyncChange,
  SyncOptions,
  SyncPlan,
  SyncResult,
  SyncScopePlan,
} from "./core/reconciliation-types.js";
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
export type {
  SelectionChange,
  SelectionKind,
  SelectionOptions,
  SelectionResult,
} from "./core/selection-command-types.js";
export {
  disableSelection,
  enableSelection,
  initScope,
  setInheritance,
} from "./core/selection-commands.js";
export {
  readSelectionManifest,
  type SelectionManifestSnapshot,
  SelectionManifestWriteError,
  writeSelectionManifest,
} from "./core/selection-manifest.js";
export { addSetSkills, createSet, listSets, removeSetSkills, showSet } from "./core/sets.js";
export { inspectVendorStatus, listVendorSources, showVendorSource } from "./core/vendor-inspect.js";
export { syncVendorSources } from "./core/vendor-sync.js";
export type {
  VendorChange,
  VendorCheckout,
  VendorOptions,
  VendorProvenance,
  VendorProvenanceInput,
  VendorSkillStatus,
  VendorSource,
  VendorSourceListResult,
  VendorSourceResolution,
  VendorSourceShowResult,
  VendorSourceSkill,
  VendorSourcesManifest,
  VendorStatusResult,
  VendorSyncOptions,
  VendorSyncResult,
} from "./core/vendor-types.js";
export { VERSION } from "./version.js";
