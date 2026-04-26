"""Typer entrypoint for skillex."""

from __future__ import annotations

import typer

from skillex.commands import init as init_cmd
from skillex.commands import pack as pack_cmd
from skillex.commands import skill as skill_cmd
from skillex.commands import slot as slot_cmd
from skillex.commands import status as status_cmd
from skillex.logging import configure_logging

app = typer.Typer(
    name="skillex",
    help="CLI-agnostic skill package manager. One pack, identical delivery across every agentic CLI.",
    no_args_is_help=True,
)


@app.callback()
def _root(
    log_json: bool = typer.Option(False, "--log-json", help="Emit logs as JSON."),
) -> None:
    """Skillex root command."""
    configure_logging("json" if log_json else "console")


init_cmd.register(app)
pack_cmd.register(app)
skill_cmd.register(app)
slot_cmd.register(app)
status_cmd.register(app)


def main() -> None:
    """Script entrypoint."""
    app()


if __name__ == "__main__":
    main()
