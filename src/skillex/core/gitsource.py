"""Read a foreign repository's skill trees out of its LOCAL object database.

**This module never touches the network, and that is a load-bearing property
rather than a nicety.** ``paths.py`` states the invariant four times over --
"``sync-skills.py`` is the only surface allowed to CLONE, so it owns the name on
disk; everything else is a read-only consumer and follows it" -- and
``SkillEntry.from_spec`` / ``SetEntry.from_spec`` each repeat it in refusal prose
that a user can read. Vendoring does not reverse that. It reads a checkout the
operator already has; a ref that is not in the local object store is a refusal
carrying the ``git fetch`` you should run, not an implicit fetch.

Two things enforce it mechanically rather than by convention:

* the subprocess environment forces ``GIT_TERMINAL_PROMPT=0``,
  ``GIT_ASKPASS=/bin/false`` and ``GIT_SSH_COMMAND=/bin/false``, so even a
  mis-declared ref cannot hang on a credential prompt or open a connection;
* :data:`_ALLOWED_VERBS` is the complete set of git subcommands this module may
  run, checked at the one place that spawns a process. ``fetch``, ``clone``,
  ``pull`` and ``remote`` are not in it.

**Content comes from a commit, never from the worktree.** The four repositories
this was built for are, right now, 42 and 6 entries dirty, one commit ahead of the
gitlink that records them, and being written by another agent between tool calls.
Addressing ``<commit>:<path>`` is the only way the result is reproducible -- and
it is also the only way to *see* that ``33GOD/skills/`` is sixteen mode-``120000``
blobs rather than sixteen skills, which is the difference between refusing loudly
and publishing sixteen absolute paths that resolve on one machine.
"""

from __future__ import annotations

import io
import os
import shutil
import stat
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from skillex.core.models import is_safe_relpath

#: Every git subcommand this module is permitted to run. The check is in
#: :meth:`GitCli._run`, so a new call site cannot quietly add a network verb.
_ALLOWED_VERBS = frozenset({"rev-parse", "ls-tree", "archive", "config", "cat-file"})

#: git tree entry modes, spelled out so call sites read as prose.
MODE_TREE = "040000"
MODE_BLOB = "100644"
MODE_EXEC = "100755"
MODE_SYMLINK = "120000"
MODE_GITLINK = "160000"

_TIMEOUT = 120


class SourceReadError(Exception):
    """A git read failed, or returned something this module refuses to interpret."""


@dataclass(frozen=True)
class TreeEntry:
    """One entry of a git tree listing.

    ``path`` is relative to the tree that was listed, not to the repository root,
    because that is what ``git ls-tree <commit>:<subdir>`` reports and re-rooting
    it here would lose the ability to say "this name, inside that subdir".
    """

    mode: str
    kind: str
    oid: str
    path: str

    @property
    def is_tree(self) -> bool:
        return self.mode == MODE_TREE

    @property
    def is_symlink(self) -> bool:
        return self.mode == MODE_SYMLINK

    @property
    def is_gitlink(self) -> bool:
        return self.mode == MODE_GITLINK

    @property
    def is_executable(self) -> bool:
        return self.mode == MODE_EXEC


class GitReader(Protocol):
    """The seam vendoring reads through.

    A Protocol and not a concrete class so the whole planner is testable with no
    git binary, no network and no fixture repository -- and, decisively, so a test
    can express a mode ``120000`` or ``160000`` tree entry, which is painful to
    construct on disk and is exactly the shape the refusals exist for.
    """

    def is_repo(self, checkout: Path) -> bool: ...

    def origin_url(self, checkout: Path) -> str | None: ...

    def resolve_commit(self, checkout: Path, ref: str) -> str: ...

    def ref_kind(self, checkout: Path, ref: str) -> str: ...

    def tree_oid(self, checkout: Path, commit: str, path: str) -> str: ...

    def ls_tree(
        self, checkout: Path, commit: str, path: str, *, recursive: bool = False
    ) -> list[TreeEntry]: ...

    def export(self, checkout: Path, commit: str, path: str, dest: Path) -> None: ...


class GitCli:
    """:class:`GitReader` backed by the ``git`` binary, hermetically."""

    def __init__(self, binary: str | None = None) -> None:
        self._binary = binary or shutil.which("git") or "git"

    # -- process ------------------------------------------------------------

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(
            {
                # Nothing may prompt, and nothing may dial out. A ref that is not
                # here is a refusal, not a fetch.
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_ASKPASS": "/bin/false",
                "SSH_ASKPASS": "/bin/false",
                "GIT_SSH_COMMAND": "/bin/false",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_ATTR_NOSYSTEM": "1",
                "LC_ALL": "C",
            }
        )
        return env

    def _run(self, checkout: Path, *args: str, text: bool = True) -> subprocess.CompletedProcess:  # type: ignore[type-arg]
        if not args or args[0] not in _ALLOWED_VERBS:
            raise SourceReadError(
                f"refusing to run 'git {args[0] if args else ''}': vendoring reads a local "
                f"object database and may only run {sorted(_ALLOWED_VERBS)}"
            )
        try:
            return subprocess.run(
                [self._binary, "--no-optional-locks", *args],
                cwd=checkout,
                env=self._env(),
                capture_output=True,
                check=False,
                timeout=_TIMEOUT,
                text=text,
            )
        except OSError as e:
            raise SourceReadError(f"cannot run git in {checkout}: {e}") from e
        except subprocess.TimeoutExpired as e:
            raise SourceReadError(f"git timed out in {checkout}: {' '.join(args)}") from e

    def _out(self, checkout: Path, *args: str) -> str:
        proc = self._run(checkout, *args)
        if proc.returncode != 0:
            raise SourceReadError(
                f"git {' '.join(args)} failed in {checkout}: {proc.stderr.strip() or 'no output'}"
            )
        return str(proc.stdout)

    # -- GitReader ----------------------------------------------------------

    def is_repo(self, checkout: Path) -> bool:
        if not checkout.is_dir():
            return False
        proc = self._run(checkout, "rev-parse", "--git-dir")
        return proc.returncode == 0

    def origin_url(self, checkout: Path) -> str | None:
        proc = self._run(checkout, "config", "--get", "remote.origin.url")
        if proc.returncode != 0:
            return None
        url = str(proc.stdout).strip()
        return url or None

    def resolve_commit(self, checkout: Path, ref: str) -> str:
        # `^{commit}` peels an annotated tag; `--end-of-options` makes a ref that
        # looks like a flag impossible even before the pattern in the model.
        out = self._out(
            checkout, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}"
        ).strip()
        if len(out) != 40:
            raise SourceReadError(f"{ref!r} did not resolve to a commit in {checkout}")
        return out

    def ref_kind(self, checkout: Path, ref: str) -> str:
        """``branch`` | ``tag`` | ``commit`` | ``unknown``. Advisory only."""
        for candidate, kind in (
            (f"refs/heads/{ref}", "branch"),
            (f"refs/remotes/{ref}", "branch"),
            (f"refs/tags/{ref}", "tag"),
        ):
            proc = self._run(
                checkout, "rev-parse", "--verify", "--quiet", "--end-of-options", candidate
            )
            if proc.returncode == 0:
                return kind
        proc = self._run(checkout, "rev-parse", "--verify", "--quiet", "--end-of-options", ref)
        return "commit" if proc.returncode == 0 else "unknown"

    def tree_oid(self, checkout: Path, commit: str, path: str) -> str:
        spec = f"{commit}:{path}" if path else f"{commit}^{{tree}}"
        out = self._out(checkout, "rev-parse", "--verify", "--quiet", "--end-of-options", spec)
        return out.strip()

    def ls_tree(
        self, checkout: Path, commit: str, path: str, *, recursive: bool = False
    ) -> list[TreeEntry]:
        spec = f"{commit}:{path}" if path else f"{commit}^{{tree}}"
        args = ["ls-tree", "-z"]
        if recursive:
            # -t so directories are still reported; the planner needs to see a
            # nested tree to know it walked one, and a `120000` inside a subdir is
            # only visible with -r.
            args.extend(["-r", "-t"])
        args.extend(["--full-tree", spec])
        proc = self._run(checkout, *args)
        if proc.returncode != 0:
            raise SourceReadError(
                f"{path or '<root>'} does not exist at {commit[:8]} in {checkout}: "
                f"{proc.stderr.strip() or 'no such path'}"
            )
        return _parse_ls_tree(str(proc.stdout))

    def export(self, checkout: Path, commit: str, path: str, dest: Path) -> None:
        """Extract ``<commit>:<path>`` into ``dest`` as real files.

        ``git archive`` rather than a per-blob ``cat-file`` loop: one process per
        skill instead of one per file, and the tar carries the executable bit,
        which a bytes-only copy would silently drop from every ``scripts/`` entry.
        """
        spec = f"{commit}:{path}" if path else f"{commit}^{{tree}}"
        proc = self._run(checkout, "archive", "--format=tar", spec, text=False)
        if proc.returncode != 0:
            stderr = proc.stderr.decode("utf-8", "replace") if proc.stderr else ""
            raise SourceReadError(f"git archive {spec} failed in {checkout}: {stderr.strip()}")
        extract_tar(bytes(proc.stdout), dest)


def _parse_ls_tree(raw: str) -> list[TreeEntry]:
    """Parse ``ls-tree -z`` output: ``<mode> SP <type> SP <oid> TAB <path> NUL``."""
    entries: list[TreeEntry] = []
    for record in raw.split("\0"):
        if not record:
            continue
        meta, _, path = record.partition("\t")
        parts = meta.split()
        if not path or len(parts) < 3:
            raise SourceReadError(f"unparseable ls-tree record: {record!r}")
        entries.append(TreeEntry(mode=parts[0], kind=parts[1], oid=parts[2], path=path))
    return entries


def extract_tar(blob: bytes, dest: Path) -> None:
    """Extract a git-produced tar into ``dest``, validating every member.

    Refuses anything that is not a regular file or a directory, and anything whose
    name is not a safe relative path. ``git archive`` will not normally produce
    such a member, but this is the boundary where foreign bytes become files on
    this disk and the check costs nothing.
    """
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as tar:
        for member in tar.getmembers():
            name = member.name.removeprefix("./").rstrip("/")
            if not name or name == ".":
                continue
            if member.issym() or member.islnk():
                raise SourceReadError(f"refusing symlink member {member.name!r} from the archive")
            if not (member.isfile() or member.isdir()):
                raise SourceReadError(
                    f"refusing non-regular member {member.name!r} from the archive"
                )
            if not is_safe_relpath(name):
                raise SourceReadError(f"refusing unsafe member path {member.name!r}")
            target = dest / name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            handle = tar.extractfile(member)
            if handle is None:
                raise SourceReadError(f"unreadable member {member.name!r}")
            with handle, open(target, "wb") as out:
                shutil.copyfileobj(handle, out)
            # The archive's mode is git's, i.e. 100644 or 100755 and nothing else.
            # Normalized rather than copied so a hand-built tar cannot set setuid.
            mode = 0o755 if member.mode & stat.S_IXUSR else 0o644
            os.chmod(target, mode)


__all__ = [
    "MODE_BLOB",
    "MODE_EXEC",
    "MODE_GITLINK",
    "MODE_SYMLINK",
    "MODE_TREE",
    "GitCli",
    "GitReader",
    "SourceReadError",
    "TreeEntry",
    "extract_tar",
]
