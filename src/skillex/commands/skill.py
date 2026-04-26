"""skillex skill: list and inspect skills."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from skillex.core.loader import discover_skills, load_config
from skillex.paths import default_config_path

console = Console()

skill_app = typer.Typer(name="skill", help="Skill introspection.", no_args_is_help=True)


@skill_app.command("list")
def list_cmd(
    slot: str | None = typer.Option(None, "--slot", help="Filter by slot type"),
    unslotted: bool = typer.Option(False, "--unslotted", help="Show only unslotted skills"),
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """List skills in skills_root, optionally filtered."""
    cfg = load_config(config_path)
    skills = discover_skills(cfg.skills_root)

    table = Table(title="Skills")
    table.add_column("name")
    table.add_column("slotType")
    table.add_column("description")

    for name in sorted(skills):
        skill = skills[name]
        st = skill.frontmatter.slot_type
        if slot is not None and st != slot:
            continue
        if unslotted and st is not None:
            continue
        table.add_row(name, st or "(none)", skill.frontmatter.description or "")

    console.print(table)


@skill_app.command("show")
def show_cmd(
    name: str,
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Show a skill's metadata and path."""
    cfg = load_config(config_path)
    skills = discover_skills(cfg.skills_root)
    skill = skills.get(name)
    if skill is None:
        console.print(f"[red]skill {name!r} not found[/red]")
        raise typer.Exit(code=1)
    console.print(f"[bold]{skill.name}[/bold]")
    console.print(f"path:       {skill.path}")
    console.print(f"SKILL.md:   {skill.skill_md_path}")
    console.print(f"slotType:   {skill.frontmatter.slot_type or '(none)'}")
    console.print(f"version:    {skill.frontmatter.version or '(none)'}")
    console.print(f"description: {skill.frontmatter.description or '(none)'}")
    if skill.frontmatter.tags:
        console.print(f"tags:       {', '.join(skill.frontmatter.tags)}")


def register(app: typer.Typer) -> None:
    app.add_typer(skill_app, name="skill")
