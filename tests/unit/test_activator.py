"""Tests for skillex.core.activator."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from skillex.adapters import (  # noqa: F401 -- registration
    claude,
    codex,
    gemini,
    hermes,
    kimi,
    opencode,
)
from skillex.core.activator import ActivationError, apply, plan
from skillex.core.models import (
    CliAdapterConfig,
    Pack,
    PackManifest,
    Skill,
    SkillexConfig,
    SkillFrontmatter,
    SlotAssignment,
)


@pytest.fixture
def tmp_tree(tmp_path: Path) -> Path:
    """Tmp tree with all-skills/, scope roots, and skillex config dir."""
    (tmp_path / "all-skills" / "hindsight").mkdir(parents=True)
    (tmp_path / "all-skills" / "hindsight" / "SKILL.md").write_text(
        "---\nname: hindsight\nslotType: Memory\n---\n# x\n", encoding="utf-8"
    )
    (tmp_path / "all-skills" / "n8n-bridge").mkdir()
    (tmp_path / "all-skills" / "n8n-bridge" / "SKILL.md").write_text(
        "---\nname: n8n-bridge\nslotType: Workflow\n---\n# x\n", encoding="utf-8"
    )
    (tmp_path / "global-claude").mkdir()
    (tmp_path / "global-codex").mkdir()
    (tmp_path / "global-opencode").mkdir()
    (tmp_path / "global-gemini").mkdir()
    (tmp_path / "global-kimi").mkdir()
    (tmp_path / "global-hermes").mkdir()
    (tmp_path / "config").mkdir()
    return tmp_path


def _make_config(tmp_tree: Path) -> SkillexConfig:
    return SkillexConfig(
        skills_root=tmp_tree / "all-skills",
        packs_root=tmp_tree / "packs",
        cli_adapters={
            "claude": CliAdapterConfig(
                name="claude",
                enabled=True,
                global_root=tmp_tree / "global-claude",
                project_root=Path(".claude"),
            ),
            "codex": CliAdapterConfig(
                name="codex",
                enabled=True,
                global_root=tmp_tree / "global-codex",
                project_root=Path(".codex"),
            ),
            "opencode": CliAdapterConfig(
                name="opencode",
                enabled=True,
                global_root=tmp_tree / "global-opencode",
                project_root=Path(".opencode"),
            ),
            "gemini": CliAdapterConfig(
                name="gemini",
                enabled=True,
                global_root=tmp_tree / "global-gemini",
                project_root=Path(".gemini"),
            ),
            "kimi": CliAdapterConfig(
                name="kimi",
                enabled=True,
                global_root=tmp_tree / "global-kimi",
                project_root=Path(".kimi-code"),
            ),
            "hermes": CliAdapterConfig(
                name="hermes",
                enabled=True,
                global_root=tmp_tree / "global-hermes",
                project_root=Path(".hermes"),
            ),
        },
    )


def _make_pack(tmp_tree: Path) -> Pack:
    hindsight = Skill(
        name="hindsight",
        path=tmp_tree / "all-skills" / "hindsight",
        skill_md_path=tmp_tree / "all-skills" / "hindsight" / "SKILL.md",
        frontmatter=SkillFrontmatter(slot_type="Memory"),
    )
    n8n = Skill(
        name="n8n-bridge",
        path=tmp_tree / "all-skills" / "n8n-bridge",
        skill_md_path=tmp_tree / "all-skills" / "n8n-bridge" / "SKILL.md",
        frontmatter=SkillFrontmatter(slot_type="Workflow"),
    )
    manifest = PackManifest(
        name="test-pack",
        slots={
            "memory": SlotAssignment(
                slot_name="memory",
                slot_type="Memory",
                required=True,
                skill="hindsight",
            ),
            "workflow": SlotAssignment(
                slot_name="workflow",
                slot_type="Workflow",
                required=False,
                skill="n8n-bridge",
            ),
        },
    )
    return Pack(
        manifest=manifest,
        pack_path=tmp_tree / "packs" / "test-pack",
        slot_skills={"memory": hindsight, "workflow": n8n},
    )


class TestPlan:
    def test_fresh_plan_has_add_ops_for_all_six_clis(self, tmp_tree: Path) -> None:
        cfg = _make_config(tmp_tree)
        pack = _make_pack(tmp_tree)
        ops = plan(pack, "global", cfg)

        add_ops = [o for o in ops if o.action == "add"]
        # 2 skills x 6 CLIs = 12 add ops
        assert len(add_ops) == 12
        clis = {o.cli for o in add_ops}
        assert clis == {"claude", "codex", "opencode", "gemini", "kimi", "hermes"}

    def test_plan_is_idempotent(self, tmp_tree: Path) -> None:
        cfg = _make_config(tmp_tree)
        pack = _make_pack(tmp_tree)

        ops = plan(pack, "global", cfg)
        apply(ops, lock_path=tmp_tree / "config" / ".lock")

        ops2 = plan(pack, "global", cfg)
        assert [o for o in ops2 if o.action == "add"] == []
        assert [o for o in ops2 if o.action == "remove"] == []
        # All should be keep ops.
        assert all(o.action == "keep" for o in ops2)

    def test_disabled_cli_skipped(self, tmp_tree: Path) -> None:
        cfg = _make_config(tmp_tree)
        cfg = cfg.model_copy(
            update={
                "cli_adapters": {
                    **cfg.cli_adapters,
                    "codex": cfg.cli_adapters["codex"].model_copy(update={"enabled": False}),
                }
            }
        )
        pack = _make_pack(tmp_tree)
        ops = plan(pack, "global", cfg)
        clis = {o.cli for o in ops}
        assert "codex" not in clis
        assert {"claude", "opencode"} <= clis


class TestApply:
    def test_dry_run_does_not_mutate(self, tmp_tree: Path) -> None:
        cfg = _make_config(tmp_tree)
        pack = _make_pack(tmp_tree)
        ops = plan(pack, "global", cfg)
        apply(ops, lock_path=tmp_tree / "config" / ".lock", dry_run=True)

        assert not (tmp_tree / "global-claude" / "skills").exists()
        assert not (tmp_tree / "global-codex" / "prompts").exists()
        assert not (tmp_tree / "global-opencode" / "agent").exists()
        assert not (tmp_tree / "global-gemini" / "config" / "skills").exists()
        assert not (tmp_tree / "global-kimi" / "skills").exists()
        assert not (tmp_tree / "global-hermes" / "skills").exists()

    def test_apply_creates_symlinks(self, tmp_tree: Path) -> None:
        cfg = _make_config(tmp_tree)
        pack = _make_pack(tmp_tree)
        ops = plan(pack, "global", cfg)
        apply(ops, lock_path=tmp_tree / "config" / ".lock")

        claude_link = tmp_tree / "global-claude" / "skills" / "hindsight"
        codex_link = tmp_tree / "global-codex" / "prompts" / "hindsight.md"
        opencode_link = tmp_tree / "global-opencode" / "agent" / "hindsight.md"
        gemini_link = tmp_tree / "global-gemini" / "config" / "skills" / "hindsight"
        kimi_link = tmp_tree / "global-kimi" / "skills" / "hindsight"
        hermes_link = tmp_tree / "global-hermes" / "skills" / "hindsight"

        assert claude_link.is_symlink()
        assert claude_link.resolve() == (tmp_tree / "all-skills" / "hindsight").resolve()

        assert codex_link.is_symlink()
        assert (
            codex_link.resolve() == (tmp_tree / "all-skills" / "hindsight" / "SKILL.md").resolve()
        )

        assert opencode_link.is_symlink()
        assert (
            opencode_link.resolve()
            == (tmp_tree / "all-skills" / "hindsight" / "SKILL.md").resolve()
        )

        for directory_link in (gemini_link, kimi_link, hermes_link):
            assert directory_link.is_symlink()
            assert directory_link.resolve() == (tmp_tree / "all-skills" / "hindsight").resolve()

    def test_deactivate_removes_owned_links_only(self, tmp_tree: Path) -> None:
        cfg = _make_config(tmp_tree)
        pack = _make_pack(tmp_tree)

        # Drop a user-created file Claude might have created independently.
        (tmp_tree / "global-claude" / "skills").mkdir(parents=True)
        user_file = tmp_tree / "global-claude" / "skills" / "user-skill"
        user_file.mkdir()
        (user_file / "SKILL.md").write_text("# not managed\n", encoding="utf-8")

        # Activate.
        apply(plan(pack, "global", cfg), lock_path=tmp_tree / "config" / ".lock")
        assert (tmp_tree / "global-claude" / "skills" / "hindsight").is_symlink()

        # Deactivate by activating an empty pack.
        empty_pack = Pack(
            manifest=PackManifest(name="empty"),
            pack_path=tmp_tree / "packs" / "empty",
        )
        apply(plan(empty_pack, "global", cfg), lock_path=tmp_tree / "config" / ".lock")

        # User file still there, managed link gone.
        assert user_file.is_dir()
        assert (user_file / "SKILL.md").is_file()
        assert not (tmp_tree / "global-claude" / "skills" / "hindsight").exists()

    def test_rollback_on_broken_source(
        self, tmp_tree: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        cfg = _make_config(tmp_tree)
        pack = _make_pack(tmp_tree)
        ops = plan(pack, "global", cfg)

        # Sabotage: replace os.symlink mid-apply to fail on the 4th call.
        real_symlink = os.symlink
        calls = {"n": 0}

        def flaky_symlink(src: str | os.PathLike, dst: str | os.PathLike) -> None:
            calls["n"] += 1
            if calls["n"] == 4:
                raise OSError("simulated failure")
            real_symlink(src, dst)

        monkeypatch.setattr(os, "symlink", flaky_symlink)
        with pytest.raises(ActivationError, match="rolled back"):
            apply(ops, lock_path=tmp_tree / "config" / ".lock")

        # No leftover symlinks from the partial apply.
        for cli_subdir in (
            "global-claude/skills",
            "global-codex/prompts",
            "global-opencode/agent",
            "global-gemini/config/skills",
            "global-kimi/skills",
            "global-hermes/skills",
        ):
            directory = tmp_tree / cli_subdir
            if directory.exists():
                children = list(directory.iterdir())
                assert all(not c.is_symlink() for c in children), (
                    f"leftover symlink under {directory}: {children}"
                )
