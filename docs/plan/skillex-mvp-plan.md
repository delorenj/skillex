# Skillex MVP Implementation Plan

**Status:** Draft v0.1
**Derived from:** `docs/prd/skillex-mvp.md`
**Last updated:** 2026-04-16

---

## Overview

Build skillex MVP as a Python 3.12 + uv + Typer CLI. Ship foundation layer first (models, loader, linter, registry), then vertical slices (init → lint → dry-run → activate → status → deactivate). Adapter layer does per-CLI rendering, not just directory symlinking, because Claude, Codex, and OpenCode use fundamentally different native layouts.

---

## Format Parity Spike Findings

Ran against `test/.claude/`, `test/.codex/`, `test/.opencode/`.

| CLI          | Skill root                                          | Per-skill layout                                | Naming                      |
| ------------ | --------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| **Claude**   | `~/.claude/skills/<skill>/`                         | Directory containing `SKILL.md` + support files | `skills/hindsight/SKILL.md` |
| **Codex**    | `~/.config/codex/prompts/`                          | Flat `.md` file per skill                       | `prompts/hindsight.md`      |
| **OpenCode** | `~/.config/opencode/agent/` (primary) or `command/` | Flat `.md` file per skill                       | `agent/hindsight.md`        |

**Implications:**

1. Claude's native format matches our canonical `all-skills/<skill>/SKILL.md` structure exactly. Claude adapter does directory-level symlinks.
2. Codex and OpenCode need file-level symlinks pointing at the `SKILL.md` inside the skill directory.
3. Support files (references, scripts, templates inside a skill dir) are reachable in Claude's directory layout but invisible in Codex/OpenCode's flat layouts. This is a known MVP limitation; skills that require support files are Claude-only for now.
4. OpenCode has two possible roots (`agent/` vs `command/`). MVP defaults to `agent/`. Skills that need command-style treatment can declare a hint in frontmatter (future).

**Adapter contract update (from PRD section 9):**

```python
class Adapter(Protocol):
    name: str
    global_root: Path         # absolute path, user-level
    project_root: Path        # relative to repo root

    def render_links(self, skill: Skill, scope_root: Path) -> list[LinkOp]:
        """Return symlink ops needed to publish `skill` into this CLI's scope_root."""
```

**Risk:** If skills in `all-skills/` have deep file structure (references, scripts), Codex and OpenCode rendering will miss that context. Mitigation documented as a known limitation; full fix is M3 (packs full scope).

---

## Architecture Decisions

### AD-1: Python 3.12 + uv + Typer

Rationale: fastest path to working MVP, matches user's stack (uv, pydantic, typer). Rust port is M7 once the API shape is proven.

### AD-2: Adapters own rendering

Rationale: CLIs diverge on layout. Keeping rendering logic in adapters preserves a single canonical skill format in `all-skills/` and a single canonical pack manifest format.

### AD-3: Symlinks only (no file copies)

Rationale: edits to a skill in `all-skills/` must propagate instantly to all active CLI roots. Copies would drift. Broken symlinks are observable with `ls -la`.

### AD-4: Snapshot-and-restore rollback

Rationale: full ACID semantics on filesystem are hard. In-memory snapshot of every pre-mutation state gives us atomic apply: any failure triggers full restore from snapshot.

### AD-5: Filesystem lock via `~/.config/skillex/.lock`

Rationale: prevents concurrent activations from racing on the same CLI roots.

### AD-6: Pydantic for all config and manifest parsing

Rationale: strict typing, validation at load, clear error messages. Matches user preferences.

### AD-7: structlog with console renderer default

Rationale: structured key-value output for observability, pretty TTY default for humans, JSON switch for CI/log aggregation.

---

## Component Dependency Graph

```
┌─────────────────────────────────────────────────────────────┐
│                      Foundation Layer                        │
├─────────────────────────────────────────────────────────────┤
│  pyproject.toml + uv + ruff + mypy + pytest                 │
│           │                                                  │
│           ▼                                                  │
│  models.py (Pack, Skill, Slot, Config, LinkOp)              │
│           │                                                  │
│           ├──────────┬─────────────┬────────────────────────┤
│           ▼          ▼             ▼                        │
│      registry.py  loader.py    logging.py                   │
│                      │                                      │
│                      ▼                                      │
│                  linter.py                                  │
└──────────────────────┼──────────────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────────────┐
│                      │    Adapter Layer                     │
├──────────────────────┼──────────────────────────────────────┤
│                      ▼                                      │
│                  adapters/base.py (Protocol)                │
│                      │                                      │
│           ┌──────────┼──────────┐                          │
│           ▼          ▼          ▼                          │
│       claude.py   codex.py   opencode.py                   │
└───────────┬──────────┬──────────┬──────────────────────────┘
            │          │          │
┌───────────┴──────────┴──────────┴──────────────────────────┐
│                   Orchestration Layer                       │
├─────────────────────────────────────────────────────────────┤
│                 activator.py (plan + apply)                 │
│                      │                                      │
│                      ▼                                      │
│                   cli.py (typer entrypoint)                 │
│                      │                                      │
│      ┌───────────────┼───────────────┐                     │
│      ▼               ▼               ▼                     │
│ commands/init.py  commands/pack.py  commands/status.py     │
└─────────────────────────────────────────────────────────────┘
```

---

## Vertical Slices (User-Value Milestones)

Build order follows dependency graph bottom-up, but user-facing milestones slice vertically to deliver complete flows.

### Slice A: Foundation (no user-visible output)

Project scaffold, models, registry, logging. No CLI commands work yet. Verification is `pytest` passing on unit tests.

### Slice B: `skillex init`

User runs `skillex init`, gets a working `~/.config/skillex/skillex.toml` with all 3 adapters registered. Verifies config loading end-to-end.

### Slice C: `skillex pack lint <name>`

User can validate a pack manifest. Exercises loader + linter + registry end-to-end. No filesystem mutation yet.

### Slice D: `skillex pack activate <name> --dry-run`

User sees the planned symlink operations per CLI without touching disk. Exercises activator planning logic plus all 3 adapters.

### Slice E: `skillex pack activate <name>` (real apply)

User actually activates a pack. Symlinks appear in all 3 CLI roots. Exercises the full write path with rollback.

### Slice F: `skillex status` + `skillex pack deactivate`

User sees active state and can roll back. Completes the user loop.

---

## Risks and Mitigations

| ID  | Risk                                                                                      | Impact | Mitigation                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| R1  | Codex/OpenCode can't use `SKILL.md` content as-is (expect different structure internally) | High   | Test render against real Codex/OpenCode invocation early. Fallback: adapter emits a flattened `.md` extracting skill body. |
| R2  | Symlink targets pointing into `all-skills/` break when submodule is updated/moved         | Medium | Use absolute paths in symlinks; emit warnings at load if any link is broken.                                               |
| R3  | User has existing `~/.claude/skills/` content that isn't skillex-managed                  | Medium | Activator respects any non-symlink files; refuses to overwrite unless `--force`.                                           |
| R4  | File lock not released on crash                                                           | Low    | PID-based lock with stale detection (if PID dead, take lock).                                                              |
| R5  | Frontmatter absent from many `all-skills/` entries                                        | High   | Audit `all-skills/` in a pre-MVP pass; add missing frontmatter. Treat unslotted skills as valid for freeform entries only. |
| R6  | `packs/google-agent-skills/` content doesn't map cleanly to pack manifest schema          | Medium | Document migration in a follow-up task; MVP ships with one hand-authored fixture pack (`33god-dev`).                       |
| R7  | OpenCode `agent/` vs `command/` routing ambiguity                                         | Low    | MVP defaults to `agent/`. Add frontmatter hint in M1.6+.                                                                   |

---

## Parallelization

| Path                             | Can parallelize?             | Notes                                                     |
| -------------------------------- | ---------------------------- | --------------------------------------------------------- |
| Foundation layer                 | Sequential                   | Models block registry, loader, linter.                    |
| Adapters (claude/codex/opencode) | Parallel after base.py       | Each adapter is independent once the Protocol is defined. |
| Commands (init/pack/status)      | Parallel after core          | Each command is independent once activator is built.      |
| Tests                            | Parallel with implementation | Unit tests written alongside each component.              |

For autopilot: primarily sequential due to single-agent context, but flag sub-components that could hand off to a second agent.

---

## Verification Checkpoints

### Checkpoint 1: Foundation ready

After: scaffolding + models + registry + loader.

- [ ] `uv run pytest tests/unit/test_models.py` passes
- [ ] `uv run pytest tests/unit/test_loader.py` passes
- [ ] `uv run mypy src/skillex/core/` passes
- [ ] `uv run ruff check .` clean

### Checkpoint 2: Validation works

After: linter complete.

- [ ] All 10 lint rules have a test case
- [ ] Lint runs against sample pack fixture without error

### Checkpoint 3: Adapter contract sealed

After: base.py + all 3 adapters.

- [ ] Each adapter has a contract test proving its `render_links` output
- [ ] A canonical fixture skill renders to 3 distinct `LinkOp` lists

### Checkpoint 4: Dry-run works

After: activator + init/lint/activate commands with `--dry-run`.

- [ ] `skillex init` produces valid config
- [ ] `skillex pack activate <name> --dry-run` prints plan
- [ ] No files are mutated during dry-run

### Checkpoint 5: Full roundtrip

After: real activate + deactivate.

- [ ] Activate populates all 3 CLI roots in a tmpdir fixture
- [ ] Deactivate returns state to pre-activation
- [ ] Activation of a 50-skill pack completes under 500ms

### Checkpoint 6: Ready to merge

- [ ] All success criteria from PRD section 17 satisfied
- [ ] Integration test suite green
- [ ] Documentation updated (README, CHANGELOG)

---

## Open Questions from Planning

None blocking. Risks R1 and R5 will be validated as we go. If R1 fails (Codex/OpenCode don't render `SKILL.md` usefully), we pause and redesign adapter output.

---

## Next Phase

Phase 3 (Tasks) breaks this plan into individual implementable tasks. See `docs/tasks/skillex-mvp-tasks.md`.
