# SKRILL-17: Offline vendoring

Implemented 2026-09-14 for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-17](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/5f44fcce-d606-4723-96ca-230fb05d9132).

The Node CLI provides `vendor list`, `vendor show SOURCE`, `vendor status`, and
`vendor sync`. These commands use the selected registry's
`all-skills/sources.toml`. A missing declaration receives a corrective diagnostic;
the prepared declaration under `docs/vendoring/` is not silently selected.
SKRILL-18 owns validating and onboarding that declaration during migration.

```sh
skillex vendor list --registry-root /workspace/skillex
skillex vendor show upstream-guides --json
skillex vendor status --source upstream-guides
skillex vendor status --source upstream-guides --upstream
skillex vendor sync --source upstream-guides --checkout guides=/workspace/guides --dry-run
skillex vendor sync --source upstream-guides --checkout guides=/workspace/guides
```

## Source declarations and checkout selection

Version 1 source declarations retain ordered `[[source]]` entries with a source
name, repository identity, and Git pin. Optional fields select a checkout ID,
source subdirectory, explicit skill names or `{ name, dir }` mappings, discovery
filters, and optional-source behavior. Explicit membership and discovery filters
are separate modes. The declaration supplies the canonical skill name;
frontmatter names do not rename catalog entries.

An authored `skills = []` means an explicit empty inventory. Omit `skills` to
discover members. This deliberately removes the Python behavior that treated an
empty explicit list as a request to discover every member.

Checkout selection uses `--checkout ID=PATH`, `SKILLEX_SOURCE_<ID>`, machine-local
`$XDG_CONFIG_HOME/skillex/sources.local.toml` mappings, then
`$SKILLEX_SOURCE_ROOT/ID` or `~/code/ID`. Explicit arguments and environment
overrides do not fall through to a different checkout when invalid. Source and
checkout options can repeat; a checkout ID must be supplied only once.

`vendor list` reports declared pins and local checkout availability. `vendor show`
reports one source declaration and its catalog members; `skill show NAME`
continues to expose an individual skill's metadata and receipt.

## Offline provenance

Ordinary `vendor status` verifies catalog files and executable modes against
recorded digests without accessing upstream checkouts. `--upstream` additionally
compares recorded commits with pins available in local Git repositories. For a
source using discovery filters, an offline report covers recorded members; it
does not claim to know newly added upstream skills.

Status also reports local-edit flags, changed declared pins or source paths, and
pending vendor journals. A valid digest does not make an interrupted update
complete. Status reads recovery evidence without applying it.

Imports read the pinned commit's tree and blobs, preserving committed bytes and
executable modes. Dirty worktree edits do not affect an import. Normal commands
never clone or fetch, including implicit lazy fetching from partial clones.
Unavailable local objects require an explicit upstream preparation step.
Git must support `--no-lazy-fetch`. Branch declarations remain usable and produce
an advisory; each receipt records the exact commit selected by that invocation.
Symlinks, Git submodules, unsafe source paths, and invalid skill metadata are
refused before publication.

Receipts retain upstream source, repository, requested pin, commit, tree, source
path, extraction time, and the Python-compatible content digest. The digest
covers file bytes and executable modes and excludes the root `.source.yaml`
receipt. Verification includes authored files that the separate local-import
command would filter; absence of a baseline digest is not evidence of unchanged
content.

## Publication and explicit destructive choices

`vendor sync` preflights selected sources and stages complete skill trees before
replacing catalog content. Catalog creation, local imports, and vendor sync
share a lock on the canonical `all-skills` directory. Final inspection and
publication occur while holding that lock. Runtime lock and journal state stay
in XDG state outside source repositories.

Selected source definitions and checkout mappings are checked again before the
first replacement. Changes to that intent abort publication; a retry resolves
the new declarations. Comment-only declaration edits do not alter intent.

An unmanaged real catalog directory requires `--adopt`. If its contents differ
from the pinned upstream tree, adoption also requires `--discard-local-edits`.
Managed local edits require `--discard-local-edits` before replacement. Catalog
symlinks require migration rather than ordinary vendor adoption.

`--prune` removes only positively attributed, unedited members absent from a
selected source that was successfully enumerated. An unavailable optional source
is a visible skip, not an empty inventory authorizing deletion. Other sources,
compositions, scope manifests, activation roots, and aliases are outside vendor
sync's write surface. Composition relinking belongs to `migrate`.

Dry-run performs inspection without locks, staging, publication, or recovery
writes. Interrupted publication keeps recovery evidence, reports incomplete work,
and requires reconciliation on a subsequent explicit sync. It never claims a
transaction-wide rollback that did not happen.

Recovery validates every recorded destination and recovery tree before changing
them. Edited staged or parked content blocks cleanup and remains intact. Old
content can be restored from the journal even if the upstream checkout has since
disappeared. A crash during staging can leave a directory without complete
ownership evidence; recovery preserves it, reports its path and an inspection
action, and returns a partial result. A nonparticipating writer racing the final
absence check and directory rename is outside the shared-lock guarantee.

## Shared API and validation

`listVendorSources`, `showVendorSource`, `inspectVendorStatus`, and
`syncVendorSources` are exported from `@delorenj/skillex` with public TypeScript
types and schema 2 result envelopes. CLI rendering stays outside the core.
Expected exits retain the shared contract: configuration 2, refusal 3,
partial/optional skip 4, lock contention 5, drift 6, and interruption 130.

Validation includes installed-package CLI behavior without Python/uv, committed
Git objects versus dirty worktrees, status with no checkout or Git executable,
source/receipt validation, mode and byte drift, explicit adoption/discard/prune,
shared catalog locking, immutable previews, injected journal and publication
failures, edited recovery content, and a real process kill after parking old
content. The suite also checks that an intent change during staging leaves all
old destinations intact and that a retry resolves the current declarations.

The full Node suite passes 676 tests with one root-UID-specific skip on Node
24.15.0 and 26.5.0. Biome and TypeScript pass. Required Python regressions pass
890 tests with five existing missing-pack skips; Ruff and mypy pass. Exact-commit
hosted CI evidence is attached to the ticket after the Linux/macOS matrix passes.

A live read-only `vendor list --registry-root /home/delorenj/code/skillex --json`
returns the expected `E_SOURCES_MANIFEST_MISSING` configuration failure. No
declaration, catalog content, or consumer activation was changed by that check.
The package remains alongside Python until SKRILL-20 installs it and switches
active consumers; SKRILL-21 owns Python retirement.
