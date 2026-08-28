"""CLI skill roots are directory-level aliases of `.agents/skills`. Nothing more.

Diagram box 5: every agentic CLI reads its own path, and each of those paths is a
symlink to the one activation root for that scope. No CLI owns another CLI's
projection, and none of them owns the root.

Three behaviors here are deliberate and each is measured:

* **A missing alias is created.** Creating an absent symlink destroys nothing, and
  no project-scope alias exists on this machine today -- without this a successful
  project sync would be invisible to every CLI.
* **A correct alias is never rewritten.** ``~/.claude/skills`` is written relative
  (``../.agents/skills``) and the other seven are absolute; both resolve to the
  same directory. pjangler string-compares against the relative literal, so sync
  writes relative when it *creates* one but compares by realpath when it *checks*
  one. Rewriting seven correct links on every run would be pure churn.
* **A real directory is reported, never converted.** In the skillex repo alone the
  five project CLI roots hold 35, 13, 30, 30 and 17 entries with five different
  contents, and ``.augment/skills`` holds a family that exists nowhere else.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from skillex.core.diagnostics import Code, Reporter

#: Global-scope aliases, relative to ``$HOME``. All eight exist and resolve today.
GLOBAL_CLI_ALIASES: tuple[Path, ...] = (
    Path(".claude/skills"),
    Path(".codex/skills"),
    Path(".gemini/skills"),
    Path(".copilot/skills"),
    Path(".kimi-code/skills"),
    Path(".kimi/skills"),
    Path(".openclaw/skills"),
    Path(".config/opencode/skills"),
)

#: Project-scope aliases, relative to the project root. Mirrors
#: ``topology.PROJECT_CLI_ROOTS`` so the checker and sync cannot disagree.
PROJECT_CLI_ALIASES: tuple[Path, ...] = (
    Path(".claude/skills"),
    Path(".codex/skills"),
    Path(".gemini/skills"),
    Path(".copilot/skills"),
    Path(".opencode/skills"),
    Path(".kimi-code/skills"),
)

#: Skill directories sync must never touch, at any scope, under any flag.
#:
#: ``.hermes/skills`` is a live Hermes runtime *overlay* (52 entries) that the
#: incumbent engine already lists as never-prune; the other three are populated by
#: tools with their own lifecycle.
NEVER_TOUCH: frozenset[str] = frozenset({".hermes", ".augment", ".cursor", ".crush"})


@dataclass(frozen=True)
class AliasStatus:
    path: Path
    ok: bool
    kind: str
    target: str | None = None
    resolved: Path | None = None


def _relative_alias_target(alias: Path, root: Path) -> str:
    """The link body to write when CREATING an alias.

    Relative, because pjangler's canonical-alias check string-compares against
    exactly ``../.agents/skills`` (adjusted for depth) rather than resolving.
    """
    return os.path.relpath(root, alias.parent)


def alias_paths(base: Path, *, is_global: bool) -> tuple[Path, ...]:
    table = GLOBAL_CLI_ALIASES if is_global else PROJECT_CLI_ALIASES
    return tuple(base / relative for relative in table)


def check_aliases(base: Path, root: Path, *, is_global: bool) -> list[AliasStatus]:
    """Inspect every alias for a scope without changing anything."""
    out: list[AliasStatus] = []
    root_real = Path(os.path.realpath(root))
    for alias in alias_paths(base, is_global=is_global):
        if alias.parts and any(part in NEVER_TOUCH for part in alias.parts):
            continue
        if alias.is_symlink():
            resolved = Path(os.path.realpath(alias))
            out.append(
                AliasStatus(
                    path=alias,
                    ok=resolved == root_real,
                    kind="symlink",
                    target=os.readlink(alias),
                    resolved=resolved,
                )
            )
        elif alias.is_dir():
            out.append(AliasStatus(path=alias, ok=False, kind="real_dir"))
        elif alias.exists():
            out.append(AliasStatus(path=alias, ok=False, kind="other"))
        else:
            out.append(AliasStatus(path=alias, ok=False, kind="absent"))
    return out


def ensure_aliases(
    base: Path,
    root: Path,
    reporter: Reporter,
    *,
    is_global: bool,
    fix: bool = False,
    dry_run: bool = False,
) -> list[AliasStatus]:
    """Create missing aliases; report anything sync will not silently change.

    :raises RefusalError: never. A wrong alias is reported as an ERROR finding so the
        run reports every one of them together rather than the first.
    """
    statuses = check_aliases(base, root, is_global=is_global)
    for status in statuses:
        if status.ok:
            continue
        if status.kind == "absent":
            if not dry_run:
                status.path.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(_relative_alias_target(status.path, root), status.path)
            continue
        if status.kind == "symlink":
            reporter.emit(
                Code.E_CLI_ALIAS_WRONG_TARGET,
                f"{status.path} points at {status.target}, not the activation root",
                path=status.path,
                detail=(f"expected {root}", f"resolves to {status.resolved}"),
                fix="repoint or remove it yourself; skillex never silently "
                "redirects an alias someone else set.",
            )
            continue
        if status.kind == "real_dir":
            if not fix:
                count = sum(1 for _ in status.path.iterdir())
                reporter.emit(
                    Code.W_CLI_ROOT_NOT_ALIAS,
                    f"{status.path} is a real directory with {count} entries, not an alias",
                    path=status.path,
                    fix="--fix-aliases moves it to skills.pre-skillex-<ts>/ and links it. "
                    "Nothing is deleted.",
                )
                continue
            if not dry_run:
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                os.rename(status.path, status.path.parent / f"skills.pre-skillex-{stamp}")
                os.symlink(_relative_alias_target(status.path, root), status.path)
            continue
        reporter.emit(
            Code.W_CLI_ROOT_NOT_ALIAS,
            f"{status.path} exists and is not a directory or symlink",
            path=status.path,
            fix="move it out of the way.",
        )
    return check_aliases(base, root, is_global=is_global) if not dry_run else statuses


__all__ = [
    "GLOBAL_CLI_ALIASES",
    "NEVER_TOUCH",
    "PROJECT_CLI_ALIASES",
    "AliasStatus",
    "alias_paths",
    "check_aliases",
    "ensure_aliases",
]
