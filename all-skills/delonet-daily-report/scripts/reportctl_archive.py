"""Artifact health, archive publication, and the published-report gate."""

from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path
from typing import Any

from reportctl_config import load_json
from reportctl_contracts import (
    ConfigError,
    active_section_ids,
    parse_iso,
    required_section_ids,
    validate_daily_report,
    validate_run_manifest,
    validate_section_artifact,
)
from reportctl_runtime import archive_paths, publish_archive_pair

GENERATION_FILES = ("report.md", "report.json", "run-manifest.json")

#: Section statuses that mean the collector RAN for this run and left an
#: artifact that can be trusted as far as it goes.
#:
#: ``partial`` belongs here on purpose: a collector reports ``partial`` when it
#: read some of its sources and said which one it could not read. That is a
#: degraded answer, not an absent one. Everything outside this set --
#: ``failed``, ``missing``, ``stale``, ``invalid``, or no entry at all -- means
#: this run holds no usable collection for that section.
#:
#: Note what is *not* here: any judgement about the news a collector found. A
#: section that read every source and reported six undelivered days is
#: ``complete``. See ``derive_status``.
SECTION_RAN = frozenset({"complete", "partial"})


def section_path(config: dict[str, Any], topic_id: str, date: str = "{date}") -> str:
    return str(Path(config["artifact_dir"]) / date / "sections" / f"{topic_id}.json")


def artifact_health(
    config: dict[str, Any], date: str, run_id: str | None = None
) -> list[dict[str, str]]:
    """Status of every enabled section for ``date``, enumerated from config.

    A section whose file is absent is reported ``missing``. It is never omitted:
    dropping it is exactly how a broken run comes to look complete.

    ``run_id`` couples the manifest to one run. When it is given, an artifact
    written by a *different* run is reported ``stale`` and says whose it is,
    instead of being adopted silently. Without that check a published generation
    is not a snapshot of one run at all: an interrupted run leaves section files
    on disk, and the next run -- or any ``--section`` retry -- stamps the
    survivors into a manifest bearing its own ``run_id``, so the published
    report attributes another run's collection to itself while still inside the
    24h freshness window. Callers that are only inspecting disk (``reportctl
    status``) pass nothing and get the old, run-agnostic view.
    """
    archive_paths(config, date)
    now = dt.datetime.now(dt.UTC)
    result = []
    for section in config["sections"]:
        if not section["enabled"]:
            continue
        path = Path(section_path(config, section["id"], date))
        status, reason = "missing", "file absent"
        if path.exists():
            try:
                artifact = validate_section_artifact(load_json(path), section["id"])
                fresh = parse_iso(artifact["fresh_until"], "fresh_until")
                if run_id is not None and artifact["run_id"] != run_id:
                    status = "stale"
                    reason = (
                        f"artifact was written by run {artifact['run_id']}, not by this "
                        f"run {run_id}; a published generation must be one run's work"
                    )
                elif fresh < now:
                    status, reason = "stale", "fresh_until elapsed"
                else:
                    status = artifact["status"]
                    reason = artifact.get("reason", "")
            except (ConfigError, ValueError, AttributeError) as exc:
                status, reason = "invalid", str(exc)
        result.append(
            {
                "id": section["id"],
                "required": section["required"],
                "status": status,
                "reason": reason,
                "path": str(path),
            }
        )
    return result


def manifest_health(config: dict[str, Any], date: str) -> dict[str, str]:
    path = Path(archive_paths(config, date)["manifest"])
    if not path.exists():
        return {"status": "missing", "path": str(path)}
    try:
        validate_run_manifest(load_json(path), config)
        return {"status": "valid", "path": str(path)}
    except ConfigError as exc:
        return {"status": "invalid", "reason": str(exc), "path": str(path)}


def required_gaps(config: dict[str, Any], section_statuses: dict[str, str]) -> list[str]:
    """Required sections that did not complete, in config order.

    The operator marked these sections as ones the report cannot be the report
    without. A gap here is not a degradation of the report; it is the absence of
    the report that was asked for.
    """
    return [
        sid
        for sid in required_section_ids(config)
        if section_statuses.get(sid) != "complete"
    ]


def required_failures(config: dict[str, Any], section_statuses: dict[str, str]) -> list[str]:
    """Required sections whose collector did not run for this run, in config order.

    The stricter half of ``required_gaps``. A section here produced nothing this
    run can stand behind: it failed outright, its file is absent or corrupt, or
    what is on disk belongs to another run. The report the operator asked for
    was not produced.

    ``required_gaps`` is the wider set -- it also holds required sections that
    ran and returned ``partial``. Those degrade the report; these fail it.
    """
    return [
        sid
        for sid in required_section_ids(config)
        if section_statuses.get(sid) not in SECTION_RAN
    ]


def derive_status(config: dict[str, Any], section_statuses: dict[str, str]) -> str:
    """The report's status, derived from the manifest and nothing else.

    ``complete``
        Every enabled section completed.
    ``failed``
        The run did not produce the report that was asked for: no enabled
        sections exist, or none of them completed, or a section the operator
        declared **required** did not run at all (``failed`` / ``missing`` /
        ``stale`` / ``invalid`` / absent).
    ``partial``
        Everything else. Something is degraded -- an optional section broke, or
        a required one ran and could only read part of its sources -- but the
        report exists and is trustworthy about what it says.

    The trigger for ``failed`` is *did not run*, not *is not complete*, and the
    difference is the whole point. A collector's status describes its
    **collection**, never the news it found: ``report-delivery`` that reads both
    of its sources cleanly and reports six undelivered days is ``complete``,
    because finding the problem is the job succeeding.

    Reading "not complete" as failure instead turned that into a latch. A
    required section carrying bad news failed the run; a failed run publishes a
    generation ``verify_published`` refuses; a refused generation is what
    ``report_delivery`` scans as ``invalid`` -- so the gap reappeared in
    tomorrow's window and failed tomorrow's run, with no path back to green. A
    report whose whole purpose is to say something is wrong cannot be suppressed
    as a failure for saying it.

    The teeth stay where they were. A required collector that could not read its
    sources still returns ``failed``, still fails the run, and still exits
    non-zero -- which is the case that started this package, a run that lost its
    primary data source and recorded success anyway.
    """
    required = required_section_ids(config)
    active = active_section_ids(config)
    if not active:
        return "failed"
    if not any(section_statuses.get(sid) == "complete" for sid in active):
        return "failed"
    if required_failures(config, section_statuses):
        return "failed"
    if not required:
        return "partial"
    if all(section_statuses.get(sid) == "complete" for sid in active):
        return "complete"
    return "partial"


def verify_published(
    config: dict[str, Any], date: str, expect_generation: str | None = None
) -> dict[str, Any]:
    """Prove a published report exists for ``date`` and is internally coherent.

    Returns ``ok: False`` with the concrete reasons when it does not. This is the
    check that would have caught the silent 2026-08-18 failure, where a cron job
    logged success over a command that never ran.

    ``expect_generation`` names the generation the caller believes it published.
    Without it this function resolves whatever ``current.json`` points at *now*,
    so a concurrent ``reportctl archive`` landing between publish and verify made
    a run report ``verified: true`` about a generation it had never written. With
    it, a pointer naming anything else is a problem, not a silent substitution.

    Two booleans, because they answer different questions:

    ``coherent``
        The generation named by ``current.json`` is the expected one, exists, is
        readable, and its three files agree with each other. This is a statement
        about the *artifact*.
    ``ok``
        ``coherent`` **and** the report it contains is not ``failed``. This is a
        statement about the *run*, and it is what the gate and the git mirror
        are allowed to act on.
    """
    paths = archive_paths(config, date)
    marker_path = Path(paths["commit_marker"])
    problems: list[str] = []
    outcome: dict[str, Any] = {
        "ok": False,
        "coherent": False,
        "date": date,
        "generation": None,
        "expected_generation": expect_generation,
        "status": None,
        "degraded": [],
        "required_gaps": [],
        "required_failures": [],
        "problems": problems,
        "commit_marker": str(marker_path),
    }
    if not marker_path.exists():
        problems.append(f"no published report for {date}: {marker_path} is absent")
        return outcome
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"current.json is unreadable: {exc}")
        return outcome
    if not isinstance(marker, dict) or not isinstance(marker.get("generation"), str):
        problems.append("current.json does not name a generation")
        return outcome
    if marker.get("report_date") != date:
        problems.append(
            f"current.json points at report_date {marker.get('report_date')!r}, expected {date!r}"
        )
    if expect_generation is not None and marker["generation"] != expect_generation:
        problems.append(
            f"current.json names generation {marker['generation']!r}, but this run published "
            f"{expect_generation!r}; the published generation was replaced under it"
        )
    generation = Path(paths["archive_root"]) / "generations" / marker["generation"]
    outcome["generation"] = str(generation)
    outcome["generation_id"] = marker["generation"]
    for name in GENERATION_FILES:
        if not (generation / name).is_file():
            problems.append(f"published generation is missing {name}")
    if problems:
        return outcome

    try:
        report = validate_daily_report(
            json.loads((generation / "report.json").read_text(encoding="utf-8")), config
        )
    except (ConfigError, OSError, json.JSONDecodeError) as exc:
        problems.append(f"report.json is invalid: {exc}")
        report = None
    try:
        manifest = validate_run_manifest(
            json.loads((generation / "run-manifest.json").read_text(encoding="utf-8")), config
        )
    except (ConfigError, OSError, json.JSONDecodeError) as exc:
        problems.append(f"run-manifest.json is invalid: {exc}")
        manifest = None
    try:
        markdown = (generation / "report.md").read_text(encoding="utf-8")
    except OSError as exc:
        problems.append(f"report.md is unreadable: {exc}")
        markdown = ""
    if not markdown.strip():
        problems.append("report.md is empty")
    if report is not None and report["report_date"] != date:
        problems.append(f"report.json report_date is {report['report_date']!r}, expected {date!r}")
    if report is not None and manifest is not None:
        if report["run_id"] != manifest["run_id"]:
            problems.append("report.json and run-manifest.json disagree on run_id")
        if report["report_date"] != manifest["report_date"]:
            problems.append("report.json and run-manifest.json disagree on report_date")
    outcome["coherent"] = not problems
    if manifest is not None:
        statuses = {item["id"]: item["status"] for item in manifest["sections"]}
        outcome["status"] = derive_status(config, statuses)
        outcome["degraded"] = sorted(
            sid for sid, status in statuses.items() if status != "complete"
        )
        outcome["required_gaps"] = required_gaps(config, statuses)
        outcome["required_failures"] = required_failures(config, statuses)
        outcome["sections"] = statuses
        if outcome["status"] == "failed":
            # Named precisely, because the two ways to fail are different facts
            # and an operator reading this has to be told which one happened.
            if not any(status == "complete" for status in statuses.values()):
                problems.append(
                    "published report status is 'failed': no section completed, so the "
                    "published artifact records a run that produced nothing"
                    + (
                        "; required section(s) "
                        + ", ".join(outcome["required_failures"])
                        + " did not run at all"
                        if outcome["required_failures"]
                        else ""
                    )
                )
            else:
                problems.append(
                    "published report status is 'failed': required section(s) "
                    + ", ".join(outcome["required_failures"])
                    + " did not run, so the report the operator asked for was "
                    "not produced"
                )
    outcome["ok"] = not problems
    return outcome


def archive_report(
    config: dict[str, Any],
    report_file: str,
    markdown_file: str,
    manifest_file: str | None = None,
) -> dict[str, Any]:
    report = validate_daily_report(load_json(Path(report_file)), config)
    paths = archive_paths(config, report["report_date"])
    manifest_path = Path(manifest_file) if manifest_file else Path(paths["manifest"])
    manifest = validate_run_manifest(load_json(manifest_path), config)
    if manifest["run_id"] != report["run_id"] or manifest["report_date"] != report["report_date"]:
        raise ConfigError("RunManifest and DailyReport run_id/report_date must match exactly")
    try:
        markdown = Path(markdown_file).read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read Markdown {markdown_file}: {exc}") from exc
    if not markdown.strip():
        raise ConfigError("Markdown archive input must be non-empty")
    archived = copy.deepcopy(report)
    archived["markdown_path"] = "report.md"
    published = publish_archive_pair(
        Path(paths["archive_root"]), markdown, archived, manifest, report["report_date"]
    )
    # The generation id, named rather than re-parsed by every caller. A caller
    # that has to guess which generation it just wrote cannot verify that one.
    published["generation"] = Path(published["markdown"]).parent.name
    return published
