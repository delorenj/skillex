import type { DiagnosticOptions, StatusResult } from "./diagnostics-types.js";
import type { RegistrySelection } from "./selection.js";

export interface DoctorOptions extends DiagnosticOptions {
  readonly sourcesOnly?: boolean;
  /** Supply the text of `ps -axo pid=,args=` for an isolated observation. */
  readonly processSnapshot?: () => Promise<string>;
}

export interface DoctorSourceInspection {
  readonly registry: RegistrySelection;
  readonly canonicalSkills: number;
  readonly sets: number;
  readonly packs: number;
  readonly provenance: number;
  readonly digestsChecked: number;
}

export interface ConfiguredLegacyWriter {
  readonly kind: "mise" | "service";
  readonly path: string;
  readonly line: number;
  readonly command: string;
}

export interface RunningLegacyWriter {
  readonly pid: number;
  readonly command: string;
  readonly entrypoint: string;
}

export interface DoctorWriterInspection {
  readonly configured: readonly ConfiguredLegacyWriter[];
  readonly running: readonly RunningLegacyWriter[];
  readonly processObservation: "complete" | "unknown";
}

export interface DoctorResult {
  readonly sourcesOnly: boolean;
  readonly sources: readonly DoctorSourceInspection[];
  readonly status: StatusResult | null;
  readonly writers: DoctorWriterInspection | null;
}
