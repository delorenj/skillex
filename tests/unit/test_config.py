"""Unit tests for Config - Environment configuration testing."""

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from skillex.exceptions import EnvironmentVariableError
from skillex.infrastructure.config import Config


class TestConfig:
    """Test suite for Config environment configuration."""

    def test_dataclass_creation(self) -> None:
        """Test direct Config dataclass creation."""
        skills_dir = Path("/home/user/.claude/skills")
        output_dir = Path("/home/user/Downloads/claude/skills")

        config = Config(
            skills_directory=skills_dir,
            output_directory=output_dir,
        )

        assert config.skills_directory == skills_dir
        assert config.output_directory == output_dir

    def test_config_is_immutable(self) -> None:
        """Test that Config is frozen (immutable)."""
        config = Config(
            skills_directory=Path("/home/user/.claude/skills"),
            output_directory=Path("/home/user/Downloads/skills"),
        )

        # Attempting to modify should raise FrozenInstanceError
        with pytest.raises(FrozenInstanceError):
            config.skills_directory = Path("/new/path")  # type: ignore

        with pytest.raises(FrozenInstanceError):
            config.output_directory = Path("/new/path")  # type: ignore

    def test_from_environment_with_dc_set(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test from_environment() when $DC is set."""
        # Set $DC environment variable
        dc_dir = tmp_path / "Downloads" / "claude"
        monkeypatch.setenv("DC", str(dc_dir))

        config = Config.from_environment()

        # Check skills_directory default
        expected_skills = Path.home() / ".claude" / "skills"
        assert config.skills_directory == expected_skills.resolve()

        # Check output_directory from $DC
        expected_output = dc_dir / "skills"
        assert config.output_directory == expected_output.resolve()

    def test_from_environment_with_tilde_in_dc(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test from_environment() with ~ in $DC value."""
        # Set $DC with tilde
        monkeypatch.setenv("DC", "~/Downloads/claude")

        config = Config.from_environment()

        # Tilde should be expanded
        expected_output = Path.home() / "Downloads" / "claude" / "skills"
        assert config.output_directory == expected_output.resolve()
        assert not str(config.output_directory).startswith("~")

    def test_from_environment_without_dc_raises_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test from_environment() raises error when $DC not set."""
        # Ensure $DC is not set
        monkeypatch.delenv("DC", raising=False)

        with pytest.raises(EnvironmentVariableError) as exc_info:
            Config.from_environment()

        assert "DC" in str(exc_info.value)
        assert "not set" in str(exc_info.value).lower()

    def test_from_environment_with_empty_dc_raises_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test from_environment() raises error when $DC is empty string."""
        # Set $DC to empty string
        monkeypatch.setenv("DC", "")

        with pytest.raises(EnvironmentVariableError):
            Config.from_environment()

    def test_from_environment_paths_are_absolute(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that from_environment() returns absolute paths."""
        dc_dir = tmp_path / "Downloads" / "claude"
        monkeypatch.setenv("DC", str(dc_dir))

        config = Config.from_environment()

        # Both paths should be absolute
        assert config.skills_directory.is_absolute()
        assert config.output_directory.is_absolute()

    def test_from_environment_relative_dc_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test from_environment() with relative path in $DC."""
        # Set $DC to relative path
        monkeypatch.setenv("DC", "Downloads/claude")

        config = Config.from_environment()

        # Path should be resolved to absolute
        assert config.output_directory.is_absolute()

    def test_skills_directory_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that skills_directory defaults to ~/.claude/skills/."""
        dc_dir = tmp_path / "Downloads"
        monkeypatch.setenv("DC", str(dc_dir))

        config = Config.from_environment()

        expected = Path.home() / ".claude" / "skills"
        assert config.skills_directory == expected.resolve()

    def test_output_directory_structure(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that output_directory is $DC/skills/."""
        dc_dir = tmp_path / "Downloads" / "claude"
        monkeypatch.setenv("DC", str(dc_dir))

        config = Config.from_environment()

        # Should be $DC/skills/
        assert config.output_directory == (dc_dir / "skills").resolve()

    def test_config_str_representation(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test __str__ method produces readable output."""
        dc_dir = tmp_path / "Downloads" / "claude"
        monkeypatch.setenv("DC", str(dc_dir))

        config = Config.from_environment()
        str_repr = str(config)

        # Should contain key information
        assert "Config" in str_repr
        assert "skills_directory" in str_repr
        assert "output_directory" in str_repr
        assert str(config.skills_directory) in str_repr
        assert str(config.output_directory) in str_repr

    def test_multiple_from_environment_calls(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that multiple from_environment() calls produce consistent results."""
        dc_dir = tmp_path / "Downloads" / "claude"
        monkeypatch.setenv("DC", str(dc_dir))

        config1 = Config.from_environment()
        config2 = Config.from_environment()

        # Should be equal
        assert config1.skills_directory == config2.skills_directory
        assert config1.output_directory == config2.output_directory

    def test_config_with_special_characters_in_dc(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test Config handles special characters in $DC path."""
        # Path with spaces and special characters
        dc_dir = tmp_path / "My Downloads" / "claude (v2)"
        dc_dir.mkdir(parents=True)
        monkeypatch.setenv("DC", str(dc_dir))

        config = Config.from_environment()

        expected = dc_dir / "skills"
        assert config.output_directory == expected.resolve()

    def test_config_equality(self) -> None:
        """Test Config equality comparison."""
        skills_dir = Path("/home/user/.claude/skills")
        output_dir = Path("/home/user/Downloads/skills")

        config1 = Config(
            skills_directory=skills_dir,
            output_directory=output_dir,
        )

        config2 = Config(
            skills_directory=skills_dir,
            output_directory=output_dir,
        )

        assert config1 == config2

    def test_config_inequality(self) -> None:
        """Test Config inequality comparison."""
        config1 = Config(
            skills_directory=Path("/home/user/.claude/skills"),
            output_directory=Path("/home/user/Downloads/skills"),
        )

        config2 = Config(
            skills_directory=Path("/different/path/.claude/skills"),
            output_directory=Path("/home/user/Downloads/skills"),
        )

        assert config1 != config2

    def test_config_hashable(self) -> None:
        """Test that Config is hashable (can be used in sets/dicts)."""
        config = Config(
            skills_directory=Path("/home/user/.claude/skills"),
            output_directory=Path("/home/user/Downloads/skills"),
        )

        # Should be hashable
        config_set = {config}
        assert config in config_set

        # Should work as dict key
        config_dict = {config: "value"}
        assert config_dict[config] == "value"


class TestConfigEdgeCases:
    """Edge case tests for Config."""

    def test_from_environment_with_whitespace_dc(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test from_environment() with whitespace in $DC."""
        # $DC with leading/trailing whitespace
        monkeypatch.setenv("DC", "  ~/Downloads/claude  ")

        config = Config.from_environment()

        # Should handle whitespace gracefully
        # Python's Path should strip it during processing
        assert config.output_directory.is_absolute()

    def test_from_environment_dc_env_precedence(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test that $DC environment variable takes precedence."""
        dc_dir1 = tmp_path / "first"
        dc_dir2 = tmp_path / "second"

        # Set $DC
        monkeypatch.setenv("DC", str(dc_dir1))
        config1 = Config.from_environment()

        # Change $DC
        monkeypatch.setenv("DC", str(dc_dir2))
        config2 = Config.from_environment()

        # Should reflect different $DC values
        assert config1.output_directory != config2.output_directory
        assert config1.output_directory == (dc_dir1 / "skills").resolve()
        assert config2.output_directory == (dc_dir2 / "skills").resolve()

    def test_config_dataclass_repr(self) -> None:
        """Test Config __repr__ (default dataclass repr)."""
        config = Config(
            skills_directory=Path("/home/user/.claude/skills"),
            output_directory=Path("/home/user/Downloads/skills"),
        )

        repr_str = repr(config)

        # Default dataclass repr should include class name and fields
        assert "Config" in repr_str
        assert "skills_directory" in repr_str
        assert "output_directory" in repr_str
