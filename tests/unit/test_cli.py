"""Unit tests for CLI - Command line interface testing."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from skillex.cli import _format_size, app
from skillex.exceptions import PackagingError
from skillex.services import PackagingResult, SkillPackageResult
from skillex.services.discovery import SkillInfo
from tests.conftest import strip_ansi

runner = CliRunner()


class TestFormatSize:
    """Tests for _format_size helper function."""

    def test_bytes(self):
        """Test formatting bytes."""
        assert _format_size(0) == "0 B"
        assert _format_size(500) == "500 B"
        assert _format_size(1023) == "1023 B"

    def test_kilobytes(self):
        """Test formatting kilobytes."""
        assert _format_size(1024) == "1.0 KB"
        assert _format_size(1536) == "1.5 KB"
        assert _format_size(10240) == "10.0 KB"

    def test_megabytes(self):
        """Test formatting megabytes."""
        assert _format_size(1024 * 1024) == "1.00 MB"
        assert _format_size(1024 * 1024 * 2) == "2.00 MB"
        assert _format_size(1024 * 1024 * 1.5) == "1.50 MB"


class TestZipCommandHelp:
    """Tests for zip command help and basic invocation."""

    def test_help_shows_usage(self):
        """Test that --help shows command usage."""
        result = runner.invoke(app, ["zip", "--help"])
        assert result.exit_code == 0
        assert "Package Claude skills" in strip_ansi(result.stdout)
        assert "PATTERN" in strip_ansi(result.stdout)
        assert "--verbose" in strip_ansi(result.stdout)

    def test_app_help_shows_zip(self):
        """Test that app help shows zip command."""
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "zip" in strip_ansi(result.stdout)


class TestZipCommandSuccess:
    """Tests for successful zip command execution."""

    @pytest.fixture
    def mock_packaging_result(self) -> PackagingResult:
        """Create a mock successful packaging result."""
        result = PackagingResult(
            successful=[
                SkillPackageResult(
                    skill_name="python-pro",
                    success=True,
                    output_path=Path("/tmp/output/python-pro.zip"),
                    size_bytes=1024,
                ),
                SkillPackageResult(
                    skill_name="typescript-pro",
                    success=True,
                    output_path=Path("/tmp/output/typescript-pro.zip"),
                    size_bytes=2048,
                ),
            ],
            failed=[],
            total_skills=2,
            total_size_bytes=3072,
            duration_seconds=0.5,
        )
        return result

    def test_zip_all_success(self, mock_packaging_result):
        """Test successful packaging of all skills."""
        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = mock_packaging_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip"])

            assert result.exit_code == 0
            assert "Packaged 2 skill(s)" in strip_ansi(result.stdout)
            mock_service.package_skills.assert_called_once_with(pattern="")

    def test_zip_with_pattern(self, mock_packaging_result):
        """Test packaging with pattern argument."""
        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = mock_packaging_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip", "python"])

            assert result.exit_code == 0
            mock_service.package_skills.assert_called_once_with(pattern="python")

    def test_zip_verbose_shows_table(self, mock_packaging_result):
        """Test verbose mode shows table output."""
        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = mock_packaging_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip", "-v"])

            assert result.exit_code == 0
            assert "Packaging Results" in strip_ansi(result.stdout)
            assert "python-pro" in strip_ansi(result.stdout)
            assert "typescript-pro" in strip_ansi(result.stdout)
            assert "Size" in strip_ansi(result.stdout)

    def test_zip_verbose_long_flag(self, mock_packaging_result):
        """Test verbose mode with --verbose flag."""
        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = mock_packaging_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip", "--verbose"])

            assert result.exit_code == 0
            assert "Packaging Results" in strip_ansi(result.stdout)

    def test_zip_shows_output_paths(self, mock_packaging_result):
        """Test that output paths are shown."""
        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = mock_packaging_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip"])

            assert result.exit_code == 0
            assert "/tmp/output/python-pro.zip" in strip_ansi(result.stdout)


class TestZipCommandNoSkills:
    """Tests for zip command when no skills found."""

    def test_no_skills_found(self):
        """Test message when no skills found."""
        empty_result = PackagingResult(
            successful=[],
            failed=[],
            total_skills=0,
            total_size_bytes=0,
            duration_seconds=0.1,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = empty_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip"])

            assert result.exit_code == 0
            assert "No skills found" in strip_ansi(result.stdout)

    def test_no_skills_matching_pattern(self):
        """Test message when no skills match pattern."""
        empty_result = PackagingResult(
            successful=[],
            failed=[],
            total_skills=0,
            total_size_bytes=0,
            duration_seconds=0.1,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = empty_result
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip", "nonexistent"])

            assert result.exit_code == 0
            assert "No skills matching 'nonexistent' found" in strip_ansi(result.stdout)


class TestZipCommandPartialFailure:
    """Tests for zip command with partial failures."""

    def test_partial_failure_shows_errors(self):
        """Test that partial failures show error messages."""
        result = PackagingResult(
            successful=[
                SkillPackageResult(
                    skill_name="python-pro",
                    success=True,
                    output_path=Path("/tmp/output/python-pro.zip"),
                    size_bytes=1024,
                ),
            ],
            failed=[
                SkillPackageResult(
                    skill_name="broken-skill",
                    success=False,
                    error="Permission denied",
                ),
            ],
            total_skills=2,
            total_size_bytes=1024,
            duration_seconds=0.5,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = result
            mock_service_cls.return_value = mock_service

            cli_result = runner.invoke(app, ["zip"])

            # Exit code 2 for partial success
            assert cli_result.exit_code == 2
            # Check combined output (stdout + stderr)
            output = cli_result.output
            assert "1 skill(s) failed" in strip_ansi(output)
            assert "broken-skill" in strip_ansi(output)
            assert "Permission denied" in strip_ansi(output)

    def test_partial_failure_verbose_shows_table(self):
        """Test that partial failures show in verbose table."""
        result = PackagingResult(
            successful=[
                SkillPackageResult(
                    skill_name="python-pro",
                    success=True,
                    output_path=Path("/tmp/output/python-pro.zip"),
                    size_bytes=1024,
                ),
            ],
            failed=[
                SkillPackageResult(
                    skill_name="broken-skill",
                    success=False,
                    error="Permission denied",
                ),
            ],
            total_skills=2,
            total_size_bytes=1024,
            duration_seconds=0.5,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = result
            mock_service_cls.return_value = mock_service

            cli_result = runner.invoke(app, ["zip", "-v"])

            assert cli_result.exit_code == 2
            assert "1/2 successful" in strip_ansi(cli_result.stdout)


class TestZipCommandTotalFailure:
    """Tests for zip command with total failure."""

    def test_total_failure_exit_code_1(self):
        """Test that total failure exits with code 1."""
        result = PackagingResult(
            successful=[],
            failed=[
                SkillPackageResult(
                    skill_name="broken-skill",
                    success=False,
                    error="Permission denied",
                ),
            ],
            total_skills=1,
            total_size_bytes=0,
            duration_seconds=0.1,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = result
            mock_service_cls.return_value = mock_service

            cli_result = runner.invoke(app, ["zip"])

            assert cli_result.exit_code == 1


class TestZipCommandErrors:
    """Tests for zip command error handling."""

    def test_packaging_error_shows_message(self):
        """Test that PackagingError shows error message."""
        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.side_effect = PackagingError(
                "Environment variable 'DC' is not set"
            )
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip"])

            assert result.exit_code == 1
            # Check combined output
            assert "Error:" in result.output
            assert "DC" in result.output

    def test_skillex_error_shows_message(self):
        """Test that SkillexError shows error message."""
        from skillex.exceptions import ConfigurationError

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.side_effect = ConfigurationError(
                "Invalid configuration"
            )
            mock_service_cls.return_value = mock_service

            result = runner.invoke(app, ["zip"])

            assert result.exit_code == 1
            # Check combined output
            assert "Error:" in result.output
            assert "Invalid configuration" in result.output


class TestZipCommandVerboseTable:
    """Tests for verbose table formatting."""

    def test_verbose_table_columns(self):
        """Test that verbose table has correct columns."""
        result = PackagingResult(
            successful=[
                SkillPackageResult(
                    skill_name="test-skill",
                    success=True,
                    output_path=Path("/tmp/test.zip"),
                    size_bytes=512,
                ),
            ],
            failed=[],
            total_skills=1,
            total_size_bytes=512,
            duration_seconds=0.1,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = result
            mock_service_cls.return_value = mock_service

            cli_result = runner.invoke(app, ["zip", "-v"])

            assert cli_result.exit_code == 0
            assert "Skill" in cli_result.stdout
            assert "Status" in cli_result.stdout
            assert "Size" in cli_result.stdout
            assert "Output Path" in cli_result.stdout

    def test_verbose_table_duration(self):
        """Test that verbose table shows duration."""
        result = PackagingResult(
            successful=[
                SkillPackageResult(
                    skill_name="test-skill",
                    success=True,
                    output_path=Path("/tmp/test.zip"),
                    size_bytes=512,
                ),
            ],
            failed=[],
            total_skills=1,
            total_size_bytes=512,
            duration_seconds=1.234,
        )

        with patch("skillex.cli.PackagingService") as mock_service_cls:
            mock_service = MagicMock()
            mock_service.package_skills.return_value = result
            mock_service_cls.return_value = mock_service

            cli_result = runner.invoke(app, ["zip", "-v"])

            assert "Duration" in strip_ansi(cli_result.stdout)
            assert "1.23" in strip_ansi(cli_result.stdout)


# ============================================================================
# List Command Tests
# ============================================================================


class TestListCommandHelp:
    """Tests for list command help and basic invocation."""

    def test_help_shows_usage(self):
        """Test that --help shows command usage."""
        result = runner.invoke(app, ["list", "--help"])
        assert result.exit_code == 0
        assert "List available Claude skills" in strip_ansi(result.stdout)
        assert "PATTERN" in strip_ansi(result.stdout)

    def test_app_help_shows_list(self):
        """Test that app help shows list command."""
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "list" in strip_ansi(result.stdout)


class TestListCommandSuccess:
    """Tests for successful list command execution."""

    @pytest.fixture
    def mock_skills(self) -> list[SkillInfo]:
        """Create mock skill list."""
        return [
            SkillInfo(
                name="python-pro",
                path=Path("/home/user/.claude/skills/python-pro"),
                size_bytes=1024,
                file_count=5,
            ),
            SkillInfo(
                name="typescript-pro",
                path=Path("/home/user/.claude/skills/typescript-pro"),
                size_bytes=2048,
                file_count=8,
            ),
            SkillInfo(
                name="rust-pro",
                path=Path("/home/user/.claude/skills/rust-pro"),
                size_bytes=512,
                file_count=3,
            ),
        ]

    def test_list_all_skills(self, mock_skills):
        """Test listing all skills without pattern."""
        with (
            patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls,
            patch("skillex.cli.FuzzyMatcherService") as mock_fuzzy_cls,
        ):
            mock_discovery = MagicMock()
            mock_discovery.discover_all.return_value = mock_skills
            mock_discovery_cls.return_value = mock_discovery

            mock_fuzzy = MagicMock()
            mock_fuzzy_cls.return_value = mock_fuzzy

            result = runner.invoke(app, ["list"])

            assert result.exit_code == 0
            assert "Found 3 skill(s)" in strip_ansi(result.stdout)
            assert "python-pro" in strip_ansi(result.stdout)
            assert "typescript-pro" in strip_ansi(result.stdout)
            assert "rust-pro" in strip_ansi(result.stdout)
            mock_discovery.discover_all.assert_called_once()

    def test_list_with_pattern(self, mock_skills):
        """Test listing skills with pattern filter."""
        filtered_skills = [mock_skills[0]]  # Just python-pro

        with (
            patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls,
            patch("skillex.cli.FuzzyMatcherService") as mock_fuzzy_cls,
        ):
            mock_discovery = MagicMock()
            mock_discovery.discover_all.return_value = mock_skills
            mock_discovery_cls.return_value = mock_discovery

            mock_fuzzy = MagicMock()
            mock_fuzzy.match.return_value = filtered_skills
            mock_fuzzy_cls.return_value = mock_fuzzy

            result = runner.invoke(app, ["list", "python"])

            assert result.exit_code == 0
            assert "Found 1 skill(s)" in strip_ansi(result.stdout)
            assert "python-pro" in strip_ansi(result.stdout)
            mock_fuzzy.match.assert_called_once_with("python", mock_skills)

    def test_list_shows_table_columns(self, mock_skills):
        """Test that list shows table with correct columns."""
        with (
            patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls,
            patch("skillex.cli.FuzzyMatcherService") as mock_fuzzy_cls,
        ):
            mock_discovery = MagicMock()
            mock_discovery.discover_all.return_value = mock_skills
            mock_discovery_cls.return_value = mock_discovery

            mock_fuzzy = MagicMock()
            mock_fuzzy_cls.return_value = mock_fuzzy

            result = runner.invoke(app, ["list"])

            assert result.exit_code == 0
            assert "Skill" in strip_ansi(result.stdout)
            assert "Size" in strip_ansi(result.stdout)
            assert "Files" in strip_ansi(result.stdout)
            assert "Path" in strip_ansi(result.stdout)

    def test_list_shows_size_formatted(self, mock_skills):
        """Test that size is formatted correctly."""
        with (
            patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls,
            patch("skillex.cli.FuzzyMatcherService") as mock_fuzzy_cls,
        ):
            mock_discovery = MagicMock()
            mock_discovery.discover_all.return_value = mock_skills
            mock_discovery_cls.return_value = mock_discovery

            mock_fuzzy = MagicMock()
            mock_fuzzy_cls.return_value = mock_fuzzy

            result = runner.invoke(app, ["list"])

            assert result.exit_code == 0
            # 1024 bytes = 1.0 KB
            assert "1.0 KB" in strip_ansi(result.stdout)
            # 2048 bytes = 2.0 KB
            assert "2.0 KB" in strip_ansi(result.stdout)


class TestListCommandNoSkills:
    """Tests for list command when no skills found."""

    def test_no_skills_found(self):
        """Test message when no skills found."""
        with (
            patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls,
            patch("skillex.cli.FuzzyMatcherService") as mock_fuzzy_cls,
        ):
            mock_discovery = MagicMock()
            mock_discovery.discover_all.return_value = []
            mock_discovery_cls.return_value = mock_discovery

            mock_fuzzy = MagicMock()
            mock_fuzzy_cls.return_value = mock_fuzzy

            result = runner.invoke(app, ["list"])

            assert result.exit_code == 0
            assert "No skills found" in strip_ansi(result.stdout)

    def test_no_skills_matching_pattern(self):
        """Test message when no skills match pattern."""
        mock_skills = [
            SkillInfo(
                name="python-pro",
                path=Path("/home/user/.claude/skills/python-pro"),
                size_bytes=1024,
                file_count=5,
            ),
        ]

        with (
            patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls,
            patch("skillex.cli.FuzzyMatcherService") as mock_fuzzy_cls,
        ):
            mock_discovery = MagicMock()
            mock_discovery.discover_all.return_value = mock_skills
            mock_discovery_cls.return_value = mock_discovery

            mock_fuzzy = MagicMock()
            mock_fuzzy.match.return_value = []
            mock_fuzzy_cls.return_value = mock_fuzzy

            result = runner.invoke(app, ["list", "nonexistent"])

            assert result.exit_code == 0
            assert "No skills matching 'nonexistent' found" in strip_ansi(result.stdout)


class TestListCommandErrors:
    """Tests for list command error handling."""

    def test_skillex_error_shows_message(self):
        """Test that SkillexError shows error message."""
        from skillex.exceptions import ConfigurationError

        with patch("skillex.cli.SkillDiscoveryService") as mock_discovery_cls:
            mock_discovery_cls.side_effect = ConfigurationError(
                "Environment variable 'DC' is not set"
            )

            result = runner.invoke(app, ["list"])

            assert result.exit_code == 1
            assert "Error:" in result.output
            assert "DC" in result.output
