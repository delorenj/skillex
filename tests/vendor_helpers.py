"""Fixtures for the vendoring tests: a fake git reader and source-tree builders.

Why a fake and not a real repository for the unit tests: mode ``120000`` and mode
``160000`` tree entries are the two shapes every refusal in ``core/vendor.py``
exists for, and they are the two shapes that are painful to construct on disk. The
fake takes both as data. ``tests/integration/test_vendor_end_to_end.py`` runs the
real :class:`~skillex.core.gitsource.GitCli` against real ``git init`` fixtures so
the two cannot silently diverge.

Nothing here touches the network, ``~/code/33GOD``, or anything outside
``tmp_path``.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
from dataclasses import dataclass, field
from pathlib import Path

from skillex.core.gitsource import (
    MODE_BLOB,
    MODE_EXEC,
    MODE_GITLINK,
    MODE_SYMLINK,
    MODE_TREE,
    SourceReadError,
    TreeEntry,
)

SKILL_BODY = "---\nname: {name}\ndescription: fixture skill {name}\n---\n\n# {name}\n"


def write_source_skill(
    parent: Path,
    name: str,
    *,
    body: str | None = None,
    files: dict[str, str] | None = None,
    executable: tuple[str, ...] = (),
) -> Path:
    """Create a skill directory inside a fake source repository."""
    skill = parent / name
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(body if body is not None else SKILL_BODY.format(name=name))
    for rel, content in (files or {}).items():
        target = skill / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        if rel in executable:
            os.chmod(target, 0o755)
    return skill


def write_source_repo(
    base: Path,
    name: str,
    *,
    skills: dict[str, dict[str, str]] | None = None,
    subdir: str = "skills",
) -> Path:
    """A fake repo holding ``<subdir>/<skill>/SKILL.md`` for each declared skill."""
    root = base / name
    parent = root / subdir if subdir else root
    parent.mkdir(parents=True, exist_ok=True)
    for skill_name, files in (skills or {}).items():
        write_source_skill(parent, skill_name, files=files)
    return root


@dataclass
class FakeRepo:
    """One repository in the fake: a ref table over on-disk trees."""

    #: ``{ref: commit}``; a commit is any opaque 40-char-ish label.
    refs: dict[str, str]
    #: ``{commit: directory}`` -- the worktree that commit is defined to hold.
    trees: dict[str, Path]
    origin: str | None = None
    #: ``{ref: "branch" | "tag" | "commit"}``.
    kinds: dict[str, str] = field(default_factory=dict)
    #: Repo-relative paths reported as mode 160000 (a nested submodule).
    gitlinks: set[str] = field(default_factory=set)


class FakeGit:
    """A :class:`~skillex.core.gitsource.GitReader` over directories in ``tmp_path``.

    Records every call in :attr:`calls` so a test can assert what was asked for --
    in particular that two sources sharing one ``checkout`` resolve it once.
    """

    def __init__(self) -> None:
        self.repos: dict[str, FakeRepo] = {}
        self.calls: list[tuple[str, str]] = []

    def add(
        self,
        checkout: Path,
        *,
        tree: Path,
        refs: dict[str, str] | None = None,
        origin: str | None = None,
        kinds: dict[str, str] | None = None,
        gitlinks: set[str] | None = None,
    ) -> None:
        commit = "0" * 40
        table = refs or {"main": commit}
        self.repos[str(checkout)] = FakeRepo(
            refs=table,
            trees=dict.fromkeys(table.values(), tree),
            origin=origin,
            kinds=kinds or dict.fromkeys(table, "branch"),
            gitlinks=gitlinks or set(),
        )

    def retarget(self, checkout: Path, ref: str, *, commit: str, tree: Path) -> None:
        """Move a ref to a new commit backed by a different directory."""
        repo = self.repos[str(checkout)]
        repo.refs[ref] = commit
        repo.trees[commit] = tree

    # -- GitReader ----------------------------------------------------------

    def _repo(self, checkout: Path) -> FakeRepo:
        repo = self.repos.get(str(checkout))
        if repo is None:
            raise SourceReadError(f"no fake repo registered at {checkout}")
        return repo

    def is_repo(self, checkout: Path) -> bool:
        return str(checkout) in self.repos

    def origin_url(self, checkout: Path) -> str | None:
        return self._repo(checkout).origin

    def resolve_commit(self, checkout: Path, ref: str) -> str:
        self.calls.append(("resolve_commit", f"{checkout}:{ref}"))
        repo = self._repo(checkout)
        if ref in repo.refs:
            return repo.refs[ref]
        if ref in repo.trees:
            return ref
        raise SourceReadError(f"{ref!r} is not in the local object store at {checkout}")

    def ref_kind(self, checkout: Path, ref: str) -> str:
        return self._repo(checkout).kinds.get(ref, "commit")

    def _base(self, checkout: Path, commit: str, path: str) -> Path:
        repo = self._repo(checkout)
        tree = repo.trees.get(commit)
        if tree is None:
            raise SourceReadError(f"unknown commit {commit} at {checkout}")
        target = tree / path if path else tree
        if not target.exists() and not target.is_symlink():
            raise SourceReadError(f"{path!r} does not exist at {commit} in {checkout}")
        return target

    def tree_oid(self, checkout: Path, commit: str, path: str) -> str:
        base = self._base(checkout, commit, path)
        digest = hashlib.sha256()
        for entry in self.ls_tree(checkout, commit, path, recursive=True):
            digest.update(f"{entry.mode} {entry.path}\n".encode())
            candidate = base / entry.path
            if entry.mode in (MODE_BLOB, MODE_EXEC):
                digest.update(candidate.read_bytes())
        return digest.hexdigest()

    def ls_tree(
        self, checkout: Path, commit: str, path: str, *, recursive: bool = False
    ) -> list[TreeEntry]:
        self.calls.append(("ls_tree", f"{checkout}:{commit}:{path}"))
        repo = self._repo(checkout)
        base = self._base(checkout, commit, path)
        tree = repo.trees[commit]
        out: list[TreeEntry] = []

        def visit(current: Path) -> None:
            for child in sorted(current.iterdir()):
                rel = child.relative_to(base).as_posix()
                repo_rel = child.relative_to(tree).as_posix()
                if repo_rel in repo.gitlinks:
                    out.append(TreeEntry(MODE_GITLINK, "commit", "0" * 40, rel))
                    continue
                if child.is_symlink():
                    out.append(TreeEntry(MODE_SYMLINK, "blob", "1" * 40, rel))
                    continue
                if child.is_dir():
                    out.append(TreeEntry(MODE_TREE, "tree", "2" * 40, rel))
                    if recursive:
                        visit(child)
                    continue
                mode = MODE_EXEC if child.stat().st_mode & stat.S_IXUSR else MODE_BLOB
                out.append(TreeEntry(mode, "blob", "3" * 40, rel))

        visit(base)
        return sorted(out, key=lambda e: e.path)

    def export(self, checkout: Path, commit: str, path: str, dest: Path) -> None:
        self.calls.append(("export", f"{checkout}:{commit}:{path}"))
        base = self._base(checkout, commit, path)
        shutil.copytree(base, dest, symlinks=True, dirs_exist_ok=True)


def sources_toml(*blocks: str, version: int = 1) -> str:
    return f"version = {version}\n\n" + "\n\n".join(blocks) + "\n"


def source_block(name: str, repo: str, version_ref: str, **fields: str) -> str:
    lines = [
        "[[source]]",
        f'name = "{name}"',
        f'repo = "{repo}"',
        f'version = "{version_ref}"',
    ]
    lines.extend(f"{key} = {value}" for key, value in fields.items())
    return "\n".join(lines)


__all__ = [
    "FakeGit",
    "FakeRepo",
    "source_block",
    "sources_toml",
    "write_source_repo",
    "write_source_skill",
]
