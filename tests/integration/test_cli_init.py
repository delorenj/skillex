"""Integration test for skillex init."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from skillex.cli import app

runner = CliRunner()


class TestInit:
    def test_creates_config(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "skillex.toml"
        result = runner.invoke(
            app,
            [
                "init",
                "--config", str(cfg_path),
                "--skills-root", str(tmp_path / "all-skills"),
                "--packs-root", str(tmp_path / "packs"),
            ],
        )
        assert result.exit_code == 0, result.output
        assert cfg_path.exists()
        content = cfg_path.read_text()
        assert "cli.claude" in content
        assert "cli.codex" in content
        assert "cli.opencode" in content

    def test_refuses_to_overwrite_without_force(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "skillex.toml"
        cfg_path.write_text("existing = true\n", encoding="utf-8")
        result = runner.invoke(app, ["init", "--config", str(cfg_path)])
        assert result.exit_code == 1
        assert "already exists" in result.output

    def test_force_overwrites(self, tmp_path: Path) -> None:
        cfg_path = tmp_path / "skillex.toml"
        cfg_path.write_text("existing = true\n", encoding="utf-8")
        result = runner.invoke(
            app,
            [
                "init",
                "--config", str(cfg_path),
                "--force",
                "--skills-root", str(tmp_path / "all-skills"),
                "--packs-root", str(tmp_path / "packs"),
            ],
        )
        assert result.exit_code == 0
        assert "cli.claude" in cfg_path.read_text()
