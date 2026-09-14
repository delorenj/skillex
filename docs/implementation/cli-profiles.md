# SKRILL-8: Hermes profile projection

Implemented for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-8](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/04fa44fa-7312-4d91-8e80-5506f22082d4).

```sh
skillex profile list
skillex profile show example-pm
skillex profile show example-pm --project /workspace/example --json
skillex profile sync example-pm --project /workspace/example --dry-run --json
skillex profile sync example-pm --project /workspace/example
skillex profile --hermes-root /srv/hermes show example-pm
```

The profile name is explicit. `sync` also requires `--project PATH`; the current
working directory never silently chooses a project for a profile. `show` uses an
explicit project or the project already recorded for that profile. Without
either, it reports observed entries and ownership without inventing a desired
selection. Read commands and dry-run do not create directories, locks, receipts,
or recovery files.

## Discovery

`--hermes-root` selects a Hermes installation explicitly. Otherwise discovery
uses `HERMES_HOME` or `~/.hermes`. An environment value ending in
`profiles/<name>` identifies that installation's parent root before symlinks
are resolved. An empty environment value falls back to the default; an empty
explicit argument is invalid. The sticky Hermes `active_profile` does not
override the requested name.

The default profile is the installation root. Named profiles live below
`profiles/` and use Hermes's lowercase alphanumeric, hyphen, and underscore name
contract. Listing and inspection read directory entries and projection state,
without loading profile configuration, credentials, or conversation files.

A profile directory may itself be a symlink to a real runtime directory.
Discovery preserves its visible path and canonical target; mutation rechecks
the identities of both. A whole `skills/` symlink requires explicit migration.
Ordinary profile sync preserves it and reports a refusal instead of writing
through it into a shared directory.

Listing retains healthy profiles and the unsupported root's metadata while
returning `E_PROFILE_SKILLS_ROOT` with exit 3. A broken named profile directory
also produces a per-profile finding without hiding the successfully discovered
profiles.

## Selection and local precedence

Profiles combine two independently resolved selections: global first, then the
explicit project. Each selection retains its manifest's sets, skills, pack,
inheritance, and exclusion semantics. The resulting union supplies profile
children. Project inheritance being off does not remove the independently
selected global contribution. Likewise, a project exclusion removes only that
project's contribution; a name still selected globally remains in the union.
Pack membership becomes individual child links in a profile's real directory.
This uses the manifest's canonical members directly; it does not depend on the
generated pack `skills/` links used for ordinary whole-root pack activation.

Repeated references to the same canonical target collapse. A canonical name
resolving to different catalog targets fails preflight. Reported candidates
include their declaration origins and winning scope.

Existing profile-owned directories, files, and symlinks win collisions. Even an
unrecorded link already pointing at the requested catalog skill remains local;
its destination alone never authorizes adoption. Runtime overlays and other
profile files remain untouched. The plan reports these preserved entries and
identifies which selected names they override.

## Ownership and recovery

Sync keeps an existing real `skills/` directory and its inode. If it is missing,
sync can create a real directory. Skillex creates links only for resolved names
that are not locally overridden. It records those children in profile-specific
XDG state outside repositories, separate from ordinary scope activation state.
Profiles sharing one canonical target share one ownership lock.
The receipt path is `$XDG_STATE_HOME/skillex/profiles/v2/<hash>.json`, keyed by
the canonical profile skills path rather than its visible name or alias.

The final read, plan, and write occur under that lock. Ownership depends on exact
recorded child identities. Stale matching links may be pruned after additions
and replacements. If a recorded child has become local content, sync preserves
the entry and relinquishes its old claim. It never removes foreign children or
replaces the profile's entire skills root. A replaced root invalidates the old
receipt and requires inspection before further mutation.

Receipts track the associated project, source revisions, root identity, child
claims, and interrupted child operations. Recovery validates each recorded
identity before acting on it. Read-only inspection reports pending recovery;
an explicit sync resumes it. A pending preview exposes only recovery, with
`managed: null`, until recovery can determine the next complete plan. Partial
execution is reported as partial, and an interruption exits 130. A no-op sync leaves receipt bytes unchanged.

An unrecognized staging entry is preserved and reported by its exact path with
exit 4. Its name alone cannot authorize cleanup. That partial result persists
until the entry is explicitly accounted for; a retry cannot silently hide it.

## Public API and acceptance

The npm package exports `listProfiles(options)`, `showProfile(name, options)`,
and `syncProfile(name, options)`. `ProfileSyncOptions` requires `project` at the
type boundary. Results use the common schema-2 envelope; CLI formatting is a
separate layer. Projection data exposes candidates and their winning origin,
preserved entries, proposed changes, pending recovery, and the actual applied
prefix for sync.

Read commands return exit 6 when a resolved projection has pending changes.
Unassociated metadata inspection and converged profiles return 0. Complete
sync previews return 0; pending recovery and incomplete selection return 4.
Invalid configuration, refused invariants, lock contention, and interruption
retain the shared exit meanings.

Local acceptance on 2026-09-14:

- Node 24.15.0 and Node 26.5.0: all 68 new profile checks pass, including 30
  discovery cases, 20 core cases, and 18 installed CLI cases.
- The complete Node suite passes 744 tests with one existing UID-dependent skip
  on each version. Biome, TypeScript, and the package build pass.
- The isolated npm artifact includes public profile types and runs with
  Python/uv unavailable. Tests include actual SIGINT, process termination after
  parking and before journal publication, concurrent aliases, local entries
  arriving during publication, stale ownership, and immutable previews.
- Retained Python lint and typing pass; its characterization suite passes 890
  tests with five existing missing-pack skips.
- Read-only inspection of the installed Hermes 0.20.5 profile layout finds all
  39 visible profiles: 13 real skills directories and 26 whole-root skills
  symlinks. The latter produce exit 3 with per-profile findings while retaining
  the healthy rows. No live profile content was changed.

The Node package workflow runs the complete suite on Node 24 and 26 on Ubuntu
and macOS. The ticket records the successful workflow for the landed commit.
Live profile migration and rollout remain part of SKRILL-18 and SKRILL-20.

Publication rechecks exact identities under the shared Skillex lock. As with
scope reconciliation, portable rename cannot eliminate the final check/rename
window for a nonparticipating process; detected conflicts are preserved and
reported, not represented as transaction-wide rollback.
