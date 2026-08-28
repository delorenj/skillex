"""`skillex sync` - reconcile every activation root reachable from the CWD.

Thin by design: flag parsing, orchestration, rendering, exit codes. Every
filesystem decision lives in ``core/``.

The orchestration has one non-obvious property worth stating up front: **both
scopes are fully resolved and diffed before either is written.** A broken project
manifest must not leave a half-written global root, and the only way to guarantee
that is to do all the reading first.
"""

from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console

from skillex.core.aliases import check_aliases, ensure_aliases
from skillex.core.diagnostics import (
    EXIT_DRIFT,
    EXIT_LOCK_BUSY,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_REFUSED,
    STRICT_PROMOTES,
    Code,
    Finding,
    RefusalError,
    Reporter,
    Severity,
    exit_code_for,
)
from skillex.core.file_lock import FileLock, LockBusyError
from skillex.core.loader import ManifestError, load_skills_manifest
from skillex.core.models import SkillsManifest, UnsupportedFieldError
from skillex.core.projection import (
    Action,
    ReconcilePlan,
    RootState,
    apply,
    classify_root,
    diff,
    managed_roots,
    preflight,
)
from skillex.core.resolver import Binding, Desired, compose
from skillex.core.scope import Scope, ScopeKind, discover_scopes
from skillex.core.state import ProjectionState, forget, load_state
from skillex.paths import default_lock_path, registry_roots

console = Console()
err_console = Console(stderr=True)


class ScopeResult:
    """Everything computed for one scope, before anything is written."""

    def __init__(
        self,
        scope: Scope,
        manifest: SkillsManifest | None,
        desired: Desired,
        state: ProjectionState,
        current: RootState,
        plan: ReconcilePlan,
    ) -> None:
        self.scope = scope
        self.manifest = manifest
        self.desired = desired
        self.state = state
        self.current = current
        self.plan = plan
        self.applied = False


def _empty_manifest(path: Path) -> SkillsManifest:
    """An absent manifest projects nothing. It is not an error.

    AC: "If the cwd has no manifest, the global skills are assumed" -- the global
    *scope* is assumed, and if its manifest is missing too the root is simply
    created empty rather than the command failing.
    """
    return SkillsManifest(path=path)


def _load(path: Path) -> SkillsManifest:
    if not path.is_file():
        return _empty_manifest(path)
    return load_skills_manifest(path)


def _render(reporter: Reporter, results: list[ScopeResult], *, verbose: bool) -> None:
    for result in results:
        scope = result.scope
        console.print(f"[bold]{scope.label:8}[/bold] {scope.root}")
        console.print(
            f"  manifest  {scope.manifest_path}"
            + ("" if scope.manifest_path.is_file() else "  [dim](absent)[/dim]")
        )
        root_desc = {
            "absent": "absent",
            "real_dir": f"real dir, {len(result.current.children)} entries"
            + (f" ({len(result.plan.reserved)} reserved)" if result.plan.reserved else ""),
            "symlink": f"symlink -> {result.current.link_target}",
            "other": "not a directory",
        }[result.current.kind]
        receipt = (
            "no state file" if result.state.absent else f"{len(result.state.entries)} recorded"
        )
        console.print(f"  root      {root_desc}, {receipt}")
        if result.manifest is not None:
            for index, entry in enumerate(result.manifest.sets):
                count = sum(
                    1
                    for b in result.desired.bindings.values()
                    if b.origin.startswith(f"sets[{index}]")
                )
                console.print(f"  set       {entry.name} -> {count} members")
            if result.manifest.packs:
                console.print(f"  pack      {result.manifest.packs[0].name}")
        counts = result.plan.counts
        console.print(
            f"\n  [green]+ add {counts['add']}[/green]"
            f"   [yellow]~ replace {counts['replace']}[/yellow]"
            f"   [red]- remove {counts['remove']}[/red]"
            f"   = keep {counts['keep']}"
            f"   ! blocked {counts['blocked']}\n"
        )
        if verbose:
            for op in result.plan.ops:
                if op.action is Action.KEEP and not verbose:
                    continue
                console.print(f"    {op.action.value:8} {op.name}  [dim]{op.target or ''}[/dim]")

    _render_findings(reporter, verbose=verbose)


def _render_findings(reporter: Reporter, *, verbose: bool) -> None:
    order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}
    findings = sorted(reporter.findings, key=lambda f: (order[f.severity], f.code.value))
    grouped: dict[Code, list[Finding]] = OrderedDict()
    for finding in findings:
        if finding.severity is Severity.INFO and not verbose:
            continue
        grouped.setdefault(finding.code, []).append(finding)

    for code, group in grouped.items():
        head = group[0]
        colour = {
            Severity.ERROR: "red",
            Severity.WARNING: "yellow",
            Severity.INFO: "dim",
        }[head.severity]
        label = head.severity.name.lower()
        if len(group) == 1:
            console.print(f"[{colour}]{label} {code.value}[/{colour}]: {head.message}")
        else:
            console.print(
                f"[{colour}]{label} {code.value}[/{colour}]: "
                f"{head.message} [dim](and {len(group) - 1} more)[/dim]"
            )
            for finding in group[1:6]:
                console.print(f"    {finding.name or finding.path}")
            if len(group) > 6:
                console.print(f"    [dim]... {len(group) - 6} more[/dim]")
        for line in head.detail:
            console.print(f"    [dim]{line}[/dim]")
        if head.fix:
            console.print(f"    [cyan]fix:[/cyan] {head.fix}")
    console.print()


def _json_payload(
    reporter: Reporter, results: list[ScopeResult], *, exit_code: int, dry_run: bool
) -> dict[str, Any]:
    return {
        "schema": 1,
        "ok": exit_code == EXIT_OK,
        "exit": exit_code,
        "dry_run": dry_run,
        "scopes": [
            {
                "scope": r.scope.label,
                "manifest": str(r.scope.manifest_path),
                "root": str(r.scope.root),
                "mode": r.plan.mode,
                "alias_target": str(r.plan.alias_target) if r.plan.alias_target else None,
                "counts": r.plan.counts,
                "reserved": list(r.plan.reserved),
                "applied": r.applied,
                "ops": [
                    {
                        "action": op.action.value,
                        "name": op.name,
                        "from": str(op.current) if op.current else None,
                        "to": str(op.target) if op.target else None,
                        "origin": op.binding.origin if op.binding else None,
                    }
                    for op in r.plan.ops
                    if op.action is not Action.KEEP
                ],
                "shadows": [
                    {
                        "name": s.name,
                        "winner": s.winner.origin,
                        "loser": s.loser.origin,
                        "divergent": s.divergent,
                    }
                    for s in r.desired.shadows
                ],
                "aliases": [
                    {
                        "path": str(a.path),
                        "ok": a.ok,
                        "kind": a.kind,
                        "target": a.target,
                    }
                    for a in check_aliases(
                        r.scope.base or Path.home(),
                        r.scope.root,
                        is_global=r.scope.kind is ScopeKind.GLOBAL,
                    )
                ],
            }
            for r in results
        ],
        "findings": [f.as_dict() for f in reporter.findings],
    }


def _explain(name: str, results: list[ScopeResult]) -> int:
    found = False
    for result in results:
        binding: Binding | None = result.desired.bindings.get(name)
        if binding is None:
            continue
        found = True
        console.print(f"[bold]{name}[/bold]  ({result.scope.label})")
        console.print(f"  declared   {binding.origin}")
        if binding.link_path:
            console.print(f"  member     {binding.link_path}")
        for index, hop in enumerate(binding.chain[1:], start=1):
            console.print(f"    hop {index} -> {hop}")
        console.print(f"  target     {binding.target}   [dim](one hop; canonical)[/dim]")
        console.print(f"  projected  {result.scope.root / name}")
        shadows = [s for s in result.desired.shadows if s.name == name]
        if shadows:
            for shadow in shadows:
                marker = "diverges" if shadow.divergent else "same target"
                console.print(f"  shadowed   {shadow.loser.origin}  [dim]({marker})[/dim]")
        else:
            console.print("  shadows    none")
        base = result.scope.base or Path.home()
        aliases = check_aliases(
            base, result.scope.root, is_global=result.scope.kind is ScopeKind.GLOBAL
        )
        # Relative to the scope's base, so the list reads as the CLI directories it
        # is (".claude/skills") rather than eight repetitions of the home path.
        reachable = " ".join(str(a.path.relative_to(base)) for a in aliases if a.ok)
        console.print(f"  reachable  {reachable or '(none)'}")
    if not found:
        err_console.print(f"[red]{name} is not projected by any scope in play.[/red]")
        return EXIT_REFUSED
    return EXIT_OK


def register(app: typer.Typer) -> None:
    @app.command()
    def sync(
        dry_run: Annotated[
            bool, typer.Option("-n", "--dry-run", help="Plan only; change nothing.")
        ] = False,
        exit_code_on_drift: Annotated[
            bool,
            typer.Option("--exit-code", help="With --dry-run, exit 6 when the plan is non-empty."),
        ] = False,
        json_out: Annotated[
            bool, typer.Option("--json", help="Machine-readable plan and result on stdout.")
        ] = False,
        scope: Annotated[
            str,
            typer.Option("--scope", help="auto | global | project | both. Override only."),
        ] = "auto",
        project: Annotated[
            Path | None, typer.Option("--project", help="Explicit project root.")
        ] = None,
        strict: Annotated[
            bool, typer.Option("--strict", help="Treat topology warnings as errors.")
        ] = False,
        no_inherit: Annotated[
            bool, typer.Option("--no-inherit", help="Ignore inherit_global this run.")
        ] = False,
        skip_occupied: Annotated[
            bool,
            typer.Option("--skip-occupied", help="Skip names blocked by foreign content; exit 4."),
        ] = False,
        fix_aliases: Annotated[
            bool,
            typer.Option("--fix-aliases", help="Convert a real CLI skills dir to an alias."),
        ] = False,
        prune: Annotated[
            bool,
            typer.Option(
                "--prune/--no-prune", help="Remove links sync wrote and no longer declares."
            ),
        ] = True,
        registry_root: Annotated[
            Path | None, typer.Option("--registry-root", help="Override the registry ladder.")
        ] = None,
        explain: Annotated[
            str | None, typer.Option("--explain", help="Full provenance for one name.")
        ] = None,
        forget_state: Annotated[
            bool, typer.Option("--forget", help="Delete this root's state file and exit.")
        ] = False,
        verbose: Annotated[
            bool, typer.Option("-v", "--verbose", help="Show keeps and info.")
        ] = False,
    ) -> None:
        """Reconcile every activation root reachable from the current directory."""
        if explain is not None:
            dry_run = True

        cwd = Path.cwd()
        reporter = Reporter()
        results: list[ScopeResult] = []

        try:
            if registry_root is not None:
                roots = [registry_root.expanduser().resolve()]
            else:
                roots = registry_roots(None)

            plan = discover_scopes(cwd, scope=scope, project=project, registry_roots=roots)
            reporter.extend(plan.findings)

            if forget_state:
                for target in plan.scopes:
                    removed = forget(target.root)
                    console.print(f"{'forgot' if removed else 'no state for'} {target.root}")
                raise typer.Exit(EXIT_OK)

            managed = managed_roots(roots)
            global_bindings: OrderedDict[str, Binding] | None = None

            # ---- PREFLIGHT: resolve and diff BOTH scopes before writing either.
            for target in plan.scopes:
                reporter.scope = target.label
                manifest = _load(target.manifest_path)
                scoped_roots = registry_roots(manifest.registry) if manifest.registry else roots
                desired = compose(
                    manifest,
                    target,
                    scoped_roots,
                    reporter,
                    inherited=global_bindings,
                    inherit=not no_inherit
                    and (manifest.inherit_global if manifest.inherit_global is not None else True),
                )
                if target.kind is ScopeKind.GLOBAL:
                    global_bindings = desired.bindings
                preflight(target.root, scoped_roots, reporter)
                state = load_state(target.root)
                current = classify_root(target.root)
                if current.kind == "other":
                    raise RefusalError(
                        Finding(
                            code=Code.E_ROOT_NOT_DIR,
                            message=f"{target.root} is neither a directory nor a symlink",
                            path=target.root,
                            fix="move it out of the way.",
                        )
                    )
                rplan = diff(
                    current,
                    desired,
                    state,
                    managed,
                    reporter,
                    skip_occupied=skip_occupied,
                    prune=prune,
                )
                results.append(ScopeResult(target, manifest, desired, state, current, rplan))
            reporter.scope = None
        except RefusalError as refusal:
            reporter.findings.append(refusal.finding)
        except ManifestError as e:
            # The loader wraps an UnsupportedFieldError rather than letting it escape,
            # so the cause is the only thing that still distinguishes "your JSON is
            # broken" from "that field parses, is in the published schema, and sync
            # refuses it on purpose". Both are config errors (exit 2); only the code
            # tells a script which one it is -- and E_UNSUPPORTED_FIELD exists in the
            # enum precisely to be that code.
            unsupported = isinstance(e.__cause__, UnsupportedFieldError)
            reporter.emit(
                Code.E_UNSUPPORTED_FIELD if unsupported else Code.E_MANIFEST_PARSE,
                str(e),
                fix=(
                    "remove the field; the message above says what it would have done."
                    if unsupported
                    else "fix the JSON, or check it against skills.schema.json."
                ),
            )
        except LockBusyError as e:
            err_console.print(f"[red]{e}[/red]")
            raise typer.Exit(EXIT_LOCK_BUSY) from e

        if strict:
            reporter.findings = [
                f.promoted() if f.code in STRICT_PROMOTES else f for f in reporter.findings
            ]

        if explain is not None:
            raise typer.Exit(_explain(explain, results))

        # Promotion above already turned every STRICT_PROMOTES warning into an ERROR,
        # and a promoted code is never a config error, so this yields EXIT_REFUSED on
        # its own. There is deliberately no "any warning fails --strict" fallback:
        # that would fail on W_SET_OPTIONAL_MISSING and W_CLI_ROOT_NOT_ALIAS too, and
        # STRICT_PROMOTES exists precisely to say those are not topology violations.
        code = exit_code_for(reporter.findings)

        drift = any(r.plan.has_drift for r in results)

        # Any error at all means ZERO mutation, in either scope.
        if code == EXIT_OK and not dry_run:
            try:
                with FileLock(default_lock_path()):
                    for result in results:
                        reporter.scope = result.scope.label
                        preflight(result.scope.root, roots, reporter)
                        apply(
                            result.scope,
                            result.plan,
                            result.desired,
                            result.state,
                            roots,
                        )
                        result.applied = True
                        ensure_aliases(
                            result.scope.base or Path.home(),
                            result.scope.root,
                            reporter,
                            is_global=result.scope.kind is ScopeKind.GLOBAL,
                            fix=fix_aliases,
                        )
                    reporter.scope = None
            except LockBusyError as e:
                err_console.print(f"[red]{e}[/red]")
                raise typer.Exit(EXIT_LOCK_BUSY) from e
            except KeyboardInterrupt:
                err_console.print(
                    "[yellow]interrupted; the root holds a superset "
                    "(nothing was removed). Re-run to converge.[/yellow]"
                )
                raise typer.Exit(130) from None
            code = exit_code_for(reporter.findings)

        if skip_occupied and any(r.plan.by(Action.BLOCKED) for r in results) and code == EXIT_OK:
            code = EXIT_PARTIAL
        if dry_run and exit_code_on_drift and drift and code == EXIT_OK:
            code = EXIT_DRIFT

        if json_out:
            # typer.echo, never console.print: Rich soft-wraps and would corrupt
            # long JSON strings mid-token.
            typer.echo(
                json.dumps(_json_payload(reporter, results, exit_code=code, dry_run=dry_run))
            )
        else:
            _render(reporter, results, verbose=verbose)
            if code == EXIT_OK:
                total = sum(len(r.desired.bindings) for r in results)
                verb = "would link" if dry_run else "linked"
                console.print(
                    f"[green]ok[/green]  {len(results)} scope(s), {verb} {total}, "
                    f"{len(reporter.warnings())} warning(s)"
                )
        raise typer.Exit(code)
