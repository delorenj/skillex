# BMAD Freeze

`skillex bmad freeze` imports the rendered BMAD skills and per-client command assets of
a BMAD-enabled project into the canonical catalog and publishes them as a **versioned,
reference-only registry pack** (`packs/bmad/<version>/`), per
[ADR-0001](architecture/ADR-0001-reference-only-skill-topology.md).

> Status: machinery + isolated verification (SKRILL-26), followed by the reviewed
> live registration of `6.12.1-next.0` into the canonical catalog and the bmad pack
> family. Native-skill activation is additive; see **Delivery** below.

## Delivery

The `6.12.1-next.0` release is registered as:

- **Versioned reference-only pack** `packs/bmad/6.12.1-next.0/` — canonical
  bodies imported into `all-skills/<name>/` with `.source.yaml` receipts;
  `skills/<name>` are reference-only symlinks; `commands/<client>/` are
  byte-for-byte legacy command copies.
- **Additive reference set** `sets/bmad-6.12.1-next.0/` — exactly the pack's
  declared membership as canonical links; enabling the set is an explicit,
  reviewed selection step.

Registration ran through the **built CLI from the repository working tree**
(for example `node dist/cli.js bmad freeze …`) because the installed `skillex`
on `PATH` (0.1.3) does not expose the `bmad` command group; the installed
package itself is unchanged. The workflow is: repeat `--dry-run` until the plan
is understood, apply once, repeat to confirm idempotency (all skills
`unchanged`), then `pack verify bmad@<version>`.

What activation does and does not mean:

- **Native skill exposure**: frozen skills are ordinary canonical skills once
  registered, so they load through every supported native-skills alias root
  (`.claude/skills`, `.codex/skills`, `.gemini/skills`, …) and per-profile
  projections, like any catalog skill. Discovery from an agent session is via
  the `bmad-help` skill or listing/inspecting a skill by name — that is
  *discovery*, not proof of execution.
- **Workflow execution is runtime-dependent**: most frozen skills (46/47 at
  this release) reference `{project-root}/_bmad` assets (see
  [Runtime prerequisites](#runtime-prerequisites-not-carried-by-the-pack)).
  They are not self-contained; a consuming project must restore the matching
  `_bmad` tree. Do not describe them as self-contained or "runnable"
  independent of a BMAD-enabled project.
- **Legacy commands are copied, not activated**: the per-client command files
  under `packs/bmad/<version>/commands/` are preserved byte-for-byte for
  provenance (including dangling references). No global command writer or
  per-client command activation is performed, and no shim implementation is
  provided.
- **Client coverage is verified only where tested**: clients whose layout the
  scanner covers are listed in `[source].commands`. Client not seen in that
  inventory are *unverified*, not "unsupported" — e.g. a project `.zcode/skills`
  directory is already a supported native-skills root and needs no special
  handling here.
- **No persona activation**: registration exposes skills, not agent personas;
  persona-style agents are not instantiated by the pack or the set.

## What a freeze does

1. **Reads the source install's own manifests** — `_bmad/_config/manifest.yaml`
   (installation version + module matrix), `skill-manifest.csv` (membership source of
   truth), and `files-manifest.csv` (integrity inventory, counted missing). Everything
   is offline; nothing is fetched.
2. **Imports rendered skill bytes into `all-skills/<name>/`** — the only complete
   bytes are the rendered `.agents/skills/bmad-*` directories; the source `_bmad` tree
   is typically pruned. Each imported skill gets a `.source.yaml` receipt recording the
   BMAD installation version, content digest, manifest SHA-256s, and module pins.
3. **Publishes `packs/bmad/<version>/`** with:
   - `pack.toml` — membership (`[freeform].skills`), `[source]` provenance (version,
     module matrix, manifest hashes, per-client command inventory, `_bmad`
     prerequisites).
   - `skills/<name>` — **reference-only symlinks** into `all-skills/`. There is never a
     real `SKILL.md` under `packs/` (ADR-0001 invariant 2; topology check stays green).
   - `commands/<client>/<file>` — per-client command assets copied **byte-for-byte**
     under their original layouts (`.claude/commands`, `.codex/prompts`,
     `.opencode/command`, `.opencode/commands`, `.crush/commands`, `.gemini/commands`,
     `.qwen/commands`, `.augment/commands`).

## Usage

```bash
# Plan without writing
skillex bmad freeze /path/to/bmad-enabled-repo --dry-run --json

# Freeze (version defaults to the source installation.version)
skillex bmad freeze /path/to/bmad-enabled-repo --registry-root /path/to/registry

# Traceability
skillex bmad status --registry-root /path/to/registry --json
skillex bmad explain bmad-prd --registry-root /path/to/registry --json
skillex pack verify bmad@6.12.1-next.0 --registry-root /path/to/registry
```

Bounded options: `--version <v>` (explicit pack version override; names the pack
directory only — `[source].bmad_version` always records the actual
`installation.version`, exactly like every per-skill receipt, so the pack verifies
green against its own canonical baselines),
`--dry-run`, `--replace` (explicit version switch), `--no-commands`,
`--state-home <path>`, `--timeout-ms <ms>`, plus global `--registry-root`/`--json`.

## Guarantees

- **Idempotent**: re-freezing the same source version changes nothing (all skills
  report `unchanged`; only the pack manifest is republished with identical content).
  This holds for a `--no-commands` repeat too: the republished manifest keeps the
  prior `[source].commands` inventory (it never falsely re-declares zero captured
  commands), and drops to an empty inventory only when the recorded command files
  are no longer present on disk.
- **Preflight, all-or-nothing**: every destination conflict (canonical bodies,
  pack family/version/manifest/skills-root, per-client command copies, replace
  staging artifacts, retirement archive) is detected in the plan phase **before
  any write**. A refusal — in `--dry-run` or apply — leaves the registry exactly
  as it was; there are no half-imported trees or orphaned stamped receipts.
- **Guarded replace**: a freeze never overwrites foreign content. A differing
  canonical body without BMAD freeze provenance is refused
  (`E_BMAD_FOREIGN_COLLISION`). A version switch requires `--replace`, and
  `--replace` gates on the **recorded baseline digest**: a pristine canonical
  (unmodified since its freeze) is replaced even when the new release changed
  the skill's bytes; a locally edited canonical no longer matches its recorded
  digest and is refused. Because `all-skills/` holds exactly one writable
  definition per name, **only one BMAD version is canonically resident at a
  time** — a later `--replace` is an explicit version-switch transaction, never
  an additive snapshot (ADR-0001 invariant 4: packs pin a composition, not
  bytes).
- **Pack declaration ownership**: a pre-existing `pack.toml` at the pack path
  is never rewritten on the basis of location alone. The freeze parses the
  declaration in the plan phase (so `--dry-run` reports the exact same
  refusal) and refuses with `E_BMAD_FOREIGN_COLLISION` /
  `E_BMAD_PACK_MANIFEST` when it is a directory/symlink, unreadable,
  malformed TOML, carries a foreign identity (`pack.name` / `source.type`),
  records a different pack or installation version, or was edited after the
  freeze (authored annotations, extra keys, or changed values). `--replace`
  cannot bypass a foreign identity: a version switch always publishes a NEW
  pack directory while the old one is retired to the archive. An owned,
  unmodified declaration is byte-identical on repeat and is never rewritten
  (no mtime churn). The **only** data ever republished is generated
  provenance (`[source].commands`, `[source].source_root`,
  `[pack].description`), and `[source].commands` is rewritten **only** when
  (a) every prior `[[source.commands]]` entry carries exclusively the
  generated keys (`client`, `layout`, `files`, `dangling`) with the generated
  types, **and** (b) the scanner-eligible command files on disk (real
  `bmad-*` non-`~` files only, exactly what the scanner counts) no longer
  match the declared counts. Any unknown or authored field inside the
  inventory region — an annotation, a note, a client-added key — makes the
  declaration authored content and is **refused** (`E_BMAD_FOREIGN_COLLISION`,
  bytes preserved, identical in `--dry-run` and apply), even when recorded
  command files are missing, a foreign file sits in `commands/<client>/`, or
  `--replace` is passed. User-authored metadata is never deleted to make the
  manifest truthful; documentation or tests can never authorize that sweep.
- **Retirement, not silent drift**: as part of the guarded `--replace`
  transaction, every superseded `packs/bmad/<old>/` is moved to
  `packs/.archived-bmad-<new>/`, **outside the discoverable packs tree**. Its
  `pack.toml` moves with it, so `pack verify bmad@<old>` can never silently
  green against the newer canonical: a restored stale pack is refused with
  `E_BMAD_PACK_BASELINE` (the pack's recorded `bmad_version` diverges from the
  canonical's receipt). Nothing is deleted; the archive is preserved for
  inspection and can be restored by moving it back explicitly.
- **No foreign adoption**: rendered `bmad-*` skills not declared in the source's
  `skill-manifest.csv` are inventoried separately and never imported. CLI
  activation dirs (`.claude/skills`, `.gemini/skills`, …) are never touched.
- **Crash-safe replace staging**: each replace parks the old tree under a unique
  owned name (`.skillex-bmad-<name>.<pid>.<ts>.backup`); a pre-existing
  artifact at any fixed staging path is refused, never deleted, so crash
  recovery is never destroyed.
- **Locked**: imports serialize on the shared catalog lock
  (`withCatalogLock`), reusing the existing import/vendor lock paths.
- **Dangling references are reported, not rewritten**: many legacy
  `.claude/commands` files point into the pruned `_bmad` tree (e.g.
  `{project-root}/_bmad/bmm/workflows/...`). The freeze copies them byte-for-byte and
  reports each dangling reference in `--json`; it never substitutes generated shims.
  Exposing working per-client commands requires an explicit follow-up (e.g. thin
  `@skills/bmad-*` shims derived from `skill-manifest.csv`).

## Exact limits (honest)

- The audit scope is the BMAD freeze path: canonical definitions, the bmad
  pack family, and the receipts the freeze writes. It is **not** a universal
  audit of every installed skill in a registry; non-BMAD canonical skills,
  other pack families, and sets are only inspected where bmad status needs
  their membership to ground traceability.
- `--no-commands` skips command scanning/copies on a fresh freeze. On a repeat
  it preserves the existing per-client command receipt bytes already in the
  pack; it never rewrites or deletes them.
- Command-inventory "disk reality" is counted exactly like the scanner counts
  imports: only real files starting with `bmad-` and not ending in `~` under
  `commands/<client>/`. A foreign file there (a `README.md`, an editor backup)
  is invisible to the inventory — never counted, never adopted, never deleted —
  and can never by itself license a manifest republish or an authored-note
  sweep. To change the recorded inventory legitimately, keep the declaration
  unedited (generated shape only) and let the command files themselves change;
  to keep an annotation, expect the next freeze to refuse until you remove the
  pack explicitly or restore the generated manifest.
- Multi-version coexistence of bmad packs is not supported by design: one
  resident canonical version at a time. Retired packs live in the archive, not
  alongside the resident version.
- Registry **URLs are identity-only** (below).

## Runtime prerequisites NOT carried by the pack

Several frozen skills and commands reference `{project-root}/_bmad` at runtime
(`render_skill.py`, `_bmad/_config/`, `resolve_config.py`, per-skill `customize.toml`
merges, `uv`). The pack records these prerequisites in `pack.toml [source].prerequisites`
but does **not** vendor them. A consuming project must install or restore the matching
BMAD `_bmad` tree for those skills/commands to function.

## Traceability semantics (honest limits)

- Every installed skill traces to the manifest via a set, an individual registry
  entry, a pack, or a local skillex path. `bmad status` reports each frozen canonical
  skill's baseline digest and flags drift (`W_BMAD_DRIFT`) plus undeclared pack
  children (`W_BMAD_UNDECLARED_MEMBER`) so a green `pack verify` cannot hide
  membership gaps.
- Registry **URLs are identity-only**: the manifest `registry` field maps to a
  pre-populated local cache (`~/.agents/.cache/registries/<sanitized>`); skillex never
  clones or fetches. There is no per-skill "registry entry URL" resolver — local path
  forms (`--registry-root`, `PJ_SKILLS_REGISTRY_ROOT`, checkout walk-up) are the
  supported resolution mechanisms.

## Version naming

The pack version directory defaults to the **bare** installation version string
(`6.12.1-next.0`), matching the source manifest exactly; a `v` prefix would still
parse but diverges from the recorded version and muddies `semver` ordering.
