"""skillex status: show active packs and per-CLI sync state."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from skillex.core.activator import _skillex_owned_links_in
from skillex.core.loader import load_config
from skillex.paths import default_config_path, find_project_root, load_project_scope_pack

console = Console()


def register(app: typer.Typer) -> None:
    @app.command("status")
    def status_cmd(
        config_path: Path = typer.Option(default_config_path(), "--config"),
    ) -> None:
        """Show active pack per scope and per-CLI sync state."""
        cfg = load_config(config_path)

        scope_table = Table(title="Active Packs")
        scope_table.add_column("scope")
        scope_table.add_column("pack")

        global_pack = cfg.scopes.get("global")
        scope_table.add_row(
            "global",
            global_pack.active_pack if global_pack and global_pack.active_pack else "(none)",
        )

        project_root = find_project_root(Path.cwd())
        if project_root is not None:
            project_pack = load_project_scope_pack(project_root)
            scope_table.add_row(
                f"project ({project_root})",
                project_pack or "(none)",
            )
        else:
            scope_table.add_row("project", "(not in a project)")

        console.print(scope_table)

        cli_table = Table(title="CLI Roots")
        cli_table.add_column("cli")
        cli_table.add_column("enabled")
        cli_table.add_column("global_root")
        cli_table.add_column("managed links")
        for cli_name, adapter_cfg in cfg.cli_adapters.items():
            managed = _skillex_owned_links_in(adapter_cfg.global_root, cfg.skills_root)
            cli_table.add_row(
                cli_name,
                "yes" if adapter_cfg.enabled else "no",
                str(adapter_cfg.global_root),
                str(len(managed)),
            )
        console.print(cli_table)
