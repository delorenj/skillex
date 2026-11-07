import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "personal-learned-inventory.py"
SPEC = importlib.util.spec_from_file_location("personal_inventory", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PersonalInventoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="skillex-personal-inventory-"))
        self.addCleanup(shutil.rmtree, self.temp)
        self.identity = self.temp / "agents" / "workforce" / "person"
        self.profile = self.temp / "hermes" / "profiles" / "person"
        self.identity.mkdir(parents=True)
        self.profile.mkdir(parents=True)
        (self.identity / "contract.yaml").write_text("id: person\n")
        (self.identity / "agent.yaml").write_text("id: person\n")
        (self.profile / "profile.yaml").write_text(
            "name: person\nflume:\n  employment: portable-specialist\n"
            f"  definition: {self.identity / 'agent.yaml'}\n"
        )
        (self.profile / "learned-skills" / "category" / "lesson").mkdir(parents=True)
        (self.profile / "learned-skills" / "category" / "lesson" / "SKILL.md").write_text(
            "---\nname: lesson\ndescription: Learned procedure\n---\nBody\n"
        )

    def test_nested_skill_is_hashed_and_bound_to_identity(self):
        result = MODULE.inventory(self.profile, self.identity)
        self.assertEqual(result["identity"], "person")
        self.assertEqual(result["skills"][0]["directory"], "category/lesson")
        self.assertEqual(len(result["skills"][0]["files"][0]["sha256"]), 64)
        self.assertEqual(json.loads(json.dumps(result))["entry_count"], 3)

    def test_rejects_mismatched_identity_binding(self):
        (self.profile / "profile.yaml").write_text(
            "name: person\nflume:\n  employment: portable-specialist\n  definition: /tmp/other/agent.yaml\n"
        )
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inventory(self.profile, self.identity)

    def test_rejects_symlink_and_selection_collision(self):
        (self.profile / "learned-skills" / "category" / "link").symlink_to(self.identity)
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inventory(self.profile, self.identity)
        (self.profile / "learned-skills" / "category" / "link").unlink()
        (self.profile / "skills").mkdir()
        (self.profile / "skills" / "lesson").mkdir()
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inventory(self.profile, self.identity)

    def test_selected_set_root_alias_is_followed_for_collision_inventory(self):
        selected = self.temp / "selected"
        selected.mkdir()
        alias = self.profile / "skills"
        alias.symlink_to(selected, target_is_directory=True)
        self.assertEqual(
            MODULE.inventory(self.profile, self.identity)["skills"][0]["name"], "lesson"
        )
        (selected / "different-alias").mkdir()
        (selected / "different-alias/SKILL.md").write_text(
            "---\nname: lesson\ndescription: Selected procedure\n---\n"
        )
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inventory(self.profile, self.identity)

    def test_missing_learned_root_is_empty_not_an_error(self):
        shutil.rmtree(self.profile / "learned-skills")
        self.assertEqual(MODULE.inventory(self.profile, self.identity)["skills"], [])

    def test_rejects_symlinked_learned_root(self):
        shutil.rmtree(self.profile / "learned-skills")
        (self.profile / "learned-skills").symlink_to(self.identity)
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inventory(self.profile, self.identity)

    def test_rejects_duplicate_names_in_categories(self):
        second = self.profile / "learned-skills" / "other" / "lesson"
        second.mkdir(parents=True)
        (second / "SKILL.md").write_text("---\nname: lesson\ndescription: Another\n---\n")
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inventory(self.profile, self.identity)


if __name__ == "__main__":
    unittest.main()
