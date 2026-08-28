"""Compile a manifest into the desired projection. Pure: reads, never writes.

The precedence law is **one rule**, not four: positional overwrite over a single
ordered sequence of passes.

    pack (short-circuits everything)
      else:  inherited global  ->  sets in array order  ->  skills in array order

Each pass writes into the same ``OrderedDict`` unconditionally, so "a later set
wins" and "an individual skill wins" fall out of the ordering rather than being
special cases. That is why ``skills[]`` is processed last regardless of where the
key sits in the JSON: the winner is determined by *pass*, never by file layout.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from skillex.core.compositions import (
    SKILL_FILENAME,
    Member,
    lexical_link_target,
    walk_composition,
)
from skillex.core.diagnostics import Code, Finding, RefusalError, Reporter
from skillex.core.loader import (
    PackError,
    flatten_inventory,
    load_pack_standalone,
    pack_flatten_enabled,
    resolve_pack_dir,
)
from skillex.core.models import (
    PackEntry,
    SkillEntry,
    SkillsManifest,
    is_safe_relpath,
)
from skillex.core.scope import Scope, ScopeKind, is_within
from skillex.paths import RegistryHit, find_in_roots

Stage = Literal["inherited", "set", "skill", "pack"]


@dataclass(frozen=True)
class Binding:
    """One projected name and the canonical directory it points at."""

    name: str
    target: Path
    stage: Stage
    #: Human-readable provenance, e.g. ``sets[0] "min-global"``.
    origin: str
    link_path: Path | None = None
    chain: tuple[Path, ...] = ()
    outside_catalog: bool = False


@dataclass(frozen=True)
class Shadow:
    """One overwrite, recorded at compile time so ``--explain`` can replay it."""

    name: str
    loser: Binding
    winner: Binding

    @property
    def divergent(self) -> bool:
        """True when the two bindings actually disagree about the target.

        The distinction is not pedantry. ``sets/global`` and ``sets/min-global``
        share **35** names with **zero** differing targets, so treating every
        collision as a conflict would print 35 warnings for a healthy manifest and
        train the eye to skip them. ``sets/global`` and ``sets/delodocs`` share 8
        names of which **5 genuinely diverge** -- those are the ones worth shouting
        about.
        """
        return self.loser.target != self.winner.target


@dataclass
class Desired:
    """The projection a manifest asks for, before the disk is consulted."""

    mode: Literal["composed", "alias"]
    bindings: OrderedDict[str, Binding]
    alias_target: Path | None = None
    shadows: list[Shadow] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.shadows is None:
            self.shadows = []


def _missing(code: Code, tried: list[Path], what: str, name: str | None = None) -> RefusalError:
    """ "I looked here, here and here, and it was in none of them."

    The code distinguishes the three cases a reader must act on differently:
    ``E_NO_REGISTRY`` means there is no checkout at all (fix your environment),
    while ``E_SET_MISSING`` / ``E_SKILL_MISSING`` mean the checkouts are fine and
    the *name* is wrong (fix your manifest). Collapsing them onto one code sends
    you looking in the wrong place, which is the whole cost of a bad error.
    """
    return RefusalError(
        Finding(
            code=code,
            message=f"no registry checkout contains {what}",
            name=name,
            detail=tuple(
                f"{p}  {'exists, but has no ' + what if p.is_dir() else 'does not exist'}"
                for p in tried
            )
            or ("the registry ladder is empty",),
            fix="check the name, pass --registry-root, or set PJ_SKILLS_REGISTRY_ROOT.",
        )
    )


def _report_skipped(reporter: Reporter, hit: RegistryHit, what: str) -> None:
    """Warn when resolution walked past a checkout that exists.

    Silence here is how a stale clone stays invisible for months: the ladder finds
    the path one rung further down, everything works, and nobody learns that the
    cache the operator believes is authoritative has been wrong since a rename.
    """
    if not hit.skipped:
        return
    reporter.emit(
        Code.W_STALE_REGISTRY_CANDIDATE,
        f"{what} resolved from {hit.root}, past {len(hit.skipped)} earlier checkout(s)",
        path=hit.root,
        detail=tuple(f"skipped {p} (exists, but has no {what})" for p in hit.skipped),
        fix="refresh or remove the stale checkout, or pin one with PJ_SKILLS_REGISTRY_ROOT.",
    )


def _record(
    bindings: OrderedDict[str, Binding],
    shadows: list[Shadow],
    reporter: Reporter,
    binding: Binding,
) -> None:
    """Unconditional overwrite, recording what it displaced.

    This single function implements both "latest set wins" and "the individual
    entry wins" -- the callers differ only in the order they run.
    """
    prior = bindings.get(binding.name)
    if prior is not None:
        shadow = Shadow(name=binding.name, loser=prior, winner=binding)
        shadows.append(shadow)
        if binding.stage == "skill":
            reporter.emit(
                Code.I_SKILL_OVERRIDES_SET,
                f"{binding.name}: skills[] entry overrides {prior.origin}",
                name=binding.name,
            )
        elif shadow.divergent:
            reporter.emit(
                Code.W_SET_CONFLICT_RETARGET,
                f"{binding.name}: {binding.origin} retargets it away from {prior.origin}",
                name=binding.name,
                detail=(f"was  {prior.target}", f"now  {binding.target}"),
                fix="exclude it from one of the sets, or pin it with a skills[] entry.",
            )
        else:
            reporter.emit(
                Code.I_SET_REBIND,
                f"{binding.name}: also in {binding.origin}, same target",
                name=binding.name,
            )
    bindings[binding.name] = binding


def _member_to_binding(member: Member, stage: Stage, origin: str) -> Binding:
    return Binding(
        name=member.name,
        target=member.target,
        stage=stage,
        origin=origin,
        link_path=member.link_path,
        chain=member.chain,
        outside_catalog=member.outside_catalog,
    )


def resolve_skill_entry(
    entry: SkillEntry,
    index: int,
    roots: list[Path],
    reporter: Reporter | None = None,
) -> Binding:
    """Resolve one ``skills[]`` entry.

    Unlike a set member, an unresolvable entry is an **error**, not a dropped
    warning: it is an explicit, hand-written declaration, so failing to honor it
    silently would be a lie.
    """
    origin = f'skills[{index}] "{entry.name}"'
    if entry.source is not None:
        if not entry.source.startswith("file://"):
            raise RefusalError(
                Finding(
                    code=Code.E_REMOTE_SOURCE,
                    message=f"{origin}: remote sources are not supported",
                    name=entry.name,
                    detail=(entry.source,),
                    fix="clone it yourself and use a file:// source, or add it to the registry.",
                )
            )
        target = Path(entry.source[len("file://") :])
    else:
        rel = entry.relpath
        if not is_safe_relpath(rel):
            raise RefusalError(
                Finding(
                    code=Code.E_UNSAFE_PATH,
                    message=f"{origin}: {rel!r} is not a safe relative path",
                    name=entry.name,
                    fix="use a relative path with no '.', '..' or leading '/'.",
                )
            )
        if rel.split("/")[0] == "packs":
            # Two live manifests on this machine declare "packs/product-manager"
            # through skills[]. A generic no-SKILL.md error would technically catch
            # it, with a message that sends you looking in the wrong place.
            raise RefusalError(
                Finding(
                    code=Code.E_PACK_VIA_SKILLS,
                    message=f"{origin} declares a pack through the skills array",
                    name=entry.name,
                    detail=(rel,),
                    fix='move it to packs[]: {"packs": ["' + rel.split("/")[1] + '"]}',
                )
            )
        hit = find_in_roots(roots, rel)
        if hit is None:
            raise _missing(Code.E_SKILL_MISSING, roots, rel, entry.name)
        if reporter is not None:
            _report_skipped(reporter, hit, rel)
        target = hit.path

    if not (target / SKILL_FILENAME).is_file():
        raise RefusalError(
            Finding(
                code=Code.E_TARGET_NOT_A_SKILL,
                message=f"{origin}: no {SKILL_FILENAME} at {target}",
                name=entry.name,
                path=target,
                fix="point it at a skill directory.",
            )
        )
    return Binding(
        name=entry.name,
        target=target,
        stage="skill",
        origin=origin,
        chain=(target,),
        outside_catalog="all-skills" not in target.parts,
    )


def expand_pack(
    pack_dir: Path,
    entry: PackEntry,
    roots: list[Path],
    reporter: Reporter,
) -> OrderedDict[str, Binding]:
    """Members of a declared pack, as bindings.

    Every branch here matches a pack shape that exists on disk:

    * ``packs/Kurzgesagt``  -- no ``pack.toml``, 12 symlink children. The globbed
      inventory returns ``[]`` for it (symlinks are invisible to that walker), so
      the composition reader handles it.
    * ``packs/hermes-base`` -- version-only layout, ``[policy] flatten = true``,
      18 declared entries expanding to 73 leaves across three depths.
    * ``packs/folder-curator`` and friends -- ``pack.toml`` and README only; every
      member resolves from ``all-skills/``.
    * ``packs/torrent-movie`` -- a ``pack.toml`` with no ``version`` key at all.
    """
    origin = f'packs[0] "{entry.name}"'
    try:
        pack = load_pack_standalone(pack_dir)
    except PackError as e:
        raise RefusalError(
            Finding(
                code=Code.E_PACK_MISSING,
                message=f"{origin}: {e}",
                path=pack_dir,
                fix="check the pack name and version.",
            )
        ) from e

    declared = list(pack.inventory)
    out: OrderedDict[str, Binding] = OrderedDict()

    if not declared:
        members = walk_composition(pack_dir, reporter, label=f"pack {entry.name}")
        keep = set(entry.filter_inventory([m.name for m in members]))
        for member in members:
            if member.name in keep:
                out[member.name] = _member_to_binding(member, "pack", origin)
        return out

    selected = entry.filter_inventory(declared)
    flatten = pack_flatten_enabled(pack, entry.flatten)
    remaining = selected

    if flatten:
        inventory = flatten_inventory(pack_dir, selected)
        for container in inventory.empty_containers:
            reporter.emit(
                Code.W_PACK_EMPTY_CONTAINER,
                f"{origin}: declared entry {container!r} expands to no skills",
                name=container,
                fix="remove it from the pack inventory, or add a SKILL.md beneath it.",
            )
        seen: dict[str, Path] = {}
        for flat in inventory.skills:
            path = pack_dir / flat.relpath
            if flat.name in seen:
                raise RefusalError(
                    Finding(
                        code=Code.E_PACK_DUPLICATE_MEMBER,
                        message=f"{origin}: two members would project as {flat.name!r}",
                        name=flat.name,
                        detail=(str(seen[flat.name]), str(path)),
                        fix="rename one of the leaf directories.",
                    )
                )
            seen[flat.name] = path
            out[flat.name] = Binding(
                name=flat.name,
                target=path,
                stage="pack",
                origin=origin,
                chain=(path,),
            )
        expanded = {flat.declared for flat in inventory.skills}
        # A declared container that expanded to nothing has ALREADY been reported,
        # as a WARNING. Leaving it in `remaining` sends it through the unflattened
        # member resolution below, where a directory holding no SKILL.md is a hard
        # E_PACK_MEMBER_MISSING refusal -- so one empty container in an 18-entry pack
        # like hermes-base makes the whole pack unsyncable while the reporter
        # insists it is only a warning. The warning is the contract; honor it.
        reported_empty = set(inventory.empty_containers)
        remaining = [n for n in selected if n not in expanded and n not in reported_empty]

    for name in remaining:
        path = pack_dir / name
        if path.is_symlink():
            target = lexical_link_target(pack_dir, name)
        elif (path / SKILL_FILENAME).is_file():
            target = path
        elif not path.exists():
            # A manifest-only pack: pack.toml names members that live in the
            # catalog rather than in the pack directory.
            hit = find_in_roots(roots, f"all-skills/{name}")
            if hit is None:
                raise RefusalError(
                    Finding(
                        code=Code.E_PACK_MEMBER_MISSING,
                        message=f"{origin}: member {name!r} is neither in the pack "
                        "nor in all-skills/",
                        name=name,
                        fix="add the skill to all-skills/, or remove it from pack.toml.",
                    )
                )
            target = hit.path
        else:
            raise RefusalError(
                Finding(
                    code=Code.E_PACK_MEMBER_MISSING,
                    message=f"{origin}: member {name!r} at {path} is not a skill",
                    name=name,
                    path=path,
                    fix=f"add a {SKILL_FILENAME}, or remove it from pack.toml.",
                )
            )
        if not (target / SKILL_FILENAME).is_file():
            raise RefusalError(
                Finding(
                    code=Code.E_PACK_MEMBER_MISSING,
                    message=f"{origin}: member {name!r} resolves to {target}, "
                    f"which has no {SKILL_FILENAME}",
                    name=name,
                    path=target,
                    fix="repair the pack member.",
                )
            )
        out[name] = Binding(
            name=name,
            target=target,
            stage="pack",
            origin=origin,
            chain=(target,),
            outside_catalog="all-skills" not in target.parts,
        )
    return out


def alias_mode_eligible(
    scope: Scope,
    pack_dir: Path,
    entry: PackEntry,
    flatten: bool,
    bindings: OrderedDict[str, Binding],
    reporter: Reporter,
) -> bool:
    """Whether the root itself may become a symlink to the pack.

    Whole-root alias mode is in the architecture (diagram box 4) and the schema
    mandates it, so it stays -- but it is gated, because a symlinked root physically
    cannot honor half of what a manifest can ask for.
    """
    reason: str | None = None
    if scope.kind is not ScopeKind.GLOBAL:
        # pjangler refuses CLI projections unless <repo>/.agents/skills is a real
        # directory, and reports "canonical alias target .agents/skills is missing
        # or unsafe" for a symlinked one. A symlinked project root breaks `pj audit`
        # and every mise enter hook in every adopting repo.
        reason = "project scope requires a real directory (pjangler audits it)"
    elif flatten:
        # Aliasing packs/hermes-base/0.18.2 exposes its 18 top-level entries, 14 of
        # them containers with no SKILL.md that no CLI can read -- instead of the 73
        # leaves that pack.toml, the golden fixture, and the live cross-engine gate
        # all pin.
        reason = "a root symlink cannot flatten a nested pack"
    elif entry.include or entry.exclude:
        reason = "a root symlink cannot apply include/exclude"
    elif any(b.target.parent != pack_dir for b in bindings.values()):
        reason = "some members resolve from outside the pack directory"
    if reason is not None:
        reporter.emit(
            Code.W_ALIAS_MODE_DECLINED,
            f"projecting {entry.name} as a real directory: {reason}",
            name=entry.name,
            path=pack_dir,
        )
        return False
    return True


def compose(
    manifest: SkillsManifest,
    scope: Scope,
    roots: list[Path],
    reporter: Reporter,
    *,
    inherited: OrderedDict[str, Binding] | None = None,
    inherit: bool = True,
) -> Desired:
    """Compile one manifest into a desired projection. Never touches the output root."""
    bindings: OrderedDict[str, Binding] = OrderedDict()
    shadows: list[Shadow] = []

    for key in manifest.unknown_keys:
        reporter.emit(
            Code.W_MANIFEST_UNKNOWN_KEY,
            f"unknown manifest key {key!r} is ignored",
            path=manifest.path,
            fix="remove it, or check the spelling against skills.schema.json.",
        )
    if manifest.scope is not None and manifest.scope != scope.kind.value:
        reporter.emit(
            Code.W_SCOPE_MISMATCH,
            f'manifest declares scope "{manifest.scope}" but was found at {scope.kind.value} scope',
            path=manifest.path,
            fix="placement wins; fix or drop the 'scope' key.",
        )

    if not roots:
        raise _missing(Code.E_NO_REGISTRY, [], "the registry")

    # --- STEP A: a pack short-circuits everything. -------------------------
    # AC: "If a pack is defined, it will trump all above and replace the skills/ path."
    # Evaluated first so no work is done that is about to be discarded.
    if manifest.packs:
        if len(manifest.packs) > 1:
            raise RefusalError(
                Finding(
                    code=Code.E_MULTIPLE_PACKS,
                    message="only one pack may be declared; found "
                    + ", ".join(repr(p.name) for p in manifest.packs),
                    detail=("A pack replaces the entire activation root.",),
                    fix="keep one entry in packs[].",
                )
            )
        entry = manifest.packs[0]
        if manifest.sets or manifest.skills:
            # The schema calls packs+sets illegal; the AC says the pack WINS.
            # Warning and letting the pack win honors the AC without rejecting a
            # manifest the author deliberately wrote. --strict escalates.
            discarded = [f"sets[]: {s.name}" for s in manifest.sets]
            discarded += [f"skills[]: {s.name}" for s in manifest.skills]
            reporter.emit(
                Code.W_PACK_TRUMPS,
                f"pack {entry.name!r} replaces the root; "
                f"{len(discarded)} other entries are discarded",
                detail=tuple(discarded[:12]) + (("...",) if len(discarded) > 12 else ()),
                fix="remove sets[]/skills[], or remove packs[].",
            )
        hit = find_in_roots(roots, entry.registry_path or f"packs/{entry.name}")
        if hit is not None:
            _report_skipped(reporter, hit, f"packs/{entry.name}")
        if hit is None:
            if not entry.optional:
                raise _missing(Code.E_PACK_MISSING, roots, f"packs/{entry.name}", entry.name)
            reporter.emit(
                Code.W_PACK_MISSING,
                f"optional pack {entry.name!r} not found; continuing without it",
                name=entry.name,
                fix="add it to the registry, or remove the entry.",
            )
        else:
            registry_root = hit.root
            try:
                pack_dir = resolve_pack_dir(registry_root / "packs", entry.name, entry.version)
            except PackError as e:
                raise RefusalError(
                    Finding(
                        code=Code.E_PACK_MISSING,
                        message=str(e),
                        name=entry.name,
                        fix="check the pack name and version.",
                    )
                ) from e
            pack = load_pack_standalone(pack_dir)
            flatten = pack_flatten_enabled(pack, entry.flatten)
            members = expand_pack(pack_dir, entry, roots, reporter)
            if alias_mode_eligible(scope, pack_dir, entry, flatten, members, reporter):
                return Desired(mode="alias", bindings=OrderedDict(), alias_target=pack_dir)
            return _finalize(Desired("composed", members, None, []), scope, reporter)

    # --- STEP B: inherited global (project scope only). --------------------
    # ADR-0001 rule 10: inheritance is a union, not a copy. Targets stay CANONICAL;
    # chaining a project link through ~/.agents/skills would break every project the
    # next time the global root is regenerated.
    if scope.kind is ScopeKind.PROJECT:
        if inherit and inherited:
            for name, binding in inherited.items():
                bindings[name] = replace(binding, stage="inherited", origin="inherited from global")
            reporter.emit(
                Code.W_INHERIT_DUPLICATES_GLOBAL,
                f"{len(bindings)} skills inherited from global are also projected here",
                detail=("A CLI reading both roots will list each of them twice.",),
                fix='set "inherit_global": false, or pass --no-inherit.',
            )
    elif manifest.inherit_global is not None:
        reporter.emit(
            Code.W_INHERIT_ON_GLOBAL,
            "'inherit_global' has no meaning on a global manifest and is ignored",
            path=manifest.path,
            fix="remove the key.",
        )

    # --- STEP C: sets, in manifest array order. Unconditional overwrite. ----
    # AC: "It will also sync the contents of each set to the skills/ path"
    # AC: "If a set skill conflicts with another set's skill, latest one wins"
    for index, set_entry in enumerate(manifest.sets):
        origin = f'sets[{index}] "{set_entry.name}"'
        set_dir: Path | None
        if set_entry.source is not None:
            if not set_entry.source.startswith("file://"):
                raise RefusalError(
                    Finding(
                        code=Code.E_REMOTE_SOURCE,
                        message=f"{origin}: remote sources are not supported",
                        name=set_entry.name,
                        detail=(set_entry.source,),
                        fix="clone it yourself and use a file:// source.",
                    )
                )
            local = Path(set_entry.source[len("file://") :])
            set_dir = local if (local.is_dir() or local.is_symlink()) else None
        else:
            hit = find_in_roots(roots, set_entry.registry_path or f"sets/{set_entry.name}")
            if hit is not None:
                _report_skipped(reporter, hit, f"sets/{set_entry.name}")
            set_dir = hit.path if hit else None

        if set_dir is None:
            if set_entry.optional:
                reporter.emit(
                    Code.W_SET_OPTIONAL_MISSING,
                    f"optional set {set_entry.name!r} not found; skipping",
                    name=set_entry.name,
                    fix="add it to the registry, or remove the entry.",
                )
                continue
            raise _missing(Code.E_SET_MISSING, roots, f"sets/{set_entry.name}", set_entry.name)

        found = walk_composition(set_dir, reporter, label=f"set {set_entry.name!r}")
        keep = set(set_entry.filter_inventory([m.name for m in found]))
        for member in found:
            if member.name in keep:
                _record(bindings, shadows, reporter, _member_to_binding(member, "set", origin))

    # --- STEP D: individual skills, LAST. ----------------------------------
    # AC: "sync all manifest `skills` to the skills/ path"
    # AC: "If a set skill conflicts with an explicit individual skill, the
    #      individual one wins"
    # This loop runs after every set, so an individual entry wins regardless of
    # where `skills` sits relative to `sets` in the JSON.
    for index, skill_entry in enumerate(manifest.skills):
        _record(
            bindings,
            shadows,
            reporter,
            resolve_skill_entry(skill_entry, index, roots, reporter),
        )

    return _finalize(Desired("composed", bindings, None, shadows), scope, reporter)


def _finalize(desired: Desired, scope: Scope, reporter: Reporter) -> Desired:
    """Reject targets that are structurally unsafe, whatever the manifest says."""
    cache = Path.home() / ".agents" / ".cache"
    for name, binding in desired.bindings.items():
        if is_within(binding.target, cache):
            raise RefusalError(
                Finding(
                    code=Code.E_UNSAFE_TARGET,
                    message=f"{name} targets the registry cache",
                    name=name,
                    path=binding.target,
                    detail=("sync-skills.py clones arbitrary remotes there.",),
                    fix="point it at a vetted checkout instead.",
                )
            )
        parts = binding.target.parts
        if ".agents" in parts and "skills" in parts:
            index = parts.index(".agents")
            if index + 1 < len(parts) and parts[index + 1] == "skills":
                raise RefusalError(
                    Finding(
                        code=Code.E_TARGET_IS_PROJECTION,
                        message=f"{name} targets another project's activation root",
                        name=name,
                        path=binding.target,
                        detail=("Regenerating that projection would silently break this one.",),
                        fix="repoint it at the canonical skill, or exclude it.",
                    )
                )
        if is_within(scope.root, binding.target):
            raise RefusalError(
                Finding(
                    code=Code.E_RECURSIVE_PROJECTION,
                    message=f"{name} targets a directory containing this activation root",
                    name=name,
                    path=binding.target,
                    fix="repoint it outside the activation root.",
                )
            )
    return desired


__all__ = [
    "Binding",
    "Desired",
    "Shadow",
    "Stage",
    "alias_mode_eligible",
    "compose",
    "expand_pack",
    "resolve_skill_entry",
]
