"""Bounded cutover invariants; run with python3 -m unittest discover -s tests -p '*cutover_test.py'."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/activation-conflict-cutover.py"
spec = importlib.util.spec_from_file_location("activation_conflict_cutover", SCRIPT)
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


class CutoverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / "code"
        self.project = self.base / "sidepiece"
        (self.project / ".agents/skills/demo").mkdir(parents=True)
        (self.project / ".agents/skills/demo/SKILL.md").write_text("canonical")
        (self.project / ".kimi/skills").mkdir(parents=True)
        (self.project / ".kimi/skills/demo").symlink_to(self.project / ".agents/skills/demo")
        self.globalroot = Path(self.temp.name) / ".agents/skills"
        self.globalroot.mkdir(parents=True)
        self.base_patch = patch.object(cutover, "BASE", self.base)
        self.home_patch = patch.object(Path, "home", return_value=Path(self.temp.name))
        self.base_patch.start()
        self.home_patch.start()
        self.addCleanup(self.base_patch.stop)
        self.addCleanup(self.home_patch.stop)

    def test_preview_is_read_only(self):
        result = cutover.cutover(self.project)
        self.assertEqual(result["status"], "ready")
        self.assertTrue((self.project / ".kimi/skills").is_dir())
        self.assertEqual(result["visible"].keys(), {"demo"})

    def test_requires_complete_visibility(self):
        (self.project / ".kimi/skills/foreign").mkdir()
        (self.project / ".kimi/skills/foreign/SKILL.md").write_text("foreign")
        with self.assertRaisesRegex(ValueError, "absent"):
            cutover.cutover(self.project)
        self.assertTrue((self.project / ".kimi/skills/foreign/SKILL.md").exists())

    def test_existing_backup_is_never_replaced(self):
        backup = Path(self.temp.name) / "backups"
        backup.mkdir()
        (backup / "sidepiece--.kimi--skills").mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            cutover.cutover(self.project, backup, True)
        self.assertTrue((self.project / ".kimi/skills").is_dir())

    def test_different_bytes_are_preserved_not_discarded(self):
        (self.project / ".kimi/skills/demo").unlink()
        (self.project / ".kimi/skills/demo").mkdir()
        (self.project / ".kimi/skills/demo/SKILL.md").write_text("old variant")
        result = cutover.cutover(self.project)
        self.assertEqual(result["source_variants"], ["demo"])
        self.assertEqual(result["inventory"]["children"]["demo"]["children"]["SKILL.md"]["kind"], "file")


if __name__ == "__main__":
    unittest.main()
