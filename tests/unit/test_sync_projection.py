"""The reconciler and every destructive-safety property of ``skillex sync``.

This module tests :mod:`skillex.core.projection` -- the only writer -- through the
CLI wherever the question is "what ends up on disk", and directly wherever the
question is "what does this function refuse". The bias throughout is to assert the
FILESYSTEM (``lstat``, ``readlink``, byte-for-byte trees) rather than the plan: a
plan that says ``keep`` proves nothing if ``apply`` writes behind its back.

Four properties are load-bearing enough to state up front, because several tests
below exist only to pin them:

* **Adds precede removes.** An interrupted run leaves a SUPERSET, never a hole.
  A superset is a few extra skills; a hole is eight CLI aliases resolving to an
  empty directory.
* **Nothing is ever deleted to make room.** A real directory, a regular file, a
  live foreign symlink and a name that was ours but became a directory are all
  reported and left exactly as they were found.
* **The receipt is load-bearing.** Containment cannot answer "did I write this?"
  for a link into ``~/code/33GOD``; the receipt can, and deleting it demonstrably
  changes the outcome.
* **The registry is a source.** No run writes a byte inside ``all-skills/``,
  ``sets/`` or ``packs/``, and a root inside one is refused.
"""

from __future__ import annotations

import errno
import json
import os
import shutil
import stat
from collections.abc import Iterable
from pathlib import Path

import pytest

from skillex.core.diagnostics import Code, RefusalError
from skillex.core.projection import TMP_PREFIX, managed_roots, preflight
from skillex.core.state import ProjectionState, state_path_for, write_pending
from skillex.paths import default_lock_path
from tests.conftest import (
    Sandbox,
    codes_in,
    run_sync,
    run_sync_json,
    snapshot,
    write_catalog,
    write_members,
    write_set,
    write_skill,
)

# ---------------------------------------------------------------------------
# sandbox guard - every sync in this module goes through it
# ---------------------------------------------------------------------------

_ACTIVE: list[Sandbox] = []


@pytest.fixture(autouse=True)
def _guarded_sandbox(sandbox: Sandbox):
    """Publish the active sandbox to :func:`sync`, for the whole test.

    Autouse and mandatory. Several tests here monkeypatch ``os.unlink`` and
    ``os.rename``, and an over-broad revert (``monkeypatch.undo()`` reverts the
    ``HOME`` / ``XDG_STATE_HOME`` / ``PJ_SKILLS_REGISTRY_ROOT`` setenvs too, since
    ``sandbox`` shares that fixture instance) would point the very next ``sync`` at
    the author's real ``~/.agents/skills``. :func:`sync` asserts the sandbox is
    still in force before every invocation, so that mistake fails a test instead of
    reconciling a live root.
    """
    _ACTIVE.append(sandbox)
    try:
        yield sandbox
    finally:
        _ACTIVE.pop()


def _assert_sandboxed() -> Sandbox:
    box = _ACTIVE[-1]
    assert Path.home() == box.home, f"HOME escaped the sandbox: {Path.home()}"
    assert os.environ.get("XDG_STATE_HOME") == str(box.state_home)
    assert os.environ.get("PJ_SKILLS_REGISTRY_ROOT") == str(box.registry)
    return box


def sync(*args: str, cwd: Path) -> tuple[int, str]:
    """``skillex sync``, refusing to run outside the sandbox."""
    _assert_sandboxed()
    return run_sync(*args, cwd=cwd)


def sync_json(*args: str, cwd: Path) -> tuple[int, dict]:
    """``skillex sync --json``, refusing to run outside the sandbox."""
    _assert_sandboxed()
    return run_sync_json(*args, cwd=cwd)


# ---------------------------------------------------------------------------
# local helpers - shapes and assertions unique to this module
# ---------------------------------------------------------------------------


def fingerprint(root: Path) -> dict[str, tuple[object, ...]]:
    """Everything under ``root``, identified strongly enough to prove "unchanged".

    ``tests.conftest.snapshot`` records ``(is_symlink, readlink | inode)``, which is
    the right tool for "did this link get rewritten". This is the stronger one used
    where the claim is *byte-identical*: inode AND ``st_mtime_ns`` AND, for regular
    files, the content itself. Symlinks are never followed.
    """
    out: dict[str, tuple[object, ...]] = {}

    def visit(path: Path, rel: str) -> None:
        if path.is_symlink():
            out[rel] = ("link", os.readlink(path))
            return
        st = path.lstat()
        if stat.S_ISDIR(st.st_mode):
            out[rel] = ("dir", st.st_ino, st.st_mtime_ns)
            for child in sorted(path.iterdir()):
                visit(child, f"{rel}/{child.name}" if rel else child.name)
            return
        out[rel] = ("file", st.st_ino, st.st_mtime_ns, st.st_size, path.read_bytes())

    if not os.path.lexists(root):
        return out
    visit(root, "")
    return out


def entries(root: Path) -> list[str]:
    """Direct child names of ``root``, sorted. ``[]`` when the root is absent."""
    if not root.is_dir():
        return []
    return sorted(os.listdir(root))


def link_identity(root: Path) -> dict[str, tuple[int, int, str]]:
    """``{name: (inode, mtime_ns, link body)}`` for every symlink directly in ``root``.

    ``os.rename`` over a name always yields a NEW inode, so an unchanged inode is
    proof the link was not rewritten -- which an equal link body alone is not.
    """
    out: dict[str, tuple[int, int, str]] = {}
    for name in entries(root):
        path = root / name
        if path.is_symlink():
            st = path.lstat()
            out[name] = (st.st_ino, st.st_mtime_ns, os.readlink(path))
    return out


def tmp_debris(root: Path) -> list[str]:
    return [name for name in entries(root) if name.startswith(TMP_PREFIX)]


def read_state(root: Path) -> dict:
    return json.loads(state_path_for(root).read_text(encoding="utf-8"))


def write_state(root: Path, payload: dict) -> None:
    state_path_for(root).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def fail_unlink_in(mp: pytest.MonkeyPatch, root: Path, *, nth: int = 1) -> dict[str, int]:
    """Make the ``nth`` real removal inside ``root`` fail with ``EIO``.

    ``.skillex-tmp-*`` is exempt: those unlinks belong to the *add* half of apply
    (``symlink`` to a tmp name, then ``rename`` over the target), and failing them
    would test the wrong half. The lock file and the pending receipt live outside
    ``root`` and are untouched.
    """
    real = os.unlink
    calls = {"n": 0}

    def fake(path, *args, **kwargs):  # type: ignore[no-untyped-def]
        candidate = Path(os.fspath(path))
        if candidate.parent == root and not candidate.name.startswith(TMP_PREFIX):
            calls["n"] += 1
            if calls["n"] == nth:
                raise OSError(errno.EIO, "injected removal failure")
        return real(path, *args, **kwargs)

    mp.setattr(os, "unlink", fake)
    return calls


def fail_rename_into(
    mp: pytest.MonkeyPatch, root: Path, *, nth: int, exc: BaseException
) -> dict[str, int]:
    """Raise ``exc`` on the ``nth`` ``os.rename`` whose destination is in ``root``."""
    real = os.rename
    calls = {"n": 0}

    def fake(src, dst, *args, **kwargs):  # type: ignore[no-untyped-def]
        if Path(os.fspath(dst)).parent == root:
            calls["n"] += 1
            if calls["n"] == nth:
                raise exc
        return real(src, dst, *args, **kwargs)

    mp.setattr(os, "rename", fake)
    return calls


def plant_links(root: Path, members: Iterable[tuple]) -> Path:
    """Build an activation root by hand, as a rival engine would have left it."""
    root.mkdir(parents=True, exist_ok=True)
    return write_members(root, members)


@pytest.fixture
def here(sandbox: Sandbox) -> Path:
    """A CWD with no manifest, inside a git repo: global scope only (AC 6).

    ``find_project`` stops at the ``.git`` boundary and returns ``None``, so every
    test in this module reconciles exactly one root -- ``$HOME/.agents/skills`` --
    unless it opts into a project scope explicitly.
    """
    return sandbox.project("standalone", manifest=None)


@pytest.fixture
def seeded(sandbox: Sandbox, registry: Path) -> dict[str, Path]:
    """``all-skills/{a..i}`` plus a global manifest declaring ``a``, ``b``, ``c``."""
    catalog = write_catalog(registry, *"abcdefghi")
    sandbox.write_global_manifest(skills=["a", "b", "c"])
    return catalog


# ---------------------------------------------------------------------------
# idempotence and churn
# ---------------------------------------------------------------------------


def test_second_run_is_all_keep_and_writes_nothing(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """Run 2 must not touch a single inode. Equal link bodies are not enough."""
    code, _ = sync(cwd=here)
    assert code == 0

    root = sandbox.global_root
    before = link_identity(root)
    root_stat_before = root.lstat()
    assert sorted(before) == ["a", "b", "c"]

    code, payload = sync_json(cwd=here)
    assert code == 0
    counts = payload["scopes"][0]["counts"]
    assert counts["keep"] == 3
    assert counts["add"] == counts["replace"] == counts["remove"] == 0
    # `ops` deliberately omits KEEP, so an empty list IS "nothing to do".
    assert payload["scopes"][0]["ops"] == []

    after = link_identity(root)
    assert after == before, "run 2 rewrote a link that was already correct"
    assert root.lstat().st_mtime_ns == root_stat_before.st_mtime_ns


def test_preexisting_link_with_a_trailing_slash_is_a_keep(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """``-> .../hindsight/`` and ``-> .../hindsight`` are the same link.

    Without the ``rstrip("/")`` in ``lexical_link_target`` this compares unequal
    every run, and sync rewrites a correct link forever.
    """
    catalog = write_catalog(registry, "hindsight")
    sandbox.write_global_manifest(skills=["hindsight"])

    root = sandbox.global_root
    plant_links(root, [("link", "hindsight", f"{catalog['hindsight']}/")])
    before = link_identity(root)
    assert before["hindsight"][2].endswith("/")

    code, payload = sync_json(cwd=here)
    assert code == 0
    assert payload["scopes"][0]["counts"]["keep"] == 1
    assert payload["scopes"][0]["counts"]["replace"] == 0
    assert link_identity(root) == before


def test_set_member_written_with_a_trailing_slash_is_idempotent(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """The ``packs/Kurzgesagt/hindsight -> ../../all-skills/hindsight/`` shape."""
    write_catalog(registry, "hindsight")
    write_set(registry, "kurz", [("link", "hindsight", "../../all-skills/hindsight/")])
    sandbox.write_global_manifest(sets=["kurz"])

    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    assert os.readlink(root / "hindsight") == str(registry / "all-skills" / "hindsight")
    before = link_identity(root)

    code, payload = sync_json(cwd=here)
    assert code == 0
    assert payload["scopes"][0]["ops"] == []
    assert link_identity(root) == before


# ---------------------------------------------------------------------------
# never destroys
# ---------------------------------------------------------------------------


def test_real_directory_at_a_desired_name_refuses_and_is_untouched(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """E_OCCUPIED, ZERO links written, and the directory byte-identical after."""
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root

    squatter = root / "d"
    write_skill(root, "d", body="# not ours\n")
    (squatter / "notes.txt").write_text("hand written\n", encoding="utf-8")
    before = fingerprint(squatter)

    sandbox.write_global_manifest(skills=["a", "b", "c", "d", "e"])
    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_OCCUPIED.value in codes_in(payload)
    assert fingerprint(squatter) == before
    assert not os.path.lexists(root / "e"), "a refusal must write nothing at all"
    assert sorted(entries(root)) == ["a", "b", "c", "d"]


def test_regular_file_at_a_desired_name_refuses(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    (root / "d").write_text("someone's notes\n", encoding="utf-8")
    before = fingerprint(root / "d")

    sandbox.write_global_manifest(skills=["a", "b", "c", "d"])
    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_OCCUPIED.value in codes_in(payload)
    assert fingerprint(root / "d") == before


def test_skip_occupied_projects_the_rest_and_exits_4(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    write_skill(root, "d", body="# not ours\n")
    before = fingerprint(root / "d")

    sandbox.write_global_manifest(skills=["a", "b", "c", "d", "e"])
    code, payload = sync_json("--skip-occupied", cwd=here)

    assert code == 4
    assert payload["scopes"][0]["counts"]["blocked"] == 1
    assert fingerprint(root / "d") == before, "the blocked name was mutated"
    assert (root / "e").is_symlink(), "the free names must still be projected"
    assert sorted(entries(root)) == ["a", "b", "c", "d", "e"]
    # A blocked name is never recorded as ours; the next run must not prune it.
    assert "d" not in read_state(root)["entries"]


def test_foreign_real_directory_is_reported_and_survives(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    write_skill(root, "someone-elses", body="# theirs\n")
    before = fingerprint(root / "someone-elses")

    code, payload = sync_json(cwd=here)

    assert code == 0
    assert Code.W_FOREIGN_ENTRY.value in codes_in(payload)
    assert fingerprint(root / "someone-elses") == before


def test_live_foreign_symlink_is_never_removed(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """A link pointing outside every managed root is somebody else's."""
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    outside = write_skill(sandbox.tmp / "other-repo" / "skills", "handmade")
    os.symlink(outside, root / "handmade")

    code, payload = sync_json(cwd=here)

    assert code == 0
    assert Code.W_FOREIGN_ENTRY.value in codes_in(payload)
    assert (root / "handmade").is_symlink()
    assert os.readlink(root / "handmade") == str(outside)


def test_owned_name_that_became_a_real_directory_is_left_alone(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """W_PRUNE_SKIPPED_NOT_LINK: the receipt says ours, the disk says otherwise."""
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    assert "c" in read_state(root)["entries"]

    os.unlink(root / "c")
    write_skill(root, "c", body="# promoted to a real skill\n")
    before = fingerprint(root / "c")

    sandbox.write_global_manifest(skills=["a", "b"])
    code, payload = sync_json(cwd=here)

    assert code == 0
    assert Code.W_PRUNE_SKIPPED_NOT_LINK.value in codes_in(payload)
    assert fingerprint(root / "c") == before


def test_no_prune_removes_nothing(sandbox: Sandbox, here: Path, seeded: dict[str, Path]) -> None:
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    before = link_identity(root)

    sandbox.write_global_manifest(skills=["a"])
    code, payload = sync_json("--no-prune", cwd=here)

    assert code == 0
    assert payload["scopes"][0]["counts"]["remove"] == 0
    assert link_identity(root) == before


def test_first_run_on_an_absent_root_removes_nothing(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    assert not sandbox.global_root.exists()
    code, payload = sync_json(cwd=here)

    assert code == 0
    counts = payload["scopes"][0]["counts"]
    assert counts["add"] == 3
    assert counts["remove"] == 0
    assert counts["sweep"] == 0
    assert counts["blocked"] == 0


# ---------------------------------------------------------------------------
# E_UNMANAGED_ROOT thresholding
# ---------------------------------------------------------------------------


def test_stateless_root_of_managed_links_proceeds(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """The live first-run case: links into the registry, no receipt. Must NOT refuse.

    ``stray`` is a managed link the manifest no longer declares. It is pruned on
    this same pass -- deliberately, and this is not a contradiction of "never
    destroys": containment proves the target is registry content sync itself could
    have written, and a reconciler that needed two passes to converge would fail
    its own idempotence contract.
    """
    catalog = write_catalog(registry, "a", "b", "stray")
    sandbox.write_global_manifest(skills=["a", "b"])

    root = sandbox.global_root
    plant_links(
        root,
        [
            ("link", "a", catalog["a"]),
            ("link", "b", catalog["b"]),
            ("link", "stray", catalog["stray"]),
        ],
    )
    assert not state_path_for(root).exists()

    code, payload = sync_json(cwd=here)

    assert code == 0, "a stateless root of managed links must not be refused"
    assert Code.E_UNMANAGED_ROOT.value not in codes_in(payload)
    assert entries(root) == ["a", "b"]


def test_stateless_root_with_real_directories_refuses(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    catalog = write_catalog(registry, "a")
    sandbox.write_global_manifest(skills=["a"])

    root = sandbox.global_root
    plant_links(root, [("link", "a", catalog["a"])])
    write_skill(root, "handmade", body="# somebody's work\n")
    before = fingerprint(root)

    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_UNMANAGED_ROOT.value in codes_in(payload)
    assert fingerprint(root) == before, "a refusal mutated the root"
    assert not state_path_for(root).exists()


def test_stateless_root_with_a_link_outside_managed_roots_refuses(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    catalog = write_catalog(registry, "a")
    sandbox.write_global_manifest(skills=["a"])
    outside = write_skill(sandbox.tmp / "elsewhere", "imported")

    root = sandbox.global_root
    plant_links(root, [("link", "a", catalog["a"]), ("link", "imported", outside)])
    before = fingerprint(root)

    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_UNMANAGED_ROOT.value in codes_in(payload)
    assert fingerprint(root) == before


# ---------------------------------------------------------------------------
# ownership and the receipt
# ---------------------------------------------------------------------------


def _outside_set(sandbox: Sandbox, registry: Path) -> Path:
    """A set with one member in the catalog and one in a foreign repo (``momo``)."""
    catalog = write_catalog(registry, "keep")
    momo = write_skill(sandbox.tmp / "33GOD" / "momo", "skill")
    return write_set(
        registry,
        "mixed",
        [("link", "keep", catalog["keep"]), ("link", "momo", momo)],
    )


def test_receipt_prunes_a_link_that_points_outside_the_registry(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """The momo/pjangler case: containment can never explain this link. The receipt can."""
    set_dir = _outside_set(sandbox, registry)
    sandbox.write_global_manifest(sets=["mixed"])
    assert sync(cwd=here)[0] == 0

    root = sandbox.global_root
    assert entries(root) == ["keep", "momo"]
    assert "momo" in read_state(root)["entries"]

    os.unlink(set_dir / "momo")
    code, payload = sync_json(cwd=here)

    assert code == 0
    assert payload["scopes"][0]["counts"]["remove"] == 1
    assert entries(root) == ["keep"]


def test_without_the_receipt_the_same_link_is_not_pruned(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """Delete the receipt and the outcome changes. That is what "load-bearing" means."""
    set_dir = _outside_set(sandbox, registry)
    sandbox.write_global_manifest(sets=["mixed"])
    assert sync(cwd=here)[0] == 0

    root = sandbox.global_root
    os.unlink(set_dir / "momo")
    state_path_for(root).unlink()
    before = fingerprint(root)

    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_UNMANAGED_ROOT.value in codes_in(payload)
    assert (root / "momo").is_symlink(), "an unexplained link was removed"
    assert fingerprint(root) == before


def test_receipt_that_no_longer_names_it_leaves_it_alone(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """A receipt that exists but disclaims the name: report it, never remove it."""
    set_dir = _outside_set(sandbox, registry)
    sandbox.write_global_manifest(sets=["mixed"])
    assert sync(cwd=here)[0] == 0

    root = sandbox.global_root
    os.unlink(set_dir / "momo")
    payload_state = read_state(root)
    del payload_state["entries"]["momo"]
    write_state(root, payload_state)

    code, payload = sync_json(cwd=here)

    assert code == 0
    assert Code.W_FOREIGN_ENTRY.value in codes_in(payload)
    assert (root / "momo").is_symlink()


def test_a_pending_receipt_survives_a_crash(sandbox: Sandbox, here: Path, registry: Path) -> None:
    """Write-ahead: pending UNION committed. An uncommitted run still owns its writes."""
    catalog = write_catalog(registry, "a")
    outside = write_skill(sandbox.tmp / "33GOD" / "momo", "skill")
    sandbox.write_global_manifest(skills=["a"])

    root = sandbox.global_root
    plant_links(root, [("link", "a", catalog["a"]), ("link", "momo", outside)])
    # Exactly the state an interrupted run leaves: pending written, never committed.
    write_pending(ProjectionState(root=root), {"a", "momo"})
    assert not state_path_for(root).exists()

    code, payload = sync_json(cwd=here)

    assert code == 0
    assert Code.E_UNMANAGED_ROOT.value not in codes_in(payload)
    assert entries(root) == ["a"], "the pending receipt was not honored"


def test_a_dangling_owned_link_is_pruned_wherever_it_points(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """Debris in a generated root is debris regardless of author or destination."""
    catalog = write_catalog(registry, "a")
    sandbox.write_global_manifest(skills=["a"])

    root = sandbox.global_root
    plant_links(
        root,
        [
            ("link", "a", catalog["a"]),
            ("dangling", "ghost-in-registry", registry / "all-skills" / "gone"),
            ("dangling", "ghost-elsewhere", sandbox.tmp / "nowhere" / "at" / "all"),
        ],
    )

    code, payload = sync_json(cwd=here)

    assert code == 0
    assert Code.E_UNMANAGED_ROOT.value not in codes_in(payload)
    assert entries(root) == ["a"]


# ---------------------------------------------------------------------------
# atomicity and interruption
# ---------------------------------------------------------------------------


def test_adds_precede_removes(sandbox: Sandbox, here: Path, seeded: dict[str, Path]) -> None:
    """Fail the first removal: the root must be a SUPERSET, never a subset."""
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root
    assert entries(root) == ["a", "b", "c"]

    sandbox.write_global_manifest(skills=["d", "e", "f"])
    # A scoped context, never the shared `monkeypatch` fixture: undoing that one
    # would also undo the sandbox's own setenvs. See `_guarded_sandbox`.
    with pytest.MonkeyPatch.context() as mp:
        calls = fail_unlink_in(mp, root, nth=1)
        code, _ = sync(cwd=here)

    assert code != 0, "the injected failure was never reached"
    assert calls["n"] >= 1
    # Every add landed BEFORE the removal was attempted.
    for name in ("d", "e", "f"):
        assert (root / name).is_symlink(), f"{name} was not added before the first removal"
    # And nothing was lost.
    for name in ("a", "b", "c"):
        assert (root / name).is_symlink(), f"{name} disappeared"
    assert tmp_debris(root) == []


def test_interruption_leaves_a_superset_and_the_next_run_converges(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """Ctrl-C mid-projection: >=4 links in, ZERO out, and run 2 converges exactly."""
    assert sync(cwd=here)[0] == 0
    root = sandbox.global_root

    wanted = ["d", "e", "f", "g", "h", "i"]
    sandbox.write_global_manifest(skills=wanted)
    with pytest.MonkeyPatch.context() as mp:
        calls = fail_rename_into(mp, root, nth=5, exc=KeyboardInterrupt())
        code, _ = sync(cwd=here)

    assert code == 130
    assert calls["n"] == 5
    landed = [name for name in wanted if (root / name).is_symlink()]
    assert len(landed) >= 4, f"only {landed} landed before the interruption"
    for name in ("a", "b", "c"):
        assert (root / name).is_symlink(), "an interrupted run removed something"
    assert tmp_debris(root) == [], "an interrupted rename stranded a tmp link"

    # The pending receipt from the interrupted run is what lets run 2 own -- and
    # therefore prune -- links it never saw committed.
    code, _ = sync(cwd=here)
    assert code == 0
    assert entries(root) == wanted


def test_a_stale_tmp_entry_is_swept_and_never_projected(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    root = sandbox.global_root
    plant_links(
        root,
        [
            ("dangling", f"{TMP_PREFIX}a-4242", sandbox.tmp / "gone"),
            ("dangling", "ghost", sandbox.tmp / "gone"),
        ],
    )

    code, payload = sync_json(cwd=here)

    assert code == 0
    assert payload["scopes"][0]["counts"]["sweep"] == 1
    assert entries(root) == ["a", "b", "c"]
    assert tmp_debris(root) == []


# ---------------------------------------------------------------------------
# root shape transitions
# ---------------------------------------------------------------------------


def test_absent_root_is_created_as_a_real_directory(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    root = sandbox.global_root
    assert not os.path.lexists(root)

    assert sync(cwd=here)[0] == 0

    assert root.is_dir() and not root.is_symlink()
    assert entries(root) == ["a", "b", "c"]


def test_symlink_root_becomes_a_directory_and_the_old_target_survives(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """``unlink`` then ``mkdir``. Unlinking a symlink-to-dir never touches the dir."""
    old_target = sandbox.tmp / "previous-projection"
    write_skill(old_target, "kept-by-the-old-engine")
    before = fingerprint(old_target)

    root = sandbox.global_root
    os.symlink(old_target, root)

    assert sync(cwd=here)[0] == 0

    assert root.is_dir() and not root.is_symlink()
    assert entries(root) == ["a", "b", "c"]
    assert fingerprint(old_target) == before, "the old target directory was disturbed"


def _alias_pack(registry: Path) -> Path:
    """A pack eligible for whole-root alias mode: flat, real members, no filters."""
    from tests.conftest import write_pack

    return write_pack(registry, "solo", skills=["pa", "pb"])


def test_real_dir_becomes_an_alias_by_moving_aside_never_deleting(
    sandbox: Sandbox, here: Path, registry: Path, seeded: dict[str, Path]
) -> None:
    pack_dir = _alias_pack(registry)
    assert sync(cwd=here)[0] == 0

    root = sandbox.global_root
    before = fingerprint(root)
    assert before, "run 1 projected nothing"

    sandbox.write_global_manifest(packs=["solo"])
    code, payload = sync_json(cwd=here)

    assert code == 0
    assert payload["scopes"][0]["mode"] == "alias"
    assert root.is_symlink()
    assert Path(os.readlink(root)) == pack_dir

    aside = sorted((sandbox.home / ".agents").glob("skills.pre-alias-*"))
    assert len(aside) == 1, f"the old root was not moved aside: {entries(sandbox.home / '.agents')}"
    moved = fingerprint(aside[0])
    # Same contents, same inodes: renamed, not copied, and nothing removed.
    assert moved == before


def test_alias_with_an_unowned_entry_refuses_and_changes_nothing(
    sandbox: Sandbox, here: Path, registry: Path, seeded: dict[str, Path]
) -> None:
    _alias_pack(registry)
    assert sync(cwd=here)[0] == 0

    root = sandbox.global_root
    write_skill(root, "stranger", body="# not ours\n")
    before = fingerprint(root)

    sandbox.write_global_manifest(packs=["solo"])
    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_ALIAS_WOULD_DISCARD.value in codes_in(payload)
    assert not root.is_symlink()
    assert fingerprint(root) == before
    assert not list((sandbox.home / ".agents").glob("skills.pre-alias-*"))


def test_a_dangling_parent_symlink_refuses_instead_of_crashing(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """``mkdir(parents=True, exist_ok=True)`` on a dangling symlink raises errno 17.

    That bare ``FileExistsError`` is the crash this refusal replaces, so the test
    pins the CODE, not merely "it failed".
    """
    agents = sandbox.home / ".agents"
    shutil.rmtree(agents)
    os.symlink(sandbox.home / "no-such-directory", agents)
    assert agents.is_symlink() and not agents.exists()

    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_UNSAFE_ROOT_CHAIN.value in codes_in(payload)
    assert agents.is_symlink(), "the refusal mutated the chain it refused to walk"


def test_a_regular_file_at_the_root_path_refuses(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    root = sandbox.global_root
    root.write_text("this is not a skills directory\n", encoding="utf-8")
    before = fingerprint(root)

    code, payload = sync_json(cwd=here)

    assert code == 3
    assert Code.E_ROOT_NOT_DIR.value in codes_in(payload)
    assert fingerprint(root) == before


# ---------------------------------------------------------------------------
# invariants
# ---------------------------------------------------------------------------


def test_every_projected_entry_is_a_symlink_never_a_real_directory(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """A live skill-ssot daemon evicts any real dir holding a SKILL.md from a
    watched root. Projecting only symlinks is what makes sync safe from it.

    ``sets/n8n`` is 14/14 real skill directories embedded in the set; sync warns
    and projects them -- as LINKS INTO the set, never as copies.
    """
    catalog = write_catalog(registry, "linked")
    write_set(
        registry,
        "n8n",
        [
            ("link", "linked", catalog["linked"]),
            ("realdir", "n8n-a"),
            ("realdir", "n8n-b"),
        ],
    )
    sandbox.write_global_manifest(sets=["n8n"])

    code, payload = sync_json(cwd=here)
    assert code == 0
    assert Code.W_SET_EMBEDDED_DEFINITION.value in codes_in(payload)

    root = sandbox.global_root
    assert entries(root) == ["linked", "n8n-a", "n8n-b"]
    for name in entries(root):
        path = root / name
        assert path.is_symlink(), (
            f"{name} was projected as a real {'dir' if path.is_dir() else 'file'}"
        )
    assert Path(os.readlink(root / "n8n-a")) == registry / "sets" / "n8n" / "n8n-a"


def test_sync_never_writes_inside_the_registry(
    sandbox: Sandbox, here: Path, registry: Path
) -> None:
    """all-skills/, sets/ and packs/ are sources. Byte-identical, inode-identical."""
    catalog = write_catalog(registry, "solo", "in-a-set")
    write_set(
        registry,
        "mix",
        [("link", "in-a-set", catalog["in-a-set"]), ("realdir", "embedded")],
    )
    _alias_pack(registry)
    sandbox.write_global_manifest(sets=["mix"], skills=["solo"])

    before = fingerprint(registry)
    assert sync(cwd=here)[0] == 0
    assert fingerprint(registry) == before

    # ...including the run that turns the whole root into an alias INTO packs/.
    sandbox.write_global_manifest(packs=["solo"])
    assert sync(cwd=here)[0] == 0
    assert fingerprint(registry) == before


def test_preflight_refuses_a_root_inside_the_registry(registry: Path) -> None:
    """``cd all-skills && skillex sync`` must never invert the write boundary."""
    from skillex.core.diagnostics import Reporter

    root = registry / "all-skills" / "impeccable" / ".agents" / "skills"
    root.parent.mkdir(parents=True)

    with pytest.raises(RefusalError) as excinfo:
        preflight(root, [registry], Reporter())

    assert excinfo.value.finding.code is Code.E_ROOT_INSIDE_REGISTRY
    assert not os.path.lexists(root)


def test_managed_roots_refuses_home_and_the_filesystem_root(sandbox: Sandbox) -> None:
    """Either would make every link on the machine "managed" -- i.e. no rule at all."""
    for candidate in (Path.home(), Path("/")):
        with pytest.raises(RefusalError) as excinfo:
            managed_roots([candidate])
        assert excinfo.value.finding.code is Code.E_UNSAFE_TARGET

    assert managed_roots([sandbox.registry]) == [Path(os.path.realpath(sandbox.registry))]


def test_dry_run_mutates_nothing_at_all(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    """The root, the CLI aliases, the state dir, and the lock: all untouched."""
    home_before = fingerprint(sandbox.home)
    state_before = fingerprint(sandbox.state_home)
    registry_before = fingerprint(sandbox.registry)

    code, payload = sync_json("--dry-run", cwd=here)

    assert code == 0
    assert payload["dry_run"] is True
    assert payload["scopes"][0]["counts"]["add"] == 3
    assert payload["scopes"][0]["applied"] is False

    assert fingerprint(sandbox.home) == home_before
    assert fingerprint(sandbox.state_home) == state_before
    assert fingerprint(sandbox.registry) == registry_before
    assert not os.path.lexists(sandbox.global_root)
    assert not os.path.lexists(default_lock_path())
    assert not os.path.lexists(default_lock_path().parent)


def test_dry_run_after_a_real_run_still_mutates_nothing(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    assert sync(cwd=here)[0] == 0
    sandbox.write_global_manifest(skills=["a", "d"])

    home_before = fingerprint(sandbox.home)
    state_before = fingerprint(sandbox.state_home)

    code, payload = sync_json("--dry-run", cwd=here)

    assert code == 0
    counts = payload["scopes"][0]["counts"]
    assert (counts["add"], counts["remove"]) == (1, 2)
    assert fingerprint(sandbox.home) == home_before
    assert fingerprint(sandbox.state_home) == state_before


def test_dry_run_exit_code_reports_drift_then_convergence(
    sandbox: Sandbox, here: Path, seeded: dict[str, Path]
) -> None:
    assert sync("--dry-run", "--exit-code", cwd=here)[0] == 6
    assert not os.path.lexists(sandbox.global_root)

    assert sync(cwd=here)[0] == 0
    assert sync("--dry-run", "--exit-code", cwd=here)[0] == 0

    # Snapshot equality is the same claim from the other direction.
    before = snapshot(sandbox.global_root)
    assert sync("--dry-run", "--exit-code", cwd=here)[0] == 0
    assert snapshot(sandbox.global_root) == before
