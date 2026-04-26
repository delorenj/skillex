"""Tests for skillex.core.file_lock."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from skillex.core.file_lock import FileLock, LockBusyError


class TestFileLock:
    def test_acquires_and_releases(self, tmp_path: Path) -> None:
        lock_path = tmp_path / ".lock"
        with FileLock(lock_path):
            assert lock_path.exists()
            assert lock_path.read_text().strip() == str(os.getpid())
        assert not lock_path.exists()

    def test_raises_when_held_by_live_pid(self, tmp_path: Path) -> None:
        lock_path = tmp_path / ".lock"
        lock_path.write_text(str(os.getpid()), encoding="utf-8")
        with pytest.raises(LockBusyError, match=f"pid {os.getpid()}"):
            with FileLock(lock_path):
                pass

    def test_reclaims_stale_lock(self, tmp_path: Path) -> None:
        lock_path = tmp_path / ".lock"
        # Use a PID that's extremely unlikely to be alive.
        lock_path.write_text("9999999", encoding="utf-8")
        with FileLock(lock_path):
            assert lock_path.read_text().strip() == str(os.getpid())

    def test_creates_parent_dir(self, tmp_path: Path) -> None:
        lock_path = tmp_path / "nested" / "dir" / ".lock"
        with FileLock(lock_path):
            assert lock_path.exists()

    def test_handles_garbage_in_lock_file(self, tmp_path: Path) -> None:
        lock_path = tmp_path / ".lock"
        lock_path.write_text("not-a-pid", encoding="utf-8")
        with FileLock(lock_path):
            assert lock_path.read_text().strip() == str(os.getpid())
