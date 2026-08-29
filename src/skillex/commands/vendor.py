"""``skillex vendor`` - declare external skill repos, vendor them into the catalog.

Shaped after ``commands/topology.py``: a module-level ``typer.Typer`` group, a
``register(app)`` that adds it, ``--json`` emitted with ``typer.echo`` and exits
via ``raise typer.Exit(code=...)``. Every filesystem decision lives in
``core/vendor.py``; this file is flag parsing, rendering and exit codes.

**Deliberately not wired into ``skillex sync``.** Sync is a projection command
that runs constantly and mutates only symlinks in activation roots. Vendoring
writes committed content into a git repository the user reviews and pushes. Those
are different blast radii and different cadences, and folding one into the other
would mean a routine sync could rewrite the catalog. ``vendor`` is invoked
deliberately, and ``sync`` never reads ``sources.toml``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console
from rich.markup import escape

from skillex.core.diagnostics import (
    EXIT_CONFIG,
    EXIT_DRIFT,
    EXIT_INTERNAL,
    EXIT_LOCK_BUSY,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_REFUSED,
    VENDOR_STRICT_PROMOTES,
    Code,
    Finding,
    Reporter,
    Severity,
    exit_code_for,
)
from skillex.core.file_lock import FileLock, LockBusyError
from skillex.core.gitsource import GitCli
from skillex.core.loader import SourcesError, SourcesParseError, load_sources_manifest
from skillex.core.models import SourcesManifest, UnsupportedFieldError
from skillex.core.payload import PayloadError
from skillex.core.provenance import read_provenance
from skillex.core.vendor import (
    SOURCES_FILENAME,
    VendorAction,
    VendorPlan,
    apply_relink,
    apply_vendor,
    catalog_root,
    check_vendor,
    checkout_candidates,
    local_checkouts_path,
    plan_relink,
    plan_vendor,
    recover_stage,
    report_unchanged,
    resolve_checkout,
)
from skillex.paths import default_lock_path, registry_roots

console = Console()
err_console = Console(stderr=True)

vendor_app = typer.Typer(
    name="vendor",
    help="Vendor external skill repositories into all-skills/ as real, pinned content.",
    no_args_is_help=True,
)


# ---------------------------------------------------------------------------
# shared option plumbing
# ---------------------------------------------------------------------------

CatalogOpt = Annotated[
    Path | None,
    typer.Option("--catalog", help="Catalog root to write. Default: <registry>/all-skills."),
]
SourcesOpt = Annotated[
    Path | None,
    typer.Option("--sources", help=f"Sources manifest. Default: <catalog>/{SOURCES_FILENAME}."),
]
SelectOpt = Annotated[
    list[str] | None,
    typer.Option("--source", help="Restrict to these source names. Repeatable."),
]
CheckoutOpt = Annotated[
    list[str] | None,
    typer.Option("--checkout", help="NAME=PATH override for one checkout. Repeatable."),
]
JsonOpt = Annotated[bool, typer.Option("--json", help="Machine-readable report on stdout.")]
VerboseOpt = Annotated[bool, typer.Option("-v", "--verbose", help="Show info findings.")]


class SetupError(Exception):
    """A setup failure that already has a finding; the caller renders and exits."""

    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


def _parse_checkouts(raw: list[str] | None, reporter: Reporter) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for item in raw or []:
        name, sep, path = item.partition("=")
        if not sep or not name or not path:
            reporter.emit(
                Code.E_SOURCES_INVALID,
                f"--checkout {item!r} is not NAME=PATH",
                fix="write it as --checkout pjangler=~/code/33GOD/pjangler.",
            )
            raise SetupError(EXIT_CONFIG)
        out[name] = Path(path).expanduser()
    return out


def _resolve_catalog(explicit: Path | None, reporter: Reporter) -> Path:
    catalog = catalog_root(explicit, registry_roots(None))
    if catalog is None:
        reporter.emit(
            Code.E_NO_REGISTRY,
            "no registry root found, so there is no catalog to vendor into",
            fix="pass --catalog, or set PJ_SKILLS_REGISTRY_ROOT.",
        )
        raise SetupError(EXIT_CONFIG)
    return catalog


def _load(catalog: Path, sources: Path | None, reporter: Reporter) -> SourcesManifest:
    path = sources.expanduser() if sources else catalog / SOURCES_FILENAME
    try:
        return load_sources_manifest(path)
    except SourcesError as e:
        # An UnsupportedFieldError is a field that IS in the schema and that
        # vendoring refuses on purpose -- the same distinction sync draws, and the
        # same code, so a script's mapping does not have to learn a second one.
        if isinstance(e.__cause__, UnsupportedFieldError):
            code, remedy = Code.E_UNSUPPORTED_FIELD, "remove the field; the message says why."
        elif isinstance(e, SourcesParseError):
            code, remedy = Code.E_SOURCES_PARSE, "fix the TOML syntax."
        else:
            code, remedy = Code.E_SOURCES_INVALID, "check the field against docs/VENDORING.md."
        reporter.emit(code, str(e), path=path, fix=remedy)
        raise SetupError(EXIT_CONFIG) from e


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------

_COLOUR = {Severity.ERROR: "red", Severity.WARNING: "yellow", Severity.INFO: "dim"}


def _render_findings(reporter: Reporter, *, verbose: bool) -> None:
    """Group by code and print head + tail, matching ``sync``'s renderer."""
    order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}
    findings = sorted(reporter.findings, key=lambda f: (order[f.severity], f.code.value))
    grouped: dict[Code, list[Finding]] = {}
    for finding in findings:
        if finding.severity is Severity.INFO and not verbose:
            continue
        grouped.setdefault(finding.code, []).append(finding)

    for code, group in grouped.items():
        head = group[0]
        colour = _COLOUR[head.severity]
        label = head.severity.name.lower()
        suffix = f" [dim](and {len(group) - 1} more)[/dim]" if len(group) > 1 else ""
        # escape(): every one of these strings is authored prose, and the vendoring
        # messages are full of `[[source]]` -- which Rich reads as markup and eats,
        # turning the one instruction that matters into "declare it as its own []".
        console.print(f"[{colour}]{label} {code.value}[/{colour}]: {escape(head.message)}{suffix}")
        for finding in group[1:6]:
            console.print(f"    {escape(str(finding.name or finding.path))}")
        if len(group) > 6:
            console.print(f"    [dim]... {len(group) - 6} more[/dim]")
        for line in head.detail:
            console.print(f"    [dim]{escape(line)}[/dim]")
        if head.fix:
            console.print(f"    [cyan]fix:[/cyan] {escape(head.fix)}")
    if grouped:
        console.print()


def _promote(reporter: Reporter, *, strict: bool) -> None:
    if strict:
        reporter.findings = [
            f.promoted() if f.code in VENDOR_STRICT_PROMOTES else f for f in reporter.findings
        ]


def _emit(payload: dict[str, Any], *, json_out: bool) -> None:
    if json_out:
        # typer.echo, never console.print: Rich soft-wraps and would corrupt long
        # JSON strings mid-token.
        typer.echo(json.dumps(payload, indent=2, sort_keys=True))


def _base_payload(reporter: Reporter, catalog: Path, *, exit_code: int) -> dict[str, Any]:
    return {
        "schema": 1,
        "ok": exit_code == EXIT_OK,
        "exit": exit_code,
        "catalog": str(catalog),
        "findings": [f.as_dict() for f in reporter.findings],
    }


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------


@vendor_app.command("list")
def list_cmd(
    catalog: CatalogOpt = None,
    sources: SourcesOpt = None,
    checkout: CheckoutOpt = None,
    json_out: JsonOpt = False,
) -> None:
    """Show the declared sources and where each resolves on this machine."""
    reporter = Reporter()
    try:
        catalog_path = _resolve_catalog(catalog, reporter)
        overrides = _parse_checkouts(checkout, reporter)
        manifest = _load(catalog_path, sources, reporter)
    except SetupError as bail:
        _emit(_base_payload(reporter, catalog or Path("."), exit_code=bail.code), json_out=json_out)
        if not json_out:
            _render_findings(reporter, verbose=True)
        raise typer.Exit(bail.code) from None

    rows: list[dict[str, Any]] = []
    for entry in manifest.sources:
        found = resolve_checkout(entry, overrides=overrides)
        rows.append(
            {
                "name": entry.name,
                "repo": entry.repo,
                "version": entry.version,
                "subdir": entry.subdir,
                "checkout_id": entry.checkout_id,
                "checkout": str(found) if found else None,
                "optional": entry.optional,
                "skills": [
                    {"name": s.name, "dir": s.relpath, "path": entry.tree_path(s)}
                    for s in entry.skills
                ]
                or None,
                "candidates": [str(p) for p in checkout_candidates(entry, overrides=overrides)],
            }
        )

    if json_out:
        payload = _base_payload(reporter, catalog_path, exit_code=EXIT_OK)
        payload["sources"] = rows
        payload["manifest"] = str(manifest.path)
        _emit(payload, json_out=True)
        raise typer.Exit(EXIT_OK)

    console.print(f"[bold]{manifest.path}[/bold]  ({len(rows)} source(s))\n")
    for row in rows:
        mark = "[green]found[/green]" if row["checkout"] else "[red]missing[/red]"
        console.print(f"[bold]{row['name']}[/bold]  {row['repo']} @ {row['version']}")
        console.print(f"  subdir     {row['subdir'] or '<repo root>'}")
        console.print(f"  checkout   {mark} {row['checkout'] or row['candidates'][-1]}")
        skills = row["skills"]
        if skills:
            console.print(f"  skills     {', '.join(s['name'] for s in skills)}")
        else:
            console.print("  skills     (discovered from the subdir)")
        console.print()
    console.print(f"[dim]machine-local checkouts: {local_checkouts_path()}[/dim]")
    raise typer.Exit(EXIT_OK)


@vendor_app.command("status")
def status_cmd(
    catalog: CatalogOpt = None,
    sources: SourcesOpt = None,
    select: SelectOpt = None,
    checkout: CheckoutOpt = None,
    upstream: Annotated[
        bool, typer.Option("--upstream", help="Also re-resolve each version; needs the checkouts.")
    ] = False,
    strict: Annotated[bool, typer.Option("--strict", help="Treat vendor warnings as errors.")] = (
        False
    ),
    json_out: JsonOpt = False,
    verbose: VerboseOpt = False,
) -> None:
    """Verify the catalog against its own recorded pins. Offline, read-only.

    Without ``--upstream`` this needs no source repository at all: it recomputes
    each vendored directory's digest and compares it to the ``.source.yaml``
    beside it. That is the whole machine-2 story -- clone the catalog, run this,
    get a yes or no. Exits 6 when anything drifted.
    """
    reporter = Reporter()
    try:
        catalog_path = _resolve_catalog(catalog, reporter)
        overrides = _parse_checkouts(checkout, reporter)
        manifest = _load(catalog_path, sources, reporter)
    except SetupError as bail:
        _emit(_base_payload(reporter, catalog or Path("."), exit_code=bail.code), json_out=json_out)
        if not json_out:
            _render_findings(reporter, verbose=True)
        raise typer.Exit(bail.code) from None

    rows = check_vendor(
        catalog_path,
        manifest,
        reporter,
        reader=GitCli() if upstream else None,
        checkouts=overrides,
        select=tuple(select or ()),
    )
    _promote(reporter, strict=strict)
    code = exit_code_for(reporter.findings)
    if code == EXIT_OK and reporter.warnings():
        code = EXIT_DRIFT

    if json_out:
        payload = _base_payload(reporter, catalog_path, exit_code=code)
        payload["skills"] = [row.as_dict() for row in rows]
        _emit(payload, json_out=True)
        raise typer.Exit(code)

    _render_findings(reporter, verbose=verbose)
    clean = sum(1 for row in rows if row.state == "ok")
    console.print(
        f"[{'green' if code == EXIT_OK else 'yellow'}]{len(rows)} declared, "
        f"{clean} verified[/], {len(reporter.warnings())} warning(s)"
    )
    raise typer.Exit(code)


@vendor_app.command("sync")
def sync_cmd(
    catalog: CatalogOpt = None,
    sources: SourcesOpt = None,
    select: SelectOpt = None,
    checkout: CheckoutOpt = None,
    dry_run: Annotated[
        bool, typer.Option("-n", "--dry-run", help="Plan only; change nothing.")
    ] = False,
    adopt: Annotated[
        bool,
        typer.Option("--adopt", help="Take over existing unmanaged catalog dirs, replacing them."),
    ] = False,
    force: Annotated[
        bool, typer.Option("--force", help="Discard local edits to a vendored skill.")
    ] = False,
    prune: Annotated[
        bool, typer.Option("--prune", help="Remove catalog entries a source no longer declares.")
    ] = False,
    strict: Annotated[bool, typer.Option("--strict", help="Treat vendor warnings as errors.")] = (
        False
    ),
    json_out: JsonOpt = False,
    verbose: VerboseOpt = False,
) -> None:
    """Copy each declared skill out of its repository at the pinned version.

    Reads the version's git objects from a checkout that is already on this
    machine. Nothing is fetched and nothing is cloned; a version that is not in
    the local object store is a refusal carrying the ``git fetch`` to run.

    Any error at all means ZERO mutation, in every source.
    """
    reporter = Reporter()
    try:
        catalog_path = _resolve_catalog(catalog, reporter)
        overrides = _parse_checkouts(checkout, reporter)
        manifest = _load(catalog_path, sources, reporter)
    except SetupError as bail:
        _emit(_base_payload(reporter, catalog or Path("."), exit_code=bail.code), json_out=json_out)
        if not json_out:
            _render_findings(reporter, verbose=True)
        raise typer.Exit(bail.code) from None

    reader = GitCli()
    if not recover_stage(catalog_path, reporter):
        _promote(reporter, strict=strict)
        code = exit_code_for(reporter.findings)
        _emit(_base_payload(reporter, catalog_path, exit_code=code), json_out=json_out)
        if not json_out:
            _render_findings(reporter, verbose=verbose)
        raise typer.Exit(code)

    plan = plan_vendor(
        catalog_path,
        manifest,
        reporter,
        reader=reader,
        select=tuple(select or ()),
        checkouts=overrides,
        adopt=adopt,
        force=force,
        prune=prune,
    )
    report_unchanged(plan, reporter)
    _promote(reporter, strict=strict)
    code = exit_code_for(reporter.findings)

    applied = False
    if code == EXIT_OK and not dry_run and plan.has_changes:
        try:
            with FileLock(default_lock_path()):
                apply_vendor(plan, reporter, reader=reader)
            applied = True
        except LockBusyError as e:
            err_console.print(f"[red]{e}[/red]")
            raise typer.Exit(EXIT_LOCK_BUSY) from e
        except (PayloadError, OSError) as e:
            reporter.emit(
                Code.E_VENDOR_STAGE_DIRTY,
                f"staging failed and nothing was swapped: {e}",
                path=catalog_path,
                fix="re-run; the stage directory is removed automatically.",
            )
            code = EXIT_INTERNAL
        else:
            code = exit_code_for(reporter.findings)

    if code == EXIT_OK and any(r.skipped for r in plan.resolutions):
        code = EXIT_PARTIAL

    if json_out:
        payload = _base_payload(reporter, catalog_path, exit_code=code)
        payload["dry_run"] = dry_run
        payload["applied"] = applied
        payload["counts"] = plan.counts
        payload["sources"] = [r.as_dict() for r in plan.resolutions]
        payload["ops"] = [op.as_dict() for op in plan.ops]
        _emit(payload, json_out=True)
        raise typer.Exit(code)

    _render_plan(plan, verbose=verbose)
    _render_findings(reporter, verbose=verbose)
    if code == EXIT_OK:
        verb = "would vendor" if dry_run or not plan.has_changes else "vendored"
        console.print(
            f"[green]ok[/green]  {len(plan.resolutions)} source(s), {verb} "
            f"{len(plan.writes)}, {len(plan.prunes)} prune(s), "
            f"{len(reporter.warnings())} warning(s)"
        )
    raise typer.Exit(code)


def _render_plan(plan: VendorPlan, *, verbose: bool) -> None:
    for resolution in plan.resolutions:
        mark = "[dim]skipped[/dim]" if resolution.skipped else (resolution.commit or "?")[:8]
        console.print(
            f"[bold]{resolution.name}[/bold]  {resolution.repo} @ {resolution.version} -> {mark}"
        )
    if plan.resolutions:
        console.print()
    for op in plan.ops:
        if op.action is VendorAction.UNCHANGED and not verbose:
            continue
        colour = "dim" if op.action is VendorAction.UNCHANGED else "cyan"
        console.print(
            f"  [{colour}]{op.action.value:12}[/{colour}] {op.name}"
            f"  [dim]{op.source}:{op.repo_path}[/dim]"
        )
    if plan.ops:
        console.print()


@vendor_app.command("relink")
def relink_cmd(
    root: Annotated[
        Path | None,
        typer.Option(
            "--root", help="Repo holding sets/ and packs/. Default: the catalog's parent."
        ),
    ] = None,
    catalog: CatalogOpt = None,
    dry_run: Annotated[
        bool, typer.Option("-n", "--dry-run", help="Plan only; change nothing.")
    ] = False,
    json_out: JsonOpt = False,
    verbose: VerboseOpt = False,
) -> None:
    """Repoint composition symlinks that bypass the catalog at a vendored entry.

    Vendoring alone does not close the portability gap: 22 of the 25 composition
    links that dangle on a second machine point straight at ``~/code/33GOD`` and
    never touch ``all-skills/`` at all. This rewrites them to
    ``../../all-skills/<name>``, preserving each link's NAME -- which is the
    projected name, and is not always the target's basename.
    """
    reporter = Reporter()
    try:
        catalog_path = _resolve_catalog(catalog, reporter)
    except SetupError as bail:
        if not json_out:
            _render_findings(reporter, verbose=True)
        raise typer.Exit(bail.code) from None

    base = (root.expanduser() if root else catalog_path.parent).resolve()
    ops = plan_relink([base / "sets", base / "packs"], catalog_path, reporter)

    code = exit_code_for(reporter.findings)
    applied = False
    if code == EXIT_OK and not dry_run and ops:
        try:
            with FileLock(default_lock_path()):
                apply_relink(ops, reporter)
            applied = True
        except LockBusyError as e:
            err_console.print(f"[red]{e}[/red]")
            raise typer.Exit(EXIT_LOCK_BUSY) from e

    if json_out:
        payload = _base_payload(reporter, catalog_path, exit_code=code)
        payload["dry_run"] = dry_run
        payload["applied"] = applied
        payload["root"] = str(base)
        payload["relinks"] = [op.as_dict() for op in ops]
        _emit(payload, json_out=True)
        raise typer.Exit(code)

    for op in ops:
        console.print(
            f"  [cyan]relink[/cyan] {op.link.relative_to(base)}  [dim]{op.old}[/dim] -> {op.new}"
        )
    if ops:
        console.print()
    _render_findings(reporter, verbose=verbose)
    verb = "would repoint" if dry_run else "repointed"
    console.print(f"[green]ok[/green]  {verb} {len(ops)} link(s)")
    raise typer.Exit(code)


@vendor_app.command("show")
def show_cmd(
    name: Annotated[str, typer.Argument(help="Catalog entry to describe.")],
    catalog: CatalogOpt = None,
    json_out: JsonOpt = False,
) -> None:
    """Print one catalog entry's provenance record."""
    reporter = Reporter()
    try:
        catalog_path = _resolve_catalog(catalog, reporter)
    except SetupError as bail:
        raise typer.Exit(bail.code) from None
    target = catalog_path / name
    prov = read_provenance(target) if target.is_dir() and not target.is_symlink() else None
    if prov is None:
        reporter.emit(
            Code.W_VENDOR_UNRECORDED,
            f"{name}: no provenance record at {target}",
            name=name,
            path=target,
        )
        if json_out:
            _emit(_base_payload(reporter, catalog_path, exit_code=EXIT_REFUSED), json_out=True)
        else:
            _render_findings(reporter, verbose=True)
        raise typer.Exit(EXIT_REFUSED)
    if json_out:
        payload = _base_payload(reporter, catalog_path, exit_code=EXIT_OK)
        payload["name"] = name
        payload["origin"] = prov.as_dict()
        _emit(payload, json_out=True)
        raise typer.Exit(EXIT_OK)
    for key, value in prov.as_dict().items():
        if value is not None:
            console.print(f"  {key:18} {value}")
    raise typer.Exit(EXIT_OK)


def register(app: typer.Typer) -> None:
    """Register the vendor command group."""
    app.add_typer(vendor_app, name="vendor")
