"""Locked process and atomic filesystem primitives for reportctl."""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import tempfile
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from reportctl_contracts import ConfigError, parse_iso
from reportctl_security import contains_secret, redact_text


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser().resolve()


def profile_setting(name: str) -> str:
    path = hermes_home() / "config.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise ConfigError(f"cannot inspect Hermes timezone config: {exc}") from exc
    match = re.search(rf"(?m)^{re.escape(name)}:\s*['\"]?([^'\"#\s]+)", text)
    return match.group(1) if match else ""


def timezone_state(config: dict[str, Any]) -> dict[str, Any]:
    profile = profile_setting("timezone")
    environment = os.environ.get("HERMES_TIMEZONE", "").strip()
    conflict = bool(environment and environment != profile)
    return {
        "profile": profile or "unset",
        "environment": environment or "unset",
        "conflict": conflict,
        "valid": profile == config["timezone"] and not conflict,
    }


def inference_state(config: dict[str, Any]) -> dict[str, Any]:
    provider = profile_setting("provider")
    model = profile_setting("model")
    expected = config["inference"]
    return {
        "profile_provider": provider or "unset",
        "profile_model": model or "unset",
        "expected_provider": expected["provider"],
        "expected_model": expected["model"],
        "valid": provider == expected["provider"] and model == expected["model"],
    }


def timezone_preflight(config: dict[str, Any]) -> None:
    state = timezone_state(config)
    if not state["valid"]:
        raise ConfigError(
            f"Hermes profile timezone must be {config['timezone']} with no conflicting HERMES_TIMEZONE; profile={state['profile']} environment={state['environment']}"
        )
    inference = inference_state(config)
    if not inference["valid"]:
        raise ConfigError(
            "Hermes profile inference must match configured provider/model; "
            f"profile={inference['profile_provider']}/{inference['profile_model']} "
            f"configured={inference['expected_provider']}/{inference['expected_model']}"
        )
    if not (hermes_home() / "skills" / "delonet-daily-report" / "SKILL.md").is_file():
        raise ConfigError(
            "delonet-daily-report must be installed in the active HERMES_HOME skills directory"
        )


def daily_next_run_valid(
    value: Any, config: dict[str, Any], now: dt.datetime | None = None
) -> bool:
    try:
        parsed = parse_iso(value, "daily_next_run_at")
        current = now or dt.datetime.now(dt.UTC)
        if current.tzinfo is None:
            return False
        zone = ZoneInfo(config["timezone"])
        local_now = current.astimezone(zone)
        expected = local_now.replace(hour=7, minute=0, second=0, microsecond=0)
        if expected <= local_now:
            expected = (local_now + dt.timedelta(days=1)).replace(
                hour=7, minute=0, second=0, microsecond=0
            )
        return parsed.astimezone(dt.UTC) == expected.astimezone(dt.UTC)
    except (ConfigError, AttributeError, TypeError, ValueError):
        return False


def archive_paths(config: dict[str, Any], date: str) -> dict[str, Any]:
    try:
        parsed = dt.date.fromisoformat(date)
    except ValueError as exc:
        raise ConfigError("date must use YYYY-MM-DD") from exc
    base = Path(config["artifact_dir"]) / date
    archive = Path(config["archive_dir"]) / f"{parsed.year:04d}" / f"{parsed.month:02d}" / date
    return {
        "sections_dir": str(base / "sections"),
        "manifest": str(base / "run-manifest.json"),
        "archive_root": str(archive),
        "commit_marker": str(archive / "current.json"),
    }


def fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(
    path: Path, value: Any, *, after_replace: Callable[[], None] | None = None
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if after_replace:
            after_replace()
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
        message = redact_text(exc.stderr or exc.stdout or str(exc))
        raise ConfigError(f"command failed: {message}") from exc


def publish_archive_pair(
    archive_root: Path,
    markdown: str,
    report: dict[str, Any],
    manifest: dict[str, Any],
    report_date: str,
) -> dict[str, Any]:
    if contains_secret(markdown) or contains_secret(report) or contains_secret(manifest):
        raise ConfigError("archive generation contains secret-like material")
    marker_path = archive_root / "current.json"
    with file_lock(marker_path.with_suffix(".lock")):
        generations = archive_root / "generations"
        generations.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        staged = generations / f".stage-{token}"
        generation = generations / token
        pointer_replaced = False

        def record_pointer_replace() -> None:
            nonlocal pointer_replaced
            pointer_replaced = True

        staged.mkdir()
        try:
            atomic_write_text(staged / "report.md", markdown)
            atomic_write(staged / "report.json", report)
            atomic_write(staged / "run-manifest.json", manifest)
            fsync_dir(staged)
            os.replace(staged, generation)
            fsync_dir(generations)
            atomic_write(
                marker_path,
                {
                    "schema_version": 1,
                    "report_date": report_date,
                    "generation": token,
                },
                after_replace=record_pointer_replace,
            )
        except BaseException:
            if staged.exists():
                for path in staged.iterdir():
                    path.unlink(missing_ok=True)
                staged.rmdir()
            pointer_target = None
            try:
                pointer = json.loads(marker_path.read_text(encoding="utf-8"))
                pointer_target = pointer.get("generation") if isinstance(pointer, dict) else None
            except (OSError, json.JSONDecodeError):
                pass
            if generation.exists() and not (pointer_replaced or pointer_target == token):
                for path in generation.iterdir():
                    path.unlink(missing_ok=True)
                generation.rmdir()
            fsync_dir(generations)
            raise
    markdown_path, report_path, manifest_path = (
        generation / "report.md",
        generation / "report.json",
        generation / "run-manifest.json",
    )
    return {
        "archived": True,
        "markdown": str(markdown_path),
        "report_json": str(report_path),
        "manifest": str(manifest_path),
        "commit_marker": str(marker_path),
    }
