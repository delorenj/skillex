"""skillex slot: list slot types and which skills fill them."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from skillex.core.loader import discover_skills, load_config
from skillex.core.registry import CANONICAL_SLOT_TYPES
from skillex.paths import default_config_path

console = Console()

slot_app = typer.Typer(name="slot", help="Slot registry introspection.", no_args_is_help=True)


@slot_app.command("list")
def list_cmd(
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Show canonical slot types and which skills declare each."""
    cfg = load_config(config_path)
    skills = discover_skills(cfg.skills_root)

    by_slot: dict[str, list[str]] = {t: [] for t in CANONICAL_SLOT_TYPES}
    for skill in skills.values():
        st = skill.frontmatter.slot_type
        if st is None:
            continue
        by_slot.setdefault(st, []).append(skill.name)

    table = Table(title="Slot Registry")
    table.add_column("slotType")
    table.add_column("canonical")
    table.add_column("skills")

    for slot_type in sorted(by_slot):
        members = by_slot[slot_type]
        table.add_row(
            slot_type,
            "yes" if slot_type in CANONICAL_SLOT_TYPES else "no",
            ", ".join(sorted(members)) or "(none)",
        )

    console.print(table)


def register(app: typer.Typer) -> None:
    app.add_typer(slot_app, name="slot")
