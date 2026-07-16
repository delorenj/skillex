"""Locked process and atomic filesystem primitives for reportctl."""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from reportctl_contracts import ConfigError


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser().resolve()


def archive_paths(config: dict[str, Any], date: str) -> dict[str, Any]:
    try:
        parsed = dt.date.fromisoformat(date)
    except ValueError as exc:
        raise ConfigError("date must use YYYY-MM-DD") from exc
    base = Path(config["artifact_dir"]) / date
    archive = Path(config["archive_dir"]) / f"{parsed.year:04d}" / f"{parsed.month:02d}"
    return {
        "sections_dir": str(base / "sections"),
        "manifest": str(base / "run-manifest.json"),
        "markdown": str(archive / f"{date}.md"),
        "report_json": str(archive / f"{date}.report.json"),
        "commit_marker": str(archive / f"{date}.committed.json"),
    }


def fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_dir(path.parent)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_dir(path.parent)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


@contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = path.open("a+", encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"lock failure at {path}: {exc}") from exc
    with handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX)
        except OSError as exc:
            raise ConfigError(f"lock failure at {path}: {exc}") from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def run_command(
    command: list[str], *, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command, check=True, text=True, capture_output=True, env=env, timeout=30
        )
    except FileNotFoundError as exc:
        raise ConfigError(f"missing executable: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ConfigError(f"command timed out: {command[0]}") from exc
    except OSError as exc:
        raise ConfigError(f"command failed to start: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        message = re.sub(
            r"(?i)(bearer\s+)\S+", r"\1[REDACTED]", exc.stderr or exc.stdout or str(exc)
        )
        message = re.sub(
            r"(?i)((?:token|secret|password|api.?key)=)[^&\s]+", r"\1[REDACTED]", message
        )
        message = re.sub(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@", r"\1[REDACTED]@", message)
        raise ConfigError(f"command failed: {message}") from exc


def publish_archive_pair(
    markdown_path: Path,
    report_path: Path,
    marker_path: Path,
    markdown: str,
    report: dict[str, Any],
    report_date: str,
) -> dict[str, Any]:
    with file_lock(marker_path.with_suffix(".lock")):
        directory = markdown_path.parent
        directory.mkdir(parents=True, exist_ok=True)
        token = f"{os.getpid()}-{id(report)}"
        staged_markdown = directory / f".{markdown_path.name}.{token}"
        staged_report = directory / f".{report_path.name}.{token}"
        marker_path.unlink(missing_ok=True)
        try:
            atomic_write_text(staged_markdown, markdown)
            atomic_write(staged_report, report)
            os.replace(staged_markdown, markdown_path)
            os.replace(staged_report, report_path)
            fsync_dir(directory)
            atomic_write(
                marker_path,
                {
                    "schema_version": 1,
                    "report_date": report_date,
                    "markdown": markdown_path.name,
                    "report_json": report_path.name,
                },
            )
        except BaseException:
            for path in (staged_markdown, staged_report, markdown_path, report_path, marker_path):
                path.unlink(missing_ok=True)
            fsync_dir(directory)
            raise
    return {
        "archived": True,
        "markdown": str(markdown_path),
        "report_json": str(report_path),
        "commit_marker": str(marker_path),
    }
