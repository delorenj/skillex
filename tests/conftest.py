"""Shared test fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def repo_root() -> Path:
    """Absolute path to the skillex repo root."""
    return Path(__file__).resolve().parent.parent


@pytest.fixture
def fixtures_dir(repo_root: Path) -> Path:
    """Absolute path to tests/fixtures/."""
    return repo_root / "tests" / "fixtures"
