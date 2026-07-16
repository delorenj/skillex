from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_fixtures import config
from test_reportctl import reportctl, reportctl_runtime


class ProfileConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "hermes"
        self.home.mkdir()
        skill = self.home / "skills" / "delonet-daily-report" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("skill", encoding="utf-8")
        self.value = config(self.root)
        self.environment = mock.patch.dict(
            os.environ,
            {"HERMES_HOME": str(self.home), "HERMES_TIMEZONE": ""},
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def write_profile(self, value: str) -> None:
        (self.home / "config.yaml").write_text(value, encoding="utf-8")

    def test_real_nested_profile_passes_preflight(self) -> None:
        self.write_profile(
            "timezone: America/New_York\nmodel:\n  provider: openai-codex\n  default: gpt-5.4\n"
        )
        reportctl.timezone_preflight(self.value)

    def test_canonical_skill_pointer_passes_preflight(self) -> None:
        skill_root = self.root / "global-skills" / "delonet-daily-report"
        skill_root.mkdir(parents=True)
        (skill_root / "SKILL.md").write_text("skill", encoding="utf-8")
        profile_skill = self.home / "skills" / "delonet-daily-report"
        (profile_skill / "SKILL.md").unlink()
        profile_skill.rmdir()
        profile_skill.write_text(str(skill_root), encoding="utf-8")
        self.write_profile(
            "timezone: America/New_York\nmodel:\n  provider: openai-codex\n  default: gpt-5.4\n"
        )
        reportctl.timezone_preflight(self.value)

    def test_unsafe_or_broken_skill_pointers_fail_closed(self) -> None:
        profile_skill = self.home / "skills" / "delonet-daily-report"
        (profile_skill / "SKILL.md").unlink()
        profile_skill.rmdir()
        self.write_profile(
            "timezone: America/New_York\nmodel:\n  provider: openai-codex\n  default: gpt-5.4\n"
        )
        for pointer in ("relative/path", "/missing/skill", "/first/path\n/second/path\n"):
            with self.subTest(pointer=pointer.splitlines()[0]):
                profile_skill.write_text(pointer, encoding="utf-8")
                with self.assertRaisesRegex(reportctl.ConfigError, "must be installed"):
                    reportctl.timezone_preflight(self.value)

    def test_flow_nested_profile_passes_preflight(self) -> None:
        self.write_profile(
            "timezone: America/New_York\nmodel: { provider: openai-codex, default: gpt-5.4 }\n"
        )
        reportctl.timezone_preflight(self.value)

    def test_flat_profile_remains_compatible(self) -> None:
        self.write_profile("timezone: America/New_York\nprovider: openai-codex\nmodel: gpt-5.4\n")
        reportctl.timezone_preflight(self.value)

    def test_flat_and_nested_inference_is_rejected_as_ambiguous(self) -> None:
        self.write_profile(
            "timezone: America/New_York\n"
            "provider: openai-codex\n"
            "model:\n"
            "  provider: openai-codex\n"
            "  default: gpt-5.4\n"
        )
        with self.assertRaisesRegex(reportctl.ConfigError, "ambiguous"):
            reportctl_runtime.profile_config()

    def test_duplicate_nested_setting_is_rejected(self) -> None:
        self.write_profile(
            "model:\n  provider: openai-codex\n  provider: openrouter\n  default: gpt-5.4\n"
        )
        with self.assertRaisesRegex(reportctl.ConfigError, "duplicate model.provider"):
            reportctl_runtime.profile_config()

    def test_aliases_and_tags_are_rejected_without_echoing_values(self) -> None:
        secret = "github_pat_abcdefghijklmnopqrstuvwxyz123456"
        for profile in (
            f"model:\n  provider: !secret {secret}\n  default: gpt-5.4\n",
            "model:\n  provider: &provider openai-codex\n  default: *provider\n",
            "defaults: &defaults\n  provider: openai-codex\nmodel:\n  <<: *defaults\n",
        ):
            with self.subTest(profile=profile[:6]):
                self.write_profile(profile)
                with self.assertRaises(reportctl.ConfigError) as raised:
                    reportctl_runtime.profile_config()
                self.assertNotIn(secret, str(raised.exception))
                self.assertRegex(str(raised.exception), "unsupported YAML")


if __name__ == "__main__":
    unittest.main()
