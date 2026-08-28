"""Read-only checks on the machine sync is about to write to.

Sync owns one directory per scope and coordinates with nothing. That is a
deliberate limit -- an advisory lock cannot reach a mise hook, a systemd unit or
a third-party installer -- so the honest alternative is to look for the other
writers and *say so*, every run, instead of quietly losing a race with them.

Everything here is read-only, best-effort, and never fatal: a check that cannot
answer stays silent rather than guessing. A false alarm on every run would train
the eye to skip the real one.
"""

from __future__ import annotations

import subprocess
from collections.abc import Sequence
from pathlib import Path

from skillex.core.diagnostics import Code, Reporter

#: Projectors that also write an activation root. Both ship in this repo's
#: ``.mise/scripts/`` and are wired into ``mise.toml`` tasks and ``[[hooks.enter]]``.
#:
#: ``sync-skills.py`` is the dangerous one and the danger is specific: it has
#: **no ``sets[]`` support at all**, so against a sets-only manifest it resolves
#: zero skills, and its reconcile step then unlinks every symlink whose target
#: lies inside the registry -- i.e. everything `skillex sync` just wrote -- and
#: exits 0. Nothing about that looks like a failure.
INCUMBENT_SCRIPTS = ("sync-skills.py", "provision-packs.py")

#: A lock file written by a third-party skill installer. Sync never reads or
#: writes it; its presence just means something else also manages skills here.
RIVAL_LOCKFILE = Path(".agents") / ".skill-lock.json"

_GIT_TIMEOUT_SECONDS = 5

#: Cap on a ``mise.toml`` this module will read into memory. A real one is a few
#: KB; a megabyte is already absurd. The guard exists because the ancestor walk
#: means this module now opens config files it did NOT author -- ``/mise.toml``,
#: an ancestor in a shared tree -- and ``read_text()`` on a pathological file
#: (a symlink to a huge regular file; ``is_file()`` follows it) would OOM and
#: kill the sync from inside a check documented as best-effort and never fatal.
_MAX_CONFIG_BYTES = 1_000_000


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str] | None:
    """Run a read-only git command, or return None if git cannot answer."""
    try:
        return subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def check_gitignored(root: Path, reporter: Reporter) -> None:
    """Warn when a generated activation root inside a repo is not ignored.

    A projection is generated output that a controller rewrites; committing it
    means every sync produces a diff, and a checkout on another machine restores
    symlinks pointing at paths that do not exist there. Both live roots are
    correctly ignored today (``~/.agents/.git/info/exclude`` covers one and
    ``skillex/.gitignore`` the other), which is exactly why a regression here
    would be easy to miss.
    """
    parent = root.parent
    if not parent.is_dir():
        return
    inside = _git(["rev-parse", "--show-toplevel"], parent)
    if inside is None or inside.returncode != 0:
        return  # not a repo, or no git available: nothing to say
    ignored = _git(["check-ignore", "-q", str(root)], parent)
    if ignored is None or ignored.returncode != 1:
        # 0 is "ignored". Anything else is git declining to answer -- 128 is what
        # it returns for a path beyond a symbolic link, and for a repo whose
        # state it will not read -- and this module guesses at nothing.
        return
    if not root.exists() and not root.is_symlink():
        # The root is not there YET; this run is about to create it, as a
        # DIRECTORY. A directory-only pattern -- `.agents/skills/`, the canonical
        # spelling and the one in this machine's core.excludesFile -- cannot match
        # a path with no directory on disk behind it, so asking about the bare
        # path warns about a repo that is already configured correctly, on the one
        # run where the user has least reason to distrust it: the first. Ask
        # instead about the shape sync is going to write.
        as_dir = _git(["check-ignore", "-q", f"{root}/"], parent)
        if as_dir is None or as_dir.returncode != 1:
            return
    toplevel = inside.stdout.strip()
    try:
        rule = "/" + str(root.relative_to(toplevel))
    except ValueError:  # pragma: no cover - root is always under its own toplevel
        rule = f"/{root.name}"
    reporter.emit(
        Code.W_PROJECTION_NOT_GITIGNORED,
        f"{root} is inside a git repo and is not ignored",
        path=root,
        detail=(
            "It is generated output; committing it produces a diff on every sync",
            "and restores machine-specific symlinks on someone else's checkout.",
        ),
        # The rule is anchored at the REPO TOP-LEVEL, because that is where the
        # file being edited lives -- `/skills` there does not ignore
        # `.agents/skills`, it ignores an unrelated top-level `skills/` (a real
        # directory in more than one repo here), so following that advice both
        # leaves the warning firing and untracks something the user wanted.
        # No trailing slash: a directory-only rule does not cover the root in
        # alias mode, where it is a symlink and `git add -A` stages it.
        fix=f"add {rule} to {toplevel}/.gitignore or .git/info/exclude.",
    )


def incumbent_search_roots(
    base: Path | None, home: Path, registry_roots: Sequence[Path]
) -> list[Path]:
    """Every directory whose ``mise.toml`` can fire against this scope's root.

    Two things make the naive answer (``[base]``, or the registry ladder for
    global) wrong, and both are measured on this machine rather than imagined:

    * **mise config is hierarchical.** A ``[[hooks.enter]]`` in an ANCESTOR runs
      when you cd into a child -- verified with mise 2026.8.10, which printed the
      ancestor hook's output from the child directory. ``~/code/33GOD/mise.toml``
      is wired to the retired projector and eight 33GOD components sit under it;
      ``~/code/intelliforia-mobile/extension`` is a project whose own
      ``mise.toml`` is clean while its parent's is not. Looking at one directory
      reports none of that.

    * **the registry is a SOURCE, not a writer of the global root.** At global
      scope the honest place to look is ``$HOME`` and ``$HOME/.agents`` -- the
      only configs whose hooks fire against ``~/.agents/skills``. The registry
      checkout is kept in the list because its own tasks do project (that is how
      ``skills:sync:global`` is spelled here), not because it is the primary
      suspect.

    The walk stops at ``home`` when it passes through it -- above a user's home is
    not that user's configuration -- and at the filesystem root otherwise, so a
    checkout outside ``$HOME`` is not silently exempt. Only ``mise.toml`` is ever
    opened, and only by :func:`check_incumbent_engine`.
    """
    out: list[Path] = []
    seen: set[Path] = set()

    def add(directory: Path) -> None:
        if directory not in seen:
            seen.add(directory)
            out.append(directory)

    def add_with_ancestors(start: Path) -> None:
        add(start)
        current = start
        # Stop at ``home`` when the walk passes through it -- above a user's home
        # is not that user's configuration -- and otherwise at the filesystem
        # root, so a checkout outside ``$HOME`` (``/srv/work``, ``/opt/...``) is
        # not silently exempt from the same hierarchy mise itself honours. Each
        # rung costs one ``is_file()``; the depth is a handful.
        while current != home and current.parent != current:
            current = current.parent
            add(current)

    if base is not None:
        # A project scope. The registry's own tasks are wired `--scope project
        # --root <the registry>`: they write the REGISTRY's root, not this
        # project's, so naming them here would be a wolf-cry on every sync.
        add_with_ancestors(base)
        return out
    add(home)
    add(home / ".agents")
    for root in registry_roots:
        add_with_ancestors(root)
    return out


def check_incumbent_engine(search_roots: Sequence[Path], reporter: Reporter) -> None:
    """Warn when another projector is still wired to write this scope's root.

    Reports the file and LINE, because "something else also syncs skills" is not
    actionable and "mise.toml:121 runs sync-skills.py --scope global" is.

    Deliberately a runtime warning rather than a one-time migration: a
    ``mise.toml`` edit reaches this repo, and the same wiring is templated into
    every adopting project. Only a check that runs on every sync survives the
    long tail.
    """
    seen: set[Path] = set()
    for search_root in search_roots:
        config = search_root / "mise.toml"
        if not config.is_file() or config in seen:
            continue
        seen.add(config)
        try:
            if config.stat().st_size > _MAX_CONFIG_BYTES:
                continue
            lines = config.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            # UnicodeDecodeError is a ValueError, NOT an OSError: a mise.toml with
            # one non-UTF-8 byte in it -- a latin-1 name, a stray copy-paste --
            # would otherwise escape this best-effort check and abort the whole
            # sync from inside a warning that is documented as never fatal.
            continue
        hits = [
            (number, stripped)
            for number, stripped in ((n, ln.strip()) for n, ln in enumerate(lines, start=1))
            # A COMMENT that names the retired engine is documentation, not wiring.
            # Without this the note explaining why the hooks were removed trips the
            # very warning it explains -- and a check that cries wolf on a correctly
            # migrated config is worse than no check, because the next reader learns
            # to skip it.
            if not stripped.startswith("#")
            and any(script in stripped for script in INCUMBENT_SCRIPTS)
        ]
        if not hits:
            continue
        reporter.emit(
            Code.W_INCUMBENT_ENGINE_ACTIVE,
            # The FULL path, not `config.name`: with the ancestor walk two
            # configs in one scope both spell "mise.toml", the renderer collapses
            # findings that share a message, and one of the two files' hit lines
            # disappears. Verified on `~/code/33GOD/momo`, where the parent and
            # the child are both wired.
            f"another projector is still wired in {config}",
            path=config,
            detail=(
                *(f"{config}:{number}  {text}" for number, text in hits[:6]),
                "That engine has no sets[] support; running it resolves zero skills",
                "and then prunes every link skillex just wrote.",
            ),
            fix="repoint those tasks and hooks at `skillex sync`, or remove them.",
        )


def check_rival_lockfile(home: Path, reporter: Reporter) -> None:
    """Note a third-party skill installer's lock file. Never read, never written.

    INFO rather than WARNING on purpose -- see :attr:`Code.I_RIVAL_LOCKFILE`. The
    file is a fact about the machine that the user may fully intend to keep, so a
    warning here would fire on every healthy global sync and never clear.
    """
    lockfile = home / RIVAL_LOCKFILE
    if not lockfile.is_file():
        return
    try:
        size = lockfile.stat().st_size
    except OSError:
        return
    reporter.emit(
        Code.I_RIVAL_LOCKFILE,
        f"another skill installer keeps state at {lockfile}",
        path=lockfile,
        detail=(
            f"{size} bytes; skillex neither reads nor writes it.",
            "Skills it installed are not in any manifest, so sync treats them as foreign.",
        ),
        fix="ignore this if you still use that installer; otherwise remove the file.",
    )


__all__ = [
    "INCUMBENT_SCRIPTS",
    "RIVAL_LOCKFILE",
    "check_gitignored",
    "check_incumbent_engine",
    "check_rival_lockfile",
    "incumbent_search_roots",
]
