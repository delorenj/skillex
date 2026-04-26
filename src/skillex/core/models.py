"""Pydantic models used across skillex.

Keep validation that needs cross-module knowledge (slot registry membership,
filesystem existence) in the registry and loader modules. This file defines
shape and trivial constraints only.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")
"""Valid pack and skill names: lowercase alphanumerics and dashes, no leading/trailing dash."""


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


class PackManifest(BaseModel):
    """Raw parsed pack.toml structure, pre-resolution."""

    model_config = ConfigDict(frozen=True)

    name: str
    version: str = "0.0.0"
    description: str = ""
    slots: dict[str, SlotAssignment] = Field(default_factory=dict)
    freeform_skills: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not NAME_PATTERN.match(v):
            raise ValueError(f"invalid pack name {v!r}; must match {NAME_PATTERN.pattern}")
        return v


class Pack(BaseModel):
    """A pack with its manifest and resolved skill references.

    Resolved means each skill reference in the manifest has been matched to an
    actual Skill record from the skills index. Unresolved references cause the
    loader to raise rather than constructing a Pack.
    """

    model_config = ConfigDict(frozen=True)

    manifest: PackManifest
    pack_path: Path
    slot_skills: dict[str, Skill] = Field(default_factory=dict)
    freeform_skills: list[Skill] = Field(default_factory=list)


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
