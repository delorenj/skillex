"""Unit tests for FileSystemManager."""

from datetime import datetime
from pathlib import Path

import pytest

from skillex.exceptions import (
    DirectoryCreateError,
    DirectoryNotFoundError,
    FileSystemError,
)
from skillex.infrastructure.filesystem import FileMetadata, FileSystemManager


class TestFileSystemManager:
    """Test suite for FileSystemManager."""

    @pytest.fixture
    def fs_manager(self) -> FileSystemManager:
        """Create a FileSystemManager instance.

        Returns:
            FileSystemManager instance
        """
        return FileSystemManager()

    @pytest.fixture
    def temp_dir(self, tmp_path: Path) -> Path:
        """Create a temporary directory with some files.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Path to temporary directory
        """
        # Create test structure
        test_dir = tmp_path / "test_skills"
        test_dir.mkdir()

        # Create some test files
        (test_dir / "file1.txt").write_text("content1")
        (test_dir / "file2.txt").write_text("content2")

        # Create a subdirectory
        subdir = test_dir / "subdir"
        subdir.mkdir()
        (subdir / "file3.txt").write_text("content3")

        return test_dir

    def test_init(self, fs_manager: FileSystemManager) -> None:
        """Test FileSystemManager initialization."""
        assert isinstance(fs_manager, FileSystemManager)

    def test_resolve_path_string(self, fs_manager: FileSystemManager, tmp_path: Path) -> None:
        """Test path resolution from string."""
        path_str = str(tmp_path)
        resolved = fs_manager._resolve_path(path_str)

        assert isinstance(resolved, Path)
        assert resolved.is_absolute()
        assert resolved == tmp_path.resolve()

    def test_resolve_path_pathlib(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test path resolution from Path object."""
        resolved = fs_manager._resolve_path(tmp_path)

        assert isinstance(resolved, Path)
        assert resolved.is_absolute()
        assert resolved == tmp_path.resolve()

    def test_resolve_path_with_tilde(self, fs_manager: FileSystemManager) -> None:
        """Test path resolution with home directory tilde."""
        resolved = fs_manager._resolve_path("~/test")

        assert isinstance(resolved, Path)
        assert resolved.is_absolute()
        assert "~" not in str(resolved)

    def test_list_directory_success(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test successful directory listing."""
        items = fs_manager.list_directory(temp_dir)

        assert isinstance(items, list)
        assert len(items) == 3  # 2 files + 1 subdirectory
        assert all(isinstance(item, Path) for item in items)
        assert all(item.is_absolute() for item in items)

        # Check items are sorted
        names = [item.name for item in items]
        assert names == sorted(names)

    def test_list_directory_with_pattern(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test directory listing with glob pattern."""
        items = fs_manager.list_directory(temp_dir, pattern="*.txt")

        assert len(items) == 2  # Only .txt files in root
        assert all(item.suffix == ".txt" for item in items)

    def test_list_directory_not_found(self, fs_manager: FileSystemManager) -> None:
        """Test listing non-existent directory."""
        with pytest.raises(DirectoryNotFoundError) as exc_info:
            fs_manager.list_directory("/nonexistent/directory")

        assert "Directory not found" in str(exc_info.value)

    def test_list_directory_not_a_directory(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test listing a file path instead of directory."""
        file_path = temp_dir / "file1.txt"

        with pytest.raises(FileSystemError) as exc_info:
            fs_manager.list_directory(file_path)

        assert "not a directory" in str(exc_info.value)

    def test_check_exists_file(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test checking existence of a file."""
        file_path = temp_dir / "file1.txt"
        assert fs_manager.check_exists(file_path) is True

    def test_check_exists_directory(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test checking existence of a directory."""
        assert fs_manager.check_exists(temp_dir) is True

    def test_check_exists_nonexistent(self, fs_manager: FileSystemManager) -> None:
        """Test checking existence of non-existent path."""
        assert fs_manager.check_exists("/nonexistent/path") is False

    def test_check_exists_string_path(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test checking existence with string path."""
        assert fs_manager.check_exists(str(temp_dir)) is True

    def test_get_metadata_file(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test getting metadata for a file."""
        file_path = temp_dir / "file1.txt"
        metadata = fs_manager.get_metadata(file_path)

        assert isinstance(metadata, FileMetadata)
        assert metadata.path == file_path.resolve()
        assert metadata.is_file is True
        assert metadata.is_directory is False
        assert metadata.size_bytes == 8  # "content1" = 8 bytes
        assert metadata.file_count is None
        assert isinstance(metadata.created_at, datetime)
        assert isinstance(metadata.modified_at, datetime)

    def test_get_metadata_directory(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test getting metadata for a directory."""
        metadata = fs_manager.get_metadata(temp_dir)

        assert isinstance(metadata, FileMetadata)
        assert metadata.path == temp_dir.resolve()
        assert metadata.is_file is False
        assert metadata.is_directory is True
        assert metadata.size_bytes > 0  # Should include all files
        assert metadata.file_count == 3  # 3 total files in tree
        assert isinstance(metadata.created_at, datetime)
        assert isinstance(metadata.modified_at, datetime)

    def test_get_metadata_nonexistent(self, fs_manager: FileSystemManager) -> None:
        """Test getting metadata for non-existent path."""
        with pytest.raises(DirectoryNotFoundError) as exc_info:
            fs_manager.get_metadata("/nonexistent/path")

        assert "Path not found" in str(exc_info.value)

    def test_file_metadata_size_human(self) -> None:
        """Test FileMetadata.size_human property."""
        metadata = FileMetadata(
            path=Path("/test"),
            size_bytes=1024,
            is_file=True,
            is_directory=False,
            created_at=datetime.now(),
            modified_at=datetime.now(),
        )

        assert metadata.size_human == "1.0 KB"

        # Test different sizes
        metadata.size_bytes = 1536  # 1.5 KB
        assert metadata.size_human == "1.5 KB"

        metadata.size_bytes = 1024 * 1024  # 1 MB
        assert metadata.size_human == "1.0 MB"

        metadata.size_bytes = 512  # 512 B
        assert metadata.size_human == "512.0 B"

    def test_create_directory_success(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test successful directory creation."""
        new_dir = tmp_path / "new_directory"
        result = fs_manager.create_directory(new_dir)

        assert result == new_dir.resolve()
        assert new_dir.exists()
        assert new_dir.is_dir()

    def test_create_directory_with_parents(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test directory creation with parent directories."""
        new_dir = tmp_path / "parent" / "child" / "grandchild"
        result = fs_manager.create_directory(new_dir, parents=True)

        assert result == new_dir.resolve()
        assert new_dir.exists()
        assert new_dir.is_dir()
        assert (tmp_path / "parent").exists()
        assert (tmp_path / "parent" / "child").exists()

    def test_create_directory_without_parents(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test directory creation without parent directories."""
        new_dir = tmp_path / "nonexistent_parent" / "child"

        with pytest.raises(DirectoryCreateError):
            fs_manager.create_directory(new_dir, parents=False)

    def test_create_directory_exist_ok(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test creating directory that already exists with exist_ok=True."""
        result = fs_manager.create_directory(temp_dir, exist_ok=True)

        assert result == temp_dir.resolve()
        assert temp_dir.exists()

    def test_create_directory_exists_not_ok(
        self, fs_manager: FileSystemManager, temp_dir: Path
    ) -> None:
        """Test creating directory that already exists with exist_ok=False."""
        with pytest.raises(DirectoryCreateError) as exc_info:
            fs_manager.create_directory(temp_dir, exist_ok=False)

        assert "already exists" in str(exc_info.value)

    def test_create_directory_string_path(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test directory creation with string path."""
        new_dir = str(tmp_path / "string_path_dir")
        result = fs_manager.create_directory(new_dir)

        assert result == Path(new_dir).resolve()
        assert Path(new_dir).exists()

    def test_list_directory_empty(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test listing an empty directory."""
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()

        items = fs_manager.list_directory(empty_dir)
        assert items == []

    def test_get_metadata_empty_directory(
        self, fs_manager: FileSystemManager, tmp_path: Path
    ) -> None:
        """Test getting metadata for an empty directory."""
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()

        metadata = fs_manager.get_metadata(empty_dir)

        assert metadata.is_directory is True
        assert metadata.size_bytes == 0
        assert metadata.file_count == 0

    def test_relative_path_resolution(
        self, fs_manager: FileSystemManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test that relative paths are resolved to absolute."""
        monkeypatch.chdir(tmp_path)

        # Create a file in current directory
        test_file = Path("test_file.txt")
        test_file.write_text("test")

        # Check with relative path
        metadata = fs_manager.get_metadata("test_file.txt")
        assert metadata.path.is_absolute()
        assert metadata.path == (tmp_path / "test_file.txt").resolve()


class TestFileMetadata:
    """Test suite for FileMetadata dataclass."""

    def test_file_metadata_creation(self) -> None:
        """Test FileMetadata dataclass creation."""
        metadata = FileMetadata(
            path=Path("/test/file.txt"),
            size_bytes=1024,
            is_file=True,
            is_directory=False,
            created_at=datetime(2024, 1, 1, 12, 0),
            modified_at=datetime(2024, 1, 2, 12, 0),
            file_count=None,
        )

        assert metadata.path == Path("/test/file.txt")
        assert metadata.size_bytes == 1024
        assert metadata.is_file is True
        assert metadata.is_directory is False
        assert metadata.file_count is None

    def test_size_human_bytes(self) -> None:
        """Test human-readable size for bytes."""
        metadata = FileMetadata(
            path=Path("/test"),
            size_bytes=500,
            is_file=True,
            is_directory=False,
            created_at=datetime.now(),
            modified_at=datetime.now(),
        )
        assert metadata.size_human == "500.0 B"

    def test_size_human_kilobytes(self) -> None:
        """Test human-readable size for kilobytes."""
        metadata = FileMetadata(
            path=Path("/test"),
            size_bytes=2048,  # 2 KB
            is_file=True,
            is_directory=False,
            created_at=datetime.now(),
            modified_at=datetime.now(),
        )
        assert metadata.size_human == "2.0 KB"

    def test_size_human_megabytes(self) -> None:
        """Test human-readable size for megabytes."""
        metadata = FileMetadata(
            path=Path("/test"),
            size_bytes=5 * 1024 * 1024,  # 5 MB
            is_file=True,
            is_directory=False,
            created_at=datetime.now(),
            modified_at=datetime.now(),
        )
        assert metadata.size_human == "5.0 MB"

    def test_size_human_gigabytes(self) -> None:
        """Test human-readable size for gigabytes."""
        metadata = FileMetadata(
            path=Path("/test"),
            size_bytes=3 * 1024 * 1024 * 1024,  # 3 GB
            is_file=True,
            is_directory=False,
            created_at=datetime.now(),
            modified_at=datetime.now(),
        )
        assert metadata.size_human == "3.0 GB"

    def test_size_human_zero(self) -> None:
        """Test human-readable size for zero bytes."""
        metadata = FileMetadata(
            path=Path("/test"),
            size_bytes=0,
            is_file=True,
            is_directory=False,
            created_at=datetime.now(),
            modified_at=datetime.now(),
        )
        assert metadata.size_human == "0.0 B"
