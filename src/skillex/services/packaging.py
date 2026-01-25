"""Packaging Service - Core skill packaging orchestration.

This module provides the main orchestration for packaging Claude skills
into distributable ZIP archives. It coordinates discovery, matching,
validation, and archive creation.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from skillex.exceptions import PackagingError
from skillex.infrastructure.config import Config
from skillex.infrastructure.zipbuilder import ZipArchiveBuilder
from skillex.services.discovery import SkillDiscoveryService, SkillInfo
from skillex.services.fuzzy import FuzzyMatcherService
from skillex.services.validation import ValidationResult, ValidationService

# Type alias for progress callback: (current: int, total: int, skill_name: str) -> None
ProgressCallback = Callable[[int, int, str], None]


@dataclass
class SkillPackageResult:
    """Result of packaging a single skill.

    Attributes:
        skill_name: Name of the skill
        success: Whether packaging succeeded
        output_path: Path to created archive (if successful)
        size_bytes: Size of archive in bytes (if successful)
        error: Error message (if failed)
    """

    skill_name: str
    success: bool
    output_path: Path | None = None
    size_bytes: int = 0
    error: str | None = None


@dataclass
class PackagingResult:
    """Result of a packaging operation.

    Attributes:
        successful: List of successfully packaged skills
        failed: List of failed packaging attempts
        total_skills: Total number of skills attempted
        total_size_bytes: Total size of all created archives
        duration_seconds: Time taken for entire operation
        validation_result: Pre-packaging validation result
    """

    successful: list[SkillPackageResult] = field(default_factory=list)
    failed: list[SkillPackageResult] = field(default_factory=list)
    total_skills: int = 0
    total_size_bytes: int = 0
    duration_seconds: float = 0.0
    validation_result: ValidationResult | None = None

    @property
    def success_count(self) -> int:
        """Number of successfully packaged skills."""
        return len(self.successful)

    @property
    def failure_count(self) -> int:
        """Number of failed packaging attempts."""
        return len(self.failed)

    @property
    def all_succeeded(self) -> bool:
        """Whether all skills were packaged successfully."""
        return self.failure_count == 0 and self.success_count > 0

    @property
    def any_succeeded(self) -> bool:
        """Whether at least one skill was packaged successfully."""
        return self.success_count > 0

    def __str__(self) -> str:
        """Return human-readable summary."""
        status = "Success" if self.all_succeeded else "Partial" if self.any_succeeded else "Failed"
        return (
            f"PackagingResult: {status} | "
            f"{self.success_count}/{self.total_skills} packaged | "
            f"{self.total_size_bytes:,} bytes | "
            f"{self.duration_seconds:.2f}s"
        )


class PackagingService:
    """Orchestrates the skill packaging workflow.

    This service coordinates the full packaging pipeline:
    1. Validates environment configuration
    2. Discovers available skills
    3. Filters skills by pattern
    4. Creates ZIP archives for matched skills

    The service continues packaging on individual skill failures,
    collecting all results for reporting.

    Example:
        >>> service = PackagingService()
        >>> result = service.package_skills("python")
        >>> print(f"Packaged {result.success_count} skills")
        Packaged 2 skills
    """

    def __init__(
        self,
        config: Config | None = None,
        discovery_service: SkillDiscoveryService | None = None,
        matcher_service: FuzzyMatcherService | None = None,
        validation_service: ValidationService | None = None,
        archive_builder: ZipArchiveBuilder | None = None,
    ) -> None:
        """Initialize PackagingService with dependencies.

        Args:
            config: Configuration instance. If not provided, loads from environment.
            discovery_service: Skill discovery service. If not provided, creates one.
            matcher_service: Fuzzy matcher service. If not provided, creates one.
            validation_service: Validation service. If not provided, creates one.
            archive_builder: ZIP archive builder. If not provided, creates one.
        """
        self.config = config
        self.discovery_service = discovery_service or SkillDiscoveryService(config=config)
        self.matcher_service = matcher_service or FuzzyMatcherService()
        self.validation_service = validation_service or ValidationService()
        self.archive_builder = archive_builder or ZipArchiveBuilder()

    def _ensure_config(self) -> Config:
        """Ensure config is loaded, loading from environment if needed."""
        if self.config is None:
            self.config = Config.from_environment()
        return self.config

    def package_skills(
        self,
        pattern: str = "",
        skip_validation: bool = False,
        progress_callback: ProgressCallback | None = None,
    ) -> PackagingResult:
        """Package skills matching the given pattern.

        Discovers all available skills, filters by pattern, and creates
        ZIP archives for each matched skill. Continues on individual
        failures, collecting all results.

        Args:
            pattern: Pattern to match skill names (empty matches all)
            skip_validation: Skip environment validation (for testing)
            progress_callback: Optional callback for progress updates.
                             Called with (current, total, skill_name) after each skill.

        Returns:
            PackagingResult with details of all packaging attempts

        Raises:
            PackagingError: If environment validation fails (unless skipped)

        Example:
            >>> def on_progress(current, total, skill):
            ...     print(f"Packaging {current}/{total}: {skill}")
            >>> service = PackagingService()
            >>> result = service.package_skills("python", progress_callback=on_progress)
            Packaging 1/3: python-utils
            Packaging 2/3: python-helpers
            Packaging 3/3: python-tools
        """
        start_time = time.monotonic()
        result = PackagingResult()

        # Validate environment (unless skipped)
        if not skip_validation:
            validation = self.validation_service.validate_environment()
            result.validation_result = validation
            if not validation.is_valid:
                result.duration_seconds = time.monotonic() - start_time
                raise PackagingError(
                    f"Environment validation failed: {'; '.join(validation.errors)}"
                )

        # Load config
        config = self._ensure_config()

        # Ensure output directory exists
        config.output_directory.mkdir(parents=True, exist_ok=True)

        # Discover all skills
        all_skills = self.discovery_service.discover_all()

        # Filter by pattern
        matched_skills = self.matcher_service.match(pattern, all_skills)
        result.total_skills = len(matched_skills)

        # Package each matched skill
        for index, skill in enumerate(matched_skills, start=1):
            skill_result = self._package_single_skill(skill, config)

            if skill_result.success:
                result.successful.append(skill_result)
                result.total_size_bytes += skill_result.size_bytes
            else:
                result.failed.append(skill_result)

            # Call progress callback if provided
            if progress_callback is not None:
                progress_callback(index, len(matched_skills), skill.name)

        result.duration_seconds = time.monotonic() - start_time
        return result

    def _package_single_skill(
        self,
        skill: SkillInfo,
        config: Config,
    ) -> SkillPackageResult:
        """Package a single skill into a ZIP archive.

        Args:
            skill: Skill information
            config: Configuration with output directory

        Returns:
            SkillPackageResult with packaging outcome
        """
        output_path = config.output_directory / f"{skill.name}.zip"

        try:
            # Create the archive
            self.archive_builder.create_archive(skill.path, output_path)

            # Get the archive size
            size_bytes = output_path.stat().st_size

            return SkillPackageResult(
                skill_name=skill.name,
                success=True,
                output_path=output_path,
                size_bytes=size_bytes,
            )

        except Exception as e:
            return SkillPackageResult(
                skill_name=skill.name,
                success=False,
                error=str(e),
            )

    def package_single(
        self,
        skill_name: str,
        skip_validation: bool = False,
    ) -> SkillPackageResult:
        """Package a single skill by exact name.

        Convenience method for packaging one specific skill.

        Args:
            skill_name: Exact name of the skill to package
            skip_validation: Skip environment validation

        Returns:
            SkillPackageResult with packaging outcome

        Raises:
            PackagingError: If skill not found or validation fails
        """
        # Validate environment
        if not skip_validation:
            validation = self.validation_service.validate_environment()
            if not validation.is_valid:
                raise PackagingError(
                    f"Environment validation failed: {'; '.join(validation.errors)}"
                )

        config = self._ensure_config()

        # Discover and find the skill
        all_skills = self.discovery_service.discover_all()
        skill_names = [s.name for s in all_skills]

        # Validate skill name
        name_validation = self.validation_service.validate_skill_name(
            skill_name, available_skills=skill_names
        )
        if not name_validation.is_valid:
            raise PackagingError(
                f"Invalid skill name: {'; '.join(name_validation.errors)}"
            )

        # Find the skill
        matching_skill = next((s for s in all_skills if s.name == skill_name), None)
        if matching_skill is None:
            raise PackagingError(f"Skill '{skill_name}' not found")

        # Ensure output directory exists
        config.output_directory.mkdir(parents=True, exist_ok=True)

        return self._package_single_skill(matching_skill, config)
