"""The ownership receipt: what sync wrote into a root, so it may later remove it.

**Why a receipt at all.** Containment cannot answer "did I write this link?".
Verified on this machine, 10 of ``min-global``'s 36 targets resolve into
``~/code/33GOD/*`` -- outside every registry root and every managed root. Under a
containment-only rule those links are indistinguishable from something a human
made, so the moment ``momo`` or ``pjangler`` leaves the set its link **leaks
forever**. That is precisely the monotonic growth the incumbent engine's own
docstring records: *81 of pjangler's 132 ``.claude/skills`` links pointed at BMAD
pack versions that no longer exist.*

**Why it lives in XDG state and not beside the root.** ``~/.agents`` is a git
repository the user manages, and roughly 44 project activation roots exist on this
machine. A per-run JSON receipt inside each of them is exactly the class of file
the user's own guidance forbids -- runtime state that a process rewrites and that
can therefore never be committed clean. One directory also gives a single place to
audit every projection on the machine, and a fresh clone correctly has no receipt
and therefore removes nothing.

**Write-ahead.** ``<hash>.pending.json`` is written with ``desired`` UNION ``prior``
*before* the first mutation; the committed file replaces it after. A crash leaves
the pending file, and the next run reads ``pending`` UNION ``committed`` -- deliberately a
superset. The asymmetry justifies it: pruning a name that no longer exists is a
no-op, while failing to recognize a link we created is a permanent leak.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from skillex import __version__

STATE_VERSION = 1


def state_dir() -> Path:
    """``$XDG_STATE_HOME/skillex/projections``, defaulting to ``~/.local/state``."""
    base = os.environ.get("XDG_STATE_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".local" / "state"
    return root / "skillex" / "projections"


def _key_for(root: Path) -> str:
    """Stable filename for a root.

    Hashed rather than path-mangled so the name is a fixed length and cannot itself
    contain a separator. ``os.path.realpath`` (not ``Path.resolve``) so a root that
    does not exist yet still hashes deterministically.
    """
    return hashlib.sha256(os.path.realpath(root).encode("utf-8")).hexdigest()[:16]


def state_path_for(root: Path) -> Path:
    return state_dir() / f"{_key_for(root)}.json"


def pending_path_for(root: Path) -> Path:
    return state_dir() / f"{_key_for(root)}.pending.json"


@dataclass(frozen=True)
class StateEntry:
    target: str
    origin: str = ""
    stage: str = ""


@dataclass
class ProjectionState:
    """What a previous run recorded about one activation root."""

    root: Path
    scope: str = ""
    mode: str = "composed"
    alias_target: str | None = None
    entries: dict[str, StateEntry] = field(default_factory=dict)
    manifests: list[dict[str, str]] = field(default_factory=list)
    registry_roots: list[str] = field(default_factory=list)
    written_at: str | None = None
    generator: str | None = None
    #: True when nothing has ever been recorded for this root.
    absent: bool = False

    def owns(self, name: str) -> bool:
        return name in self.entries

    def to_json(self) -> dict[str, object]:
        return {
            "version": STATE_VERSION,
            "root": str(self.root),
            "scope": self.scope,
            "mode": self.mode,
            "alias_target": self.alias_target,
            "manifests": self.manifests,
            "registry_roots": self.registry_roots,
            "written_at": self.written_at,
            "generator": self.generator,
            "entries": {
                name: {"target": e.target, "origin": e.origin, "stage": e.stage}
                for name, e in sorted(self.entries.items())
            },
        }


def _read(path: Path) -> dict[str, object] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # A corrupt receipt must never be fatal, and must never be read as "I own
        # nothing" either -- that would make the next run prune links it wrote. The
        # caller falls back to containment, which is conservative in the safe
        # direction (it refuses to remove rather than removing wrongly).
        #
        # ``ValueError`` and not ``json.JSONDecodeError``: a receipt truncated or
        # zeroed by a crash is exactly the case this exists for, and half of those
        # are not valid UTF-8. ``UnicodeDecodeError`` and ``JSONDecodeError`` are
        # both ``ValueError``, so one clause cannot miss the sibling.
        return None
    return raw if isinstance(raw, dict) else None


def _entries_from(raw: dict[str, object]) -> dict[str, StateEntry]:
    entries = raw.get("entries")
    if not isinstance(entries, dict):
        return {}
    out: dict[str, StateEntry] = {}
    for name, value in entries.items():
        if isinstance(value, dict):
            out[str(name)] = StateEntry(
                target=str(value.get("target", "")),
                origin=str(value.get("origin", "")),
                stage=str(value.get("stage", "")),
            )
        elif isinstance(value, str):
            out[str(name)] = StateEntry(target=value)
    return out


def load_state(root: Path) -> ProjectionState:
    """Committed receipt UNIONED with any pending one. Never raises."""
    committed = _read(state_path_for(root))
    pending = _read(pending_path_for(root))
    if committed is None and pending is None:
        return ProjectionState(root=root, absent=True)

    base = committed or {}
    state = ProjectionState(
        root=root,
        scope=str(base.get("scope", "")),
        mode=str(base.get("mode", "composed")),
        alias_target=base.get("alias_target")
        if isinstance(base.get("alias_target"), str)
        else None,
        entries=_entries_from(base),
        manifests=list(base.get("manifests", []))
        if isinstance(base.get("manifests"), list)
        else [],
        registry_roots=list(base.get("registry_roots", []))
        if isinstance(base.get("registry_roots"), list)
        else [],
        written_at=base.get("written_at") if isinstance(base.get("written_at"), str) else None,
        generator=base.get("generator") if isinstance(base.get("generator"), str) else None,
    )
    if pending is not None:
        # Union, not replace: an interrupted run's pending set is a superset of what
        # it managed to write, and both halves are ours.
        state.entries.update(_entries_from(pending))
    return state


def _atomic_write(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_pending(state: ProjectionState, names: set[str]) -> None:
    """Record ``names`` as ours BEFORE the first mutation."""
    payload = state.to_json()
    payload["entries"] = {
        name: {
            "target": state.entries[name].target if name in state.entries else "",
            "origin": state.entries[name].origin if name in state.entries else "",
            "stage": state.entries[name].stage if name in state.entries else "",
        }
        for name in sorted(names)
    }
    payload["written_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    _atomic_write(pending_path_for(state.root), payload)


def commit_state(state: ProjectionState) -> None:
    """Publish the receipt and drop the pending file."""
    state.written_at = datetime.now(UTC).isoformat(timespec="seconds")
    state.generator = f"skillex {__version__}"
    _atomic_write(state_path_for(state.root), state.to_json())
    pending_path_for(state.root).unlink(missing_ok=True)


def forget(root: Path) -> bool:
    """Delete both receipts for ``root``. Returns True if anything was removed."""
    removed = False
    for path in (state_path_for(root), pending_path_for(root)):
        if path.exists():
            path.unlink()
            removed = True
    return removed


__all__ = [
    "STATE_VERSION",
    "ProjectionState",
    "StateEntry",
    "commit_state",
    "forget",
    "load_state",
    "pending_path_for",
    "state_dir",
    "state_path_for",
    "write_pending",
]
