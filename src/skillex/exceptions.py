"""Custom exceptions for skillex.

This module defines all custom exceptions used throughout the application.
Exceptions are organized by layer and purpose to provide clear error handling.
"""


class SkillexError(Exception):
    """Base exception for all skillex errors."""

    pass


# Infrastructure Layer Exceptions


class FileSystemError(SkillexError):
    """Base exception for file system operations."""

    pass


class DirectoryNotFoundError(FileSystemError):
    """Raised when a directory does not exist."""

    pass


class FileNotFoundError(FileSystemError):
    """Raised when a file does not exist."""

    pass


class PermissionDeniedError(FileSystemError):
    """Raised when file system operation lacks permissions."""

    pass


class DirectoryCreateError(FileSystemError):
    """Raised when directory creation fails."""

    pass


class PathResolutionError(FileSystemError):
    """Raised when path resolution fails."""

    pass


# Security Exceptions


class SecurityError(SkillexError):
    """Base exception for security-related errors."""

    pass


class PathTraversalError(SecurityError):
    """Raised when path traversal attack is detected."""

    pass


# Configuration Exceptions


class ConfigurationError(SkillexError):
    """Base exception for configuration errors."""

    pass


class EnvironmentVariableError(ConfigurationError):
    """Raised when required environment variable is missing."""

    pass


# Validation Exceptions


class ValidationError(SkillexError):
    """Base exception for validation errors."""

    pass


# Packaging Exceptions


class PackagingError(SkillexError):
    """Base exception for packaging errors."""

    pass


class ArchiveCreationError(PackagingError):
    """Raised when ZIP archive creation fails."""

    pass


class ArchiveIntegrityError(PackagingError):
    """Raised when ZIP archive integrity check fails."""

    pass
