"""Hermes adapter.

Hermes loads local skills as directories under `<scope_root>/skills/<name>/`
and can preload them with `hermes --skills <name>`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from skillex.adapters.base import Scope, register_adapter
from skillex.core.models import LinkOp, Skill


@dataclass(frozen=True)
class HermesAdapter:
    name: str = "hermes"

    def render_links(
        self,
        skill: Skill,
        scope_root: Path,
        scope: Scope,
    ) -> list[LinkOp]:
        target = scope_root / "skills" / skill.name
        return [
            LinkOp(
                action="add",
                target=target,
                source=skill.path,
                cli=self.name,
                scope=scope,
            )
        ]


register_adapter(HermesAdapter())
