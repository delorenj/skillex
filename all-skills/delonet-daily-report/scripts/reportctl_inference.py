"""Hermes inference snapshot drift and safe cron creation helpers."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from reportctl_contracts import ConfigError
from reportctl_runtime import run_command

SNAPSHOT_FIELDS = ("provider_snapshot", "model_snapshot")


def snapshot_mismatch(wanted: dict[str, Any], current: dict[str, Any]) -> bool:
    return any(current.get(field) != wanted[field] for field in SNAPSHOT_FIELDS)


def inference_issues(
    config: dict[str, Any], jobs: list[dict[str, Any]], managed: Callable[[str], bool]
) -> list[dict[str, str]]:
    expected = config["inference"]
    issues = []
    for job in jobs:
        if not managed(job["name"]):
            continue
        reasons = []
        for field, key in (("provider_snapshot", "provider"), ("model_snapshot", "model")):
            actual = job.get(field)
            if actual is None:
                reasons.append(f"{field}=null")
            elif actual != expected[key]:
                reasons.append(f"{field}={actual}")
        if reasons:
            issues.append({"id": job["id"], "name": job["name"], "reason": ", ".join(reasons)})
    return issues


def _stable_core(jobs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        job["id"]: {key: value for key, value in job.items() if key != "next_run_at"}
        for job in jobs
    }


def _created_id(stdout: str, name: str) -> str:
    match = re.search(r"Created job:\s*(\S+)", stdout)
    if not match:
        raise ConfigError(f"created job {name} but could not read its Hermes job ID")
    return match.group(1)


def _verify_created(action: dict[str, Any], created_id: str, jobs: list[dict[str, Any]]) -> None:
    current = next((job for job in jobs if job["id"] == created_id), None)
    if current is None or current["name"] != action["name"]:
        raise ConfigError(f"created job {action['name']} missing from canonical Hermes state")
    if snapshot_mismatch(action, current):
        raise ConfigError(f"created job {action['name']} has unexpected inference snapshots")
    if current["enabled"] != action["enabled"]:
        raise ConfigError(f"created job {action['name']} did not preserve enabled state")


def apply_create(
    action: dict[str, Any],
    environment: dict[str, str],
    action_command: Callable[[dict[str, Any]], list[str]],
    stable_read: Callable[[], list[dict[str, Any]]],
) -> None:
    before = stable_read()
    if any(job["name"] == action["name"] for job in before):
        raise ConfigError(f"job {action['name']} appeared before create; abort and replan")
    result = run_command(action_command({**action, "action": "create"}), env=environment)
    created_id = _created_id(result.stdout, action["name"])
    if not action["enabled"]:
        run_command(["hermes", "cron", "pause", created_id], env=environment)
    after = stable_read()
    after_core = _stable_core(after)
    created_core = after_core.pop(created_id, None)
    if created_core is None or after_core != _stable_core(before):
        raise ConfigError("canonical Hermes jobs changed unexpectedly during create")
    _verify_created(action, created_id, after)


def apply_recreate(
    action: dict[str, Any],
    environment: dict[str, str],
    action_command: Callable[[dict[str, Any]], list[str]],
    stable_read: Callable[[], list[dict[str, Any]]],
) -> None:
    before = stable_read()
    current = next((job for job in before if job["id"] == action["id"]), None)
    if current is None or current["name"] != action["name"]:
        raise ConfigError("recreate target changed; abort and replan")
    run_command(["hermes", "cron", "remove", action["id"]], env=environment)
    after_remove = stable_read()
    expected = _stable_core(before)
    expected.pop(action["id"])
    if _stable_core(after_remove) != expected:
        raise ConfigError("canonical Hermes jobs changed unexpectedly after recreate removal")
    if any(job["name"] == action["name"] for job in after_remove):
        raise ConfigError("recreate name reappeared after removal; abort before create")
    apply_create(action, environment, action_command, stable_read)
