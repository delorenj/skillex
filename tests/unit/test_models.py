"""Tests for skillex.core.models."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from skillex.core.models import (
    CliAdapterConfig,
    LinkOp,
    Pack,
    PackManifest,
    ScopeConfig,
    Skill,
    SkillexConfig,
    SkillFrontmatter,
    SlotAssignment,
)


class TestSkillFrontmatter:
    def test_empty_is_valid(self) -> None:
        fm = SkillFrontmatter()
        assert fm.slot_type is None
        assert fm.tags == []

    def test_slot_type_alias(self) -> None:
        fm = SkillFrontmatter.model_validate({"slotType": "Memory"})
        assert fm.slot_type == "Memory"

    def test_extra_fields_preserved(self) -> None:
        fm = SkillFrontmatter.model_validate({"name": "x", "homepage": "https://example.com"})
        assert fm.name == "x"


class TestSkill:
    def test_valid_skill(self, tmp_path: Path) -> None:
        skill = Skill(
            name="hindsight",
            path=tmp_path / "hindsight",
            skill_md_path=tmp_path / "hindsight" / "SKILL.md",
            frontmatter=SkillFrontmatter(),
        )
        assert skill.name == "hindsight"

    def test_invalid_name_rejects_uppercase(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="invalid skill name"):
            Skill(
                name="Hindsight",
                path=tmp_path / "Hindsight",
                skill_md_path=tmp_path / "Hindsight" / "SKILL.md",
                frontmatter=SkillFrontmatter(),
            )

    def test_invalid_name_rejects_underscore(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="invalid skill name"):
            Skill(
                name="my_skill",
                path=tmp_path / "my_skill",
                skill_md_path=tmp_path / "my_skill" / "SKILL.md",
                frontmatter=SkillFrontmatter(),
            )


class TestPackManifest:
    def test_minimal_manifest(self) -> None:
        pm = PackManifest(name="33god-dev")
        assert pm.version == "0.0.0"
        assert pm.slots == {}

    def test_invalid_name_rejected(self) -> None:
        with pytest.raises(ValidationError, match="invalid pack name"):
            PackManifest(name="Bad Name!")

    def test_with_slots(self) -> None:
        pm = PackManifest(
            name="test-pack",
            slots={
                "memory": SlotAssignment(
                    slot_name="memory",
                    slot_type="Memory",
                    required=True,
                    skill="hindsight",
                ),
            },
        )
        assert pm.slots["memory"].skill == "hindsight"


class TestCliAdapterConfig:
    def test_valid(self, tmp_path: Path) -> None:
        cfg = CliAdapterConfig(
            name="claude",
            enabled=True,
            global_root=tmp_path / "claude",
            project_root=Path(".claude"),
        )
        assert cfg.enabled


class TestSkillexConfig:
    def test_minimal(self, tmp_path: Path) -> None:
        cfg = SkillexConfig(
            skills_root=tmp_path / "all-skills",
            packs_root=tmp_path / "packs",
        )
        assert cfg.log_format == "console"
        assert cfg.scopes == {}

    def test_with_scopes_and_adapters(self, tmp_path: Path) -> None:
        cfg = SkillexConfig(
            skills_root=tmp_path / "all-skills",
            packs_root=tmp_path / "packs",
            scopes={"global": ScopeConfig(active_pack="33god-dev")},
            cli_adapters={
                "claude": CliAdapterConfig(
                    name="claude",
                    enabled=True,
                    global_root=tmp_path / "claude",
                    project_root=Path(".claude"),
                ),
            },
        )
        assert cfg.scopes["global"].active_pack == "33god-dev"
        assert "claude" in cfg.cli_adapters


class TestLinkOp:
    def test_add_link(self, tmp_path: Path) -> None:
        op = LinkOp(
            action="add",
            target=tmp_path / "target",
            source=tmp_path / "source",
            cli="claude",
            scope="global",
        )
        assert op.action == "add"

    def test_invalid_action_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError):
            LinkOp(
                action="wat",  # type: ignore[arg-type]
                target=tmp_path / "target",
                source=tmp_path / "source",
                cli="claude",
                scope="global",
            )


class TestPack:
    def test_pack_with_resolved_skills(self, tmp_path: Path) -> None:
        skill = Skill(
            name="hindsight",
            path=tmp_path / "hindsight",
            skill_md_path=tmp_path / "hindsight" / "SKILL.md",
            frontmatter=SkillFrontmatter(slot_type="Memory"),
        )
        pack = Pack(
            manifest=PackManifest(name="test-pack"),
            pack_path=tmp_path / "packs" / "test-pack",
            slot_skills={"memory": skill},
        )
        assert pack.slot_skills["memory"].name == "hindsight"
