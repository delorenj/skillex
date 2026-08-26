"""skillex topology: validate the single-source ownership contract."""

from __future__ import annotations

import json
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from skillex.core.topology import TopologySeverity, check_topology

console = Console()

topology_app = typer.Typer(
    name="topology",
    help="Validate canonical skills, reference-only compositions, and CLI aliases.",
    no_args_is_help=True,
)


@topology_app.command("check")
def check_cmd(
    root: Path = typer.Option(Path.cwd(), "--root", file_okay=False, resolve_path=True),
    sources_only: bool = typer.Option(
        False,
        "--sources-only",
        help="Check all-skills, skill-sets, and packs without project activation roots.",
    ),
    output_json: bool = typer.Option(False, "--json", help="Emit a machine-readable report."),
) -> None:
    """Fail when writable skill bytes exist outside all-skills/."""
    report = check_topology(root, include_activation=not sources_only)
    if output_json:
        # Rich's normal console renderer may soft-wrap long string values,
        # inserting newlines inside JSON strings. Emit the serialized payload
        # directly so stdout remains valid machine-readable JSON.
        typer.echo(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    else:
        table = Table(title="Skillex topology contract")
        table.add_column("severity")
        table.add_column("rule")
        table.add_column("path")
        table.add_column("message")
        for finding in report.findings:
            color = "red" if finding.severity is TopologySeverity.ERROR else "yellow"
            table.add_row(
                f"[{color}]{finding.severity.value}[/{color}]",
                finding.code.value,
                finding.path,
                finding.message,
            )
        console.print(table)
        status = "PASS" if report.ok else "FAIL"
        color = "green" if report.ok else "red"
        console.print(
            f"[{color}]{status}[/{color}] "
            f"canonical={report.canonical_skills} packs={report.pack_manifests} "
            f"errors={report.error_count} warnings={report.warning_count}"
        )
    if not report.ok:
        raise typer.Exit(code=1)


def register(app: typer.Typer) -> None:
    """Register the topology command group."""
    app.add_typer(topology_app, name="topology")
