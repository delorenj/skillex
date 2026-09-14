import { realpath, stat } from "node:fs/promises";
import { diagnosticExit } from "./diagnostics.js";
import { discoverRegistry } from "./discovery.js";
import { fail } from "./error.js";
import { migrateActivation, recoverActivationMigration } from "./migration-activation.js";
import {
  checkMigrationSignal,
  migrationFailure,
  normalizeMigrationOptions,
} from "./migration-common.js";
import { migrateManifest } from "./migration-manifest.js";
import { migrateRegistry } from "./migration-registry.js";
import { migrateSources } from "./migration-sources.js";
import type {
  MigrationOptions,
  MigrationResult,
  MigrationSectionResult,
} from "./migration-types.js";
import { discoverProfile } from "./profile-discovery.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";

/** Explicit, resumable conversion. No target scope is inferred from the caller's directory. */
export async function migrate(
  input: MigrationOptions = {},
): Promise<ResultEnvelope<MigrationResult | null>> {
  let data: MigrationResult | null = null;
  const findings: Diagnostic[] = [];
  const exits: ExitCode[] = [];
  try {
    // Recover recorded filesystem work before parsing newly changed selection choices.
    const { mapping: _mapping, ...locationOptions } = input ?? {};
    let options = normalizeMigrationOptions(locationOptions);
    checkMigrationSignal(options);
    const targets: string[] = [];
    if (options.project !== undefined) {
      let selected: string;
      try {
        selected = await realpath(options.project);
      } catch {
        fail("E_MIGRATION_CONFIG", "The explicit project does not exist.", {
          path: options.project,
          fix: "Select an existing project directory.",
        });
      }
      if (!(await stat(selected)).isDirectory())
        fail("E_MIGRATION_CONFIG", "The explicit project must be a directory.", { path: selected });
      targets.push(selected);
    } else if (options.scope === "global") targets.push(options.home as string);
    if (options.profile !== undefined) {
      const profile = await discoverProfile(options.profile, options);
      targets.push(profile.skillsRoot);
    }
    data = {
      registry: null,
      apply: options.apply === true,
      targets,
      items: [],
      applied: [],
      receipts: [],
    };
    const add = (section: ResultEnvelope<MigrationSectionResult | null>): boolean => {
      findings.push(...section.findings);
      exits.push(section.exit);
      if (data && section.data)
        data = {
          ...data,
          items: [...data.items, ...section.data.items],
          applied: [...data.applied, ...section.data.applied],
          receipts: [...new Set([...data.receipts, ...section.data.receipts])],
        };
      return (
        section.exit !== ExitCode.INTERRUPTED &&
        section.exit !== ExitCode.LOCK_BUSY &&
        section.data !== null
      );
    };
    const result = () => {
      let exit = diagnosticExit(exits);
      if (data?.applied.length && exit !== ExitCode.SUCCESS && exit !== ExitCode.INTERRUPTED)
        exit = ExitCode.PARTIAL;
      return makeResult("migrate", data, { exit, findings });
    };
    if (options.apply && (options.scope !== undefined || options.project !== undefined)) {
      const recovery = await recoverActivationMigration(options);
      if (!add(recovery) || recovery.exit !== ExitCode.SUCCESS) return result();
    }
    options = normalizeMigrationOptions(input);
    const registry = await discoverRegistry(options);
    data = { ...data, registry, targets: [registry.root, ...targets] };
    if (options.apply) {
      const preview = await migrate({ ...options, apply: false, registryRoot: registry.root });
      const unsafeState = preview.findings.some(
        (finding) =>
          finding.code.startsWith("E_RECEIPT_") ||
          finding.code === "E_LOCK_STATE" ||
          finding.code === "E_MIGRATION_RECEIPT" ||
          finding.code === "E_MIGRATION_STATE",
      );
      if (unsafeState) {
        add(preview);
        return result();
      }
    }
    if (!add(await migrateSources({ ...options, registryRoot: registry.root }))) return result();
    checkMigrationSignal(options);
    const sources = await migrateRegistry({ ...options, registryRoot: registry.root });
    if (!add(sources)) return result();
    checkMigrationSignal(options);
    if (options.scope !== undefined || options.project !== undefined) {
      const manifests = await migrateManifest(
        { ...options, registryRoot: registry.root },
        sources.data?.nameMap,
      );
      if (!add(manifests)) return result();
      // A refused selection cannot authorize a different activation target or desired loadout.
      if (options.apply && manifests.exit !== ExitCode.SUCCESS) return result();
      checkMigrationSignal(options);
      add(await migrateActivation({ ...options, registryRoot: registry.root }));
    }
    return result();
  } catch (error) {
    const failure = migrationFailure("migrate", error, data);
    return makeResult("migrate", data, {
      exit:
        data?.applied.length && failure.exit !== ExitCode.INTERRUPTED
          ? ExitCode.PARTIAL
          : failure.exit,
      findings: [...findings, ...failure.findings],
    });
  }
}
