# SKRILL-18: Explicit legacy migration

Tooling for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-18](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/f29575b7-2222-471a-a336-19b14cf15821).
Catalog conversion and live consumer rollout are separate acceptance steps;
this document does not claim that the installed Python launcher has been retired.

```sh
skillex migrate --registry-root /workspace/skillex --json
skillex migrate --registry-root /workspace/skillex --mapping choices.json --apply
skillex migrate --scope global --json
skillex migrate --project /workspace/example --json
skillex migrate --profile example-pm --project /workspace/example --json
```

`migrate` previews by default. `--apply` executes ready items. With no target
selector it converts the selected registry only; it never infers an activation
scope from the working directory. `--scope global` selects the user's scope,
and `--project PATH` selects one project explicitly. Named Hermes migration
requires its associated project; `--hermes-root` selects the installation.

The typed package exports `migrate(options)`, `MigrationOptions`,
`MigrationMapping`, `MigrationItem`, and `MigrationResult`. Implementation
sections remain private. The common schema-2 envelope reports each item,
dependencies, before/after digests, blocked choices, actual applied IDs, and
verification receipt paths. An error following a published prefix returns
partial application; interruption retains exit 130. A partial result never
claims that the whole operation rolled back.

## Catalog and compositions

Migration inventories canonical definitions, embedded definitions, linked
external collections, set members, and legacy pack containers. Real catalog
definitions remain authoritative. Imports publish and verify before their
composition references change. Identical authored payloads reuse one canonical
definition; distinct provenance remains in the migration receipt. Differing
payloads receive source-qualified names, with explicit mappings for ambiguous
cases. Skill support files and executable modes remain part of the inventory.

Sets become real collections of canonical links. Hidden legacy containers such
as `.system` expand into explicit members. Pack containers expand once into
canonical manifest membership and generated `skills/` links. Pack-level support
assets and useful provenance remain pack-owned; slots and copied-payload policy
are retired with the item evidence. Unknown fields, missing content, unsafe
links, and unsupported topology keep the affected item intact and blocked.

Wrapper skills at a set root require explicit ownership of their support paths.
Relative routes must still work from the new canonical location; migration
reports routes that would break rather than declaring a blind copy verified.
Linked versioned pack families are refused before traversing an external
ancestor for mutation.

## Authored choices

`--mapping PATH` reads a version 1 JSON object. Paths are registry-relative or
explicit absolute source paths. It supports:

- `names`: source path to canonical name.
- `references`: exact old reference path to canonical name. `null` explicitly
  retires a composition reference; it never authorizes deletion of a real
  definition or an activation entry.
- `digests`: expected complete migration-inventory hashes for source paths.
- `packs`: old pack path to an explicitly authored name and version.
- `wrappers`: set path to a canonical wrapper name and its `ownedPaths`, including
  `SKILL.md`.
- `manifests`: exact legacy manifest path to a complete current-schema selection
  when the old selection cannot be translated without choosing new behavior.

On 2026-09-14 the user explicitly chose to remove the stale Kurzgesagt
`skill-creator` member. Migration must not restore a historical variant for it.
Independent current and embedded system creator skills are preserved.

## Declarations and selections

`--sources-file PATH` selects prepared upstream declarations explicitly.
Otherwise migration can onboard `docs/vendoring/sources.toml` when the catalog
has no declaration. The same strict parser used by vendoring validates it, and
recorded upstream identities must agree. Onboarding preserves every skill byte
and existing upstream pin. An existing catalog declaration remains authoritative
and is never overwritten by a prepared fallback. No clone or fetch occurs.

Current-schema selection files remain byte-stable. Legacy external references
need exact source/name/content mappings. A legacy empty `include` meant all
members; translation preserves that meaning. Old additive packs, inherited
project packs, non-equivalent adapters, and ambiguous payload/slot settings
require an authored replacement rather than silently becoming exclusive packs.
Legacy TOML is retired only after the new JSON and migration evidence are
verified. The receipt records hashes and field decisions, not raw configuration
text. Interrupted retirement can resume without losing the verified selection.

## Activation and profile ownership

Python receipts are parsed independently of the permissive old loader. Their
version, selected root, scope, names, and nonempty targets must agree with actual
links. Pending-only empty targets cannot grant ownership. Explicit mappings and
exact observed objects determine new v2 claims; unrelated real content remains
unowned.

Whole-root links can become real containers while preserving child reachability.
CLI directory conversion handles empty and fully accounted link directories.
Unresolved local or installer directories remain in place and block that alias
with named child paths. Migration never hides installer content in an invisible
parking directory to make an alias appear successful.

Hermes conversion preserves the shared target and creates a real profile skills
directory. Only verified mapped canonical children gain projection claims;
other children retain their local precedence. Ordinary `profile sync` remains
the explicit operation that applies current global/project intent afterward.

## Recovery and state

Receipts use the existing guarded state IO under
`$XDG_STATE_HOME/skillex/migrations/v2/`, with distinct bindings for registry,
source declaration, manifest, and activation targets. State cannot be placed in
selected catalogs, projects, or imported external definitions. Global migration
allows normal `~/.local/state` while excluding activation/configuration roots.

Each section preflights without writing. Ready mutations recheck under the
existing catalog, composition, activation, or profile lock. No-op or refused
work does not acquire unnecessary locks. Exact identity/digest evidence governs
staging, publication, and cleanup. Recovery of parked activation objects runs
before newly invalid source/selection intent can strand them. Unrecorded staging
is preserved and remains visible as partial work until explicitly accounted for.

As in ordinary reconciliation, portable rename cannot eliminate the final
check/rename window against a process that does not participate in these locks.

## Verification

The focused suites cover registry conversion, manifest translation, activation
handoff, source onboarding, and the installed CLI with Python/uv absent from
PATH. They exercise immutable previews/refusals, exact content/provenance reuse,
source qualification, the explicit Kurzgesagt retirement, missing mappings,
foreign/installer preservation, alias roots, concurrent operations, post-write
I/O errors, actual SIGKILL recovery, and retry/idempotency.

Local tooling acceptance on 2026-09-14:

- Full suites on Node 24.15.0 and Node 26.5.0 each pass 842 tests with one
  existing UID-dependent skip. Biome, TypeScript, and package build pass.
- All 98 new migration checks pass, including 37 registry, 20 manifest,
  20 activation, 13 declaration, and eight installed CLI cases.
- The isolated npm package includes usable public migration types and executes
  migration with Python/uv absent from PATH.
- Retained Python lint and typing pass; 890 characterization tests pass with
  five existing missing-pack skips.

The Node package workflow checks Node 24/26 on Ubuntu/macOS. Its exact landed
commit/run and the committed catalog conversion are recorded on SKRILL-18 as
those acceptance steps complete. Active-consumer cutover remains SKRILL-20 and
Python removal remains SKRILL-21.
