"""Pytest configuration and fixtures for skillex tests."""

import os
import re
import pytest


def strip_ansi(text: str) -> str:
    """Strip ANSI escape codes from text.

    Args:
        text: Text potentially containing ANSI codes

    Returns:
        Text with all ANSI codes removed
    """
    ansi_escape = re.compile(r'\x1b\[[0-9;]*m')
    return ansi_escape.sub('', text)


@pytest.fixture
def ansi_strip():
    """Fixture providing ANSI code stripping function."""
    return strip_ansi


@pytest.fixture(autouse=True)
def disable_colors(monkeypatch):
    """Disable colored output in all tests for consistent assertions.

    Sets NO_COLOR environment variable to disable ANSI color codes
    in rich output, making test assertions simpler and more reliable.
    """
    monkeypatch.setenv("NO_COLOR", "1")
