# SKRILL-15: Scope selection commands

Implemented for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-15](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a3480478-25a3-4e26-a869-ba8e8a2cbb21).

Selection commands edit one `.agents/skills.json` and immediately reconcile
that scope. They reuse the canonical resolver, activation planner, receipts,
and ownership lock described in [reconciliation](cli-reconciliation.md).

```sh
skillex init --scope global
skillex init --project /workspace/example
skillex enable skill example --scope global
skillex enable set development --project /workspace/example --dry-run --json
skillex disable skill example --project /workspace/example
skillex inherit off --project /workspace/example
skillex enable pack tooling@1.0.0 --project /workspace/example
skillex disable pack tooling --project /workspace/example
```

## Target selection

`enable` and `disable` default to the nearest existing project manifest,
otherwise the global manifest. `--scope global|project` selects one scope;
`--project PATH` explicitly selects a project. Combining `--scope global` with
`--project` is an argument error. A missing selected manifest receives an
actionable `init` diagnostic. Narrowing writes to a project retains its global
inheritance.

`init` retains an existing manifest without overwriting its selections or
reformatting its bytes. For a new manifest it uses the nearest project manifest
or Git root, otherwise global. An explicit project directory need not contain
Git metadata, but must exist. New projects inherit global skills by default.
Initialization creates the declaration; it does not create activation links.

`inherit on|off` always changes a project, discovered from the nearest manifest
or selected with `--project`. It does not modify the global declaration.

## Selection behavior

Enabling a skill adds its direct canonical reference and removes a matching
scope exclusion. Disabling a skill removes its direct entry and records a
scope-local exclusion, including for inherited or set-provided skills. Shared
sets and global declarations retain their original content.

Enabling a set retains an already selected set's filters and optional flag.
Disabling a set removes that declaration. Removing a broken reference does not
require its missing source to become available first; the resulting selection
must still resolve completely before it can be saved and applied.
Required references retained in shared sets or the inherited global declaration
are validated before scope exclusions; an exclusion does not hide a broken
retained source.

Enabling a pack replaces the active pack selection and retains ordinary skills,
sets, inheritance, and exclusions as dormant state. Disabling the selected pack
restores those settings. Skill, set, and inheritance edits are refused while a
pack is active, with an action to disable it first. An unversioned pack name can
disable its current pin; an explicit different name or version cannot silently
remove the active selection.

An already satisfied selection still reconciles activation drift. Declaration
idempotency does not prevent repair of a missing owned link or alias.

## Preflight and saved intent

The proposed manifest is validated and resolved in memory. A complete activation
plan is checked before writing the manifest. Execution repeats the read, edit,
and preflight under the same activation lock, publishes the complete manifest
atomically, then reconciles from saved disk intent. No caller-supplied stale
plan is accepted as write authority. If another writer substitutes a different
selection before activation reads the saved manifest, execution reports the
intervening edit and preserves the current declaration for explicit recovery.

`--dry-run` combines manifest, activation, alias, and receipt changes in one
preview and writes no files. Validation and collision failures preserve the
manifest bytes and activation contents. Existing file modes are retained;
symlinked manifests or unsafe destination parents require explicit correction.

If execution fails after intent is saved, the result reports that saved state
and completed operations. It does not claim rollback. Correct the reported
problem and rerun `sync` to finish the saved selection. Ctrl-C uses the same
safe cancellation boundaries and exit 130 as sync.

## Shared API and validation

The package exports `initScope`, `enableSelection`, `disableSelection`, and
`setInheritance`. Their result includes the selected scope, manifest path,
proposed manifest, declaration-change and saved-intent flags, and combined
planned/applied operations. CLI formatting remains outside the core.

Node 24.15.0 and 26.5.0 each pass 505 tests, with one filesystem-owner test
skipped because it requires root. C06 adds 18 public selection API cases,
24 manifest I/O cases, 27 installed CLI cases, and two state-location checks.
The isolated package's TypeScript consumer exercises the new exported API;
Biome and TypeScript checks pass.

Fixtures cover inherited masking and re-enable, pack restoration, nested and
explicit targeting, immutable previews/refusals, and immediate drift repair.
Concurrent edits preserve the union of saved selections. Failure injection
proves prepublication preservation, saved-intent reporting after cancellation
or activation collision, and refusal of an intervening manifest edit. Rerunning
sync converges from the current saved declaration. A real installed child
process returns exit 130 when interrupted while waiting for the activation lock.

Manifest tests verify semantic no-ops without byte or inode churn, exact
snapshot checks, mode preservation, exclusive creation, atomic replacement,
and preservation of foreign files and parents. Permission fixtures distinguish
failures before publication from durability failures after publication.

The retained Python reference passes 890 tests with five missing-pack fixture
skips, plus Ruff and mypy. The implementation commit and hosted Node 24/26
Linux/macOS CI are recorded on the ticket. All mutation tests use isolated
scope roots; live migration and consumer cutover remain later epic stories.
