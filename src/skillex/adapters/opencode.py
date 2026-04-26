"""OpenCode adapter.

OpenCode consumes skills from two roots: `<scope_root>/agent/<name>.md` for
agent personas and `<scope_root>/command/<name>.md` for slash commands. MVP
defaults to `agent/`. Routing hints for `command/` arrive in a later milestone.

Like Codex, this is a flat file-level symlink to the SKILL.md. Support files
are not reachable; known MVP limitation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from skillex.adapters.base import Scope, register_adapter
from skillex.core.models import LinkOp, Skill


@dataclass(frozen=True)
class OpenCodeAdapter:
    name: str = "opencode"

    def render_links(
        self,
        skill: Skill,
        scope_root: Path,
        scope: Scope,
    ) -> list[LinkOp]:
        target = scope_root / "agent" / f"{skill.name}.md"
        return [
            LinkOp(
                action="add",
                target=target,
                source=skill.skill_md_path,
                cli=self.name,
                scope=scope,
            )
        ]


register_adapter(OpenCodeAdapter())
