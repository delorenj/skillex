"""Pack lifecycle commands: list, show, lint, activate, deactivate, create."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from skillex.core.activator import apply, plan
from skillex.core.linter import Severity, has_errors, lint_pack
from skillex.core.loader import (
    discover_skills,
    load_config,
    load_pack,
    load_pack_manifest,
)
from skillex.core.models import Pack, PackManifest, SkillexConfig
from skillex.logging import get_logger
from skillex.paths import default_config_path, default_lock_path

console = Console()
log = get_logger(__name__)

pack_app = typer.Typer(name="pack", help="Pack lifecycle commands.", no_args_is_help=True)


def _resolve_pack(cfg: SkillexConfig, name: str) -> Pack:
    pack_dir = cfg.packs_root / name
    if not pack_dir.is_dir():
        console.print(f"[red]pack {name!r} not found in {cfg.packs_root}[/red]")
        raise typer.Exit(code=1)
    skills_index = discover_skills(cfg.skills_root)
    return load_pack(pack_dir, skills_index)


@pack_app.command("list")
def list_cmd(
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """List packs available in packs_root."""
    cfg = load_config(config_path)
    if not cfg.packs_root.is_dir():
        console.print(f"[yellow]packs_root does not exist: {cfg.packs_root}[/yellow]")
        return

    table = Table(title="Packs")
    table.add_column("name")
    table.add_column("version")
    table.add_column("description")

    for pack_dir in sorted(cfg.packs_root.iterdir()):
        if not pack_dir.is_dir():
            continue
        manifest_path = pack_dir / "pack.toml"
        if not manifest_path.is_file():
            continue
        manifest = load_pack_manifest(manifest_path)
        table.add_row(manifest.name, manifest.version, manifest.description)

    console.print(table)


@pack_app.command("show")
def show_cmd(
    name: str,
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Show a pack's manifest and resolved skills."""
    cfg = load_config(config_path)
    pack = _resolve_pack(cfg, name)

    console.print(f"[bold]{pack.manifest.name}[/bold] v{pack.manifest.version}")
    if pack.manifest.description:
        console.print(pack.manifest.description)

    if pack.manifest.slots:
        table = Table(title="Slots")
        table.add_column("slot")
        table.add_column("type")
        table.add_column("required")
        table.add_column("skill")
        for slot_name, assignment in pack.manifest.slots.items():
            skill = pack.slot_skills.get(slot_name)
            table.add_row(
                slot_name,
                assignment.slot_type,
                "yes" if assignment.required else "no",
                skill.name if skill else "(empty)",
            )
        console.print(table)

    if pack.freeform_skills:
        freeform_table = Table(title="Freeform Skills")
        freeform_table.add_column("skill")
        freeform_table.add_column("slotType")
        for skill in pack.freeform_skills:
            freeform_table.add_row(
                skill.name,
                skill.frontmatter.slot_type or "(none)",
            )
        console.print(freeform_table)


@pack_app.command("lint")
def lint_cmd(
    name: str,
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Lint a pack. Exits 1 on errors, 0 on clean or warnings only."""
    cfg = load_config(config_path)
    pack = _resolve_pack(cfg, name)
    skills_index = discover_skills(cfg.skills_root)
    issues = lint_pack(pack, skills_index)

    if not issues:
        console.print("[green]clean[/green]")
        return

    for issue in issues:
        color = "red" if issue.severity is Severity.ERROR else "yellow"
        console.print(
            f"[{color}]{issue.severity.value}[/{color}] "
            f"{issue.rule.value} at {issue.location}: {issue.message}"
        )

    if has_errors(issues):
        raise typer.Exit(code=1)


@pack_app.command("activate")
def activate_cmd(
    name: str,
    scope: str = typer.Option("global", "--scope", help="global or project"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show plan without applying"),
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Activate a pack at the given scope."""
    if scope not in ("global", "project"):
        console.print("[red]--scope must be 'global' or 'project'[/red]")
        raise typer.Exit(code=2)

    cfg = load_config(config_path)
    pack = _resolve_pack(cfg, name)
    skills_index = discover_skills(cfg.skills_root)
    issues = lint_pack(pack, skills_index)
    if has_errors(issues):
        console.print("[red]pack has lint errors; refusing to activate[/red]")
        for issue in issues:
            if issue.severity is Severity.ERROR:
                console.print(
                    f"  [red]{issue.rule.value}[/red] {issue.location}: {issue.message}"
                )
        raise typer.Exit(code=1)

    project_root: Path | None = Path.cwd() if scope == "project" else None
    scope_literal: str = scope  # narrowed above
    ops = plan(pack, scope_literal, cfg, project_root=project_root)  # type: ignore[arg-type]

    table = Table(title=f"Plan ({scope})")
    table.add_column("action")
    table.add_column("cli")
    table.add_column("target")
    table.add_column("source")
    for op in ops:
        table.add_row(op.action, op.cli, str(op.target), str(op.source))
    console.print(table)

    if dry_run:
        console.print("[cyan]dry-run: no changes applied[/cyan]")
        return

    apply(ops, lock_path=default_lock_path())
    log.info(
        "activation.applied",
        pack=pack.manifest.name,
        scope=scope,
        op_count=len(ops),
    )
    console.print(f"[green]activated {pack.manifest.name!r} at {scope} scope[/green]")


@pack_app.command("deactivate")
def deactivate_cmd(
    scope: str = typer.Option("global", "--scope"),
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Deactivate the current pack at the given scope by activating an empty pack."""
    if scope not in ("global", "project"):
        console.print("[red]--scope must be 'global' or 'project'[/red]")
        raise typer.Exit(code=2)

    cfg = load_config(config_path)
    empty_pack = Pack(
        manifest=PackManifest(name="empty"),
        pack_path=cfg.packs_root / "empty",
    )
    project_root: Path | None = Path.cwd() if scope == "project" else None
    scope_literal: str = scope
    ops = plan(empty_pack, scope_literal, cfg, project_root=project_root)  # type: ignore[arg-type]
    apply(ops, lock_path=default_lock_path())
    log.info("activation.deactivated", scope=scope, op_count=len(ops))
    console.print(f"[green]deactivated at {scope} scope[/green]")


@pack_app.command("create")
def create_cmd(
    name: str,
    config_path: Path = typer.Option(default_config_path(), "--config"),
) -> None:
    """Scaffold a new pack directory with an empty manifest."""
    cfg = load_config(config_path)
    pack_dir = cfg.packs_root / name
    if pack_dir.exists():
        console.print(f"[red]pack {name!r} already exists at {pack_dir}[/red]")
        raise typer.Exit(code=1)
    pack_dir.mkdir(parents=True)
    (pack_dir / "pack.toml").write_text(
        f'[pack]\nname = "{name}"\nversion = "0.1.0"\ndescription = ""\n',
        encoding="utf-8",
    )
    (pack_dir / "README.md").write_text(f"# {name}\n\nPack description.\n", encoding="utf-8")
    console.print(f"[green]created pack at {pack_dir}[/green]")


def register(app: typer.Typer) -> None:
    app.add_typer(pack_app, name="pack")
