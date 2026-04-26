"""skillex init: scaffold a default skillex.toml."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from skillex.paths import default_config_path

console = Console()

DEFAULT_TEMPLATE = """\
[skillex]
skills_root = "{skills_root}"
packs_root = "{packs_root}"
log_format = "console"

[scopes.global]
# Set active_pack to a pack name in packs_root to activate globally.
# active_pack = "33god-dev"

[cli.claude]
enabled = true
global_root = "~/.claude"
project_root = ".claude"

[cli.codex]
enabled = true
global_root = "~/.config/codex"
project_root = ".codex"

[cli.opencode]
enabled = true
global_root = "~/.config/opencode"
project_root = ".opencode"
"""


def register(app: typer.Typer) -> None:
    @app.command("init")
    def init_cmd(
        force: bool = typer.Option(
            False, "--force", "-f", help="Overwrite existing config."
        ),
        skills_root: Path = typer.Option(
            Path.home() / ".agents" / "skillex" / "all-skills",
            "--skills-root",
            help="Path to the master skills pool.",
        ),
        packs_root: Path = typer.Option(
            Path.home() / ".agents" / "skillex" / "packs",
            "--packs-root",
            help="Path to the pack manifests directory.",
        ),
        config_path: Path = typer.Option(
            default_config_path(),
            "--config",
            help="Path to write skillex.toml.",
        ),
    ) -> None:
        """Scaffold a default ~/.config/skillex/skillex.toml."""
        if config_path.exists() and not force:
            console.print(
                f"[red]config already exists at {config_path}. "
                f"Pass --force to overwrite.[/red]"
            )
            raise typer.Exit(code=1)

        config_path.parent.mkdir(parents=True, exist_ok=True)
        content = DEFAULT_TEMPLATE.format(
            skills_root=str(skills_root.expanduser()),
            packs_root=str(packs_root.expanduser()),
        )
        config_path.write_text(content, encoding="utf-8")
        console.print(f"[green]wrote {config_path}[/green]")
