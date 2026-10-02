"""The resync installer: symlinked user units, layout drop-ins, idempotence; a fake systemctl."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).parents[2]
UNITS = [
    "skillex-hermes-resync.service",
    "skillex-hermes-resync.timer",
    "skillex-hermes-resync.path",
]

FAKE_SYSTEMCTL = """#!/bin/sh
echo "$@" >> "$FAKE_CTL_LOG"
case "$*" in
  *is-enabled*) echo "${FAKE_ENABLED:-enabled}" ;;
  *is-active*) echo "${FAKE_ACTIVE:-active}" ;;
esac
exit 0
"""


class Box:
    """A scratch HOME in which the installer runs against a fake systemctl."""

    def __init__(self, root, repo=REPO, link_default=True):
        self.root = root
        self.home = root / "home"
        self.repo = repo
        self.home.mkdir()
        if link_default:  # ~/code/skillex -> the repo, as on the real host
            (self.home / "code").mkdir()
            (self.home / "code/skillex").symlink_to(repo)
        self.ctl = root / "systemctl"
        self.ctl.write_text(FAKE_SYSTEMCTL)
        self.ctl.chmod(0o755)
        self.log = root / "ctl.log"
        self.user = self.home / ".config/systemd/user"
        self.state = root / "state"

    def run(self, command, installer=None, **env):
        merged = {
            "HOME": str(self.home),
            "PATH": "/usr/bin:/bin",
            "SYSTEMCTL": str(self.ctl),
            "FAKE_CTL_LOG": str(self.log),
            "XDG_STATE_HOME": str(self.state),
        }
        merged.update(env)
        script = installer or self.repo / "scripts/install-hermes-resync.sh"
        return subprocess.run(
            ["bash", str(script), command], env=merged, capture_output=True, text=True, timeout=60
        )

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []


@pytest.fixture
def box(tmp_path):
    return Box(tmp_path)


def test_install_links_the_tracked_units_and_enables_timer_and_path(box):
    done = box.run("install")
    assert done.returncode == 0, done.stderr
    for unit in UNITS:
        link = box.user / unit
        assert link.is_symlink() and link.resolve() == (REPO / "systemd" / unit).resolve()
    assert box.calls() == [
        "--user daemon-reload",
        "--user reset-failed " + " ".join(UNITS),
        "--user enable --now skillex-hermes-resync.timer skillex-hermes-resync.path",
    ]
    # the default layout needs no drop-in: the tracked units already say ~/code/skillex
    assert not list(box.user.glob("*.d"))


def test_install_twice_changes_nothing(box):
    assert box.run("install").returncode == 0
    before = sorted(str(p) for p in box.user.rglob("*"))
    again = box.run("install")
    assert again.returncode == 0
    assert again.stdout.count("ok       ") == 3 and "linked" not in again.stdout
    assert sorted(str(p) for p in box.user.rglob("*")) == before


def test_a_stale_symlink_is_repointed_and_a_real_file_is_refused(box):
    box.user.mkdir(parents=True)
    (box.user / UNITS[0]).symlink_to("/nowhere/skillex-hermes-resync.service")
    (box.user / UNITS[1]).write_text("[Timer]\n")
    refused = box.run("install")
    assert refused.returncode == 1 and "is not a symlink" in refused.stderr
    assert (box.user / UNITS[1]).read_text() == "[Timer]\n"  # never clobbered
    (box.user / UNITS[1]).unlink()
    assert box.run("install").returncode == 0
    assert (box.user / UNITS[0]).resolve() == (REPO / "systemd" / UNITS[0]).resolve()


def test_off_default_layout_gets_a_drop_in_and_loses_it_when_it_becomes_default(tmp_path):
    box = Box(tmp_path, link_default=False)
    assert box.run("install").returncode == 0
    service = (box.user / "skillex-hermes-resync.service.d/10-layout.conf").read_text()
    assert f"ExecStart=/usr/bin/python3 -B {REPO}/scripts/hermes-skillex-resync.py" in service
    assert service.splitlines()[1:3] == ["ExecStart=", service.splitlines()[2]]
    assert f"PJ_SKILLS_REGISTRY_ROOT={REPO}" in service
    path = (box.user / "skillex-hermes-resync.path.d/10-layout.conf").read_text()
    gitdir = subprocess.run(
        ["git", "-C", str(REPO / "all-skills"), "rev-parse", "--absolute-git-dir"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert f"PathModified={gitdir}/logs/HEAD" in path and f"PathChanged={gitdir}/HEAD" in path
    assert path.splitlines()[1:3] == ["PathModified=", "PathChanged="]  # resets the tracked list

    (box.home / "code").mkdir()
    (box.home / "code/skillex").symlink_to(REPO)  # now the default layout
    assert box.run("install").returncode == 0
    assert not list(box.user.glob("*.d"))


def test_a_submodule_style_gitdir_file_is_resolved_to_the_real_gitdir(tmp_path):
    skeleton = tmp_path / "home/code/skillex"
    box = Box(tmp_path, repo=skeleton, link_default=False)  # creates tmp_path/home
    (skeleton / "scripts").mkdir(parents=True)
    shutil.copytree(REPO / "systemd", skeleton / "systemd")
    for name in ("install-hermes-resync.sh", "hermes-skillex-resync.py"):
        shutil.copy(REPO / "scripts" / name, skeleton / "scripts" / name)
    modules = skeleton / ".git/modules/all-skills"
    modules.parent.mkdir(parents=True)
    subprocess.run(
        ["git", "init", "-q", "--separate-git-dir", str(modules), str(skeleton / "all-skills")],
        check=True,
        capture_output=True,
    )
    assert (skeleton / "all-skills/.git").is_file()  # a gitdir file, not a directory
    done = box.run("install")
    assert done.returncode == 0, done.stderr
    path = (box.user / "skillex-hermes-resync.path.d/10-layout.conf").read_text()
    assert f"PathModified={modules.resolve()}/logs/HEAD" in path
    assert not (box.user / "skillex-hermes-resync.service.d").exists()  # repo IS at ~/code/skillex


def test_uninstall_removes_its_own_links_and_nothing_else(box):
    assert box.run("install").returncode == 0
    stranger = box.user / "other.timer"
    stranger.symlink_to("/elsewhere/other.timer")
    box.log.unlink()
    done = box.run("uninstall")
    assert done.returncode == 0, done.stderr
    assert not any((box.user / unit).exists() or (box.user / unit).is_symlink() for unit in UNITS)
    assert stranger.is_symlink()
    assert (
        box.calls()[0]
        == "--user disable --now skillex-hermes-resync.timer skillex-hermes-resync.path"
    )
    assert box.run("uninstall").returncode == 0  # and again


def test_uninstall_leaves_a_link_that_points_somewhere_else(box):
    box.user.mkdir(parents=True)
    foreign = box.user / UNITS[2]
    foreign.symlink_to(box.root)  # exists, but is not this repo's unit
    done = box.run("uninstall")
    assert done.returncode == 0 and foreign.is_symlink() and "left" in done.stdout


def last_run(box, **fields):
    box.state.joinpath("skillex").mkdir(parents=True, exist_ok=True)
    record = {
        "status": "ok",
        "exit": 0,
        "finished_at": "2026-10-02T17:00:00Z",
        "trigger": "skillex-hermes-resync.path",
        "counts": {"total": 26, "synced": 25, "refused": 0, "error": 0, "busy": 0},
        "attention": [],
        "catalog_commit": "c" * 40,
    }
    record.update(fields)
    (box.state / "skillex/hermes-resync.last.json").write_text(json.dumps(record))


def test_status_is_healthy_only_with_live_units_and_a_good_last_run(box):
    assert box.run("install").returncode == 0
    last_run(box)
    ok = box.run("status")
    assert ok.returncode == 0, ok.stdout
    assert "healthy" in ok.stdout and "desks=26 synced=25" in ok.stdout
    assert "MOVED" in ok.stdout  # the fixture's catalog sha is not the repo's HEAD
    inactive = box.run("status", FAKE_ACTIVE="inactive")
    assert inactive.returncode == 1 and "NOT HEALTHY" in inactive.stdout


def test_status_names_the_desks_that_need_a_human(box):
    assert box.run("install").returncode == 0
    last_run(box, status="attention", exit=1, attention=["voxxy-pm"])
    done = box.run("status")
    assert done.returncode == 1
    assert "ATTENTION voxxy-pm" in done.stdout and "NOT HEALTHY" in done.stdout


def test_status_without_a_last_run_or_links_is_not_healthy(box):
    done = box.run("status")
    assert done.returncode == 1
    assert "NOT LINKED" in done.stdout and "none recorded" in done.stdout


def test_unknown_command_prints_usage(box):
    done = box.run("frobnicate")
    assert done.returncode == 2 and "install | uninstall | status" in done.stderr
