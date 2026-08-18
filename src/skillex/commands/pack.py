"""Pack lifecycle commands: list, show, lint, activate, deactivate, create."""

from __future__ import annotations

import json
from pathlib import Path

import typer
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from skillex.core.activator import apply, plan
from skillex.core.linter import (
    LintIssue,
    Severity,
    has_errors,
    is_sealed,
    lint_pack,
    lint_pack_contract,
)
from skillex.core.loader import (
    ManifestError,
    PackError,
    discover_skills,
    load_config,
    load_pack,
    load_pack_standalone,
    load_skills_manifest,
    resolve_inventory,
    resolve_pack_dir,
)
from skillex.core.models import Pack, PackEntry, PackManifest, SkillexConfig
from skillex.core.payload import PayloadError
from skillex.core.renderer import RenderError, apply_render, plan_render
from skillex.logging import get_logger
from skillex.paths import default_config_path, default_lock_path, registry_root_candidates

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
    table.add_column("path")
    table.add_column("description")

    for pack_dir in sorted(cfg.packs_root.iterdir()):
        if pack_dir.is_symlink() or not pack_dir.is_dir():
            continue
        for root in _pack_roots(pack_dir):
            rel = root.relative_to(cfg.packs_root).as_posix()
            try:
                pack = load_pack_standalone(root)
            except PackError as e:
                table.add_row(pack_dir.name, "?", rel, f"[red]{escape(str(e))}[/red]")
                continue
            table.add_row(
                pack.manifest.name,
                pack.manifest.version,
                rel,
                pack.manifest.description,
            )

    console.print(table)


def _pack_roots(pack_dir: Path) -> list[Path]:
    """Yield every pack root under `packs/<name>`: itself, or its version dirs."""
    if (pack_dir / "pack.toml").is_file():
        return [pack_dir]
    versions = [
        child
        for child in sorted(pack_dir.iterdir())
        if child.is_dir() and not child.is_symlink() and not child.name.startswith((".", "_"))
    ]
    versioned = [child for child in versions if (child / "pack.toml").is_file()]
    return versioned or [pack_dir]


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

    flat = resolve_inventory(pack)
    if flat.enabled:
        # A flattened pack's declared entries are containers; report what it
        # actually projects so the count is not mistaken for the skill total.
        console.print(
            f"[cyan]flattened[/cyan] (section 3b): {len(flat.skills)} leaf skills "
            f"from {len(pack.inventory)} declared entries"
        )

    issues = lint_pack(pack, skills_index)

    if not issues:
        console.print("[green]clean[/green]")
        return

    _print_issues(issues, prefix="")

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
        _print_issues([i for i in issues if i.severity is Severity.ERROR])
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


# ---------------------------------------------------------------------------
# Packs contract: render / verify / manifest
# ---------------------------------------------------------------------------


def _print_issues(issues: list[LintIssue], *, prefix: str = "  ") -> None:
    """Print findings. Messages and locations are escaped: they legitimately contain
    `[freeform]`, `[policy]` and regex character classes, which rich would eat as
    style markup."""
    for issue in issues:
        color = "red" if issue.severity is Severity.ERROR else "yellow"
        console.print(
            f"{prefix}[{color}]{issue.severity.value}[/{color}] "
            f"{issue.rule.value} at {escape(issue.location)}: {escape(issue.message)}"
        )


@pack_app.command("render")
def render_cmd(
    root: Path = typer.Argument(
        ..., help="Pack root directory, e.g. packs/NAME or packs/NAME/VERSION"
    ),
    name: str = typer.Option(..., "--name", help="Pack name; must match the directory"),
    version: str = typer.Option(..., "--version", help="Pack version; must match the version dir"),
    description: str = typer.Option("", "--description"),
    upstream: str | None = typer.Option(None, "--upstream", help="[source].upstream"),
    upstream_version: str | None = typer.Option(None, "--upstream-version"),
    rendered_from: str | None = typer.Option(None, "--rendered-from"),
    projection: str = typer.Option("symlink", "--project-projection"),
    sealed: bool = typer.Option(True, "--sealed/--no-sealed", help="[policy] sealed"),
    immutable: bool = typer.Option(True, "--immutable/--no-immutable", help="[policy] immutable"),
    flatten: bool = typer.Option(
        False,
        "--flatten",
        help="Discover section 3b containers as declared entries. Inferred "
        "automatically when the existing pack.toml declares [policy] flatten",
    ),
    check: bool = typer.Option(False, "--check", help="Plan only; write nothing"),
    force: bool = typer.Option(
        False,
        "--force",
        help="Re-render a pack marked immutable/base_readonly, or one whose "
        "declarations this render would drop",
    ),
) -> None:
    """Write pack.toml + SHA256SUMS for a pack directory.

    Skills are discovered as child directories holding a regular SKILL.md, or - for
    a pack that declares [policy] flatten - as the containers those skills nest
    under. The payload is pack.toml plus everything under those directories.
    Nothing is written unless the whole payload enumerates and hashes cleanly
    first, and a re-render that would lose an existing declaration needs --force.
    """
    try:
        render_plan = plan_render(
            root,
            name,
            version,
            description=description,
            upstream=upstream,
            upstream_version=upstream_version,
            rendered_from=rendered_from,
            immutable=immutable,
            sealed=sealed,
            project_projection=projection,
            flatten=flatten,
        )
    except (RenderError, PayloadError) as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(code=1) from e

    inventory = f"{len(render_plan.skills)} skills"
    if render_plan.flatten:
        inventory = (
            f"{len(render_plan.skills)} declared entries -> "
            f"{len(render_plan.leaves)} leaf skills (flattened)"
        )
    console.print(
        f"[bold]{render_plan.name}[/bold]@{render_plan.version}: {inventory}, "
        f"{render_plan.declared_payload_files} payload files (+pack.toml)"
    )
    if render_plan.dropped_keys and not force:
        console.print(
            f"[yellow]this render would drop {len(render_plan.dropped_keys)} existing "
            f"declaration(s): {escape(', '.join(render_plan.dropped_keys))}[/yellow]"
        )

    if check:
        for skill in render_plan.skills:
            console.print(f"  {skill}")
        console.print("[cyan]--check: nothing written[/cyan]")
        return

    try:
        apply_render(render_plan, force=force)
    except (RenderError, PayloadError) as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(code=1) from e

    console.print(
        f"[green]rendered {render_plan.manifest_path} and {render_plan.sums_path}[/green]"
    )


def _pack_summary(pack: Pack, *, sealed: bool | None, flatten: bool | None) -> str:
    """One-line pack header: identity, seal state, skill count, manifest presence.

    A flattened pack (contract section 3b) reports the LEAF count - what it actually
    projects - and keeps the declared count visible so the two-level layout on disk
    stays legible. An unflattened pack renders exactly as it always has.
    """
    flat = resolve_inventory(pack, flatten=flatten)
    label = f"{pack.manifest.name}@{pack.manifest.version}"
    count = f"{len(flat.skills)} skills"
    if flat.enabled:
        count += f" (flattened from {len(pack.inventory)} declared)"
    return (
        f"[bold]{label}[/bold] "
        f"({'sealed' if is_sealed(pack, sealed) else 'unsealed'}, "
        f"{count}, "
        f"{'pack.toml' if pack.has_manifest else 'no pack.toml (globbed)'})"
    )


@pack_app.command("verify")
def verify_cmd(
    root: Path = typer.Argument(
        ..., help="Pack root directory, e.g. packs/NAME or packs/NAME/VERSION"
    ),
    sealed: bool = typer.Option(
        False,
        "--sealed",
        help="Force checksum verification even if pack.toml omits [policy] sealed",
    ),
    flatten: bool = typer.Option(
        False,
        "--flatten",
        help="Force section 3b container expansion even if pack.toml omits [policy] flatten",
    ),
) -> None:
    """Verify a pack against the packs contract. Exits 1 on errors."""
    try:
        pack = load_pack_standalone(root)
    except PackError as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(code=1) from e

    console.print(_pack_summary(pack, sealed=sealed, flatten=flatten))

    issues = lint_pack_contract(pack, sealed=sealed, flatten=flatten)
    if not issues:
        console.print("[green]VERIFIED[/green]")
        return

    _print_issues(issues)
    if has_errors(issues):
        console.print("[red]FAILED[/red]")
        raise typer.Exit(code=1)
    console.print("[green]VERIFIED[/green] (with warnings)")


@pack_app.command("inventory")
def inventory_cmd(
    root: Path = typer.Argument(
        ..., help="Pack root directory, e.g. packs/NAME or packs/NAME/VERSION"
    ),
    flatten: bool = typer.Option(
        False,
        "--flatten",
        help="Force section 3b container expansion even if pack.toml omits [policy] flatten",
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit canonical JSON on stdout"),
) -> None:
    """Print the inventory a pack PROJECTS as (name, relpath) pairs.

    The cross-surface conformance surface for contract section 3b. Every engine that
    implements the contract - this one, pjangler's TypeScript `expandPackInventory`,
    and the `sync-skills.py` fanout - has to agree on this exact list for a given pack
    root, so `--json` is a stable, diffable rendering rather than a pretty table:
    sorted by `relpath`, no ANSI, no host paths, one trailing newline.

    Read-only. Never resolves a registry, never touches a manifest, never mutates.
    """
    try:
        pack = load_pack_standalone(root)
    except PackError as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(code=1) from e

    flat = resolve_inventory(pack, flatten=flatten)
    # Sorted by relpath: the one ordering every engine can reproduce without
    # agreeing on walk order, which is what makes the JSON byte-comparable.
    pairs = sorted(((s.name, s.relpath) for s in flat.skills), key=lambda p: p[1])

    if as_json:
        payload = {
            "pack": pack.manifest.name,
            "version": pack.manifest.version,
            "flattened": flat.enabled,
            "declared": len(pack.inventory),
            "skills": [{"name": name, "relpath": relpath} for name, relpath in pairs],
        }
        # `print`, not `console.print`: rich would wrap, highlight and re-flow the
        # payload, and this output exists precisely to be compared byte-for-byte.
        print(json.dumps(payload, indent=2, sort_keys=True))
        return

    console.print(_pack_summary(pack, sealed=None, flatten=flatten))
    for name, relpath in pairs:
        console.print(f"  {name}" if name == relpath else f"  {name}  [dim]<- {relpath}[/dim]")
    for container in flat.empty_containers:
        console.print(f"  [yellow]{escape(container)}: container contributes no skills[/yellow]")
    for link in flat.skipped_symlinks:
        console.print(f"  [yellow]{escape(link)}: symlink, skipped[/yellow]")


@pack_app.command("manifest")
def manifest_cmd(
    manifest_path: Path = typer.Argument(..., help="Path to a skills.json manifest"),
    registry_root: Path | None = typer.Option(
        None,
        "--registry-root",
        help="Registry checkout root; used ALONE when given. Otherwise the "
        "contract ladder is walked: PJ_SKILLS_REGISTRY_ROOT, "
        "~/.agents/.cache/registries/<url>, then ~/code/skillex",
    ),
    verify: bool = typer.Option(False, "--verify", help="Verify each resolved pack"),
) -> None:
    """Read a skills.json manifest's packs[] and resolve each pack root.

    Read-only: never clones or fetches a registry.
    """
    try:
        manifest = load_skills_manifest(manifest_path)
    except ManifestError as e:
        console.print(f"[red]{escape(str(e))}[/red]")
        raise typer.Exit(code=1) from e

    if not manifest.packs:
        console.print(f"[yellow]{manifest_path} declares no packs[/yellow]")
        return

    if registry_root is not None:
        # An explicit root is an operator decision, not a suggestion: use it alone.
        candidates = [registry_root]
    else:
        try:
            candidates = registry_root_candidates(manifest.registry)
        except ValueError as e:
            console.print(f"[red]{escape(str(e))}[/red]")
            raise typer.Exit(code=1) from e
    candidates = [candidate for candidate in candidates if candidate.is_dir()]
    if not candidates:
        console.print("[red]no registry checkout found; pass --registry-root[/red]")
        raise typer.Exit(code=1)

    table = Table(title=f"packs[] in {manifest_path}")
    table.add_column("name")
    table.add_column("version")
    table.add_column("root")
    table.add_column("status")

    failed = False
    verified: list[tuple[PackEntry, Path]] = []
    for entry in manifest.packs:
        try:
            pack_root = _resolve_entry_root_across(candidates, entry)
        except PackError as e:
            status = (
                "[yellow]optional, unresolved[/yellow]" if entry.optional else "[red]error[/red]"
            )
            failed = failed or not entry.optional
            table.add_row(entry.name, entry.version or "-", escape(str(e)), status)
            continue
        verified.append((entry, pack_root))
        table.add_row(entry.name, entry.version or "(auto)", str(pack_root), "resolved")

    console.print(table)

    if verify:
        for entry, pack_root in verified:
            console.print(f"\n[bold]{entry.name}[/bold] -> {pack_root}")
            try:
                pack = load_pack_standalone(pack_root)
            except PackError as e:
                console.print(f"  [red]{escape(str(e))}[/red]")
                failed = True
                continue
            # `sealed` and `flatten` both come from the entry: each may only
            # TIGHTEN what the pack's own pack.toml already declares.
            console.print("  " + _pack_summary(pack, sealed=entry.sealed, flatten=entry.flatten))
            issues = lint_pack_contract(pack, sealed=entry.sealed, flatten=entry.flatten)
            if not issues:
                console.print("  [green]VERIFIED[/green]")
                continue
            _print_issues(issues)
            if has_errors(issues):
                # `optional` only excuses a MISSING/unresolvable pack. A pack that
                # resolved and then failed verification is always fatal.
                failed = True
                console.print("  [red]FAILED[/red]")
            else:
                console.print("  [green]VERIFIED[/green] (with warnings)")

    if failed:
        raise typer.Exit(code=1)


def _resolve_entry_root(packs_root: Path, entry: PackEntry) -> Path:
    """Resolve one packs[] entry to a pack root inside the registry checkout.

    `source` overrides are the sync tool's job (they may clone); this command is
    strictly read-only and only resolves registry-relative roots.
    """
    if entry.source is not None:
        raise PackError(f"pack {entry.name!r} uses a 'source' override; not resolvable offline")
    if entry.registry_path is not None:
        candidate = packs_root.parent / entry.registry_path
        _assert_registry_path_contained(packs_root, entry)
        if candidate.is_symlink() or not candidate.is_dir():
            raise PackError(f"pack root must be a real directory: {candidate}")
        return candidate
    return resolve_pack_dir(packs_root, entry.name, entry.version)


def _assert_registry_path_contained(packs_root: Path, entry: PackEntry) -> None:
    """`registry_path` may not escape the registry root. Pure path math."""
    assert entry.registry_path is not None
    resolved = (packs_root.parent / entry.registry_path).resolve()
    if not resolved.is_relative_to(packs_root.parent.resolve()):
        raise PackError(f"registry_path {entry.registry_path!r} escapes the registry root")


def _entry_candidate_path(packs_root: Path, entry: PackEntry) -> Path:
    """The deepest path a checkout must carry for `entry` to resolve there at all.

    Deliberately deeper than `packs/<name>` when a version is pinned: a checkout
    that has `packs/bmad/` but not `packs/bmad/6.10.2/` does not carry the pinned
    pack, and the ladder has to be able to walk past it.
    """
    if entry.registry_path is not None:
        return packs_root.parent / entry.registry_path
    base = packs_root / entry.name
    return base if entry.version is None else base / entry.version


def _exists_nofollow(path: Path) -> bool:
    """Presence WITHOUT following symlinks.

    A dangling symlink counts as PRESENT: that is a hostile path for
    :func:`assert_real_dir` to reject, never one the ladder may quietly skip.
    """
    try:
        path.lstat()
    except OSError:
        return False
    return True


def _pack_root_attests(pack_root: Path, entry: PackEntry) -> bool:
    """Does `pack_root` carry a `pack.toml` that positively identifies `entry`?

    Contract section 3 makes `pack.toml` the AUTHORITATIVE identity and inventory
    of a pack; a bare `packs/<name>/<version>/` directory is an unattested claim
    resting on nothing but a directory name anyone can create.
    """
    # Raises PackError (does NOT return False) when pack.toml exists but does not
    # parse - that is a hard error everywhere else and must not be downgraded
    # into "merely not attested".
    pack = load_pack_standalone(pack_root)
    if pack.manifest_path is None or pack.manifest.name != entry.name:
        return False
    return entry.version is None or pack.manifest.version == entry.version


def _resolve_entry_root_in(packs_root: Path, entry: PackEntry) -> tuple[Path, bool] | None:
    """Resolve `entry` inside ONE registry checkout.

    Returns ``(pack_root, attested)``, or ``None`` when this checkout simply does
    not carry the pack. Present-but-unsafe still RAISES: an ordered candidate list
    exists to walk past absence, never to mask a symlinked or escaping pack path
    by quietly trying the next checkout.
    """
    if entry.source is not None:
        raise PackError(f"pack {entry.name!r} uses a 'source' override; not resolvable offline")
    if entry.registry_path is not None:
        # Escape validation is pure path math and must happen BEFORE the ladder is
        # allowed to write this entry off as "just absent here".
        _assert_registry_path_contained(packs_root, entry)
    if not _exists_nofollow(_entry_candidate_path(packs_root, entry)):
        return None
    pack_root = _resolve_entry_root(packs_root, entry)
    return pack_root, _pack_root_attests(pack_root, entry)


def _resolve_entry_root_across(registry_roots: list[Path], entry: PackEntry) -> Path:
    """Walk the registry checkout ladder (contract section 2 step 3) for `entry`.

    Contract order picks the winner, with one promotion: an ATTESTED root - one
    whose `pack.toml` identifies this exact pack - outranks an unattested one.
    Several checkouts routinely carry the same `packs/<name>/<version>/` path
    while only one holds the RENDERED pack, because the sync cache is a clone of
    what has been *pushed* and therefore lags a pack that is still being cut.
    Without this promotion a `[policy] sealed = true` pack is silently downgraded
    to "unsealed, structural checks only" by whichever checkout happens to sort
    first, and every identity built on the pack root (redundancy pruning,
    projection targets) points at the wrong copy.

    The promotion can only TIGHTEN. Contract order still breaks every tie between
    two attested roots, so a sealed pack in a higher-priority checkout always wins
    and a lower-priority checkout can never demote it - unattested is strictly the
    lower rank. A manifest-level ``sealed: true`` is likewise untouched: it is
    enforced against whichever root wins, and a root that cannot satisfy it fails.
    """
    matches: list[tuple[Path, bool]] = []
    for registry_root in registry_roots:
        match = _resolve_entry_root_in(registry_root / "packs", entry)
        if match is not None:
            matches.append(match)

    if not matches:
        pinned = f"{entry.name}@{entry.version}" if entry.version else entry.name
        roots = ", ".join(str(root) for root in registry_roots)
        raise PackError(f"pack {pinned!r} is not present in any registry checkout: {roots}")

    for pack_root, attested in matches:
        if attested:
            return pack_root
    return matches[0][0]


def register(app: typer.Typer) -> None:
    app.add_typer(pack_app, name="pack")
