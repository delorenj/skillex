from tests.conftest import strip_ansi
"""Integration tests for CLI - End-to-end command testing with real file operations."""

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from skillex.cli import app

runner = CliRunner()


@pytest.fixture
def temp_skills_env(tmp_path: Path):
    """Create a temporary environment with skills directories.

    Sets up:
    - DC environment variable pointing to temp output directory
    - Skills directory with sample skill structure
    """
    # Create output directory (DC target)
    output_dir = tmp_path / "output"
    output_dir.mkdir()

    # Create skills source directory
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()

    # Create sample skills
    skill1 = skills_dir / "test-skill-one"
    skill1.mkdir()
    (skill1 / "SKILL.md").write_text("# Test Skill One\nA sample skill for testing.")
    (skill1 / "prompt.txt").write_text("You are a test skill.")

    skill2 = skills_dir / "test-skill-two"
    skill2.mkdir()
    (skill2 / "SKILL.md").write_text("# Test Skill Two\nAnother sample skill.")

    skill3 = skills_dir / "python-helper"
    skill3.mkdir()
    (skill3 / "SKILL.md").write_text("# Python Helper\nA Python-focused skill.")
    (skill3 / "examples").mkdir()
    (skill3 / "examples" / "example1.py").write_text("print('hello')")

    # Set environment variables
    old_dc = os.environ.get("DC")
    old_home = os.environ.get("HOME")

    os.environ["DC"] = str(tmp_path)
    os.environ["HOME"] = str(tmp_path)

    # Create .claude/skills directory structure
    claude_skills = tmp_path / ".claude" / "skills"
    claude_skills.mkdir(parents=True)

    # Symlink or copy skills to .claude/skills
    for skill_dir in skills_dir.iterdir():
        if skill_dir.is_dir():
            target = claude_skills / skill_dir.name
            # Copy instead of symlink for cross-platform compatibility
            import shutil

            shutil.copytree(skill_dir, target)

    yield {
        "root": tmp_path,
        "output": output_dir,
        "skills": skills_dir,
        "claude_skills": claude_skills,
    }

    # Restore environment
    if old_dc is not None:
        os.environ["DC"] = old_dc
    else:
        os.environ.pop("DC", None)

    if old_home is not None:
        os.environ["HOME"] = old_home


class TestZipCommandIntegration:
    """Integration tests for the zip command."""

    def test_zip_all_creates_archives(self, temp_skills_env):
        """Test that zip command creates actual ZIP archives."""
        result = runner.invoke(app, ["zip"])

        assert result.exit_code == 0
        assert "Packaged" in strip_ansi(result.stdout)

        # Check that ZIP files were created
        output_dir = temp_skills_env["root"] / "skills"
        zip_files = list(output_dir.glob("*.zip"))
        assert len(zip_files) == 3

    def test_zip_with_pattern_filters_skills(self, temp_skills_env):
        """Test that pattern filtering works correctly."""
        result = runner.invoke(app, ["zip", "python"])

        assert result.exit_code == 0
        assert "Packaged 1 skill(s)" in strip_ansi(result.stdout)
        assert "python-helper" in strip_ansi(result.stdout)

    def test_zip_verbose_shows_table(self, temp_skills_env):
        """Test that verbose mode shows rich table output."""
        result = runner.invoke(app, ["zip", "-v"])

        assert result.exit_code == 0
        assert "Packaging Results" in strip_ansi(result.stdout)
        assert "Skill" in strip_ansi(result.stdout)
        assert "Status" in strip_ansi(result.stdout)
        assert "Size" in strip_ansi(result.stdout)

    def test_zip_creates_valid_archives(self, temp_skills_env):
        """Test that created archives are valid ZIP files."""
        import zipfile

        result = runner.invoke(app, ["zip", "test-skill-one"])

        assert result.exit_code == 0

        # Find the created archive
        output_dir = temp_skills_env["root"] / "skills"
        zip_path = output_dir / "test-skill-one.zip"
        assert zip_path.exists()

        # Verify it's a valid ZIP
        assert zipfile.is_zipfile(zip_path)

        # Verify contents (files are in a subdirectory named after the skill)
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            # Check for SKILL.md file (may be at root or in subdirectory)
            assert any("SKILL.md" in name for name in names)
            assert any("prompt.txt" in name for name in names)

    def test_zip_pattern_no_match(self, temp_skills_env):
        """Test message when pattern doesn't match any skills."""
        result = runner.invoke(app, ["zip", "nonexistent"])

        assert result.exit_code == 0
        assert "No skills matching 'nonexistent' found" in strip_ansi(result.stdout)

    def test_zip_output_paths_shown(self, temp_skills_env):
        """Test that output paths are displayed."""
        result = runner.invoke(app, ["zip", "python"])

        assert result.exit_code == 0
        assert ".zip" in strip_ansi(result.stdout)


class TestZipCommandEnvironmentErrors:
    """Test CLI behavior when environment is misconfigured."""

    def test_missing_dc_env_var(self, tmp_path: Path, monkeypatch):
        """Test error when DC environment variable is not set."""
        # Remove DC from environment
        monkeypatch.delenv("DC", raising=False)

        result = runner.invoke(app, ["zip"])

        assert result.exit_code == 1
        assert "DC" in strip_ansi(result.output)


class TestCLIHelpOutput:
    """Test CLI help and usage information."""

    def test_main_help(self):
        """Test that main help shows available commands."""
        result = runner.invoke(app, ["--help"])

        assert result.exit_code == 0
        assert "skillex" in strip_ansi(result.stdout).lower() or "claude" in strip_ansi(result.stdout).lower()
        assert "zip" in strip_ansi(result.stdout)

    def test_zip_help(self):
        """Test that zip help shows usage."""
        result = runner.invoke(app, ["zip", "--help"])

        assert result.exit_code == 0
        assert "Package Claude skills" in strip_ansi(result.stdout)
        assert "PATTERN" in strip_ansi(result.stdout)
        assert "--verbose" in strip_ansi(result.stdout)
        assert "-v" in strip_ansi(result.stdout)


# ============================================================================
# List Command Integration Tests
# ============================================================================


class TestListCommandIntegration:
    """Integration tests for the list command."""

    def test_list_all_shows_skills(self, temp_skills_env):
        """Test that list command shows all skills."""
        result = runner.invoke(app, ["list"])

        assert result.exit_code == 0
        assert "Found 3 skill(s)" in strip_ansi(result.stdout)
        assert "test-skill-one" in strip_ansi(result.stdout)
        assert "test-skill-two" in strip_ansi(result.stdout)
        assert "python-helper" in strip_ansi(result.stdout)

    def test_list_with_pattern_filters_skills(self, temp_skills_env):
        """Test that pattern filtering works correctly."""
        result = runner.invoke(app, ["list", "python"])

        assert result.exit_code == 0
        assert "Found 1 skill(s)" in strip_ansi(result.stdout)
        assert "python-helper" in strip_ansi(result.stdout)
        # Other skills should not be shown
        assert "test-skill-one" not in strip_ansi(result.stdout)
        assert "test-skill-two" not in strip_ansi(result.stdout)

    def test_list_shows_table_format(self, temp_skills_env):
        """Test that list shows rich table output."""
        result = runner.invoke(app, ["list"])

        assert result.exit_code == 0
        # Table headers
        assert "Skill" in strip_ansi(result.stdout)
        assert "Size" in strip_ansi(result.stdout)
        assert "Files" in strip_ansi(result.stdout)
        assert "Path" in strip_ansi(result.stdout)

    def test_list_pattern_no_match(self, temp_skills_env):
        """Test message when pattern doesn't match any skills."""
        result = runner.invoke(app, ["list", "nonexistent"])

        assert result.exit_code == 0
        assert "No skills matching 'nonexistent' found" in strip_ansi(result.stdout)

    def test_list_shows_file_counts(self, temp_skills_env):
        """Test that file counts are displayed."""
        result = runner.invoke(app, ["list", "python-helper"])

        assert result.exit_code == 0
        # python-helper has SKILL.md and examples/example1.py (2 files)
        # This checks that file count is shown
        assert "2" in strip_ansi(result.stdout)

    def test_list_case_insensitive(self, temp_skills_env):
        """Test that pattern matching is case-insensitive."""
        result = runner.invoke(app, ["list", "PYTHON"])

        assert result.exit_code == 0
        assert "Found 1 skill(s)" in strip_ansi(result.stdout)
        assert "python-helper" in strip_ansi(result.stdout)

    def test_list_partial_match(self, temp_skills_env):
        """Test that partial pattern matches work."""
        result = runner.invoke(app, ["list", "test"])

        assert result.exit_code == 0
        assert "Found 2 skill(s)" in strip_ansi(result.stdout)
        assert "test-skill-one" in strip_ansi(result.stdout)
        assert "test-skill-two" in strip_ansi(result.stdout)


class TestListCommandEnvironmentErrors:
    """Test list command behavior when environment is misconfigured."""

    def test_missing_dc_env_var(self, tmp_path: Path, monkeypatch):
        """Test error when DC environment variable is not set."""
        # Remove DC from environment
        monkeypatch.delenv("DC", raising=False)

        result = runner.invoke(app, ["list"])

        assert result.exit_code == 1
        assert "DC" in strip_ansi(result.output)
