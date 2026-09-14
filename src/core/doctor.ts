import { diagnosticExit, inspectStatus } from "./diagnostics.js";
import { discoverRegistry, discoverScopes } from "./discovery.js";
import { inspectDoctorSources } from "./doctor-sources.js";
import type { DoctorOptions, DoctorResult, DoctorSourceInspection } from "./doctor-types.js";
import { inspectDoctorWriters } from "./doctor-writers.js";
import { SkillexError } from "./error.js";
import { readManifest } from "./manifest.js";
import { resolveSelection } from "./resolution.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";

/** Aggregate source and activation observations without locks, repair, or network access. */
export async function doctor(options: DoctorOptions = {}): Promise<ResultEnvelope<DoctorResult>> {
  const findings: Diagnostic[] = [];
  const exits: ExitCode[] = [];
  const sources: DoctorSourceInspection[] = [];
  const registries = new Map<string, RegistrySelection>();
  const sourcesOnly = options.sourcesOnly ?? false;
  let status: DoctorResult["status"] = null;
  let writers: DoctorResult["writers"] = null;
  const capture = (error: unknown) => {
    if (error instanceof SkillexError) {
      findings.push(...error.findings);
      exits.push(error.exit);
    } else {
      findings.push({
        code: "E_IO",
        severity: "error",
        message: "A doctor observation failed.",
        detail: [error instanceof Error ? error.message : String(error)],
        fix: "Check readable source and configuration paths, then retry doctor.",
      });
      exits.push(ExitCode.FAILURE);
    }
  };
  const interrupted = () => {
    if (!options.signal?.aborted) return false;
    if (!exits.includes(ExitCode.INTERRUPTED))
      findings.push({
        code: "E_INTERRUPTED",
        severity: "error",
        message: "Doctor was interrupted before all observations completed.",
        fix: "Rerun doctor to collect a complete read-only audit.",
      });
    exits.push(ExitCode.INTERRUPTED);
    return true;
  };
  if (!interrupted() && sourcesOnly) {
    try {
      const resolved = await resolveSelection(options);
      findings.push(...resolved.findings);
      exits.push(resolved.exit);
      for (const scope of resolved.data?.scopes ?? [])
        registries.set(scope.registry.root, scope.registry);
      if (!registries.size) {
        // Selection failures must not suppress a source audit. Recover only
        // valid declared registry identities; never inspect activation state.
        const locations = await discoverScopes(options);
        const candidates = [
          locations.global,
          ...(locations.project ? [locations.project] : []),
        ].filter((location) => locations.writeScopes.includes(location.scope));
        for (const location of candidates) {
          if (!location.exists) continue;
          try {
            const manifest = await readManifest(location.path);
            const selected = await discoverRegistry({
              ...options,
              ...(manifest.registry !== undefined ? { registry: manifest.registry } : {}),
            });
            registries.set(selected.root, selected);
          } catch {
            /* The selected declaration's blocker is already retained above. */
          }
        }
      }
    } catch (error) {
      capture(error);
    }
  }
  if (!interrupted() && !sourcesOnly) {
    try {
      const inspected = await inspectStatus(options);
      status = inspected.data;
      findings.push(...inspected.findings);
      exits.push(inspected.exit);
      for (const scope of status?.resolution?.scopes ?? [])
        registries.set(scope.registry.root, scope.registry);
      if (!registries.size) {
        // Failed resolution can still leave valid source declarations available.
        // Reading those does not require activation or receipt health.
        for (const scope of status?.scopes ?? []) {
          try {
            const manifest = await readManifest(scope.manifestPath);
            const selected = await discoverRegistry({
              ...options,
              ...(manifest.registry !== undefined ? { registry: manifest.registry } : {}),
            });
            registries.set(selected.root, selected);
          } catch {
            /* Status retains this scope's configuration/resolution blocker. */
          }
        }
      }
    } catch (error) {
      capture(error);
    }
  }
  if (!interrupted() && !registries.size) {
    try {
      const selected = await discoverRegistry(options);
      registries.set(selected.root, selected);
    } catch (error) {
      capture(error);
    }
  }
  for (const registry of registries.values()) {
    if (interrupted()) break;
    try {
      const inspected = await inspectDoctorSources(registry);
      sources.push(inspected.data);
      findings.push(...inspected.findings);
      exits.push(...inspected.exits);
    } catch (error) {
      capture(error);
    }
  }
  if (!sourcesOnly && !interrupted()) {
    try {
      const inspected = await inspectDoctorWriters(
        options,
        [...registries.values()],
        status?.scopes ?? [],
      );
      writers = inspected.data;
      findings.push(...inspected.findings);
      exits.push(...inspected.exits);
    } catch (error) {
      capture(error);
    }
  }
  const unique = [
    ...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values(),
  ].sort((a, b) =>
    `${a.path ?? ""}\0${a.code}\0${a.message}`.localeCompare(
      `${b.path ?? ""}\0${b.code}\0${b.message}`,
    ),
  );
  return makeResult(
    "doctor",
    { sourcesOnly, sources, status, writers },
    {
      findings: unique,
      exit: diagnosticExit(exits, exits.includes(ExitCode.DRIFT)),
    },
  );
}
