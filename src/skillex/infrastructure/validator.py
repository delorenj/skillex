"""Path Validator - Security-focused path validation.

This module provides security validation for file paths to prevent
directory traversal attacks and other path-based security vulnerabilities.
All user-controlled paths should be validated through this component.
"""

from pathlib import Path

from skillex.exceptions import PathTraversalError, SecurityError


class PathValidator:
    """Validates file paths to prevent security vulnerabilities.

    This class provides methods to validate that paths are safe to use,
    preventing directory traversal attacks and ensuring paths stay within
    allowed boundaries.

    The validator:
    - Resolves paths to absolute canonical form
    - Detects directory traversal attempts (../, absolute paths)
    - Validates paths are within allowed base directories
    - Raises clear SecurityError exceptions on validation failure

    All validation is performed on the resolved (canonical) path to handle
    symlinks, relative paths, and other path obfuscation techniques.
    """

    def validate_path(self, path: str | Path, allowed_base: str | Path) -> Path:
        """Validate that a path is safe and within allowed boundaries.

        This method performs comprehensive security validation on a path:
        1. Resolves both path and allowed_base to canonical absolute form
        2. Checks that resolved path is a child of allowed_base
        3. Prevents directory traversal attacks

        Args:
            path: Path to validate (can be relative or absolute)
            allowed_base: Base directory that path must be within

        Returns:
            Validated absolute Path object

        Raises:
            SecurityError: If path validation fails (base class)
            PathTraversalError: If path attempts to escape allowed_base

        Examples:
            >>> validator = PathValidator()
            >>> # Valid path within base
            >>> validator.validate_path("/home/user/skills/my-skill", "/home/user/skills")
            Path('/home/user/skills/my-skill')

            >>> # Invalid: tries to escape with ../
            >>> validator.validate_path("../../etc/passwd", "/home/user/skills")
            PathTraversalError: Path traversal detected

            >>> # Invalid: absolute path outside base
            >>> validator.validate_path("/etc/passwd", "/home/user/skills")
            PathTraversalError: Path outside allowed directory
        """
        # Convert to Path objects if strings
        if isinstance(path, str):
            path = Path(path)
        if isinstance(allowed_base, str):
            allowed_base = Path(allowed_base)

        try:
            # Resolve to absolute canonical paths
            # This handles:
            # - Relative paths (., ..)
            # - Symlinks (follows to target)
            # - Redundant separators (//)
            # - ~ expansion
            resolved_path = path.expanduser().resolve()
            resolved_base = allowed_base.expanduser().resolve()

        except (OSError, RuntimeError) as e:
            raise SecurityError(
                f"Failed to resolve path '{path}' or base '{allowed_base}': {e}"
            ) from e

        # Check if resolved path is relative to (child of) allowed base
        # Path.is_relative_to() returns True if path is under base
        try:
            if not resolved_path.is_relative_to(resolved_base):
                raise PathTraversalError(
                    f"Path '{path}' (resolves to '{resolved_path}') "
                    f"is outside allowed directory '{allowed_base}' "
                    f"(resolves to '{resolved_base}')"
                )
        except ValueError as e:
            # is_relative_to can raise ValueError on Windows with different drives
            raise PathTraversalError(
                f"Path '{path}' is not within allowed base '{allowed_base}': {e}"
            ) from e

        return resolved_path
