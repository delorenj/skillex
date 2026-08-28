"""Make an activation root match a desired projection. The only writer.

Per-link ``os.symlink`` + ``os.rename`` is atomic: a reader sees either the old
link or the new one, never a gap. **Adds precede removes**, so an interruption
leaves a superset, never a hole -- agents see a few extra skills rather than a root
that eight CLI aliases all resolve to as empty. A superset is recoverable; a hole
is an outage.

The **run** is not transactional and there is deliberately no rollback: the desired
state is a pure function of the manifests, so re-running *is* the recovery, which is
a stronger property than a compensating rollback that swallows ``OSError``.

There is deliberately **no whole-root swap**. All five of these were measured on
this filesystem: ``rename(dir -> non-empty dir)`` is ``ENOTEMPTY``;
``rename(symlink -> real dir)`` is ``IsADirectoryError``; a two-step rename-aside
leaves every CLI alias dangling for the window and can strand real content in a
hidden sibling; ``mkdir(parents=True, exist_ok=True)`` on a dangling symlink raises
``FileExistsError``; and ``renameat2(RENAME_EXCHANGE)`` changes the root inode,
silently detaching every process holding an open fd or CWD inside it.
"""

from __future__ import annotations

import os
from contextlib import suppress
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Literal

from skillex.core.compositions import EXCLUDED_PREFIXES, lexical_link_target
from skillex.core.diagnostics import Code, Finding, RefusalError, Reporter
from skillex.core.resolver import Binding, Desired
from skillex.core.scope import Scope, is_within
from skillex.core.state import ProjectionState, StateEntry

TMP_PREFIX = ".skillex-tmp-"


class Action(StrEnum):
    ADD = "add"
    REPLACE = "replace"
    KEEP = "keep"
    REMOVE = "remove"
    SWEEP = "sweep"
    BLOCKED = "blocked"
    FOREIGN = "foreign"


class Ownership(StrEnum):
    OWNED = "owned"
    OWNED_DANGLING = "owned_dangling"
    UNOWNED_REAL = "unowned_real"
    UNOWNED_FOREIGN = "unowned_foreign"


@dataclass(frozen=True)
class Op:
    action: Action
    name: str
    target: Path | None = None
    current: Path | None = None
    binding: Binding | None = None
    note: str = ""


@dataclass
class RootState:
    """What the activation root looks like right now."""

    kind: Literal["absent", "real_dir", "symlink", "other"]
    path: Path
    link_target: Path | None = None
    children: dict[str, os.DirEntry[str]] = field(default_factory=dict)


@dataclass
class ReconcilePlan:
    ops: list[Op]
    mode: Literal["composed", "alias"]
    #: Entries in the root that are outside sync's namespace (dot/underscore
    #: prefixed) and are therefore neither projected nor pruned. Surfaced so
    #: "37 entries" and "36 managed" never look like a discrepancy.
    reserved: tuple[str, ...] = ()
    alias_target: Path | None = None
    #: True when the root must change shape (dir <-> symlink) before ops apply.
    mode_change: bool = False

    def by(self, *actions: Action) -> list[Op]:
        return [op for op in self.ops if op.action in actions]

    @property
    def counts(self) -> dict[str, int]:
        out = {a.value: 0 for a in Action}
        for op in self.ops:
            out[op.action.value] += 1
        return out

    @property
    def has_drift(self) -> bool:
        return any(op.action is not Action.KEEP for op in self.ops)


def managed_roots(registry_roots: list[Path]) -> list[Path]:
    """Roots a symlink may point into and still be presumed ours.

    ``$HOME`` and ``/`` are refused outright: either would make every link on the
    machine "managed", which is the same as having no ownership rule at all.
    """
    home = Path.home()
    out: list[Path] = []
    for root in registry_roots:
        resolved = Path(os.path.realpath(root))
        if resolved in (home, Path("/")):
            raise RefusalError(
                Finding(
                    code=Code.E_UNSAFE_TARGET,
                    message=f"refusing to treat {resolved} as a registry root",
                    path=resolved,
                    fix="point PJ_SKILLS_REGISTRY_ROOT at a real registry checkout.",
                )
            )
        out.append(resolved)
    return out


def classify_root(root: Path) -> RootState:
    if root.is_symlink():
        return RootState(
            kind="symlink",
            path=root,
            link_target=lexical_link_target(root.parent, root.name),
        )
    if not root.exists():
        return RootState(kind="absent", path=root)
    if not root.is_dir():
        return RootState(kind="other", path=root)
    with os.scandir(root) as it:
        children = {entry.name: entry for entry in it}
    return RootState(kind="real_dir", path=root, children=children)


def classify_entry(
    root: Path,
    name: str,
    entry: os.DirEntry[str],
    state: ProjectionState,
    managed: list[Path],
) -> Ownership:
    """Who owns one direct child of the root. Lexical; never ``Path.resolve``."""
    if not entry.is_symlink():
        return Ownership.UNOWNED_REAL
    if state.owns(name):
        return Ownership.OWNED
    target = lexical_link_target(root, name)
    if not os.path.lexists(target):
        # A dangling symlink in a GENERATED root is debris regardless of author --
        # every CLI renders it as a broken skill. This is exactly the case the old
        # activator gets wrong: resolve(strict=False) invents a phantom path,
        # relative_to raises, and the entry is skipped forever.
        return Ownership.OWNED_DANGLING
    if any(is_within(target, m) for m in managed):
        return Ownership.OWNED
    return Ownership.UNOWNED_FOREIGN


def preflight(root: Path, registry_roots: list[Path], reporter: Reporter) -> None:
    """Every check that can fail, run before the first byte is written.

    Re-run at the mutation boundary, not merely at plan time: between plan and apply
    the tree may have been swapped for a symlink, and on this machine dozens of
    repos run a rival projector on every ``cd``.
    """
    parent = root.parent
    current = Path(parent.root)
    for part in parent.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise RefusalError(
                Finding(
                    code=Code.E_UNSAFE_ROOT_CHAIN,
                    message=f"{current} is a symlink; refusing to create a root through it",
                    path=current,
                    fix="replace it with a real directory, or choose another root.",
                )
            )
    if not parent.is_dir():
        raise RefusalError(
            Finding(
                code=Code.E_UNSAFE_ROOT_CHAIN,
                message=f"{parent} is not a directory",
                path=parent,
                fix="create it first.",
            )
        )
    for registry in registry_roots:
        for internal in ("all-skills", "sets", "packs", "skill-sets"):
            if is_within(Path(os.path.realpath(root)), Path(os.path.realpath(registry)) / internal):
                raise RefusalError(
                    Finding(
                        code=Code.E_ROOT_INSIDE_REGISTRY,
                        message=f"{root} lies inside the registry's {internal}/",
                        path=root,
                        detail=("The registry is a source, never an activation target.",),
                        fix="choose an activation root outside the registry.",
                    )
                )


def diff(
    current: RootState,
    desired: Desired,
    state: ProjectionState,
    managed: list[Path],
    reporter: Reporter,
    *,
    skip_occupied: bool = False,
    prune: bool = True,
) -> ReconcilePlan:
    """Ops that would make ``current`` match ``desired``. Pure; writes nothing."""
    if desired.mode == "alias":
        return _diff_alias(current, desired, state, managed, reporter)

    ops: list[Op] = []
    all_children = dict(current.children) if current.kind == "real_dir" else {}
    # Dot- and underscore-prefixed entries are OUTSIDE sync's namespace, not merely
    # unowned. A composition can never project one (compositions.EXCLUDED_PREFIXES
    # drops them at read time), so sync can neither create nor prune one, and
    # treating them as evidence of a foreign populator would be a permanent, silent
    # veto over the root.
    #
    # This is not hypothetical: Codex installs its own `.system/` directory --
    # `skill-creator`, `skill-installer` and a `.codex-system-skills.marker` -- into
    # the live global activation root, and it belongs there. Counting it as a
    # trespasser made E_UNMANAGED_ROOT unclearable by any action short of deleting
    # another tool's data. Reserved entries are ignored, in both directions.
    reserved = {n for n in all_children if n.startswith(EXCLUDED_PREFIXES)} - {
        n for n in all_children if n.startswith(TMP_PREFIX)
    }
    present = {n: e for n, e in all_children.items() if n not in reserved}

    # A root with no receipt is refused only when it holds something we could not
    # have written: a non-symlink, or a symlink pointing outside every managed root.
    # Symlinks INTO a managed root on a stateless root are safely overwritable --
    # which is exactly today's live case (36 links into ~/code/skillex, no receipt),
    # and refusing it would have blocked sync's own first run.
    if state.absent and present:
        unexplained = [
            name
            for name, entry in present.items()
            if not name.startswith(TMP_PREFIX)
            and classify_entry(current.path, name, entry, state, managed)
            in (Ownership.UNOWNED_REAL, Ownership.UNOWNED_FOREIGN)
        ]
        if unexplained and not skip_occupied:
            reals = sum(1 for n in unexplained if not present[n].is_symlink())
            raise RefusalError(
                Finding(
                    code=Code.E_UNMANAGED_ROOT,
                    message=f"{current.path} has {len(present)} entries and no skillex state",
                    path=current.path,
                    detail=(
                        f"{reals} not written by skillex, "
                        f"{len(unexplained) - reals} linked outside the registry",
                        *sorted(unexplained)[:8],
                    ),
                    fix="another tool populated this root; empty it yourself, "
                    "or re-run with --skip-occupied to add only the free names.",
                )
            )

    blocked: list[str] = []
    for name, binding in desired.bindings.items():
        entry = present.get(name)
        if entry is None:
            ops.append(Op(Action.ADD, name, target=binding.target, binding=binding))
        elif not entry.is_symlink():
            blocked.append(name)
            ops.append(
                Op(
                    Action.BLOCKED,
                    name,
                    target=binding.target,
                    current=Path(entry.path),
                    binding=binding,
                    note="directory" if entry.is_dir() else "file",
                )
            )
        elif lexical_link_target(current.path, name) == binding.target:
            ops.append(Op(Action.KEEP, name, target=binding.target, binding=binding))
        else:
            ops.append(
                Op(
                    Action.REPLACE,
                    name,
                    target=binding.target,
                    current=lexical_link_target(current.path, name),
                    binding=binding,
                )
            )

    if blocked and not skip_occupied:
        raise RefusalError(
            Finding(
                code=Code.E_OCCUPIED,
                message=f"{len(blocked)} names are occupied by content skillex did not create",
                path=current.path,
                detail=tuple(
                    f"{current.path / n}   "
                    f"{'real directory' if present[n].is_dir() else 'regular file'}"
                    for n in blocked[:8]
                ),
                fix="move them yourself, or re-run with --skip-occupied "
                "(leaves them in place, does not project those names, exits 4).",
            )
        )

    for name, entry in sorted(present.items()):
        if name in desired.bindings:
            continue
        if name.startswith(TMP_PREFIX):
            ops.append(Op(Action.SWEEP, name, current=Path(entry.path)))
            continue
        ownership = classify_entry(current.path, name, entry, state, managed)
        if ownership in (Ownership.OWNED, Ownership.OWNED_DANGLING) and prune:
            ops.append(Op(Action.REMOVE, name, current=Path(entry.path)))
            continue
        if ownership is Ownership.UNOWNED_REAL and state.owns(name):
            reporter.emit(
                Code.W_PRUNE_SKIPPED_NOT_LINK,
                f"{name} was ours but is now a real directory; leaving it alone",
                name=name,
                path=Path(entry.path),
                fix="remove it yourself if it is stale.",
            )
        elif ownership in (Ownership.UNOWNED_REAL, Ownership.UNOWNED_FOREIGN):
            reporter.emit(
                Code.W_FOREIGN_ENTRY,
                f"{name} is in the root but not in the manifest, and skillex did not write it",
                name=name,
                path=Path(entry.path),
                fix="remove it yourself, or declare it in the manifest.",
            )
        ops.append(Op(Action.FOREIGN, name, current=Path(entry.path)))
    return ReconcilePlan(ops=ops, mode="composed", reserved=tuple(sorted(reserved)))


def _diff_alias(
    current: RootState,
    desired: Desired,
    state: ProjectionState,
    managed: list[Path],
    reporter: Reporter,
) -> ReconcilePlan:
    assert desired.alias_target is not None
    if current.kind == "symlink" and current.link_target == desired.alias_target:
        return ReconcilePlan(ops=[], mode="alias", alias_target=desired.alias_target)
    if current.kind == "real_dir":
        unowned = [
            name
            for name, entry in current.children.items()
            if classify_entry(current.path, name, entry, state, managed)
            in (Ownership.UNOWNED_REAL, Ownership.UNOWNED_FOREIGN)
        ]
        if unowned:
            raise RefusalError(
                Finding(
                    code=Code.E_ALIAS_WOULD_DISCARD,
                    message=f"a pack requires {current.path} to become a symlink, "
                    f"but it holds {len(unowned)} entries skillex did not write",
                    path=current.path,
                    detail=tuple(sorted(unowned)[:8]),
                    fix="move them yourself; skillex will then move the root aside to "
                    "skills.pre-alias-<ts>/ automatically. Nothing is deleted.",
                )
            )
    if current.kind == "other":
        raise RefusalError(
            Finding(
                code=Code.E_ROOT_NOT_DIR,
                message=f"{current.path} is neither a directory nor a symlink",
                path=current.path,
                fix="move it out of the way.",
            )
        )
    return ReconcilePlan(
        ops=[Op(Action.ADD, current.path.name, target=desired.alias_target)],
        mode="alias",
        alias_target=desired.alias_target,
        mode_change=True,
    )


def _timestamp() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def ensure_root(root: Path, mode: str, alias_target: Path | None) -> None:
    """Bring the root to the right SHAPE before children are written."""
    if mode == "alias":
        assert alias_target is not None
        if root.is_symlink():
            tmp = root.parent / f"{TMP_PREFIX}root-{os.getpid()}"
            os.symlink(alias_target, tmp)
            os.rename(tmp, root)  # atomic: symlink over symlink
            return
        if root.is_dir():
            # rename(symlink -> real dir) is IsADirectoryError, so the directory
            # must move out of the way first. Moved, never removed.
            os.rename(root, root.parent / f"{root.name}.pre-alias-{_timestamp()}")
        os.symlink(alias_target, root)
        return

    if root.is_symlink():
        # Unlinking a symlink-to-dir leaves the target directory untouched.
        os.unlink(root)
    if not root.exists():
        root.mkdir(parents=True, exist_ok=False)


def apply(
    scope: Scope,
    plan: ReconcilePlan,
    desired: Desired,
    state: ProjectionState,
    registry_roots: list[Path],
) -> ProjectionState:
    """Execute ``plan``. Adds and replaces first, removes last."""
    from skillex.core.state import commit_state, write_pending

    ensure_root(scope.root, plan.mode, plan.alias_target)

    if plan.mode == "alias":
        state.mode = "alias"
        state.alias_target = str(plan.alias_target)
        state.entries = {}
        state.scope = scope.kind.value
        state.registry_roots = [str(r) for r in registry_roots]
        commit_state(state)
        return state

    # Write-ahead, and deliberately a SUPERSET of what we are about to write.
    write_pending(state, set(desired.bindings) | set(state.entries))

    for op in plan.by(Action.ADD, Action.REPLACE):
        assert op.target is not None
        tmp = scope.root / f"{TMP_PREFIX}{op.name}-{os.getpid()}"
        tmp.unlink(missing_ok=True)
        os.symlink(op.target, tmp)
        try:
            os.rename(tmp, scope.root / op.name)
        except BaseException:
            # An interrupted rename must not strand the staging link. It is ours,
            # it was never published under its real name, and left behind it is a
            # third thing the root can hold -- neither the old link nor the new one
            # -- in a directory eight CLI aliases read. `sweep_tmp` and the SWEEP op
            # are the backstop for a killed process, not a licence to leak here.
            with suppress(OSError):
                os.unlink(tmp)
            raise

    for op in plan.by(Action.REMOVE, Action.SWEEP):
        try:
            os.unlink(scope.root / op.name)
        except FileNotFoundError:
            pass

    projected = {op.name for op in plan.by(Action.ADD, Action.REPLACE, Action.KEEP)}
    state.mode = "composed"
    state.alias_target = None
    state.scope = scope.kind.value
    state.registry_roots = [str(r) for r in registry_roots]
    state.entries = {
        name: StateEntry(
            target=str(binding.target), origin=binding.origin, stage=str(binding.stage)
        )
        for name, binding in desired.bindings.items()
        if name in projected
    }
    commit_state(state)
    return state


def sweep_tmp(root: Path) -> int:
    """Remove stale ``.skillex-tmp-*`` entries. Returns how many."""
    if not root.is_dir() or root.is_symlink():
        return 0
    removed = 0
    with os.scandir(root) as it:
        for entry in it:
            if entry.name.startswith(TMP_PREFIX):
                try:
                    os.unlink(entry.path)
                    removed += 1
                except OSError:
                    pass
    return removed


__all__ = [
    "TMP_PREFIX",
    "Action",
    "Op",
    "Ownership",
    "ReconcilePlan",
    "RootState",
    "apply",
    "classify_entry",
    "classify_root",
    "diff",
    "ensure_root",
    "managed_roots",
    "preflight",
    "sweep_tmp",
]
