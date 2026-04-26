"""Tests for skillex.core.loader."""

from __future__ import annotations

from pathlib import Path

import pytest

from skillex.core.loader import (
    ConfigError,
    DuplicateSkillError,
    PackError,
    SkillError,
    SkillReferenceError,
    discover_skills,
    load_config,
    load_pack,
    load_pack_manifest,
    load_skill,
)


@pytest.fixture
def skills_fixture(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_skills"


@pytest.fixture
def pack_fixture(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_pack"


class TestLoadSkill:
    def test_loads_slotted_skill(self, skills_fixture: Path) -> None:
        skill = load_skill(skills_fixture / "hindsight")
        assert skill.name == "hindsight"
        assert skill.frontmatter.slot_type == "Memory"
        assert skill.frontmatter.description == "Shared team memory persistence across sessions"

    def test_loads_unslotted_skill(self, skills_fixture: Path) -> None:
        skill = load_skill(skills_fixture / "mermaid-expert")
        assert skill.name == "mermaid-expert"
        assert skill.frontmatter.slot_type is None

    def test_missing_directory_raises(self, tmp_path: Path) -> None:
        with pytest.raises(SkillError, match="not a directory"):
            load_skill(tmp_path / "nonexistent")

    def test_missing_skill_md_raises(self, tmp_path: Path) -> None:
        (tmp_path / "bad-skill").mkdir()
        with pytest.raises(SkillError, match=r"no SKILL\.md"):
            load_skill(tmp_path / "bad-skill")


class TestDiscoverSkills:
    def test_finds_all_fixture_skills(self, skills_fixture: Path) -> None:
        index = discover_skills(skills_fixture)
        assert set(index.keys()) == {"hindsight", "n8n-bridge", "mermaid-expert"}

    def test_missing_root_raises(self, tmp_path: Path) -> None:
        with pytest.raises(SkillError, match="does not exist"):
            discover_skills(tmp_path / "nonexistent")

    def test_duplicate_names_raise(self, tmp_path: Path) -> None:
        for subdir in ("dup-a", "dup-b"):
            skill_dir = tmp_path / subdir
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: duplicate\n---\n# x\n", encoding="utf-8"
            )
        with pytest.raises(DuplicateSkillError) as exc:
            discover_skills(tmp_path)
        assert exc.value.name == "duplicate"
        assert len(exc.value.paths) == 2

    def test_skips_hidden_dirs(self, tmp_path: Path) -> None:
        (tmp_path / ".hidden").mkdir()
        (tmp_path / ".hidden" / "SKILL.md").write_text("# x\n", encoding="utf-8")
        index = discover_skills(tmp_path)
        assert index == {}


class TestLoadPackManifest:
    def test_loads_fixture(self, pack_fixture: Path) -> None:
        manifest = load_pack_manifest(pack_fixture / "pack.toml")
        assert manifest.name == "test-pack"
        assert manifest.slots["memory"].slot_type == "Memory"
        assert manifest.slots["memory"].required is True
        assert manifest.slots["workflow"].required is False
        assert manifest.freeform_skills == ["mermaid-expert"]

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(PackError, match="not found"):
            load_pack_manifest(tmp_path / "nope.toml")

    def test_missing_name_raises(self, tmp_path: Path) -> None:
        (tmp_path / "pack.toml").write_text("[pack]\nversion = '0.1.0'\n", encoding="utf-8")
        with pytest.raises(PackError, match=r"missing \[pack\]\.name"):
            load_pack_manifest(tmp_path / "pack.toml")

    def test_custom_slot_type_passthrough(self, tmp_path: Path) -> None:
        (tmp_path / "pack.toml").write_text(
            """
[pack]
name = "custom-pack"
["slots.custom:voice"]
required = false
skill = "elevenlabs"
""".strip(),
            encoding="utf-8",
        )
        # Note: TOML doesn't accept colons in bare keys; verify via explicit type override
        (tmp_path / "pack.toml").write_text(
            """
[pack]
name = "custom-pack"

[slots.voice]
type = "custom:voice"
required = false
skill = "elevenlabs"
""".strip(),
            encoding="utf-8",
        )
        manifest = load_pack_manifest(tmp_path / "pack.toml")
        assert manifest.slots["voice"].slot_type == "custom:voice"


class TestLoadPack:
    def test_loads_and_resolves_skills(
        self, pack_fixture: Path, skills_fixture: Path
    ) -> None:
        index = discover_skills(skills_fixture)
        pack = load_pack(pack_fixture, index)
        assert pack.manifest.name == "test-pack"
        assert pack.slot_skills["memory"].name == "hindsight"
        assert pack.slot_skills["workflow"].name == "n8n-bridge"
        assert len(pack.freeform_skills) == 1
        assert pack.freeform_skills[0].name == "mermaid-expert"

    def test_unknown_skill_reference_raises(
        self, pack_fixture: Path, skills_fixture: Path
    ) -> None:
        # Provide an empty index so references fail.
        with pytest.raises(SkillReferenceError, match="unknown skill"):
            load_pack(pack_fixture, {})


class TestLoadConfig:
    def test_loads_minimal_config(self, tmp_path: Path) -> None:
        config_path = tmp_path / "skillex.toml"
        config_path.write_text(
            """
[skillex]
skills_root = "/tmp/all-skills"
packs_root = "/tmp/packs"

[scopes.global]
active_pack = "foo"

[cli.claude]
enabled = true
global_root = "~/.claude"
project_root = ".claude"
""".strip(),
            encoding="utf-8",
        )
        cfg = load_config(config_path)
        assert cfg.skills_root == Path("/tmp/all-skills")
        assert cfg.scopes["global"].active_pack == "foo"
        assert "claude" in cfg.cli_adapters
        assert cfg.cli_adapters["claude"].enabled is True

    def test_missing_config_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError, match="not found"):
            load_config(tmp_path / "missing.toml")

    def test_missing_required_fields_raise(self, tmp_path: Path) -> None:
        config_path = tmp_path / "skillex.toml"
        config_path.write_text("[skillex]\n", encoding="utf-8")
        with pytest.raises(ConfigError, match="skills_root"):
            load_config(config_path)
