"""Pack payload enumeration and SHA256SUMS primitives.

Implements exactly the payload/checksum semantics of PACKS-CONTRACT.md section 4:

    payload = pack.toml + every file recursively under each DECLARED skill
              directory (the full declared inventory, pre include/exclude)

Everything here is pure and read-only. It NEVER follows a symlink and it raises
:class:`PayloadError` the moment it meets one, which is what gives callers the
"one unsafe symlink produces zero mutation" property: enumerate first, mutate
after.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from skillex.core.models import is_safe_component, is_safe_relpath

MANIFEST_FILENAME = "pack.toml"
SUMS_FILENAME = "SHA256SUMS"
SKILL_FILENAME = "SKILL.md"

EXCLUDED_PREFIXES = (".", "_")
"""Directories whose name starts with these are never skills and never payload."""

_SUMS_LINE = re.compile(r"^(?P<digest>[0-9a-f]{64})  (?P<path>.+)$")

_CHUNK = 1 << 20


class PayloadError(Exception):
    """Raised when a pack payload or SHA256SUMS file violates the contract."""


def assert_real_dir(path: Path, what: str = "path") -> None:
    """Raise unless `path` is a real directory that is not itself a symlink.

    `Path.is_dir()` follows symlinks, so it is checked against `lstat` explicitly.
    """
    try:
        mode = path.lstat().st_mode
    except OSError as e:
        raise PayloadError(f"{what} is not accessible: {path} ({e})") from e
    if stat.S_ISLNK(mode):
        raise PayloadError(f"{what} must not be a symlink: {path}")
    if not stat.S_ISDIR(mode):
        raise PayloadError(f"{what} must be a directory: {path}")


def is_regular_file(path: Path) -> bool:
    """True when `path` is a regular file and not a symlink. Never follows links.

    `Path.is_file()` follows symlinks, so a link pointing at a real file would
    pass it; every contract check that says "regular file" means this instead.
    """
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def discover_skill_dirs(root: Path) -> list[str]:
    """Inventory for a pack with no pack.toml (contract section 3).

    Child directories that (a) do not start with ``.`` or ``_`` and (b) contain a
    regular ``SKILL.md``. Symlinked children are skipped, never followed.
    """
    assert_real_dir(root, "pack root")
    names: list[str] = []
    with os.scandir(root) as entries:
        for entry in sorted(entries, key=lambda e: e.name):
            if not entry.is_dir(follow_symlinks=False):
                continue
            if entry.name.startswith(EXCLUDED_PREFIXES):
                continue
            if not is_safe_component(entry.name):
                continue
            skill_md = Path(entry.path) / SKILL_FILENAME
            try:
                if stat.S_ISREG(skill_md.lstat().st_mode):
                    names.append(entry.name)
            except OSError:
                continue
    return names


def symlinked_skill_candidates(root: Path) -> list[str]:
    """Child entries that LOOK like skills but are symlinks, so are never inventory.

    Purely diagnostic. `packs/Kurzgesagt` is built entirely out of symlinks into
    `all-skills/`, which the contract excludes from both the globbed inventory and
    the payload. Reporting them keeps that from looking like an empty pack.
    """
    names: list[str] = []
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return names
    for entry in entries:
        if entry.name.startswith(EXCLUDED_PREFIXES):
            continue
        if not entry.is_symlink():
            continue
        try:
            # Follows the link on purpose: this is a read-only diagnostic probe.
            if (Path(entry.path) / SKILL_FILENAME).is_file():
                names.append(entry.name)
        except OSError:
            continue
    return names


def has_regular_skill_md(root: Path, skill: str) -> bool:
    """True when `root/skill` is a real dir holding a regular (non-symlink) SKILL.md."""
    if not is_safe_component(skill):
        return False
    skill_dir = root / skill
    try:
        if not stat.S_ISDIR(skill_dir.lstat().st_mode):
            return False
    except OSError:
        return False
    return is_regular_file(skill_dir / SKILL_FILENAME)


@dataclass(frozen=True)
class PackPayload:
    """The enumerated payload of a pack: its files AND the directories holding them.

    Directories matter because a checksum can only ever authenticate a *file*. A
    directory that contains no payload file is covered by no line of
    ``SHA256SUMS``, so it could be planted in a sealed pack without changing a
    single digest. Recording the walked directories is what lets the seal check
    reject that (contract section 4 rules 2 and 4).
    """

    files: tuple[str, ...]
    """Relative POSIX paths of every payload file, sorted. Includes ``pack.toml``."""

    directories: tuple[str, ...]
    """Relative POSIX paths of every declared skill dir and its descendants, sorted."""


def payload_entries(root: Path, skills: Sequence[str]) -> PackPayload:
    """Enumerate the payload of `root`: files plus the directories walked.

    Includes ``pack.toml`` when present. Raises :class:`PayloadError` on a missing
    skill directory, an unsafe skill name, or any symlink / non-regular file
    anywhere in the payload.
    """
    assert_real_dir(root, "pack root")

    paths: list[str] = []
    directories: set[str] = set()
    manifest = root / MANIFEST_FILENAME
    try:
        manifest_mode: int | None = manifest.lstat().st_mode
    except FileNotFoundError:
        manifest_mode = None
    except OSError as e:
        raise PayloadError(f"cannot stat {manifest}: {e}") from e
    if manifest_mode is not None:
        if stat.S_ISLNK(manifest_mode):
            raise PayloadError(f"pack payload may not contain symlinks: {manifest}")
        if not stat.S_ISREG(manifest_mode):
            raise PayloadError(f"{MANIFEST_FILENAME} must be a regular file: {manifest}")
        paths.append(MANIFEST_FILENAME)

    for skill in skills:
        if not is_safe_component(skill):
            raise PayloadError(f"invalid skill name {skill!r}; must be one safe path component")
        base = root / skill
        assert_real_dir(base, f"skill directory {skill!r}")
        for dirpath, dirnames, filenames in os.walk(base):  # os.walk never follows links
            dirnames.sort()
            # `base` itself is the first dirpath, so the skill dir is recorded too.
            directories.add(Path(dirpath).relative_to(root).as_posix())
            for name in sorted(filenames):
                full = Path(dirpath) / name
                mode = full.lstat().st_mode
                if stat.S_ISLNK(mode):
                    raise PayloadError(f"pack payload may not contain symlinks: {full}")
                if not stat.S_ISREG(mode):
                    raise PayloadError(f"pack payload may contain only regular files: {full}")
                paths.append(full.relative_to(root).as_posix())
            for name in dirnames:
                child = Path(dirpath) / name
                if stat.S_ISLNK(child.lstat().st_mode):
                    raise PayloadError(f"pack payload may not contain symlinks: {child}")

    return PackPayload(files=tuple(sorted(paths)), directories=tuple(sorted(directories)))


def payload_paths(root: Path, skills: Sequence[str]) -> list[str]:
    """Relative POSIX paths of every payload file under `root`, sorted.

    Thin wrapper over :func:`payload_entries` for callers that only need files.
    """
    return list(payload_entries(root, skills).files)


def unauthenticated_directories(files: Iterable[str], directories: Iterable[str]) -> list[str]:
    """Payload directories that no payload file lives under, sorted.

    A directory is *authenticated* only transitively, by containing (at any depth)
    a file whose digest is recorded. One holding no payload file at all is covered
    by no checksum and could therefore be planted undetected, so a sealed pack may
    not contain one.
    """
    covered: set[str] = set()
    for rel in files:
        parts = rel.split("/")
        for index in range(1, len(parts)):
            covered.add("/".join(parts[:index]))
    return sorted(d for d in directories if d not in covered)


def sha256_file(path: Path) -> str:
    """Stream a regular file into sha256. Refuses to read through a symlink."""
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        raise PayloadError(f"refusing to hash a symlink: {path}")
    if not stat.S_ISREG(mode):
        raise PayloadError(f"refusing to hash a non-regular file: {path}")
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def render_sha256sums(root: Path, paths: Sequence[str]) -> str:
    """Render the `<64-hex>  <relative/path>` body, sorted by path, trailing newline."""
    lines = [f"{sha256_file(root / rel)}  {rel}" for rel in sorted(paths)]
    return "\n".join(lines) + "\n" if lines else ""


def parse_sha256sums(text: str, *, origin: str = SUMS_FILENAME) -> dict[str, str]:
    """Parse a SHA256SUMS body into `{relative_path: digest}`.

    Enforces contract section 4 rule 5: relative, `/`-separated, no `.`/`..`/empty
    segments, no backslashes, not absolute; duplicates are an error.
    """
    result: dict[str, str] = {}
    for lineno, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        match = _SUMS_LINE.match(raw)
        if match is None:
            raise PayloadError(
                f"{origin}:{lineno}: malformed line; expected '<64-hex>  <relative/path>'"
            )
        rel = match.group("path")
        if not is_safe_relpath(rel):
            raise PayloadError(f"{origin}:{lineno}: unsafe path {rel!r}")
        if rel in result:
            raise PayloadError(f"{origin}:{lineno}: duplicate entry for {rel!r}")
        result[rel] = match.group("digest")
    return result


def load_sha256sums(root: Path) -> dict[str, str]:
    """Read and parse `root/SHA256SUMS`. Raises if it is absent or not a regular file."""
    sums = root / SUMS_FILENAME
    try:
        mode = sums.lstat().st_mode
    except OSError as e:
        raise PayloadError(f"{SUMS_FILENAME} not found at pack root: {sums}") from e
    if not stat.S_ISREG(mode):
        raise PayloadError(f"{SUMS_FILENAME} must be a regular file: {sums}")
    return parse_sha256sums(sums.read_text(encoding="utf-8"), origin=str(sums))


__all__ = [
    "EXCLUDED_PREFIXES",
    "MANIFEST_FILENAME",
    "SKILL_FILENAME",
    "SUMS_FILENAME",
    "PackPayload",
    "PayloadError",
    "assert_real_dir",
    "discover_skill_dirs",
    "has_regular_skill_md",
    "load_sha256sums",
    "parse_sha256sums",
    "payload_entries",
    "payload_paths",
    "render_sha256sums",
    "sha256_file",
    "symlinked_skill_candidates",
    "unauthenticated_directories",
]
