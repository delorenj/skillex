"""CLI - Command Line Interface for skillex.

This module provides the typer-based CLI for interacting with the skillex
skill packaging system. Commands use rich for formatted terminal output.
"""

import os
from contextlib import contextmanager
from typing import Annotated, Iterator

import typer
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskID,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

from skillex.exceptions import PackagingError, SkillexError
from skillex.services import PackagingResult, PackagingService
from skillex.services.discovery import SkillDiscoveryService, SkillInfo
from skillex.services.fuzzy import FuzzyMatcherService

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


class OutputFormatter:
    """Centralized output formatting with rich terminal features.

    Provides consistent color scheme, symbols, and formatting across all CLI
    commands. Handles graceful degradation for non-color terminals.

    Color Scheme:
        - Green: Success states, confirmations
        - Red: Errors, failures
        - Cyan: Information, data
        - Yellow: Warnings, notices
        - Dim: Secondary information
    """

    # Color scheme constants
    SUCCESS = "green"
    ERROR = "red"
    INFO = "cyan"
    WARNING = "yellow"
    DIM = "dim"

    # Symbols
    CHECK = "✓"
    CROSS = "✗"
    ARROW = "→"
    BULLET = "•"

    def __init__(self, force_terminal: bool | None = None) -> None:
        """Initialize OutputFormatter.

        Args:
            force_terminal: Override terminal detection. If None, auto-detects.
        """
        # Graceful degradation: detect if terminal supports colors
        if force_terminal is None:
            # Check common environment variables for color support
            no_color = os.environ.get("NO_COLOR")
            term = os.environ.get("TERM", "")
            force_terminal = not no_color and term != "dumb"

        self.console = Console(force_terminal=force_terminal)
        self.error_console = Console(stderr=True, force_terminal=force_terminal)

    def print(self, message: str, style: str | None = None) -> None:
        """Print a message to stdout with optional style."""
        self.console.print(message, style=style)

    def print_error(self, message: str) -> None:
        """Print an error message to stderr."""
        self.error_console.print(f"[{self.ERROR}]Error:[/{self.ERROR}] {message}")

    def print_success(self, message: str) -> None:
        """Print a success message."""
        self.console.print(f"[{self.SUCCESS}]{self.CHECK}[/{self.SUCCESS}] {message}")

    def print_warning(self, message: str) -> None:
        """Print a warning message."""
        self.console.print(f"[{self.WARNING}]{message}[/{self.WARNING}]")

    def format_size(self, size_bytes: int) -> str:
        """Format bytes as human-readable size."""
        if size_bytes < 1024:
            return f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            return f"{size_bytes / 1024:.1f} KB"
        else:
            return f"{size_bytes / (1024 * 1024):.2f} MB"

    @contextmanager
    def progress_bar(
        self,
        total: int | None = None,
        description: str = "Processing...",
    ) -> Iterator[Progress]:
        """Create a progress bar context manager.

        Args:
            total: Total number of items (None for indeterminate)
            description: Description text shown next to progress

        Yields:
            Progress instance for updating progress

        Example:
            >>> with formatter.progress_bar(total=10, description="Packaging") as progress:
            ...     task = progress.add_task(description, total=10)
            ...     for i in range(10):
            ...         progress.update(task, advance=1)
        """
        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeElapsedColumn(),
            console=self.console,
        )

        with progress:
            yield progress


# Global formatter instance with auto-detection
formatter = OutputFormatter()

# Maintain backward compatibility with existing console usage
console = formatter.console
error_console = formatter.error_console


def _format_size(size_bytes: int) -> str:
    """Format bytes as human-readable size (backward compatibility wrapper)."""
    return formatter.format_size(size_bytes)


def _display_result_summary(result: PackagingResult) -> None:
    """Display a brief success summary."""
    if result.success_count > 0:
        formatter.print_success(
            f"Packaged {result.success_count} skill(s) "
            f"({formatter.format_size(result.total_size_bytes)}) in {result.duration_seconds:.2f}s"
        )
        for skill in result.successful:
            formatter.print(f"  [{formatter.DIM}]{formatter.ARROW}[/{formatter.DIM}] {skill.output_path}")


def _display_result_table(result: PackagingResult) -> None:
    """Display detailed results in a rich table."""
    # Summary line
    formatter.print("")
    formatter.print(
        f"[bold]Packaging Results[/bold] "
        f"({result.success_count}/{result.total_skills} successful)"
    )
    formatter.print("")

    # Create results table
    table = Table(show_header=True, header_style="bold")
    table.add_column("Skill", style=formatter.INFO)
    table.add_column("Status", justify="center")
    table.add_column("Size", justify="right")
    table.add_column("Output Path")

    # Add successful skills
    for skill in result.successful:
        table.add_row(
            skill.skill_name,
            f"[{formatter.SUCCESS}]{formatter.CHECK}[/{formatter.SUCCESS}]",
            formatter.format_size(skill.size_bytes),
            str(skill.output_path) if skill.output_path else "",
        )

    # Add failed skills
    for skill in result.failed:
        table.add_row(
            skill.skill_name,
            f"[{formatter.ERROR}]{formatter.CROSS}[/{formatter.ERROR}]",
            "-",
            f"[{formatter.ERROR}]{skill.error}[/{formatter.ERROR}]" if skill.error else "",
        )

    formatter.console.print(table)

    # Summary footer
    formatter.print("")
    formatter.print(
        f"[{formatter.DIM}]Total:[/{formatter.DIM}] {formatter.format_size(result.total_size_bytes)} | "
        f"[{formatter.DIM}]Duration:[/{formatter.DIM}] {result.duration_seconds:.2f}s"
    )


def _display_errors(result: PackagingResult) -> None:
    """Display error information."""
    if result.failure_count > 0:
        formatter.error_console.print()
        formatter.error_console.print(
            f"[{formatter.ERROR}]{formatter.CROSS} {result.failure_count} skill(s) failed:[/{formatter.ERROR}]"
        )
        for skill in result.failed:
            formatter.error_console.print(
                f"  [{formatter.ERROR}]{formatter.BULLET}[/{formatter.ERROR}] {skill.skill_name}: {skill.error}"
            )


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
            help="Show detailed output with rich table and progress",
        ),
    ] = False,
) -> None:
    """Package Claude skills into ZIP archives.

    Discovers skills matching PATTERN and creates distributable ZIP archives.
    If no pattern is provided, packages all available skills.

    Examples:
        skillex zip              # Package all skills
        skillex zip python       # Package skills matching 'python'
        skillex zip -v           # Verbose output with table and progress
        skillex zip python -v    # Verbose output for python skills
    """
    # Use empty string if pattern is None
    search_pattern = pattern or ""

    try:
        # Create service
        service = PackagingService()

        # If verbose, show progress bar during packaging
        if verbose:
            # Pre-discover skills for progress bar
            from skillex.services.discovery import SkillDiscoveryService
            from skillex.services.fuzzy import FuzzyMatcherService

            discovery = SkillDiscoveryService()
            matcher = FuzzyMatcherService()
            all_skills = discovery.discover_all()
            matched = matcher.match(search_pattern, all_skills)

            if matched:
                with formatter.progress_bar() as progress:
                    task = progress.add_task(
                        f"Packaging {len(matched)} skill(s)...",
                        total=len(matched)
                    )
                    result = service.package_skills(pattern=search_pattern)
                    progress.update(task, completed=len(matched))
            else:
                result = service.package_skills(pattern=search_pattern)
        else:
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
                formatter.print_warning(f"No skills matching '{search_pattern}' found")
            else:
                formatter.print_warning("No skills found")
            raise typer.Exit(code=0)

    except PackagingError as e:
        formatter.print_error(str(e))
        raise typer.Exit(code=1) from None

    except SkillexError as e:
        formatter.print_error(str(e))
        raise typer.Exit(code=1) from None


def _display_skills_table(skills: list[SkillInfo]) -> None:
    """Display skills in a rich table.

    Args:
        skills: List of SkillInfo objects to display
    """
    table = Table(show_header=True, header_style="bold")
    table.add_column("Skill", style=formatter.INFO)
    table.add_column("Size", justify="right")
    table.add_column("Files", justify="right")
    table.add_column("Path")

    for skill in skills:
        table.add_row(
            skill.name,
            formatter.format_size(skill.size_bytes),
            str(skill.file_count),
            str(skill.path),
        )

    formatter.console.print(table)


@app.command(name="list")
def list_skills(
    pattern: Annotated[
        str | None,
        typer.Argument(
            help="Pattern to filter skill names (empty shows all)",
            show_default=False,
        ),
    ] = None,
) -> None:
    """List available Claude skills.

    Discovers skills from the skills directory and displays them in a table.
    If a pattern is provided, filters skills using fuzzy substring matching.

    Examples:
        skillex list              # List all skills
        skillex list python       # List skills matching 'python'
    """
    search_pattern = pattern or ""

    try:
        # Create services
        discovery_service = SkillDiscoveryService()
        fuzzy_matcher = FuzzyMatcherService()

        # Discover skills
        all_skills = discovery_service.discover_all()

        # Filter if pattern provided
        skills = fuzzy_matcher.match(search_pattern, all_skills) if search_pattern else all_skills

        # Handle no skills found
        if not skills:
            if search_pattern:
                formatter.print_warning(f"No skills matching '{search_pattern}' found")
            else:
                formatter.print_warning("No skills found")
            raise typer.Exit(code=0)

        # Display table
        _display_skills_table(skills)

        # Summary
        formatter.print("")
        formatter.print_success(f"Found {len(skills)} skill(s)")

    except SkillexError as e:
        formatter.print_error(str(e))
        raise typer.Exit(code=1) from None


def main() -> None:
    """Entry point for the CLI."""
    app()


if __name__ == "__main__":
    main()
