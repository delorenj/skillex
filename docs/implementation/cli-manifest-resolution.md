# SKRILL-11: Canonical manifest resolution

Implemented 2026-09-14 for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-11](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9).

The shared Node core resolves global and project selections offline. It validates
the shipped manifest schema, returns canonical paths with contribution history,
and reports unsupported legacy fields with migration actions. Resolution changes
no catalog content, manifests, activation links, or state.

## Public API

```ts
import { resolveSelection } from "@delorenj/skillex";

const result = await resolveSelection({
  cwd: "/workspace/project/src",
  scope: "project",
  registryRoot: "/workspace/skillex",
});
```

`resolveSelection` returns a schema 2 result envelope. Successful data includes
`scopes` and `writeScopes`: project-only targeting can include global resolution
data for inheritance while selecting only the project for a later write. Each
resolved scope contains its manifest, selected registry and search candidates,
composition mode, canonical bindings, exclusions, and optional pack identity.
Every binding retains its skill/set/pack/inheritance contributions.

`discoverScopes`, `discoverRegistry`, `parseManifest`, `readManifest`, name
validators, and their public types are also exported. These lower-level helpers
throw `SkillexError` with an exit code and structured findings; the top-level
resolver converts failures to an envelope and does not print or exit.

## Resolution behavior

- Composed selections apply global inheritance, ordered sets, direct skills,
  then scope exclusions. Same-name references to the same canonical path retain
  every origin. Different canonical paths for one name fail explicitly.
- Canonical skill directories and their `SKILL.md` must be real catalog entries.
  Set links must resolve to the same-named definition in that selected catalog.
  Real definitions anywhere in a selected composition are refused.
- One selected pack replaces inheritance, sets, direct skills, and exclusions.
  Dormant declarations remain in the normalized manifest. Pack membership comes
  from `pack.toml`; verification of its generated `skills/` links belongs to
  SKRILL-13 and must precede whole-root activation in SKRILL-14.
- Missing required references fail. Optional missing sets or members remain
  visible as `W_OPTIONAL_SKIPPED`, with exit 4 and usable partial data. A missing
  optional pack has no resolved pack and never activates dormant selections or
  a partial loadout. Structural/topology errors remain failures when optional.
- The schema accepts empty, inherited-only, and exclusion-only manifests. It
  rejects unknown fields, external source overrides, payload/slot policies,
  multiple active packs, unsafe names, and per-member pack filters.
- Discovery respects the nearest manifest and nested Git boundaries, including
  worktree `.git` files. Explicit project paths select that exact manifest.
  A project with inheritance disabled or an exclusive pack does not need a
  readable global manifest unless global is also a requested write scope.
- Registry precedence is explicit argument, exclusive environment override,
  the scope manifest's existing local cache, invocation checkout, installed
  checkout, then the conventional home checkout. Invalid explicit roots never
  fall through. Relative roots retain their invocation-directory meaning for
  both scopes. A bare npm installation is not mistaken for a catalog.

## Acceptance evidence

Fixture suites cover manifest validation, discovery, composition and provenance,
inheritance and exclusions, optional references, pack restoration, semantic
version selection, strict source ownership, conflicting catalogs, and explicit
registry precedence. Resolver fixtures assert unchanged bytes, modes, timestamps,
directories, and links after every invocation.

The npm tarball suite imports and invokes the installed core with Python and uv
unavailable, loads its packaged schema, checks missing catalog discovery, and
typechecks a separate consumer without relying on repository dev dependencies.
All 175 Node tests pass on both Node 24.15.0 and 26.5.0. The combined
`mise run check` validates both implementations.
The retained Python suite passes 890 tests; five existing BMAD fixture-dependent
tests remain skipped. Ruff and mypy pass, with 42 Python source files checked.

The [hosted matrix](https://github.com/delorenj/skillex/actions/runs/34830026509)
passed all four Linux/macOS and Node 24/26 jobs for landed commit `d4c605a`.

SKRILL-12 adds catalog commands next. Scope mutation, reconciliation, installed
consumer cutover, and Python retirement remain open in the epic.
