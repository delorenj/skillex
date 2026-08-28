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
    if ignored is None or ignored.returncode == 0:
        return  # ignored, or git could not tell us
    reporter.emit(
        Code.W_PROJECTION_NOT_GITIGNORED,
        f"{root} is inside a git repo and is not ignored",
        path=root,
        detail=(
            "It is generated output; committing it produces a diff on every sync",
            "and restores machine-specific symlinks on someone else's checkout.",
        ),
        fix=f"add /{root.name} to {inside.stdout.strip()}/.gitignore or .git/info/exclude.",
    )


def check_incumbent_engine(search_roots: list[Path], reporter: Reporter) -> None:
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
            f"another projector is still wired in {config.name}",
            path=config,
            detail=(
                *(f"{config}:{number}  {text}" for number, text in hits[:6]),
                "That engine has no sets[] support; running it resolves zero skills",
                "and then prunes every link skillex just wrote.",
            ),
            fix="repoint those tasks and hooks at `skillex sync`, or remove them.",
        )


def check_rival_lockfile(home: Path, reporter: Reporter) -> None:
    """Note a third-party skill installer's lock file. Never read, never written."""
    lockfile = home / RIVAL_LOCKFILE
    if not lockfile.is_file():
        return
    try:
        size = lockfile.stat().st_size
    except OSError:
        return
    reporter.emit(
        Code.W_RIVAL_LOCKFILE,
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
]
