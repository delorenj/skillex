"""Shared test fixtures.

Two layers live here:

* the two original path fixtures (``repo_root``, ``fixtures_dir``);
* a programmatic fixture-registry builder for ``skillex sync``.

**Everything is built at runtime.** No symlink fixture is ever committed: a
dangling link in git is fragile across checkouts, platforms and archive formats,
and half the shapes sync must handle *are* dangling links. The builders below
reproduce the live shapes measured on the author's machine (``sets/min-global``'s
``.system/`` + ``.lastagent``, ``sets/hyperframes``'s symlinked set directory,
``sets/n8n``'s embedded real directories, ``packs/Kurzgesagt``'s pack.toml-less
symlink children, ``packs/hermes-base/0.18.2``'s flatten tree) without shipping
any of them.

Every helper is BOTH a module-level function and a fixture of the same name, so a
test module may either request ``write_set`` as a fixture or
``from tests.conftest import write_set``.

.. warning::

   Any test that runs sync must depend on :func:`sandbox`. It repoints ``HOME``,
   ``XDG_STATE_HOME`` and ``PJ_SKILLS_REGISTRY_ROOT`` into ``tmp_path``. Without
   it a test reads (and ``apply()`` WRITES) the real ``~/.agents/skills``, the
   real CLI alias directories and the real XDG state dir.
   ``PJ_SKILLS_REGISTRY_ROOT`` is *exclusive* -- when it is set,
   ``registry_root_candidates()`` returns exactly that one path -- so the registry
   ladder cannot fall through to ``~/code/skillex``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

# ---------------------------------------------------------------------------
# original fixtures - existing tests depend on these
# ---------------------------------------------------------------------------


@pytest.fixture
def repo_root() -> Path:
    """Absolute path to the skillex repo root."""
    return Path(__file__).resolve().parent.parent


@pytest.fixture
def fixtures_dir(repo_root: Path) -> Path:
    """Absolute path to tests/fixtures/."""
    return repo_root / "tests" / "fixtures"


# ---------------------------------------------------------------------------
# member specs
# ---------------------------------------------------------------------------

#: One entry of a composition (a set directory, or a pack.toml-less pack).
#:
#: ``("link",      name, target)``   symlink to something that exists
#: ``("dangling",  name, target)``   symlink to something that does not
#: ``("realdir",   name[, body])``   a real embedded skill dir (ADR-0001 violation)
#: ``("container", name, [leaves])`` a real dir with NO SKILL.md, holding leaf skills
#: ``("file",      name, content)``  a plain file
#:
#: ``target`` is either a :class:`~pathlib.Path` (the link body is computed -
#: absolute, or relative to the composition when ``relative_links=True``) or a
#: :class:`str`, which is written as the link body VERBATIM. The string form is
#: how you reproduce ``packs/Kurzgesagt/hindsight -> ../../all-skills/hindsight/``,
#: the one trailing-slash link in the live tree.
MemberSpec = tuple[Any, ...]

SKILL_MD = "SKILL.md"

DEFAULT_SKILL_BODY = "---\nname: {name}\ndescription: fixture skill {name}\n---\n\n# {name}\n"


# ---------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------


def write_skill(parent: Path, name: str, *, body: str | None = None) -> Path:
    """Create ``parent/name/SKILL.md`` and return the skill directory.

    A real directory holding a regular ``SKILL.md`` - the only shape every
    resolver in the codebase accepts as "a skill".
    """
    skill_dir = parent / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / SKILL_MD).write_text(
        body if body is not None else DEFAULT_SKILL_BODY.format(name=name),
        encoding="utf-8",
    )
    return skill_dir


def make_registry(root: Path) -> Path:
    """Create an empty fixture registry (``all-skills/``, ``sets/``, ``packs/``)."""
    for internal in ("all-skills", "sets", "packs"):
        (root / internal).mkdir(parents=True, exist_ok=True)
    return root


def write_catalog(registry: Path, *names: str, body: str | None = None) -> dict[str, Path]:
    """Create ``registry/all-skills/<name>`` for each name. Returns ``{name: path}``."""
    catalog = registry / "all-skills"
    catalog.mkdir(parents=True, exist_ok=True)
    return {name: write_skill(catalog, name, body=body) for name in names}


def _link_body(base: Path, target: Path | str, *, relative: bool) -> str:
    """The literal string to store in the symlink."""
    if isinstance(target, str):
        return target  # verbatim, trailing slash and all
    if relative:
        return os.path.relpath(target, base)
    return str(target)


def write_members(
    base: Path,
    members: Iterable[MemberSpec],
    *,
    relative_links: bool = False,
) -> Path:
    """Materialize :data:`MemberSpec` entries inside ``base``. Returns ``base``.

    Shared by :func:`write_set` and :func:`write_pack` because a set and a
    pack.toml-less pack are read by the same walker.
    """
    base.mkdir(parents=True, exist_ok=True)
    for spec in members:
        kind = spec[0]
        name = spec[1]
        path = base / name
        if kind in ("link", "dangling"):
            path.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(_link_body(base, spec[2], relative=relative_links), path)
        elif kind == "realdir":
            write_skill(base, name, body=spec[2] if len(spec) > 2 else None)
        elif kind == "container":
            path.mkdir(parents=True, exist_ok=True)
            for leaf in spec[2]:
                write_skill(path, leaf)
        elif kind == "file":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(spec[2], encoding="utf-8")
        else:  # pragma: no cover - a typo in a test, surfaced loudly
            raise ValueError(f"unknown member kind {kind!r} in {spec!r}")
    return base


def write_set(
    registry: Path,
    name: str,
    members: Iterable[MemberSpec] = (),
    *,
    as_symlink_to: Path | None = None,
    relative_links: bool = False,
) -> Path:
    """Create ``registry/sets/<name>`` and return that path.

    ``as_symlink_to`` reproduces the ``sets/hyperframes`` shape: the set BODY is
    built at that (external) path and ``sets/<name>`` becomes a symlink to it.
    ``walk_composition`` resolves the container once and then reads its children
    lexically, which is what makes that shape yield members instead of zero.
    """
    sets_dir = registry / "sets"
    sets_dir.mkdir(parents=True, exist_ok=True)
    set_path = sets_dir / name

    if as_symlink_to is not None:
        body = as_symlink_to
        body.mkdir(parents=True, exist_ok=True)
        write_members(body, members, relative_links=relative_links)
        os.symlink(str(body), set_path)
        return set_path

    write_members(set_path, members, relative_links=relative_links)
    return set_path


def write_tree(base: Path, tree: Mapping[str, Any]) -> Path:
    """Build a nested pack tree under ``base``.

    ``None`` is a LEAF (a real skill dir with a ``SKILL.md``); a mapping is a
    CONTAINER (a real dir with no ``SKILL.md``). An EMPTY mapping is therefore an
    empty container - the shape that produces ``W_PACK_EMPTY_CONTAINER``.
    """
    base.mkdir(parents=True, exist_ok=True)
    for name, value in tree.items():
        if value is None:
            write_skill(base, name)
        else:
            write_tree(base / name, value)
    return base


def _pack_toml(
    name: str,
    *,
    version: str | None,
    description: str,
    declared: Sequence[str],
    flatten: bool,
    policy: Mapping[str, object] | None,
) -> str:
    lines = ["[pack]", f'name = "{name}"']
    if version is not None:
        lines.append(f'version = "{version}"')
    if description:
        lines.append(f'description = "{description}"')
    lines += ["", "[freeform]", "skills = [" + ", ".join(f'"{s}"' for s in declared) + "]"]
    merged: dict[str, object] = dict(policy or {})
    if flatten:
        merged["flatten"] = True
    if merged:
        lines += ["", "[policy]"]
        for key, value in merged.items():
            rendered = str(value).lower() if isinstance(value, bool) else f'"{value}"'
            lines.append(f"{key} = {rendered}")
    return "\n".join(lines) + "\n"


def write_pack(
    registry: Path,
    name: str,
    *,
    version: str | None = None,
    skills: Sequence[str] = (),
    tree: Mapping[str, Any] | None = None,
    members: Iterable[MemberSpec] = (),
    declared: Sequence[str] | None = None,
    pack_toml: bool = True,
    declare_version: bool = True,
    flatten: bool = False,
    policy: Mapping[str, object] | None = None,
    description: str = "",
    extra_files: Mapping[str, str] | None = None,
    relative_links: bool = False,
) -> Path:
    """Create a pack and return its directory (the VERSION dir when versioned).

    Every live pack shape is one call:

    ==========================  =============================================
    live pack                   call
    ==========================  =============================================
    ``packs/Kurzgesagt``        ``write_pack(r, "Kurzgesagt", pack_toml=False,
                                members=[("link", ...), ("dangling", ...)])``
    ``packs/hermes-base``       ``write_pack(r, "hermes-base",
                                version="0.18.2", tree={...}, flatten=True)``
    ``packs/folder-curator``    ``write_pack(r, "folder-curator",
                                declared=["a", "b"],
                                extra_files={"README.md": "..."})``
    ``packs/torrent-movie``     ``write_pack(r, "torrent-movie",
                                skills=["x"], declare_version=False)``
    ==========================  =============================================

    ``version`` drives the on-disk layout: ``packs/<name>/<version>/`` when set,
    ``packs/<name>/`` when ``None``. ``declare_version=False`` writes a
    ``pack.toml`` with no ``version`` key inside a versioned directory.

    ``declared`` defaults to the top-level entries actually created (``skills``
    then ``tree`` keys). Passing it explicitly with no matching directories is the
    manifest-only pack whose members resolve from ``all-skills/``.
    """
    packs_dir = registry / "packs"
    pack_dir = packs_dir / name if version is None else packs_dir / name / version
    pack_dir.mkdir(parents=True, exist_ok=True)

    created: list[str] = []
    for skill in skills:
        write_skill(pack_dir, skill)
        created.append(skill)
    if tree:
        write_tree(pack_dir, tree)
        created += list(tree)
    write_members(pack_dir, members, relative_links=relative_links)

    for filename, content in (extra_files or {}).items():
        target = pack_dir / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    if pack_toml:
        (pack_dir / "pack.toml").write_text(
            _pack_toml(
                name,
                version=version if declare_version else None,
                description=description,
                declared=list(declared) if declared is not None else created,
                flatten=flatten,
                policy=policy,
            ),
            encoding="utf-8",
        )
    return pack_dir


def write_manifest(
    directory: Path, raw: str | Mapping[str, Any] | None = None, **keys: Any
) -> Path:
    """Write ``<directory>/.agents/skills.json`` and return its path.

    ``write_manifest(project, sets=["global"], skills=["hindsight"])`` is the
    normal form. ``raw`` overrides it entirely: a mapping is dumped verbatim (for
    unknown keys or a non-object array), a string is written as-is (for the
    unparseable-JSON cases).
    """
    agents = directory / ".agents"
    agents.mkdir(parents=True, exist_ok=True)
    path = agents / "skills.json"
    if isinstance(raw, str):
        path.write_text(raw, encoding="utf-8")
        return path
    payload: dict[str, Any] = dict(raw) if raw is not None else {}
    payload.update(keys)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# snapshot
# ---------------------------------------------------------------------------


def snapshot(root: Path) -> dict[str, tuple[bool, object]]:
    """A comparable picture of everything under ``root``. Never follows symlinks.

    Maps a ``/``-joined path relative to ``root`` (``""`` for the root itself) to
    ``(is_symlink, readlink-or-inode)``. Assert equality of two snapshots to prove
    a run changed NOTHING - stronger than asserting an empty plan, which would
    still pass if apply() wrote behind the plan's back.

    The inode, not mtime or content: a replaced-then-restored link is a different
    inode, and mtime has coarse granularity on some filesystems.
    """
    out: dict[str, tuple[bool, object]] = {}
    if root.is_symlink():
        return {"": (True, os.readlink(root))}
    if not root.exists():
        return out

    stack: list[tuple[Path, str]] = [(root, "")]
    while stack:
        current, prefix = stack.pop()
        with os.scandir(current) as entries:
            for entry in sorted(entries, key=lambda e: e.name):
                rel = f"{prefix}/{entry.name}" if prefix else entry.name
                if entry.is_symlink():
                    out[rel] = (True, os.readlink(entry.path))
                    continue
                out[rel] = (False, entry.stat(follow_symlinks=False).st_ino)
                if entry.is_dir(follow_symlinks=False):
                    stack.append((Path(entry.path), rel))
    return out


# ---------------------------------------------------------------------------
# sandbox
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Sandbox:
    """A hermetic HOME + registry + XDG state dir for one test."""

    tmp: Path
    home: Path
    registry: Path
    state_home: Path

    @property
    def global_root(self) -> Path:
        """``$HOME/.agents/skills`` - the global activation root."""
        return self.home / ".agents" / "skills"

    @property
    def global_manifest(self) -> Path:
        """``$HOME/.agents/skills.json``."""
        return self.home / ".agents" / "skills.json"

    @property
    def state_dir(self) -> Path:
        """``$XDG_STATE_HOME/skillex/projections`` - where receipts land."""
        return self.state_home / "skillex" / "projections"

    @property
    def all_skills(self) -> Path:
        return self.registry / "all-skills"

    def write_global_manifest(
        self, raw: str | Mapping[str, Any] | None = None, **keys: Any
    ) -> Path:
        """``write_manifest`` against ``$HOME/.agents/``."""
        return write_manifest(self.home, raw, **keys)

    def project(
        self,
        name: str = "proj",
        *,
        manifest: Mapping[str, Any] | str | None = None,
        git: bool = True,
    ) -> Path:
        """Create ``<tmp>/projects/<name>`` and return it.

        ``manifest=None`` writes NO manifest (the "cwd has no manifest" case);
        ``manifest={}`` writes an empty one, which makes the directory a project.
        ``git=True`` drops a ``.git`` directory so ``find_project`` stops at this
        boundary instead of walking into ``tmp_path``.
        """
        root = self.tmp / "projects" / name
        root.mkdir(parents=True, exist_ok=True)
        if git:
            (root / ".git").mkdir(exist_ok=True)
        if manifest is not None:
            write_manifest(root, manifest)
        return root

    def project_root_of(self, project: Path) -> Path:
        """``<project>/.agents/skills``."""
        return project / ".agents" / "skills"


def make_sandbox(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, registry: Path) -> Sandbox:
    home = tmp_path / "home"
    state_home = tmp_path / "state"
    (home / ".agents").mkdir(parents=True, exist_ok=True)
    state_home.mkdir(parents=True, exist_ok=True)
    (tmp_path / "projects").mkdir(parents=True, exist_ok=True)

    # SEAL: stop every upward walk AT tmp_path. This is not cosmetic and it is not
    # scoped to one module -- it closes a live hole in the sandbox.
    #
    # pytest's basetemp is $TMPDIR/pytest-of-<user>/..., and on this machine TMPDIR
    # is /home/<user>/.claude/tmp -- INSIDE the real home. Repointing HOME below
    # stops `refused_roots()` from naming the real home, but the cwd still
    # physically sits under it, so a `find_project` walk from a directory with no
    # .git and no manifest above it climbs straight out of the sandbox. Measured,
    # with HOME already patched:
    #
    #     find_project(<tmp>/projects)  ->  /home/<user>        # the REAL home
    #     discover_scopes(...).scopes   ->  [global -> <tmp>/home/.agents/skills,
    #                                        project -> /home/<user>/.agents/skills]
    #
    # and `apply()` writes that second one. The only thing preventing it today is
    # the accidental presence of /home/<user>/.claude/.git one level above
    # basetemp; scope.py's own docstring says relying on that kind of accident is
    # not a guard. A bare .git marker is a boundary `find_project` already honors,
    # and `probe_child_projects` skips it (no manifest inside), so it is inert in
    # every other respect.
    (tmp_path / ".git").mkdir(exist_ok=True)

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # Path.home() on Windows
    monkeypatch.setenv("XDG_STATE_HOME", str(state_home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    # EXCLUSIVE: registry_root_candidates() returns exactly this one path, so no
    # lookup can fall through to ~/.agents/.cache/registries or ~/code/skillex.
    monkeypatch.setenv("PJ_SKILLS_REGISTRY_ROOT", str(registry))
    return Sandbox(tmp=tmp_path, home=home, registry=registry, state_home=state_home)


# ---------------------------------------------------------------------------
# CLI runner
# ---------------------------------------------------------------------------

runner = CliRunner()

#: Keeps rich from soft-wrapping diagnostics at 80 columns mid-word, and keeps
#: ANSI escapes out of anything a test greps.
CLI_ENV = {"COLUMNS": "200", "TERM": "dumb", "NO_COLOR": "1"}


@contextmanager
def chdir(path: Path):
    """``os.chdir`` with a guaranteed restore.

    ``sync`` reads ``Path.cwd()`` directly (scope discovery is defined as "walk up
    from where you are standing"), and ``CliRunner`` does not change directory.
    """
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield path
    finally:
        os.chdir(previous)


def run_cli(*args: str, cwd: Path | None = None) -> tuple[int, str]:
    """Invoke the skillex typer app. Returns ``(exit_code, stdout)``."""
    from skillex.cli import app

    if cwd is None:
        result = runner.invoke(app, list(args), env=CLI_ENV)
    else:
        with chdir(cwd):
            result = runner.invoke(app, list(args), env=CLI_ENV)
    return result.exit_code, result.stdout


def run_sync(*args: str, cwd: Path | None = None) -> tuple[int, str]:
    """``skillex sync [args]``. Returns ``(exit_code, stdout)``.

    ``cwd`` is the directory to stand in, which is the whole input to scope
    discovery; omit it only for a test that has already chdir'd itself.
    """
    return run_cli("sync", *args, cwd=cwd)


def run_sync_json(*args: str, cwd: Path | None = None) -> tuple[int, dict[str, Any]]:
    """``skillex sync --json [args]``. Returns ``(exit_code, parsed payload)``.

    Prefer this for anything that asserts on diagnostics: the payload carries
    ``findings[].code`` as the published :class:`~skillex.core.diagnostics.Code`
    strings, while the human renderer groups, truncates and colorizes.
    """
    code, out = run_cli("sync", "--json", *args, cwd=cwd)
    return code, json.loads(out)


def codes_in(payload: Mapping[str, Any]) -> list[str]:
    """Every ``findings[].code`` in a ``--json`` payload, in emission order."""
    return [f["code"] for f in payload["findings"]]


# ---------------------------------------------------------------------------
# fixtures - each helper above, injectable by its own name
# ---------------------------------------------------------------------------


@pytest.fixture
def registry(tmp_path: Path) -> Path:
    """A fixture registry root with ``all-skills/``, ``sets/`` and ``packs/``."""
    return make_registry(tmp_path / "registry")


@pytest.fixture
def sandbox(tmp_path: Path, registry: Path) -> Iterator[Sandbox]:
    """HOME, XDG_STATE_HOME and PJ_SKILLS_REGISTRY_ROOT, all inside ``tmp_path``.

    Deliberately uses a PRIVATE :class:`pytest.MonkeyPatch` rather than the shared
    ``monkeypatch`` fixture. A test that patches something itself and then calls
    ``monkeypatch.undo()`` -- the ordinary way to assert "and now, unbroken, it
    converges" -- would otherwise undo the *sandbox as well*, silently repointing
    ``HOME`` at the developer's real one for the rest of the test. ``apply()``
    writes, so the next ``sync()`` call reconciles the real ``~/.agents/skills``.

    That is not hypothetical: it is exactly how
    ``test_interruption_leaves_a_superset_and_the_next_run_converges`` came to
    rewrite this machine's live global activation root. Isolation must be a
    property of the fixture, not a rule contributors are asked to remember.
    """
    mp = pytest.MonkeyPatch()
    try:
        yield make_sandbox(mp, tmp_path, registry)
    finally:
        mp.undo()


@pytest.fixture(autouse=True)
def _never_touch_the_real_machine() -> Iterator[None]:
    """Tripwire: fail any test that mutated the developer's real skill state.

    The ``sandbox`` fixture makes escape hard; this makes it *loud*. It costs two
    ``stat`` calls per test and it is the only thing standing between a plausible
    refactor and a test suite that quietly reconciles the machine it runs on.
    """
    watched = [
        Path.home() / ".agents" / "skills",
        Path.home() / ".local" / "state" / "skillex" / "projections",
    ]

    def fingerprint() -> list[tuple[str, float, int] | None]:
        out: list[tuple[str, float, int] | None] = []
        for path in watched:
            try:
                st = path.stat()
                out.append((str(path), st.st_mtime, len(list(path.iterdir()))))
            except OSError:
                out.append(None)
        return out

    before = fingerprint()
    yield
    after = fingerprint()
    assert after == before, (
        "this test mutated the REAL machine state, not its sandbox:\n"
        f"  before {before}\n  after  {after}\n"
        "Request the `sandbox` fixture, and never call monkeypatch.undo() on a "
        "MonkeyPatch that something else is also using."
    )


@pytest.fixture(name="write_skill")
def _write_skill_fixture():
    return write_skill


@pytest.fixture(name="write_catalog")
def _write_catalog_fixture():
    return write_catalog


@pytest.fixture(name="write_members")
def _write_members_fixture():
    return write_members


@pytest.fixture(name="write_set")
def _write_set_fixture():
    return write_set


@pytest.fixture(name="write_tree")
def _write_tree_fixture():
    return write_tree


@pytest.fixture(name="write_pack")
def _write_pack_fixture():
    return write_pack


@pytest.fixture(name="write_manifest")
def _write_manifest_fixture():
    return write_manifest


@pytest.fixture(name="snapshot")
def _snapshot_fixture():
    return snapshot


@pytest.fixture(name="run_sync")
def _run_sync_fixture():
    return run_sync


@pytest.fixture(name="run_sync_json")
def _run_sync_json_fixture():
    return run_sync_json


@pytest.fixture(name="run_cli")
def _run_cli_fixture():
    return run_cli
