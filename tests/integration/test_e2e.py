"""End-to-end integration test: init → lint → activate → status → deactivate."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from skillex.cli import app

runner = CliRunner()


@pytest.fixture
def workspace(tmp_path: Path, fixtures_dir: Path) -> Path:
    """Full workspace mirroring the real layout:

    tmp/
      all-skills/...      (copy of tests/fixtures/sample_skills)
      packs/33god-dev/    (generated below)
      config/skillex.toml (generated via skillex init)
      roots/.claude/
      roots/.codex/
      roots/.opencode/
    """
    skills_dir = tmp_path / "all-skills"
    shutil.copytree(fixtures_dir / "sample_skills", skills_dir)

    packs_dir = tmp_path / "packs"
    pack_dir = packs_dir / "33god-dev"
    pack_dir.mkdir(parents=True)
    (pack_dir / "pack.toml").write_text(
        """
[pack]
name = "33god-dev"
version = "0.1.0"
description = "E2E fixture pack"

[slots.memory]
required = true
skill = "hindsight"

[slots.workflow]
required = false
skill = "n8n-bridge"

[freeform]
skills = ["mermaid-expert"]
""".strip(),
        encoding="utf-8",
    )

    (tmp_path / "roots" / "claude").mkdir(parents=True)
    (tmp_path / "roots" / "codex").mkdir()
    (tmp_path / "roots" / "opencode").mkdir()

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    config_path = config_dir / "skillex.toml"
    config_path.write_text(
        f"""
[skillex]
skills_root = "{skills_dir}"
packs_root = "{packs_dir}"

[scopes.global]
active_pack = "33god-dev"

[cli.claude]
enabled = true
global_root = "{tmp_path / 'roots' / 'claude'}"
project_root = ".claude"

[cli.codex]
enabled = true
global_root = "{tmp_path / 'roots' / 'codex'}"
project_root = ".codex"

[cli.opencode]
enabled = true
global_root = "{tmp_path / 'roots' / 'opencode'}"
project_root = ".opencode"
""".strip(),
        encoding="utf-8",
    )

    return tmp_path


def _config(workspace: Path) -> Path:
    return workspace / "config" / "skillex.toml"


class TestE2E:
    def test_full_roundtrip(self, workspace: Path) -> None:
        cfg_path = _config(workspace)

        # 1. Lint
        result = runner.invoke(app, ["pack", "lint", "33god-dev", "--config", str(cfg_path)])
        assert result.exit_code == 0, result.output
        assert "clean" in result.output.lower() or "warn" in result.output.lower()

        # 2. Dry-run activate
        result = runner.invoke(
            app,
            ["pack", "activate", "33god-dev", "--scope", "global", "--dry-run",
             "--config", str(cfg_path)],
        )
        assert result.exit_code == 0, result.output
        assert "dry-run" in result.output

        # Nothing should be written yet.
        assert not (workspace / "roots" / "claude" / "skills").exists()

        # 3. Real activate
        result = runner.invoke(
            app,
            ["pack", "activate", "33god-dev", "--scope", "global",
             "--config", str(cfg_path)],
        )
        assert result.exit_code == 0, result.output
        assert "activated" in result.output

        # Verify symlinks exist across all 3 CLI roots.
        claude_link = workspace / "roots" / "claude" / "skills" / "hindsight"
        codex_link = workspace / "roots" / "codex" / "prompts" / "hindsight.md"
        opencode_link = workspace / "roots" / "opencode" / "agent" / "hindsight.md"
        assert claude_link.is_symlink()
        assert codex_link.is_symlink()
        assert opencode_link.is_symlink()

        # And the freeform skill too.
        assert (workspace / "roots" / "claude" / "skills" / "mermaid-expert").is_symlink()
        assert (workspace / "roots" / "codex" / "prompts" / "mermaid-expert.md").is_symlink()

        # 4. Status
        result = runner.invoke(app, ["status", "--config", str(cfg_path)])
        assert result.exit_code == 0
        assert "33god-dev" in result.output

        # 5. Re-activate (idempotency)
        result = runner.invoke(
            app,
            ["pack", "activate", "33god-dev", "--scope", "global",
             "--config", str(cfg_path)],
        )
        assert result.exit_code == 0

        # 6. Deactivate
        result = runner.invoke(
            app,
            ["pack", "deactivate", "--scope", "global", "--config", str(cfg_path)],
        )
        assert result.exit_code == 0, result.output
        assert "deactivated" in result.output

        # Verify symlinks removed.
        assert not claude_link.exists()
        assert not codex_link.exists()
        assert not opencode_link.exists()

    def test_lint_catches_mismatch(self, workspace: Path) -> None:
        cfg_path = _config(workspace)
        bad_pack_dir = workspace / "packs" / "broken"
        bad_pack_dir.mkdir()
        (bad_pack_dir / "pack.toml").write_text(
            """
[pack]
name = "broken"

[slots.workflow]
required = true
skill = "hindsight"
""".strip(),
            encoding="utf-8",
        )
        result = runner.invoke(
            app, ["pack", "lint", "broken", "--config", str(cfg_path)]
        )
        assert result.exit_code == 1
        assert "SLOT_TYPE_MISMATCH" in result.output

    def test_skill_list(self, workspace: Path) -> None:
        result = runner.invoke(
            app, ["skill", "list", "--config", str(_config(workspace))]
        )
        assert result.exit_code == 0
        assert "hindsight" in result.output
        assert "Memory" in result.output

    def test_slot_list(self, workspace: Path) -> None:
        result = runner.invoke(
            app, ["slot", "list", "--config", str(_config(workspace))]
        )
        assert result.exit_code == 0
        assert "Memory" in result.output
        assert "Workflow" in result.output
        assert "TTS" in result.output

    def test_pack_list(self, workspace: Path) -> None:
        result = runner.invoke(
            app, ["pack", "list", "--config", str(_config(workspace))]
        )
        assert result.exit_code == 0
        assert "33god-dev" in result.output

    def test_pack_show(self, workspace: Path) -> None:
        result = runner.invoke(
            app, ["pack", "show", "33god-dev", "--config", str(_config(workspace))]
        )
        assert result.exit_code == 0
        assert "hindsight" in result.output
        assert "n8n-bridge" in result.output
