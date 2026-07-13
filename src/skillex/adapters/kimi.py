"""Kimi Code adapter.

Kimi Code loads skills as directories under `<scope_root>/skills/<name>/`.
The CLI also supports `--skills-dir`, so this layout works for both global and
project-scoped skill roots.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from skillex.adapters.base import Scope, register_adapter
from skillex.core.models import LinkOp, Skill


@dataclass(frozen=True)
class KimiAdapter:
    name: str = "kimi"

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


register_adapter(KimiAdapter())
