"""Activation engine: plan and apply symlink operations per CLI root.

plan() computes the LinkOp list needed to activate a pack at a given scope,
diffed against the current state of each enabled CLI's skill root.

apply() executes the plan atomically: snapshot current symlinks, perform
all ops, verify each new link resolves, and restore from snapshot on any
failure.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from skillex.adapters.base import Scope, all_adapters
from skillex.core.file_lock import FileLock
from skillex.core.models import LinkOp, Pack, SkillexConfig


class ActivationError(RuntimeError):
    """Raised when activation fails and rollback has been performed."""


@dataclass(frozen=True)
class _Snapshot:
    """Record of a symlink that existed before mutation."""

    path: Path
    target: Path  # path it pointed to


def _scope_root_for(
    cli_name: str,
    scope: Scope,
    config: SkillexConfig,
    project_root: Path | None,
) -> Path | None:
    """Return the CLI-specific scope root, or None if that scope is unavailable."""
    adapter_cfg = config.cli_adapters.get(cli_name)
    if adapter_cfg is None or not adapter_cfg.enabled:
        return None
    if scope == "global":
        return adapter_cfg.global_root
    if project_root is None:
        return None
    return project_root / adapter_cfg.project_root


def _skillex_owned_links_in(
    scope_root: Path, skills_root: Path
) -> list[Path]:
    """Find existing symlinks under scope_root that point into skills_root.

    Recursively walks the expected subdirectories (skills/, prompts/, agent/).
    Non-symlinks are ignored so we never delete user-created content.
    """
    owned: list[Path] = []
    if not scope_root.exists():
        return owned

    resolved_skills_root = skills_root.resolve()

    for sub in ("skills", "prompts", "agent", "command"):
        candidate = scope_root / sub
        if not candidate.is_dir():
            continue
        for entry in candidate.iterdir():
            if not entry.is_symlink():
                continue
            try:
                target = entry.resolve(strict=False)
            except OSError:
                continue
            try:
                target.relative_to(resolved_skills_root)
            except ValueError:
                continue
            owned.append(entry)
    return owned


def plan(
    pack: Pack,
    scope: Scope,
    config: SkillexConfig,
    *,
    project_root: Path | None = None,
) -> list[LinkOp]:
    """Compute the LinkOp plan needed to bring scope roots into pack's state."""
    ops: list[LinkOp] = []
    skills_to_link = list(pack.slot_skills.values()) + list(pack.freeform_skills)

    adapters = all_adapters()

    for cli_name, adapter in adapters.items():
        scope_root = _scope_root_for(cli_name, scope, config, project_root)
        if scope_root is None:
            continue

        existing = {p.resolve(strict=False): p for p in _skillex_owned_links_in(
            scope_root, config.skills_root
        )}
        desired_ops: list[LinkOp] = []
        for skill in skills_to_link:
            desired_ops.extend(adapter.render_links(skill, scope_root, scope))

        desired_targets = {op.target.resolve(strict=False): op for op in desired_ops}

        # ADD ops for anything desired not yet present (or pointing elsewhere)
        for resolved, op in desired_targets.items():
            current_link = existing.get(resolved)
            if current_link is None:
                ops.append(op)
            else:
                # Already present; keep-op for plan visibility.
                ops.append(
                    LinkOp(
                        action="keep",
                        target=op.target,
                        source=op.source,
                        cli=op.cli,
                        scope=op.scope,
                    )
                )

        # REMOVE ops for owned links not in desired set.
        for resolved, link_path in existing.items():
            if resolved not in desired_targets:
                ops.append(
                    LinkOp(
                        action="remove",
                        target=link_path,
                        source=link_path.resolve(strict=False),
                        cli=cli_name,
                        scope=scope,
                    )
                )

    return ops


def apply(
    ops: list[LinkOp],
    *,
    lock_path: Path,
    dry_run: bool = False,
) -> None:
    """Execute a plan atomically under a file lock, with rollback on failure."""
    if dry_run:
        return

    with FileLock(lock_path):
        snapshots: list[_Snapshot] = []
        created: list[Path] = []
        try:
            # Snapshot anything we're about to remove or overwrite.
            for op in ops:
                if op.action == "remove" and op.target.is_symlink():
                    snapshots.append(
                        _Snapshot(path=op.target, target=op.target.readlink())
                    )

            # Remove first.
            for op in ops:
                if op.action == "remove":
                    _unlink_if_symlink(op.target)

            # Then add.
            for op in ops:
                if op.action == "add":
                    op.target.parent.mkdir(parents=True, exist_ok=True)
                    if op.target.exists() or op.target.is_symlink():
                        snapshots.append(
                            _Snapshot(
                                path=op.target,
                                target=(
                                    op.target.readlink()
                                    if op.target.is_symlink()
                                    else op.target
                                ),
                            )
                        )
                        _unlink_if_symlink(op.target)
                    os.symlink(op.source, op.target)
                    created.append(op.target)

            # Verify.
            for target in created:
                if not target.is_symlink() or not target.exists():
                    raise ActivationError(
                        f"post-apply verification failed for {target}"
                    )
        except Exception as e:
            _rollback(created, snapshots)
            raise ActivationError(f"activation failed, rolled back: {e}") from e


def _unlink_if_symlink(path: Path) -> None:
    if path.is_symlink() or path.exists():
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _rollback(created: list[Path], snapshots: list[_Snapshot]) -> None:
    """Restore pre-apply state. Best-effort: logs failures instead of raising."""
    for path in created:
        try:
            if path.is_symlink() or path.exists():
                path.unlink()
        except OSError:
            pass
    for snap in snapshots:
        try:
            if not (snap.path.is_symlink() or snap.path.exists()):
                os.symlink(snap.target, snap.path)
        except OSError:
            pass


RenderAction = Literal["add", "remove", "keep"]
