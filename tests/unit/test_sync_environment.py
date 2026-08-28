"""The three read-only environment checks, in full.

:mod:`skillex.core.environment` is the part of sync that looks at the machine
rather than the manifest: who ELSE writes the root we are about to write, is that
root generated output someone has committed, and is a third-party installer
keeping state next door. Its whole contract is negative -- best-effort, read-only,
**never fatal** -- so the tests that matter most here are the ones asserting
SILENCE and the one asserting nothing on disk moved.

Three properties are load-bearing enough to state up front:

* **A false alarm is worse than no alarm.** ``check_incumbent_engine`` fires on a
  ``mise.toml`` still wired to the retired projector. A ``mise.toml`` whose only
  mention of that projector is the COMMENT explaining why it was removed is a
  correctly migrated config, and warning on it teaches the next reader to skip the
  warning -- which is the one thing this check cannot afford, since it is the only
  thing standing between a sets-only manifest and an engine that silently prunes
  every link sync just wrote. Both comment shapes are pinned below.
* **The line number is the whole point.** "something else also syncs skills" is
  not actionable; ``mise.toml:5  run = "... sync-skills.py ..."`` is. The line
  numbers asserted here are literals, cross-checked against the source line they
  claim to name, so a fencepost slip fails loudly instead of pointing a reader at
  the wrong line.
* **None of the three may raise, whatever it finds.** They run inside plan(), and
  an exception escaping a warning aborts a sync that had nothing wrong with it.
  ``test_no_check_ever_raises_on_a_hostile_tree`` is the gauntlet; it caught a real
  one (see :func:`test_a_non_utf8_mise_toml_is_silent`).

**Isolation note, and it is not decorative.** Every git test here takes the
``sandbox`` fixture *for its HOME and XDG_CONFIG_HOME*, because this machine's
``~/.config/git/ignore`` contains ``.agents/skills/`` -- the very pattern
``check_gitignored`` asks about. Without the repointed config home, ``git
check-ignore`` answers "ignored" for a repo with no ``.gitignore`` at all, and
``test_a_root_inside_a_repo_and_not_ignored_warns`` passes for the wrong reason on
this machine and fails on CI. ``GIT_CEILING_DIRECTORIES`` is set for the same
class of reason: pytest's basetemp lives under the developer's real home, so an
un-ceilinged upward walk from "a directory in no repo" climbs out of ``tmp_path``
and finds a real one.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from skillex.core import environment
from skillex.core.diagnostics import (
    EXIT_REFUSED,
    STRICT_PROMOTES,
    Code,
    Reporter,
    Severity,
)
from skillex.core.environment import (
    INCUMBENT_SCRIPTS,
    RIVAL_LOCKFILE,
    check_gitignored,
    check_incumbent_engine,
    check_rival_lockfile,
)
from tests.conftest import Sandbox, codes_in, run_sync_json, snapshot, write_catalog

requires_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")

#: chmod 0o000 does not stop uid 0, so the unreadable-file case cannot be staged.
not_root = pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0, reason="root reads unreadable files"
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def codes(reporter: Reporter) -> list[Code]:
    """Every emitted code, in emission order."""
    return [f.code for f in reporter.findings]


def only(reporter: Reporter, code: Code):
    """The single finding, asserted to carry ``code``."""
    assert codes(reporter) == [code]
    return reporter.findings[0]


def write_mise(directory: Path, *lines: str) -> Path:
    """Write ``directory/mise.toml`` from ``lines``. Line N is ``lines[N - 1]``."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "mise.toml"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def hit_lines(finding, config: Path) -> list[str]:
    """The detail lines that name ``config:<number>``."""
    return [line for line in finding.detail if line.startswith(f"{config}:")]


def numbers(finding, config: Path) -> list[int]:
    """The line NUMBERS reported for ``config``, in detail order."""
    prefix = f"{config}:"
    return [int(line[len(prefix) :].split()[0]) for line in hit_lines(finding, config)]


def git(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)


@pytest.fixture
def repo(sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A real git repo at ``<tmp>/repo``, with the upward walk sealed at ``tmp_path``.

    ``sandbox`` is requested for its HOME/XDG_CONFIG_HOME repointing, which is what
    keeps this machine's global ``~/.config/git/ignore`` out of every
    ``check-ignore`` answer below. See the module docstring.
    """
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(sandbox.tmp))
    root = sandbox.tmp / "repo"
    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", ".", cwd=root)
    (root / ".agents").mkdir(exist_ok=True)
    return root


@pytest.fixture
def projection(repo: Path) -> Path:
    """``<repo>/.agents/skills`` -- the shape of a real activation root in a repo."""
    root = repo / ".agents" / "skills"
    root.mkdir(parents=True, exist_ok=True)
    return root


# ===========================================================================
# check_incumbent_engine
# ===========================================================================


@pytest.mark.parametrize("script", INCUMBENT_SCRIPTS)
def test_a_hook_running_an_incumbent_script_names_the_file_and_the_line(
    tmp_path: Path, script: str
) -> None:
    """Both retired projectors trip it, and the detail names file AND line.

    Parametrized over the constant rather than over two hardcoded names: adding a
    third incumbent to ``INCUMBENT_SCRIPTS`` should extend this test for free, and
    removing one should not leave a test asserting a name nothing looks for.
    """
    lines = (
        "[tools]",
        'python = "3.12"',
        "",
        "[[hooks.enter]]",
        f'run = "uv run .mise/scripts/{script} --scope global"',
        "",
        "[tasks.build]",
        'run = "echo build"',
    )
    config = write_mise(tmp_path, *lines)
    reporter = Reporter()

    check_incumbent_engine([tmp_path], reporter)

    finding = only(reporter, Code.W_INCUMBENT_ENGINE_ACTIVE)
    assert finding.severity is Severity.WARNING  # never fatal, by contract
    assert finding.path == config
    # The literal 5, cross-checked against the line it claims to name: a fencepost
    # slip here would otherwise still "pass" against a computed index.
    assert numbers(finding, config) == [5]
    assert lines[5 - 1].startswith("run =")
    assert script in hit_lines(finding, config)[0]


def test_the_reported_line_is_the_hook_line_not_the_table_header(tmp_path: Path) -> None:
    """A hook spanning several lines reports the line the script is ON."""
    lines = (
        "# skillex projection",
        "[[hooks.enter]]",
        "run = '''",
        "set -e",
        "python .mise/scripts/sync-skills.py",
        "'''",
    )
    config = write_mise(tmp_path, *lines)
    reporter = Reporter()

    check_incumbent_engine([tmp_path], reporter)

    finding = only(reporter, Code.W_INCUMBENT_ENGINE_ACTIVE)
    assert numbers(finding, config) == [5]
    assert lines[5 - 1].strip() == "python .mise/scripts/sync-skills.py"


@pytest.mark.parametrize(
    ("label", "comment"),
    [
        ("full-line", "# we removed sync-skills.py because it has no sets[] support"),
        ("indented", "    # sync-skills.py and provision-packs.py were retired here"),
        ("indented-tab", "\t# provision-packs.py is gone; see ADR-0001"),
    ],
)
def test_a_comment_naming_a_retired_engine_emits_nothing(
    tmp_path: Path, label: str, comment: str
) -> None:
    """THE REGRESSION THAT ALREADY HAPPENED.

    The note explaining why the hooks were removed must not trip the very warning
    it explains. A check that cries wolf on a correctly migrated config is worse
    than no check at all, because the next reader learns to skip it -- and the one
    time it is right, it is right about an engine that resolves zero skills from a
    sets-only manifest and then unlinks everything sync just wrote.
    """
    write_mise(
        tmp_path,
        "[tools]",
        'python = "3.12"',
        "",
        comment,
        "[tasks.'skills:sync']",
        'run = "uv run skillex sync"',
    )
    reporter = Reporter()

    check_incumbent_engine([tmp_path], reporter)

    assert codes(reporter) == []


def test_a_comment_and_a_live_hook_report_only_the_live_hook(tmp_path: Path) -> None:
    """The migrated half is documentation; the un-migrated half is wiring."""
    lines = (
        "# sync-skills.py used to run here on enter -- removed, see ADR-0001.",
        "[tasks.'skills:sync']",
        'run = "uv run skillex sync"',
        "",
        "[tasks.'skills:legacy']",
        'run = "python .mise/scripts/provision-packs.py"',
    )
    config = write_mise(tmp_path, *lines)
    reporter = Reporter()

    check_incumbent_engine([tmp_path], reporter)

    finding = only(reporter, Code.W_INCUMBENT_ENGINE_ACTIVE)
    assert numbers(finding, config) == [6]


def test_a_mise_toml_naming_neither_script_is_silent(tmp_path: Path) -> None:
    write_mise(
        tmp_path,
        "[tools]",
        'python = "3.12"',
        "",
        "[tasks.'skills:sync']",
        'run = "uv run skillex sync"',
        "",
        "[tasks.'skills:sync:global']",
        'run = "uv run skillex sync --scope global"',
    )
    reporter = Reporter()

    check_incumbent_engine([tmp_path], reporter)

    assert codes(reporter) == []


@pytest.mark.parametrize("shape", ["missing-file", "missing-dir", "mise-is-a-dir", "no-roots"])
def test_nothing_to_read_is_silent(tmp_path: Path, shape: str) -> None:
    """No mise.toml, no search root, and a DIRECTORY named mise.toml all say nothing."""
    roots: list[Path]
    if shape == "missing-file":
        (tmp_path / "empty").mkdir()
        roots = [tmp_path / "empty"]
    elif shape == "missing-dir":
        roots = [tmp_path / "does-not-exist"]
    elif shape == "mise-is-a-dir":
        (tmp_path / "odd" / "mise.toml").mkdir(parents=True)
        roots = [tmp_path / "odd"]
    else:
        roots = []
    reporter = Reporter()

    check_incumbent_engine(roots, reporter)

    assert codes(reporter) == []


@not_root
def test_an_unreadable_mise_toml_is_silent(tmp_path: Path) -> None:
    """A permission error is an answer the check does not have, so it says nothing."""
    config = write_mise(tmp_path, "[[hooks.enter]]", 'run = "sync-skills.py"')
    config.chmod(0o000)
    reporter = Reporter()
    try:
        check_incumbent_engine([tmp_path], reporter)
    finally:
        config.chmod(0o644)

    assert codes(reporter) == []


def test_a_non_utf8_mise_toml_is_silent(tmp_path: Path) -> None:
    """SOURCE BUG, found and fixed by this test.

    ``read_text(encoding="utf-8")`` raises ``UnicodeDecodeError``, which is a
    ``ValueError`` and **not** an ``OSError``. The original ``except OSError``
    therefore let one stray latin-1 byte in a ``mise.toml`` -- an accented name, a
    copy-pasted dash -- escape a check documented as "best-effort, never fatal" and
    abort an otherwise healthy sync from inside a warning.
    """
    directory = tmp_path / "latin1"
    directory.mkdir()
    (directory / "mise.toml").write_bytes(
        b'[tools]\n# caf\xe9\n[[hooks.enter]]\nrun = "sync-skills.py"\n'
    )
    reporter = Reporter()

    check_incumbent_engine([directory], reporter)

    assert codes(reporter) == []


def test_the_same_file_reached_through_two_search_roots_is_reported_once(
    tmp_path: Path,
) -> None:
    """sync passes ``[*scoped_roots]``, which can legitimately repeat a directory."""
    config = write_mise(tmp_path, "[[hooks.enter]]", 'run = "sync-skills.py"')
    reporter = Reporter()

    check_incumbent_engine([tmp_path, Path(str(tmp_path)), tmp_path], reporter)

    finding = only(reporter, Code.W_INCUMBENT_ENGINE_ACTIVE)
    assert numbers(finding, config) == [2]


def test_two_different_mise_files_are_reported_separately(tmp_path: Path) -> None:
    """Dedupe is per FILE, not a global one-shot: two configs are two problems."""
    first = write_mise(tmp_path / "a", "[[hooks.enter]]", 'run = "sync-skills.py"')
    second = write_mise(tmp_path / "b", 'run = "provision-packs.py"')
    reporter = Reporter()

    check_incumbent_engine([tmp_path / "a", tmp_path / "b"], reporter)

    assert codes(reporter) == [
        Code.W_INCUMBENT_ENGINE_ACTIVE,
        Code.W_INCUMBENT_ENGINE_ACTIVE,
    ]
    assert [f.path for f in reporter.findings] == [first, second]


def test_more_than_six_hits_are_truncated(tmp_path: Path) -> None:
    """A config wired in 40 places must not print 40 detail lines.

    The detail is a hint, not a report: six lines plus the two-line explanation is
    enough to act on, and the seventh through fortieth would push the explanation
    off the reader's screen.
    """
    lines = [f'run = "sync-skills.py --task {n}"' for n in range(1, 11)]
    config = write_mise(tmp_path, *lines)
    reporter = Reporter()

    check_incumbent_engine([tmp_path], reporter)

    finding = only(reporter, Code.W_INCUMBENT_ENGINE_ACTIVE)
    assert numbers(finding, config) == [1, 2, 3, 4, 5, 6]  # first six, in file order
    # six hits + the two-line "that engine has no sets[] support" explanation
    assert len(finding.detail) == 8
    # The TEXTS are the first six source lines and nothing else. Asserting on the
    # rendered hit lines instead would false-pass: tmp_path itself contains digits.
    quoted = [line.split("  ", 1)[1] for line in hit_lines(finding, config)]
    assert quoted == lines[:6]


def test_check_incumbent_engine_never_writes(tmp_path: Path) -> None:
    write_mise(tmp_path, "[[hooks.enter]]", 'run = "sync-skills.py"')
    before = snapshot(tmp_path)

    check_incumbent_engine([tmp_path], Reporter())

    assert snapshot(tmp_path) == before


# ===========================================================================
# check_gitignored
# ===========================================================================


@requires_git
def test_a_root_inside_a_repo_and_not_ignored_warns(projection: Path) -> None:
    """Generated output tracked in a repo diffs on every sync and travels badly."""
    reporter = Reporter()

    check_gitignored(projection, reporter)

    finding = only(reporter, Code.W_PROJECTION_NOT_GITIGNORED)
    assert finding.severity is Severity.WARNING
    assert finding.path == projection


@requires_git
def test_a_matching_gitignore_silences_it(repo: Path, projection: Path) -> None:
    (repo / ".gitignore").write_text(".agents/skills/\n", encoding="utf-8")
    reporter = Reporter()

    check_gitignored(projection, reporter)

    assert codes(reporter) == []


@requires_git
def test_git_info_exclude_silences_it(repo: Path, projection: Path) -> None:
    """The live global root is covered this way, not by a committed .gitignore.

    ``~/.agents/.git/info/exclude`` is the only thing keeping the real global
    activation root out of that repo's index, so a check that only understood
    ``.gitignore`` would warn on the healthiest tree on this machine.
    """
    exclude = repo / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text("/.agents/skills/\n", encoding="utf-8")
    reporter = Reporter()

    check_gitignored(projection, reporter)

    assert codes(reporter) == []


@requires_git
def test_a_root_in_no_git_repo_at_all_is_silent(
    sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(sandbox.tmp))
    parent = sandbox.tmp / "loose" / ".agents"
    parent.mkdir(parents=True)
    reporter = Reporter()

    check_gitignored(parent / "skills", reporter)

    assert codes(reporter) == []


def test_a_root_whose_parent_does_not_exist_is_silent_without_spawning_git(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cheap guard runs first: no parent directory, no subprocess."""
    calls: list[list[str]] = []
    monkeypatch.setattr(
        environment,
        "_git",
        lambda args, cwd: calls.append(args) or None,  # type: ignore[func-returns-value]
    )
    reporter = Reporter()

    check_gitignored(tmp_path / "gone" / "skills", reporter)

    assert codes(reporter) == []
    assert calls == []


def test_git_missing_entirely_is_silent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``_git`` returns None when git is absent or times out. Nothing to say."""
    monkeypatch.setattr(environment, "_git", lambda args, cwd: None)
    root = tmp_path / ".agents" / "skills"
    root.parent.mkdir(parents=True)
    reporter = Reporter()

    check_gitignored(root, reporter)

    assert codes(reporter) == []


def test_check_ignore_that_cannot_answer_is_silent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """rev-parse succeeds, check-ignore does not answer -> silence, not a guess.

    Warning here would mean "I could not tell, so I assume the worst", which is the
    false alarm this module exists to avoid.
    """

    def fake(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str] | None:
        if args[0] == "rev-parse":
            return subprocess.CompletedProcess(args, 0, stdout=f"{tmp_path}\n", stderr="")
        return None

    monkeypatch.setattr(environment, "_git", fake)
    root = tmp_path / ".agents" / "skills"
    root.parent.mkdir(parents=True)
    reporter = Reporter()

    check_gitignored(root, reporter)

    assert codes(reporter) == []


@requires_git
def test_check_gitignored_never_writes_outside_gits_own_bookkeeping(
    repo: Path, projection: Path
) -> None:
    """Nothing in the WORKTREE moves. ``.git/`` is excluded: index bookkeeping is
    git's business, and the claim under test is that this check writes no content.
    """

    def worktree(root: Path) -> dict[str, object]:
        return {k: v for k, v in snapshot(root).items() if not k.startswith(".git/")}

    before = worktree(repo)

    check_gitignored(projection, Reporter())

    assert worktree(repo) == before


# ===========================================================================
# check_rival_lockfile
# ===========================================================================


def test_a_present_lockfile_names_the_path_and_its_size(tmp_path: Path) -> None:
    """41960 bytes of someone else's state is the whole signal; say how much."""
    lockfile = tmp_path / RIVAL_LOCKFILE
    lockfile.parent.mkdir(parents=True)
    payload = '{"installed": ["a", "b"]}'
    lockfile.write_text(payload, encoding="utf-8")
    reporter = Reporter()

    check_rival_lockfile(tmp_path, reporter)

    finding = only(reporter, Code.I_RIVAL_LOCKFILE)
    assert finding.severity is Severity.INFO
    assert finding.path == lockfile
    assert str(lockfile) in finding.message
    assert any(line.startswith(f"{len(payload)} bytes") for line in finding.detail)


def test_the_lockfile_is_looked_for_at_the_documented_relative_path() -> None:
    """``<home>/.agents/.skill-lock.json`` -- pinned so a move is a deliberate edit."""
    assert RIVAL_LOCKFILE == Path(".agents") / ".skill-lock.json"


def test_an_absent_lockfile_is_silent(tmp_path: Path) -> None:
    (tmp_path / ".agents").mkdir()
    reporter = Reporter()

    check_rival_lockfile(tmp_path, reporter)

    assert codes(reporter) == []


def test_a_home_without_a_dot_agents_directory_is_silent(tmp_path: Path) -> None:
    reporter = Reporter()

    check_rival_lockfile(tmp_path, reporter)

    assert codes(reporter) == []


def test_a_directory_at_the_lockfile_path_is_silent(tmp_path: Path) -> None:
    """Not a file, so not that installer's state. Guessing would be a false alarm."""
    (tmp_path / RIVAL_LOCKFILE).mkdir(parents=True)
    reporter = Reporter()

    check_rival_lockfile(tmp_path, reporter)

    assert codes(reporter) == []


def test_a_dangling_symlink_at_the_lockfile_path_is_silent(tmp_path: Path) -> None:
    lockfile = tmp_path / RIVAL_LOCKFILE
    lockfile.parent.mkdir(parents=True)
    os.symlink(str(tmp_path / "nowhere.json"), lockfile)
    reporter = Reporter()

    check_rival_lockfile(tmp_path, reporter)

    assert codes(reporter) == []


def test_check_rival_lockfile_never_writes(tmp_path: Path) -> None:
    lockfile = tmp_path / RIVAL_LOCKFILE
    lockfile.parent.mkdir(parents=True)
    lockfile.write_text("{}", encoding="utf-8")
    before = snapshot(tmp_path)

    check_rival_lockfile(tmp_path, Reporter())

    assert snapshot(tmp_path) == before


# ===========================================================================
# cross-cutting
# ===========================================================================


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        # Actionable and CLEARABLE: fix the .gitignore, repoint the task, and the
        # finding goes away. That is what earns a warning.
        (Code.W_PROJECTION_NOT_GITIGNORED, Severity.WARNING),
        (Code.W_INCUMBENT_ENGINE_ACTIVE, Severity.WARNING),
        # NOT clearable, if you still use that installer -- so at WARNING it fired
        # on every healthy global sync forever and was the only finding on a clean
        # run of this machine. diagnostics.py reserves INFO for exactly that:
        # "events that are expected in a healthy tree, so they must not train the
        # eye to skip warnings."
        (Code.I_RIVAL_LOCKFILE, Severity.INFO),
    ],
)
def test_environment_findings_never_fail_a_run_and_strict_never_promotes_them(
    code: Code, expected: Severity
) -> None:
    """These describe the ENVIRONMENT, not the composition.

    Two properties, and the second is the one that must hold for all three:
    the severity each code's PREFIX declares, and that ``--strict`` promotes none
    of them. ``--strict`` is a topology gate; failing CI because a co-worker's
    machine also has another installer on it would make the flag useless for what
    it is for.
    """
    from skillex.core.diagnostics import severity_of

    assert severity_of(code) is expected
    assert expected is not Severity.ERROR
    assert code not in STRICT_PROMOTES


@pytest.mark.parametrize(
    "hostile",
    [
        "empty-tree",
        "mise-is-a-dir",
        "mise-is-a-dangling-symlink",
        "mise-is-binary",
        "lockfile-is-a-dir",
        "agents-is-a-file",
        "everything-at-once",
    ],
)
def test_no_check_ever_raises_on_a_hostile_tree(tmp_path: Path, hostile: str) -> None:
    """Whatever they find, all three return. They run inside plan(); an exception
    escaping one of them fails a sync that had nothing wrong with it.
    """
    home = tmp_path / "home"
    home.mkdir()
    if hostile in ("mise-is-a-dir", "everything-at-once"):
        (home / "mise.toml").mkdir(exist_ok=True)
    if hostile == "mise-is-a-dangling-symlink":
        os.symlink(str(tmp_path / "nowhere.toml"), home / "mise.toml")
    if hostile == "mise-is-binary":
        (home / "mise.toml").write_bytes(bytes(range(256)))
    if hostile in ("lockfile-is-a-dir", "everything-at-once"):
        (home / RIVAL_LOCKFILE).mkdir(parents=True, exist_ok=True)
    if hostile == "agents-is-a-file":
        (home / ".agents").write_text("not a directory", encoding="utf-8")

    reporter = Reporter()
    check_incumbent_engine([home, home / "nope", tmp_path], reporter)
    check_gitignored(home / ".agents" / "skills", reporter)
    check_rival_lockfile(home, reporter)

    # Whatever it decided to say, nothing here is fatal. Asserting WARNING
    # exactly would be the wrong pin: I_RIVAL_LOCKFILE is deliberately INFO, and
    # this test is about survivability, not about which channel a finding uses.
    assert all(f.severity is not Severity.ERROR for f in reporter.findings)


@requires_git
def test_all_three_together_write_nothing(
    sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch, repo: Path, projection: Path
) -> None:
    """The strongest form of "read-only": run the whole trio over a tree that trips
    all three, and prove not one inode under it changed.
    """
    write_mise(repo, "[[hooks.enter]]", 'run = "sync-skills.py"')
    lockfile = sandbox.home / RIVAL_LOCKFILE
    lockfile.parent.mkdir(parents=True, exist_ok=True)
    lockfile.write_text("{}", encoding="utf-8")

    def worktree(root: Path) -> dict[str, object]:
        return {k: v for k, v in snapshot(root).items() if not k.startswith(".git/")}

    before_repo = worktree(repo)
    before_home = snapshot(sandbox.home)

    reporter = Reporter()
    check_incumbent_engine([repo], reporter)
    check_gitignored(projection, reporter)
    check_rival_lockfile(sandbox.home, reporter)

    assert set(codes(reporter)) == {
        Code.W_INCUMBENT_ENGINE_ACTIVE,
        Code.W_PROJECTION_NOT_GITIGNORED,
        Code.I_RIVAL_LOCKFILE,
    }
    assert worktree(repo) == before_repo
    assert snapshot(sandbox.home) == before_home


# ===========================================================================
# The false-positive lens: cases where a check fired when it should not, or
# stayed silent when it should not. Every test below failed before its fix.
# ===========================================================================


@requires_git
def test_a_root_that_does_not_exist_yet_is_not_reported_as_unignored(repo: Path) -> None:
    """The FIRST sync of a correctly configured repo must be silent.

    ``.agents/skills/`` -- with the trailing slash, the canonical spelling, and the
    one in this machine's ``core.excludesFile`` -- is a DIRECTORY-ONLY pattern.
    ``git check-ignore`` matches it against the filesystem, so it answers "not
    ignored" for a path with no directory behind it yet. The root is absent exactly
    once per repo: on the run that is about to create it. Warning there tells a
    user who did everything right to go add a rule they already have.
    """
    (repo / ".gitignore").write_text(".agents/skills/\n", encoding="utf-8")
    root = repo / ".agents" / "skills"
    assert not root.exists()
    reporter = Reporter()

    check_gitignored(root, reporter)

    assert codes(reporter) == []


@requires_git
def test_an_absent_root_that_is_genuinely_not_ignored_still_warns(repo: Path) -> None:
    """The control. Without it the test above would also pass if the absent case
    had simply been skipped, which would lose the check on every first sync."""
    root = repo / ".agents" / "skills"
    assert not root.exists()
    reporter = Reporter()

    check_gitignored(root, reporter)

    assert codes(reporter) == [Code.W_PROJECTION_NOT_GITIGNORED]


@requires_git
def test_a_symlink_root_that_a_dir_only_rule_does_not_cover_still_warns(repo: Path) -> None:
    """Alias mode is NOT a false positive, and must not be silenced with the above.

    A directory-only rule does not match a symlink, and ``git add -A`` in this
    exact shape stages ``.agents/skills`` as a symlink -- measured, not reasoned:
    that is the "machine-specific symlink restored on someone else's checkout"
    the check exists to prevent. So the honest answer here is to warn.
    """
    (repo / ".gitignore").write_text(".agents/skills/\n", encoding="utf-8")
    root = repo / ".agents" / "skills"
    root.symlink_to(repo / "elsewhere")
    reporter = Reporter()

    check_gitignored(root, reporter)

    assert codes(reporter) == [Code.W_PROJECTION_NOT_GITIGNORED]


@requires_git
def test_the_suggested_rule_actually_silences_the_warning(repo: Path) -> None:
    """The fix must WORK when followed verbatim, and hit nothing else.

    The rule used to be ``/<root.name>`` -- ``/skills`` -- anchored at the repo
    top-level, where it does not match ``.agents/skills`` at all and does match an
    unrelated top-level ``skills/`` (``~/code/33GOD/skills/`` is one, with 16
    tracked files). Following it left the warning firing and untracked real
    sources. Applying the fix and re-running the check is the only assertion that
    can catch that; matching the string never would.
    """
    unrelated = repo / "skills"
    unrelated.mkdir()
    (unrelated / "keep.md").write_text("real source\n", encoding="utf-8")
    root = repo / ".agents" / "skills"
    root.mkdir(parents=True)
    reporter = Reporter()

    check_gitignored(root, reporter)
    finding = only(reporter, Code.W_PROJECTION_NOT_GITIGNORED)

    assert finding.fix is not None
    rule = finding.fix.removeprefix("add ").split(" to ")[0]
    (repo / ".gitignore").write_text(rule + "\n", encoding="utf-8")

    after = Reporter()
    check_gitignored(root, after)
    assert codes(after) == []  # the advice worked

    # ...and did not quietly ignore an unrelated directory that shares the name.
    still_tracked = subprocess.run(
        ["git", "check-ignore", "-q", str(unrelated / "keep.md")],
        cwd=repo,
        capture_output=True,
        check=False,
    )
    assert still_tracked.returncode == 1


@requires_git
def test_a_root_beyond_a_symlinked_parent_is_silent_not_a_guess(repo: Path) -> None:
    """``git check-ignore`` exits 128 for a path beyond a symbolic link.

    128 is not "not ignored", and the module's contract is that a check which
    cannot answer stays silent. Treating every non-zero code as "not ignored" made
    git's refusal indistinguishable from git's answer.
    """
    real = repo / "real"
    (real / "skills").mkdir(parents=True)
    (repo / "link").symlink_to(real)
    reporter = Reporter()

    check_gitignored(repo / "link" / "skills", reporter)

    assert codes(reporter) == []


def test_a_project_scope_searches_its_ancestors_not_only_itself(tmp_path: Path) -> None:
    """mise config is HIERARCHICAL: an ancestor's ``[[hooks.enter]]`` fires in a child.

    Confirmed against mise 2026.8.10, which printed the ancestor hook's output
    from the child directory. ``~/code/33GOD/mise.toml`` is wired to the retired
    projector with eight components beneath it, and
    ``~/code/intelliforia-mobile/extension`` is a live project whose own
    ``mise.toml`` is clean while its parent's is not. Searching only the project
    root reports neither.
    """
    home = tmp_path
    parent = write_mise(tmp_path / "mono", "[[hooks.enter]]", 'run = "sync-skills.py"')
    child = tmp_path / "mono" / "child"
    write_mise(child, "[tools]", 'python = "3.12"')
    reporter = Reporter()

    check_incumbent_engine(environment.incumbent_search_roots(child, home, []), reporter)

    finding = only(reporter, Code.W_INCUMBENT_ENGINE_ACTIVE)
    assert finding.path == parent


def test_the_ancestor_walk_stops_at_home(tmp_path: Path) -> None:
    """Above a user's home is not that user's configuration, and must not be read."""
    home = tmp_path / "home"
    outside = write_mise(tmp_path, "[[hooks.enter]]", 'run = "sync-skills.py"')
    project = home / "code" / "proj"
    project.mkdir(parents=True)

    roots = environment.incumbent_search_roots(project, home, [])

    assert outside.parent not in roots
    assert roots == [project, home / "code", home]


def test_a_checkout_outside_home_still_gets_its_ancestors(tmp_path: Path) -> None:
    """The home bound must not become an exemption for /srv or /opt checkouts."""
    home = tmp_path / "home"
    home.mkdir()
    project = tmp_path / "srv" / "work" / "proj"
    project.mkdir(parents=True)

    roots = environment.incumbent_search_roots(project, home, [])

    assert tmp_path / "srv" / "work" in roots
    assert tmp_path / "srv" in roots


def test_global_scope_searches_home_and_dot_agents_not_only_the_registry(
    tmp_path: Path,
) -> None:
    """The registry is a SOURCE. The configs that write ``~/.agents/skills`` live in
    ``$HOME`` and ``$HOME/.agents``, and searching the registry ladder instead
    reported neither -- verified end-to-end before the fix, with a
    ``sync-skills.py --scope global`` hook in both places and no warning."""
    home = tmp_path / "home"
    at_home = write_mise(home, "[[hooks.enter]]", 'run = "sync-skills.py --scope global"')
    at_agents = write_mise(home / ".agents", "[[hooks.enter]]", 'run = "provision-packs.py"')
    registry = tmp_path / "registry"
    registry.mkdir()
    reporter = Reporter()

    check_incumbent_engine(environment.incumbent_search_roots(None, home, [registry]), reporter)

    assert codes(reporter) == [
        Code.W_INCUMBENT_ENGINE_ACTIVE,
        Code.W_INCUMBENT_ENGINE_ACTIVE,
    ]
    assert [f.path for f in reporter.findings] == [at_home, at_agents]


def test_a_project_scope_does_not_search_the_registry(tmp_path: Path) -> None:
    """The registry's own tasks are wired ``--scope project --root <the registry>``:
    they write the REGISTRY's root, not this project's. Naming them under a project
    scope would be a wolf-cry on every sync in every repo on the machine."""
    home = tmp_path
    registry = tmp_path / "registry"
    write_mise(registry, "[[hooks.enter]]", 'run = "sync-skills.py"')
    project = tmp_path / "proj"
    project.mkdir()
    reporter = Reporter()

    check_incumbent_engine(environment.incumbent_search_roots(project, home, [registry]), reporter)

    assert codes(reporter) == []


def test_two_wired_configs_in_one_scope_carry_distinct_messages(tmp_path: Path) -> None:
    """The renderer groups findings by CODE and prints only the head's detail lines.
    With the ancestor walk, a parent and a child are both commonly wired (eight
    33GOD components are), and a message of ``config.name`` made both read
    "wired in mise.toml" -- so the reader could not tell which file the shown lines
    came from."""
    home = tmp_path
    write_mise(tmp_path / "mono", "[[hooks.enter]]", 'run = "sync-skills.py"')
    child = tmp_path / "mono" / "child"
    write_mise(child, "[[hooks.enter]]", 'run = "provision-packs.py"')
    reporter = Reporter()

    check_incumbent_engine(environment.incumbent_search_roots(child, home, []), reporter)

    messages = [f.message for f in reporter.findings]
    assert len(messages) == 2
    assert len(set(messages)) == 2


# ---------------------------------------------------------------------------
# ORDER: the checks must run before anything that can refuse out of the loop.
# ---------------------------------------------------------------------------


def test_an_unmanaged_root_still_reports_who_wrote_it(sandbox: Sandbox) -> None:
    """The one case the incumbent check exists for must not be the case it skips.

    ``E_UNMANAGED_ROOT`` -- "this root has entries and no skillex state" -- IS the
    signature of another projector having already written it. It is raised from
    ``diff()``, which used to run BEFORE the environment checks, so the refusal
    abandoned the loop and the run never named the engine responsible. Reproduced
    live on ``~/code/33GOD/momo``: exit 3, ``E_UNMANAGED_ROOT``, and not one word
    about the ``mise.toml`` two lines away that is wired to the retired projector.

    Worse, the obvious way out of the refusal -- delete the root, or ``--forget``
    -- hands it straight back to that projector on the next ``cd``.
    """
    write_catalog(sandbox.registry, "demo")
    sandbox.write_global_manifest(skills=["demo"])
    project = sandbox.project(manifest={"skills": ["demo"]})
    write_mise(project, "[[hooks.enter]]", 'run = "python3 .mise/scripts/sync-skills.py"')
    # A root some OTHER engine wrote: real entries, no skillex receipt.
    foreign = sandbox.project_root_of(project) / "handwritten"
    foreign.mkdir(parents=True)
    (foreign / "SKILL.md").write_text("# hand-written\n", encoding="utf-8")

    code, payload = run_sync_json("--dry-run", cwd=project)

    assert code == EXIT_REFUSED
    reported = codes_in(payload)
    assert Code.E_UNMANAGED_ROOT.value in reported
    assert Code.W_INCUMBENT_ENGINE_ACTIVE.value in reported


def test_a_manifest_that_cannot_resolve_still_reports_who_wrote_it(sandbox: Sandbox) -> None:
    """Same property one stage earlier: ``compose()`` can refuse too."""
    sandbox.write_global_manifest(skills=[])
    project = sandbox.project(manifest={"skills": ["nope"]})
    write_mise(project, "[[hooks.enter]]", 'run = "python3 .mise/scripts/sync-skills.py"')

    code, payload = run_sync_json("--dry-run", cwd=project)

    assert code != 0
    assert Code.W_INCUMBENT_ENGINE_ACTIVE.value in codes_in(payload)


def test_the_cli_searches_a_projects_ancestors_too(sandbox: Sandbox) -> None:
    """The wiring, not just the helper: `skillex sync` must pass the ancestor list.

    Unit-testing ``incumbent_search_roots`` alone cannot catch sync.py handing
    ``[target.base]`` to the check, which is what it did.
    """
    write_catalog(sandbox.registry, "demo")
    sandbox.write_global_manifest(skills=["demo"])
    project = sandbox.project(manifest={"skills": ["demo"]})
    write_mise(project.parent, "[[hooks.enter]]", 'run = "python3 sync-skills.py"')

    _, payload = run_sync_json("--dry-run", cwd=project)

    assert Code.W_INCUMBENT_ENGINE_ACTIVE.value in codes_in(payload)
