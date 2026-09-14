# SKRILL-12: Catalog commands

Implemented 2026-09-14 for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-12](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/045f95d2-2d6c-4bb7-9d8e-a7045be76e24).

The Node CLI supports canonical catalog inspection, scaffolding, and local
imports. Each operation discovers the registry through the shared core and
accepts an authoritative `--registry-root PATH` override.

```sh
skillex skill list --query deploy --registry-root /workspace/skillex
skillex skill show release-guide --json --registry-root /workspace/skillex
skillex skill create release-guide --description "Prepare and verify a release." --dry-run
skillex skill import /workspace/authored/guide --name release-guide --dry-run
```

## Inspection

`skill list` and `skill show` report canonical directory names, descriptions,
metadata, provenance, and set/pack references in human or JSON output. Search
matches names and descriptions case-insensitively. A frontmatter display name
never changes the canonical identity. Existing Markdown without frontmatter is
inspectable; malformed YAML, field types, provenance, or UTF-8 receive named
diagnostics. YAML parsing does not print warnings outside the result envelope.

Pack references come from validated membership manifests, and set references
come from canonical links. Unrelated invalid compositions or catalog entries
remain visible in a partial report with exit 4 while usable data is retained.
An empty healthy catalog or a query with no matches succeeds. If every catalog
definition is invalid, listing reports the validation failure instead of an
apparently usable partial catalog.

## Creation and import

`skill create` writes a real `all-skills/<name>/SKILL.md` with YAML name and
description fields, a starter body, and a `.source.yaml` provenance record.
`skill import` copies a local directory's authored files, directory/file modes,
and portable internal support links. The original directory and definition
bytes remain intact, including any frontmatter name different from `--name`.

Import provenance records the source location, timestamp, and content digest;
an existing provenance document is preserved under `previous_provenance`.
Regular-file digests retain the Python vendor wire format, including executable
bits and excluding the root provenance receipt. Imports containing support
symlinks declare their digest-format extension explicitly.

Before any write, imports capture and validate the entire source tree, metadata,
destination, and support-link topology. Recursive source/destination layouts,
external or dangling links, directory-link cycles, and links into excluded
content are refused. VCS internals, runtime state, caches, backups, and local
environment files are excluded explicitly in the plan; authored support files
and template/reference environment files remain eligible.

Dry runs perform the same preflight and report the complete change list without
creating a destination or state. Publication reserves the name with exclusive
directory creation and uses exclusive file writes with directory-identity
checks. Existing files, links, or directories are never replaced. A filesystem
failure after publication starts reports incomplete creation and the partial
destination; it does not claim rollback or complete success.

Catalog commands author source declarations. Activation remains the job of the
later selection and reconciliation commands.

## Shared API and validation

`listSkills`, `showSkill`, `createSkill`, and `importSkill` are exported from
`@delorenj/skillex` with typed inputs and schema 2 result envelopes. JSON command
names match the CLI family and action, such as `skill import`. CLI formatting
stays outside the shared core.

Acceptance covers isolated npm installation and public declarations; human/JSON
output and global-option placement; read-only inspection and dry-run snapshots;
complete imports with executable files; source preservation; metadata and path
errors; canonical-name collisions; concurrent same-name creation; and safe
support-link handling. All 260 Node tests pass on Node 24.15.0 and 26.5.0;
Biome and TypeScript pass. Hosted CI and combined-check evidence are recorded on
the ticket.

The live catalog smoke check found the expected Skillex-related definitions and
reported existing legacy topology/manifests with exit 4. That report is a
migration finding, not evidence of a clean source topology. SKRILL-18 owns source
migration; SKRILL-20/21 own installed consumer cutover and Python retirement.
