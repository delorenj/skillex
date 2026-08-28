"""Loaders for skillex.toml, pack.toml, and SKILL.md frontmatter.

Loaders are pure: they parse files into typed models and raise specific
exceptions. They do not validate semantic rules (slot type membership,
required-slot presence). Semantic rules live in the linter.
"""

from __future__ import annotations

import json
import os
import tomllib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import frontmatter
from pydantic import ValidationError

from skillex.core.models import (
    NAME_PATTERN,
    CliAdapterConfig,
    Pack,
    PackEntry,
    PackManifest,
    PackPolicy,
    PackSource,
    ScopeConfig,
    SetEntry,
    Skill,
    SkillEntry,
    SkillexConfig,
    SkillFrontmatter,
    SkillsManifest,
    SlotAssignment,
    UnsupportedFieldError,
    is_safe_component,
)
from skillex.core.payload import (
    EXCLUDED_PREFIXES,
    MANIFEST_FILENAME,
    SKILL_FILENAME,
    PayloadError,
    assert_real_dir,
    discover_skill_dirs,
    is_regular_file,
)
from skillex.logging import get_logger

log = get_logger(__name__)

PACKS_DIRNAME = "packs"


class LoaderError(Exception):
    """Base class for loader errors."""


class ConfigError(LoaderError):
    """Raised when skillex.toml is missing or malformed."""


class PackError(LoaderError):
    """Raised when a pack.toml is missing or malformed."""


class ManifestError(LoaderError):
    """Raised when a skills.json manifest is missing or malformed."""


class SkillError(LoaderError):
    """Raised when a skill directory is malformed."""


class DuplicateSkillError(LoaderError):
    """Raised when two skills share the same name in the skills root."""

    def __init__(self, name: str, paths: list[Path]) -> None:
        path_list = ", ".join(str(p) for p in paths)
        super().__init__(f"duplicate skill name {name!r} found at: {path_list}")
        self.name = name
        self.paths = paths


class SkillReferenceError(LoaderError):
    """Raised when a pack references a skill that does not exist."""


def load_config(path: Path) -> SkillexConfig:
    """Load and validate a skillex.toml file."""
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"failed to parse {path}: {e}") from e

    skillex_section = raw.get("skillex", {})
    scopes_section = raw.get("scopes", {})
    cli_section = raw.get("cli", {})

    skills_root = skillex_section.get("skills_root")
    packs_root = skillex_section.get("packs_root")
    if skills_root is None or packs_root is None:
        raise ConfigError(
            f"{path} missing required fields [skillex].skills_root and/or [skillex].packs_root"
        )

    scopes: dict[str, ScopeConfig] = {
        scope_name: ScopeConfig(active_pack=cfg.get("active_pack"))
        for scope_name, cfg in scopes_section.items()
    }

    cli_adapters: dict[str, CliAdapterConfig] = {}
    for cli_name, cli_cfg in cli_section.items():
        try:
            cli_adapters[cli_name] = CliAdapterConfig(
                name=cli_name,
                enabled=bool(cli_cfg.get("enabled", True)),
                global_root=Path(cli_cfg["global_root"]).expanduser(),
                project_root=Path(cli_cfg["project_root"]),
            )
        except (KeyError, ValidationError) as e:
            raise ConfigError(f"invalid [cli.{cli_name}] entry in {path}: {e}") from e

    try:
        return SkillexConfig(
            skills_root=Path(skills_root).expanduser(),
            packs_root=Path(packs_root).expanduser(),
            log_format=skillex_section.get("log_format", "console"),
            scopes=scopes,
            cli_adapters=cli_adapters,
        )
    except ValidationError as e:
        raise ConfigError(f"invalid skillex config in {path}: {e}") from e


def load_skill(skill_dir: Path) -> Skill:
    """Load a single skill directory containing a SKILL.md file.

    The skill name is derived from the directory name unless frontmatter
    overrides it. This keeps directory structure and skill identity linked
    for symlink targeting.
    """
    if not skill_dir.is_dir():
        raise SkillError(f"not a directory: {skill_dir}")

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        raise SkillError(f"no SKILL.md in {skill_dir}")

    try:
        post = frontmatter.load(skill_md)
    except Exception as e:
        raise SkillError(f"failed to parse frontmatter in {skill_md}: {e}") from e

    try:
        fm = SkillFrontmatter.model_validate(dict(post.metadata))
    except ValidationError as e:
        raise SkillError(f"invalid frontmatter in {skill_md}: {e}") from e

    name = fm.name or skill_dir.name
    try:
        return Skill(
            name=name,
            path=skill_dir.resolve(),
            skill_md_path=skill_md.resolve(),
            frontmatter=fm,
        )
    except ValidationError as e:
        raise SkillError(f"invalid skill at {skill_dir}: {e}") from e


def discover_skills(skills_root: Path) -> dict[str, Skill]:
    """Discover all skills under skills_root.

    Skips hidden directories and anything without a SKILL.md. Raises on
    duplicate names to prevent ambiguous references.
    """
    if not skills_root.is_dir():
        raise SkillError(f"skills root does not exist or is not a directory: {skills_root}")

    index: dict[str, list[Skill]] = {}
    for child in sorted(skills_root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if not (child / "SKILL.md").is_file():
            continue
        try:
            skill = load_skill(child)
        except SkillError as e:
            log.warning("skipping malformed skill", path=str(child), error=str(e))
            continue
        index.setdefault(skill.name, []).append(skill)

    for name, skills in index.items():
        if len(skills) > 1:
            raise DuplicateSkillError(name, [s.path for s in skills])

    return {name: skills[0] for name, skills in index.items()}


def load_pack_manifest(pack_toml_path: Path) -> PackManifest:
    """Parse a pack.toml into a PackManifest.

    Does not resolve skill references against the index; see load_pack.
    """
    if not pack_toml_path.is_file():
        raise PackError(f"pack manifest not found: {pack_toml_path}")

    try:
        raw = tomllib.loads(pack_toml_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise PackError(f"failed to parse {pack_toml_path}: {e}") from e

    pack_section = raw.get("pack", {})
    slots_section = raw.get("slots", {})
    freeform_section = raw.get("freeform", {})
    source_section = raw.get("source", {})
    policy_section = raw.get("policy", {})

    if "name" not in pack_section:
        raise PackError(f"{pack_toml_path} missing [pack].name")

    slots: dict[str, SlotAssignment] = {}
    for slot_name, slot_cfg in slots_section.items():
        slot_type = _derive_slot_type(slot_name, slot_cfg)
        slots[slot_name] = SlotAssignment(
            slot_name=slot_name,
            slot_type=slot_type,
            required=bool(slot_cfg.get("required", False)),
            skill=slot_cfg.get("skill"),
        )

    freeform_skills = [str(s) for s in freeform_section.get("skills", [])]

    try:
        source = PackSource.model_validate(source_section)
        policy = PackPolicy.model_validate(policy_section)
        return PackManifest(
            name=pack_section["name"],
            version=pack_section.get("version", "0.0.0"),
            description=pack_section.get("description", ""),
            slots=slots,
            freeform_skills=freeform_skills,
            source=source,
            policy=policy,
        )
    except ValidationError as e:
        raise PackError(f"invalid pack manifest at {pack_toml_path}: {e}") from e


def _derive_slot_type(slot_name: str, slot_cfg: dict[str, Any]) -> str:
    """Derive the slot type from slot_name.

    Convention: slot key is the slot type with first letter lowered. Custom
    slots use the full `custom:foo` identifier. If `type` is explicitly set
    in the cfg dict, that wins.
    """
    explicit = slot_cfg.get("type")
    if isinstance(explicit, str):
        return explicit
    if slot_name.startswith("custom:"):
        return slot_name
    return slot_name[:1].upper() + slot_name[1:]


def load_pack(pack_dir: Path, skills_index: dict[str, Skill]) -> Pack:
    """Load a pack and resolve its skill references against the index."""
    manifest = load_pack_manifest(pack_dir / "pack.toml")

    slot_skills: dict[str, Skill] = {}
    for slot_name, assignment in manifest.slots.items():
        if assignment.skill is None:
            continue
        if assignment.skill not in skills_index:
            raise SkillReferenceError(
                f"pack {manifest.name!r} slot {slot_name!r} references unknown skill "
                f"{assignment.skill!r}"
            )
        slot_skills[slot_name] = skills_index[assignment.skill]

    freeform_resolved: list[Skill] = []
    for skill_name in manifest.freeform_skills:
        if skill_name not in skills_index:
            raise SkillReferenceError(
                f"pack {manifest.name!r} freeform references unknown skill {skill_name!r}"
            )
        freeform_resolved.append(skills_index[skill_name])

    return Pack(
        manifest=manifest,
        pack_path=pack_dir.resolve(),
        slot_skills=slot_skills,
        freeform_skills=freeform_resolved,
        manifest_path=(pack_dir / MANIFEST_FILENAME).resolve(),
        dir_name=pack_dir.name,
    )


# ---------------------------------------------------------------------------
# Packs contract: version directories, pack.toml-less packs, skills.json packs[]
# ---------------------------------------------------------------------------


def _segment_key(segment: str) -> tuple[int, int, str]:
    """Order one version segment: numeric segments sort below alphabetic ones."""
    if segment.isdigit():
        return (0, int(segment), "")
    return (1, 0, segment)


def version_sort_key(version: str) -> tuple[object, ...]:
    """Numeric-segment-aware ordering key; a prerelease sorts BELOW its release.

    ``6.10.2 > 6.10.1 > 6.10.1-next.31``. Segments are compared numerically when
    they are all digits, lexically otherwise, so ``6.10.2`` beats ``6.9.9``.
    """
    release, sep, prerelease = version.partition("-")
    release_key = tuple(_segment_key(s) for s in release.split("."))
    if not sep:
        return (release_key, (1,), ())
    prerelease_key = tuple(_segment_key(s) for s in prerelease.replace("-", ".").split("."))
    return (release_key, (0,), prerelease_key)


def list_version_dirs(pack_dir: Path) -> list[str]:
    """Real (non-symlink) child directories of `pack_dir`, sorted lowest version first.

    The candidate list only. Whether those candidates are versions AT ALL is
    :func:`select_pack_version`'s call, never this function's.
    """
    names: list[str] = []
    try:
        entries = sorted(pack_dir.iterdir(), key=lambda p: p.name)
    except OSError as e:
        raise PackError(f"cannot list pack directory {pack_dir}: {e}") from e
    for child in entries:
        if child.is_symlink() or not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        names.append(child.name)
    return sorted(names, key=version_sort_key)


def select_pack_version(pack_dir: Path) -> str | None:
    """Highest version subdirectory of `packs/<name>/`, or None when this is not a
    pure "only subdirectories" version layout (i.e. it is a flat pack).

    "Only subdirectories" is necessary but NOT sufficient. A `pack.toml`-less
    `packs/<name>/` whose children are REAL directories that each hold a regular
    `SKILL.md` satisfies that test and is emphatically not a version layout -- it is
    a flat pack, and the contract section 3 glob inventory applies instead. The
    discriminator is what those children ARE: a child holding a regular `SKILL.md`
    is a skill, so its parent cannot be a version root. Contrast `packs/bmad/`, also
    `pack.toml`-less and also all real directories, but whose children
    (`6.10.1-next.31/`, `6.10.2/`) hold no top-level `SKILL.md` -- that IS a version
    layout.

    `packs/Kurzgesagt/` is NOT an example of this: its twelve children are all
    symlinks, so it is disqualified one check earlier by the `is_symlink()` test
    below and never reaches the `SKILL.md` test. (Earlier revisions of this comment
    cited it as "twelve skill directories"; that was wrong.)
    """
    try:
        entries = sorted(pack_dir.iterdir(), key=lambda p: p.name)
    except OSError as e:
        raise PackError(f"cannot list pack directory {pack_dir}: {e}") from e

    versions: list[str] = []
    for child in entries:
        if child.name.startswith("."):
            continue
        # A symlink or a stray file means this is not a version-directory layout.
        if child.is_symlink() or not child.is_dir():
            return None
        if is_regular_file(child / SKILL_FILENAME):
            return None
        versions.append(child.name)
    if not versions:
        return None
    return max(versions, key=version_sort_key)


def resolve_pack_dir(packs_root: Path, name: str, version: str | None = None) -> Path:
    """Resolve `packs/<name>[/<version>]` per contract section 2 step 2.

    When `version` is omitted, `packs/<name>/pack.toml` is absent, and
    `packs/<name>/` is a version layout per :func:`select_pack_version`, the
    HIGHEST version directory is selected. That is the only implicit choice this
    function makes. Nothing is ever cloned or fetched.
    """
    try:
        entry = PackEntry(name=name, version=version)
    except ValidationError as e:
        raise PackError(f"invalid pack reference {name!r}: {e}") from e

    base = packs_root / entry.name
    try:
        assert_real_dir(base, f"pack {entry.name!r}")
    except PayloadError as e:
        raise PackError(str(e)) from e

    if entry.version is not None:
        candidate = base / entry.version
        try:
            assert_real_dir(candidate, f"pack {entry.name}@{entry.version}")
        except PayloadError as e:
            raise PackError(str(e)) from e
        return candidate

    if (base / MANIFEST_FILENAME).is_file():
        return base

    selected = select_pack_version(base)
    if selected is None:
        # No pack.toml and not a version layout: a flat pack.toml-less pack
        # (contract section 3 fallback). Never guess.
        return base
    log.debug(
        "pack.version.autoselect",
        pack=entry.name,
        selected=selected,
        available=list_version_dirs(base),
    )
    # `selected` came from iterdir(), so it is one component and cannot escape
    # `base`. Re-assert anyway: contract section 2 rule 4 wants the resolved root
    # checked on EVERY branch, and this closes the window between the scan above
    # and the caller's first read.
    resolved = base / selected
    try:
        assert_real_dir(resolved, f"pack {entry.name}@{selected}")
    except PayloadError as e:
        raise PackError(str(e)) from e
    return resolved


def infer_pack_location(pack_dir: Path) -> tuple[str, str | None]:
    """Infer `(dir_name, version_dir)` from a pack root's position in the registry.

    Purely structural, so the linter can catch a pack.toml whose declared
    name/version disagrees with where it actually lives.
    """
    resolved = pack_dir.resolve()
    parent = resolved.parent
    if parent.name == PACKS_DIRNAME:
        return resolved.name, None
    if parent.parent.name == PACKS_DIRNAME:
        return parent.name, resolved.name
    return resolved.name, None


def load_pack_standalone(
    pack_dir: Path,
    *,
    dir_name: str | None = None,
    version_dir: str | None = None,
) -> Pack:
    """Load a self-contained pack: the layout the packs contract describes.

    Unlike :func:`load_pack` this resolves NOTHING against a skills index. The
    inventory comes from `[freeform].skills` when a pack.toml exists, and from
    globbed `SKILL.md` directories when it does not (contract section 3).

    Raises :class:`PackError` if the pack root is not a real directory.
    """
    try:
        assert_real_dir(pack_dir, "pack root")
    except PayloadError as e:
        raise PackError(str(e)) from e

    inferred_dir, inferred_version = infer_pack_location(pack_dir)
    dir_name = dir_name if dir_name is not None else inferred_dir
    version_dir = version_dir if version_dir is not None else inferred_version

    manifest_path = pack_dir / MANIFEST_FILENAME
    if manifest_path.is_file():
        manifest = load_pack_manifest(manifest_path)
        resolved_manifest_path: Path | None = manifest_path.resolve()
    else:
        try:
            discovered = discover_skill_dirs(pack_dir)
        except PayloadError as e:
            raise PackError(str(e)) from e
        try:
            manifest = PackManifest(
                name=dir_name,
                version=version_dir or "0.0.0",
                description="",
                freeform_skills=discovered,
            )
        except ValidationError as e:
            raise PackError(f"cannot synthesize a manifest for {pack_dir}: {e}") from e
        resolved_manifest_path = None

    return Pack(
        manifest=manifest,
        pack_path=pack_dir.resolve(),
        manifest_path=resolved_manifest_path,
        dir_name=dir_name,
        version_dir=version_dir,
    )


# ---------------------------------------------------------------------------
# Flattened packs: two-level upstream layouts (contract section 3b)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FlatSkill:
    """One projected leaf skill of a flattened pack."""

    name: str
    """Projected skill name: the LEAF directory's basename (contract section 3b)."""

    relpath: str
    """POSIX path of the leaf directory, relative to the pack root."""

    declared: str
    """The declared inventory entry (section 3) this leaf was expanded from."""

    depth: int
    """0 when the declared entry is itself the skill, 1+ for each container level."""


@dataclass(frozen=True)
class FlattenedInventory:
    """Result of expanding a declared inventory per contract section 3b.

    When `enabled` is False this is just the declared inventory re-expressed, so
    every caller can use one shape regardless of layout.
    """

    enabled: bool
    skills: tuple[FlatSkill, ...] = ()
    empty_containers: tuple[str, ...] = ()
    """Containers that expanded to zero leaves - reported, never silently dropped."""
    skipped_symlinks: tuple[str, ...] = ()
    """Symlinked containers/leaves: skipped, never followed, never pack content."""
    unreadable: tuple[str, ...] = ()
    """Container directories that could not be listed."""
    noncanonical: tuple[str, ...] = ()
    """Leaves whose basename is not a canonical skill name: skipped, never projected."""

    @property
    def names(self) -> list[str]:
        """Projected skill names, in expansion order."""
        return [s.name for s in self.skills]

    @property
    def by_name(self) -> dict[str, FlatSkill]:
        """First leaf per projected name. Ambiguity is the linter's to report."""
        out: dict[str, FlatSkill] = {}
        for skill in self.skills:
            out.setdefault(skill.name, skill)
        return out

    def duplicates(self) -> dict[str, list[str]]:
        """Projected names claimed by more than one leaf, with their relpaths."""
        seen: dict[str, list[str]] = {}
        for skill in self.skills:
            seen.setdefault(skill.name, []).append(skill.relpath)
        return {name: paths for name, paths in seen.items() if len(paths) > 1}


@dataclass
class _Expansion:
    """Mutable accumulator threaded through the container walk."""

    skills: list[FlatSkill] = field(default_factory=list)
    empty_containers: list[str] = field(default_factory=list)
    skipped_symlinks: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    noncanonical: list[str] = field(default_factory=list)


def pack_flatten_enabled(pack: Pack, override: bool | None = None) -> bool:
    """Effective flatten state: pack.toml `[policy] flatten` OR the manifest override.

    Pure OR, exactly like :func:`skillex.core.linter.is_sealed`: the manifest field
    exists to turn flattening ON for a pack that ships no `pack.toml`, and passing
    False never un-flattens a pack that declares the layout itself.
    """
    return pack.manifest.policy.flatten or bool(override)


def _expand_container(
    root: Path,
    entry_name: str,
    max_depth: int | None,
    acc: _Expansion,
) -> None:
    """Expand one declared container, recording its leaves and empty sub-containers.

    A child holding a regular ``SKILL.md`` IS a skill and is never descended into,
    which is what keeps a skill's own ``references/``/``scripts/`` support tree out
    of the projection. A child holding none is another container level.

    Deliberately iterative, not recursive: nesting depth here is attacker-influenced
    (it is just how deep a directory tree goes) and a `RecursionError` in a
    read-only verify would be an uncaught crash rather than a finding.
    """
    order: list[str] = [entry_name]
    child_containers: dict[str, list[str]] = {}
    direct_leaves: dict[str, int] = {}
    unreadable: set[str] = set()
    stack: list[tuple[str, int]] = [(entry_name, 1)]

    while stack:
        rel, depth = stack.pop()
        child_containers.setdefault(rel, [])
        direct_leaves.setdefault(rel, 0)
        try:
            entries = sorted(os.scandir(root / rel), key=lambda e: e.name)
        except OSError:
            # Reported as unreadable, never additionally as "empty": an
            # unlistable container is a different finding from an empty one.
            acc.unreadable.append(rel)
            unreadable.add(rel)
            del direct_leaves[rel]
            continue

        for entry in entries:
            if entry.name.startswith(EXCLUDED_PREFIXES):
                continue
            child_rel = f"{rel}/{entry.name}"
            if entry.is_symlink():
                # Diagnostic probe only; the link is skipped either way. Symlinks
                # are never pack content, so never inventory and never payload.
                try:
                    if Path(entry.path).is_dir():
                        acc.skipped_symlinks.append(child_rel)
                except OSError:
                    pass
                continue
            if not entry.is_dir(follow_symlinks=False):
                continue
            if not is_safe_component(entry.name):
                continue
            if is_regular_file(Path(entry.path) / SKILL_FILENAME):
                if not NAME_PATTERN.match(entry.name):
                    # Contract section 3b. Flatten is the ONLY place a projected
                    # skill name is lifted straight off the filesystem - without it
                    # a pack.toml pack projects exactly the strings its author typed
                    # into `[freeform].skills`. `is_safe_component` only asks for one
                    # safe path component, which happily admits `-rf`, `--help`, `*`,
                    # and names carrying newlines or tabs; every consumer turns these
                    # into symlink names inside six CLI skill directories, where they
                    # are argv- and glob-hostile. Skipped (a linter WARN), never a
                    # hard failure, so one odd upstream directory cannot brick a pack.
                    # Deliberately not counted in `direct_leaves`: a container whose
                    # only leaves are rejected here is genuinely empty and must say so.
                    acc.noncanonical.append(child_rel)
                    continue
                acc.skills.append(
                    FlatSkill(name=entry.name, relpath=child_rel, declared=entry_name, depth=depth)
                )
                direct_leaves[rel] += 1
            elif max_depth is None or depth < max_depth:
                child_containers[rel].append(child_rel)
                order.append(child_rel)
                stack.append((child_rel, depth + 1))

    # `order` lists every container parent-before-child, so one reverse pass
    # settles each subtree's total before its parent needs it.
    totals = dict(direct_leaves)
    for rel in reversed(order):
        if rel not in totals:  # unreadable: already reported, contributes nothing
            continue
        totals[rel] += sum(totals.get(child, 0) for child in child_containers.get(rel, ()))

    acc.empty_containers.extend(
        rel for rel in order if rel not in unreadable and totals.get(rel, 0) == 0
    )


def flatten_inventory(
    root: Path,
    declared: Sequence[str],
    *,
    max_depth: int | None = None,
) -> FlattenedInventory:
    """Expand a DECLARED inventory into leaf skills (contract section 3b).

    Each declared entry is classified:

    - it holds a regular ``SKILL.md``  -> it IS a skill, taken as-is
    - it holds none                    -> it is a CONTAINER; its child directories
      holding a regular ``SKILL.md`` become skills

    ``max_depth`` bounds the container levels traversed (``1`` reproduces a strict
    single-level expansion; ``None`` descends while a node is still a container and
    is the default).

    Why the default descends rather than stopping at one level: contract section 3b
    pins ``packs/hermes-base/0.18.2`` at **73** leaf skills, and upstream Hermes
    resolves that same tree with a recursive walk that prunes only a skill's own
    support directories (``agent/skill_utils.py::iter_skill_index_files``). That
    pack is not uniformly two-level - ``mlops/`` carries three sub-containers
    (``evaluation/``, ``inference/``, ``models/``), each with its own
    ``DESCRIPTION.md`` and two leaves. Stopping at one level yields 67 and silently
    drops those six real skills, which is precisely the outcome section 3b's "never
    silently dropped" rule exists to forbid. The invariant that actually matters is
    "never descend into something that IS a skill", and this honours it.

    A leaf basename that is not a canonical skill name (:data:`NAME_PATTERN`) is
    collected into ``noncanonical`` and NOT projected - see :func:`_expand_container`.
    A DECLARED entry that is itself a skill is exempt: its name is the author's
    string, not a filesystem basename, exactly as it would be without flatten.

    Never follows a symlink. Purely read-only: the payload/sealing definition
    (section 4) is computed from the DECLARED entries and is untouched by this.
    """
    acc = _Expansion()
    for entry_name in declared:
        if not is_safe_component(entry_name):
            # Reported by the linter as SKILL_NAME_UNSAFE; never joined onto a path.
            continue
        base = root / entry_name
        try:
            if is_regular_file(base / SKILL_FILENAME):
                acc.skills.append(
                    FlatSkill(name=entry_name, relpath=entry_name, declared=entry_name, depth=0)
                )
                continue
            assert_real_dir(base, f"skill directory {entry_name!r}")
        except PayloadError:
            # Missing / symlinked / non-directory entries are the linter's to report
            # (SKILL_DIR_MISSING); expansion just has nothing to contribute here.
            continue
        _expand_container(root, entry_name, max_depth, acc)

    # Sorted by relpath so the projection is stable regardless of walk order and
    # of the order the filesystem happens to hand back.
    return FlattenedInventory(
        enabled=True,
        skills=tuple(sorted(acc.skills, key=lambda s: s.relpath)),
        empty_containers=tuple(sorted(acc.empty_containers)),
        skipped_symlinks=tuple(sorted(acc.skipped_symlinks)),
        unreadable=tuple(sorted(acc.unreadable)),
        noncanonical=tuple(sorted(acc.noncanonical)),
    )


def discover_declared_dirs(root: Path) -> list[str]:
    """Inventory for a FLATTENED pack that has no authoritative declared list.

    The section-3 counterpart :func:`skillex.core.payload.discover_skill_dirs` keeps
    only children that hold a regular ``SKILL.md``. In a flattened pack (section 3b)
    that is exactly the wrong test: the entries are CONTAINERS, and a container has
    no ``SKILL.md`` of its own - `packs/hermes-base/0.18.2` has 14 of them against 4
    already-flat entries. Discovery has to accept both.

    A child is kept when it is a skill itself OR expands to at least one leaf skill.
    One that yields neither is left out, matching how :func:`discover_skill_dirs`
    leaves out a child with no ``SKILL.md``.

    Returns DECLARED entry names (containers), never the projected leaf names: the
    payload and the seal are defined from the declared entries (contract section 4),
    and declaring a container already covers everything beneath it.
    """
    assert_real_dir(root, "pack root")
    candidates: list[str] = []
    with os.scandir(root) as entries:
        for entry in sorted(entries, key=lambda e: e.name):
            if not entry.is_dir(follow_symlinks=False):
                continue
            if entry.name.startswith(EXCLUDED_PREFIXES):
                continue
            if not is_safe_component(entry.name):
                continue
            candidates.append(entry.name)

    # Reuse the projection walk itself rather than reimplementing "is this a
    # container": discovery and projection must never be able to disagree about
    # what the pack contains.
    contributing = {skill.declared for skill in flatten_inventory(root, candidates).skills}
    return [name for name in candidates if name in contributing]


def resolve_inventory(pack: Pack, *, flatten: bool | None = None) -> FlattenedInventory:
    """The inventory a pack PROJECTS, flattened when section 3b applies.

    `flatten` is the explicit override for manifest-driven callers (a `packs[]`
    entry's `"flatten"`); it may only turn flattening ON, per
    :func:`pack_flatten_enabled`.

    With flattening off the declared names come back verbatim and `enabled` is
    False, so every existing pack resolves exactly as it did before section 3b.
    """
    if not pack_flatten_enabled(pack, flatten):
        return FlattenedInventory(
            enabled=False,
            skills=tuple(
                FlatSkill(name=name, relpath=name, declared=name, depth=0)
                for name in pack.inventory
            ),
        )
    return flatten_inventory(pack.pack_path, pack.inventory)


KNOWN_MANIFEST_KEYS = frozenset(
    {"$schema", "scope", "inherit_global", "registry", "sets", "packs", "skills"}
)


def _parse_entries[T: (PackEntry, SetEntry, SkillEntry)](
    path: Path,
    raw: dict[str, object],
    key: str,
    builder: Callable[[str | dict[str, object]], T],
) -> tuple[T, ...]:
    """Parse one manifest array, preserving declaration order.

    Order is the whole precedence law -- a later entry overwrites an earlier one --
    so this returns a tuple and never sorts or deduplicates.
    """
    items = raw.get(key, [])
    if not isinstance(items, list):
        raise ManifestError(f"{path}: {key!r} must be an array")
    out: list[T] = []
    for index, spec in enumerate(items):
        if not isinstance(spec, str | dict):
            raise ManifestError(f"{path}: {key}[{index}] must be a string or an object")
        try:
            out.append(builder(spec))
        except UnsupportedFieldError as e:
            # Re-raised verbatim: the authored explanation is the whole value.
            raise ManifestError(f"{path}: {key}[{index}]: {e}") from e
        except (ValidationError, ValueError) as e:
            raise ManifestError(f"{path}: invalid {key}[{index}]: {e}") from e
    return tuple(out)


def load_skills_manifest(path: Path) -> SkillsManifest:
    """Parse a skills.json manifest: `packs[]`, `sets[]` and `skills[]`.

    Each array accepts the string shorthand and the object form. Declaration order
    is preserved across all three because `compose()` resolves them positionally.

    Unknown top-level keys are recorded rather than rejected: the published schema
    sets no ``additionalProperties: false``, so a typo like ``"skils"`` validates
    today and would otherwise vanish without trace.
    """
    if not path.is_file():
        raise ManifestError(f"skills manifest not found: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ManifestError(f"failed to parse {path}: {e}") from e
    if not isinstance(raw, dict):
        raise ManifestError(f"{path}: top level must be a JSON object")

    packs = _parse_entries(path, raw, "packs", PackEntry.from_spec)
    sets = _parse_entries(path, raw, "sets", SetEntry.from_spec)
    skills = _parse_entries(path, raw, "skills", SkillEntry.from_spec)

    try:
        return SkillsManifest(
            path=path.resolve(),
            schema_url=raw.get("$schema"),
            scope=raw.get("scope"),
            inherit_global=raw.get("inherit_global"),
            registry=raw.get("registry"),
            packs=packs,
            sets=sets,
            skills=skills,
            unknown_keys=tuple(sorted(k for k in raw if k not in KNOWN_MANIFEST_KEYS)),
        )
    except ValidationError as e:
        raise ManifestError(f"invalid skills manifest at {path}: {e}") from e
