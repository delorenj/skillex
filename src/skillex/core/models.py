"""Pydantic models used across skillex.

Keep validation that needs cross-module knowledge (slot registry membership,
filesystem existence) in the registry and loader modules. This file defines
shape and trivial constraints only.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")
"""Canonical pack and skill names: lowercase alphanumerics and dashes, no leading/trailing dash.

This is the name shape the packs contract (section 1) mandates for *new* names and
the shape `skills[]` entries must use.
"""

PACK_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
"""Accepted pack directory/manifest names.

Deliberately wider than :data:`NAME_PATTERN`: the live registry ships
``packs/Kurzgesagt``, and rejecting it outright would silently drop a real pack.
Names that parse here but do not match :data:`NAME_PATTERN` are still flagged by
the linter (``PACK_NAME_NONCANONICAL``, warn) so the drift stays visible.

Still constrained to exactly ONE safe path component - see :func:`is_safe_component`.
"""

VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
"""Accepted pack version / version-directory names, e.g. ``6.10.2``, ``6.10.1-next.31``."""

_UNSAFE_COMPONENTS = frozenset({"", ".", ".."})


def is_safe_component(value: str) -> bool:
    """True when `value` is exactly one path component that cannot escape its parent.

    Rejects empty strings, ``.``/``..``, anything containing a path separator
    (forward or backslash), NUL bytes, and leading/trailing whitespace. This is the
    single gate every pack name, version directory and skill name passes through
    before it is ever joined onto a filesystem path.
    """
    if value in _UNSAFE_COMPONENTS:
        return False
    if value != value.strip():
        return False
    if "/" in value or "\\" in value or "\x00" in value:
        return False
    return Path(value).name == value


def is_safe_relpath(value: str) -> bool:
    """True when `value` is a relative, `/`-separated path with only safe components.

    Used for `SHA256SUMS` entries and `registry_path` overrides. Rejects absolute
    paths, backslashes, and any ``.``/``..``/empty segment (contract section 4 rule 5).
    """
    if not value or "\\" in value or "\x00" in value:
        return False
    if value.startswith("/"):
        return False
    return all(is_safe_component(part) for part in value.split("/"))


class SkillFrontmatter(BaseModel):
    """Parsed YAML frontmatter from a SKILL.md file.

    All fields are optional because many legacy skills lack frontmatter. Skills
    without a slotType can still be used in freeform pack entries but are not
    eligible for typed slot placement.
    """

    model_config = ConfigDict(extra="allow", frozen=True, populate_by_name=True)

    name: str | None = None
    description: str | None = None
    version: str | None = None
    slot_type: str | None = Field(default=None, alias="slotType")
    tags: list[str] = Field(default_factory=list)


class Skill(BaseModel):
    """A skill residing in all-skills/<name>/.

    path is the absolute path to the skill directory. skill_md_path is the
    absolute path to the SKILL.md file inside that directory.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    path: Path
    skill_md_path: Path
    frontmatter: SkillFrontmatter

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not NAME_PATTERN.match(v):
            raise ValueError(f"invalid skill name {v!r}; must match {NAME_PATTERN.pattern}")
        return v


class SlotAssignment(BaseModel):
    """Binding of one slot in a pack manifest to one skill."""

    model_config = ConfigDict(frozen=True)

    slot_name: str
    slot_type: str
    required: bool
    skill: str | None


class PackSource(BaseModel):
    """`[source]` provenance block of a pack.toml.

    `extra="allow"` on purpose: real packs carry bespoke provenance keys
    (`upstream_git`, `harvested_from`, `excluded`, `*_manifest_sha256`) that must
    survive a load/render round-trip rather than being silently dropped.
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    upstream: str | None = None
    upstream_version: str | None = None
    rendered_from: str | None = None
    payload_files: int | None = None

    @field_validator("payload_files")
    @classmethod
    def _validate_payload_files(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError(f"[source].payload_files must be >= 0, got {v}")
        return v


class PackPolicy(BaseModel):
    """`[policy]` block of a pack.toml.

    `immutable` forbids in-place edits/re-render. `sealed` demands checksum
    verification (contract section 4). Note that `immutable` alone does NOT imply
    `sealed`. `flatten` declares a two-level (container/leaf) upstream layout that
    is expanded at PROJECTION time (contract section 3b) - the pack on disk keeps
    the nesting verbatim. `extra="allow"` because packs in the wild carry extra
    policy keys (`overlay_wins`, `base_readonly`).
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    immutable: bool = False
    sealed: bool = False
    flatten: bool = False
    project_projection: str | None = None


class PackManifest(BaseModel):
    """Raw parsed pack.toml structure, pre-resolution."""

    model_config = ConfigDict(frozen=True)

    name: str
    version: str = "0.0.0"
    description: str = ""
    slots: dict[str, SlotAssignment] = Field(default_factory=dict)
    freeform_skills: list[str] = Field(default_factory=list)
    source: PackSource = Field(default_factory=PackSource)
    policy: PackPolicy = Field(default_factory=PackPolicy)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PACK_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack name {v!r}; must match {PACK_NAME_PATTERN.pattern}")
        return v

    @field_validator("version")
    @classmethod
    def _validate_version(cls, v: str) -> str:
        if not VERSION_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack version {v!r}; must match {VERSION_PATTERN.pattern}")
        return v

    @property
    def is_canonical_name(self) -> bool:
        """True when the pack name also satisfies the strict contract name shape."""
        return bool(NAME_PATTERN.match(self.name))


class Pack(BaseModel):
    """A pack with its manifest and (optionally) resolved skill references.

    `slot_skills`/`freeform_skills` are populated only when the pack was loaded
    against a skills index (:func:`skillex.core.loader.load_pack`). Self-contained
    packs - the ones the packs contract describes, which ship their skill
    directories inside the pack root - are loaded by
    :func:`skillex.core.loader.load_pack_standalone` and carry their inventory in
    `manifest.freeform_skills` with no index resolution.
    """

    model_config = ConfigDict(frozen=True)

    manifest: PackManifest
    pack_path: Path
    slot_skills: dict[str, Skill] = Field(default_factory=dict)
    freeform_skills: list[Skill] = Field(default_factory=list)
    manifest_path: Path | None = None
    """Absolute path to pack.toml, or None for a pack.toml-less pack."""
    dir_name: str | None = None
    """Directory name the pack lives under (`packs/<dir_name>[/<version_dir>]`)."""
    version_dir: str | None = None
    """Version directory name, or None for a flat/unversioned pack."""

    @property
    def has_manifest(self) -> bool:
        return self.manifest_path is not None

    @property
    def inventory(self) -> list[str]:
        """Declared skill names: `[freeform].skills`, or the globbed dirs when no pack.toml."""
        return list(self.manifest.freeform_skills)


class PackEntry(BaseModel):
    """One entry of a skills.json `packs[]` array (contract section 1)."""

    model_config = ConfigDict(frozen=True)

    name: str
    version: str | None = None
    source: str | None = None
    registry: str | None = None
    registry_path: str | None = None
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    optional: bool = False
    sealed: bool | None = None
    flatten: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not PACK_NAME_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack name {v!r}; must match {PACK_NAME_PATTERN.pattern}")
        return v

    @field_validator("version")
    @classmethod
    def _validate_version(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not VERSION_PATTERN.match(v) or not is_safe_component(v):
            raise ValueError(f"invalid pack version {v!r}; must match {VERSION_PATTERN.pattern}")
        return v

    @field_validator("registry_path")
    @classmethod
    def _validate_registry_path(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not is_safe_relpath(v):
            raise ValueError(
                f"invalid registry_path {v!r}; must be a relative, /-separated path "
                "with no '.', '..' or empty segments"
            )
        return v

    @field_validator("include", "exclude")
    @classmethod
    def _validate_filter_names(cls, v: tuple[str, ...]) -> tuple[str, ...]:
        for name in v:
            if not is_safe_component(name):
                raise ValueError(f"invalid skill name {name!r}; must be one safe path component")
        return v

    @model_validator(mode="after")
    def _validate_exclusivity(self) -> PackEntry:
        if self.source is not None and self.registry_path is not None:
            raise ValueError("pack entry may not set both 'source' and 'registry_path'")
        return self

    @classmethod
    def from_spec(cls, spec: str | dict[str, object]) -> PackEntry:
        """Build an entry from the string shorthand or the object form.

        `"bmad"` -> name only; `"bmad@6.10.2"` -> name + version.
        """
        if isinstance(spec, str):
            name, sep, version = spec.partition("@")
            return cls(name=name, version=version if sep else None)
        return cls.model_validate(spec)

    def filter_inventory(self, names: list[str]) -> list[str]:
        """Apply `include` then `exclude` to a declared inventory, preserving order."""
        selected = [n for n in names if n in self.include] if self.include else list(names)
        if self.exclude:
            selected = [n for n in selected if n not in self.exclude]
        return selected

    def is_sealed(self, manifest_sealed: bool) -> bool:
        """Resolve the effective sealed flag.

        `sealed` in the manifest may only TIGHTEN: `sealed: false` MUST NOT disable
        a pack.toml that declares `[policy] sealed = true`.
        """
        return manifest_sealed or bool(self.sealed)

    def is_flattened(self, pack_flatten: bool) -> bool:
        """Resolve the effective flatten flag (contract section 3b).

        Enabled when EITHER the pack's `pack.toml` declares `[policy] flatten = true`
        OR this manifest entry sets `"flatten": true`. Layout is a property of the
        pack, so `pack.toml` is the natural home; the manifest field exists for packs
        that ship no `pack.toml`. Like `sealed`, the manifest may only TIGHTEN -
        `"flatten": false` does not un-flatten a pack that declares the layout.
        """
        return pack_flatten or bool(self.flatten)


class SkillsManifest(BaseModel):
    """The subset of a skills.json manifest this CLI reads."""

    model_config = ConfigDict(frozen=True)

    path: Path
    schema_url: str | None = None
    scope: str | None = None
    inherit_global: bool | None = None
    registry: str | None = None
    packs: tuple[PackEntry, ...] = ()


class CliAdapterConfig(BaseModel):
    """One entry in the [cli.*] section of skillex.toml."""

    model_config = ConfigDict(frozen=True)

    name: str
    enabled: bool
    global_root: Path
    project_root: Path


class ScopeConfig(BaseModel):
    """Which pack is active at a given scope."""

    model_config = ConfigDict(frozen=True)

    active_pack: str | None = None


class SkillexConfig(BaseModel):
    """Fully resolved ~/.config/skillex/skillex.toml."""

    model_config = ConfigDict(frozen=True)

    skills_root: Path
    packs_root: Path
    log_format: Literal["console", "json"] = "console"
    scopes: dict[str, ScopeConfig] = Field(default_factory=dict)
    cli_adapters: dict[str, CliAdapterConfig] = Field(default_factory=dict)


class LinkOp(BaseModel):
    """One filesystem operation in an activation plan.

    action=add creates a symlink at target pointing to source.
    action=remove deletes the symlink at target (source is informational).
    action=keep is a no-op, used only for plan display.
    """

    model_config = ConfigDict(frozen=True)

    action: Literal["add", "remove", "keep"]
    target: Path
    source: Path
    cli: str
    scope: Literal["global", "project"]
