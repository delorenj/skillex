"""Which activation roots a `skillex sync` invocation writes, derived from the CWD.

``--scope`` exists only as an override. The default answer comes from where you
are standing:

* **global is always in play** -- ``~/.agents/skills`` is the root every CLI reads
  when no project is active, so leaving it stale to sync a project is never right.
* **a project is added when you are standing inside one**, found by walking UP from
  the CWD to the nearest ``.agents/skills.json``.

The upward walk is what makes ``skillex sync`` work from ``<repo>/src/a/b`` instead
of only from a repo root -- the failure mode the incumbent ``pack activate
--scope project`` has, where a raw ``Path.cwd()`` silently projects into
``<repo>/src/a/b/.agents/skills``.

Two guards stop the walk before it produces something absurd; both close a hazard
verified on this machine rather than a hypothetical one. See
:data:`REFUSED_ROOTS` and :func:`is_registry_internal`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from skillex.core.diagnostics import Code, Finding, RefusalError

MANIFEST_RELPATH = Path(".agents") / "skills.json"
ROOT_RELPATH = Path(".agents") / "skills"


#: Directories that can never be a *project* root, however they look.
#:
#: ``~/.agents`` is the global scope's own home and -- verified -- is itself a git
#: repository with ``/skills`` in ``.git/info/exclude``. Without this guard an
#: upward walk from anywhere beneath it would adopt the global scope as a project
#: and write one root twice under two identities. The shapes happen not to collide
#: today (there is no ``~/.agents/.agents/skills.json``); relying on that accident
#: is not a guard.
#:
#: ``$HOME`` and ``/`` are refused for the obvious reason: a manifest that lands
#: there would make every directory on the machine "inside a project".
def refused_roots() -> frozenset[Path]:
    """Computed, not a module constant, so tests can monkeypatch ``HOME``."""
    home = Path.home()
    return frozenset({home, home / ".agents", Path("/")})


#: Registry subtrees that are SOURCES and must never become activation targets.
REGISTRY_INTERNAL_DIRS = ("all-skills", "sets", "packs", "skill-sets")


class ScopeKind(StrEnum):
    GLOBAL = "global"
    PROJECT = "project"


@dataclass(frozen=True)
class Scope:
    """One (manifest, activation root) pair to reconcile."""

    kind: ScopeKind
    manifest_path: Path
    root: Path
    #: The repo root for a project scope; ``None`` for global.
    base: Path | None = None

    @property
    def label(self) -> str:
        return self.kind.value


@dataclass
class ScopePlan:
    """The scopes one invocation will write, global first.

    Global is always index 0 and is always resolved first, because a project map
    may inherit from it and computing the global projection twice must give one
    answer.
    """

    scopes: list[Scope]
    findings: list[Finding]


def global_scope() -> Scope:
    home = Path.home()
    return Scope(
        kind=ScopeKind.GLOBAL,
        manifest_path=home / MANIFEST_RELPATH,
        root=home / ROOT_RELPATH,
    )


def project_scope(project_root: Path) -> Scope:
    return Scope(
        kind=ScopeKind.PROJECT,
        manifest_path=project_root / MANIFEST_RELPATH,
        root=project_root / ROOT_RELPATH,
        base=project_root,
    )


def is_within(path: Path, ancestor: Path) -> bool:
    """True when ``path`` is ``ancestor`` or lies beneath it. Purely lexical.

    Both sides must already be absolute and normalized. This never touches the
    filesystem, which is the point: it is used to decide whether a *hostile* path
    is safe before anything resolves or opens it.
    """
    try:
        path.relative_to(ancestor)
    except ValueError:
        return False
    return True


def is_registry_internal(path: Path, registry_roots: Sequence[Path] = ()) -> bool:
    """True when ``path`` lies inside a registry's source trees.

    Two real traps on this machine, both actual files:

    * ``all-skills/.agents/skills.json`` -- the catalog submodule is itself a
      "project" with its own ``mise.toml``;
    * ``all-skills/impeccable/scripts/.agents/skills.json`` -- buried inside a
      canonical skill.

    Either would make ``cd all-skills && skillex sync`` build a projection **inside
    the only writable byte store**, inverting the write boundary the whole
    architecture rests on.

    When ``registry_roots`` is empty the check falls back to structure: any path
    with an ``all-skills`` / ``sets`` / ``packs`` component that has a sibling
    ``all-skills`` directory at that level is registry-internal. That covers a
    checkout the ladder does not know about.
    """
    resolved = path.resolve()
    for root in registry_roots:
        for internal in REGISTRY_INTERNAL_DIRS:
            if is_within(resolved, (root / internal).resolve()):
                return True
    parts = resolved.parts
    for index, part in enumerate(parts):
        if part in REGISTRY_INTERNAL_DIRS:
            registry_root = Path(*parts[:index]) if index else Path("/")
            if (registry_root / "all-skills").is_dir():
                return True
    return False


def find_project(cwd: Path, registry_roots: Sequence[Path] = ()) -> Path | None:
    """Nearest enclosing project root, walking UP from ``cwd``. ``None`` if none.

    Stops -- returning ``None`` -- at a repo boundary that carries no manifest.
    Walking past it into a parent repository would let a nested checkout adopt its
    host's manifest, which is never what the author meant.

    :raises RefusalError: when ``cwd`` itself sits inside a registry's source trees.
    """
    refused = refused_roots()
    current = cwd.resolve()
    while True:
        if current in refused:
            return None
        manifest = current / MANIFEST_RELPATH
        if manifest.is_file():
            if is_registry_internal(current, registry_roots):
                raise RefusalError(
                    Finding(
                        code=Code.E_REGISTRY_INTERNAL,
                        message="refusing to project into the skill registry itself",
                        path=current,
                        detail=(
                            f"{current} is inside a registry's "
                            f"{'/, '.join(REGISTRY_INTERNAL_DIRS)}/ tree.",
                            "The canonical catalog is a source, never an activation target.",
                        ),
                        fix="cd to the project you meant, or pass --project <path>.",
                    )
                )
            return current
        if is_registry_internal(current, registry_roots):
            return None
        # A repo that does not use skillex is not a skillex project. Returning None
        # here (rather than continuing up) is what keeps sync from creating a
        # .agents/ directory nobody asked for.
        if (current / ".git").exists() or (current / ".skillex.toml").is_file():
            return None
        if current.parent == current:
            return None
        current = current.parent


def probe_child_projects(cwd: Path, registry_roots: Sequence[Path] = ()) -> list[Path]:
    """Project roots exactly ONE level below ``cwd``. Non-recursive, symlink-refusing.

    Reporting only -- :func:`discover_scopes` never adopts what this finds. It
    exists so ``skillex sync`` run one directory above a project says so instead of
    silently doing nothing visible, and so the fan-out reading of the "ancestor of
    a project root" clause is one branch away rather than a redesign.

    Recursing here would be the single most destructive command on this machine:
    ``~/code`` alone carries 19 direct child manifests and 44 activation roots at
    depth 3, several already broken, and one mistyped ``cd`` would act on all of
    them.
    """
    try:
        children = sorted(cwd.iterdir())
    except OSError:
        return []
    out = []
    for child in children:
        if child.is_symlink() or not child.is_dir():
            continue
        if not (child / MANIFEST_RELPATH).is_file():
            continue
        if is_registry_internal(child, registry_roots):
            continue
        out.append(child)
    return out


def discover_scopes(
    cwd: Path,
    *,
    scope: str = "auto",
    project: Path | None = None,
    registry_roots: Sequence[Path] = (),
) -> ScopePlan:
    """Resolve ``cwd`` (and any overrides) to the scopes this run will write.

    ``scope`` is one of ``auto`` / ``global`` / ``project`` / ``both``.

    :raises RefusalError: ``--scope project`` with no project found; or a CWD inside a
        registry's source trees.
    """
    findings: list[Finding] = []
    project_root: Path | None = None

    if project is not None:
        explicit = project.expanduser().resolve()
        if not (explicit / MANIFEST_RELPATH).is_file():
            raise RefusalError(
                Finding(
                    code=Code.E_NO_PROJECT_MANIFEST,
                    message=f"no manifest at {explicit / MANIFEST_RELPATH}",
                    path=explicit,
                    fix="create the manifest, or drop --project to sync global only.",
                )
            )
        project_root = explicit
    elif scope == "global":
        project_root = None
    else:
        project_root = find_project(cwd, registry_roots)

    if project_root is None and scope in {"auto", "both"} and project is None:
        # Report-only; see probe_child_projects. Never adopts, never an error --
        # `cd ~/code && skillex sync` must stay a plain, successful global sync.
        below = probe_child_projects(cwd, registry_roots)
        if len(below) == 1:
            findings.append(
                Finding(
                    code=Code.I_PROJECT_BELOW_CWD,
                    message=f"a project sits one level below: {below[0].name}",
                    path=below[0],
                    fix=f"cd {below[0].name} (or --project {below[0]}) to sync it too.",
                )
            )
        elif len(below) > 1:
            findings.append(
                Finding(
                    code=Code.I_SIBLING_PROJECTS,
                    message=f"{len(below)} projects sit one level below; syncing global only",
                    detail=tuple(p.name for p in below[:10])
                    + (("...",) if len(below) > 10 else ()),
                    fix="cd into the one you meant, or pass --project <path>.",
                )
            )

    if scope == "project" and project_root is None:
        raise RefusalError(
            Finding(
                code=Code.E_NO_PROJECT_MANIFEST,
                message=f"--scope project, but no {MANIFEST_RELPATH} above {cwd}",
                path=cwd,
                fix="create the manifest, cd into the project, or pass --project <path>.",
            )
        )

    scopes: list[Scope] = []
    if scope != "project":
        scopes.append(global_scope())
    if project_root is not None:
        scopes.append(project_scope(project_root))
    return ScopePlan(scopes=scopes, findings=findings)


__all__ = [
    "MANIFEST_RELPATH",
    "REGISTRY_INTERNAL_DIRS",
    "ROOT_RELPATH",
    "Scope",
    "ScopeKind",
    "ScopePlan",
    "discover_scopes",
    "find_project",
    "global_scope",
    "is_registry_internal",
    "is_within",
    "probe_child_projects",
    "project_scope",
    "refused_roots",
]
