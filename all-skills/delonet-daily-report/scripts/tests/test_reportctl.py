from __future__ import annotations

import copy
import datetime as dt
import importlib.machinery
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "reportctl"
reportctl = importlib.machinery.SourceFileLoader("reportctl", str(SCRIPT)).load_module()


def config(root: Path) -> dict:
    return {
        "version": 1,
        "timezone": "America/New_York",
        "artifact_dir": str(root / "artifacts"),
        "archive_dir": str(root / "archive"),
        "max_age_hours": 24,
        "core_sections": [
            {"id": "executive-brief", "title": "Executive Brief", "required": True},
            {"id": "key-changes", "title": "Key Changes", "required": True},
            {"id": "risks-watchlist", "title": "Risks and Watchlist", "required": True},
            {"id": "coverage-freshness", "title": "Coverage and Freshness", "required": True},
        ],
        "daily": {"enabled": True, "schedule": "0 7 * * *", "deliver": "local"},
        "topics": [
            {
                "id": "ai-agents",
                "title": "AI Agents",
                "prompt": "Track material releases",
                "schedule": "15 6 * * *",
                "enabled": True,
                "sources": ["https://example.org/releases"],
                "secret_env": ["NEWS_API_TOKEN"],
            }
        ],
    }


def observed_from_desired(value: dict) -> list[dict]:
    return [
        {"id": f"job-{index}", **job} for index, job in enumerate(reportctl.desired_jobs(value), 1)
    ]


def valid_artifact(fresh_until: str) -> dict:
    return {
        "schema_version": 1,
        "run_id": "run-1",
        "topic_id": "ai-agents",
        "generated_at": "2026-07-15T10:00:00Z",
        "fresh_until": fresh_until,
        "status": "complete",
        "summary": "Material release found.",
        "findings": [
            {
                "claim": "A release shipped.",
                "significance": "Improves reliability.",
                "source_urls": ["https://example.org/releases/1"],
            }
        ],
        "sources": [
            {
                "url": "https://example.org/releases/1",
                "title": "Release",
                "publisher": "Example",
                "published_at": "2026-07-15T09:00:00Z",
                "retrieved_at": "2026-07-15T10:00:00Z",
            }
        ],
        "caveats": ["Independent adoption data is unavailable."],
    }


class ReportctlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.value = config(self.root)
        self.path = self.root / "report.json"
        self.path.write_text(json.dumps(self.value), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT), "--config", str(self.path), *args],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_validation_rejects_duplicate_topics_and_credentials(self) -> None:
        invalid = copy.deepcopy(self.value)
        invalid["topics"].append(copy.deepcopy(invalid["topics"][0]))
        with self.assertRaisesRegex(reportctl.ConfigError, "duplicate topic"):
            reportctl.validate_config(invalid)
        invalid = copy.deepcopy(self.value)
        invalid["topics"][0]["sources"] = ["https://user:password@example.org/private"]
        with self.assertRaisesRegex(reportctl.ConfigError, "without credentials"):
            reportctl.validate_config(invalid)

    def test_plan_is_stable_and_idempotent(self) -> None:
        desired = observed_from_desired(self.value)
        self.assertEqual([], reportctl.reconciliation_plan(self.value, desired))
        drifted = copy.deepcopy(desired)
        drifted[0]["schedule"] = "0 0 * * *"
        first = reportctl.reconciliation_plan(self.value, drifted)
        second = reportctl.reconciliation_plan(self.value, drifted)
        self.assertEqual(first, second)
        self.assertEqual("edit", first[0]["action"])
        create_plan = reportctl.reconciliation_plan(self.value, [])
        applied = [
            {
                "id": f"applied-{index}",
                **{key: value for key, value in action.items() if key != "action"},
            }
            for index, action in enumerate(create_plan)
        ]
        self.assertEqual([], reportctl.reconciliation_plan(self.value, applied))

    def test_daily_runs_at_seven_am_eastern_and_timezone_is_enforced(self) -> None:
        jobs = reportctl.desired_jobs(self.value)
        daily = next(job for job in jobs if job["name"] == "ddr:daily")
        self.assertEqual("0 7 * * *", daily["schedule"])
        self.assertEqual("America/New_York", daily["timezone"])
        invalid = copy.deepcopy(self.value)
        invalid["timezone"] = "UTC"
        with self.assertRaisesRegex(reportctl.ConfigError, "America/New_York"):
            reportctl.validate_config(invalid)
        invalid = copy.deepcopy(self.value)
        invalid["daily"]["schedule"] = "0 8 * * *"
        with self.assertRaisesRegex(reportctl.ConfigError, "07:00"):
            reportctl.validate_config(invalid)
        invalid = copy.deepcopy(self.value)
        invalid["topics"][0]["schedule"] = "every 2h"
        with self.assertRaisesRegex(reportctl.ConfigError, "daily cron"):
            reportctl.validate_config(invalid)
        with mock.patch.object(
            reportctl.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")
        ) as run:
            reportctl.apply_plan(
                [{"action": "pause", "id": "job-1", "name": "ddr:daily"}], "America/New_York"
            )
            self.assertEqual("America/New_York", run.call_args.kwargs["env"]["HERMES_TIMEZONE"])

    def test_duplicate_and_stale_jobs_are_removed_without_touching_foreign_jobs(self) -> None:
        jobs = observed_from_desired(self.value)
        jobs.extend(
            [
                {**jobs[0], "id": "zzz-duplicate"},
                {
                    "id": "old",
                    "name": "ddr:journal:deleted",
                    "schedule": "1 1 * * *",
                    "prompt": "old",
                    "enabled": True,
                },
                {
                    "id": "foreign",
                    "name": "backup:daily",
                    "schedule": "2 2 * * *",
                    "prompt": "keep",
                    "enabled": True,
                },
            ]
        )
        plan = reportctl.reconciliation_plan(self.value, jobs)
        self.assertEqual(["remove-duplicate", "remove-stale"], [item["action"] for item in plan])
        self.assertNotIn("foreign", {item.get("id") for item in plan})

    def test_topic_add_pause_resume_remove_is_atomic(self) -> None:
        added = self.run_cli(
            "topic",
            "add",
            "security",
            "Security",
            "--prompt",
            "Track advisories",
            "--schedule",
            "30 6 * * *",
            "--source",
            "https://example.org/security",
        )
        self.assertEqual(0, added.returncode, added.stderr)
        self.assertEqual(2, len(json.loads(self.path.read_text())["topics"]))
        self.assertEqual(0, self.run_cli("topic", "pause", "security").returncode)
        self.assertFalse(json.loads(self.path.read_text())["topics"][1]["enabled"])
        self.assertEqual(0, self.run_cli("topic", "resume", "security").returncode)
        self.assertEqual(0, self.run_cli("topic", "remove", "security").returncode)
        self.assertEqual(
            ["ai-agents"], [item["id"] for item in json.loads(self.path.read_text())["topics"]]
        )

    def test_duplicate_add_does_not_modify_config(self) -> None:
        before = self.path.read_bytes()
        result = self.run_cli(
            "topic", "add", "ai-agents", "Again", "--prompt", "No", "--schedule", "0 0 * * *"
        )
        self.assertEqual(2, result.returncode)
        self.assertEqual(before, self.path.read_bytes())

    def test_stale_section_health(self) -> None:
        date = dt.date.today().isoformat()
        section = Path(reportctl.section_path(self.value, "ai-agents", date))
        section.parent.mkdir(parents=True)
        section.write_text(json.dumps(valid_artifact("2000-01-01T00:00:00Z")), encoding="utf-8")
        health = reportctl.artifact_health(self.value, date)
        self.assertEqual("stale", health[0]["status"])

    def test_strict_nested_contract_and_malformed_health(self) -> None:
        malformed = valid_artifact("2099-01-01T00:00:00Z")
        malformed["findings"][0]["unexpected"] = True
        with self.assertRaisesRegex(reportctl.ConfigError, "contract mismatch"):
            reportctl.validate_section_artifact(malformed, "ai-agents")
        date = dt.date.today().isoformat()
        section = Path(reportctl.section_path(self.value, "ai-agents", date))
        section.parent.mkdir(parents=True)
        section.write_text(json.dumps(malformed), encoding="utf-8")
        self.assertEqual("invalid", reportctl.artifact_health(self.value, date)[0]["status"])

    def test_core_sections_feed_aggregator_prompt(self) -> None:
        defaults = json.loads(
            (SCRIPT.parent.parent / "assets" / "default-core-sections.json").read_text()
        )
        self.assertEqual(defaults, self.value["core_sections"])
        prompt = reportctl.daily_prompt(self.value)
        positions = [prompt.index(section["id"]) for section in self.value["core_sections"]]
        self.assertEqual(sorted(positions), positions)
        invalid = copy.deepcopy(self.value)
        invalid["core_sections"] = invalid["core_sections"][:-1]
        with self.assertRaisesRegex(reportctl.ConfigError, "coverage-freshness"):
            reportctl.validate_config(invalid)
        invalid = copy.deepcopy(self.value)
        invalid["core_sections"] = [invalid["core_sections"][-1]]
        with self.assertRaisesRegex(reportctl.ConfigError, "shipped defaults"):
            reportctl.validate_config(invalid)

    def test_secret_redaction_is_recursive(self) -> None:
        value = {
            "api_token": "literal",
            "message": "Authorization: Bearer abc.def",
            "nested": [{"password": "hunter2"}],
            "secret_env": ["TOKEN_NAME"],
        }
        redacted = reportctl.redact(value)
        self.assertEqual("[REDACTED]", redacted["api_token"])
        self.assertNotIn("abc.def", redacted["message"])
        self.assertEqual("[REDACTED]", redacted["nested"][0]["password"])
        self.assertEqual(["TOKEN_NAME"], redacted["secret_env"])

    def test_archive_paths_are_partitioned(self) -> None:
        paths = reportctl.archive_paths(self.value, "2026-07-15")
        self.assertTrue(paths["markdown"].endswith("/2026/07/2026-07-15.md"))
        self.assertTrue(paths["manifest"].endswith("/2026-07-15/run-manifest.json"))

    def test_archive_writes_validated_json_and_markdown_atomically(self) -> None:
        report = {
            "schema_version": 1,
            "run_id": "run-1",
            "report_date": "2026-07-15",
            "title": "Daily Company Rollup",
            "generated_at": "2026-07-15T11:00:00Z",
            "sections": [
                {
                    "id": section["id"],
                    "title": section["title"],
                    "body": f"Body for {section['title']}",
                    "source_urls": [],
                }
                for section in self.value["core_sections"]
            ],
            "coverage": {"complete": ["ai-agents"], "degraded": []},
            "markdown_path": "/pending/report.md",
        }
        report_file, markdown_file = self.root / "input.json", self.root / "input.md"
        report_file.write_text(json.dumps(report), encoding="utf-8")
        markdown_file.write_text("# Daily Company Rollup\n", encoding="utf-8")
        output = reportctl.archive_report(self.value, str(report_file), str(markdown_file))
        self.assertEqual("# Daily Company Rollup\n", Path(output["markdown"]).read_text())
        archived = json.loads(Path(output["report_json"]).read_text())
        self.assertEqual(output["markdown"], archived["markdown_path"])
        self.assertFalse(list(Path(output["markdown"]).parent.glob(".*.md.*")))


if __name__ == "__main__":
    unittest.main()
