"""Exercise real PM setup, real Skillex CLI, and canonical renderer in isolation."""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
RENDERER = Path.home() / "code/33GOD/hermes-agent-template/scripts/hermes-profile-config.py"


@pytest.fixture
def tmp_root():
    """Skillex refuses activation receipts inside a git checkout, and pytest's
    tmp_path can sit in one (TMPDIR=~/.claude/tmp under Claude Code hooks)."""
    with tempfile.TemporaryDirectory(prefix="pm-setup-", dir="/tmp") as tmp:
        yield Path(tmp).resolve()


def fixture(tmp_path):
    home = tmp_path / "home"
    role = tmp_path / "project/agents/hermes/pm"
    scripts = role / ".scripts"
    shutil.copytree(
        ROOT / "agents/hermes/pm/.scripts",
        scripts,
        ignore=shutil.ignore_patterns("__pycache__", ".provision*", ".done*"),
    )
    (scripts / "_lib.sh").write_text("""set -euo pipefail
ROLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE_YAML="$ROLE_DIR/role.yaml"
PROFILE_NAME=fixture-pm
AGENT_ID=fixture-pm
REGISTRY_FILE="$HOME/no-registry"
load_role_env() { :; }
project_repo_path() { printf '%s' "$TEST_PROJECT"; }
log() { :; }
warn() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
already_done() { return 1; }
mark_done() { :; }
""")
    (role / "role.yaml").write_text(
        "repo: fixture\nrole: pm\nprofile: fixture-pm\nagent_id: fixture-pm\n"
    )
    project = tmp_path / "project"
    (project / ".agents").mkdir()
    (project / ".agents/skills.json").write_text('{"inherit_global":true}')
    (home / ".agents").mkdir(parents=True)
    (home / ".agents/skills.json").write_text('{"skills":["alpha"]}')
    catalog = tmp_path / "registry/all-skills/alpha"
    catalog.mkdir(parents=True)
    (catalog / "SKILL.md").write_text("---\nname: alpha\ndescription: test\n---\n")
    (tmp_path / "registry/sets").mkdir()
    fleet = home / ".hermes"
    fleet.mkdir()
    (fleet / "config.yaml").write_text("skills:\n  external_dirs: [legacy]\nmodel: preserved\n")
    wrapper = tmp_path / "skillex"
    wrapper.write_text(f'#!/bin/sh\nexec node "{ROOT}/dist/cli.js" "$@"\n')
    wrapper.chmod(0o755)
    hermes = tmp_path / "hermes"
    hermes.write_text("""#!/bin/sh
mkdir -p "$HOME/.hermes/profiles/$3/skills"
printf '{}\\n' > "$HOME/.hermes/profiles/$3/config.yaml"
""")
    hermes.chmod(0o755)
    env = {
        **os.environ,
        "HOME": str(home),
        "HERMES_HOME": str(fleet),
        "TEST_PROJECT": str(project),
        "SKILLEX_BIN": str(wrapper),
        "HERMES_BIN": str(hermes),
        "PROFILE_RENDERER": str(RENDERER),
        "PJ_SKILLS_REGISTRY_ROOT": str(tmp_path / "registry"),
        "XDG_STATE_HOME": str(tmp_path / "state"),
    }
    return fleet / "profiles/fixture-pm", scripts, env


def run(scripts, env):
    return subprocess.run(
        ["bash", str(scripts / "10-hermes-profile.sh")], env=env, text=True, capture_output=True
    )


def test_new_profile_gets_strict_policy_and_repeated_setup_preserves_state(tmp_root):
    profile, scripts, env = fixture(tmp_root)
    result = run(scripts, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (profile / ".skillex-only").is_file()
    assert (profile / ".no-bundled-skills").is_file()
    assert (profile / "skills/alpha").is_symlink()
    assert not (profile / "skills/legacy").exists()
    (profile / "state.db").write_bytes(b"runtime")
    (profile / "gateway.pid").write_text("123")
    before = {
        p.name: (p.stat().st_ino, p.read_bytes())
        for p in [
            profile / "state.db",
            profile / "gateway.pid",
            profile / "config.yaml",
            profile / "config.delta.yaml",
        ]
    }
    result = run(scripts, env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert before == {
        p.name: (p.stat().st_ino, p.read_bytes())
        for p in [
            profile / "state.db",
            profile / "gateway.pid",
            profile / "config.yaml",
            profile / "config.delta.yaml",
        ]
    }


def test_existing_foreign_skill_refuses_without_resetting_live_state(tmp_root):
    profile, scripts, env = fixture(tmp_root)
    assert run(scripts, env).returncode == 0
    foreign = profile / "skills/foreign"
    foreign.mkdir()
    (foreign / "SKILL.md").write_text("preserve")
    (profile / "state.db").write_bytes(b"runtime")
    result = run(scripts, env)
    assert result.returncode != 0
    assert (foreign / "SKILL.md").read_text() == "preserve"
    assert (profile / "state.db").read_bytes() == b"runtime"
