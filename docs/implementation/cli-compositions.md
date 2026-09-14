# SKRILL-13: Set and pack commands

Implemented 2026-09-14 for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-13](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/2db60d04-477e-448a-bdd0-d04eaf3f0859).

The Node CLI manages reusable sets and versioned packs as references to
`all-skills/`. These commands edit catalog compositions; activation is handled
by the later selection and reconciliation commands.

```sh
skillex set list --registry-root /workspace/skillex
skillex set create release --dry-run
skillex set add release release-guide test-guide
skillex set show release --json
skillex set remove release test-guide

skillex pack create release --version 1.0.0 --description "Release loadout"
skillex pack add release@1.0.0 release-guide test-guide --dry-run
skillex pack show release@1.0.0 --json
skillex pack remove release@1.0.0 test-guide
skillex pack verify release@1.0.0
```

## Membership and inspection

Sets use canonical child symlinks under `sets/<name>/`. Packs use
`packs/<name>/<version>/pack.toml` as their membership authority and canonical
child symlinks under the pack's `skills/` directory. Creation requires an
explicit pack version. Existing flat packs remain readable under the shared
resolver's contract; versionless references use its version-selection rules.

Listing and inspection report names, versions where applicable, composition
paths, and canonical member paths. Pack descriptions come from the manifest.
Mixed valid and invalid inventories retain usable entries with findings and
exit 4. Verification reports missing canonical definitions, missing or wrong
member links, undeclared generated content, and embedded real `SKILL.md` files.
Link disagreement returns exit 3. Invalid declarations retain their structured
validation errors.

All new membership links point directly to matching definitions in
`all-skills/`. Existing correct relative or absolute links are retained.
Composition commands preserve pack hooks, commands, scripts, provenance, and
support assets. They never copy a real skill definition into a set or pack.

## Editing and recovery

Create, add, and remove support `--dry-run` and schema 2 JSON output. The shared
core returns the desired composition and a change list containing directory,
link, and manifest operations. Repeating an already satisfied operation returns
an empty change list. Missing generated pack links can be rebuilt from the
manifest without replacing foreign entries.

Preflight validates every requested name, canonical definition, existing
composition, and destination before taking a write lock. Read-only operations,
dry runs, valid no-ops, and preflight refusals do not initialize state. A real
edit rereads its inputs under a registry-wide composition lock and checks
directory and link identities at write boundaries.

Pack manifest changes use a complete temporary file and atomic publication,
preserving the manifest's mode and supported metadata. Desired membership is
published before generated links are changed, and new links are created before
requested old links are removed. Failures after editing starts return partial
state and exit 4. No rollback is claimed, and foreign files or conflicting links
require explicit inspection and migration.

If creation stops before publishing a new `pack.toml`, inspect and remove only
the empty partial directories before retrying. Existing directories without a
manifest are not automatically adopted. After the manifest is published,
repeating the edit repairs missing member links or finishes explicit removals.

## Locking and shared API

`withLock` is an exported core helper. Lock state lives under the selected
`XDG_STATE_HOME/skillex/locks/` directory, falling back to
`~/.local/state/skillex/locks/`. API callers may supply `stateHome` explicitly.
The default contention timeout is two seconds and returns `E_LOCK_BUSY` with
exit 5 without invoking the action.

Each invocation publishes a unique claim with an immutable ordering ticket.
Only a proven-dead local process permits recovery. Live processes, permission
denials, foreign hosts, and malformed or unrelated state are never treated as
stale based on elapsed time. The lock requires coherent local filesystem
directory operations; it is not a distributed lease.

`listSets`, `showSet`, `createSet`, `addSetSkills`, `removeSetSkills`, `listPacks`,
`showPack`, `createPack`, `addPackSkills`, `removePackSkills`, and `verifyPack`
are exported from `@delorenj/skillex` with typed options and result data. CLI
formatting remains separate from filesystem behavior.

## Validation

All 352 Node tests pass on Node 24.15.0 and 26.5.0, including 41 installed
composition CLI cases, 35 set/pack core cases, and 16 lock cases. Biome and
TypeScript pass. Acceptance covers reference-only topology, support-asset and
provenance preservation, complete dry-run snapshots, idempotency, version
selection, verification findings, concurrent edits, and injected filesystem
failures before and after manifest publication. Real child processes verify
mutual exclusion, bounded contention, dead-owner recovery, and preservation of
live or foreign lock state.

CLI regression coverage distinguishes `pack create --version VERSION` from the
installed package version and retains shared-flag placement and argument
validation. Hosted CI and combined-check evidence are recorded on the ticket.
