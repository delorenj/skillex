"""Base Adapter protocol and registry.

An Adapter renders a single Skill into one or more LinkOps that materialize
the skill inside a CLI's native skill root. Different CLIs use different
layouts (directory-per-skill vs flat .md files), so each adapter owns its
own rendering logic.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Protocol

from skillex.core.models import LinkOp, Skill

Scope = Literal["global", "project"]


class Adapter(Protocol):
    """Render skills into a CLI's native layout."""

    @property
    def name(self) -> str:
        ...

    def render_links(
        self,
        skill: Skill,
        scope_root: Path,
        scope: Scope,
    ) -> list[LinkOp]:
        """Return LinkOps that publish `skill` into `scope_root` for this CLI.

        scope_root is the CLI's top-level config directory for the given scope
        (e.g., ~/.claude or <repo>/.claude). Adapter determines the exact
        subdirectory and file names.
        """
        ...


_REGISTRY: dict[str, Adapter] = {}


def register_adapter(adapter: Adapter) -> None:
    _REGISTRY[adapter.name] = adapter


def get_adapter(name: str) -> Adapter:
    if name not in _REGISTRY:
        raise KeyError(f"no adapter registered for {name!r}; have: {sorted(_REGISTRY)}")
    return _REGISTRY[name]


def all_adapters() -> dict[str, Adapter]:
    return dict(_REGISTRY)
