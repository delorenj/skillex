---
workflowType: 'analyze-source'
stepsCompleted: ['step-01-init', 'step-02-scan-project', 'step-03-identify-units', 'step-04-map-and-detect', 'step-05-recommend', 'step-06-generate-briefs']
lastStep: 'step-06-generate-briefs'
nextWorkflow: 'create-skill (briefs are detailed enough); brief-skill if scope refinement desired; create-stack-skill after individual skills exist'
confirmed_units:
  - 'skillex-core'
  - 'skillex-adapters'
  - 'skillex-core-activator'
stack_skill_candidates:
  - { name: 'skillex-stack', members: ['skillex-core', 'skillex-adapters', 'skillex-commands'], flagged_for_create_stack_skill: true, reason: 'orchestration via cli.py + commands/pack.py' }
lastContinued: ''
date: '2026-04-26'
user_name: 'Jarad DeLorenzo'
project_name: 'skillex'
project_paths: ['/home/delorenj/code/skillex']
forge_tier: 'Deep'
existing_skills: []
confirmed_units: []
stack_skill_candidates: []
scope_excludes: ['all-skills/', '_bmad/']
nextWorkflow: ''
---

# Source Analysis Report: skillex

## Project Scan

**Project:** `/home/delorenj/code/skillex`
**Forge Tier:** Deep
**Scope Excludes:** `all-skills/`, `_bmad/`, `forge-data/`, `.claude/`, `.agents/`, `.augment/`, `.gemini/`, `.github/`, `.opencode/`, `_skf-learn/`, `skills/`, plus standard exclusions (`__pycache__`, `.venv`, `dist`, `build`, `.git`)

### Structure Overview

```
/home/delorenj/code/skillex/
├── src/skillex/              # Single Python package (1,892 LOC)
│   ├── __init__.py           # version export
│   ├── cli.py                # Typer entrypoint
│   ├── logging.py            # structlog config
│   ├── paths.py              # path resolution helpers
│   ├── core/                 # Domain layer
│   │   ├── models.py         # Pydantic models (Skill, Pack, LinkOp, etc.)
│   │   ├── loader.py         # Config/pack/skill loading + error hierarchy
│   │   ├── linter.py         # Validation rules
│   │   ├── activator.py      # LinkOp plan/apply with rollback
│   │   ├── registry.py       # Slot type validation
│   │   └── file_lock.py      # Process-safe file lock
│   ├── commands/             # Typer subcommands (init, pack, skill, slot, status)
│   └── adapters/             # CLI-specific renderers (base, claude, codex, opencode)
├── tests/                    # unit/ + integration/
├── docs/                     # PRD + plan + tasks (markdown)
├── packs/                    # Example packs (33god-dev, google-agent-skills, Kurzgesagt)
├── skill-sets/               # Global skill sets
├── scripts/                  # Utility scripts
├── pyproject.toml            # Project manifest (strict mypy + ruff + hatchling)
├── uv.lock                   # uv lockfile
└── mise.toml                 # Task runner
```

### Detected Boundaries

| Path | Type | Confidence | Detection Signals |
|------|------|-----------|-------------------|
| `src/skillex` | package | strong | pyproject.toml, hatchling target, `[project.scripts] skillex = "skillex.cli:app"` |
| `src/skillex/core` | module (domain) | strong | independent class cluster, no Typer/CLI imports, dependency boundary respected |
| `src/skillex/commands` | module (CLI surface) | strong | dedicated Typer subcommand registration pattern (`register(app)`) |
| `src/skillex/adapters` | module (extension point) | strong | `Adapter(Protocol)` + registry + 3 concrete impls, classic plugin pattern |

### Manifests

| Path | Type | Language |
|------|------|----------|
| `pyproject.toml` | project manifest | Python 3.12, hatchling, strict mypy, ruff |
| `uv.lock` | lockfile | uv |

### Entry Points

| Path | Type |
|------|------|
| `src/skillex/cli.py` | Typer app (`skillex` console script) |
| `src/skillex/__init__.py` | package init |
| `src/skillex/{core,commands,adapters}/__init__.py` | sub-package inits |

### Service Configurations

| Path | Type |
|------|------|
| `mise.toml` | Task runner / toolchain pinning |

### Deep-Tier Class Inventory (ast-grep + grep verified)

| Module | Classes |
|--------|---------|
| `core/models.py` | `SkillFrontmatter`, `Skill`, `SlotAssignment`, `PackManifest`, `Pack`, `CliAdapterConfig`, `ScopeConfig`, `SkillexConfig`, `LinkOp` (9 Pydantic models) |
| `core/loader.py` | `LoaderError`, `ConfigError`, `PackError`, `SkillError`, `DuplicateSkillError`, `SkillReferenceError` (6 exception types) |
| `core/linter.py` | `Severity`, `RuleCode`, `LintIssue` |
| `core/activator.py` | `ActivationError`, `_Snapshot` |
| `core/file_lock.py` | `LockBusyError`, `FileLock` |
| `adapters/base.py` | `Adapter` (Protocol) |
| `adapters/{claude,codex,opencode}.py` | `ClaudeAdapter`, `CodexAdapter`, `OpenCodeAdapter` |

### Observations

- **Single Python package.** No multi-service split. Skill candidates are sub-modules, not services.
- **Strict typing.** mypy strict mode + Pydantic v2 + Protocol-based adapter contract → high-fidelity AST extraction expected.
- **Classic plugin pattern.** `adapters/` is a textbook Adapter Protocol + registry. Strong skill candidate.
- **Domain layer is self-contained.** `core/` holds models, loader, linter, activator, registry, file_lock with no upward imports → can be skilled independently of the CLI.
- **CLI surface is mechanical.** `commands/*` follows uniform `register(app)` Typer pattern → either skill the pattern itself or fold into a single CLI skill.
- **Entry-point surface is thin.** `cli.py` is 42 lines of pure registration; not a skill candidate on its own.

## Identified Units

### Qualifying Units

| # | Unit Name | Path | Boundary Type | Scope Type | Signals (S/M/W) | Confidence | Status | LOC | Language |
|---|-----------|------|---------------|------------|------------------|------------|--------|-----|----------|
| 1 | `skillex` | `src/skillex/` | Package | full-library | 5 / 3 / 0 | high | new | 1,892 | Python 3.12 |
| 2 | `skillex-core` | `src/skillex/core/` | Module | specific-modules | 1 / 4 / 1 | high | new | 964 | Python 3.12 |
| 3 | `skillex-adapters` | `src/skillex/adapters/` | Module | public-api | 1 / 3 / 1 | high | new | 138 | Python 3.12 |
| 4 | `skillex-commands` | `src/skillex/commands/` | Module | specific-modules | 0 / 4 / 1 | medium | new | 487 | Python 3.12 |
| 5 | `skillex-core-activator` | `src/skillex/core/activator.py` | Module (file-scoped) | specific-modules | 0 / 3 / 0 | medium-high | new | 222 | Python 3.12 |

### Signal Detail per Unit

**Unit 1: `skillex` (whole package)**
- Strong: `pyproject.toml` (independent manifest), `src/skillex/cli.py` (separate entry point), `[project.scripts] skillex = "skillex.cli:app"` (console script export), `from skillex import` public API surface, `[tool.hatch.build.targets.wheel] packages = ["src/skillex"]` (build target)
- Moderate: `tests/` separate test suite, `README.md` present, `mise.toml` task runner reference

**Unit 2: `skillex-core` (domain layer)**
- Strong: distinct export surface (`from skillex.core.models import ...` consumed by every module above)
- Moderate: top-level subdirectory boundary, dedicated test files (`test_models`, `test_loader`, `test_linter`, `test_activator`, `test_registry`, `test_file_lock`), no upward imports into commands/adapters (clean DI boundary), dependency cluster (Pydantic + structlog only)
- Weak: import clustering (intra-module imports dominant)

**Unit 3: `skillex-adapters` (Adapter Protocol + registrations)**
- Strong: `Adapter(Protocol)` formal interface contract + `_REGISTRY` + `register_adapter`/`get_adapter`/`all_adapters` exported API
- Moderate: `test_adapters.py` dedicated tests, top-level subdirectory boundary, classic plugin pattern signature (Protocol + registry + N implementations)
- Weak: import clustering between base.py and the three impls

**Unit 4: `skillex-commands` (Typer subcommand surface)**
- Moderate: top-level subdirectory boundary, uniform `register(app: typer.Typer) -> None` pattern across all 5 files, `cli.py` registers them in sequence, dedicated tests via integration suite, ruff per-file-ignores carve out `B008` for Typer idiomatic args
- Weak: import clustering with `core/`

**Unit 5: `skillex-core-activator` (plan/apply with rollback)**
- Moderate: 222 LOC of self-contained plan-then-apply algorithm with `_Snapshot`, `_rollback`, `ActivationError`, `_skillex_owned_links_in`, `_unlink_if_symlink` helpers; expressed as functions on top of LinkOp models; the most algorithmically interesting piece in the codebase
- Independent skill candidate because the plan/apply/rollback pattern is reusable beyond skillex (any reversible filesystem mutation tool would benefit)

### Disqualified Candidates

| Path | Reason |
|------|--------|
| `src/skillex/cli.py` | Too small (42 LOC, pure registration) |
| `src/skillex/paths.py` | Too small (47 LOC, 4 utility functions) |
| `src/skillex/logging.py` | Too small (41 LOC, structlog config wrapper) |
| `src/skillex/core/registry.py` | Too small (35 LOC, 2 functions) |
| `src/skillex/core/file_lock.py` | Borderline (72 LOC, 2 classes); single-concept utility, fold into `skillex-core` |
| `src/skillex/core/models.py` | Substantial (150 LOC, 9 classes) but covered by `skillex-core` umbrella; standalone-skill split deferred to step-05 |
| `src/skillex/core/loader.py` | Substantial (256 LOC) but covered by `skillex-core` umbrella; standalone-skill split deferred to step-05 |
| `src/skillex/core/linter.py` | Substantial (229 LOC) but covered by `skillex-core` umbrella; standalone-skill split deferred to step-05 |
| `tests/` | Test-only |
| `docs/` | Pure documentation |
| `packs/` | Example fixture data, no production logic |
| `skill-sets/` | Data only |
| `scripts/` | Empty directory |
| `mise.toml` | Pure configuration |

### Already-Skilled Units

None.

### Stack Skill Candidates

| Candidate | Why |
|-----------|-----|
| `skillex` (whole package) | Integrates Typer + Pydantic + structlog + python-frontmatter + Adapter Protocol pattern; the umbrella skill is itself a stack-skill candidate at `full-library` scope |

### Notes

- **Granularity choice ahead.** Units 2 (`skillex-core`) and 5 (`skillex-core-activator`) overlap. If you skill core as one unit, drop 5. If you skill activator separately, narrow core's scope to "models + loader + linter + registry + file_lock". Step-05 will surface the trade-off.
- **`skillex-commands` is borderline.** The Typer `register(app)` pattern is mechanical; consider folding into `skillex` (full-library) instead of skilling separately unless you want a Typer-pattern skill specifically.
- **`skillex-adapters` is the highest-leverage standalone skill.** Adapter Protocol + registry + N concrete implementations is a reusable design template, valuable beyond this codebase.

## Export Map

**Strategy:** Full export scan (all 22 source files; well under the 50-file threshold).

### Per-Unit Export Summary

| Unit | Files | Top-Level Exports (def/class) | Pattern | API Surface |
|------|-------|-------------------------------|---------|-------------|
| `skillex` | 22 | 49 (whole package, aggregated) | nested module hierarchy | medium |
| `skillex-core` | 7 | 31 (9 models + 6 errors + 11 functions + 5 misc classes) | direct module imports, no barrel | medium |
| `skillex-adapters` | 5 | 7 (1 Protocol + 3 registry fns + 3 concrete adapters) | Protocol + registry + N implementations | small |
| `skillex-commands` | 6 | 18 (5 `register(app)` + 13 typed `@app.command` callbacks) | uniform Typer subcommand modules | medium |
| `skillex-core-activator` | 1 | 3 public (`plan`, `apply`, `ActivationError`) + 6 private helpers | functional plan/apply with snapshot rollback | small |

### Key Public Symbols (Deep-tier ast-grep verified)

**`skillex-core` (`src/skillex/core/`):**
- `models.py:20-150` — `SkillFrontmatter`, `Skill`, `SlotAssignment`, `PackManifest`, `Pack`, `CliAdapterConfig`, `ScopeConfig`, `SkillexConfig`, `LinkOp`
- `loader.py:59-228` — `load_config`, `load_skill`, `discover_skills`, `load_pack_manifest`, `load_pack`; error hierarchy: `LoaderError → {ConfigError, PackError, SkillError → {DuplicateSkillError, SkillReferenceError}}`
- `linter.py:45-202` — `lint_pack`, `lint_packs`, `has_errors`; `Severity`, `RuleCode`, `LintIssue`
- `activator.py:82-142` — `plan(cfg, pack, scopes) -> list[LinkOp]`, `apply(ops) -> None`; `ActivationError`
- `registry.py:15-24` — `is_valid_slot_type`, `explain_invalid_slot_type`, `CANONICAL_SLOT_TYPES`
- `file_lock.py:21-25` — `FileLock`, `LockBusyError`

**`skillex-adapters` (`src/skillex/adapters/`):**
- `base.py:19-54` — `Adapter(Protocol)` with `name` + `render_links(skill, scope_root, scope) -> list[LinkOp]`; `register_adapter`, `get_adapter`, `all_adapters`; `Scope = Literal["global", "project"]`
- `claude.py`, `codex.py`, `opencode.py` — three concrete `Adapter` implementations registered via module-level `register_adapter(...)` side effect

**`skillex-commands` (`src/skillex/commands/`):**
- Each module exports `register(app: typer.Typer) -> None` + 1-6 typed command callbacks
- `pack.py` is the largest (228 LOC, 8 functions): `list_cmd`, `show_cmd`, `lint_cmd`, `activate_cmd`, `deactivate_cmd`, `create_cmd`, plus `_resolve_pack` and `register`
- `init.py:77` bootstraps `skillex.toml`; `status.py:61` reports active state; `skill.py:69`/`slot.py:52` are read-only listers

## Integration Points

### Cross-Reference Matrix (intra-package import graph)

| Unit | Imports From | Imported By | External Deps |
|------|--------------|-------------|---------------|
| `skillex` (top: cli, paths, logging) | `commands.*`, `logging` | (entry point) | `typer`, `structlog` |
| `skillex-core` | `adapters.base` (via activator) | `commands.*` (heavy), `adapters.*` | `pydantic`, `python-frontmatter`, `structlog` |
| `skillex-adapters` | `core.models` | `commands.pack` (via `core.activator`), `core.activator` | (none) |
| `skillex-commands` | `core.{activator, linter, loader, models, registry}`, `paths`, `logging` | `cli.py` (registration) | `typer`, `rich` |
| `skillex-core-activator` | `adapters.base` (`Scope`, `all_adapters`), `core.file_lock`, `core.models` | `commands.pack`, `commands.status` | (none direct) |

### Integration Points

| # | Source → Target | Type | Files | Coupling |
|---|-----------------|------|-------|----------|
| 1 | `commands/pack.py` → `core.{activator, linter, loader, models}` + `logging` + `paths` | direct import (5 modules pulled together) | `pack.py:11-21` | **tight** (orchestrator) |
| 2 | `commands/{skill, slot, status}` → `core.loader` + `paths` | direct import (read-only) | `skill.py:11-12`, `slot.py:11-13`, `status.py:11-13` | moderate |
| 3 | `core.activator` → `adapters.base` | direct import (`Scope`, `all_adapters`) | `activator.py:18` | **tight, layer-inverted** |
| 4 | `adapters.{claude, codex, opencode}` → `adapters.base` | direct import (`Scope`, `register_adapter`) | each adapter line 12-17 | tight (registration) |
| 5 | `adapters.*` → `core.models` | direct import (`LinkOp`, `Skill`) | each adapter | tight (return-type contract) |
| 6 | `cli.py` → `commands.*` | mechanical registration | `cli.py:7-12` | loose |
| 7 | `commands.status.py` → `core.activator._skillex_owned_links_in` | private-name import | `status.py:11` | **tight + leaky** (private symbol crossed module boundary) |

### Stack Skill Candidates

| Candidate | Members | Detection Signal | Evidence |
|-----------|---------|------------------|----------|
| `skillex-stack` (whole tool) | `skillex-core` + `skillex-adapters` + `skillex-commands` | Orchestration layer (`cli.py` registers `commands.*`, `commands.pack` co-imports core + adapters via activator) | `cli.py:7-12`, `pack.py:11-21`, `activator.py:18` |
| `activator+adapters` (sub-stack) | `skillex-core-activator` + `skillex-adapters` | Tight functional contract (activator iterates `all_adapters()` to render LinkOps) | `activator.py:18`, `activator.py:82-142` (plan iterates registry) |

### Architectural Observations

- **Layer inversion at `core.activator → adapters.base`.** `core` is not a strict bottom layer; it depends on the `adapters` extension point to enumerate registered adapters at planning time. This is intentional (the activator needs to know all CLIs to render LinkOps), but it means `core` cannot be shipped without `adapters`. Worth surfacing in the `skillex-core` skill as a layering note.
- **Adapter side-effect registration.** Each concrete adapter registers itself at import time via module-level `register_adapter(...)`. Tests use `# noqa: F401 -- registration` imports (`test_adapters.py:9`, `test_activator.py:10`). This is a load-order contract that must be documented in any adapter skill.
- **Private-symbol leak.** `commands/status.py:11` imports `_skillex_owned_links_in` from `core.activator` (a leading-underscore name). This is technically a layering smell; the activator should expose this as a public function if commands legitimately need it. Worth flagging in the activator skill so the pattern doesn't propagate.
- **Loose CLI coupling, tight domain coupling.** `cli.py` is a thin registration shell, but `commands/pack.py` is the true orchestrator (228 LOC pulling 5 core modules together). When skilling, treat `pack.py` as the primary worked example for any "how skillex orchestrates a pack activation" narrative.
- **Pure data flow in adapters.** The three concrete adapters (`claude`, `codex`, `opencode`) only depend on `adapters.base` and `core.models`. Zero dependencies on commands/CLI/IO. This is a clean extension point — adding a 4th adapter is mechanical.

## Recommendations

### User Decisions

| ID | Recommendation | Decision | Reason |
|----|----------------|----------|--------|
| 1 | `skillex` (whole-package, standalone) | **N** | Covered by stack-skill flag; would overlap units 2/3 |
| 2 | `skillex-core` (narrowed: models + loader + linter + registry + file_lock; activator excluded) | **Y** | Self-contained domain layer with substantial export surface (31 symbols across 5 files) |
| 3 | `skillex-adapters` | **Y** | Highest-leverage standalone skill; classic Adapter Protocol + registry + 3 concrete impls; reusable beyond this codebase |
| 4 | `skillex-commands` (standalone) | **N** | Mechanical Typer pattern; folded into stack-skill instead of standalone |
| 5 | `skillex-core-activator` | **Y** | Most algorithmically interesting piece (plan/apply/rollback over filesystem mutations); generalizable pattern |
| S1 | Stack-skill: `skillex-stack` (core + adapters + commands) | **Y** | Captures orchestration story (`cli.py → commands → core + adapters`) |
| S2 | Stack-skill: `activator-and-adapters` sub-stack | **N** | Subsumed by S1 |

### Confirmed Units for Brief Generation

**Unit: `skillex-core`**
```yaml
name: skillex-core
language: python
scope:
  type: specific-modules
  include:
    - 'src/skillex/core/models.py'
    - 'src/skillex/core/loader.py'
    - 'src/skillex/core/linter.py'
    - 'src/skillex/core/registry.py'
    - 'src/skillex/core/file_lock.py'
  exclude:
    - 'src/skillex/core/activator.py'
  notes: 'Excludes activator.py — promoted to its own skill (skillex-core-activator) for the plan/apply/rollback pattern. file_lock and registry are utility helpers retained here for proximity to loader/models.'
description: "Skillex domain layer: Pydantic v2 models for Skill/Pack/LinkOp/SkillexConfig, a typed loader error hierarchy, structured lint rules with severity + RuleCode codes, slot type registry, and a process-safe file lock. Forms the bottom of the skillex stack — no upward imports into commands or CLI."
```

**Unit: `skillex-adapters`**
```yaml
name: skillex-adapters
language: python
scope:
  type: public-api
  include:
    - 'src/skillex/adapters/base.py'
    - 'src/skillex/adapters/claude.py'
    - 'src/skillex/adapters/codex.py'
    - 'src/skillex/adapters/opencode.py'
description: "CLI-specific renderer adapters for skillex. Defines an Adapter Protocol (name + render_links → list[LinkOp]), a module-level _REGISTRY, and three concrete implementations for Claude Code, Codex, and OpenCode. Each adapter registers itself via side effect at import time. Zero dependencies on commands/CLI/IO layers."
```

**Unit: `skillex-core-activator`**
```yaml
name: skillex-core-activator
language: python
scope:
  type: specific-modules
  include:
    - 'src/skillex/core/activator.py'
  notes: 'Single-file skill scoped to the plan/apply/rollback algorithm. Public surface: plan(), apply(), ActivationError. Depends on adapters.base (registry enumeration) + core.file_lock + core.models — not standalone, but conceptually distinct from the rest of core.'
description: "Filesystem mutation engine for skillex: plan() computes a LinkOp diff for activating a Pack across one or more CLI scopes; apply() executes ops with per-op snapshot capture and rolls back on any failure. Reusable pattern for any reversible-mutation tool (migration runners, IaC executors, package linkers)."
```

### Stack-Skill Flags

**S1: `skillex-stack`** — flagged for `create-stack-skill` workflow.

```yaml
name: skillex-stack
members:
  - skillex-core
  - skillex-adapters
  - skillex-core-activator   # implicit member via skillex-commands integration
  - skillex-commands         # not skilled standalone but contributes orchestration story
integration_evidence:
  - 'cli.py:7-12 — registers all command modules'
  - 'commands/pack.py:11-21 — pulls 5 core modules + adapters via activator'
  - 'activator.py:18 — imports adapters.base.all_adapters() during plan()'
description: 'How skillex composes a CLI tool out of a Pydantic domain model, a Protocol-based extension point, and a Typer subcommand surface — with reversible filesystem mutations as the load-bearing primitive.'
```

### Rejected Units

| Unit | Reason |
|------|--------|
| `skillex` (#1) | Overlaps with units 2-3-5; covered by S1 stack-skill instead |
| `skillex-commands` (#4) | Mechanical Typer registration pattern with one substantial worked example (`pack.py`); folded into S1 as the orchestration narrative |

## Generation Results

### Generated Briefs

| # | Unit Name | Output Path | Validation | Next Workflow |
|---|-----------|-------------|------------|---------------|
| 1 | `skillex-core` | `forge-data/skillex-core/skill-brief.yaml` | pass | `brief-skill` (refine specific-modules scope) **or** `create-skill` (brief is already detailed) |
| 2 | `skillex-adapters` | `forge-data/skillex-adapters/skill-brief.yaml` | pass | `brief-skill` (public-api detailed scoping) **or** `create-skill` (brief is already detailed) |
| 3 | `skillex-core-activator` | `forge-data/skillex-core-activator/skill-brief.yaml` | pass | `brief-skill` (refine specific-modules scope) **or** `create-skill` (brief is already detailed) |

### Generation Summary

- Total confirmed units: 3
- Briefs generated: 3
- Briefs skipped/failed: 0
- Stack-skill candidates flagged: 1 (`skillex-stack`)

### Next Steps

1. **Run `create-skill` (CS) directly** for any of the three units — the briefs include explicit `scope.include` lists, descriptions, and notes; they are compilation-ready as-is. Use `--batch` to compile all three in sequence.
2. **Or run `brief-skill` (BS)** on any unit first if you want to refine scope further (e.g., narrow `skillex-core` to only models + loader, or expand activator's brief with a worked-example narrative). Per-workflow recommendation favored this route, but the briefs are detailed enough to skip it.
3. **After individual skills exist, run `create-stack-skill` (SS)** to compile `skillex-stack`, integrating the orchestration story (`cli.py → commands → core + adapters`) on top of the three component skills.
4. **Optional follow-up:** address the two architectural smells flagged in step-04 — the layer inversion at `core/activator.py:18` and the private-symbol leak at `commands/status.py:11`. Neither blocks skilling; both belong in the activator skill's "constraints" section.
