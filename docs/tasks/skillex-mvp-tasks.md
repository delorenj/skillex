# Skillex MVP Task Breakdown

**Status:** Draft v0.1
**Derived from:** `docs/plan/skillex-mvp-plan.md`
**Last updated:** 2026-04-16

---

## Phase 1: Foundation

### T1: Scaffold Python project

**Description:** Initialize uv-managed Python project. Create package skeleton, dev dependencies, ruff/mypy/pytest config, mise task entries.

**Acceptance criteria:**
- [ ] `uv sync` installs all dev + runtime deps without error.
- [ ] `uv run skillex --help` prints typer help (may be empty; just proves entry point wires up).
- [ ] `uv run ruff check .` exits 0.
- [ ] `uv run mypy src/skillex` exits 0.
- [ ] `uv run pytest` exits 0 (no tests yet).

**Verification:**
- [ ] Run the four commands above in order.

**Files:**
- `pyproject.toml`, `uv.lock`
- `src/skillex/__init__.py`, `src/skillex/cli.py` (stub)
- `tests/__init__.py`, `tests/conftest.py`
- `mise.toml` (add tasks: `build`, `test`, `lint`, `fmt`, `tc`)
- `.gitignore` additions (`.venv`, `dist/`, `__pycache__`)

**Dependencies:** None

**Scope:** S

---

### T2: Core models

**Description:** Define all pydantic models used across the codebase.

**Acceptance criteria:**
- [ ] `SlotType`, `SkillFrontmatter`, `Skill`, `SlotAssignment`, `PackManifest`, `Pack`, `CliAdapterConfig`, `SkillexConfig`, `LinkOp` all defined and typed.
- [ ] Models use `model_config = ConfigDict(frozen=True)` where immutable.
- [ ] Unit tests cover each model's validation edge cases.

**Verification:**
- [ ] `uv run pytest tests/unit/test_models.py -v` green.
- [ ] `uv run mypy --strict src/skillex/core/models.py` clean.

**Files:**
- `src/skillex/core/__init__.py`
- `src/skillex/core/models.py`
- `tests/unit/test_models.py`

**Dependencies:** T1

**Scope:** S

---

### T3: Slot registry

**Description:** Canonical slot types list, custom-prefix validation, lookup helpers.

**Acceptance criteria:**
- [ ] Module exposes `CANONICAL_SLOT_TYPES = {"Memory", "Workflow", "TTS"}`.
- [ ] `is_valid_slot_type(name: str) -> bool` accepts canonical or `custom:<anything>`.
- [ ] Invalid slot types produce actionable error with suggestion.

**Verification:**
- [ ] `uv run pytest tests/unit/test_registry.py -v` green.

**Files:**
- `src/skillex/core/registry.py`
- `tests/unit/test_registry.py`

**Dependencies:** T2

**Scope:** XS

---

### T4: Loader

**Description:** Parse `skillex.toml`, `pack.toml`, and SKILL.md YAML frontmatter into typed models. Handle missing files, malformed TOML, invalid frontmatter with clear errors.

**Acceptance criteria:**
- [ ] `load_config(path)` returns `SkillexConfig` or raises `ConfigError`.
- [ ] `load_pack(path)` returns `Pack` with resolved skill references.
- [ ] `load_skill(path)` returns `Skill` with optional frontmatter.
- [ ] `discover_skills(skills_root)` returns `dict[str, Skill]` keyed by name.
- [ ] Duplicate skill names across `all-skills/` raise `DuplicateSkillError` with both paths.

**Verification:**
- [ ] `uv run pytest tests/unit/test_loader.py -v` green with ≥6 test cases.
- [ ] Load succeeds against a hand-crafted fixture pack.

**Files:**
- `src/skillex/core/loader.py`
- `tests/unit/test_loader.py`
- `tests/fixtures/sample_skills/` (minimal valid fixtures)

**Dependencies:** T2, T3

**Scope:** M

---

### Checkpoint 1: Foundation ready

- [ ] T1–T4 all completed
- [ ] `uv run pytest tests/unit/` green
- [ ] `uv run mypy --strict src/skillex/core/` clean
- [ ] `uv run ruff check .` clean

---

## Phase 2: Validation

### T5: Linter

**Description:** Implement all 10 lint rules from PRD section 11. Return typed issues with severity and location.

**Acceptance criteria:**
- [ ] `lint_pack(pack, skills_index) -> list[LintIssue]` returns structured findings.
- [ ] All 10 rules have code constants (`SLOT_TYPE_MISMATCH`, etc.).
- [ ] Each rule has at least one positive and one negative test case.
- [ ] `LintIssue` includes severity, rule code, message, and path context.

**Verification:**
- [ ] `uv run pytest tests/unit/test_linter.py -v` green, ≥20 test cases.

**Files:**
- `src/skillex/core/linter.py`
- `tests/unit/test_linter.py`

**Dependencies:** T4

**Scope:** M

---

### Checkpoint 2: Validation ready

- [ ] Linter catches each rule in a fixture pack designed to fail it.

---

## Phase 3: Adapters

### T6: Adapter base

**Description:** Define the adapter Protocol, shared path resolution helpers, and a registry for adapter discovery.

**Acceptance criteria:**
- [ ] `Adapter` Protocol with `name`, `global_root`, `project_root`, `render_links()`.
- [ ] `get_adapter(name)` lookup helper.
- [ ] Shared helpers for path expansion (`~` to home, relative to absolute).

**Verification:**
- [ ] `uv run pytest tests/unit/test_adapter_base.py -v` green.

**Files:**
- `src/skillex/adapters/__init__.py`
- `src/skillex/adapters/base.py`
- `tests/unit/test_adapter_base.py`

**Dependencies:** T2

**Scope:** S

---

### T7: Claude adapter

**Description:** Render a skill as a directory-level symlink under `<scope_root>/skills/<name>/ -> <all_skills>/<name>/`.

**Acceptance criteria:**
- [ ] `render_links(skill, scope_root)` returns exactly one `LinkOp` pointing to the skill directory.
- [ ] Works against both global (`~/.claude/`) and project (`<repo>/.claude/`) scope roots.

**Verification:**
- [ ] `uv run pytest tests/unit/test_adapter_claude.py -v` green.

**Files:**
- `src/skillex/adapters/claude.py`
- `tests/unit/test_adapter_claude.py`

**Dependencies:** T6

**Scope:** S

---

### T8: Codex adapter

**Description:** Render a skill as a file-level symlink under `<scope_root>/prompts/<name>.md -> <all_skills>/<name>/SKILL.md`.

**Acceptance criteria:**
- [ ] `render_links(skill, scope_root)` returns a `LinkOp` for the SKILL.md file.
- [ ] Flat naming, no subdirectories.

**Verification:**
- [ ] `uv run pytest tests/unit/test_adapter_codex.py -v` green.

**Files:**
- `src/skillex/adapters/codex.py`
- `tests/unit/test_adapter_codex.py`

**Dependencies:** T6

**Scope:** S

---

### T9: OpenCode adapter

**Description:** Render a skill as a file-level symlink under `<scope_root>/agent/<name>.md -> <all_skills>/<name>/SKILL.md`. MVP defaults to `agent/`; `command/` routing is future work.

**Acceptance criteria:**
- [ ] `render_links(skill, scope_root)` returns a `LinkOp` targeting `agent/`.
- [ ] Test explicitly documents the `command/` deferral.

**Verification:**
- [ ] `uv run pytest tests/unit/test_adapter_opencode.py -v` green.

**Files:**
- `src/skillex/adapters/opencode.py`
- `tests/unit/test_adapter_opencode.py`

**Dependencies:** T6

**Scope:** S

---

### Checkpoint 3: Adapter contract sealed

- [ ] All three adapters render a canonical fixture skill without error.
- [ ] LinkOp lists per adapter match the golden file.

---

## Phase 4: Activation Engine

### T10: File lock

**Description:** PID-aware file lock at `~/.config/skillex/.lock`. Detects stale locks.

**Acceptance criteria:**
- [ ] `FileLock(path)` context manager with `__enter__` / `__exit__`.
- [ ] Writes current PID to lock file.
- [ ] If lock exists and PID is alive, raises `LockBusyError`.
- [ ] If lock exists but PID is dead, takes over lock.

**Verification:**
- [ ] `uv run pytest tests/unit/test_file_lock.py -v` green.

**Files:**
- `src/skillex/core/file_lock.py`
- `tests/unit/test_file_lock.py`

**Dependencies:** T1

**Scope:** XS

---

### T11: Activator plan

**Description:** Compute the set of `LinkOp` additions, removals, and no-ops given a pack, scope, and current CLI root state.

**Acceptance criteria:**
- [ ] `plan(pack, scope, config) -> list[LinkOp]` returns ordered ops.
- [ ] Planned ops are idempotent: running against an already-active pack yields empty diff.
- [ ] Dry-run prints plan without executing.

**Verification:**
- [ ] `uv run pytest tests/unit/test_activator_plan.py -v` green.

**Files:**
- `src/skillex/core/activator.py`
- `tests/unit/test_activator_plan.py`

**Dependencies:** T6, T7, T8, T9

**Scope:** S

---

### T12: Activator apply with rollback

**Description:** Execute a plan against the filesystem. Snapshot prior state, apply ops, verify, restore on any failure.

**Acceptance criteria:**
- [ ] `apply(plan, dry_run=False)` creates/removes symlinks per plan.
- [ ] All writes happen under the file lock.
- [ ] On any verification failure, snapshot is restored and an `ActivationError` is raised.
- [ ] Structured log event emitted per apply (`event="activation.applied"` with pack, scope, op_count).

**Verification:**
- [ ] `uv run pytest tests/unit/test_activator_apply.py -v` green.
- [ ] Integration test proves rollback on simulated mid-apply failure.

**Files:**
- `src/skillex/core/activator.py` (extend)
- `tests/unit/test_activator_apply.py`
- `tests/integration/test_activator_rollback.py`

**Dependencies:** T10, T11

**Scope:** M

---

### Checkpoint 4: Activation engine ready

- [ ] Plan + apply work end-to-end against a tmpdir fixture.
- [ ] Rollback test proves no partial state on failure.

---

## Phase 5: CLI

### T13: Typer entrypoint + `init`

**Description:** Wire up the Typer app. Implement `skillex init` to scaffold a default `~/.config/skillex/skillex.toml`.

**Acceptance criteria:**
- [ ] `uv run skillex init` creates the config file if missing.
- [ ] Refuses to overwrite existing config without `--force`.
- [ ] Default config registers Claude, Codex, OpenCode adapters.

**Verification:**
- [ ] `uv run pytest tests/integration/test_cli_init.py -v` green.

**Files:**
- `src/skillex/cli.py`
- `src/skillex/commands/__init__.py`
- `src/skillex/commands/init.py`
- `tests/integration/test_cli_init.py`

**Dependencies:** T2

**Scope:** S

---

### T14: `pack lint` + `pack activate` + `pack deactivate`

**Description:** Implement the main pack lifecycle commands.

**Acceptance criteria:**
- [ ] `skillex pack lint <name>` runs linter, exits 0 on clean, 1 on errors.
- [ ] `skillex pack activate <name> [--scope] [--dry-run]` plans and applies.
- [ ] `skillex pack deactivate [--scope]` restores pre-active state by reading symlinks and removing only skillex-owned ones.
- [ ] All commands print Rich-formatted output.

**Verification:**
- [ ] `uv run pytest tests/integration/test_cli_pack.py -v` green.

**Files:**
- `src/skillex/commands/pack.py`
- `tests/integration/test_cli_pack.py`

**Dependencies:** T5, T12, T13

**Scope:** M

---

### T15: `status` + `pack list/show` + `skill list/show` + `slot list`

**Description:** Implement the read-only introspection commands.

**Acceptance criteria:**
- [ ] `skillex status` prints active pack per scope and per-CLI sync state.
- [ ] `skillex pack list` lists all packs in `packs/`.
- [ ] `skillex pack show <name>` prints manifest + resolved skills.
- [ ] `skillex skill list [--slot <type>]` lists skills, optionally filtered.
- [ ] `skillex skill show <name>` prints skill metadata and path.
- [ ] `skillex slot list` prints registry + which skills fill each type.

**Verification:**
- [ ] `uv run pytest tests/integration/test_cli_introspection.py -v` green.

**Files:**
- `src/skillex/commands/status.py`
- `src/skillex/commands/pack.py` (extend)
- `src/skillex/commands/skill.py`
- `src/skillex/commands/slot.py`
- `tests/integration/test_cli_introspection.py`

**Dependencies:** T13

**Scope:** M

---

### Checkpoint 5: CLI complete

- [ ] Every command from PRD section 10 works against fixture.
- [ ] `--help` on any subcommand prints useful output.

---

## Phase 6: Integration

### T16: Fixture pack

**Description:** Author a real `33god-dev` pack in `packs/33god-dev/pack.toml` that references existing skills in `all-skills/`. Used as primary end-to-end fixture.

**Acceptance criteria:**
- [ ] Pack manifest lints clean.
- [ ] Pack activates successfully against `test/` fixture without errors.
- [ ] README in pack directory explains the loadout.

**Verification:**
- [ ] `skillex pack lint 33god-dev` exits 0.
- [ ] `skillex pack activate 33god-dev --dry-run` prints expected plan.

**Files:**
- `packs/33god-dev/pack.toml`
- `packs/33god-dev/README.md`

**Dependencies:** T14

**Scope:** XS

---

### T17: End-to-end integration test

**Description:** Full roundtrip against a tmpdir copy of `test/`: init → lint → activate → verify links → deactivate → verify restored.

**Acceptance criteria:**
- [ ] Test clones `test/` to tmpdir.
- [ ] Runs full activate/deactivate cycle.
- [ ] Asserts symlinks exist and point correctly after activate.
- [ ] Asserts no skillex-owned symlinks remain after deactivate.
- [ ] Asserts prior non-skillex files are untouched.

**Verification:**
- [ ] `uv run pytest tests/integration/test_e2e.py -v` green.

**Files:**
- `tests/integration/test_e2e.py`
- `tests/fixtures/e2e_pack/pack.toml`

**Dependencies:** T14, T16

**Scope:** M

---

### Checkpoint 6: Integration green

- [ ] E2E test passes locally.
- [ ] `skillex pack activate 33god-dev` against the real `test/` layout produces identical symlink graphs across all 3 adapters.

---

## Phase 7: Polish

### T18: Logging, README, mise wiring

**Description:** Set up structlog with console default + `--json` flag. Write a user-facing README. Ensure mise tasks exist for build/test/lint/fmt/tc.

**Acceptance criteria:**
- [ ] `structlog.configure()` called once at CLI entry.
- [ ] Every activate/deactivate emits a structured event.
- [ ] `README.md` at repo root covers install, init, first pack activation, common commands.
- [ ] `mise run test`, `mise run lint`, `mise run tc` all work.

**Verification:**
- [ ] Manually run each mise task.
- [ ] Inspect log output in both console and `--log-json` modes.

**Files:**
- `src/skillex/logging.py`
- `src/skillex/cli.py` (wire logging)
- `README.md`
- `mise.toml`

**Dependencies:** T17

**Scope:** S

---

### Checkpoint 7: Ready for review

- [ ] All success criteria from PRD section 17 satisfied.
- [ ] `uv run pytest` green.
- [ ] `uv run ruff check && uv run mypy --strict src/skillex` clean.
- [ ] `skillex pack activate 33god-dev` completes against `test/` in under 500ms.

---

## Task Summary Table

| ID | Title | Scope | Deps |
|----|-------|-------|------|
| T1 | Scaffold Python project | S | — |
| T2 | Core models | S | T1 |
| T3 | Slot registry | XS | T2 |
| T4 | Loader | M | T2, T3 |
| T5 | Linter | M | T4 |
| T6 | Adapter base | S | T2 |
| T7 | Claude adapter | S | T6 |
| T8 | Codex adapter | S | T6 |
| T9 | OpenCode adapter | S | T6 |
| T10 | File lock | XS | T1 |
| T11 | Activator plan | S | T6, T7, T8, T9 |
| T12 | Activator apply with rollback | M | T10, T11 |
| T13 | Typer entrypoint + init | S | T2 |
| T14 | pack lifecycle commands | M | T5, T12, T13 |
| T15 | Introspection commands | M | T13 |
| T16 | Fixture pack | XS | T14 |
| T17 | E2E integration test | M | T14, T16 |
| T18 | Logging + README + mise | S | T17 |

**Total:** 18 tasks. Scope mix: 2 XS, 7 S, 5 M. No XL. No task touches more than 5 files.

---

## Parallelization Notes

After T6 (adapter base), T7/T8/T9 can parallelize across agents. After T13 (entrypoint), T14 and T15 can parallelize with care (both modify `commands/pack.py` so need merge discipline).

In autopilot single-agent flow, order is strictly sequential.
