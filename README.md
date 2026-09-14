# Skillex

A Node CLI for defining skills once, composing them by reference, and exposing the selected skills to agentic CLIs.

## Install

Requires Node 24 or newer. The npm package contains the compiled CLI, typed ESM core, and JSON schemas. It has no Python or uv runtime dependency.

```sh
npm install --global @delorenj/skillex@0.1.1
skillex --help
```

Keep a local registry checkout with its `all-skills/` submodule initialized. Select it with `--registry-root PATH` or `PJ_SKILLS_REGISTRY_ROOT`; an explicit invalid root is an error. Resolution and reconciliation work offline.

## Select and sync skills

A global or project `.agents/skills.json` declares skills, sets, an optional exclusive pack, and exclusions. Projects inherit global selections by default.

```sh
skillex init --scope global
skillex enable set global --scope global
skillex init --scope project --project /workspace/example
skillex enable skill code-reviewer --scope project --project /workspace/example
skillex sync --scope project --project /workspace/example --dry-run
skillex sync --scope project --project /workspace/example
skillex status --project /workspace/example
skillex explain code-reviewer --project /workspace/example
```

`enable`, `disable`, and `inherit` save the selected scope's intent and immediately reconcile that scope. Disabling an inherited skill adds a local exclusion. A pack supplies the entire loadout; disabling it restores the retained ordinary selection.

Plain `sync` reconciles global plus the nearest project, or global alone outside a project. `--scope project --project PATH` restricts writes to that project while still resolving inheritance. Existing foreign files and installer-owned content are preserved. Only recorded owned links can be pruned.

## Manage the catalog

```sh
skillex skill list --query review
skillex skill show code-reviewer
skillex skill create my-workflow
skillex skill import /workspace/authored-skill --name my-import
skillex set list
skillex pack list
skillex pack verify hermes-base@0.18.2
skillex doctor --sources-only
```

`all-skills/` owns real definitions. Sets and packs contain canonical references; packs may also own hooks, commands, and support assets. Ordinary CLI skill roots alias one `.agents/skills` activation root. Catalog and composition edits take effect for a consumer when that consumer explicitly syncs.

Vendoring reads committed trees from available local upstream checkouts, preserves source pins and executable modes, and never clones or fetches implicitly. Use `vendor list`, `vendor show`, `vendor status`, and `vendor sync`; see the [vendoring contract](docs/implementation/cli-vendoring.md).

Hermes profiles keep real skill directories and their own content. Project targeting is explicit:

```sh
skillex profile list
skillex profile show example-pm
skillex profile sync example-pm --project /workspace/example --dry-run
skillex profile sync example-pm --project /workspace/example
```

## Migrate an existing installation

Preview the registry and each target before applying their migration. The migration result lists content choices, changed objects, and verification receipts. Missing mappings and unresolved local content remain visible as blocked items.

```sh
skillex migrate --registry-root /workspace/skillex --json
skillex migrate --registry-root /workspace/skillex --mapping choices.json --apply
skillex migrate --scope global --json
skillex migrate --scope global --apply
skillex migrate --project /workspace/example --json
skillex migrate --project /workspace/example --apply
```

Do not run the Python and Node reconcilers against the same target. The [migration contract](docs/implementation/cli-migration.md) covers legacy references, explicit choices, ownership handoff, interruption recovery, and profile conversion. The [CLI Revamp delivery record](docs/tasks/cli-revamp-tickets.md) tracks the remaining template and consumer cutover work; installing the package alone does not migrate consumers.

## Automation and development

Use `--json` for a schema-2 envelope with `schema`, `command`, `ok`, `exit`, `data`, and `findings`. Diagnostic output does not contaminate JSON stdout. Mutating commands support `--dry-run`; `migrate` previews by default and requires `--apply`. `sync --dry-run --exit-code` returns 6 for drift.

Exit codes: 0 success, 1 execution failure, 2 invalid configuration or arguments, 3 refusal, 4 partial application, 5 lock contention, 6 drift, and 130 interruption. Receipts and locks live in XDG state outside the source repositories.

```sh
npm ci
npm run check
npm pack
node dist/cli.js --help
```

Checks cover the installed npm package, Node 24/26, Linux/macOS behavior, offline resolution, content preservation, ownership, concurrency, and recovery. Python characterization checks remain in the development workflow until retirement is complete.

See the [command specification](docs/plan/cli-revamp.md), [ownership ADR](docs/architecture/ADR-0001-reference-only-skill-topology.md), and [result schema](schemas/result.schema.json). PJangler consumes the same public core exported by `@delorenj/skillex`.
