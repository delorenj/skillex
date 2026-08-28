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

import fcntl
import os
from pathlib import Path
from types import TracebackType


class LockBusyError(RuntimeError):
    """Raised when the lock is held by a live process."""


class FileLock:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._fd: int | None = None

    def __enter__(self) -> FileLock:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # flock FIRST, then the PID check. The PID file alone has a TOCTOU window
        # wide enough for two concurrent syncs to both read "no live holder" and
        # both proceed; an advisory flock closes it. The PID check stays because it
        # is what reclaims a lock whose holder died without unlinking, which flock
        # cannot express (the kernel drops a dead process's flock, so a stale file
        # with a live-looking PID would otherwise be invisible).
        fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            os.close(fd)
            raise LockBusyError(
                f"lock held by another skillex process at {self._path}; wait for it to finish"
            ) from e
        self._fd = fd
        if self._path.exists():
            existing = self._read_pid()
            if existing is not None and _pid_alive(existing):
                self._release_fd()
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
        self._release_fd()

    def _release_fd(self) -> None:
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

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
