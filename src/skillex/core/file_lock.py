"""PID-aware file lock for serializing activation commands.

Usage:

    with FileLock(Path("~/.config/skillex/.lock").expanduser()):
        ...activation work...

If the lock file exists and names a live PID, raises LockBusyError. If it
names a dead PID (process no longer exists), the lock is considered stale
and taken over. The lock is removed on normal exit and remains on crash;
next invocation will pick it up or reclaim.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import TracebackType


class LockBusyError(RuntimeError):
    """Raised when the lock is held by a live process."""


class FileLock:
    def __init__(self, path: Path) -> None:
        self._path = path

    def __enter__(self) -> FileLock:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._path.exists():
            existing = self._read_pid()
            if existing is not None and _pid_alive(existing):
                raise LockBusyError(
                    f"lock held by pid {existing} at {self._path}; "
                    f"wait for it to finish or remove the lock file manually"
                )
            # Stale lock; reclaim.
        self._path.write_text(str(os.getpid()), encoding="utf-8")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            pass

    def _read_pid(self) -> int | None:
        try:
            raw = self._path.read_text(encoding="utf-8").strip()
            return int(raw) if raw else None
        except (OSError, ValueError):
            return None


def _pid_alive(pid: int) -> bool:
    """Return True if pid is a running process on this machine."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we lack permission; treat as alive.
        return True
    return True
