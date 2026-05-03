# skillex-core — Full API Reference

All signatures verified against AST extraction at commit `8d36702`. Provenance citations format: `[AST:{file}:L{line}]`.

## Models (`src/skillex/core/models.py`)

### `SkillFrontmatter`

```python
class SkillFrontmatter(BaseModel):
    model_config = ConfigDict(extra="allow", frozen=True, populate_by_name=True)
    name: str | None = None
    description: str | None = None
    version: str | None = None
    slot_type: str | None = Field(default=None, alias="slotType")
    tags: list[str] = Field(default_factory=list)
```
Parsed YAML frontmatter from a `SKILL.md` file. All fields optional — many legacy skills lack frontmatter. Skills without `slot_type` can still be used in freeform pack entries but are not eligible for typed slot placement. `[AST:src/skillex/core/models.py:L20]`

### `Skill`

```python
class Skill(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str          # validated against NAME_PATTERN
    path: Path         # absolute path to skill directory
    skill_md_path: Path
    frontmatter: SkillFrontmatter
```
Includes a `_validate_name` field validator that enforces `NAME_PATTERN`. `[AST:src/skillex/core/models.py:L37]`

### `SlotAssignment`

Binding of one slot in a pack manifest to one skill. Fields: `slot_name: str`, `slot_type: str`, `required: bool`, `skill: str | None`. `[AST:src/skillex/core/models.py:L59]`

### `PackManifest`

Raw parsed `pack.toml` structure, pre-resolution. Fields: `name: str`, `version: str = "0.0.0"`, `description: str = ""`, `slots: dict[str, SlotAssignment]`, `freeform_skills: list[str]`. Validates `name` against `NAME_PATTERN`. `[AST:src/skillex/core/models.py:L70]`

### `Pack`

A pack with its manifest and resolved skill references. Fields: `manifest: PackManifest`, `pack_path: Path`, `slot_skills: dict[str, Skill]`, `freeform_skills: list[Skill]`. "Resolved" means each skill reference in the manifest has been matched to an actual `Skill` record from the skills index. Unresolved references cause the loader to raise rather than constructing a `Pack`. `[AST:src/skillex/core/models.py:L89]`

### `CliAdapterConfig`

One entry in the `[cli.*]` section of `skillex.toml`. Fields: `name: str`, `enabled: bool`, `global_root: Path`, `project_root: Path`. `[AST:src/skillex/core/models.py:L105]`

### `ScopeConfig`

Which pack is active at a given scope. Fields: `active_pack: str | None`. `[AST:src/skillex/core/models.py:L116]`

### `SkillexConfig`

Fully resolved `~/.config/skillex/skillex.toml`. Fields: `skills_root: Path`, `packs_root: Path`, `log_format: Literal["console", "json"] = "console"`, `scopes: dict[str, ScopeConfig]`, `cli_adapters: dict[str, CliAdapterConfig]`. `[AST:src/skillex/core/models.py:L124]`

### `LinkOp`

One filesystem operation in an activation plan. Fields: `action: Literal["add", "remove", "keep"]`, `target: Path`, `source: Path`, `cli: str`, `scope: Literal["global", "project"]`. Semantics: `add` creates a symlink at `target` pointing to `source`; `remove` deletes the symlink at `target` (source is informational); `keep` is a no-op for plan display. `[AST:src/skillex/core/models.py:L136]`

## Loader (`src/skillex/core/loader.py`)

### Exception hierarchy

```
LoaderError(Exception)                      [L29]
├── ConfigError                              [L33]   skillex.toml missing or malformed
├── PackError                                [L37]   pack.toml missing or malformed
├── SkillError                               [L41]   skill directory malformed
├── DuplicateSkillError                      [L45]   carries .name and .paths
└── SkillReferenceError                      [L55]   pack references unknown skill
```
Loaders are pure: they parse files into typed models and raise specific exceptions. They do not validate semantic rules — that lives in the linter.

### `load_config(path: Path) -> SkillexConfig` `[L59]`

Loads and validates a `skillex.toml`. Raises `ConfigError` when the file is missing, fails to parse, lacks `[skillex].skills_root`/`packs_root`, or contains an invalid `[cli.{name}]` entry.

### `load_skill(skill_dir: Path) -> Skill` `[L108]`

Loads a single skill directory containing a `SKILL.md`. Skill name is derived from the directory name unless frontmatter overrides it. Raises `SkillError` for missing directory, missing `SKILL.md`, frontmatter parse failure, or validation failure.

### `discover_skills(skills_root: Path) -> dict[str, Skill]` `[L144]`

Scans `skills_root`, skipping hidden directories and entries without a `SKILL.md`. Raises `DuplicateSkillError` if two skills share a name (carries the name and the conflicting paths).

### `load_pack_manifest(pack_toml_path: Path) -> PackManifest` `[L169]`

Parses a `pack.toml` into a `PackManifest`. Does not resolve skill references; see `load_pack`. Raises `PackError`.

### `load_pack(pack_dir: Path, skills_index: dict[str, Skill]) -> Pack` `[L228]`

Loads a pack and resolves its skill references against the supplied index. Raises `SkillReferenceError` when a slot or freeform reference is missing from the index.

## Linter (`src/skillex/core/linter.py`)

### `Severity` (StrEnum)

`ERROR`, `WARN`. `[L20]`

### `RuleCode` (StrEnum) — 8 rules

| Code | When raised |
|------|-------------|
| `SLOT_TYPE_MISMATCH` | Skill's frontmatter `slotType` differs from the slot's required type |
| `SLOT_TYPE_UNKNOWN` | Slot's type is neither canonical nor `custom:*` |
| `REQUIRED_SLOT_EMPTY` | Required slot has no skill assigned |
| `DUPLICATE_SKILL` | A skill name appears in multiple slots or freeform within a pack |
| `UNSLOTTED_IN_SLOT` | Skill has no `slotType` frontmatter but is placed in a typed slot |
| `PACK_NAME_CONFLICT` | Two packs declare the same name (cross-pack rule) |
| `MISSING_FRONTMATTER` | Freeform skill has no frontmatter at all |
| `ORPHAN_SLOT` | Optional slot has no skill assigned (warn-only) |

`[AST:src/skillex/core/linter.py:L25]`

### `LintIssue` (frozen dataclass) `[L37]`

Fields: `severity: Severity`, `rule: RuleCode`, `message: str`, `pack: str`, `location: str`. Returned in lists by lint functions so CLI callers can print full reports without exception flow.

### `lint_pack(pack: Pack, skills_index: dict[str, Skill]) -> list[LintIssue]` `[L45]`

Applies all 8 rules to a single resolved pack.

### `lint_packs(packs: list[Pack], skills_index: dict[str, Skill]) -> list[LintIssue]` `[L177]`

Lints multiple packs together. Catches `PACK_NAME_CONFLICT` cross-pack collisions before delegating each pack to `lint_pack`.

### `has_errors(issues: list[LintIssue]) -> bool` `[L202]`

True iff any issue has `severity is Severity.ERROR`.

## Registry (`src/skillex/core/registry.py`)

### Module-level constants

- `CANONICAL_SLOT_TYPES: frozenset[str] = frozenset({"Memory", "Workflow", "TTS"})` `[L10]`
- `CUSTOM_PREFIX = "custom:"` `[L12]`

### `is_valid_slot_type(name: str) -> bool` `[L15]`

True if `name` is in `CANONICAL_SLOT_TYPES` OR starts with `custom:` and has a non-empty suffix.

### `explain_invalid_slot_type(name: str) -> str` `[L24]`

Produces an actionable error message: distinguishes the "custom: with no suffix" case from the "not in canonical list" case.

## File lock (`src/skillex/core/file_lock.py`)

### `LockBusyError(RuntimeError)` `[L21]`

Raised when the lock is held by a live PID. The message includes the PID and the lock file path.

### `FileLock(path: Path)` — context manager `[L25]`

```python
class FileLock:
    def __init__(self, path: Path) -> None: ...
    def __enter__(self) -> FileLock: ...
    def __exit__(self, exc_type, exc, tb) -> None: ...
    def _read_pid(self) -> int | None: ...
```

Acquisition logic (`__enter__`): creates the parent directory; reads the existing PID if a lock file is present; if the PID is alive (`os.kill(pid, 0)` succeeds or returns `PermissionError`), raises `LockBusyError`; if the PID is dead (`ProcessLookupError`), reclaims the lock; writes the current PID to the file.

Release (`__exit__`): unlinks the lock file (`missing_ok=True`); silently swallows `OSError`. The lock is removed on normal exit and remains on crash; the next invocation will pick it up or reclaim it.

### `_pid_alive(pid: int) -> bool` (private) `[L61]`

Probes via `os.kill(pid, 0)`. `ProcessLookupError` → False. `PermissionError` → True (process exists, we lack signal permission). Other outcomes → True for `pid > 0`.
