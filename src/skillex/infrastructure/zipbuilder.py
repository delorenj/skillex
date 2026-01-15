"""ZIP Archive Builder - Infrastructure Layer Component.

This module provides reliable ZIP archive creation with data integrity
guarantees. All skill packaging operations use this component to create
distributable archives.
"""

import contextlib
import os
import tempfile
import zipfile
from pathlib import Path

from skillex.exceptions import ArchiveCreationError, ArchiveIntegrityError
from skillex.infrastructure.filesystem import FileSystemManager


class ZipArchiveBuilder:
    """Creates ZIP archives with data integrity guarantees.

    This class handles skill packaging with:
    - Atomic operations (temp file → rename on success)
    - ZIP_DEFLATED compression
    - Relative path preservation
    - Symlink protection (no following)
    - Integrity validation after creation

    All operations are designed to be safe and reversible, with no partial
    or corrupt archives left on disk if operations fail.
    """

    def __init__(self, fs_manager: FileSystemManager | None = None) -> None:
        """Initialize the ZipArchiveBuilder.

        Args:
            fs_manager: Optional FileSystemManager instance for file operations.
                       If None, creates a new instance.
        """
        self.fs_manager = fs_manager or FileSystemManager()

    def create_archive(self, source_dir: str | Path, output_path: str | Path) -> Path:
        """Create a ZIP archive from a source directory.

        This method packages a directory into a ZIP archive with:
        - Atomic operations: writes to temp file, renames on success
        - Compression: ZIP_DEFLATED for size reduction
        - Relative paths: archived paths relative to parent of source_dir
        - Security: symlinks are not followed
        - Integrity: validates archive after creation

        Args:
            source_dir: Directory to archive
            output_path: Destination path for ZIP file

        Returns:
            Absolute Path to created archive

        Raises:
            ArchiveCreationError: If archive creation fails
            ArchiveIntegrityError: If integrity validation fails

        Example:
            >>> builder = ZipArchiveBuilder()
            >>> archive = builder.create_archive(
            ...     "/home/user/skills/my-skill",
            ...     "/output/my-skill.zip"
            ... )
            >>> print(archive)
            Path('/output/my-skill.zip')
        """
        # Resolve paths to absolute
        source_dir_path = Path(source_dir).resolve()
        output_path_obj = Path(output_path).resolve()

        # Validate source directory exists
        if not self.fs_manager.check_exists(source_dir_path):
            raise ArchiveCreationError(
                f"Source directory not found: {source_dir_path}"
            )

        if not source_dir_path.is_dir():
            raise ArchiveCreationError(
                f"Source path is not a directory: {source_dir_path}"
            )

        # Create output directory if needed
        output_dir = output_path_obj.parent
        if not self.fs_manager.check_exists(output_dir):
            self.fs_manager.create_directory(output_dir, parents=True)

        # Create temp file in same directory as output for atomic rename
        # (rename only works atomically within same filesystem)
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=".tmp_",
                suffix=".zip",
                dir=output_dir,
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)

            # Create ZIP archive
            self._write_archive(source_dir_path, temp_path)

            # Validate archive integrity
            self._validate_archive(temp_path)

            # Atomic rename: temp file → final path
            # This ensures no partial archives exist on failure
            temp_path.replace(output_path_obj)

            return output_path_obj

        except Exception as e:
            # Clean up temp file on any error
            if "temp_path" in locals() and temp_path.exists():
                with contextlib.suppress(OSError):
                    temp_path.unlink()

            # Re-raise as ArchiveCreationError if not already
            if isinstance(e, (ArchiveCreationError, ArchiveIntegrityError)):
                raise
            else:
                raise ArchiveCreationError(
                    f"Failed to create archive '{output_path}': {e}"
                ) from e

    def _write_archive(self, source_dir: Path, archive_path: Path) -> None:
        """Write directory contents to ZIP archive.

        Args:
            source_dir: Source directory to archive
            archive_path: Path to ZIP file to create

        Raises:
            ArchiveCreationError: If writing archive fails
        """
        try:
            # Get parent directory for relative path calculation
            # Archive paths are relative to parent of source_dir
            # E.g., /home/user/skills/my-skill → my-skill/file.txt
            parent_dir = source_dir.parent

            with zipfile.ZipFile(
                archive_path,
                mode="w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=6,  # Balanced compression
            ) as zf:
                # Walk directory tree
                for root, _dirs, files in os.walk(source_dir, followlinks=False):
                    root_path = Path(root)

                    # Archive all files
                    for file_name in files:
                        file_path = root_path / file_name

                        # Skip symlinks (security)
                        if file_path.is_symlink():
                            continue

                        # Calculate relative path from parent
                        try:
                            arcname = file_path.relative_to(parent_dir)
                        except ValueError:
                            # Should not happen, but handle gracefully
                            arcname = file_path.relative_to(source_dir.parent)

                        # Add file to archive with relative path
                        zf.write(file_path, arcname=str(arcname))

        except OSError as e:
            raise ArchiveCreationError(
                f"Failed to write archive '{archive_path}': {e}"
            ) from e
        except zipfile.BadZipFile as e:
            raise ArchiveCreationError(
                f"Failed to create valid ZIP file '{archive_path}': {e}"
            ) from e

    def _validate_archive(self, archive_path: Path) -> None:
        """Validate ZIP archive integrity.

        Performs testzip() to check for corrupt files in the archive.

        Args:
            archive_path: Path to ZIP archive to validate

        Raises:
            ArchiveIntegrityError: If archive is corrupt or invalid
        """
        try:
            with zipfile.ZipFile(archive_path, mode="r") as zf:
                # Test ZIP integrity
                # Returns name of first bad file or None if all OK
                bad_file = zf.testzip()

                if bad_file is not None:
                    raise ArchiveIntegrityError(
                        f"Archive '{archive_path}' is corrupt: "
                        f"bad file '{bad_file}'"
                    )

        except zipfile.BadZipFile as e:
            raise ArchiveIntegrityError(
                f"Archive '{archive_path}' is not a valid ZIP file: {e}"
            ) from e
        except OSError as e:
            raise ArchiveIntegrityError(
                f"Failed to validate archive '{archive_path}': {e}"
            ) from e
