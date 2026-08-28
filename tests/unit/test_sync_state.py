"""The ownership receipt: ``skillex.core.state``.

Every invariant asserted here is one the module's own docstring claims:

* the receipt lives in XDG state and **never** beside the activation root -- the
  global root's parent (``~/.agents``) is a git repository and ~44 project roots
  exist, so a per-run JSON receipt inside each would churn every one of those
  trees forever;
* a corrupt receipt is *absent*, never "I own nothing" -- the difference decides
  whether the next run prunes links a human put there;
* the loaded set is ``pending`` UNION ``committed``, and ``write_pending`` writes a
  deliberate SUPERSET, because failing to recognize a link we created leaks it
  permanently while pruning a name that is already gone is a no-op.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from skillex.core.diagnostics import EXIT_OK, EXIT_REFUSED, Code
from skillex.core.scope import is_within
from skillex.core.state import (
    STATE_VERSION,
    ProjectionState,
    StateEntry,
    commit_state,
    forget,
    load_state,
    pending_path_for,
    state_dir,
    state_path_for,
    write_pending,
)
from tests.conftest import Sandbox, codes_in

#: ``<16 hex>.json`` / ``<16 hex>.pending.json`` -- the only two names
#: :func:`state_path_for` and :func:`pending_path_for` can produce.
RECEIPT_NAME = re.compile(r"^[0-9a-f]{16}(\.pending)?\.json$")


def receipts_under(base: Path) -> list[Path]:
    """Every receipt-shaped file under ``base``. Never follows a symlink."""
    out: list[Path] = []
    for dirpath, _dirnames, filenames in os.walk(base, followlinks=False):
        out += [Path(dirpath) / n for n in filenames if RECEIPT_NAME.match(n)]
    return sorted(out)


def read_receipt(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# where the receipt lives
# ---------------------------------------------------------------------------


def test_state_dir_honors_xdg_state_home(sandbox: Sandbox) -> None:
    assert state_dir() == sandbox.state_home / "skillex" / "projections"


def test_state_dir_falls_back_to_local_state(sandbox: Sandbox, monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("XDG_STATE_HOME", raising=False)
    assert state_dir() == sandbox.home / ".local" / "state" / "skillex" / "projections"


def test_state_dir_expands_a_tilde_in_xdg_state_home(sandbox: Sandbox, monkeypatch) -> None:
    """``~/state`` in the environment must not become a literal ``./~`` directory."""
    monkeypatch.setenv("XDG_STATE_HOME", "~/state")
    assert state_dir() == sandbox.home / "state" / "skillex" / "projections"


def test_receipt_is_written_outside_every_repo(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    """The hard requirement: nothing lands in an activation root or its repo.

    ``~/.agents`` is a git repo and a project root is someone's checkout. A receipt
    inside either is runtime state in a tracked tree -- the exact thing that can
    never be committed clean.
    """
    write_catalog(registry, "alpha", "beta")
    sandbox.write_global_manifest(skills=["alpha"])
    project = sandbox.project("repo", manifest={"skills": ["beta"], "inherit_global": False})

    code, out = run_sync(cwd=project)
    assert code == EXIT_OK, out

    global_root = sandbox.global_root
    project_root = sandbox.project_root_of(project)
    # Both roots really were written -- otherwise "no receipt inside" is vacuous.
    assert (global_root / "alpha").is_symlink()
    assert (project_root / "beta").is_symlink()

    # Exactly two receipts, both in the XDG state dir.
    assert [p.name for p in receipts_under(sandbox.state_dir)] == sorted(
        {state_path_for(global_root).name, state_path_for(project_root).name}
    )

    # And none anywhere in either repo, or in the registry.
    assert receipts_under(project) == []
    assert receipts_under(sandbox.home / ".agents") == []
    assert receipts_under(registry) == []

    # Stated as the containment rule it is, not just as "no file appeared".
    for root in (global_root, project_root):
        for repo in (project, sandbox.home / ".agents", root):
            assert not is_within(state_path_for(root), repo)
            assert not is_within(pending_path_for(root), repo)


def test_apply_leaves_no_pending_file_and_no_tmp_debris(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])

    code, out = run_sync(cwd=sandbox.home)
    assert code == EXIT_OK, out

    assert state_path_for(sandbox.global_root).is_file()
    assert not pending_path_for(sandbox.global_root).exists()
    # ``_atomic_write`` writes ``.<name>.<pid>.tmp`` then ``os.replace``.
    assert [p.name for p in sandbox.state_dir.iterdir()] == [
        state_path_for(sandbox.global_root).name
    ]


# ---------------------------------------------------------------------------
# the key
# ---------------------------------------------------------------------------


def test_two_roots_get_different_state_files(sandbox: Sandbox) -> None:
    one = sandbox.tmp / "a" / ".agents" / "skills"
    two = sandbox.tmp / "b" / ".agents" / "skills"
    assert state_path_for(one) != state_path_for(two)
    assert state_path_for(one).parent == state_path_for(two).parent == state_dir()


def test_state_path_is_stable_for_a_root_that_does_not_exist_yet(sandbox: Sandbox) -> None:
    """``os.path.realpath``, not ``Path.resolve``: the root is created *after* the
    first ``load_state`` on every fresh machine."""
    root = sandbox.tmp / "later" / ".agents" / "skills"
    assert not root.exists()
    before = state_path_for(root)
    assert state_path_for(root) == before  # stable across calls

    root.mkdir(parents=True)
    assert state_path_for(root) == before  # and across the root coming into being


def test_pending_and_committed_share_one_key(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "r" / ".agents" / "skills"
    assert pending_path_for(root).name == f"{state_path_for(root).stem}.pending.json"


# ---------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------


def test_load_state_on_a_missing_file_is_absent_and_raises_nothing(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "nope" / ".agents" / "skills"
    state = load_state(root)
    assert state.absent is True
    assert state.entries == {}
    assert state.owns("anything") is False
    assert state.root == root


def test_load_state_on_corrupt_json_is_absent_not_empty(sandbox: Sandbox) -> None:
    """A corrupt receipt must be indistinguishable from a missing one.

    ``absent=True`` is what makes ``diff`` fall back to containment and refuse a
    populated root. An *empty but valid* receipt (``absent=False``) says "I own
    nothing", which is a licence to prune.
    """
    root = sandbox.tmp / "corrupt" / ".agents" / "skills"
    state_dir().mkdir(parents=True, exist_ok=True)
    state_path_for(root).write_text("{not json at all", encoding="utf-8")

    state = load_state(root)
    assert state.absent is True
    assert state.entries == {}

    # Same for a well-formed JSON document of the wrong shape.
    state_path_for(root).write_text("[1, 2, 3]", encoding="utf-8")
    assert load_state(root).absent is True

    # ...and for a receipt that is not readable as text at all.
    state_path_for(root).write_bytes(b"\xff\xfe\x00\x01")
    assert load_state(root).absent is True


def test_corrupt_receipt_does_not_let_the_next_run_prune_real_content(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_skill,
    run_sync_json,
) -> None:
    """The consequence of the invariant above, end to end.

    The root holds something skillex could not have written. With the receipt
    corrupt, sync must refuse (``E_UNMANAGED_ROOT``) rather than read "I own
    nothing" and prune.
    """
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])

    root = sandbox.global_root
    root.mkdir(parents=True)
    write_skill(root, "handmade")  # a real directory a human put there
    outside = sandbox.tmp / "elsewhere"
    write_skill(outside, "foreign")
    os.symlink(outside / "foreign", root / "foreign")  # a link outside every managed root

    state_dir().mkdir(parents=True, exist_ok=True)
    state_path_for(root).write_text("{ truncated", encoding="utf-8")

    code, payload = run_sync_json(cwd=sandbox.home)

    assert code == EXIT_REFUSED
    assert Code.E_UNMANAGED_ROOT.value in codes_in(payload)
    # Nothing was touched: both entries survive, and nothing new was added.
    assert (root / "handmade" / "SKILL.md").is_file()
    assert os.readlink(root / "foreign") == str(outside / "foreign")
    assert not (root / "alpha").exists()


def test_pending_is_unioned_with_committed(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "u" / ".agents" / "skills"
    committed = ProjectionState(root=root, entries={"from-committed": StateEntry("t1")})
    commit_state(committed)
    # An interrupted later run: pending written, never committed.
    write_pending(ProjectionState(root=root), {"from-pending"})

    state = load_state(root)
    assert state.absent is False
    assert state.owns("from-committed")
    assert state.owns("from-pending")
    assert set(state.entries) == {"from-committed", "from-pending"}


def test_pending_alone_is_enough_to_claim_ownership(sandbox: Sandbox) -> None:
    """A crash before the first commit still leaves a claim; that is the point of
    the write-ahead file."""
    root = sandbox.tmp / "p" / ".agents" / "skills"
    write_pending(ProjectionState(root=root), {"half-written"})
    assert not state_path_for(root).exists()

    state = load_state(root)
    assert state.absent is False
    assert state.owns("half-written")


def test_committed_scalars_survive_a_pending_union(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "s" / ".agents" / "skills"
    committed = ProjectionState(
        root=root,
        scope="global",
        registry_roots=[str(sandbox.registry)],
        entries={"a": StateEntry("t", origin="sets[0]", stage="staged")},
    )
    commit_state(committed)
    write_pending(ProjectionState(root=root), {"b"})

    state = load_state(root)
    assert state.scope == "global"
    assert state.mode == "composed"
    assert state.registry_roots == [str(sandbox.registry)]
    assert state.generator is not None
    assert state.written_at is not None
    assert state.entries["a"] == StateEntry("t", origin="sets[0]", stage="staged")


def test_a_legacy_receipt_with_bare_string_entries_still_loads(sandbox: Sandbox) -> None:
    """An older shape wrote ``{"entries": {"name": "<target>"}}``. Rejecting it would
    turn every pre-upgrade root into an unowned one."""
    root = sandbox.tmp / "old" / ".agents" / "skills"
    state_dir().mkdir(parents=True, exist_ok=True)
    state_path_for(root).write_text(
        json.dumps({"version": 1, "root": str(root), "entries": {"hindsight": "/reg/hindsight"}}),
        encoding="utf-8",
    )

    state = load_state(root)
    assert state.absent is False
    assert state.owns("hindsight")
    assert state.entries["hindsight"] == StateEntry(target="/reg/hindsight")


def test_a_receipt_with_junk_entries_is_tolerated(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "junk" / ".agents" / "skills"
    state_dir().mkdir(parents=True, exist_ok=True)
    state_path_for(root).write_text(
        json.dumps({"entries": ["not", "a", "mapping"], "manifests": "nope"}),
        encoding="utf-8",
    )
    state = load_state(root)
    assert state.absent is False
    assert state.entries == {}
    assert state.manifests == []


# ---------------------------------------------------------------------------
# writing
# ---------------------------------------------------------------------------


def test_write_pending_writes_the_superset_of_desired_and_prior(sandbox: Sandbox) -> None:
    """``apply`` calls ``write_pending(state, desired | prior)``; this pins that the
    file really carries both halves."""
    root = sandbox.tmp / "w" / ".agents" / "skills"
    prior = ProjectionState(root=root, entries={"prior": StateEntry("t-prior")})
    desired = {"new-one", "another"}

    write_pending(prior, desired | set(prior.entries))

    payload = read_receipt(pending_path_for(root))
    assert set(payload["entries"]) == {"prior", "new-one", "another"}
    # The prior entry keeps its recorded target; a brand-new name has none yet.
    assert payload["entries"]["prior"]["target"] == "t-prior"
    assert payload["entries"]["new-one"]["target"] == ""
    assert payload["version"] == STATE_VERSION
    assert payload["root"] == str(root)


def test_write_pending_does_not_mutate_the_in_memory_state(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "w2" / ".agents" / "skills"
    state = ProjectionState(root=root, entries={"prior": StateEntry("t")})
    write_pending(state, {"prior", "extra"})
    assert set(state.entries) == {"prior"}


def test_commit_state_replaces_and_unlinks_the_pending_file(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "c" / ".agents" / "skills"
    first = ProjectionState(root=root, entries={"gone": StateEntry("t-gone")})
    commit_state(first)
    write_pending(first, {"gone", "in-flight"})
    assert pending_path_for(root).exists()

    second = ProjectionState(root=root, entries={"kept": StateEntry("t-kept")})
    commit_state(second)

    assert not pending_path_for(root).exists()
    payload = read_receipt(state_path_for(root))
    assert set(payload["entries"]) == {"kept"}  # replaced, not merged

    # And the union on the next load is now just the committed set.
    assert set(load_state(root).entries) == {"kept"}


def test_commit_state_stamps_the_generator_and_a_utc_timestamp(sandbox: Sandbox) -> None:
    from skillex import __version__

    root = sandbox.tmp / "g" / ".agents" / "skills"
    state = ProjectionState(root=root)
    commit_state(state)
    assert state.generator == f"skillex {__version__}"
    payload = read_receipt(state_path_for(root))
    assert payload["generator"] == f"skillex {__version__}"
    assert str(payload["written_at"]).endswith("+00:00")


def test_commit_state_creates_the_state_directory(sandbox: Sandbox) -> None:
    assert not state_dir().exists()
    commit_state(ProjectionState(root=sandbox.tmp / "mk" / ".agents" / "skills"))
    assert state_dir().is_dir()


def test_entries_are_serialized_sorted(sandbox: Sandbox) -> None:
    """Sorted so a receipt diffs cleanly when someone does look at one."""
    root = sandbox.tmp / "sorted" / ".agents" / "skills"
    commit_state(
        ProjectionState(root=root, entries={n: StateEntry(n) for n in ("zeta", "alpha", "mid")})
    )
    assert list(read_receipt(state_path_for(root))["entries"]) == ["alpha", "mid", "zeta"]


# ---------------------------------------------------------------------------
# forget
# ---------------------------------------------------------------------------


def test_forget_removes_both_receipts(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "f" / ".agents" / "skills"
    state = ProjectionState(root=root, entries={"a": StateEntry("t")})
    commit_state(state)
    write_pending(state, {"a", "b"})
    assert state_path_for(root).exists()
    assert pending_path_for(root).exists()

    assert forget(root) is True
    assert not state_path_for(root).exists()
    assert not pending_path_for(root).exists()
    assert load_state(root).absent is True


def test_forget_returns_false_when_there_was_nothing(sandbox: Sandbox) -> None:
    assert forget(sandbox.tmp / "never" / ".agents" / "skills") is False


def test_forget_returns_true_for_a_pending_file_alone(sandbox: Sandbox) -> None:
    root = sandbox.tmp / "fp" / ".agents" / "skills"
    write_pending(ProjectionState(root=root), {"a"})
    assert forget(root) is True


def test_sync_forget_removes_the_receipt_and_leaves_the_links(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
    snapshot,
) -> None:
    """``--forget`` drops ownership; it is not an uninstall."""
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    assert run_sync(cwd=sandbox.home)[0] == EXIT_OK
    assert state_path_for(sandbox.global_root).is_file()

    before = snapshot(sandbox.global_root)
    code, out = run_sync("--forget", cwd=sandbox.home)

    assert code == EXIT_OK, out
    assert not state_path_for(sandbox.global_root).exists()
    assert snapshot(sandbox.global_root) == before
