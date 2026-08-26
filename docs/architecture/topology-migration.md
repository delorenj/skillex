# Single-Source Topology Migration

This is the execution companion to
[ADR-0001](ADR-0001-reference-only-skill-topology.md). The checker is the live
authority; the counts below are the baseline captured on 2026-08-26.

## Baseline

| Area | Legacy state | Required state |
| --- | ---: | --- |
| `all-skills/` skill-bearing links | 26 | 0 |
| Real skill definitions under `skill-sets/` | 27 | 0 |
| Real skill definitions under `packs/` | 73 | 0 |
| Dangling Kurzgesagt pack references | 2 | 0 |
| Project CLI roots that are real directories | 4 | 0 |

The Hermes 0.18.2 payload accounts for all 73 pack-owned definitions. Seventy-one
names are absent from the canonical catalog. `computer-use` and `design-md`
collide with existing canonical names and require semantic reconciliation before
either version is selected.

Run the live audit with:

```bash
uv run skillex topology check --root .
uv run skillex topology check --root . --sources-only --json
```

`mise run topology:check` is intentionally available but not yet part of
`mise run check`: the guard must remain strict while the recorded debt is
removed, and the normal quality suite must remain usable during that migration.

## Migration Order

### 1. Stabilize the canonical repository

- Land or separate existing work in the `all-skills` repository before bulk
  imports.
- For each of the 26 linked catalog entries, select one canonical name, import
  the real definition, and retire aliases that duplicate the same skill.
- Re-run the checker after each bounded import batch.

### 2. Convert Hermes to a reference-only pack

- Import the 71 missing leaf skills into `all-skills/` with upstream provenance.
- Reconcile `computer-use` and `design-md`; do not overwrite either definition
  merely because its name matches.
- Replace the 18 container declarations with the final flat set of 73 canonical
  names.
- Record the canonical catalog Git revision needed to reproduce the pack.
- Delete the 0.18.2 copied payload, `flatten` policy, and payload checksum logic.

### 3. Convert skill sets

- Move each of the 27 real definitions to `all-skills/` or reconcile it with the
  canonical definition already there.
- Replace the set member with a relative directory symlink to the canonical
  entry.
- Preserve set metadata, but never a set-owned `SKILL.md`.

### 4. Converge activation roots

- Choose whole-root alias mode or composed projection mode independently for
  global and project scopes.
- Make every active CLI `skills/` path a directory-level alias to the scope's
  `.agents/skills` root.
- Ensure only the reconciler writes a composed projection.

### 5. Retire legacy runtime behavior

- Remove self-contained pack payload discovery, recursive flattening, sealing,
  and checksum verification.
- Reject external direct-skill activation sources; import them into the
  canonical catalog first.
- Add `topology:check` to `mise check` and CI only when the live report has zero
  errors.

## Completion Gates

- `uv run skillex topology check --root .` exits zero.
- `find packs skill-sets -type f -name SKILL.md` prints nothing.
- Every skill-bearing entry in `all-skills/` is a real directory.
- Every active CLI root resolves to the correct scope `.agents/skills` root.
- The unit, lint, and typecheck suites remain green.
