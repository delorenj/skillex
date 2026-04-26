"""Loaders for skillex.toml, pack.toml, and SKILL.md frontmatter.

Loaders are pure: they parse files into typed models and raise specific
exceptions. They do not validate semantic rules (slot type membership,
required-slot presence). Semantic rules live in the linter.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import frontmatter
from pydantic import ValidationError

from skillex.core.models import (
    CliAdapterConfig,
    Pack,
    PackManifest,
    ScopeConfig,
    Skill,
    SkillexConfig,
    SkillFrontmatter,
    SlotAssignment,
)


class LoaderError(Exception):
    """Base class for loader errors."""


class ConfigError(LoaderError):
    """Raised when skillex.toml is missing or malformed."""


class PackError(LoaderError):
    """Raised when a pack.toml is missing or malformed."""


class SkillError(LoaderError):
    """Raised when a skill directory is malformed."""


class DuplicateSkillError(LoaderError):
    """Raised when two skills share the same name in the skills root."""

    def __init__(self, name: str, paths: list[Path]) -> None:
        path_list = ", ".join(str(p) for p in paths)
        super().__init__(f"duplicate skill name {name!r} found at: {path_list}")
        self.name = name
        self.paths = paths


class SkillReferenceError(LoaderError):
    """Raised when a pack references a skill that does not exist."""


def load_config(path: Path) -> SkillexConfig:
    """Load and validate a skillex.toml file."""
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"failed to parse {path}: {e}") from e

    skillex_section = raw.get("skillex", {})
    scopes_section = raw.get("scopes", {})
    cli_section = raw.get("cli", {})

    skills_root = skillex_section.get("skills_root")
    packs_root = skillex_section.get("packs_root")
    if skills_root is None or packs_root is None:
        raise ConfigError(
            f"{path} missing required fields [skillex].skills_root and/or [skillex].packs_root"
        )

    scopes: dict[str, ScopeConfig] = {
        scope_name: ScopeConfig(active_pack=cfg.get("active_pack"))
        for scope_name, cfg in scopes_section.items()
    }

    cli_adapters: dict[str, CliAdapterConfig] = {}
    for cli_name, cli_cfg in cli_section.items():
        try:
            cli_adapters[cli_name] = CliAdapterConfig(
                name=cli_name,
                enabled=bool(cli_cfg.get("enabled", True)),
                global_root=Path(cli_cfg["global_root"]).expanduser(),
                project_root=Path(cli_cfg["project_root"]),
            )
        except (KeyError, ValidationError) as e:
            raise ConfigError(f"invalid [cli.{cli_name}] entry in {path}: {e}") from e

    try:
        return SkillexConfig(
            skills_root=Path(skills_root).expanduser(),
            packs_root=Path(packs_root).expanduser(),
            log_format=skillex_section.get("log_format", "console"),
            scopes=scopes,
            cli_adapters=cli_adapters,
        )
    except ValidationError as e:
        raise ConfigError(f"invalid skillex config in {path}: {e}") from e


def load_skill(skill_dir: Path) -> Skill:
    """Load a single skill directory containing a SKILL.md file.

    The skill name is derived from the directory name unless frontmatter
    overrides it. This keeps directory structure and skill identity linked
    for symlink targeting.
    """
    if not skill_dir.is_dir():
        raise SkillError(f"not a directory: {skill_dir}")

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        raise SkillError(f"no SKILL.md in {skill_dir}")

    try:
        post = frontmatter.load(skill_md)
    except Exception as e:
        raise SkillError(f"failed to parse frontmatter in {skill_md}: {e}") from e

    try:
        fm = SkillFrontmatter.model_validate(dict(post.metadata))
    except ValidationError as e:
        raise SkillError(f"invalid frontmatter in {skill_md}: {e}") from e

    name = fm.name or skill_dir.name
    try:
        return Skill(
            name=name,
            path=skill_dir.resolve(),
            skill_md_path=skill_md.resolve(),
            frontmatter=fm,
        )
    except ValidationError as e:
        raise SkillError(f"invalid skill at {skill_dir}: {e}") from e


def discover_skills(skills_root: Path) -> dict[str, Skill]:
    """Discover all skills under skills_root.

    Skips hidden directories and anything without a SKILL.md. Raises on
    duplicate names to prevent ambiguous references.
    """
    if not skills_root.is_dir():
        raise SkillError(f"skills root does not exist or is not a directory: {skills_root}")

    index: dict[str, list[Skill]] = {}
    for child in sorted(skills_root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if not (child / "SKILL.md").is_file():
            continue
        skill = load_skill(child)
        index.setdefault(skill.name, []).append(skill)

    for name, skills in index.items():
        if len(skills) > 1:
            raise DuplicateSkillError(name, [s.path for s in skills])

    return {name: skills[0] for name, skills in index.items()}


def load_pack_manifest(pack_toml_path: Path) -> PackManifest:
    """Parse a pack.toml into a PackManifest.

    Does not resolve skill references against the index; see load_pack.
    """
    if not pack_toml_path.is_file():
        raise PackError(f"pack manifest not found: {pack_toml_path}")

    try:
        raw = tomllib.loads(pack_toml_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise PackError(f"failed to parse {pack_toml_path}: {e}") from e

    pack_section = raw.get("pack", {})
    slots_section = raw.get("slots", {})
    freeform_section = raw.get("freeform", {})

    if "name" not in pack_section:
        raise PackError(f"{pack_toml_path} missing [pack].name")

    slots: dict[str, SlotAssignment] = {}
    for slot_name, slot_cfg in slots_section.items():
        slot_type = _derive_slot_type(slot_name, slot_cfg)
        slots[slot_name] = SlotAssignment(
            slot_name=slot_name,
            slot_type=slot_type,
            required=bool(slot_cfg.get("required", False)),
            skill=slot_cfg.get("skill"),
        )

    freeform_skills = list(freeform_section.get("skills", []))

    try:
        return PackManifest(
            name=pack_section["name"],
            version=pack_section.get("version", "0.0.0"),
            description=pack_section.get("description", ""),
            slots=slots,
            freeform_skills=freeform_skills,
        )
    except ValidationError as e:
        raise PackError(f"invalid pack manifest at {pack_toml_path}: {e}") from e


def _derive_slot_type(slot_name: str, slot_cfg: dict[str, Any]) -> str:
    """Derive the slot type from slot_name.

    Convention: slot key is the slot type with first letter lowered. Custom
    slots use the full `custom:foo` identifier. If `type` is explicitly set
    in the cfg dict, that wins.
    """
    explicit = slot_cfg.get("type")
    if isinstance(explicit, str):
        return explicit
    if slot_name.startswith("custom:"):
        return slot_name
    return slot_name[:1].upper() + slot_name[1:]


def load_pack(pack_dir: Path, skills_index: dict[str, Skill]) -> Pack:
    """Load a pack and resolve its skill references against the index."""
    manifest = load_pack_manifest(pack_dir / "pack.toml")

    slot_skills: dict[str, Skill] = {}
    for slot_name, assignment in manifest.slots.items():
        if assignment.skill is None:
            continue
        if assignment.skill not in skills_index:
            raise SkillReferenceError(
                f"pack {manifest.name!r} slot {slot_name!r} references unknown skill "
                f"{assignment.skill!r}"
            )
        slot_skills[slot_name] = skills_index[assignment.skill]

    freeform_resolved: list[Skill] = []
    for skill_name in manifest.freeform_skills:
        if skill_name not in skills_index:
            raise SkillReferenceError(
                f"pack {manifest.name!r} freeform references unknown skill {skill_name!r}"
            )
        freeform_resolved.append(skills_index[skill_name])

    return Pack(
        manifest=manifest,
        pack_path=pack_dir.resolve(),
        slot_skills=slot_skills,
        freeform_skills=freeform_resolved,
    )
