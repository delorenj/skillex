# Skillex

CLI-agnostic skill package manager. Define every skill once, compose it by reference, and expose the same activation root to every agentic CLI.

**Status:** Node CLI revamp in progress. The package foundation supports help,
version, structured errors, and an importable core. Operational commands still
use the Python CLI while the remaining [CLI Revamp tickets](docs/tasks/cli-revamp-tickets.md)
implement the [accepted command surface](docs/plan/cli-revamp.md).

## Node development

Use Node 24 or newer. From this checkout:

```bash
npm ci
npm run check
node dist/cli.js --help
node dist/cli.js --version --json
```

`npm run check` runs Biome, TypeScript, the build, and tests against an isolated
installation of the npm tarball. Those tests run the executable with only Node
on its PATH and check that the catalog, activation roots, and user state stay
unchanged. `npm pack` builds a publishable `@delorenj/skillex` tarball containing
the runtime, declarations, and schemas. The npm package has no Python or uv
dependency.

The ESM core exports `makeResult`, `ExitCode`, `JSON_SCHEMA_VERSION`, `VERSION`,
and their public types. JSON output follows
[result schema 2](schemas/result.schema.json):

```json
{"schema":2,"command":"version","ok":true,"exit":0,"data":{"version":"0.1.1"},"findings":[]}
```

Process exits are 0 success, 1 execution failure, 2 configuration/arguments,
3 refusal, 4 partial result, 5 lock contention, 6 drift, and 130 interruption.
With `--json`, stdout contains one result envelope and stderr is empty. Human
output puts errors on stderr.

`mise run check` and the pre-push hook run both Node and Python checks during
the migration. `mise run build` builds the Node package; `mise run python:build`
retains the Python distribution build. `uv run skillex` continues to select the
Python implementation until the consumer cutover tickets are complete.

## Architecture

[![Skillex single-source architecture](architecture.png)](architecture.excalidraw)

The accepted ownership contract is
[ADR-0001](docs/architecture/ADR-0001-reference-only-skill-topology.md):

- `all-skills/` is the only writable skill-definition root.
- skill sets and agentpacks are reference-only compositions; packs may own
  metadata, hooks, commands, and pack-level support assets, but no `SKILL.md`.
- each scope exposes one `.agents/skills` activation root.
- CLI-specific skill roots are directory-level aliases to that activation root.

Audit the live repository without changing it:

```bash
uv run skillex topology check --root .
uv run skillex topology check --root . --sources-only --json
```

The current migration backlog is recorded in
[docs/architecture/topology-migration.md](docs/architecture/topology-migration.md).

## Vendoring external skill repositories

A skill authored in another repository can be *vendored* into `all-skills/` as
real, committed content pinned to a version, so the catalog resolves on every
machine while authoring stays where it belongs. See
[docs/VENDORING.md](docs/VENDORING.md).

```bash
uv run skillex vendor list             # declared sources and where they resolve here
uv run skillex vendor sync -n          # plan; writes nothing
uv run skillex vendor status           # verify the catalog against its own pins, offline
```

Nothing is ever cloned or fetched: sources are read from a local checkout's git
objects, and a version that is not present is a refusal carrying the `git fetch`
to run.

## Experimental: BMAD HTML Workspace Skill

This repo now includes an experimental skill scaffold at `skills/bmad-html-workspace/` for teams that want a single-file HTML "project cockpit" instead of fragmented Markdown outputs.

Start with:

- `skills/bmad-html-workspace/SKILL.md`
- `skills/bmad-html-workspace/references/app-model.md`
- `skills/bmad-html-workspace/templates/workspace.template.html`
