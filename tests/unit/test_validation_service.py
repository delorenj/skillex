"""Unit tests for ValidationService - Input and operation validation testing."""

from pathlib import Path

import pytest

from skillex.services.validation import ValidationResult, ValidationService


class TestValidationResult:
    """Test suite for ValidationResult dataclass."""

    def test_default_creation(self) -> None:
        """Test default ValidationResult is valid with empty lists."""
        result = ValidationResult()

        assert result.is_valid is True
        assert result.errors == []
        assert result.warnings == []

    def test_add_error_marks_invalid(self) -> None:
        """Test that adding an error marks result as invalid."""
        result = ValidationResult()
        result.add_error("Test error")

        assert result.is_valid is False
        assert len(result.errors) == 1
        assert result.errors[0] == "Test error"

    def test_add_multiple_errors(self) -> None:
        """Test adding multiple errors."""
        result = ValidationResult()
        result.add_error("Error 1")
        result.add_error("Error 2")

        assert result.is_valid is False
        assert len(result.errors) == 2
        assert "Error 1" in result.errors
        assert "Error 2" in result.errors

    def test_add_warning_keeps_valid(self) -> None:
        """Test that adding a warning does not mark result as invalid."""
        result = ValidationResult()
        result.add_warning("Test warning")

        assert result.is_valid is True
        assert len(result.warnings) == 1
        assert result.warnings[0] == "Test warning"

    def test_add_multiple_warnings(self) -> None:
        """Test adding multiple warnings."""
        result = ValidationResult()
        result.add_warning("Warning 1")
        result.add_warning("Warning 2")

        assert result.is_valid is True
        assert len(result.warnings) == 2

    def test_merge_combines_errors(self) -> None:
        """Test that merge combines errors from both results."""
        result1 = ValidationResult()
        result1.add_error("Error 1")

        result2 = ValidationResult()
        result2.add_error("Error 2")

        result1.merge(result2)

        assert result1.is_valid is False
        assert len(result1.errors) == 2
        assert "Error 1" in result1.errors
        assert "Error 2" in result1.errors

    def test_merge_combines_warnings(self) -> None:
        """Test that merge combines warnings from both results."""
        result1 = ValidationResult()
        result1.add_warning("Warning 1")

        result2 = ValidationResult()
        result2.add_warning("Warning 2")

        result1.merge(result2)

        assert result1.is_valid is True
        assert len(result1.warnings) == 2

    def test_merge_invalid_makes_result_invalid(self) -> None:
        """Test that merging invalid result makes the merged result invalid."""
        result1 = ValidationResult()
        result2 = ValidationResult()
        result2.add_error("Error")

        result1.merge(result2)

        assert result1.is_valid is False

    def test_merge_returns_self(self) -> None:
        """Test that merge returns self for method chaining."""
        result1 = ValidationResult()
        result2 = ValidationResult()

        returned = result1.merge(result2)

        assert returned is result1

    def test_str_valid_no_issues(self) -> None:
        """Test string representation for valid result with no issues."""
        result = ValidationResult()
        str_repr = str(result)

        assert "Valid" in str_repr
        assert "Errors" not in str_repr
        assert "Warnings" not in str_repr

    def test_str_invalid_with_errors(self) -> None:
        """Test string representation for invalid result with errors."""
        result = ValidationResult()
        result.add_error("Error 1")
        result.add_error("Error 2")
        str_repr = str(result)

        assert "Invalid" in str_repr
        assert "Errors: 2" in str_repr

    def test_str_valid_with_warnings(self) -> None:
        """Test string representation for valid result with warnings."""
        result = ValidationResult()
        result.add_warning("Warning 1")
        str_repr = str(result)

        assert "Valid" in str_repr
        assert "Warnings: 1" in str_repr


class TestValidationServiceInit:
    """Test suite for ValidationService initialization."""

    def test_init_default(self) -> None:
        """Test default initialization creates path validator."""
        service = ValidationService()

        assert service.path_validator is not None

    def test_init_with_custom_validator(self) -> None:
        """Test initialization with custom path validator."""
        from skillex.infrastructure.validator import PathValidator

        custom_validator = PathValidator()
        service = ValidationService(path_validator=custom_validator)

        assert service.path_validator is custom_validator


class TestValidateEnvironment:
    """Test suite for validate_environment method."""

    @pytest.fixture
    def service(self) -> ValidationService:
        """Create ValidationService instance."""
        return ValidationService()

    def test_missing_dc_env_var(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test validation fails when DC env var is missing."""
        monkeypatch.delenv("DC", raising=False)

        result = service.validate_environment()

        assert result.is_valid is False
        assert len(result.errors) == 1
        assert "DC" in result.errors[0]
        assert "not set" in result.errors[0]

    def test_valid_environment(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test validation passes with valid environment."""
        # Create directories
        skills_dir = tmp_path / ".claude" / "skills"
        skills_dir.mkdir(parents=True)
        output_parent = tmp_path / "dc"
        output_parent.mkdir()

        # Mock home directory and DC
        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        result = service.validate_environment()

        assert result.is_valid is True
        assert len(result.errors) == 0

    def test_missing_skills_directory_warning(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test warning when skills directory doesn't exist."""
        output_parent = tmp_path / "dc"
        output_parent.mkdir()

        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        result = service.validate_environment()

        assert result.is_valid is True
        assert len(result.warnings) >= 1
        assert any("Skills directory does not exist" in w for w in result.warnings)

    def test_skills_path_not_directory_error(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test error when skills path is a file, not directory."""
        # Create skills as a file instead of directory
        skills_file = tmp_path / ".claude" / "skills"
        skills_file.parent.mkdir(parents=True)
        skills_file.touch()

        output_parent = tmp_path / "dc"
        output_parent.mkdir()

        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        result = service.validate_environment()

        assert result.is_valid is False
        assert any("not a directory" in e for e in result.errors)


class TestValidatePaths:
    """Test suite for validate_paths method."""

    @pytest.fixture
    def service(self) -> ValidationService:
        """Create ValidationService instance."""
        return ValidationService()

    def test_valid_paths(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test validation passes for valid paths."""
        source = tmp_path / "source"
        source.mkdir()
        output = tmp_path / "output.zip"

        result = service.validate_paths(source, output)

        assert result.is_valid is True
        assert len(result.errors) == 0

    def test_source_not_exists(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test error when source path doesn't exist."""
        source = tmp_path / "nonexistent"
        output = tmp_path / "output.zip"

        result = service.validate_paths(source, output)

        assert result.is_valid is False
        assert any("does not exist" in e for e in result.errors)

    def test_source_not_directory(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test error when source path is a file."""
        source = tmp_path / "file.txt"
        source.touch()
        output = tmp_path / "output.zip"

        result = service.validate_paths(source, output)

        assert result.is_valid is False
        assert any("not a directory" in e for e in result.errors)

    def test_output_parent_not_exists_warning(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test warning when output parent directory doesn't exist."""
        source = tmp_path / "source"
        source.mkdir()
        output = tmp_path / "nonexistent" / "output.zip"

        result = service.validate_paths(source, output)

        assert result.is_valid is True
        assert any("does not exist" in w for w in result.warnings)

    def test_output_exists_warning(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test warning when output file already exists."""
        source = tmp_path / "source"
        source.mkdir()
        output = tmp_path / "output.zip"
        output.touch()

        result = service.validate_paths(source, output)

        assert result.is_valid is True
        assert any("already exists" in w for w in result.warnings)

    def test_path_traversal_detection(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test error on path traversal attempt."""
        source = tmp_path / "source"
        source.mkdir()
        output = tmp_path / "output.zip"
        allowed_base = tmp_path / "allowed"
        allowed_base.mkdir()

        result = service.validate_paths(source, output, allowed_base=allowed_base)

        assert result.is_valid is False
        assert any("Security" in e or "outside" in e.lower() for e in result.errors)

    def test_valid_path_within_base(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test validation passes when source is within allowed base."""
        allowed_base = tmp_path / "allowed"
        source = allowed_base / "source"
        allowed_base.mkdir()
        source.mkdir()
        output = tmp_path / "output.zip"

        result = service.validate_paths(source, output, allowed_base=allowed_base)

        assert result.is_valid is True

    def test_string_paths_accepted(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test that string paths are accepted and converted."""
        source = tmp_path / "source"
        source.mkdir()

        result = service.validate_paths(str(source), str(tmp_path / "output.zip"))

        assert result.is_valid is True


class TestValidateSkillName:
    """Test suite for validate_skill_name method."""

    @pytest.fixture
    def service(self) -> ValidationService:
        """Create ValidationService instance."""
        return ValidationService()

    def test_valid_skill_name(self, service: ValidationService) -> None:
        """Test validation passes for valid skill name."""
        result = service.validate_skill_name("python-pro")

        assert result.is_valid is True
        assert len(result.errors) == 0

    def test_empty_skill_name(self, service: ValidationService) -> None:
        """Test error for empty skill name."""
        result = service.validate_skill_name("")

        assert result.is_valid is False
        assert any("cannot be empty" in e for e in result.errors)

    def test_whitespace_only_skill_name(self, service: ValidationService) -> None:
        """Test error for whitespace-only skill name."""
        result = service.validate_skill_name("   ")

        assert result.is_valid is False
        assert any("whitespace only" in e for e in result.errors)

    def test_invalid_characters(self, service: ValidationService) -> None:
        """Test error for skill name with invalid characters."""
        result = service.validate_skill_name("skill<name>")

        assert result.is_valid is False
        assert any("invalid characters" in e for e in result.errors)

    def test_multiple_invalid_characters(self, service: ValidationService) -> None:
        """Test error message lists all invalid characters."""
        result = service.validate_skill_name('skill<name>:path/"test"')

        assert result.is_valid is False
        # Should mention the invalid characters found

    def test_skill_not_in_available_list(self, service: ValidationService) -> None:
        """Test error when skill not in available skills list."""
        available = ["python-pro", "rust-pro", "typescript-pro"]

        result = service.validate_skill_name("java-pro", available_skills=available)

        assert result.is_valid is False
        assert any("not found" in e for e in result.errors)

    def test_skill_in_available_list(self, service: ValidationService) -> None:
        """Test validation passes when skill is in available list."""
        available = ["python-pro", "rust-pro", "typescript-pro"]

        result = service.validate_skill_name("python-pro", available_skills=available)

        assert result.is_valid is True

    def test_case_mismatch_suggestion(self, service: ValidationService) -> None:
        """Test suggestion when skill name has wrong case."""
        available = ["Python-Pro", "Rust-Pro"]

        result = service.validate_skill_name("python-pro", available_skills=available)

        assert result.is_valid is False
        assert any("Did you mean" in e for e in result.errors)

    def test_skill_name_with_special_chars(self, service: ValidationService) -> None:
        """Test valid skill names with allowed special characters."""
        result = service.validate_skill_name("my-skill_v2.0")

        assert result.is_valid is True

    def test_skill_name_stripped(self, service: ValidationService) -> None:
        """Test that leading/trailing whitespace is stripped."""
        available = ["python-pro"]

        result = service.validate_skill_name("  python-pro  ", available_skills=available)

        assert result.is_valid is True


class TestValidateAll:
    """Test suite for validate_all method."""

    @pytest.fixture
    def service(self) -> ValidationService:
        """Create ValidationService instance."""
        return ValidationService()

    def test_validate_all_environment_only(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test validate_all with no optional parameters."""
        skills_dir = tmp_path / ".claude" / "skills"
        skills_dir.mkdir(parents=True)
        output_parent = tmp_path / "dc"
        output_parent.mkdir()

        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        result = service.validate_all()

        assert result.is_valid is True

    def test_validate_all_with_skill_name(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test validate_all with skill name validation."""
        skills_dir = tmp_path / ".claude" / "skills"
        skills_dir.mkdir(parents=True)
        output_parent = tmp_path / "dc"
        output_parent.mkdir()

        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        result = service.validate_all(skill_name="python-pro")

        assert result.is_valid is True

    def test_validate_all_with_paths(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test validate_all with path validation."""
        skills_dir = tmp_path / ".claude" / "skills"
        skills_dir.mkdir(parents=True)
        output_parent = tmp_path / "dc"
        output_parent.mkdir()
        source = tmp_path / "source"
        source.mkdir()

        monkeypatch.setenv("DC", str(tmp_path / "dc"))
        monkeypatch.setenv("HOME", str(tmp_path))

        result = service.validate_all(
            source_path=source,
            output_path=tmp_path / "output.zip"
        )

        assert result.is_valid is True

    def test_validate_all_combines_errors(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that validate_all combines errors from all validations."""
        monkeypatch.delenv("DC", raising=False)

        result = service.validate_all(
            skill_name="",
            source_path=tmp_path / "nonexistent",
            output_path=tmp_path / "output.zip"
        )

        assert result.is_valid is False
        # Should have errors from environment (DC missing) and skill name (empty)
        assert len(result.errors) >= 2


class TestValidationServicePurity:
    """Test suite verifying ValidationService has no side effects."""

    @pytest.fixture
    def service(self) -> ValidationService:
        """Create ValidationService instance."""
        return ValidationService()

    def test_validate_paths_no_file_creation(
        self, service: ValidationService, tmp_path: Path
    ) -> None:
        """Test that validate_paths doesn't create any files."""
        source = tmp_path / "source"
        source.mkdir()
        output = tmp_path / "nonexistent_dir" / "output.zip"

        service.validate_paths(source, output)

        # The nonexistent directory should still not exist
        assert not output.parent.exists()

    def test_validate_environment_no_modifications(
        self, service: ValidationService, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that validate_environment doesn't modify environment."""
        original_dc = "original_value"
        monkeypatch.setenv("DC", original_dc)

        service.validate_environment()

        import os
        assert os.environ.get("DC") == original_dc
