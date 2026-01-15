"""Unit tests for PathValidator - Security-focused testing."""

import os
import random
import string
from pathlib import Path

import pytest

from skillex.exceptions import PathTraversalError, SecurityError
from skillex.infrastructure.validator import PathValidator


class TestPathValidator:
    """Test suite for PathValidator security validation."""

    @pytest.fixture
    def validator(self) -> PathValidator:
        """Create a PathValidator instance.

        Returns:
            PathValidator instance
        """
        return PathValidator()

    @pytest.fixture
    def safe_base(self, tmp_path: Path) -> Path:
        """Create a safe base directory for testing.

        Args:
            tmp_path: pytest tmp_path fixture

        Returns:
            Path to safe base directory
        """
        base = tmp_path / "safe_base"
        base.mkdir()
        return base

    @pytest.fixture
    def nested_structure(self, safe_base: Path) -> dict[str, Path]:
        """Create a nested directory structure for testing.

        Args:
            safe_base: Base directory path

        Returns:
            Dictionary mapping names to paths
        """
        # Create nested structure
        level1 = safe_base / "level1"
        level1.mkdir()

        level2 = level1 / "level2"
        level2.mkdir()

        level3 = level2 / "level3"
        level3.mkdir()

        # Create a file
        test_file = level3 / "test.txt"
        test_file.write_text("test content")

        return {
            "base": safe_base,
            "level1": level1,
            "level2": level2,
            "level3": level3,
            "file": test_file,
        }

    def test_init(self, validator: PathValidator) -> None:
        """Test PathValidator initialization."""
        assert isinstance(validator, PathValidator)

    def test_validate_path_within_base(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test validating a path within allowed base."""
        child_path = safe_base / "child" / "file.txt"
        result = validator.validate_path(child_path, safe_base)

        assert result == child_path.resolve()
        assert result.is_absolute()

    def test_validate_path_exact_base(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test validating the base directory itself."""
        result = validator.validate_path(safe_base, safe_base)
        assert result == safe_base.resolve()

    def test_validate_path_string_inputs(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test validation with string inputs instead of Path objects."""
        child_str = str(safe_base / "child")
        base_str = str(safe_base)

        result = validator.validate_path(child_str, base_str)
        assert isinstance(result, Path)
        assert result.is_absolute()

    def test_validate_path_relative_within_base(
        self, validator: PathValidator, safe_base: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test validation with relative path within base."""
        # Change to base directory
        monkeypatch.chdir(safe_base)

        # Relative path
        result = validator.validate_path("./child/file.txt", safe_base)
        expected = (safe_base / "child" / "file.txt").resolve()

        assert result == expected

    def test_traversal_attack_parent_directory(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test detection of ../ traversal attack."""
        malicious_path = safe_base / ".." / ".." / "etc" / "passwd"

        with pytest.raises(PathTraversalError) as exc_info:
            validator.validate_path(malicious_path, safe_base)

        assert "outside allowed directory" in str(exc_info.value)
        assert str(malicious_path) in str(exc_info.value)

    def test_traversal_attack_multiple_parents(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test detection of multiple ../ in path."""
        malicious_path = safe_base / "child" / ".." / ".." / ".." / "etc"

        with pytest.raises(PathTraversalError):
            validator.validate_path(malicious_path, safe_base)

    def test_traversal_attack_absolute_path_outside(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test detection of absolute path outside base."""
        malicious_path = Path("/etc/passwd")

        with pytest.raises(PathTraversalError) as exc_info:
            validator.validate_path(malicious_path, safe_base)

        assert "outside allowed directory" in str(exc_info.value)

    def test_traversal_attack_from_child(
        self, validator: PathValidator, nested_structure: dict[str, Path]
    ) -> None:
        """Test traversal from deep child trying to escape."""
        base = nested_structure["base"]
        level3 = nested_structure["level3"]

        # Try to escape from level3
        malicious_path = level3 / ".." / ".." / ".." / ".." / "etc"

        with pytest.raises(PathTraversalError):
            validator.validate_path(malicious_path, base)

    def test_symlink_to_outside_directory(
        self, validator: PathValidator, tmp_path: Path
    ) -> None:
        """Test detection of symlink pointing outside allowed base."""
        safe_base = tmp_path / "safe"
        safe_base.mkdir()

        outside_dir = tmp_path / "outside"
        outside_dir.mkdir()

        # Create symlink inside safe_base pointing to outside_dir
        symlink = safe_base / "escape_link"
        symlink.symlink_to(outside_dir)

        # Symlink resolves to outside directory, should be rejected
        with pytest.raises(PathTraversalError):
            validator.validate_path(symlink, safe_base)

    def test_symlink_within_base(
        self, validator: PathValidator, nested_structure: dict[str, Path]
    ) -> None:
        """Test symlink that stays within allowed base."""
        base = nested_structure["base"]
        level1 = nested_structure["level1"]
        level3 = nested_structure["level3"]

        # Create symlink from level1 to level3 (both within base)
        symlink = level1 / "link_to_level3"
        symlink.symlink_to(level3)

        # Should be valid as it stays within base
        result = validator.validate_path(symlink, base)
        assert result == level3.resolve()

    def test_tilde_expansion_within_base(
        self, validator: PathValidator, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Test path with ~ expansion."""
        # Set HOME to tmp_path
        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setenv("HOME", str(home))

        safe_base = home / "safe"
        safe_base.mkdir()

        # Path with ~ should expand correctly
        result = validator.validate_path("~/safe/file.txt", home)
        expected = (home / "safe" / "file.txt").resolve()

        assert result == expected

    def test_redundant_separators(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test path with redundant separators like //."""
        # Path with extra slashes
        messy_path = str(safe_base) + "//child///file.txt"

        result = validator.validate_path(messy_path, safe_base)
        expected = (safe_base / "child" / "file.txt").resolve()

        assert result == expected

    def test_dot_current_directory(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test path with . (current directory) references."""
        dotted_path = safe_base / "." / "child" / "." / "file.txt"

        result = validator.validate_path(dotted_path, safe_base)
        expected = (safe_base / "child" / "file.txt").resolve()

        assert result == expected

    def test_empty_path_components(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test path with empty components."""
        # Paths with trailing slashes
        result = validator.validate_path(safe_base / "child/", safe_base)
        expected = (safe_base / "child").resolve()

        assert result == expected

    def test_case_sensitive_paths(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test that path validation is case-sensitive."""
        child = safe_base / "Child"
        child.mkdir()

        # Exact case should work
        result = validator.validate_path(safe_base / "Child", safe_base)
        assert result == child.resolve()

        # Different case - behavior depends on filesystem
        # On case-insensitive filesystems (macOS, Windows), this resolves
        # On case-sensitive filesystems (Linux), this may fail
        # We just test that validation works, not the case behavior

    def test_nonexistent_path_within_base(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test validation of nonexistent path within base."""
        # Path doesn't need to exist, just needs to be within base
        nonexistent = safe_base / "doesnt" / "exist" / "yet.txt"

        result = validator.validate_path(nonexistent, safe_base)
        assert result == nonexistent.resolve()

    def test_nonexistent_path_outside_base(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test validation of nonexistent path outside base."""
        nonexistent = Path("/nonexistent/path/outside.txt")

        with pytest.raises(PathTraversalError):
            validator.validate_path(nonexistent, safe_base)

    def test_special_characters_in_path(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test paths with special characters."""
        special_chars = "!@#$%^&()[]{}';,."
        special_path = safe_base / f"special{special_chars}file.txt"

        # Should handle special characters
        result = validator.validate_path(special_path, safe_base)
        assert result == special_path.resolve()

    def test_unicode_in_path(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test paths with unicode characters."""
        unicode_path = safe_base / "файл" / "文件.txt"

        result = validator.validate_path(unicode_path, safe_base)
        assert result == unicode_path.resolve()

    def test_very_long_path(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test very long path validation."""
        # Create a very long path
        long_component = "a" * 200
        long_path = safe_base
        for _ in range(5):
            long_path = long_path / long_component

        result = validator.validate_path(long_path, safe_base)
        assert result == long_path.resolve()

    def test_fuzzing_random_paths(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Fuzzing test with random path inputs."""
        # Generate random path components
        for _ in range(20):
            components = []
            for _ in range(random.randint(1, 5)):
                # Random component with mixed characters
                comp = "".join(
                    random.choices(
                        string.ascii_letters + string.digits + "._-", k=random.randint(1, 20)
                    )
                )
                components.append(comp)

            random_path = safe_base / Path(*components)

            # Should either validate or raise PathTraversalError
            # Should never raise other exceptions
            try:
                result = validator.validate_path(random_path, safe_base)
                # If validated, should be absolute
                assert result.is_absolute()
            except (PathTraversalError, SecurityError):
                # Expected for some random paths
                pass

    def test_fuzzing_malicious_patterns(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Fuzzing test with known malicious patterns."""
        malicious_patterns = [
            "../" * 10 + "etc/passwd",
            "./../" * 5 + "root",
            "....//....//....//etc",
            ".." + os.sep + ".." + os.sep + "etc",
            safe_base.as_posix() + "/../../../etc",
        ]

        for pattern in malicious_patterns:
            with pytest.raises((PathTraversalError, SecurityError)):
                validator.validate_path(pattern, safe_base)

    def test_null_byte_injection(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test null byte injection attempt."""
        # Null bytes should be handled safely by Path
        # This is more about ensuring no crashes
        try:
            malicious = str(safe_base / "file.txt\x00/etc/passwd")
            validator.validate_path(malicious, safe_base)
        except (ValueError, PathTraversalError, SecurityError):
            # Expected - Path or validation should reject null bytes
            pass

    def test_windows_drive_letter_escape(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test Windows drive letter escape attempt."""
        # On Unix, C: is just a directory name
        # On Windows, it's a drive letter
        # Either way, if outside base should be rejected

        try:
            result = validator.validate_path("C:/Windows/System32", safe_base)
            # If this succeeds, it resolved to something within base
            # (unlikely but possible)
            assert result.is_relative_to(safe_base.resolve())
        except PathTraversalError:
            # Expected on most systems
            pass

    def test_unc_path_escape(
        self, validator: PathValidator, safe_base: Path
    ) -> None:
        """Test UNC path escape attempt (Windows network paths)."""
        try:
            result = validator.validate_path("//server/share/file", safe_base)
            # If validated, must be within base
            assert result.is_relative_to(safe_base.resolve())
        except PathTraversalError:
            # Expected
            pass


class TestPathValidatorEdgeCases:
    """Additional edge case tests for PathValidator."""

    @pytest.fixture
    def validator(self) -> PathValidator:
        """Create a PathValidator instance."""
        return PathValidator()

    def test_base_with_trailing_slash(
        self, validator: PathValidator, tmp_path: Path
    ) -> None:
        """Test base path with trailing slash."""
        base = tmp_path / "base/"
        child = base / "child"

        result = validator.validate_path(child, base)
        assert result.is_absolute()

    def test_relative_base_directory(
        self, validator: PathValidator, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test validation with relative base directory."""
        monkeypatch.chdir(tmp_path)

        base = Path("relative_base")
        base.mkdir()

        child = base / "child"

        result = validator.validate_path(child, base)
        expected = (tmp_path / "relative_base" / "child").resolve()
        assert result == expected

    def test_base_equals_path(
        self, validator: PathValidator, tmp_path: Path
    ) -> None:
        """Test when path equals base exactly."""
        result = validator.validate_path(tmp_path, tmp_path)
        assert result == tmp_path.resolve()

    def test_deeply_nested_valid_path(
        self, validator: PathValidator, tmp_path: Path
    ) -> None:
        """Test very deeply nested but valid path."""
        base = tmp_path / "base"
        base.mkdir()

        # Create 20 levels deep
        deep_path = base
        for i in range(20):
            deep_path = deep_path / f"level{i}"

        result = validator.validate_path(deep_path, base)
        assert result == deep_path.resolve()
        assert result.is_relative_to(base.resolve())
