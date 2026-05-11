---
name: skillex-core
description: >
  Documents the skillex domain layer — Pydantic v2 models for Skill, Pack,
  LinkOp, and SkillexConfig; a typed LoaderError hierarchy with six exception
  classes; structured pack-lint rules using Severity and RuleCode StrEnums; a
  canonical slot-type registry with a custom: prefix escape hatch; and a
  PID-aware FileLock context manager. Use this skill when reading, parsing, or
  validating skillex.toml, pack.toml, or SKILL.md files; when constructing
  LinkOp activation plans; when writing tests against the loader's exception
  hierarchy; or when serializing slot-type validation rules. Do NOT use for the
  plan/apply activation algorithm itself — that lives in the
  skillex-core-activator skill.
---

# skillex-core

## Overview

Skillex domain layer at `src/skillex/core/` v0.1.1. Five files, 31 public
exports across 9 Pydantic models, 6 loader exception types, 4 lint functions,
2 registry helpers, and 1 file-lock primitive. Forms the bottom of the
skillex stack — `core` has no upward imports into `commands` or the CLI;
its only outward edge is `activator.py → adapters.base` (excluded from this
skill, see `skillex-core-activator`). All extraction is T1 (AST-verified)
with line-level citations.

| | |
|---|---|
| Source | `delorenj/skillex` (local: `/home/delorenj/code/skillex`) |
| Commit | `8d36702` |
| Tier | Deep |
| Files | 5 in scope (`core/{models,loader,linter,registry,file_lock}.py`) |
| Public exports | 31 (T1) |

## Quick Start

End-to-end: load a skillex config, discover skills, load and lint a pack,
acquire the activation lock.

```python
from pathlib import Path

from skillex.core.file_lock import FileLock, LockBusyError
from skillex.core.linter import has_errors, lint_pack
from skillex.core.loader import (
    discover_skills,
    load_config,
    load_pack,
)

cfg = load_config(Path("~/.config/skillex/skillex.toml").expanduser())
skills_index = discover_skills(cfg.skills_root)
pack = load_pack(cfg.packs_root / "33god-dev", skills_index)

issues = lint_pack(pack, skills_index)
if has_errors(issues):
    for issue in issues:
        print(f"{issue.severity.value} {issue.rule.value}: {issue.message}")
    raise SystemExit(1)

with FileLock(Path("~/.config/skillex/.lock").expanduser()):
    # ...activation work happens here (handled by skillex-core-activator)
    pass
```

`[AST:src/skillex/core/loader.py:L59,L108,L144,L228]` `[AST:src/skillex/core/linter.py:L45,L202]` `[AST:src/skillex/core/file_lock.py:L25]`

## Common Workflows

### Load and validate a skillex.toml

```python
from skillex.core.loader import ConfigError, load_config
try:
    cfg = load_config(Path("skillex.toml"))
except ConfigError as e:
    # ConfigError chains the underlying tomllib.TOMLDecodeError or ValidationError
    raise
```
`[AST:src/skillex/core/loader.py:L59,L33]`

### Discover all skills, raising on duplicate names

```python
from skillex.core.loader import DuplicateSkillError, discover_skills
try:
    skills = discover_skills(Path("all-skills"))
except DuplicateSkillError as e:
    print(f"duplicate skill {e.name!r} at: {e.paths}")
```
`[AST:src/skillex/core/loader.py:L144,L45]`

### Lint a pack and surface errors only

```python
from skillex.core.linter import Severity, has_errors, lint_pack
issues = lint_pack(pack, skills_index)
errors = [i for i in issues if i.severity is Severity.ERROR]
```
`[AST:src/skillex/core/linter.py:L45,L20,L202]`

### Validate a slot type, custom prefix included

```python
from skillex.core.registry import explain_invalid_slot_type, is_valid_slot_type
if not is_valid_slot_type("Memory"):
    print(explain_invalid_slot_type("Memory"))   # canonical: returns True, no error path
if not is_valid_slot_type("custom:my-slot"):
    print(explain_invalid_slot_type("custom:my-slot"))   # accepted via custom: prefix
```
`[AST:src/skillex/core/registry.py:L15,L24]`

### Acquire the activation lock with stale-PID reclaim

```python
from skillex.core.file_lock import FileLock, LockBusyError
try:
    with FileLock(lock_path) as lock:
        # ...critical section
        ...
except LockBusyError as e:
    print(e)   # "lock held by pid N at <path>; ..."
```
`[AST:src/skillex/core/file_lock.py:L25,L21]`

## Key API Summary

| Symbol | Kind | Purpose | Citation |
|--------|------|---------|----------|
| `Skill` | Pydantic model (frozen) | A skill on disk: `name`, `path`, `skill_md_path`, `frontmatter` | `[AST:src/skillex/core/models.py:L37]` |
| `Pack` | Pydantic model (frozen) | A resolved pack: `manifest`, `pack_path`, `slot_skills`, `freeform_skills` | `[AST:src/skillex/core/models.py:L89]` |
| `PackManifest` | Pydantic model (frozen) | Raw parsed `pack.toml`: `name`, `version`, `description`, `slots`, `freeform_skills` | `[AST:src/skillex/core/models.py:L70]` |
| `SkillexConfig` | Pydantic model (frozen) | Parsed `skillex.toml`: `skills_root`, `packs_root`, `log_format`, `scopes`, `cli_adapters` | `[AST:src/skillex/core/models.py:L124]` |
| `LinkOp` | Pydantic model (frozen) | One filesystem operation in an activation plan: `action` ∈ {add, remove, keep}, `target`, `source`, `cli`, `scope` | `[AST:src/skillex/core/models.py:L136]` |
| `load_config(path) -> SkillexConfig` | function | Parse + validate `skillex.toml`; raises `ConfigError` | `[AST:src/skillex/core/loader.py:L59]` |
| `load_skill(skill_dir) -> Skill` | function | Parse a skill directory + frontmatter; raises `SkillError` | `[AST:src/skillex/core/loader.py:L108]` |
| `discover_skills(skills_root) -> dict[str, Skill]` | function | Scan a skills root; raises `DuplicateSkillError` on collision | `[AST:src/skillex/core/loader.py:L144]` |
| `load_pack(pack_dir, skills_index) -> Pack` | function | Parse `pack.toml` + resolve skill refs; raises `SkillReferenceError` | `[AST:src/skillex/core/loader.py:L228]` |
| `lint_pack(pack, skills_index) -> list[LintIssue]` | function | Apply 8 lint rules to a resolved pack | `[AST:src/skillex/core/linter.py:L45]` |
| `lint_packs(packs, skills_index) -> list[LintIssue]` | function | Cross-pack lint catching `PACK_NAME_CONFLICT` | `[AST:src/skillex/core/linter.py:L177]` |
| `has_errors(issues) -> bool` | function | True if any issue has `Severity.ERROR` | `[AST:src/skillex/core/linter.py:L202]` |
| `is_valid_slot_type(name) -> bool` | function | Canonical types or `custom:*` non-empty suffix | `[AST:src/skillex/core/registry.py:L15]` |
| `explain_invalid_slot_type(name) -> str` | function | Actionable error message for invalid slot types | `[AST:src/skillex/core/registry.py:L24]` |
| `FileLock(path)` | context manager | PID-aware lock; reclaims stale locks (dead PID) | `[AST:src/skillex/core/file_lock.py:L25]` |

Full signatures and parameter tables: see `references/api-reference.md`.

## Key Types

### `Severity` (StrEnum, `linter.py:L20`)

| Value | Meaning |
|-------|---------|
| `ERROR` | Lint failure that blocks pack activation |
| `WARN` | Non-blocking concern (e.g., orphan optional slot) |

### `RuleCode` (StrEnum, `linter.py:L25`) — 8 codes

`SLOT_TYPE_MISMATCH`, `SLOT_TYPE_UNKNOWN`, `REQUIRED_SLOT_EMPTY`,
`DUPLICATE_SKILL`, `UNSLOTTED_IN_SLOT`, `PACK_NAME_CONFLICT`,
`MISSING_FRONTMATTER`, `ORPHAN_SLOT`.

### `LinkOp.action` (Literal, `models.py:L146`)

`"add"` creates a symlink at `target → source`; `"remove"` deletes the symlink
at `target` (source is informational); `"keep"` is a no-op for plan display.

### `LinkOp.scope` (Literal, `models.py:L150`)

`"global"` (e.g., `~/.claude`) or `"project"` (e.g., `<repo>/.claude`).

### `CANONICAL_SLOT_TYPES` (frozenset, `registry.py:L10`)

`{"Memory", "Workflow", "TTS"}`. Additions are promoted one-per-PR with a
regression test; the `custom:` prefix lets users prototype new slot types
without a registry change.

### `NAME_PATTERN` (regex, `models.py:L16`)

`^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$` — pack and skill names: lowercase
alphanumeric + dashes, no leading/trailing dash. Enforced via Pydantic
`field_validator` on `Skill.name` and `PackManifest.name`.

## Architecture at a Glance

- `models.py` — 9 frozen Pydantic v2 models. Shape and trivial constraints only; cross-module validation lives elsewhere.
- `loader.py` — pure parsers (`tomllib` + `frontmatter`) with a 6-class exception hierarchy rooted at `LoaderError`. Loaders raise on structural errors, not semantic ones.
- `linter.py` — semantic validation: 8 `RuleCode`s, 2 `Severity` levels, returns `list[LintIssue]` so CLI callers can print full reports.
- `registry.py` — the only place `CANONICAL_SLOT_TYPES` is defined. `is_valid_slot_type` and `explain_invalid_slot_type` are imported by `linter.py` for slot-type validation.
- `file_lock.py` — PID-aware lock for serializing activation commands. Stale locks (dead PID) are reclaimed automatically; `LockBusyError` only raises for live PIDs.

## CLI

This skill exposes no CLI of its own. Consumers are the `skillex` Typer
subcommands at `src/skillex/commands/` (out of scope for this skill —
see the `skillex-stack` skill when it's compiled).

## Manual Sections

<!-- [MANUAL] Project conventions and idioms — fill on iteration -->

<!-- [MANUAL] Worked examples beyond Quick Start — fill on iteration -->

<!-- [MANUAL] Known issues, gotchas, and migration notes specific to this version -->

## Full API Reference

See `references/api-reference.md` for complete signatures, parameter tables, and
return-type details for every export.
