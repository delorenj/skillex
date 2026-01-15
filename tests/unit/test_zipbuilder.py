"""Unit tests for ZipArchiveBuilder - Archive creation and validation testing."""

import contextlib
import os
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

from skillex.exceptions import ArchiveCreationError, ArchiveIntegrityError
from skillex.infrastructure.filesystem import FileSystemManager
from skillex.infrastructure.zipbuilder import ZipArchiveBuilder


class TestZipArchiveBuilder:
    """Test suite for ZipArchiveBuilder archive creation."""

    @pytest.fixture
    def builder(self) -> ZipArchiveBuilder:
        """Create a ZipArchiveBuilder instance.

        Returns:
            ZipArchiveBuilder instance
        """
        return ZipArchiveBuilder()

    @pytest.fixture
    def simple_dir(self, tmp_path: Path) -> Path:
        """Create a simple directory with a few files.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Path to simple directory
        """
        simple = tmp_path / "simple_skill"
        simple.mkdir()

        (simple / "SKILL.md").write_text("# Simple Skill\n\nSkill content.")
        (simple / "data.json").write_text('{"key": "value"}')

        return simple

    @pytest.fixture
    def nested_dir(self, tmp_path: Path) -> Path:
        """Create a nested directory structure.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Path to nested directory
        """
        nested = tmp_path / "nested_skill"
        nested.mkdir()

        # Root files
        (nested / "SKILL.md").write_text("# Nested Skill")
        (nested / "README.md").write_text("# README")

        # Subdirectories
        docs = nested / "docs"
        docs.mkdir()
        (docs / "guide.md").write_text("# Guide")

        assets = nested / "assets"
        assets.mkdir()
        (assets / "image.png").write_bytes(b"PNG data")

        nested_deep = assets / "icons"
        nested_deep.mkdir()
        (nested_deep / "icon.svg").write_text("<svg></svg>")

        return nested

    @pytest.fixture
    def empty_dir(self, tmp_path: Path) -> Path:
        """Create an empty directory.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Path to empty directory
        """
        empty = tmp_path / "empty_skill"
        empty.mkdir()
        return empty

    def test_init(self, builder: ZipArchiveBuilder) -> None:
        """Test ZipArchiveBuilder initialization."""
        assert isinstance(builder, ZipArchiveBuilder)
        assert isinstance(builder.fs_manager, FileSystemManager)

    def test_init_with_custom_fs_manager(self) -> None:
        """Test initialization with custom FileSystemManager."""
        custom_fs = FileSystemManager()
        builder = ZipArchiveBuilder(fs_manager=custom_fs)

        assert builder.fs_manager is custom_fs

    def test_create_archive_simple(
        self, builder: ZipArchiveBuilder, simple_dir: Path, tmp_path: Path
    ) -> None:
        """Test creating archive from simple directory."""
        output = tmp_path / "output" / "simple.zip"

        result = builder.create_archive(simple_dir, output)

        assert result == output.resolve()
        assert output.exists()
        assert output.is_file()

        # Verify archive contents
        with zipfile.ZipFile(output, "r") as zf:
            names = zf.namelist()
            assert "simple_skill/SKILL.md" in names
            assert "simple_skill/data.json" in names
            assert len(names) == 2

    def test_create_archive_nested(
        self, builder: ZipArchiveBuilder, nested_dir: Path, tmp_path: Path
    ) -> None:
        """Test creating archive from nested directory structure."""
        output = tmp_path / "output" / "nested.zip"

        result = builder.create_archive(nested_dir, output)

        assert result == output.resolve()
        assert output.exists()

        # Verify all files are in archive with correct paths
        with zipfile.ZipFile(output, "r") as zf:
            names = sorted(zf.namelist())
            expected = [
                "nested_skill/README.md",
                "nested_skill/SKILL.md",
                "nested_skill/assets/icons/icon.svg",
                "nested_skill/assets/image.png",
                "nested_skill/docs/guide.md",
            ]
            assert names == expected

    def test_create_archive_empty_directory(
        self, builder: ZipArchiveBuilder, empty_dir: Path, tmp_path: Path
    ) -> None:
        """Test creating archive from empty directory."""
        output = tmp_path / "output" / "empty.zip"

        result = builder.create_archive(empty_dir, output)

        assert result == output.resolve()
        assert output.exists()

        # Archive should be valid but contain no files
        with zipfile.ZipFile(output, "r") as zf:
            assert len(zf.namelist()) == 0

    def test_create_archive_with_compression(
        self, builder: ZipArchiveBuilder, nested_dir: Path, tmp_path: Path
    ) -> None:
        """Test that archives use compression."""
        output = tmp_path / "output" / "compressed.zip"

        builder.create_archive(nested_dir, output)

        # Check compression settings
        with zipfile.ZipFile(output, "r") as zf:
            # At least one file should be compressed
            for info in zf.infolist():
                if info.file_size > 0:
                    assert info.compress_type == zipfile.ZIP_DEFLATED

    def test_relative_path_preservation(
        self, builder: ZipArchiveBuilder, nested_dir: Path, tmp_path: Path
    ) -> None:
        """Test that relative paths are preserved correctly."""
        output = tmp_path / "output" / "relative.zip"

        builder.create_archive(nested_dir, output)

        with zipfile.ZipFile(output, "r") as zf:
            # All paths should start with directory name
            for name in zf.namelist():
                assert name.startswith("nested_skill/")
                # No absolute paths
                assert not Path(name).is_absolute()

    def test_symlink_not_followed(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test that symlinks are not followed (security)."""
        skill_dir = tmp_path / "skill_with_symlink"
        skill_dir.mkdir()

        # Create regular file
        (skill_dir / "regular.txt").write_text("regular content")

        # Create symlink to outside directory
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("secret data")

        symlink = skill_dir / "escape_link"
        symlink.symlink_to(outside)

        output = tmp_path / "output" / "symlink_test.zip"
        builder.create_archive(skill_dir, output)

        # Symlink should NOT be in archive
        with zipfile.ZipFile(output, "r") as zf:
            names = zf.namelist()
            assert "skill_with_symlink/regular.txt" in names
            assert "skill_with_symlink/escape_link" not in names
            # Should only have the regular file
            assert len(names) == 1

    def test_atomic_operation_success(
        self, builder: ZipArchiveBuilder, simple_dir: Path, tmp_path: Path
    ) -> None:
        """Test atomic operation completes successfully."""
        output = tmp_path / "output" / "atomic.zip"

        builder.create_archive(simple_dir, output)

        # Final file should exist
        assert output.exists()

        # No temp files should remain
        output_dir = output.parent
        temp_files = list(output_dir.glob(".tmp_*.zip"))
        assert len(temp_files) == 0

    def test_atomic_operation_cleanup_on_failure(
        self, builder: ZipArchiveBuilder, simple_dir: Path, tmp_path: Path
    ) -> None:
        """Test temp file cleanup when archive creation fails."""
        output = tmp_path / "output" / "fail.zip"

        # Mock _validate_archive to raise error
        with (
            patch.object(
                builder, "_validate_archive", side_effect=ArchiveIntegrityError("Mock error")
            ),
            pytest.raises(ArchiveIntegrityError),
        ):
            builder.create_archive(simple_dir, output)

        # Final file should NOT exist
        assert not output.exists()

        # Temp files should be cleaned up
        output_dir = output.parent
        temp_files = list(output_dir.glob(".tmp_*.zip"))
        assert len(temp_files) == 0

    def test_source_directory_not_found(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test error when source directory doesn't exist."""
        nonexistent = tmp_path / "nonexistent"
        output = tmp_path / "output" / "test.zip"

        with pytest.raises(ArchiveCreationError) as exc_info:
            builder.create_archive(nonexistent, output)

        assert "not found" in str(exc_info.value).lower()

    def test_source_path_not_directory(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test error when source path is a file, not directory."""
        # Create a file instead of directory
        file_path = tmp_path / "not_a_dir.txt"
        file_path.write_text("content")

        output = tmp_path / "output" / "test.zip"

        with pytest.raises(ArchiveCreationError) as exc_info:
            builder.create_archive(file_path, output)

        assert "not a directory" in str(exc_info.value).lower()

    def test_output_directory_created(
        self, builder: ZipArchiveBuilder, simple_dir: Path, tmp_path: Path
    ) -> None:
        """Test output directory is created if it doesn't exist."""
        # Output path with non-existent parent directories
        output = tmp_path / "level1" / "level2" / "level3" / "output.zip"

        builder.create_archive(simple_dir, output)

        assert output.exists()
        assert output.parent.exists()

    def test_string_paths(
        self, builder: ZipArchiveBuilder, simple_dir: Path, tmp_path: Path
    ) -> None:
        """Test archive creation with string paths instead of Path objects."""
        output = tmp_path / "output" / "string_test.zip"

        # Pass string paths
        result = builder.create_archive(str(simple_dir), str(output))

        assert isinstance(result, Path)
        assert result == output.resolve()
        assert output.exists()

    def test_special_characters_in_filenames(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test archiving files with special characters."""
        skill_dir = tmp_path / "special_chars"
        skill_dir.mkdir()

        # Create files with special characters
        (skill_dir / "file with spaces.txt").write_text("content")
        (skill_dir / "file-with-dashes.txt").write_text("content")
        (skill_dir / "file_with_underscores.txt").write_text("content")
        (skill_dir / "file.multiple.dots.txt").write_text("content")

        output = tmp_path / "output" / "special.zip"
        builder.create_archive(skill_dir, output)

        with zipfile.ZipFile(output, "r") as zf:
            names = zf.namelist()
            assert len(names) == 4
            assert "special_chars/file with spaces.txt" in names

    def test_unicode_in_filenames(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test archiving files with unicode characters."""
        skill_dir = tmp_path / "unicode_test"
        skill_dir.mkdir()

        # Create files with unicode names
        (skill_dir / "файл.txt").write_text("Russian")
        (skill_dir / "文件.txt").write_text("Chinese")
        (skill_dir / "archivo.txt").write_text("Spanish")

        output = tmp_path / "output" / "unicode.zip"
        builder.create_archive(skill_dir, output)

        with zipfile.ZipFile(output, "r") as zf:
            assert len(zf.namelist()) == 3

    def test_large_file(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test archiving large file."""
        skill_dir = tmp_path / "large_file"
        skill_dir.mkdir()

        # Create a 1MB file
        large_content = b"x" * (1024 * 1024)
        (skill_dir / "large.bin").write_bytes(large_content)

        output = tmp_path / "output" / "large.zip"
        builder.create_archive(skill_dir, output)

        assert output.exists()

        # Verify compression worked (compressed size should be smaller)
        with zipfile.ZipFile(output, "r") as zf:
            info = zf.getinfo("large_file/large.bin")
            assert info.compress_size < info.file_size

    def test_many_files(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test archiving many files."""
        skill_dir = tmp_path / "many_files"
        skill_dir.mkdir()

        # Create 100 files
        for i in range(100):
            (skill_dir / f"file_{i:03d}.txt").write_text(f"Content {i}")

        output = tmp_path / "output" / "many.zip"
        builder.create_archive(skill_dir, output)

        with zipfile.ZipFile(output, "r") as zf:
            assert len(zf.namelist()) == 100


class TestZipArchiveBuilderValidation:
    """Test suite for ZIP archive integrity validation."""

    @pytest.fixture
    def builder(self) -> ZipArchiveBuilder:
        """Create a ZipArchiveBuilder instance."""
        return ZipArchiveBuilder()

    @pytest.fixture
    def valid_archive(self, tmp_path: Path) -> Path:
        """Create a valid ZIP archive for testing.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Path to valid archive
        """
        skill_dir = tmp_path / "skill"
        skill_dir.mkdir()
        (skill_dir / "file.txt").write_text("content")

        output = tmp_path / "valid.zip"
        builder = ZipArchiveBuilder()
        builder.create_archive(skill_dir, output)

        return output

    def test_validate_archive_success(
        self, builder: ZipArchiveBuilder, valid_archive: Path
    ) -> None:
        """Test validation of valid archive."""
        # Should not raise any exception
        builder._validate_archive(valid_archive)

    def test_validate_corrupt_archive(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test validation of corrupt archive."""
        corrupt = tmp_path / "corrupt.zip"

        # Create a file that looks like ZIP but is corrupt
        corrupt.write_bytes(b"PK\x03\x04" + b"corrupt data" * 100)

        with pytest.raises(ArchiveIntegrityError):
            builder._validate_archive(corrupt)

    def test_validate_non_zip_file(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test validation of non-ZIP file."""
        not_zip = tmp_path / "not_zip.txt"
        not_zip.write_text("This is not a ZIP file")

        with pytest.raises(ArchiveIntegrityError):
            builder._validate_archive(not_zip)

    def test_validate_empty_file(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test validation of empty file."""
        empty = tmp_path / "empty.zip"
        empty.write_bytes(b"")

        with pytest.raises(ArchiveIntegrityError):
            builder._validate_archive(empty)

    def test_create_archive_validates(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test that create_archive calls validation."""
        skill_dir = tmp_path / "skill"
        skill_dir.mkdir()
        (skill_dir / "file.txt").write_text("content")

        output = tmp_path / "test.zip"

        # Mock validate to raise error
        with (
            patch.object(
                builder,
                "_validate_archive",
                side_effect=ArchiveIntegrityError("Validation failed"),
            ),
            pytest.raises(ArchiveIntegrityError),
        ):
            builder.create_archive(skill_dir, output)

        # Archive should not exist (atomic operation failed)
        assert not output.exists()


class TestZipArchiveBuilderErrorHandling:
    """Test suite for error handling in ZipArchiveBuilder."""

    @pytest.fixture
    def builder(self) -> ZipArchiveBuilder:
        """Create a ZipArchiveBuilder instance."""
        return ZipArchiveBuilder()

    def test_write_permission_error(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test error when write permission denied."""
        skill_dir = tmp_path / "skill"
        skill_dir.mkdir()
        (skill_dir / "file.txt").write_text("content")

        # Try to write to root (permission denied)
        if os.name != "nt":  # Skip on Windows
            output = Path("/root/forbidden.zip")

            with pytest.raises(ArchiveCreationError):
                builder.create_archive(skill_dir, output)

    def test_disk_full_simulation(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test handling of disk full scenario."""
        skill_dir = tmp_path / "skill"
        skill_dir.mkdir()
        (skill_dir / "file.txt").write_text("content")

        output = tmp_path / "output.zip"

        # Mock write to raise OSError (disk full)
        with patch("zipfile.ZipFile.write", side_effect=OSError("No space left")):
            with pytest.raises(ArchiveCreationError) as exc_info:
                builder.create_archive(skill_dir, output)

            assert "no space" in str(exc_info.value).lower()

    def test_file_disappears_during_archiving(
        self, builder: ZipArchiveBuilder, tmp_path: Path
    ) -> None:
        """Test handling when file disappears during archiving."""
        skill_dir = tmp_path / "skill"
        skill_dir.mkdir()
        file1 = skill_dir / "file1.txt"
        file1.write_text("content")

        output = tmp_path / "output.zip"

        # Mock os.walk to return file that doesn't exist
        original_walk = os.walk

        def mock_walk(path, **kwargs):
            """Mock walk that returns non-existent file."""
            for root, dirs, files in original_walk(path, **kwargs):
                # Add a fake file that doesn't exist
                files.append("nonexistent.txt")
                yield root, dirs, files

        # Should handle gracefully or raise clear error
        with (
            patch("os.walk", side_effect=mock_walk),
            contextlib.suppress(ArchiveCreationError),
        ):
            # Expected - file doesn't exist
            builder.create_archive(skill_dir, output)
