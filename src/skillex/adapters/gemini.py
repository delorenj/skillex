"""Gemini adapter.

Gemini CLI consumes linked skills as directories. User-scope skills live under
`~/.gemini/config/skills/<name>/`; workspace-scope skills live under
`<repo>/.gemini/skills/<name>/`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from skillex.adapters.base import Scope, register_adapter
from skillex.core.models import LinkOp, Skill


@dataclass(frozen=True)
class GeminiAdapter:
    name: str = "gemini"

    def render_links(
        self,
        skill: Skill,
        scope_root: Path,
        scope: Scope,
    ) -> list[LinkOp]:
        skills_root = (
            scope_root / "config" / "skills" if scope == "global" else scope_root / "skills"
        )
        target = skills_root / skill.name
        return [
            LinkOp(
                action="add",
                target=target,
                source=skill.path,
                cli=self.name,
                scope=scope,
            )
        ]


register_adapter(GeminiAdapter())
