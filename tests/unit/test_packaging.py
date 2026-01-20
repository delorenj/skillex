"""Unit tests for PackagingService - Skill packaging orchestration testing."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from skillex.exceptions import PackagingError
from skillex.infrastructure.config import Config
from skillex.services.discovery import SkillInfo
from skillex.services.packaging import (
    PackagingResult,
    PackagingService,
    SkillPackageResult,
)
from skillex.services.validation import ValidationResult


class TestSkillPackageResult:
    """Test suite for SkillPackageResult dataclass."""

    def test_successful_result(self) -> None:
        """Test creating a successful package result."""
        result = SkillPackageResult(
            skill_name="python-pro",
            success=True,
            output_path=Path("/output/python-pro.zip"),
            size_bytes=12345,
        )

        assert result.skill_name == "python-pro"
        assert result.success is True
        assert result.output_path == Path("/output/python-pro.zip")
        assert result.size_bytes == 12345
        assert result.error is None

    def test_failed_result(self) -> None:
        """Test creating a failed package result."""
        result = SkillPackageResult(
            skill_name="broken-skill",
            success=False,
            error="Permission denied",
        )

        assert result.skill_name == "broken-skill"
        assert result.success is False
        assert result.output_path is None
        assert result.size_bytes == 0
        assert result.error == "Permission denied"


class TestPackagingResult:
    """Test suite for PackagingResult dataclass."""

    def test_empty_result(self) -> None:
        """Test default PackagingResult."""
        result = PackagingResult()

        assert result.successful == []
        assert result.failed == []
        assert result.total_skills == 0
        assert result.total_size_bytes == 0
        assert result.duration_seconds == 0.0
        assert result.success_count == 0
        assert result.failure_count == 0

    def test_success_count(self) -> None:
        """Test success_count property."""
        result = PackagingResult()
        result.successful = [
            SkillPackageResult("skill1", True),
            SkillPackageResult("skill2", True),
        ]

        assert result.success_count == 2

    def test_failure_count(self) -> None:
        """Test failure_count property."""
        result = PackagingResult()
        result.failed = [
            SkillPackageResult("skill1", False, error="error1"),
            SkillPackageResult("skill2", False, error="error2"),
        ]

        assert result.failure_count == 2

    def test_all_succeeded_true(self) -> None:
        """Test all_succeeded when all skills pass."""
        result = PackagingResult()
        result.successful = [SkillPackageResult("skill1", True)]

        assert result.all_succeeded is True

    def test_all_succeeded_false_with_failures(self) -> None:
        """Test all_succeeded when some skills fail."""
        result = PackagingResult()
        result.successful = [SkillPackageResult("skill1", True)]
        result.failed = [SkillPackageResult("skill2", False, error="err")]

        assert result.all_succeeded is False

    def test_all_succeeded_false_with_no_successes(self) -> None:
        """Test all_succeeded when no skills succeed."""
        result = PackagingResult()

        assert result.all_succeeded is False

    def test_any_succeeded_true(self) -> None:
        """Test any_succeeded when at least one succeeds."""
        result = PackagingResult()
        result.successful = [SkillPackageResult("skill1", True)]
        result.failed = [SkillPackageResult("skill2", False, error="err")]

        assert result.any_succeeded is True

    def test_any_succeeded_false(self) -> None:
        """Test any_succeeded when none succeed."""
        result = PackagingResult()
        result.failed = [SkillPackageResult("skill1", False, error="err")]

        assert result.any_succeeded is False

    def test_str_success(self) -> None:
        """Test string representation for successful result."""
        result = PackagingResult()
        result.successful = [SkillPackageResult("skill1", True)]
        result.total_skills = 1
        result.total_size_bytes = 1000
        result.duration_seconds = 1.5

        str_repr = str(result)

        assert "Success" in str_repr
        assert "1/1" in str_repr
        assert "1,000 bytes" in str_repr

    def test_str_partial(self) -> None:
        """Test string representation for partial result."""
        result = PackagingResult()
        result.successful = [SkillPackageResult("skill1", True)]
        result.failed = [SkillPackageResult("skill2", False, error="err")]
        result.total_skills = 2

        str_repr = str(result)

        assert "Partial" in str_repr
        assert "1/2" in str_repr

    def test_str_failed(self) -> None:
        """Test string representation for failed result."""
        result = PackagingResult()
        result.failed = [SkillPackageResult("skill1", False, error="err")]
        result.total_skills = 1

        str_repr = str(result)

        assert "Failed" in str_repr


class TestPackagingServiceInit:
    """Test suite for PackagingService initialization."""

    def test_init_with_defaults(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """Test initialization with default dependencies."""
        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        service = PackagingService()

        assert service.discovery_service is not None
        assert service.matcher_service is not None
        assert service.validation_service is not None
        assert service.archive_builder is not None

    def test_init_with_custom_dependencies(self) -> None:
        """Test initialization with custom dependencies."""
        mock_discovery = MagicMock()
        mock_matcher = MagicMock()
        mock_validation = MagicMock()
        mock_builder = MagicMock()
        mock_config = MagicMock()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            matcher_service=mock_matcher,
            validation_service=mock_validation,
            archive_builder=mock_builder,
        )

        assert service.config is mock_config
        assert service.discovery_service is mock_discovery
        assert service.matcher_service is mock_matcher
        assert service.validation_service is mock_validation
        assert service.archive_builder is mock_builder


class TestPackageSkills:
    """Test suite for package_skills method."""

    @pytest.fixture
    def mock_config(self, tmp_path: Path) -> Config:
        """Create mock config with temp directories."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        output_dir = tmp_path / "output"
        output_dir.mkdir()
        return Config(skills_directory=skills_dir, output_directory=output_dir)

    @pytest.fixture
    def sample_skills(self, tmp_path: Path) -> list[SkillInfo]:
        """Create sample skills with actual directories."""
        skills = []
        for name in ["python-pro", "rust-pro", "typescript-pro"]:
            skill_dir = tmp_path / "skills" / name
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(f"# {name}\nTest skill")
            skills.append(
                SkillInfo(
                    name=name,
                    path=skill_dir,
                    size_bytes=100,
                    file_count=1,
                )
            )
        return skills

    def test_package_skills_empty_pattern_matches_all(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test that empty pattern matches all skills."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("")

        assert result.total_skills == 3
        assert result.success_count == 3
        assert result.all_succeeded is True

    def test_package_skills_with_pattern(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test packaging with pattern filter."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("python")

        assert result.total_skills == 1
        assert result.success_count == 1
        assert result.successful[0].skill_name == "python-pro"

    def test_package_skills_creates_zip_files(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test that ZIP files are actually created."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills[:1]

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("")

        assert result.success_count == 1
        output_path = result.successful[0].output_path
        assert output_path is not None
        assert output_path.exists()
        assert output_path.suffix == ".zip"

    def test_package_skills_calculates_total_size(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test that total size is calculated correctly."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("")

        assert result.total_size_bytes > 0
        # Total should be sum of individual sizes
        individual_sum = sum(s.size_bytes for s in result.successful)
        assert result.total_size_bytes == individual_sum

    def test_package_skills_records_duration(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test that duration is recorded."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills[:1]

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("")

        assert result.duration_seconds > 0

    def test_package_skills_validation_failure(
        self, mock_config: Config, tmp_path: Path
    ) -> None:
        """Test that validation failure raises PackagingError."""
        validation_result = ValidationResult()
        validation_result.add_error("DC environment variable not set")

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = validation_result

        service = PackagingService(
            config=mock_config,
            validation_service=mock_validation,
        )

        with pytest.raises(PackagingError) as exc_info:
            service.package_skills("")

        assert "validation failed" in str(exc_info.value).lower()

    def test_package_skills_skip_validation(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test that validation can be skipped."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills[:1]

        mock_validation = MagicMock()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("", skip_validation=True)

        mock_validation.validate_environment.assert_not_called()
        assert result.success_count == 1

    def test_package_skills_no_matches(
        self, mock_config: Config, sample_skills: list[SkillInfo], tmp_path: Path
    ) -> None:
        """Test packaging with no pattern matches."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = sample_skills

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("nonexistent")

        assert result.total_skills == 0
        assert result.success_count == 0
        assert result.failure_count == 0


class TestPackageSkillsErrorHandling:
    """Test suite for error handling in package_skills."""

    @pytest.fixture
    def mock_config(self, tmp_path: Path) -> Config:
        """Create mock config."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        output_dir = tmp_path / "output"
        output_dir.mkdir()
        return Config(skills_directory=skills_dir, output_directory=output_dir)

    def test_continues_on_individual_failure(
        self, mock_config: Config, tmp_path: Path
    ) -> None:
        """Test that packaging continues when one skill fails."""
        # Create skills - one valid, one that will fail
        valid_skill_dir = tmp_path / "skills" / "valid-skill"
        valid_skill_dir.mkdir(parents=True)
        (valid_skill_dir / "SKILL.md").write_text("# Valid")

        skills = [
            SkillInfo("valid-skill", valid_skill_dir, 100, 1),
            SkillInfo("broken-skill", tmp_path / "nonexistent", 100, 1),
        ]

        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = skills

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("", skip_validation=True)

        assert result.success_count == 1
        assert result.failure_count == 1
        assert result.successful[0].skill_name == "valid-skill"
        assert result.failed[0].skill_name == "broken-skill"

    def test_captures_error_message(
        self, mock_config: Config, tmp_path: Path
    ) -> None:
        """Test that error messages are captured in failed results."""
        skill = SkillInfo("broken-skill", tmp_path / "nonexistent", 100, 1)

        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = [skill]

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_skills("", skip_validation=True)

        assert result.failure_count == 1
        assert result.failed[0].error is not None
        assert len(result.failed[0].error) > 0


class TestPackageSingle:
    """Test suite for package_single method."""

    @pytest.fixture
    def mock_config(self, tmp_path: Path) -> Config:
        """Create mock config."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        output_dir = tmp_path / "output"
        output_dir.mkdir()
        return Config(skills_directory=skills_dir, output_directory=output_dir)

    @pytest.fixture
    def sample_skill(self, tmp_path: Path) -> SkillInfo:
        """Create a sample skill."""
        skill_dir = tmp_path / "skills" / "python-pro"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# Python Pro\nTest skill")
        return SkillInfo(
            name="python-pro",
            path=skill_dir,
            size_bytes=100,
            file_count=1,
        )

    def test_package_single_success(
        self, mock_config: Config, sample_skill: SkillInfo, tmp_path: Path
    ) -> None:
        """Test successful single skill packaging."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = [sample_skill]

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()
        mock_validation.validate_skill_name.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_single("python-pro")

        assert result.success is True
        assert result.skill_name == "python-pro"
        assert result.output_path is not None
        assert result.output_path.exists()

    def test_package_single_skill_not_found(
        self, mock_config: Config, sample_skill: SkillInfo, tmp_path: Path
    ) -> None:
        """Test error when skill not found."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = [sample_skill]

        validation_result = ValidationResult()
        validation_result.add_error("Skill 'nonexistent' not found")

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = ValidationResult()
        mock_validation.validate_skill_name.return_value = validation_result

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        with pytest.raises(PackagingError) as exc_info:
            service.package_single("nonexistent")

        assert "not found" in str(exc_info.value).lower()

    def test_package_single_validation_failure(
        self, mock_config: Config, tmp_path: Path
    ) -> None:
        """Test error when environment validation fails."""
        validation_result = ValidationResult()
        validation_result.add_error("DC not set")

        mock_validation = MagicMock()
        mock_validation.validate_environment.return_value = validation_result

        service = PackagingService(
            config=mock_config,
            validation_service=mock_validation,
        )

        with pytest.raises(PackagingError) as exc_info:
            service.package_single("python-pro")

        assert "validation failed" in str(exc_info.value).lower()

    def test_package_single_skip_validation(
        self, mock_config: Config, sample_skill: SkillInfo, tmp_path: Path
    ) -> None:
        """Test that validation can be skipped."""
        mock_discovery = MagicMock()
        mock_discovery.discover_all.return_value = [sample_skill]

        mock_validation = MagicMock()
        mock_validation.validate_skill_name.return_value = ValidationResult()

        service = PackagingService(
            config=mock_config,
            discovery_service=mock_discovery,
            validation_service=mock_validation,
        )

        result = service.package_single("python-pro", skip_validation=True)

        mock_validation.validate_environment.assert_not_called()
        assert result.success is True


class TestPackagingServiceIntegration:
    """Integration tests with real file operations."""

    def test_full_packaging_workflow(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test complete packaging workflow with real files."""
        # Setup directory structure
        skills_dir = tmp_path / ".claude" / "skills"
        output_dir = tmp_path / "dc" / "skills"
        skills_dir.mkdir(parents=True)
        output_dir.parent.mkdir(parents=True)

        # Create test skills
        for name in ["skill-a", "skill-b"]:
            skill_dir = skills_dir / name
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(f"# {name}")
            (skill_dir / "main.py").write_text(f"# {name} main")

        # Set environment
        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        # Create service with real dependencies
        service = PackagingService()

        # Package all skills
        result = service.package_skills("")

        # Verify results
        assert result.success_count == 2
        assert result.failure_count == 0
        assert result.all_succeeded is True
        assert output_dir.exists()

        # Verify ZIP files exist
        for skill_result in result.successful:
            assert skill_result.output_path is not None
            assert skill_result.output_path.exists()
            assert skill_result.size_bytes > 0

    def test_output_directory_created_if_missing(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that output directory is created if it doesn't exist."""
        skills_dir = tmp_path / ".claude" / "skills"
        output_dir = tmp_path / "dc" / "skills"
        skills_dir.mkdir(parents=True)

        # Create one skill
        skill_dir = skills_dir / "test-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("# Test")

        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        # Output dir doesn't exist yet
        assert not output_dir.exists()

        service = PackagingService()
        result = service.package_skills("")

        # Output dir should be created
        assert output_dir.exists()
        assert result.success_count == 1
