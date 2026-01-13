"""File System Manager - Infrastructure Layer Component.

This module provides an abstraction over file system operations,
ensuring cross-platform compatibility and comprehensive error handling.
All file operations go through this layer for consistency and testability.
"""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from skillex.exceptions import (
    DirectoryCreateError,
    DirectoryNotFoundError,
    FileSystemError,
    PathResolutionError,
    PermissionDeniedError,
)


@dataclass
class FileMetadata:
    """Metadata for a file or directory.

    Attributes:
        path: Absolute path to the file/directory
        size_bytes: Size in bytes (0 for directories)
        is_file: True if path points to a file
        is_directory: True if path points to a directory
        created_at: Creation timestamp
        modified_at: Last modification timestamp
        file_count: Number of files in directory (None for files)
    """

    path: Path
    size_bytes: int
    is_file: bool
    is_directory: bool
    created_at: datetime
    modified_at: datetime
    file_count: int | None = None

    @property
    def size_human(self) -> str:
        """Return human-readable size (e.g., '1.2 MB').

        Returns:
            Human-readable size string
        """
        units = ["B", "KB", "MB", "GB", "TB"]
        size = float(self.size_bytes)
        unit_index = 0

        while size >= 1024.0 and unit_index < len(units) - 1:
            size /= 1024.0
            unit_index += 1

        return f"{size:.1f} {units[unit_index]}"


class FileSystemManager:
    """Manages file system operations with cross-platform compatibility.

    This class provides a consistent interface for file operations across
    different operating systems. All paths are resolved to absolute paths
    internally for safety and consistency.

    The manager handles:
    - Directory listing
    - Existence checking
    - Metadata retrieval
    - Directory creation

    All methods raise specific exceptions from skillex.exceptions for
    proper error handling.
    """

    def __init__(self) -> None:
        """Initialize the FileSystemManager."""
        pass

    def _resolve_path(self, path: str | Path) -> Path:
        """Resolve path to absolute form.

        Args:
            path: Path as string or Path object

        Returns:
            Absolute Path object

        Raises:
            PathResolutionError: If path resolution fails
        """
        try:
            if isinstance(path, str):
                path = Path(path)

            # Expand user home directory
            path = path.expanduser()

            # Resolve to absolute path
            absolute_path = path.resolve()

            return absolute_path

        except (OSError, RuntimeError) as e:
            raise PathResolutionError(
                f"Failed to resolve path '{path}': {e}"
            ) from e

    def list_directory(
        self, directory: str | Path, pattern: str = "*"
    ) -> list[Path]:
        """List contents of a directory.

        Args:
            directory: Path to directory to list
            pattern: Glob pattern for filtering (default: "*" for all)

        Returns:
            List of absolute Path objects for items in directory

        Raises:
            DirectoryNotFoundError: If directory does not exist
            PermissionDeniedError: If lacking read permissions
            FileSystemError: For other file system errors
        """
        dir_path = self._resolve_path(directory)

        if not dir_path.exists():
            raise DirectoryNotFoundError(
                f"Directory not found: {dir_path}"
            )

        if not dir_path.is_dir():
            raise FileSystemError(
                f"Path is not a directory: {dir_path}"
            )

        try:
            items = list(dir_path.glob(pattern))
            return sorted(items)

        except PermissionError as e:
            raise PermissionDeniedError(
                f"Permission denied reading directory '{dir_path}': {e}"
            ) from e

        except OSError as e:
            raise FileSystemError(
                f"Error reading directory '{dir_path}': {e}"
            ) from e

    def check_exists(self, path: str | Path) -> bool:
        """Check if a path exists.

        Args:
            path: Path to check

        Returns:
            True if path exists, False otherwise

        Raises:
            PathResolutionError: If path resolution fails
        """
        resolved_path = self._resolve_path(path)
        return resolved_path.exists()

    def get_metadata(self, path: str | Path) -> FileMetadata:
        """Get metadata for a file or directory.

        Args:
            path: Path to file or directory

        Returns:
            FileMetadata object with path information

        Raises:
            DirectoryNotFoundError: If path does not exist
            PermissionDeniedError: If lacking read permissions
            FileSystemError: For other file system errors
        """
        resolved_path = self._resolve_path(path)

        if not resolved_path.exists():
            raise DirectoryNotFoundError(
                f"Path not found: {resolved_path}"
            )

        try:
            stat_info = resolved_path.stat()

            is_file = resolved_path.is_file()
            is_directory = resolved_path.is_dir()

            # Calculate directory size and file count if directory
            size_bytes = 0
            file_count = None

            if is_directory:
                file_count = 0
                for item in resolved_path.rglob("*"):
                    if item.is_file():
                        try:
                            size_bytes += item.stat().st_size
                            file_count += 1
                        except (OSError, PermissionError):
                            # Skip files we can't access
                            continue
            else:
                size_bytes = stat_info.st_size

            return FileMetadata(
                path=resolved_path,
                size_bytes=size_bytes,
                is_file=is_file,
                is_directory=is_directory,
                created_at=datetime.fromtimestamp(stat_info.st_ctime),
                modified_at=datetime.fromtimestamp(stat_info.st_mtime),
                file_count=file_count,
            )

        except PermissionError as e:
            raise PermissionDeniedError(
                f"Permission denied accessing '{resolved_path}': {e}"
            ) from e

        except OSError as e:
            raise FileSystemError(
                f"Error getting metadata for '{resolved_path}': {e}"
            ) from e

    def create_directory(
        self, directory: str | Path, parents: bool = True, exist_ok: bool = True
    ) -> Path:
        """Create a directory.

        Args:
            directory: Path to directory to create
            parents: Create parent directories if needed (default: True)
            exist_ok: Don't raise error if directory exists (default: True)

        Returns:
            Absolute Path object for created directory

        Raises:
            DirectoryCreateError: If directory creation fails
            PermissionDeniedError: If lacking write permissions
            FileSystemError: For other file system errors
        """
        dir_path = self._resolve_path(directory)

        try:
            dir_path.mkdir(parents=parents, exist_ok=exist_ok)
            return dir_path

        except FileExistsError as e:
            raise DirectoryCreateError(
                f"Directory already exists: {dir_path}"
            ) from e

        except PermissionError as e:
            raise PermissionDeniedError(
                f"Permission denied creating directory '{dir_path}': {e}"
            ) from e

        except OSError as e:
            raise DirectoryCreateError(
                f"Failed to create directory '{dir_path}': {e}"
            ) from e
