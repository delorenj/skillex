"""Fail-closed resolution of Hermes skill directories and pointer files."""

from __future__ import annotations

import stat
from pathlib import Path

from reportctl_security import contains_secret

MAX_POINTER_BYTES = 4096


def _resolved_directory(path: Path) -> Path | None:
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return resolved if resolved.is_dir() else None


def _approved_roots(home: Path) -> list[Path]:
    roots = (home / "skills", Path.home() / ".agents" / "skills")
    return [resolved for root in roots if (resolved := _resolved_directory(root)) is not None]


def _under_approved_root(target: Path, roots: list[Path]) -> bool:
    return any(target == root or target.is_relative_to(root) for root in roots)


def _pointer_target(entry: Path) -> Path | None:
    try:
        metadata = entry.lstat()
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= MAX_POINTER_BYTES:
            return None
        raw = entry.read_bytes()
    except OSError:
        return None
    if len(raw) > MAX_POINTER_BYTES or b"\x00" in raw:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        return None
    lines = text.splitlines()
    if len(lines) != 1 or not lines[0].strip() or contains_secret(text):
        return None
    value = lines[0].strip()
    target = Path(value)
    if not target.is_absolute() or ".." in target.parts:
        return None
    return _resolved_directory(target)


def skill_entry_installed(home: Path, name: str) -> bool:
    """Return whether a profile skill entry resolves to an approved skill directory."""
    entry = home / "skills" / name
    roots = _approved_roots(home)
    try:
        metadata = entry.lstat()
    except OSError:
        return False
    if stat.S_ISREG(metadata.st_mode):
        target = _pointer_target(entry)
    else:
        target = _resolved_directory(entry)
    return bool(
        target
        and target.name == name
        and _under_approved_root(target, roots)
        and (target / "SKILL.md").is_file()
    )
