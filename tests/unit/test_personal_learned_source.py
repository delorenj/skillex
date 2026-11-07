import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/personal-learned-source.py"


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


class PersonalSourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="skillex-source-test-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "--bare", str(self.remote)], check=True, capture_output=True)
        self.repo = self.tmp / "agents"
        git(self.tmp, "clone", str(self.remote), str(self.repo))
        git(self.repo, "config", "user.name", "Fixture")
        git(self.repo, "config", "user.email", "fixture@example.test")
        self.identity = self.repo / "workforce/person"
        self.identity.mkdir(parents=True)
        (self.identity / "contract.yaml").write_text("id: person\n")
        (self.identity / "agent.yaml").write_text("id: person\n")
        self.profile = self.tmp / "hermes/person"
        self.profile.mkdir(parents=True)
        (self.profile / "profile.yaml").write_text(
            "name: person\nflume:\n  employment: portable-specialist\n"
            f"  definition: {self.identity / 'agent.yaml'}\n")
        self.skill = self.profile / "learned-skills/topic/lesson"
        self.skill.mkdir(parents=True)
        (self.skill / "SKILL.md").write_text("---\nname: lesson\ndescription: Lesson\n---\nHello\n")
        (self.skill / "assets").mkdir()
        (self.skill / "assets/data.bin").write_bytes(b"\x00\xff")
        git(self.repo, "add", "workforce/person/agent.yaml", "workforce/person/contract.yaml")
        git(self.repo, "commit", "-m", "fixture")
        git(self.repo, "push", "-u", "origin", "HEAD")

    def run_script(self, *args, success=True):
        env = dict(os.environ, XDG_STATE_HOME=str(self.tmp / "state"))
        result = subprocess.run(["python3", str(SCRIPT), *args, "--profile", str(self.profile)],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def migrate(self):
        return self.run_script("migrate", "--apply")

    def test_preview_migrate_recovery_and_idempotence(self):
        self.assertTrue(self.run_script("migrate")["ok"])
        self.assertFalse((self.identity / "learned-skills").exists())
        result = self.migrate()
        self.assertTrue(result["pushed"])
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), git(self.remote, "rev-parse", "HEAD"))
        self.assertTrue(self.profile.joinpath("learned-skills").is_symlink())
        self.assertEqual(git(self.repo, "show", "HEAD:workforce/person/personal-learned-source.json"),
                         '{"identity": "person", "schema": 1, "source": "learned-skills"}')
        self.assertEqual((self.skill / "assets/data.bin").read_bytes(), b"\x00\xff")
        recovered = list((self.tmp / "state/skillex/personal-learning/person").glob("*/topic/lesson/assets/data.bin"))
        self.assertGreaterEqual(len(recovered), 1)
        self.assertTrue(all(path.read_bytes() == b"\x00\xff" for path in recovered))
        self.assertTrue(self.run_script("check")["ok"])
        self.assertTrue(self.run_script("migrate")["ok"])
        self.assertEqual(self.migrate()["commit"], result["commit"])

    def test_checkpoint_create_edit_assets_and_unrelated_staged(self):
        self.migrate()
        (self.tmp / "outside").write_text("ignored")
        (self.repo / "unrelated.txt").write_text("staged bytes")
        git(self.repo, "add", "unrelated.txt")
        baseline = git(self.repo, "show", ":unrelated.txt")
        (self.skill / "SKILL.md").write_text("---\nname: lesson\ndescription: Lesson\n---\nEdited\n")
        (self.skill / "assets/new.bin").write_bytes(b"new")
        second = self.identity / "learned-skills/topic/second"
        second.mkdir()
        (second / "SKILL.md").write_text("---\nname: second\ndescription: New\n---\n")
        result = self.run_script("checkpoint")
        self.assertTrue(result["pushed"])
        self.assertEqual(git(self.repo, "show", ":unrelated.txt"), baseline)
        self.assertNotIn("unrelated.txt", git(self.repo, "show", "--pretty=format:", "--name-only", "HEAD"))
        self.assertEqual(git(self.remote, "rev-parse", "HEAD"), result["commit"])
        self.assertIn("workforce/person/learned-skills/topic/second/SKILL.md",
                      git(self.repo, "show", "--pretty=format:", "--name-only", "HEAD"))

    def test_empty_identity_tracks_source_and_definition_without_generated_contract(self):
        (self.identity / "contract.yaml").unlink()
        git(self.repo, "rm", "--cached", "workforce/person/contract.yaml")
        (self.repo / ".gitignore").write_text("/workforce/*/contract.yaml\n")
        (self.identity / "contract.yaml").write_text("id: person\n")
        git(self.repo, "add", ".gitignore")
        git(self.repo, "commit", "-m", "ignore generated contract")
        git(self.repo, "push", "origin", "HEAD")
        git(self.repo, "rm", "--cached", "workforce/person/agent.yaml")
        git(self.repo, "commit", "-m", "simulate new definition")
        git(self.repo, "push", "origin", "HEAD")
        shutil.rmtree(self.profile / "learned-skills")
        result = self.migrate()
        paths = git(self.repo, "show", "--pretty=format:", "--name-only", result["commit"])
        self.assertIn("workforce/person/agent.yaml", paths)
        self.assertIn("workforce/person/learned-skills/.gitkeep", paths)
        self.assertIn("workforce/person/personal-learned-source.json", paths)
        self.assertNotIn("contract.yaml", paths)
        self.assertTrue(self.run_script("check")["ok"])
        self.assertEqual(self.migrate()["commit"], result["commit"])

    def test_collisions_identity_and_bad_metadata_refuse(self):
        (self.profile / "skills/alias").mkdir(parents=True)
        (self.profile / "skills/alias/SKILL.md").write_text("---\nname: lesson\ndescription: Selected\n---\n")
        self.run_script("migrate", success=False)
        self.assertFalse((self.identity / "learned-skills").exists())
        shutil.rmtree(self.profile / "skills")
        (self.profile / "profile.yaml").write_text("name: someone-else\n")
        self.run_script("migrate", success=False)
        self.assertTrue(self.skill.exists())

    def test_push_failure_preserves_original_then_recovers(self):
        git(self.repo, "remote", "set-url", "origin", str(self.tmp / "missing.git"))
        failure = self.run_script("migrate", "--apply", success=False)
        self.assertFalse(failure["pushed"])
        self.assertTrue(self.skill.exists())
        self.assertFalse((self.profile / "learned-skills").is_symlink())
        git(self.repo, "remote", "set-url", "origin", str(self.remote))
        self.assertTrue(self.migrate()["pushed"])

    def test_failed_checkpoint_retains_written_changes_for_retry(self):
        self.migrate()
        (self.skill / "SKILL.md").write_text("---\nname: lesson\ndescription: Lesson\n---\nChanged\n")
        git(self.repo, "remote", "set-url", "origin", str(self.tmp / "missing.git"))
        failure = self.run_script("checkpoint", success=False)
        self.assertFalse(failure["pushed"])
        self.assertIn("Changed", (self.skill / "SKILL.md").read_text())
        git(self.repo, "remote", "set-url", "origin", str(self.remote))
        retry = self.run_script("checkpoint")
        self.assertEqual(git(self.remote, "rev-parse", "HEAD"), retry["commit"])


if __name__ == "__main__":
    unittest.main()
