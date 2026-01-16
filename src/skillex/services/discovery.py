"""Skill Discovery Service - Service Layer Component.

This module provides skill discovery functionality by scanning the Claude skills
directory and returning metadata about each discovered skill. Results are cached
within a single command execution for performance.
"""

from dataclasses import dataclass
from pathlib import Path

from skillex.infrastructure.config import Config
from skillex.infrastructure.filesystem import FileSystemManager


@dataclass(frozen=True)
class SkillInfo:
    """Immutable information about a discovered skill.

    This dataclass contains metadata about a skill discovered in the
    skills directory. All paths are absolute.

    Attributes:
        name: Skill directory name (e.g., "python-pro")
        path: Absolute path to skill directory
        size_bytes: Total size of all files in skill directory
        file_count: Number of files in skill directory (recursive)

    The frozen=True parameter makes this dataclass immutable and hashable.
    """

    name: str
    path: Path
    size_bytes: int
    file_count: int

    def __str__(self) -> str:
        """Return human-readable string representation.

        Returns:
            str: Formatted skill info summary
        """
        return (
            f"SkillInfo(name='{self.name}', "
            f"files={self.file_count}, "
            f"size={self.size_bytes} bytes)"
        )


class SkillDiscoveryService:
    """Discovers Claude skills from the configured skills directory.

    This service scans the skills directory and returns metadata about each
    discovered skill. Results are cached within the service instance for
    performance during single command execution.

    The service:
    - Reads skills from Config.skills_directory
    - Identifies directories only (not files)
    - Returns empty list if directory doesn't exist (graceful)
    - Caches results for subsequent calls
    - No recursive scanning (top-level only)
    """

    def __init__(
        self,
        config: Config | None = None,
        fs_manager: FileSystemManager | None = None,
    ) -> None:
        """Initialize the SkillDiscoveryService.

        Args:
            config: Configuration object. If None, creates from environment.
            fs_manager: FileSystemManager instance. If None, creates new instance.
        """
        self.config = config if config is not None else Config.from_environment()
        self.fs_manager = fs_manager if fs_manager is not None else FileSystemManager()

        # Cache for discovered skills (cleared between command executions)
        self._cache: list[SkillInfo] | None = None

    def discover_all(self) -> list[SkillInfo]:
        """Discover all skills in the configured skills directory.

        Scans the skills directory (Config.skills_directory) and returns
        metadata for each skill found. Only top-level directories are
        scanned (no recursion).

        Results are cached within this service instance for performance.
        Subsequent calls return the cached result.

        Returns:
            list[SkillInfo]: List of discovered skills, sorted by name.
                            Returns empty list if directory doesn't exist.

        Example:
            >>> service = SkillDiscoveryService()
            >>> skills = service.discover_all()
            >>> for skill in skills:
            ...     print(f"{skill.name}: {skill.file_count} files")
            python-pro: 5 files
            typescript-pro: 8 files
        """
        # Return cached result if available
        if self._cache is not None:
            return self._cache

        # Get skills directory from config
        skills_dir = self.config.skills_directory

        # Return empty list if directory doesn't exist (graceful)
        if not self.fs_manager.check_exists(skills_dir):
            self._cache = []
            return self._cache

        # Return empty list if path is not a directory
        if not skills_dir.is_dir():
            self._cache = []
            return self._cache

        # Discover skills
        skills: list[SkillInfo] = []

        # List all items in skills directory
        try:
            items = self.fs_manager.list_directory(skills_dir)
        except Exception:
            # If listing fails for any reason, return empty list
            self._cache = []
            return self._cache

        # Process each item
        for item_path in items:
            # Skip files, only process directories
            if not item_path.is_dir():
                continue

            # Get skill name (directory name)
            skill_name = item_path.name

            # Calculate skill statistics
            size_bytes = self._calculate_size(item_path)
            file_count = self._count_files(item_path)

            # Create SkillInfo
            skill_info = SkillInfo(
                name=skill_name,
                path=item_path,
                size_bytes=size_bytes,
                file_count=file_count,
            )

            skills.append(skill_info)

        # Sort by name for consistent ordering
        skills.sort(key=lambda s: s.name)

        # Cache result
        self._cache = skills

        return skills

    def _calculate_size(self, directory: Path) -> int:
        """Calculate total size of all files in directory (recursive).

        Args:
            directory: Directory to calculate size for

        Returns:
            int: Total size in bytes
        """
        total_size = 0

        try:
            for item in directory.rglob("*"):
                if item.is_file() and not item.is_symlink():
                    try:
                        total_size += item.stat().st_size
                    except OSError:
                        # Skip files that can't be accessed
                        continue
        except OSError:
            # If directory traversal fails, return 0
            return 0

        return total_size

    def _count_files(self, directory: Path) -> int:
        """Count total number of files in directory (recursive).

        Args:
            directory: Directory to count files in

        Returns:
            int: Number of files (not including directories)
        """
        file_count = 0

        try:
            for item in directory.rglob("*"):
                if item.is_file() and not item.is_symlink():
                    file_count += 1
        except OSError:
            # If directory traversal fails, return 0
            return 0

        return file_count

    def clear_cache(self) -> None:
        """Clear the cached skill discovery results.

        This method is primarily for testing. In normal usage, the cache
        persists for the lifetime of the service instance.
        """
        self._cache = None
