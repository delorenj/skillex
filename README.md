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

The Node implementation enforces this model. Older installed packages and the
retained Python migration reference may still implement the reversed semantics;
never run both writers on the same root. Existing manifests and foreign roots
need an explicit previewed migration, not a silent reinterpretation.

Adding a pack to a shared set-backed root derives a scope-owned set and switches
only that scope. The shared set and its other consumers remain unchanged. A
project set overrides Skillex's inherited global selection, but agent clients
also discover global skills independently: client isolation requires a supported
adapter and runtime verification, not merely `inherit_global: false`.

## Install

Requires Node 24 or newer. The npm package contains the compiled CLI, typed ESM core, and JSON schemas. It has no Python or uv runtime dependency.

```sh
npm install --global @delorenj/skillex
skillex --help
```

Keep a local registry checkout with its `all-skills/` submodule initialized. Select it with `--registry-root PATH` or `PJ_SKILLS_REGISTRY_ROOT`; an explicit invalid root is an error. Resolution and reconciliation work offline.

## Select and sync skills

Selection lives in global or project `.agents/skills.json`. Select at most one
set, any number of distinct packs, and residual individual skills. Use `-g` on
selection commands for global scope, or `--project PATH` for one project. Preview
mutating commands before applying; foreign content requires explicit adoption.

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

`enable`, `disable`, and `inherit` save and reconcile one scope unless previewed.
`enable set NAME` switches its root, while `enable pack NAME@VERSION` adds that
pack without discarding other packs. `pack add REF MEMBERS...` edits pack
membership, not manifest selection. Exclusions and additions on a set-backed root
use a scope-owned derivation rather than modifying the shared set.

Plain `sync` reconciles global plus the nearest project, or global alone outside a project. `--scope project --project PATH` restricts writes to that project while still resolving inheritance. Existing foreign files and installer-owned content are preserved. Only recorded owned links can be pruned.

## Repeatable integration repairs

```sh
# Compose references from a root, individual skill paths, or explicit Git sources.
skillex set create project-base --from-root /workspace/skills --dry-run
skillex pack create project-tools --version 1.0.0 --from /workspace/skill-a --from https://example.org/team/skills.git --import --dry-run

# Preview normalization; --base-set is required for ambiguous legacy multi-set declarations.
skillex normalize --project /workspace/example
skillex normalize --project /workspace/example --apply
skillex normalize -g --base-set min-global --dry-run

# Explicit ownership cutover preserves original roots when mapping entries.
skillex root adopt --project /workspace/example --map old-name=new-name --dry-run

# Project-set override for OpenCode V2; verify with a dedicated existing session.
skillex clients isolate --client opencode --project /workspace/example
skillex clients verify --client opencode --project /workspace/example --session ses_probe --agent build
```

Source creation refuses differing same-name content and never silently skips
requested unknown skills. `--import` explicitly authorizes missing definitions
through the canonical importer; Git acquisition records a commit and never runs
source code. Normalization replaces exact groups with references without widening
membership. Root adoption and client isolation preview by default; apply with
`--apply`, then repeat the preview to prove convergence.

OpenCode isolation preserves unrelated configuration and uses owned permission
rules. Conflicting user rules require an explicit decision; other clients are not
certified by this adapter. `clients unisolate` removes only owned rules. Verification
checks canonical paths and actual permissions, not merely the raw registered list.

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
