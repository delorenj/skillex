"""Default path helpers for skillex."""

from __future__ import annotations

from pathlib import Path


def default_config_path() -> Path:
    """~/.config/skillex/skillex.toml"""
    return Path.home() / ".config" / "skillex" / "skillex.toml"


def default_lock_path() -> Path:
    """~/.config/skillex/.lock"""
    return Path.home() / ".config" / "skillex" / ".lock"


def find_project_root(start: Path) -> Path | None:
    """Walk up from `start` looking for .skillex.toml or a git root.

    Returns None if neither is found.
    """
    current = start.resolve()
    while True:
        if (current / ".skillex.toml").is_file():
            return current
        if (current / ".git").exists():
            return current
        if current.parent == current:
            return None
        current = current.parent


def load_project_scope_pack(project_root: Path) -> str | None:
    """Read `.skillex.toml` at project_root and return the active pack for project scope, if any."""
    path = project_root / ".skillex.toml"
    if not path.is_file():
        return None
    import tomllib
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        return None
    scopes = data.get("scopes", {})
    project = scopes.get("project", {})
    active = project.get("active_pack")
    return str(active) if isinstance(active, str) else None
