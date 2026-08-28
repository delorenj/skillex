"""Default path helpers for skillex."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

REGISTRY_ROOT_ENV = "PJ_SKILLS_REGISTRY_ROOT"
DEFAULT_REGISTRY_CHECKOUT = Path("~/code/skillex")

#: The one normalization that turns a registry URL into the registry-cache
#: directory name. This is a WIRE FORMAT, not an implementation detail: three
#: independent surfaces address the same directory on the same machine and must
#: compute byte-identical names, or a single manifest resolves to two different
#: checkouts (and one of them may be an unsealed stale clone that gets zero
#: integrity checking). The other two surfaces are:
#:
#:   * ``sync-skills.py`` -> ``registry_cache_dir()``
#:         ``re.sub(r"[^a-zA-Z0-9]", "_", registry_url)``
#:   * pjangler ``src/parity/index.ts`` -> ``registryCacheDirName()``
#:         ``registryUrl.replace(/[^a-zA-Z0-9]/g, "_")``
#:
#: ``sync-skills.py`` is the only surface allowed to CLONE, so it owns the name
#: on disk; everything else is a read-only consumer and follows it.
#: Do not "improve" this regex here alone.
REGISTRY_CACHE_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9]")


def default_config_path() -> Path:
    """~/.config/skillex/skillex.toml"""
    return Path.home() / ".config" / "skillex" / "skillex.toml"


def sanitize_registry_url(url: str) -> str:
    """Collapse a registry URL into one safe path component for the cache dir name.

    Every non-alphanumeric byte becomes ``_``, so the result can never contain a
    path separator, ``.``, ``..`` or a leading ``-`` - it is always exactly one
    safe path component (or empty, for empty input; callers must not build a
    path from an empty registry URL - see :func:`registry_root_candidates`).

    Must stay byte-identical to ``sync-skills.py`` and pjangler; see
    :data:`REGISTRY_CACHE_UNSAFE_RE`.
    """
    return REGISTRY_CACHE_UNSAFE_RE.sub("_", url)


def registry_root_candidates(registry_url: str | None = None) -> list[Path]:
    """Registry checkout roots in contract order (section 2 step 3).

    ``PJ_SKILLS_REGISTRY_ROOT`` | ``~/.agents/.cache/registries/<sanitized-url>``
    | ``~/code/skillex``. Existence is NOT checked here and nothing is ever
    cloned or fetched - resolution is read-only by construction.

    ``<sanitized-url>`` is :func:`sanitize_registry_url`, which must agree
    byte-for-byte with ``sync-skills.py`` and pjangler - they address the same
    directory.
    """
    candidates: list[Path] = []
    env = os.environ.get(REGISTRY_ROOT_ENV)
    if env:
        # EXCLUSIVE, not merely first. Pinning this variable is a deliberate act -
        # regression suites point it at a fixture, and an operator points it at a
        # vetted checkout. If the ladder could fall through it, a pack missing from
        # the pinned root would be served silently from the developer's real
        # ~/code/skillex instead, which is neither hermetic nor what was asked for.
        # pjangler's `packRegistryRoots` does the same; the two must not diverge.
        return [Path(env).expanduser()]
    if registry_url:
        cache_name = sanitize_registry_url(registry_url)
        # Empty would collapse the candidate to the registries/ dir itself and
        # hand back a "checkout" that is really the cache parent.
        if not cache_name:
            raise ValueError(f"registry URL has no usable cache directory name: {registry_url!r}")
        candidates.append(Path.home() / ".agents" / ".cache" / "registries" / cache_name)
    candidates.append(DEFAULT_REGISTRY_CHECKOUT.expanduser())
    return candidates


def resolve_registry_root(registry_url: str | None = None) -> Path | None:
    """First existing candidate from :func:`registry_root_candidates`, else None.

    .. warning::

       This returns the first root that merely EXISTS, which is not the same as
       the first root that carries what you asked for. On a machine with a stale
       registry cache it confidently returns the stale clone: verified live,
       ``~/.agents/.cache/registries/https___github_com_delorenj_skillex_git``
       exists, still has the retired ``skill-sets/``, and has no ``sets/`` at all,
       so every set lookup through this function resolves against a checkout that
       cannot contain any set.

       **Do not use this for resolution.** Use :func:`find_in_roots`, which walks
       the whole ladder and stops at the first rung that actually carries the
       requested path -- the same rule ``sync-skills.py`` already follows.
    """
    for candidate in registry_root_candidates(registry_url):
        if candidate.is_dir():
            return candidate
    return None


def registry_roots(registry_url: str | None = None) -> list[Path]:
    """Every EXISTING rung of the contract ladder, in order.

    ``PJ_SKILLS_REGISTRY_ROOT`` stays exclusive: when it is set,
    :func:`registry_root_candidates` yields exactly one candidate and this
    function can therefore return at most that one, existing or not.
    """
    return [c for c in registry_root_candidates(registry_url) if c.is_dir()]


@dataclass(frozen=True)
class RegistryHit:
    """Where a registry-relative path was found, and what was passed over first."""

    root: Path
    path: Path
    #: Rungs that EXIST but do not carry the requested path, in ladder order.
    #:
    #: Never empty by accident: a non-empty list means resolution silently walked
    #: past a checkout the operator may believe is authoritative. On this machine
    #: that is the norm -- ``~/.agents/.cache/registries/<sanitized-url>`` exists,
    #: still carries the retired ``skill-sets/``, and has no ``sets/`` at all, so
    #: every set resolves one rung further down than a reader would guess.
    skipped: tuple[Path, ...] = ()

    def __iter__(self) -> Iterator[Path]:
        """Unpack as ``(root, path)`` so existing call sites keep working."""
        yield self.root
        yield self.path

    def __getitem__(self, index: int) -> Path:
        return (self.root, self.path)[index]


def find_in_roots(roots: Sequence[Path], relpath: str) -> RegistryHit | None:
    """First root that actually CARRIES ``relpath``.

    Existence is tested LEXICALLY (``is_symlink() or exists()``) so a dangling
    symlink still counts as "this rung has it" -- the caller reports the dangle
    with a useful message instead of silently falling through to another rung and
    resolving to a different skill entirely.

    Returns ``None`` when no rung carries it; the caller raises with the full
    tried-list, because "not found" is only actionable if you can see where it
    looked.
    """
    skipped: list[Path] = []
    for root in roots:
        candidate = root / relpath
        if candidate.is_symlink() or candidate.exists():
            return RegistryHit(root=root, path=candidate, skipped=tuple(skipped))
        skipped.append(root)
    return None


def find_manifest_root(start: Path, marker: Path = Path(".agents/skills.json")) -> Path | None:
    """Nearest ancestor of ``start`` (inclusive) containing ``marker``, else None.

    Unlike :func:`find_project_root` this does NOT treat a bare ``.git`` as a hit:
    a git repository that does not use skillex is not a skillex project, and
    creating a ``.agents/`` inside one would be an unrequested side effect.
    """
    current = start.resolve()
    while True:
        if (current / marker).is_file():
            return current
        if current.parent == current:
            return None
        current = current.parent


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
