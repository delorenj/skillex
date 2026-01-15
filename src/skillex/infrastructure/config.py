"""Environment Configuration - Infrastructure Layer Component.

This module provides configuration management by reading environment variables
and providing default paths for skill operations. All configuration is immutable
to prevent accidental modification during runtime.
"""

import os
from dataclasses import dataclass
from pathlib import Path

from skillex.exceptions import EnvironmentVariableError


@dataclass(frozen=True)
class Config:
    """Immutable configuration for skillex operations.

    This dataclass holds all configuration paths needed for skill discovery,
    packaging, and output operations. All paths are resolved to absolute paths.

    Attributes:
        skills_directory: Directory containing Claude skills to discover
        output_directory: Directory where packaged skills are saved

    The frozen=True parameter makes this dataclass immutable after creation,
    preventing accidental modification of configuration during runtime.
    """

    skills_directory: Path
    output_directory: Path

    @classmethod
    def from_environment(cls) -> "Config":
        """Create configuration from environment variables.

        Reads the $DC environment variable to determine output directory.
        Falls back to sensible defaults for skills directory.

        Environment Variables:
            DC: Required. Base directory for skill output (e.g., ~/Downloads/claude)

        Defaults:
            skills_directory: ~/.claude/skills/
            output_directory: $DC/skills/

        Returns:
            Config: Immutable configuration object with resolved absolute paths

        Raises:
            EnvironmentVariableError: If $DC environment variable is not set

        Example:
            >>> # With DC=/home/user/Downloads/claude
            >>> config = Config.from_environment()
            >>> print(config.skills_directory)
            Path('/home/user/.claude/skills')
            >>> print(config.output_directory)
            Path('/home/user/Downloads/claude/skills')

            >>> # Without DC set
            >>> config = Config.from_environment()
            EnvironmentVariableError: Required environment variable 'DC' is not set
        """
        # Check for required $DC environment variable
        dc_value = os.environ.get("DC")
        if not dc_value:
            raise EnvironmentVariableError(
                "Required environment variable 'DC' is not set. "
                "Please set DC to your downloads/output directory "
                "(e.g., export DC=~/Downloads/claude)"
            )

        # Default skills directory: ~/.claude/skills/
        skills_dir = Path.home() / ".claude" / "skills"

        # Output directory: $DC/skills/
        output_dir = Path(dc_value).expanduser() / "skills"

        # Resolve to absolute paths
        skills_dir = skills_dir.resolve()
        output_dir = output_dir.resolve()

        return cls(
            skills_directory=skills_dir,
            output_directory=output_dir,
        )

    def __str__(self) -> str:
        """Return human-readable string representation.

        Returns:
            str: Formatted configuration summary
        """
        return (
            f"Config(\n"
            f"  skills_directory={self.skills_directory}\n"
            f"  output_directory={self.output_directory}\n"
            f")"
        )
