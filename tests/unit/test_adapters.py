"""Contract tests for each CLI adapter."""

from __future__ import annotations

from pathlib import Path

import pytest

from skillex.adapters import (  # noqa: F401 -- register side effect
    claude,
    codex,
    gemini,
    hermes,
    kimi,
    opencode,
)
from skillex.adapters.base import Scope, all_adapters, get_adapter
from skillex.core.models import Skill, SkillFrontmatter


@pytest.fixture
def sample_skill(tmp_path: Path) -> Skill:
    skill_dir = tmp_path / "hindsight"
    skill_dir.mkdir()
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("---\nname: hindsight\n---\n# x\n", encoding="utf-8")
    return Skill(
        name="hindsight",
        path=skill_dir,
        skill_md_path=skill_md,
        frontmatter=SkillFrontmatter(slot_type="Memory"),
    )


class TestAdapterRegistry:
    def test_all_six_registered(self) -> None:
        names = set(all_adapters())
        assert {"claude", "codex", "gemini", "hermes", "kimi", "opencode"} <= names

    def test_get_unknown_raises(self) -> None:
        with pytest.raises(KeyError):
            get_adapter("doesnotexist")


class TestClaudeAdapter:
    def test_renders_directory_symlink(self, sample_skill: Skill, tmp_path: Path) -> None:
        adapter = get_adapter("claude")
        scope_root = tmp_path / ".claude"
        scope: Scope = "global"
        ops = adapter.render_links(sample_skill, scope_root, scope)

        assert len(ops) == 1
        op = ops[0]
        assert op.action == "add"
        assert op.target == scope_root / "skills" / "hindsight"
        assert op.source == sample_skill.path
        assert op.cli == "claude"
        assert op.scope == "global"


class TestCodexAdapter:
    def test_renders_file_symlink(self, sample_skill: Skill, tmp_path: Path) -> None:
        adapter = get_adapter("codex")
        scope_root = tmp_path / ".codex"
        ops = adapter.render_links(sample_skill, scope_root, "global")

        assert len(ops) == 1
        op = ops[0]
        assert op.target == scope_root / "prompts" / "hindsight.md"
        assert op.source == sample_skill.skill_md_path
        assert op.cli == "codex"


class TestOpenCodeAdapter:
    def test_renders_agent_file_symlink(self, sample_skill: Skill, tmp_path: Path) -> None:
        adapter = get_adapter("opencode")
        scope_root = tmp_path / ".opencode"
        ops = adapter.render_links(sample_skill, scope_root, "project")

        assert len(ops) == 1
        op = ops[0]
        assert op.target == scope_root / "agent" / "hindsight.md"
        assert op.source == sample_skill.skill_md_path
        assert op.cli == "opencode"
        assert op.scope == "project"


class TestGeminiAdapter:
    def test_renders_global_config_skill_directory(
        self, sample_skill: Skill, tmp_path: Path
    ) -> None:
        adapter = get_adapter("gemini")
        scope_root = tmp_path / ".gemini"
        ops = adapter.render_links(sample_skill, scope_root, "global")

        assert len(ops) == 1
        op = ops[0]
        assert op.target == scope_root / "config" / "skills" / "hindsight"
        assert op.source == sample_skill.path
        assert op.cli == "gemini"

    def test_renders_project_skill_directory(self, sample_skill: Skill, tmp_path: Path) -> None:
        adapter = get_adapter("gemini")
        scope_root = tmp_path / ".gemini"
        ops = adapter.render_links(sample_skill, scope_root, "project")

        assert len(ops) == 1
        assert ops[0].target == scope_root / "skills" / "hindsight"


class TestKimiAdapter:
    def test_renders_skill_directory(self, sample_skill: Skill, tmp_path: Path) -> None:
        adapter = get_adapter("kimi")
        scope_root = tmp_path / ".kimi-code"
        ops = adapter.render_links(sample_skill, scope_root, "global")

        assert len(ops) == 1
        op = ops[0]
        assert op.target == scope_root / "skills" / "hindsight"
        assert op.source == sample_skill.path
        assert op.cli == "kimi"


class TestHermesAdapter:
    def test_renders_skill_directory(self, sample_skill: Skill, tmp_path: Path) -> None:
        adapter = get_adapter("hermes")
        scope_root = tmp_path / ".hermes"
        ops = adapter.render_links(sample_skill, scope_root, "project")

        assert len(ops) == 1
        op = ops[0]
        assert op.target == scope_root / "skills" / "hindsight"
        assert op.source == sample_skill.path
        assert op.cli == "hermes"
        assert op.scope == "project"


class TestAdapterParity:
    def test_same_skill_six_distinct_targets(self, sample_skill: Skill, tmp_path: Path) -> None:
        """Six adapters produce six distinct LinkOp targets for the same skill."""
        targets: set[Path] = set()
        for cli in ("claude", "codex", "opencode", "gemini", "kimi", "hermes"):
            scope_root = tmp_path / f".{cli}"
            ops = get_adapter(cli).render_links(sample_skill, scope_root, "global")
            assert len(ops) == 1
            targets.add(ops[0].target)
        assert len(targets) == 6
