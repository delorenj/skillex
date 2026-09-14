import { entry, matches } from "./activation-ownership.js";
import { diagnosticExit } from "./diagnostics.js";
import { SkillexError } from "./error.js";
import { checkProfileSignal, discoverProfile, discoverProfiles } from "./profile-discovery.js";
import { inspectProfile, runProfileSync } from "./profile-sync.js";
import type {
  ProfileListResult,
  ProfileOptions,
  ProfileShowResult,
  ProfileSummary,
  ProfileSyncOptions,
  ProfileSyncResult,
} from "./profile-types.js";
import { type Diagnostic, ExitCode, makeResult, type ResultEnvelope } from "./result.js";

function failure<T>(command: string, error: unknown, data: T): ResultEnvelope<T> {
  return makeResult(
    command,
    data,
    error instanceof SkillexError
      ? { exit: error.exit, findings: error.findings }
      : {
          exit: ExitCode.FAILURE,
          findings: [
            {
              code: "E_IO",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              fix: "Check the selected Hermes profile paths and their permissions, then retry.",
            },
          ],
        },
  );
}

/** List configured profiles and read-only projection observations without choosing an ambient project. */
export async function listProfiles(
  options: ProfileOptions = {},
): Promise<ResultEnvelope<ProfileListResult | null>> {
  try {
    checkProfileSignal(options);
    const discovery = await discoverProfiles(options);
    const profiles: ProfileSummary[] = [];
    const findings: Diagnostic[] = [...discovery.findings];
    const exits: ExitCode[] = discovery.findings.map((finding) =>
      finding.code === "E_PROFILE_NOT_FOUND" ? ExitCode.CONFIG : ExitCode.REFUSED,
    );
    for (const profile of discovery.profiles) {
      checkProfileSignal(options);
      const observed = await inspectProfile(profile, options);
      findings.push(...observed.findings);
      exits.push(observed.exit);
      let managed = 0;
      if (observed.state)
        for (const [name, claim] of Object.entries(observed.state.data.links))
          if (matches(await entry(`${profile.skillsRoot}/${name}`), claim)) managed++;
      profiles.push({
        profile,
        project: observed.result.project,
        receiptPath: observed.result.receiptPath,
        projection:
          observed.exit === ExitCode.REFUSED ||
          observed.exit === ExitCode.CONFIG ||
          observed.exit === ExitCode.FAILURE
            ? "invalid"
            : observed.result.pending
              ? "pending"
              : observed.state?.snapshot.document
                ? "managed"
                : "unmanaged",
        counts: {
          managed: observed.state ? managed : null,
          local: observed.result.preserved.length,
        },
      });
    }
    return makeResult(
      "profile list",
      { hermesRoot: discovery.hermesRoot, profiles },
      { findings, exit: diagnosticExit(exits, exits.includes(ExitCode.DRIFT)) },
    );
  } catch (error) {
    return failure("profile list", error, null);
  }
}

export async function showProfile(
  name: string,
  options: ProfileOptions = {},
): Promise<ResultEnvelope<ProfileShowResult | null>> {
  try {
    checkProfileSignal(options);
    const observed = await inspectProfile(await discoverProfile(name, options), options);
    return makeResult("profile show", observed.result, {
      findings: observed.findings,
      exit: observed.exit,
    });
  } catch (error) {
    return failure("profile show", error, null);
  }
}

export async function syncProfile(
  name: string,
  options: ProfileSyncOptions,
): Promise<ResultEnvelope<ProfileSyncResult | null>> {
  return runProfileSync(name, options ?? ({} as ProfileSyncOptions));
}
