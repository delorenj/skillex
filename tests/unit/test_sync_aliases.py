"""CLI skill roots as directory-level aliases: ``skillex.core.aliases``.

The module docstring commits to three behaviors and this file pins each:

* a **missing** alias is created, and created *relative* -- pjangler
  string-compares against the relative literal, so ``../.agents/skills`` is not a
  stylistic choice;
* a **correct** alias is never rewritten, whether it was written relative or
  absolute, because equality is by resolved path and rewriting seven correct links
  every run is pure churn;
* a **real directory** is reported, never converted. Five project CLI roots in the
  skillex repo alone hold 35, 13, 30, 30 and 17 entries with five different
  contents. ``--fix-aliases`` moves one aside; nothing is ever deleted.

Plus the rule that has no flag at all: :data:`NEVER_TOUCH` is untouchable.
"""

from __future__ import annotations

import os
from pathlib import Path

from skillex.core.aliases import (
    GLOBAL_CLI_ALIASES,
    NEVER_TOUCH,
    PROJECT_CLI_ALIASES,
    alias_paths,
    check_aliases,
    ensure_aliases,
)
from skillex.core.diagnostics import EXIT_OK, EXIT_REFUSED, Code, Reporter
from tests.conftest import Sandbox, codes_in

# ---------------------------------------------------------------------------
# local helpers - shapes unique to this file
# ---------------------------------------------------------------------------


def link_state(path: Path) -> tuple[bool, str | None, int | None]:
    """``(is_symlink, readlink, inode)`` for one alias path, never following it.

    The inode is what turns "the link still points at the right place" into "the
    link was not replaced": a delete-and-recreate produces an identical
    ``readlink`` and a different inode.
    """
    if not path.is_symlink():
        return (False, None, None)
    return (True, os.readlink(path), os.lstat(path).st_ino)


def tree_contents(root: Path) -> dict[str, str]:
    """Every regular file under ``root``, relpath -> text. Never follows a symlink."""
    out: dict[str, str] = {}
    for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
        for name in filenames:
            path = Path(dirpath) / name
            if path.is_symlink():
                continue
            out[str(path.relative_to(root))] = path.read_text(encoding="utf-8")
    return out


def seed_never_touch(home: Path) -> dict[str, dict[str, str]]:
    """Populate all four :data:`NEVER_TOUCH` skill dirs. Returns their contents."""
    seeded: dict[str, dict[str, str]] = {}
    for owner in sorted(NEVER_TOUCH):
        skills = home / owner / "skills"
        (skills / f"{owner.lstrip('.')}-only").mkdir(parents=True)
        (skills / f"{owner.lstrip('.')}-only" / "SKILL.md").write_text(
            f"# owned by {owner}\n", encoding="utf-8"
        )
        (skills / "marker.txt").write_text(f"{owner} runtime overlay\n", encoding="utf-8")
        seeded[owner] = tree_contents(skills)
    return seeded


# ---------------------------------------------------------------------------
# the tables
# ---------------------------------------------------------------------------


def test_global_alias_table_is_the_eight_declared_paths() -> None:
    assert GLOBAL_CLI_ALIASES == (
        Path(".claude/skills"),
        Path(".codex/skills"),
        Path(".gemini/skills"),
        Path(".copilot/skills"),
        Path(".kimi-code/skills"),
        Path(".kimi/skills"),
        Path(".openclaw/skills"),
        Path(".config/opencode/skills"),
    )
    assert len(GLOBAL_CLI_ALIASES) == 8
    assert len(set(GLOBAL_CLI_ALIASES)) == 8


def test_project_alias_table_is_the_six_declared_paths() -> None:
    assert PROJECT_CLI_ALIASES == (
        Path(".claude/skills"),
        Path(".codex/skills"),
        Path(".gemini/skills"),
        Path(".copilot/skills"),
        Path(".opencode/skills"),
        Path(".kimi-code/skills"),
    )
    assert len(PROJECT_CLI_ALIASES) == 6
    assert len(set(PROJECT_CLI_ALIASES)) == 6


def test_no_alias_is_ever_a_never_touch_directory() -> None:
    """The tables and the blocklist must not overlap, or the guard below is dead
    code that happens to look reassuring."""
    for table in (GLOBAL_CLI_ALIASES, PROJECT_CLI_ALIASES):
        for alias in table:
            assert not (set(alias.parts) & NEVER_TOUCH)


def test_alias_paths_are_joined_onto_the_scope_base(tmp_path: Path) -> None:
    assert alias_paths(tmp_path, is_global=True) == tuple(tmp_path / p for p in GLOBAL_CLI_ALIASES)
    assert alias_paths(tmp_path, is_global=False) == tuple(
        tmp_path / p for p in PROJECT_CLI_ALIASES
    )


# ---------------------------------------------------------------------------
# a missing alias is created, relative
# ---------------------------------------------------------------------------


def test_sync_creates_every_missing_global_alias_relative(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])

    code, out = run_sync(cwd=sandbox.home)
    assert code == EXIT_OK, out

    for relative in GLOBAL_CLI_ALIASES:
        alias = sandbox.home / relative
        assert alias.is_symlink(), f"{relative} was not created"
        # RELATIVE, not absolute: pjangler string-compares against this literal.
        body = os.readlink(alias)
        assert not os.path.isabs(body), f"{relative} -> {body} is absolute"
        assert Path(os.path.realpath(alias)) == Path(os.path.realpath(sandbox.global_root))
        assert (alias / "alpha").is_symlink()  # and it actually reaches the skills


def test_a_nested_alias_gets_the_right_depth(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    """``.config/opencode/skills`` is one level deeper than the other seven, so a
    hardcoded ``../.agents/skills`` would dangle."""
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    assert run_sync(cwd=sandbox.home)[0] == EXIT_OK

    assert os.readlink(sandbox.home / ".claude" / "skills") == "../.agents/skills"
    assert os.readlink(sandbox.home / ".config" / "opencode" / "skills") == "../../.agents/skills"


def test_sync_creates_the_project_aliases(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    """No project-scope alias exists on this machine today; without creation a
    successful project sync is invisible to every CLI."""
    write_catalog(registry, "alpha", "beta")
    sandbox.write_global_manifest(skills=["alpha"])
    project = sandbox.project("repo", manifest={"skills": ["beta"], "inherit_global": False})

    code, out = run_sync(cwd=project)
    assert code == EXIT_OK, out

    for relative in PROJECT_CLI_ALIASES:
        alias = project / relative
        assert alias.is_symlink(), f"{relative} was not created"
        assert (alias / "beta").is_symlink()
    # The project uses .opencode/skills, not .config/opencode/skills.
    assert os.readlink(project / ".opencode" / "skills") == "../.agents/skills"
    assert not (project / ".config").exists()


def test_ensure_aliases_creates_the_parent_directory(sandbox: Sandbox) -> None:
    root = sandbox.global_root
    root.mkdir(parents=True)
    reporter = Reporter()

    ensure_aliases(sandbox.home, root, reporter, is_global=True)

    assert (sandbox.home / ".config" / "opencode").is_dir()
    assert not reporter.findings


# ---------------------------------------------------------------------------
# a correct alias is never rewritten
# ---------------------------------------------------------------------------


def test_a_correct_alias_is_left_byte_identical(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    """Both spellings resolve to the same directory, so both are correct and
    neither may be touched. ``~/.claude/skills`` is relative on this machine and the
    other seven are absolute -- rewriting them would be churn on every run."""
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    root = sandbox.global_root
    root.mkdir(parents=True)

    relative_alias = sandbox.home / ".claude" / "skills"
    relative_alias.parent.mkdir(parents=True)
    os.symlink("../.agents/skills", relative_alias)

    absolute_alias = sandbox.home / ".codex" / "skills"
    absolute_alias.parent.mkdir(parents=True)
    os.symlink(str(root), absolute_alias)

    before = {p: link_state(p) for p in (relative_alias, absolute_alias)}
    assert run_sync(cwd=sandbox.home)[0] == EXIT_OK
    after = {p: link_state(p) for p in (relative_alias, absolute_alias)}

    assert after == before
    assert os.readlink(relative_alias) == "../.agents/skills"
    assert os.readlink(absolute_alias) == str(root)


def test_check_aliases_judges_by_resolved_path_not_string(sandbox: Sandbox) -> None:
    """The unit-level statement of the same rule."""
    root = sandbox.global_root
    root.mkdir(parents=True)
    for relative, body in (
        (".claude/skills", "../.agents/skills"),
        (".codex/skills", str(root)),
        # A path with a redundant component still resolves to the root.
        (".gemini/skills", str(sandbox.home / ".agents" / "." / "skills")),
    ):
        alias = sandbox.home / relative
        alias.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(body, alias)

    by_path = {s.path: s for s in check_aliases(sandbox.home, root, is_global=True)}
    for relative in (".claude/skills", ".codex/skills", ".gemini/skills"):
        status = by_path[sandbox.home / relative]
        assert status.ok is True
        assert status.kind == "symlink"
    # The five that do not exist are reported, not created.
    assert by_path[sandbox.home / ".kimi" / "skills"].kind == "absent"
    assert not (sandbox.home / ".kimi").exists()


def test_a_second_sync_rewrites_no_alias(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    assert run_sync(cwd=sandbox.home)[0] == EXIT_OK

    aliases = [sandbox.home / p for p in GLOBAL_CLI_ALIASES]
    before = {p: link_state(p) for p in aliases}
    assert run_sync(cwd=sandbox.home)[0] == EXIT_OK
    assert {p: link_state(p) for p in aliases} == before


# ---------------------------------------------------------------------------
# a wrong alias is reported, never redirected
# ---------------------------------------------------------------------------


def test_an_alias_pointing_elsewhere_is_an_error_and_is_not_changed(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync_json,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])

    elsewhere = sandbox.tmp / "somebody-elses-skills"
    elsewhere.mkdir()
    alias = sandbox.home / ".gemini" / "skills"
    alias.parent.mkdir(parents=True)
    os.symlink(str(elsewhere), alias)
    before = link_state(alias)

    code, payload = run_sync_json(cwd=sandbox.home)

    assert code == EXIT_REFUSED
    assert Code.E_CLI_ALIAS_WRONG_TARGET.value in codes_in(payload)
    assert link_state(alias) == before
    assert os.readlink(alias) == str(elsewhere)
    # Reported, not repaired -- even with --fix-aliases, which only moves real dirs.
    code, payload = run_sync_json("--fix-aliases", cwd=sandbox.home)
    assert code == EXIT_REFUSED
    assert link_state(alias) == before


def test_a_dangling_alias_is_reported_not_replaced(sandbox: Sandbox) -> None:
    """``is_symlink()`` is true for a dangling link, so it takes the symlink branch
    rather than the ``absent`` one -- it must not be silently overwritten."""
    root = sandbox.global_root
    root.mkdir(parents=True)
    alias = sandbox.home / ".kimi" / "skills"
    alias.parent.mkdir(parents=True)
    os.symlink(str(sandbox.tmp / "vanished"), alias)
    before = link_state(alias)

    reporter = Reporter()
    ensure_aliases(sandbox.home, root, reporter, is_global=True)

    assert [f.code for f in reporter.findings] == [Code.E_CLI_ALIAS_WRONG_TARGET]
    assert link_state(alias) == before


# ---------------------------------------------------------------------------
# a real directory is reported, and only ever MOVED
# ---------------------------------------------------------------------------


def test_a_real_directory_at_an_alias_path_is_reported_and_survives(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_skill,
    run_sync_json,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])

    occupied = sandbox.home / ".copilot" / "skills"
    write_skill(occupied, "hand-rolled")
    (occupied / "notes.md").write_text("mine\n", encoding="utf-8")
    before = tree_contents(occupied)

    code, payload = run_sync_json(cwd=sandbox.home)

    assert code == EXIT_OK  # a warning, not a refusal
    assert Code.W_CLI_ROOT_NOT_ALIAS.value in codes_in(payload)
    assert occupied.is_dir() and not occupied.is_symlink()
    assert tree_contents(occupied) == before
    # The projection still happened; only this one CLI cannot see it yet.
    assert (sandbox.global_root / "alpha").is_symlink()
    assert (sandbox.home / ".claude" / "skills").is_symlink()


def test_fix_aliases_moves_the_directory_aside_and_links(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_skill,
    run_sync_json,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])

    occupied = sandbox.home / ".copilot" / "skills"
    write_skill(occupied, "hand-rolled")
    (occupied / "notes.md").write_text("mine\n", encoding="utf-8")
    before = tree_contents(occupied)

    code, payload = run_sync_json("--fix-aliases", cwd=sandbox.home)

    assert code == EXIT_OK
    assert Code.W_CLI_ROOT_NOT_ALIAS.value not in codes_in(payload)

    # It is now an alias, written relative like every other created one.
    assert occupied.is_symlink()
    assert os.readlink(occupied) == "../.agents/skills"
    assert (occupied / "alpha").is_symlink()

    # And the old contents were MOVED, not deleted.
    aside = sorted(sandbox.home.glob(".copilot/skills.pre-skillex-*"))
    assert len(aside) == 1
    assert aside[0].is_dir() and not aside[0].is_symlink()
    assert tree_contents(aside[0]) == before


def test_fix_aliases_never_deletes_a_second_time(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_skill,
    run_sync,
) -> None:
    """Re-running must not clobber the first rescue directory."""
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    occupied = sandbox.home / ".copilot" / "skills"
    write_skill(occupied, "hand-rolled")

    assert run_sync("--fix-aliases", cwd=sandbox.home)[0] == EXIT_OK
    aside = sorted(sandbox.home.glob(".copilot/skills.pre-skillex-*"))
    assert len(aside) == 1
    contents = tree_contents(aside[0])

    assert run_sync("--fix-aliases", cwd=sandbox.home)[0] == EXIT_OK
    assert sorted(sandbox.home.glob(".copilot/skills.pre-skillex-*")) == aside
    assert tree_contents(aside[0]) == contents


def test_a_regular_file_at_an_alias_path_is_reported_not_removed(sandbox: Sandbox) -> None:
    root = sandbox.global_root
    root.mkdir(parents=True)
    blocker = sandbox.home / ".openclaw" / "skills"
    blocker.parent.mkdir(parents=True)
    blocker.write_text("not a directory\n", encoding="utf-8")

    reporter = Reporter()
    ensure_aliases(sandbox.home, root, reporter, is_global=True, fix=True)

    assert Code.W_CLI_ROOT_NOT_ALIAS in [f.code for f in reporter.findings]
    assert blocker.is_file()
    assert blocker.read_text(encoding="utf-8") == "not a directory\n"


# ---------------------------------------------------------------------------
# NEVER_TOUCH
# ---------------------------------------------------------------------------


def test_never_touch_dirs_are_untouched_even_with_fix_aliases(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
    snapshot,
) -> None:
    """``.hermes/skills`` is a live 52-entry Hermes runtime overlay; the other three
    are populated by tools with their own lifecycle. No flag reaches any of them."""
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    seeded = seed_never_touch(sandbox.home)
    assert set(seeded) == {".hermes", ".augment", ".cursor", ".crush"}

    before = {owner: snapshot(sandbox.home / owner) for owner in seeded}

    code, out = run_sync("--fix-aliases", cwd=sandbox.home)
    assert code == EXIT_OK, out

    for owner, contents in seeded.items():
        skills = sandbox.home / owner / "skills"
        assert skills.is_dir() and not skills.is_symlink()
        assert tree_contents(skills) == contents
        # Byte-identical AND inode-identical: nothing was moved aside either.
        assert snapshot(sandbox.home / owner) == before[owner]
        assert not list((sandbox.home / owner).glob("skills.pre-skillex-*"))


def test_check_aliases_skips_any_path_with_a_never_touch_component(
    sandbox: Sandbox,
) -> None:
    """The guard itself: every alias under a ``NEVER_TOUCH`` base is filtered out
    before the filesystem is even consulted."""
    root = sandbox.global_root
    root.mkdir(parents=True)
    for owner in sorted(NEVER_TOUCH):
        assert check_aliases(sandbox.home / owner, root, is_global=True) == []
        assert check_aliases(sandbox.home / owner, root, is_global=False) == []


# ---------------------------------------------------------------------------
# dry run
# ---------------------------------------------------------------------------


def test_dry_run_creates_no_alias(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    run_sync,
    snapshot,
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    before = snapshot(sandbox.home)

    code, out = run_sync("--dry-run", cwd=sandbox.home)

    assert code == EXIT_OK, out
    assert snapshot(sandbox.home) == before
    for relative in GLOBAL_CLI_ALIASES:
        assert not (sandbox.home / relative).exists()
        assert not (sandbox.home / relative).is_symlink()


def test_ensure_aliases_dry_run_creates_nothing_and_still_reports(
    sandbox: Sandbox,
    write_skill,
    snapshot,
) -> None:
    root = sandbox.global_root
    root.mkdir(parents=True)
    occupied = sandbox.home / ".copilot" / "skills"
    write_skill(occupied, "hand-rolled")
    before = snapshot(sandbox.home)

    reporter = Reporter()
    statuses = ensure_aliases(sandbox.home, root, reporter, is_global=True, dry_run=True)

    assert snapshot(sandbox.home) == before
    assert Code.W_CLI_ROOT_NOT_ALIAS in [f.code for f in reporter.findings]
    assert {s.kind for s in statuses} == {"absent", "real_dir"}
    # dry_run reports the pre-run picture, not an imagined post-run one.
    assert not any(s.ok for s in statuses)


def test_ensure_aliases_dry_run_with_fix_moves_nothing(
    sandbox: Sandbox,
    write_skill,
    snapshot,
) -> None:
    root = sandbox.global_root
    root.mkdir(parents=True)
    write_skill(sandbox.home / ".copilot" / "skills", "hand-rolled")
    before = snapshot(sandbox.home)

    ensure_aliases(sandbox.home, root, Reporter(), is_global=True, fix=True, dry_run=True)

    assert snapshot(sandbox.home) == before
