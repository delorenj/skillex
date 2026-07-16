from __future__ import annotations

import copy
import subprocess
import unittest
from unittest import mock

from test_fixtures import config
from test_reportctl import reportctl

reportctl_inference = __import__("reportctl_inference")


def native_jobs(value: dict) -> list[dict]:
    return [
        {
            "id": f"native-{index}",
            **job,
            "provider": None,
            "model": None,
            "base_url": None,
        }
        for index, job in enumerate(reportctl.desired_jobs(value), 1)
    ]


class InferenceReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.value = config(__import__("pathlib").Path("/tmp/ddr-inference-test"))

    def test_native_snapshots_are_idempotent_and_mismatch_recreates_once(self) -> None:
        observed = native_jobs(self.value)
        self.assertEqual([], reportctl.reconciliation_plan(self.value, observed))
        observed[0]["provider_snapshot"] = "openrouter"
        observed[0]["model_snapshot"] = None
        first = reportctl.reconciliation_plan(self.value, observed)
        second = reportctl.reconciliation_plan(self.value, observed)
        self.assertEqual(first, second)
        recreates = [action for action in first if action["action"] == "recreate"]
        self.assertEqual(1, len(recreates))
        self.assertEqual(observed[0]["id"], recreates[0]["id"])
        self.assertEqual("openai-codex", recreates[0]["provider_snapshot"])
        self.assertEqual("gpt-5.4", recreates[0]["model_snapshot"])
        repaired = copy.deepcopy(observed)
        repaired[0]["provider_snapshot"] = "openai-codex"
        repaired[0]["model_snapshot"] = "gpt-5.4"
        self.assertEqual([], reportctl.reconciliation_plan(self.value, repaired))

    def test_report_config_requires_explicit_inference_pin(self) -> None:
        invalid = copy.deepcopy(self.value)
        invalid.pop("inference")
        with self.assertRaisesRegex(reportctl.ConfigError, "missing keys.*inference"):
            reportctl.validate_config(invalid)

    def test_paused_recreate_removes_then_creates_pauses_and_postchecks(self) -> None:
        value = copy.deepcopy(self.value)
        value["topics"][0]["enabled"] = False
        observed = native_jobs(value)
        target = next(job for job in observed if job["name"].startswith("ddr:journal:"))
        target["provider_snapshot"] = "openrouter"
        target["model_snapshot"] = None
        action = next(
            item
            for item in reportctl.reconciliation_plan(value, observed)
            if item["name"] == target["name"]
        )
        self.assertEqual("recreate", action["action"])
        self.assertFalse(action["enabled"])
        old = reportctl.normalize_job(target)
        created = reportctl.normalize_job(
            {
                **target,
                "id": "new-job",
                "provider_snapshot": "openai-codex",
                "model_snapshot": "gpt-5.4",
                "enabled": False,
            }
        )
        stable_states = [[old], [], [], [created]]

        def command_result(command, **_kwargs):
            stdout = "Created job: new-job\n" if command[2] == "create" else ""
            return subprocess.CompletedProcess(command, 0, stdout, "")

        with (
            mock.patch.object(reportctl, "read_stable_live_jobs", side_effect=stable_states),
            mock.patch.object(
                reportctl_inference, "run_command", side_effect=command_result
            ) as run,
        ):
            reportctl.apply_plan([action], value)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(["remove", "create", "pause"], [command[2] for command in commands])
        self.assertNotIn("run", [part for command in commands for part in command])
        self.assertNotIn("--provider", commands[1])
        self.assertNotIn("--model", commands[1])

    def test_recreate_race_aborts_before_create(self) -> None:
        observed = native_jobs(self.value)
        observed[0]["provider_snapshot"] = "openrouter"
        action = reportctl.reconciliation_plan(self.value, observed)[0]
        old = reportctl.normalize_job(observed[0])
        intruder = {**old, "id": "intruder"}
        with (
            mock.patch.object(reportctl, "read_stable_live_jobs", side_effect=[[old], [intruder]]),
            mock.patch.object(
                reportctl_inference,
                "run_command",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run,
        ):
            with self.assertRaisesRegex(reportctl.ConfigError, "changed unexpectedly"):
                reportctl.apply_plan([action], self.value)
        self.assertEqual(1, run.call_count)
        self.assertEqual("remove", run.call_args.args[0][2])

    def test_fresh_create_requires_expected_snapshots(self) -> None:
        action = reportctl.reconciliation_plan(self.value, [native_jobs(self.value)[0]])[0]
        self.assertEqual("create", action["action"])
        bad = reportctl.normalize_job(
            {
                "id": "new-job",
                **action,
                "provider_snapshot": None,
                "model_snapshot": None,
            }
        )
        with (
            mock.patch.object(reportctl, "read_stable_live_jobs", side_effect=[[], [bad]]),
            mock.patch.object(
                reportctl_inference,
                "run_command",
                return_value=subprocess.CompletedProcess([], 0, "Created job: new-job\n", ""),
            ),
        ):
            with self.assertRaisesRegex(reportctl.ConfigError, "unexpected inference"):
                reportctl.apply_plan([action], self.value)

    def test_health_inference_flags_null_and_mismatch(self) -> None:
        observed = [reportctl.normalize_job(job) for job in native_jobs(self.value)]
        observed[0]["provider_snapshot"] = None
        observed[1]["model_snapshot"] = "wrong-model"
        issues = reportctl.inference_issues(self.value, observed, reportctl.managed)
        self.assertEqual(2, len(issues))
        self.assertIn("provider_snapshot=null", issues[0]["reason"])
        self.assertIn("model_snapshot=wrong-model", issues[1]["reason"])


if __name__ == "__main__":
    unittest.main()
