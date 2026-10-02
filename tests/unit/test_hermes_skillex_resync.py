"""Unattended Skillex-only desk resync: a stub skillex and a scratch Hermes root; no live host writes."""

import fcntl
import importlib.util
import itertools
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts/hermes-skillex-resync.py"

# Scripted per-desk behaviour. The resync hands its child an allowlisted environment, so the
# stub finds its script, its call log and its version file next to itself, not in env vars.
STUB = r"""#!@PYTHON@
import json
import os
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a") as handle:
    handle.write(
        json.dumps(
            {
                "argv": argv,
                "registry": os.environ.get("PJ_SKILLS_REGISTRY_ROOT"),
                "token_leaked": "OP_SERVICE_ACCOUNT_TOKEN" in os.environ,
            }
        )
        + "\n"
    )
if argv == ["--version"]:
    version = os.path.join(here, "stub-version")
    print(open(version).read().strip() if os.path.exists(version) else "0.1.3")
    sys.exit(0)

path = os.path.join(here, "stub-state.json")
state = json.load(open(path))
desks = state["desks"]


def save():
    json.dump(state, open(path, "w"))


def option(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None


def emit(code, data=None, findings=()):
    envelope = {
        "schema": 2,
        "command": "profile " + argv[1],
        "ok": code == 0,
        "exit": code,
        "data": data,
        "findings": list(findings),
    }
    print(json.dumps(envelope))
    sys.exit(code)


def finding(code, message, where=None):
    return {"code": code, "severity": "error", "message": message, "path": where}


verb = argv[1]
if verb == "list":
    if state.get("list") == "garbage":
        print("not json at all")
        sys.exit(1)
    rows = [{"profile": {"name": n}, "project": d.get("project")} for n, d in desks.items()]
    # the real `list` exits 3 when any profile is invalid, and still returns the data
    emit(3, {"hermesRoot": {}, "profiles": rows}, [finding("E_PROFILE_SKILLS_ROOT", "alias")])

name = argv[2]
desk = desks[name]
desk["shows"] = desk.get("shows", 0) + (verb == "show")
save()
mode = desk["mode"]
project = option("--project") or desk.get("project")
shown = {
    "profile": {"name": name},
    "project": project,
    "managed": [],
    "preserved": [],
    "pending": False,
    "changes": [],
}
if verb == "show":
    if mode == "hang":
        time.sleep(60)
    if mode == "crash":
        print("Segmentation noodle")
        sys.exit(1)
    if mode == "flaky" and desk["shows"] == 1:
        emit(3, shown, [finding("E_PROFILE_CHANGED", "another writer is active")])
    if mode == "foreign":
        stray = finding("E_PROFILE_SKILLEX_ONLY", "Skillex-only profile contains unowned entry x.")
        emit(3, shown, [stray])
    if mode in ("pending", "stuck", "sync-fails", "sync-refused", "sync-busy"):
        shown["changes"] = [{"action": "write-receipt", "path": "/receipt.json"}]
        emit(6, shown)
    emit(0, shown)

assert verb == "sync" and "--skillex-only" in argv, "the resync must always ask for strict sync"
if mode == "pending":
    desk["mode"] = "ok"
    save()
    emit(0, shown)
if mode == "stuck":
    emit(0, shown)
if mode == "sync-refused":
    emit(3, shown, [finding("E_PROFILE_CONTENT_CHANGED", "a local entry appeared")])
if mode == "sync-busy":
    emit(5, shown, [finding("E_LOCK_BUSY", "locked")])
emit(1, shown, [finding("E_IO", "disk said no")])
"""


def load():
    spec = importlib.util.spec_from_file_location("hermes_skillex_resync", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def script(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return path


class Fleet:
    """A scratch Hermes root whose `skillex` is the scripted stub above."""

    def __init__(self, root):
        self.root = root
        self.home = root / "home"
        self.hermes = root / "hermes"
        self.registry = root / "registry"
        self.state_dir = root / "state"
        self.stub = root / "skillex-stub"
        self.state_file = root / "stub-state.json"
        self.calls_file = root / "calls.jsonl"
        (self.hermes / "profiles").mkdir(parents=True)
        (self.registry / "all-skills").mkdir(parents=True)
        self.home.mkdir()
        self.stub.write_text(STUB.replace("@PYTHON@", sys.executable))
        self.stub.chmod(0o755)
        self.state = {"desks": {}}
        self.save()

    def save(self):
        self.state_file.write_text(json.dumps(self.state))

    def desk(self, name, mode="ok", marker=True):
        """A profile directory; marker: True regular file, False none, "symlink", "dir"."""
        directory = self.hermes / "profiles" / name
        directory.mkdir()
        target = directory / ".skillex-only"
        if marker is True:
            target.write_text("strict\n")
        elif marker == "symlink":
            (directory / "real-marker").write_text("strict\n")
            target.symlink_to("real-marker")
        elif marker == "dir":
            target.mkdir()
        self.state["desks"][name] = {"mode": mode, "project": f"/proj/{name}"}
        self.save()
        return directory

    def env(self, **override):
        env = {
            "HOME": str(self.home),
            "PATH": "/usr/bin:/bin",
            "SKILLEX_BIN": str(self.stub),
            "OP_SERVICE_ACCOUNT_TOKEN": "not-a-real-token",
        }
        env.update(override)
        return {key: value for key, value in env.items() if value is not None}

    def args(self, *extra):
        return [
            "--hermes-root",
            str(self.hermes),
            "--registry-root",
            str(self.registry),
            "--state-dir",
            str(self.state_dir),
            "--retry-delay",
            "0",
            *extra,
        ]

    def run(self, *extra, **override):
        command = [sys.executable, "-B", str(SCRIPT), *self.args(*extra)]
        return subprocess.run(
            command, env=self.env(**override), capture_output=True, text=True, timeout=60
        )

    def calls(self):
        if not self.calls_file.exists():
            return []
        return [json.loads(line) for line in self.calls_file.read_text().splitlines()]

    def verbs(self):
        """[(verb, desk-or-None)] for every skillex call that was not --version."""
        rows = []
        for call in self.calls():
            argv = call["argv"]
            if argv != ["--version"]:
                rows.append((argv[1], argv[2] if argv[1] != "list" else None))
        return rows

    def mode(self, name):
        return json.loads(self.state_file.read_text())["desks"][name]["mode"]

    def log(self):
        path = self.state_dir / "hermes-resync.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def last(self):
        return json.loads((self.state_dir / "hermes-resync.last.json").read_text())

    def tree(self):
        """Everything on disk except the stub's own bookkeeping."""
        skip = {self.state_file, self.calls_file}
        return {
            str(path): (path.stat().st_size, path.stat().st_mtime_ns)
            for path in sorted(self.root.rglob("*"))
            if path not in skip and not path.is_dir()
        }


@pytest.fixture
def fleet(tmp_path):
    return Fleet(tmp_path)


def test_nothing_pending_is_a_noop(fleet):
    fleet.desk("alpha-pm")
    fleet.desk("beta-pm")
    done = fleet.run()
    assert done.returncode == 0, done.stderr
    assert done.stdout.count("\n") == 1 and "2 current" in done.stdout
    assert fleet.verbs() == [
        ("list", None),
        ("show", "alpha-pm"),
        ("show", "beta-pm"),
    ]
    last = fleet.last()
    assert (last["status"], last["exit"], last["counts"]["ok"]) == ("ok", 0, 2)
    # a current desk is evidence in last.json, not a line in the growing log
    assert [row["event"] for row in fleet.log()] == ["run"]


def test_pending_desk_is_synced_then_verified_and_nothing_else_is_touched(fleet):
    fleet.desk("alpha-pm", "pending")
    fleet.desk("beta-pm")
    done = fleet.run()
    assert done.returncode == 0, done.stderr
    assert fleet.verbs() == [
        ("list", None),
        ("show", "alpha-pm"),
        ("sync", "alpha-pm"),
        ("show", "alpha-pm"),
        ("show", "beta-pm"),
    ]
    sync = next(c["argv"] for c in fleet.calls() if c["argv"][1:2] == ["sync"])
    assert sync[:5] == ["profile", "sync", "alpha-pm", "--project", "/proj/alpha-pm"]
    assert "--skillex-only" in sync and "--json" in sync and "--dry-run" not in sync
    assert fleet.mode("alpha-pm") == "ok"
    rows = fleet.log()
    assert [(r["event"], r.get("desk"), r["status"]) for r in rows] == [
        ("desk", "alpha-pm", "synced"),
        ("run", None, "ok"),
    ]
    assert (rows[0]["show_exit"], rows[0]["sync_exit"], rows[0]["verify_exit"]) == (6, 0, 0)
    assert rows[0]["run_id"] == rows[1]["run_id"] and rows[0]["ts"] == rows[1]["finished_at"]
    assert rows[0]["changes"] == {"write-receipt": 1}
    assert fleet.last()["counts"] == {
        "ok": 1,
        "synced": 1,
        "would_sync": 0,
        "refused": 0,
        "error": 0,
        "busy": 0,
        "total": 2,
    }


def test_the_child_sees_the_pinned_registry_and_no_credentials(fleet):
    fleet.desk("alpha-pm", "pending")
    assert fleet.run().returncode == 0
    for call in fleet.calls():
        assert call["registry"] == str(fleet.registry)
        assert not call["token_leaked"]
    for call in fleet.calls():
        argv = call["argv"]
        if argv != ["--version"]:
            assert argv[argv.index("--hermes-root") + 1] == str(fleet.hermes)
            assert argv[argv.index("--registry-root") + 1] == str(fleet.registry)
            assert argv[-1] == "--json"


def test_foreign_content_is_never_touched_and_the_other_desks_proceed(fleet):
    fleet.desk("alpha-pm", "foreign")
    fleet.desk("beta-pm", "pending")
    fleet.desk("gamma-pm")
    done = fleet.run()
    assert done.returncode == 1
    assert ("sync", "alpha-pm") not in fleet.verbs()
    assert fleet.mode("beta-pm") == "ok"  # synced after alpha was refused
    assert "ATTENTION alpha-pm: refused" in done.stderr
    assert "unowned entry" in done.stderr
    assert "1 refused" in done.stderr
    rows = fleet.log()
    refused = next(r for r in rows if r.get("desk") == "alpha-pm")
    assert refused["status"] == "refused" and refused["show_exit"] == 3
    assert refused["findings"][0]["code"] == "E_PROFILE_SKILLEX_ONLY"
    assert rows[-1]["status"] == "attention" and rows[-1]["attention"] == ["alpha-pm"]
    assert rows[-1]["exit"] == 1
    # the same findings reach last.json, where an audit reads them
    assert fleet.last()["results"][0]["desk"] == "alpha-pm"


def test_a_desk_without_a_regular_marker_is_skipped_without_a_single_call(fleet):
    fleet.desk("alpha-pm")
    fleet.desk("legacy-pm", "pending", marker=False)
    fleet.desk("midcutover-pm", "pending", marker=False)
    fleet.desk("linked-pm", "pending", marker="symlink")
    fleet.desk("odd-pm", "pending", marker="dir")
    (fleet.hermes / "profiles" / ".alpha-pm.config.lock").write_text("")
    done = fleet.run()
    assert done.returncode == 0, done.stderr
    assert {name for _, name in fleet.verbs() if name} == {"alpha-pm"}
    skipped = {row["desk"]: row["reason"] for row in fleet.last()["skipped"]}
    assert set(skipped) == {"legacy-pm", "midcutover-pm", "linked-pm", "odd-pm"}
    assert "regular file" in skipped["linked-pm"] and "regular file" in skipped["odd-pm"]
    assert fleet.mode("legacy-pm") == fleet.mode("linked-pm") == "pending"


def test_a_peer_holding_the_lock_makes_the_run_a_polite_noop(fleet):
    fleet.desk("alpha-pm", "pending")
    lock = fleet.hermes / ".skillex-resync.lock"
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    try:
        done = fleet.run()
    finally:
        os.close(descriptor)
    assert done.returncode == 0, done.stderr
    assert "busy" in done.stdout
    assert fleet.calls() == []
    assert [(r["event"], r["status"]) for r in fleet.log()] == [("run", "busy")]
    assert not (fleet.state_dir / "hermes-resync.last.json").exists()  # the peer's stands
    assert fleet.mode("alpha-pm") == "pending"
    # and once the peer lets go, the same run works
    assert fleet.run().returncode == 0
    assert fleet.mode("alpha-pm") == "ok"


def test_dry_run_reports_and_writes_nothing(fleet):
    fleet.desk("alpha-pm", "pending")
    fleet.desk("beta-pm")
    before = fleet.tree()
    done = fleet.run("--dry-run")
    assert done.returncode == 0, done.stderr
    assert "DRY RUN" in done.stdout and "1 would sync" in done.stdout
    assert [verb for verb, _ in fleet.verbs()] == ["list", "show", "show"]
    assert fleet.mode("alpha-pm") == "pending"
    assert fleet.tree() == before  # no log, no last-run file, no lock, no desk change
    assert not fleet.state_dir.exists()
    assert not (fleet.hermes / ".skillex-resync.lock").exists()


def test_a_missing_skillex_is_reported_clearly_and_nothing_is_touched(fleet):
    fleet.desk("alpha-pm", "pending")
    done = fleet.run(SKILLEX_BIN=None, PATH=str(fleet.root / "no-such-bin"))
    assert done.returncode == 2
    for needle in ("ERROR", "no usable skillex CLI", "SKILLEX_BIN", "mise"):
        assert needle in done.stderr
    assert fleet.calls() == [] and fleet.mode("alpha-pm") == "pending"
    row = fleet.last()
    assert (row["status"], row["exit"]) == ("error", 2)
    assert "no usable skillex CLI" in row["message"]
    assert fleet.log()[-1]["status"] == "error"


def test_an_explicit_but_unusable_skillex_is_not_second_guessed(fleet):
    fleet.desk("alpha-pm", "pending")
    gone = fleet.run(SKILLEX_BIN=str(fleet.root / "nope"))
    assert gone.returncode == 2 and "is not an executable file" in gone.stderr
    (fleet.root / "stub-version").write_text("0.1.2\n")
    old = fleet.run()
    assert old.returncode == 2 and "needs skillex 0.1.3 or newer" in old.stderr
    assert fleet.mode("alpha-pm") == "pending"
    assert ("sync", "alpha-pm") not in fleet.verbs()


def test_one_desks_crash_or_hang_does_not_stop_the_others(fleet):
    fleet.desk("a-pm", "crash")
    fleet.desk("b-pm", "hang")
    fleet.desk("c-pm", "pending")
    done = fleet.run("--timeout", "1")
    assert done.returncode == 1
    results = {row["desk"]: row for row in fleet.last()["results"]}
    assert results["a-pm"]["status"] == "error" and "non-json" in results["a-pm"]["reason"]
    assert results["b-pm"]["status"] == "error" and "timeout" in results["b-pm"]["reason"]
    assert results["c-pm"]["status"] == "synced"
    assert fleet.mode("c-pm") == "ok"
    assert ("sync", "a-pm") not in fleet.verbs() and ("sync", "b-pm") not in fleet.verbs()


def test_a_sync_that_does_not_converge_is_an_error_not_a_success(fleet):
    fleet.desk("alpha-pm", "stuck")
    done = fleet.run()
    assert done.returncode == 1
    row = fleet.last()["results"][0]
    assert row["status"] == "error" and "not converged after sync" in row["reason"]
    assert (row["show_exit"], row["sync_exit"], row["verify_exit"]) == (6, 0, 6)


def test_sync_refusal_failure_and_busy_are_told_apart(fleet):
    fleet.desk("a-pm", "sync-refused")
    fleet.desk("b-pm", "sync-fails")
    fleet.desk("c-pm", "sync-busy")
    done = fleet.run()
    assert done.returncode == 1
    results = {row["desk"]: row for row in fleet.last()["results"]}
    assert results["a-pm"]["status"] == "refused"
    assert results["b-pm"]["status"] == "error" and "disk said no" in results["b-pm"]["reason"]
    assert results["c-pm"]["status"] == "busy"
    assert fleet.last()["attention"] == ["a-pm", "b-pm"]  # busy is a retry, not an alarm


def test_busy_alone_is_a_partial_run_and_not_a_failure(fleet):
    fleet.desk("c-pm", "sync-busy")
    done = fleet.run()
    assert done.returncode == 0
    assert (fleet.last()["status"], fleet.last()["counts"]["busy"]) == ("partial", 1)


def test_a_transient_refusal_is_asked_again_before_it_is_recorded(fleet):
    fleet.desk("alpha-pm", "flaky")
    done = fleet.run()
    assert done.returncode == 0, done.stderr
    assert fleet.last()["results"][0]["status"] == "ok"
    assert [v for v, _ in fleet.verbs()] == ["list", "show", "show"]


def test_unreadable_listing_falls_back_to_the_recorded_project_per_desk(fleet):
    fleet.desk("alpha-pm", "pending")
    fleet.state["list"] = "garbage"
    fleet.save()
    done = fleet.run()
    assert done.returncode == 0, done.stderr
    shows = [c["argv"] for c in fleet.calls() if c["argv"][1:2] == ["show"]]
    assert "--project" not in shows[0]  # discovery asks Skillex for the recorded project
    assert shows[1][shows[1].index("--project") + 1] == "/proj/alpha-pm"
    assert fleet.mode("alpha-pm") == "ok"


def test_desk_with_no_recorded_project_is_left_alone_and_reported(fleet):
    fleet.desk("alpha-pm", "pending")
    fleet.state["desks"]["alpha-pm"]["project"] = None
    fleet.save()
    done = fleet.run()
    assert done.returncode == 1
    assert "no recorded project" in done.stderr
    assert ("sync", "alpha-pm") not in fleet.verbs()


def test_profile_flag_limits_the_run_and_refuses_a_desk_that_is_not_strict(fleet):
    fleet.desk("a-pm", "pending")
    fleet.desk("b-pm", "pending")
    fleet.desk("legacy-pm", "pending", marker=False)
    assert fleet.run("--profile", "b-pm").returncode == 0
    assert {name for _, name in fleet.verbs() if name} == {"b-pm"}
    assert (fleet.mode("a-pm"), fleet.mode("b-pm")) == ("pending", "ok")
    refused = fleet.run("--profile", "legacy-pm")
    assert refused.returncode == 1 and "not a strict desk" in refused.stderr
    assert fleet.mode("legacy-pm") == "pending"


def test_json_mode_prints_the_whole_run_record_as_one_line(fleet):
    fleet.desk("alpha-pm", "pending")
    done = fleet.run("--json", INVOCATION_ID="0123abcd")
    assert done.returncode == 0
    record = json.loads(done.stdout)
    assert done.stdout.count("\n") == 1
    assert record["schema"] == 1 and record["event"] == "run" and record["status"] == "ok"
    assert record["trigger"] == "systemd"  # an INVOCATION_ID means systemd started it
    assert record["skillex"] == {"bin": str(fleet.stub), "version": "0.1.3"}
    assert record["results"][0]["status"] == "synced"
    assert json.loads(fleet.run("--json").stdout)["trigger"] == "manual"


def test_the_run_records_where_the_catalog_was_and_when_it_moved(fleet):
    git = ["git", "-C", str(fleet.registry / "all-skills"), "-c", "core.hooksPath=/dev/null"]
    ident = ["-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run([*git, "init", "-q"], check=True, capture_output=True)
    for number in (1, 2):
        subprocess.run(
            [*git, *ident, "commit", "-q", "--allow-empty", "-m", f"c{number}"],
            check=True,
            capture_output=True,
        )
        if number == 1:
            fleet.desk("alpha-pm")
            assert fleet.run().returncode == 0
    first = fleet.last()
    assert first["previous_catalog_commit"] is None
    second = fleet.run("--json")
    record = json.loads(second.stdout)
    assert record["previous_catalog_commit"] == first["catalog_commit"]
    assert record["catalog_commit"] != record["previous_catalog_commit"]
    assert record["catalog_moved_at"] >= record["started_at"][:10]  # an ISO UTC stamp
    assert record["catalog_moved_at"].endswith("Z")


def test_catalog_that_moves_mid_run_gets_another_pass(fleet, monkeypatch, capsys):
    module = load()
    fleet.desk("alpha-pm", "pending")
    heads = iter(["a" * 40, "b" * 40, "b" * 40, "b" * 40])
    monkeypatch.setattr(module, "catalog_head", lambda *_: next(heads))
    code = module.main(fleet.args("--json"), environ=fleet.env())
    record = json.loads(capsys.readouterr().out)
    assert code == 0
    assert (record["passes"], record["settled"], record["catalog_commit"]) == (2, True, "b" * 40)
    # synced on pass 1, found converged on pass 2: the evidence still says it was synced
    assert record["results"][0]["status"] == "synced"


def test_a_catalog_that_never_settles_stops_at_the_pass_cap(fleet, monkeypatch, capsys):
    module = load()
    fleet.desk("alpha-pm")
    ticks = itertools.count()
    monkeypatch.setattr(module, "catalog_head", lambda *_: f"{next(ticks):040x}")
    code = module.main(fleet.args("--json", "--max-passes", "3"), environ=fleet.env())
    record = json.loads(capsys.readouterr().out)
    assert code == 0 and (record["passes"], record["settled"]) == (3, False)


def test_a_real_catalog_commit_is_recorded(fleet):
    git = ["git", "-C", str(fleet.registry / "all-skills"), "-c", "core.hooksPath=/dev/null"]
    for command in (
        ["init", "-q"],
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c"],
    ):
        subprocess.run([*git, *command], check=True, capture_output=True)
    head = subprocess.run(
        [*git, "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    fleet.desk("alpha-pm")
    assert fleet.run().returncode == 0
    assert fleet.last()["catalog_commit"] == head


def test_log_rotates_instead_of_growing_forever(tmp_path, monkeypatch):
    module = load()
    monkeypatch.setattr(module, "LOG_ROTATE_BYTES", 10)
    log = tmp_path / "hermes-resync.jsonl"
    log.write_text("x" * 50)
    module.append_log(log, [{"event": "run"}])
    assert (tmp_path / "hermes-resync.jsonl.1").read_text() == "x" * 50
    assert json.loads(log.read_text()) == {"event": "run"}


def test_skillex_is_found_through_the_mise_shim_on_a_bare_path(tmp_path):
    module = load()
    home, bare = tmp_path / "home", str(tmp_path / "bare")  # a PATH with no mise on it
    script(home / ".local/share/mise/shims/skillex", 'echo "0.1.3"')
    argv0, env, version = module.resolve_skillex({"HOME": str(home), "PATH": bare}, tmp_path)
    assert argv0 == str(home / ".local/share/mise/shims/skillex") and version == "0.1.3"
    assert env["PJ_SKILLS_REGISTRY_ROOT"] == str(tmp_path) and env["PATH"] == bare


def test_an_old_skillex_on_the_path_is_skipped_for_the_one_mise_names(tmp_path):
    module = load()
    home = tmp_path / "home"
    script(tmp_path / "bin/skillex", 'echo "0.1.1"')  # the retired Python build
    real = script(tmp_path / "real/skillex", 'echo "0.1.3"')
    script(home / ".local/bin/mise", f'[ "$1 $2" = "which skillex" ] && echo {real}')
    environ = {"HOME": str(home), "PATH": str(tmp_path / "bin")}
    argv0, _, version = module.resolve_skillex(environ, tmp_path)
    assert (argv0, version) == (str(real), "0.1.3")


def test_a_real_binary_that_meets_node_20_is_given_a_newer_node(tmp_path):
    module = load()
    node, bare = tmp_path / "mise/installs/node/24.1.0/bin", str(tmp_path / "bare")
    node.mkdir(parents=True)
    (node / "node").write_text("")
    body = (
        'case "$PATH" in "' + str(node) + '":*) echo "0.1.3";; '
        '*) echo "E_NODE_VERSION: Node 24 or newer is required; running 20.19.4." >&2; exit 1;; esac'
    )
    stub = script(tmp_path / "bin/skillex", body)
    environ = {
        "HOME": str(tmp_path / "home"),
        "PATH": bare,
        "SKILLEX_BIN": str(stub),
        "MISE_DATA_DIR": str(tmp_path / "mise"),
    }
    _, env, version = module.resolve_skillex(environ, tmp_path)
    assert env["PATH"] == f"{node}:{bare}" and version == "0.1.3"


def test_a_bare_environment_is_enough(fleet):
    """The units run with no shell setup: HOME and a system PATH only."""
    fleet.desk("alpha-pm", "pending")
    done = fleet.run()
    assert done.returncode == 0, done.stderr
    assert fleet.mode("alpha-pm") == "ok"


def test_the_deadline_marks_unreached_desks_instead_of_hiding_them(fleet):
    fleet.desk("a-pm")
    fleet.desk("b-pm")
    done = fleet.run("--deadline", "0")
    assert done.returncode == 1
    reasons = [row["reason"] for row in fleet.last()["results"]]
    assert reasons and all("deadline" in reason for reason in reasons)
