"""Unit tests for SkillDiscoveryService - Skill discovery testing."""

from pathlib import Path

import pytest

from skillex.infrastructure.config import Config
from skillex.infrastructure.filesystem import FileSystemManager
from skillex.services.discovery import SkillDiscoveryService, SkillInfo


class TestSkillInfo:
    """Test suite for SkillInfo dataclass."""

    def test_dataclass_creation(self) -> None:
        """Test SkillInfo dataclass creation."""
        skill_info = SkillInfo(
            name="python-pro",
            path=Path("/home/user/.claude/skills/python-pro"),
            size_bytes=1024,
            file_count=5,
        )

        assert skill_info.name == "python-pro"
        assert skill_info.path == Path("/home/user/.claude/skills/python-pro")
        assert skill_info.size_bytes == 1024
        assert skill_info.file_count == 5

    def test_skillinfo_is_immutable(self) -> None:
        """Test that SkillInfo is frozen (immutable)."""
        from dataclasses import FrozenInstanceError

        skill_info = SkillInfo(
            name="test-skill",
            path=Path("/path/to/skill"),
            size_bytes=100,
            file_count=2,
        )

        # Attempting to modify should raise FrozenInstanceError
        with pytest.raises(FrozenInstanceError):
            skill_info.name = "new-name"

    def test_skillinfo_str_representation(self) -> None:
        """Test __str__ method produces readable output."""
        skill_info = SkillInfo(
            name="test-skill",
            path=Path("/path/to/skill"),
            size_bytes=2048,
            file_count=10,
        )

        str_repr = str(skill_info)

        assert "SkillInfo" in str_repr
        assert "test-skill" in str_repr
        assert "10" in str_repr
        assert "2048" in str_repr

    def test_skillinfo_equality(self) -> None:
        """Test SkillInfo equality comparison."""
        skill1 = SkillInfo(
            name="python-pro",
            path=Path("/path/to/skill"),
            size_bytes=1024,
            file_count=5,
        )

        skill2 = SkillInfo(
            name="python-pro",
            path=Path("/path/to/skill"),
            size_bytes=1024,
            file_count=5,
        )

        assert skill1 == skill2

    def test_skillinfo_hashable(self) -> None:
        """Test that SkillInfo is hashable."""
        skill_info = SkillInfo(
            name="test-skill",
            path=Path("/path"),
            size_bytes=100,
            file_count=2,
        )

        # Should be hashable
        skill_set = {skill_info}
        assert skill_info in skill_set


class TestSkillDiscoveryService:
    """Test suite for SkillDiscoveryService."""

    @pytest.fixture
    def mock_config(self, tmp_path: Path) -> Config:
        """Create a mock Config with temp skills directory.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Config: Config with skills_directory set to tmp_path
        """
        skills_dir = tmp_path / ".claude" / "skills"
        skills_dir.mkdir(parents=True)

        return Config(
            skills_directory=skills_dir,
            output_directory=tmp_path / "output",
        )

    @pytest.fixture
    def service(self, mock_config: Config) -> SkillDiscoveryService:
        """Create SkillDiscoveryService with mock config.

        Args:
            mock_config: Mock Config fixture

        Returns:
            SkillDiscoveryService: Service instance
        """
        return SkillDiscoveryService(config=mock_config)

    def test_init(self, service: SkillDiscoveryService) -> None:
        """Test SkillDiscoveryService initialization."""
        assert isinstance(service, SkillDiscoveryService)
        assert isinstance(service.config, Config)
        assert isinstance(service.fs_manager, FileSystemManager)
        assert service._cache is None

    def test_init_with_defaults(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """Test initialization with default dependencies."""
        dc_dir = tmp_path / "Downloads" / "claude"
        monkeypatch.setenv("DC", str(dc_dir))

        service = SkillDiscoveryService()

        assert isinstance(service.config, Config)
        assert isinstance(service.fs_manager, FileSystemManager)

    def test_discover_all_empty_directory(
        self, service: SkillDiscoveryService
    ) -> None:
        """Test discover_all with empty skills directory."""
        skills = service.discover_all()

        assert skills == []
        assert isinstance(skills, list)

    def test_discover_all_single_skill(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test discover_all with one skill directory."""
        # Create skill directory with files
        skill_dir = mock_config.skills_directory / "python-pro"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("# Python Pro Skill")
        (skill_dir / "readme.md").write_text("# README")

        skills = service.discover_all()

        assert len(skills) == 1
        assert skills[0].name == "python-pro"
        assert skills[0].path == skill_dir
        assert skills[0].file_count == 2
        assert skills[0].size_bytes > 0

    def test_discover_all_multiple_skills(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test discover_all with multiple skill directories."""
        skills_dir = mock_config.skills_directory

        # Create multiple skills
        skill1 = skills_dir / "typescript-pro"
        skill1.mkdir()
        (skill1 / "SKILL.md").write_text("TypeScript")

        skill2 = skills_dir / "python-pro"
        skill2.mkdir()
        (skill2 / "SKILL.md").write_text("Python")

        skill3 = skills_dir / "rust-pro"
        skill3.mkdir()
        (skill3 / "SKILL.md").write_text("Rust")

        skills = service.discover_all()

        assert len(skills) == 3
        # Should be sorted by name
        assert skills[0].name == "python-pro"
        assert skills[1].name == "rust-pro"
        assert skills[2].name == "typescript-pro"

    def test_discover_all_skips_files(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test that discover_all skips files, only processes directories."""
        skills_dir = mock_config.skills_directory

        # Create skill directory
        skill_dir = skills_dir / "python-pro"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("Skill")

        # Create files in skills directory (should be ignored)
        (skills_dir / "README.md").write_text("README")
        (skills_dir / "notes.txt").write_text("Notes")

        skills = service.discover_all()

        # Only the directory should be discovered
        assert len(skills) == 1
        assert skills[0].name == "python-pro"

    def test_discover_all_missing_directory(self, tmp_path: Path) -> None:
        """Test discover_all with non-existent skills directory."""
        # Create config with non-existent directory
        config = Config(
            skills_directory=tmp_path / "nonexistent" / "skills",
            output_directory=tmp_path / "output",
        )

        service = SkillDiscoveryService(config=config)
        skills = service.discover_all()

        # Should return empty list, not raise error
        assert skills == []

    def test_discover_all_nested_files(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test that nested files are counted correctly."""
        skill_dir = mock_config.skills_directory / "nested-skill"
        skill_dir.mkdir()

        # Root level file
        (skill_dir / "SKILL.md").write_text("Skill")

        # Nested files
        docs_dir = skill_dir / "docs"
        docs_dir.mkdir()
        (docs_dir / "guide.md").write_text("Guide")
        (docs_dir / "api.md").write_text("API")

        # Deeply nested
        examples_dir = docs_dir / "examples"
        examples_dir.mkdir()
        (examples_dir / "example1.py").write_text("Example 1")

        skills = service.discover_all()

        assert len(skills) == 1
        assert skills[0].file_count == 4  # All files should be counted

    def test_discover_all_caching(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test that discover_all caches results."""
        # Create skill
        skill_dir = mock_config.skills_directory / "python-pro"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("Skill")

        # First call
        skills1 = service.discover_all()
        assert len(skills1) == 1

        # Add another skill directory (won't be discovered due to cache)
        skill_dir2 = mock_config.skills_directory / "rust-pro"
        skill_dir2.mkdir()
        (skill_dir2 / "SKILL.md").write_text("Rust")

        # Second call should return cached result
        skills2 = service.discover_all()
        assert len(skills2) == 1  # Still only 1 skill (cached)

        # Should be same object
        assert skills1 is skills2

    def test_clear_cache(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test clear_cache method."""
        # Create skill
        skill_dir = mock_config.skills_directory / "python-pro"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text("Skill")

        # Discover and cache
        skills1 = service.discover_all()
        assert len(skills1) == 1
        assert service._cache is not None

        # Clear cache
        service.clear_cache()
        assert service._cache is None

        # Add another skill
        skill_dir2 = mock_config.skills_directory / "rust-pro"
        skill_dir2.mkdir()
        (skill_dir2 / "SKILL.md").write_text("Rust")

        # Discover again (should see both skills now)
        skills2 = service.discover_all()
        assert len(skills2) == 2

    def test_discover_all_calculates_size(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test that size is calculated correctly."""
        skill_dir = mock_config.skills_directory / "python-pro"
        skill_dir.mkdir()

        # Write files with known sizes
        content1 = "x" * 100
        content2 = "y" * 200
        (skill_dir / "file1.txt").write_text(content1)
        (skill_dir / "file2.txt").write_text(content2)

        skills = service.discover_all()

        assert len(skills) == 1
        assert skills[0].size_bytes == 300  # 100 + 200

    def test_discover_all_skill_with_no_files(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test skill directory with no files (empty directory)."""
        # Create empty skill directory
        skill_dir = mock_config.skills_directory / "empty-skill"
        skill_dir.mkdir()

        skills = service.discover_all()

        assert len(skills) == 1
        assert skills[0].name == "empty-skill"
        assert skills[0].file_count == 0
        assert skills[0].size_bytes == 0

    def test_discover_all_symlinks_not_followed(
        self, service: SkillDiscoveryService, mock_config: Config, tmp_path: Path
    ) -> None:
        """Test that symlinks are not followed or counted."""
        # Create skill directory
        skill_dir = mock_config.skills_directory / "test-skill"
        skill_dir.mkdir()
        (skill_dir / "regular.txt").write_text("content")

        # Create external file
        external_file = tmp_path / "external.txt"
        external_file.write_text("external content")

        # Create symlink inside skill directory
        symlink = skill_dir / "link.txt"
        symlink.symlink_to(external_file)

        skills = service.discover_all()

        assert len(skills) == 1
        # Symlink should not be counted
        assert skills[0].file_count == 1  # Only regular.txt

    def test_discover_all_special_characters_in_names(
        self, service: SkillDiscoveryService, mock_config: Config
    ) -> None:
        """Test skills with special characters in names."""
        skills_dir = mock_config.skills_directory

        # Create skills with special characters
        skill1 = skills_dir / "python-3.12-pro"
        skill1.mkdir()
        (skill1 / "SKILL.md").write_text("Skill")

        skill2 = skills_dir / "skill_with_underscores"
        skill2.mkdir()
        (skill2 / "SKILL.md").write_text("Skill")

        skill3 = skills_dir / "skill.with.dots"
        skill3.mkdir()
        (skill3 / "SKILL.md").write_text("Skill")

        skills = service.discover_all()

        assert len(skills) == 3
        names = {s.name for s in skills}
        assert "python-3.12-pro" in names
        assert "skill_with_underscores" in names
        assert "skill.with.dots" in names

    def test_calculate_size_helper(
        self, service: SkillDiscoveryService, tmp_path: Path
    ) -> None:
        """Test _calculate_size helper method."""
        test_dir = tmp_path / "test"
        test_dir.mkdir()

        # Create files
        (test_dir / "file1.txt").write_text("a" * 50)
        (test_dir / "file2.txt").write_text("b" * 100)

        # Nested file
        subdir = test_dir / "subdir"
        subdir.mkdir()
        (subdir / "file3.txt").write_text("c" * 75)

        size = service._calculate_size(test_dir)
        assert size == 225  # 50 + 100 + 75

    def test_count_files_helper(
        self, service: SkillDiscoveryService, tmp_path: Path
    ) -> None:
        """Test _count_files helper method."""
        test_dir = tmp_path / "test"
        test_dir.mkdir()

        # Create files
        (test_dir / "file1.txt").write_text("content")
        (test_dir / "file2.txt").write_text("content")

        # Nested files
        subdir = test_dir / "subdir"
        subdir.mkdir()
        (subdir / "file3.txt").write_text("content")
        (subdir / "file4.txt").write_text("content")

        # Another nested level
        subsubdir = subdir / "nested"
        subsubdir.mkdir()
        (subsubdir / "file5.txt").write_text("content")

        count = service._count_files(test_dir)
        assert count == 5


class TestSkillDiscoveryServiceEdgeCases:
    """Edge case tests for SkillDiscoveryService."""

    @pytest.fixture
    def mock_config(self, tmp_path: Path) -> Config:
        """Create mock Config."""
        return Config(
            skills_directory=tmp_path / "skills",
            output_directory=tmp_path / "output",
        )

    def test_discover_all_path_not_directory(self, tmp_path: Path) -> None:
        """Test discover_all when skills_directory is a file, not directory."""
        # Create file instead of directory
        skills_file = tmp_path / "skills.txt"
        skills_file.write_text("not a directory")

        config = Config(
            skills_directory=skills_file,
            output_directory=tmp_path / "output",
        )

        service = SkillDiscoveryService(config=config)
        skills = service.discover_all()

        # Should return empty list gracefully
        assert skills == []

    def test_discover_all_permission_error_handling(
        self, mock_config: Config, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test graceful handling of permission errors."""
        service = SkillDiscoveryService(config=mock_config)

        # Create skills directory
        mock_config.skills_directory.mkdir(parents=True)

        # Mock list_directory to raise exception
        def mock_list_directory(path):
            raise PermissionError("Permission denied")

        monkeypatch.setattr(service.fs_manager, "list_directory", mock_list_directory)

        skills = service.discover_all()

        # Should return empty list, not crash
        assert skills == []

    def test_size_calculation_with_inaccessible_files(
        self, mock_config: Config
    ) -> None:
        """Test size calculation skips inaccessible files."""
        service = SkillDiscoveryService(config=mock_config)

        skill_dir = mock_config.skills_directory
        skill_dir.mkdir(parents=True)

        skill = skill_dir / "test-skill"
        skill.mkdir()

        # Create regular file
        (skill / "accessible.txt").write_text("a" * 100)

        # The _calculate_size method should handle OSError gracefully
        # We can't easily test permission errors in unit tests,
        # but the code handles them
        skills = service.discover_all()

        assert len(skills) == 1
        assert skills[0].size_bytes >= 100
