# Skillex

A Node CLI for defining skills once, composing them by reference, and exposing the selected skills to agentic CLIs.

## Core model

The user-confirmed definitions (2026-10-10) are:

| Term | Meaning |
| --- | --- |
| Skill root | A directory where an agent looks for skills, almost always named `skills/`. |
| Global skill root | A directory an agent automatically loads regardless of project scope. |
| Canonical skill root | Skillex's SSOT root: `~/.agents/skills/` globally; `<project>/.agents/skills/` locally. |
| Skill set | **Replaces** the canonical root with a symlink to the set's skill root. Sets are **mutually exclusive**. |
| Skill pack | **Populates** the existing root with individual skill symlinks. Packs are **composable**. |

**Sets select the root; packs add skills to it.** A ten-skill pack adds ten member
links; it does not take over the root. `all-skills/` owns the definition bytes,
not the canonical discovery root. See [AGENTS.md](AGENTS.md) for the vocabulary.

> **Implementation mismatch:** the current CLI/schema still contain reversed
> semantics: additive sets and exclusive packs. Those are defects relative to
> this model, not alternative definitions. This documentation correction does
> not repair the resolver or migrate live roots. Preview changes and do not apply
> a plan that contradicts the model. The diagram's `skill-sets/global` root alias
> agrees with set replacement; its global/project examples do not restrict which
> scope can use either operation. Older planning defaults do not override the
> user's definitions.

Known repair points (not fixed by this documentation change):

- `skills.schema.json` and `src/core/manifest.ts`: allow composable packs rather
  than restricting them to one; enforce mutually exclusive sets.
- `src/core/resolution.ts` and `src/core/reconciliation.ts`: replace additive-set
  and whole-root-pack behavior with the defined operations.
- Selection commands, migration, diagnostics, command help, and their tests:
  remove exclusive-pack/dormant-selection assumptions.

Existing manifests and live roots need an explicit migration, not an automatic
swap based only on renamed concepts. Shared-set additions, inheritance, and
collision policy are still to be specified.

## Install

Requires Node 24 or newer. The npm package contains the compiled CLI, typed ESM core, and JSON schemas. It has no Python or uv runtime dependency.

```sh
npm install --global @delorenj/skillex@0.1.1
skillex --help
```

Keep a local registry checkout with its `all-skills/` submodule initialized. Select it with `--registry-root PATH` or `PJ_SKILLS_REGISTRY_ROOT`; an explicit invalid root is an error. Resolution and reconciliation work offline.

## Select and sync skills

Selection lives in global or project `.agents/skills.json`. Intended set and
pack semantics are defined above. The current implementation also has individual
skill selections, exclusions, and project inheritance; do not mistake its legacy
exclusive-pack restrictions for the product contract.

The commands below describe the existing CLI surface, not proof that set/pack
behavior is correct. Preview mutating commands with `--dry-run` before applying.

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

`enable`, `disable`, and `inherit` save the selected scope's intent and immediately
reconcile that scope unless previewed. The current implementation adds a local
exclusion when disabling an inherited skill. Its behavior of making a pack the
entire loadout is legacy drift: packs must add member links, while sets replace
the root. Do not use that legacy behavior as an activation recipe.

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

Profiles normally combine global and project selections. A profile's generated
`config.yaml` can set `skills.inherit_global: false` to keep its loadout limited
to the explicit project selection. Ordinary `profile show` and later resyncs
honor this persistent boundary, including when the project manifest inherits
global skills. Change this setting through the profile's owning config renderer.

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

## Retire skill-operation mise tasks

Existing mise tasks for skills are obsolete. Remove them rather than updating
their package pins or introducing replacement wrappers. Invoke `skillex` directly.

```sh
skillex integrations retire-mise --project /workspace/example
skillex integrations retire-mise --project /workspace/example --apply
skillex integrations retire-mise --project /workspace/example
```

The default is a read-only preview. Removal covers detected skill-operation task
tables, their dependencies, and supported watcher/enter-hook calls. Unrelated
configuration and tool installation remain. The final preview must be empty.
Use `--file PATH` for one explicit TOML source or `-g` for global mise configs.
Unsupported inline task definitions or mixed hooks refuse instead of dropping
unrelated behavior. This command does not change skill roots or run mise.
File-task scripts and externally included config sources are not yet scanned;
inspect those separately and extend the command before claiming their retirement.

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
