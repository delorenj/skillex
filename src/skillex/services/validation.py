"""Validation Service - Comprehensive input and operation validation.

This module provides validation functionality for the skillex application.
All validation is pure (no side effects) and returns actionable error messages.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

from skillex.exceptions import (
    ConfigurationError,
    EnvironmentVariableError,
    PathTraversalError,
    SecurityError,
)
from skillex.infrastructure.config import Config
from skillex.infrastructure.validator import PathValidator


@dataclass
class ValidationResult:
    """Result of a validation operation.

    Attributes:
        is_valid: Whether validation passed (no errors)
        errors: List of error messages (validation failures)
        warnings: List of warning messages (non-fatal issues)
    """

    is_valid: bool = True
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add_error(self, message: str) -> None:
        """Add an error message and mark as invalid.

        Args:
            message: Error message describing the validation failure
        """
        self.errors.append(message)
        self.is_valid = False

    def add_warning(self, message: str) -> None:
        """Add a warning message (does not affect validity).

        Args:
            message: Warning message describing a non-fatal issue
        """
        self.warnings.append(message)

    def merge(self, other: "ValidationResult") -> "ValidationResult":
        """Merge another ValidationResult into this one.

        Args:
            other: Another ValidationResult to merge

        Returns:
            Self for method chaining
        """
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)
        if not other.is_valid:
            self.is_valid = False
        return self

    def __str__(self) -> str:
        """Return human-readable summary of validation result."""
        status = "Valid" if self.is_valid else "Invalid"
        parts = [f"ValidationResult: {status}"]
        if self.errors:
            parts.append(f"Errors: {len(self.errors)}")
        if self.warnings:
            parts.append(f"Warnings: {len(self.warnings)}")
        return " | ".join(parts)


class ValidationService:
    """Provides comprehensive validation for inputs and operations.

    This service validates environment configuration, paths, and skill names
    before any file operations occur. All validation is pure (no side effects)
    and returns actionable error messages.

    The service uses PathValidator for security-focused path validation and
    integrates with Config for environment validation.

    Example:
        >>> validator = ValidationService()
        >>> result = validator.validate_environment()
        >>> if not result.is_valid:
        ...     for error in result.errors:
        ...         print(f"Error: {error}")
    """

    def __init__(self, path_validator: PathValidator | None = None) -> None:
        """Initialize ValidationService.

        Args:
            path_validator: Optional PathValidator instance for path validation.
                           If not provided, a new instance is created.
        """
        self.path_validator = path_validator or PathValidator()

    def validate_environment(self) -> ValidationResult:
        """Validate that the environment is properly configured.

        Checks:
        - DC environment variable is set
        - Config can be loaded successfully
        - Skills directory path is valid
        - Output directory path is valid

        Returns:
            ValidationResult with any errors or warnings
        """
        result = ValidationResult()

        # Check DC environment variable
        dc_value = os.environ.get("DC")
        if not dc_value:
            result.add_error(
                "Environment variable 'DC' is not set. "
                "Set it to your development container path (e.g., ~/dc)."
            )
            return result

        # Try to load config
        try:
            config = Config.from_environment()
        except (ConfigurationError, EnvironmentVariableError) as e:
            result.add_error(f"Configuration error: {e}")
            return result

        # Validate skills directory exists
        if not config.skills_directory.exists():
            result.add_warning(
                f"Skills directory does not exist: {config.skills_directory}. "
                "No skills will be discovered."
            )
        elif not config.skills_directory.is_dir():
            result.add_error(
                f"Skills path is not a directory: {config.skills_directory}. "
                f"Please ensure ~/.claude/skills is a directory."
            )

        # Validate output directory (parent should exist or be creatable)
        output_parent = config.output_directory.parent
        if not output_parent.exists():
            result.add_warning(
                f"Output directory parent does not exist: {output_parent}. "
                "It will be created when packaging skills."
            )

        return result

    def validate_paths(
        self,
        source_path: str | Path,
        output_path: str | Path,
        allowed_base: str | Path | None = None,
    ) -> ValidationResult:
        """Validate source and output paths for file operations.

        Checks:
        - Source path exists and is a directory
        - Source path is within allowed base (if specified)
        - Output path parent exists or can be created
        - No path traversal attacks

        Args:
            source_path: Path to source directory (skill to package)
            output_path: Path where output will be written
            allowed_base: Optional base directory that source must be within

        Returns:
            ValidationResult with any errors or warnings
        """
        result = ValidationResult()

        # Convert to Path objects
        source = Path(source_path).expanduser().resolve()
        output = Path(output_path).expanduser().resolve()

        # Validate source path exists
        if not source.exists():
            result.add_error(
                f"Source path does not exist: {source}. "
                f"Please check the path and try again."
            )
        elif not source.is_dir():
            result.add_error(
                f"Source path is not a directory: {source}. "
                f"Please provide a valid directory path."
            )

        # Validate source is within allowed base (if specified)
        if allowed_base is not None:
            try:
                self.path_validator.validate_path(source, allowed_base)
            except (PathTraversalError, SecurityError) as e:
                result.add_error(f"Security validation failed: {e}")

        # Validate output path parent
        output_parent = output.parent
        if not output_parent.exists():
            result.add_warning(
                f"Output directory does not exist: {output_parent}. "
                "It will be created."
            )
        elif not output_parent.is_dir():
            result.add_error(
                f"Output path parent is not a directory: {output_parent}. "
                f"Please provide a valid output directory path."
            )

        # Check if output file already exists
        if output.exists():
            result.add_warning(f"Output file already exists and will be overwritten: {output}")

        return result

    def validate_skill_name(
        self, skill_name: str, available_skills: list[str] | None = None
    ) -> ValidationResult:
        """Validate a skill name.

        Checks:
        - Name is not empty
        - Name doesn't contain invalid characters
        - Name exists in available skills (if list provided)

        Args:
            skill_name: Skill name to validate
            available_skills: Optional list of available skill names to check against

        Returns:
            ValidationResult with any errors or warnings
        """
        result = ValidationResult()

        # Check for empty name
        if not skill_name:
            result.add_error("Skill name cannot be empty. Please provide a valid skill name.")
            return result

        # Check for whitespace-only name
        if skill_name.isspace():
            result.add_error("Skill name cannot be whitespace only. Please provide a valid skill name.")
            return result

        # Strip whitespace for further validation
        skill_name = skill_name.strip()

        # Check for invalid characters (basic validation)
        invalid_chars = set('<>:"/\\|?*')
        found_invalid = [c for c in skill_name if c in invalid_chars]
        if found_invalid:
            result.add_error(
                f"Skill name contains invalid characters: {', '.join(repr(c) for c in found_invalid)}. "
                f"Please use only alphanumeric characters, hyphens, and underscores."
            )

        # Check against available skills (if provided)
        if available_skills is not None and skill_name not in available_skills:
            # Check for similar names (case-insensitive)
            lower_name = skill_name.lower()
            similar = [s for s in available_skills if s.lower() == lower_name]
            if similar:
                result.add_error(
                    f"Skill '{skill_name}' not found. Did you mean '{similar[0]}'?"
                )
            else:
                result.add_error(
                    f"Skill '{skill_name}' not found in available skills. "
                    f"Run 'skillex list' to see available skills."
                )

        return result

    def validate_all(
        self,
        skill_name: str | None = None,
        source_path: str | Path | None = None,
        output_path: str | Path | None = None,
        available_skills: list[str] | None = None,
    ) -> ValidationResult:
        """Perform comprehensive validation of all inputs.

        Convenience method that combines environment, path, and skill validation.

        Args:
            skill_name: Optional skill name to validate
            source_path: Optional source path to validate
            output_path: Optional output path to validate
            available_skills: Optional list of available skill names

        Returns:
            ValidationResult with all errors and warnings combined
        """
        result = ValidationResult()

        # Always validate environment
        result.merge(self.validate_environment())

        # Validate skill name if provided
        if skill_name is not None:
            result.merge(self.validate_skill_name(skill_name, available_skills))

        # Validate paths if both provided
        if source_path is not None and output_path is not None:
            result.merge(self.validate_paths(source_path, output_path))

        return result
