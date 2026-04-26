"""Codex adapter.

Codex consumes skills as flat Markdown files under `<scope_root>/prompts/<name>.md`.
The adapter emits a file-level symlink to the SKILL.md inside the skill
directory. Support files in the skill directory are not reachable by Codex
with this rendering; that is a known MVP limitation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from skillex.adapters.base import Scope, register_adapter
from skillex.core.models import LinkOp, Skill


@dataclass(frozen=True)
class CodexAdapter:
    name: str = "codex"

    def render_links(
        self,
        skill: Skill,
        scope_root: Path,
        scope: Scope,
    ) -> list[LinkOp]:
        target = scope_root / "prompts" / f"{skill.name}.md"
        return [
            LinkOp(
                action="add",
                target=target,
                source=skill.skill_md_path,
                cli=self.name,
                scope=scope,
            )
        ]


register_adapter(CodexAdapter())
