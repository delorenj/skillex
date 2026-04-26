"""Claude adapter.

Claude consumes skills as directories under `<scope_root>/skills/<name>/`.
The adapter emits a single directory-level symlink per skill.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from skillex.adapters.base import Scope, register_adapter
from skillex.core.models import LinkOp, Skill


@dataclass(frozen=True)
class ClaudeAdapter:
    name: str = "claude"

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


register_adapter(ClaudeAdapter())
