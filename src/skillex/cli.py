"""CLI - Command Line Interface for skillex.

This module provides the typer-based CLI for interacting with the skillex
skill packaging system. Commands use rich for formatted terminal output.
"""

from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from skillex.exceptions import PackagingError, SkillexError
from skillex.services import PackagingResult, PackagingService

# Create typer app with explicit command handling
app = typer.Typer(
    name="skillex",
    help="Claude Skills Management CLI - Package and manage Claude AI skills",
    no_args_is_help=True,
    add_completion=False,
    invoke_without_command=False,
)


@app.callback()
def callback() -> None:
    """Claude Skills Management CLI - Package and manage Claude AI skills."""
    pass

# Console for rich output
console = Console()
error_console = Console(stderr=True)


def _format_size(size_bytes: int) -> str:
    """Format bytes as human-readable size."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"


def _display_result_summary(result: PackagingResult) -> None:
    """Display a brief success summary."""
    if result.success_count > 0:
        console.print(
            f"[green]✓[/green] Packaged {result.success_count} skill(s) "
            f"({_format_size(result.total_size_bytes)}) in {result.duration_seconds:.2f}s"
        )
        for skill in result.successful:
            console.print(f"  [dim]→[/dim] {skill.output_path}")


def _display_result_table(result: PackagingResult) -> None:
    """Display detailed results in a rich table."""
    # Summary line
    console.print()
    console.print(
        f"[bold]Packaging Results[/bold] "
        f"({result.success_count}/{result.total_skills} successful)"
    )
    console.print()

    # Create results table
    table = Table(show_header=True, header_style="bold")
    table.add_column("Skill", style="cyan")
    table.add_column("Status", justify="center")
    table.add_column("Size", justify="right")
    table.add_column("Output Path")

    # Add successful skills
    for skill in result.successful:
        table.add_row(
            skill.skill_name,
            "[green]✓[/green]",
            _format_size(skill.size_bytes),
            str(skill.output_path) if skill.output_path else "",
        )

    # Add failed skills
    for skill in result.failed:
        table.add_row(
            skill.skill_name,
            "[red]✗[/red]",
            "-",
            f"[red]{skill.error}[/red]" if skill.error else "",
        )

    console.print(table)

    # Summary footer
    console.print()
    console.print(
        f"[dim]Total:[/dim] {_format_size(result.total_size_bytes)} | "
        f"[dim]Duration:[/dim] {result.duration_seconds:.2f}s"
    )


def _display_errors(result: PackagingResult) -> None:
    """Display error information."""
    if result.failure_count > 0:
        error_console.print()
        error_console.print(f"[red]✗ {result.failure_count} skill(s) failed:[/red]")
        for skill in result.failed:
            error_console.print(f"  [red]•[/red] {skill.skill_name}: {skill.error}")


@app.command()
def zip(
    pattern: Annotated[
        str | None,
        typer.Argument(
            help="Pattern to match skill names (empty matches all)",
            show_default=False,
        ),
    ] = None,
    verbose: Annotated[
        bool,
        typer.Option(
            "--verbose",
            "-v",
            help="Show detailed output with rich table",
        ),
    ] = False,
) -> None:
    """Package Claude skills into ZIP archives.

    Discovers skills matching PATTERN and creates distributable ZIP archives.
    If no pattern is provided, packages all available skills.

    Examples:
        skillex zip              # Package all skills
        skillex zip python       # Package skills matching 'python'
        skillex zip -v           # Verbose output with table
        skillex zip python -v    # Verbose output for python skills
    """
    # Use empty string if pattern is None
    search_pattern = pattern or ""

    try:
        # Create service and run packaging
        service = PackagingService()
        result = service.package_skills(pattern=search_pattern)

        # Display results based on verbosity
        if verbose:
            _display_result_table(result)
        else:
            _display_result_summary(result)

        # Show errors if any
        _display_errors(result)

        # Exit with error code if any failures
        if result.failure_count > 0 and result.success_count == 0:
            raise typer.Exit(code=1)

        # Exit with warning code if partial success
        if result.failure_count > 0:
            raise typer.Exit(code=2)

        # No skills found
        if result.total_skills == 0:
            if search_pattern:
                console.print(f"[yellow]No skills matching '{search_pattern}' found[/yellow]")
            else:
                console.print("[yellow]No skills found[/yellow]")
            raise typer.Exit(code=0)

    except PackagingError as e:
        error_console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1) from None

    except SkillexError as e:
        error_console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1) from None


def main() -> None:
    """Entry point for the CLI."""
    app()


if __name__ == "__main__":
    main()
