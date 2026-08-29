"""Vendor external skill repositories into the canonical catalog as real content.

The problem, measured: 15 entries of ``all-skills/`` are symlinks with ABSOLUTE
targets into ``~/code/33GOD``, so the published catalog carries 15 paths that
resolve on exactly one machine. On a second machine ``sets/min-global`` drops from
36 usable skills to 26 and ``sets/global`` from 90 to 75.

The shape of the fix, in the user's words: *declare* an external repo in a
manifest, *vendor* its skills into the catalog as committed content pinned to a
version, and keep authoring them in the repo they belong to.

Three facts about those 15 shape everything here, and each one is a refusal rather
than a comment, because each is a mistake a reasonable manifest would otherwise
make silently:

1. **``33GOD/skills/`` is not a skill directory.** All 16 entries are mode
   ``120000`` symlink blobs pointing into nested submodules. A source declaring
   "33GOD, subdir ``skills``" -- the obvious reading, and the default this module
   ships -- would vendor 16 absolute path strings. :data:`Code.E_SOURCE_ENTRY_IS_LINK`.
2. **9 of the 15 live in nested submodules** (``pjangler``, ``bloodbank``,
   ``momo``), whose content is not in 33GOD's object database at all.
   :data:`Code.E_SOURCE_ENTRY_IS_SUBMODULE` names them and tells you to declare
   them as their own sources.
3. **The projected name is neither the basename nor the frontmatter.** ``momo``'s
   directory is named ``skill``; ``project-jangler``'s frontmatter says
   ``pjangler``. The catalog name comes from ``sources.toml`` and only from there.

Two invariants this module does not get to relax:

* **It never clones and never fetches.** See ``core/gitsource.py``; the
  prohibition is stated four times across ``paths.py``, two ``from_spec``
  refusals and the published schema, and vendoring is an addition to that world,
  not a reversal of it.
* **A locally-modified vendored skill is never silently overwritten.** The
  recorded digest is recomputed against the directory on every run; a mismatch is
  :data:`Code.E_VENDOR_LOCAL_EDITS` with the repo to push to, and only an explicit
  ``--force`` discards it.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from skillex.core.diagnostics import Code, Reporter
from skillex.core.gitsource import GitReader, SourceReadError, TreeEntry
from skillex.core.models import (
    SourceEntry,
    SourcesManifest,
    is_safe_component,
    is_safe_relpath,
)
from skillex.core.payload import (
    EXCLUDED_PREFIXES,
    SKILL_FILENAME,
    PayloadError,
    assert_real_dir,
    sha256_file,
)
from skillex.core.provenance import (
    SOURCE_YAML,
    VENDORED,
    Provenance,
    now_stamp,
    read_provenance,
    write_provenance,
)

CATALOG_DIRNAME = "all-skills"
SOURCES_FILENAME = "sources.toml"
STAGE_DIRNAME = ".vendor-stage"

#: Where a machine says which directory a logical checkout id lives in.
#: ``sources.toml`` is committed and shared, so it may not contain a path; this
#: file is the honest home for the one fact that IS about this disk.
LOCAL_CHECKOUTS_FILENAME = "sources.local.toml"


class VendorAction(StrEnum):
    """What a plan would do to one catalog entry."""

    CREATE = "create"
    #: The entry is a symlink today -- the starting state of all 15.
    REPLACE_LINK = "replace-link"
    #: Existing unmanaged content taken over, only under an explicit ``--adopt``.
    ADOPT = "adopt"
    UPDATE = "update"
    UNCHANGED = "unchanged"
    PRUNE = "prune"


#: Actions that write bytes into the catalog.
WRITING_ACTIONS = frozenset(
    {VendorAction.CREATE, VendorAction.REPLACE_LINK, VendorAction.ADOPT, VendorAction.UPDATE}
)


@dataclass(frozen=True)
class VendorOp:
    """One planned change to one catalog entry."""

    action: VendorAction
    name: str
    source: str
    repo: str = ""
    version: str = ""
    commit: str = ""
    tree: str = ""
    repo_path: str = ""
    checkout: Path | None = None
    detail: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "action": self.action.value,
            "name": self.name,
            "source": self.source,
            "repo": self.repo,
            "version": self.version,
            "commit": self.commit,
            "tree": self.tree,
            "repo_path": self.repo_path,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class SourceResolution:
    """What a source resolved to on this machine, for reporting."""

    name: str
    repo: str
    version: str
    checkout: Path | None
    commit: str | None
    ref_kind: str = "unknown"
    skipped: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "repo": self.repo,
            "version": self.version,
            "checkout": str(self.checkout) if self.checkout else None,
            "commit": self.commit,
            "ref_kind": self.ref_kind,
            "skipped": self.skipped,
        }


@dataclass
class VendorPlan:
    catalog: Path
    ops: list[VendorOp] = field(default_factory=list)
    resolutions: list[SourceResolution] = field(default_factory=list)

    @property
    def writes(self) -> list[VendorOp]:
        return [op for op in self.ops if op.action in WRITING_ACTIONS]

    @property
    def prunes(self) -> list[VendorOp]:
        return [op for op in self.ops if op.action is VendorAction.PRUNE]

    @property
    def has_changes(self) -> bool:
        return bool(self.writes or self.prunes)

    @property
    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {a.value: 0 for a in VendorAction}
        for op in self.ops:
            out[op.action.value] += 1
        return out


# ---------------------------------------------------------------------------
# digest
# ---------------------------------------------------------------------------


def _walk_files(unit: Path) -> list[tuple[str, Path]]:
    """Every regular file under ``unit``, sorted, excluding the root ``.source.yaml``.

    Never follows a symlink and raises :class:`PayloadError` the moment it meets
    one -- the same "enumerate first, refuse before mutating" rule ``payload.py``
    is built on. A vendored skill is real content by definition; a link inside one
    would reintroduce exactly the machine-local path this feature removes.
    """
    out: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(unit):  # os.walk never follows links
        dirnames.sort()
        here = Path(dirpath)
        for name in sorted(dirnames):
            child = here / name
            if stat.S_ISLNK(child.lstat().st_mode):
                raise PayloadError(f"vendored content may not contain symlinks: {child}")
        for name in sorted(filenames):
            full = here / name
            rel = full.relative_to(unit).as_posix()
            if rel == SOURCE_YAML:
                continue
            mode = full.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise PayloadError(f"vendored content may not contain symlinks: {full}")
            if not stat.S_ISREG(mode):
                raise PayloadError(f"vendored content may contain only regular files: {full}")
            out.append((rel, full))
    out.sort(key=lambda pair: pair[0])
    return out


def tree_digest(unit: Path) -> str:
    """``sha256:<hex>`` over ``<mode> <sha256>  <relpath>`` lines, sorted by path.

    The mode is in the digest, and that is the whole reason this is not just
    :func:`payload.render_sha256sums`: skills ship ``scripts/`` directories, and a
    lost executable bit is a real breakage that a bytes-only digest cannot see.
    Only ``100644`` and ``100755`` are expressible, matching what git records and
    what :func:`gitsource.extract_tar` writes.

    ``<unit>/.source.yaml`` is excluded because it contains this value; including
    it would be a fixpoint. Excluding it also means an upstream repo adding or
    removing its own ``.source.yaml`` never registers as drift.
    """
    lines = []
    for rel, full in _walk_files(unit):
        mode = "100755" if full.lstat().st_mode & stat.S_IXUSR else "100644"
        lines.append(f"{mode} {sha256_file(full)}  {rel}")
    body = "\n".join(lines) + "\n" if lines else ""
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# catalog + checkout resolution
# ---------------------------------------------------------------------------


def config_dir() -> Path:
    """``$XDG_CONFIG_HOME/skillex``, defaulting to ``~/.config/skillex``."""
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".config"
    return root / "skillex"


def local_checkouts_path() -> Path:
    return config_dir() / LOCAL_CHECKOUTS_FILENAME


def load_local_checkouts(path: Path | None = None) -> dict[str, Path]:
    """Read the machine-local ``[checkouts]`` table. Never raises.

    A malformed file degrades to "I know less" and the ladder falls through to
    ``~/code/<id>``, which is recoverable; refusing to run because an optional
    convenience file has a typo is not.
    """
    import tomllib

    target = path or local_checkouts_path()
    try:
        raw = tomllib.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    table = raw.get("checkouts")
    if not isinstance(table, dict):
        return {}
    out: dict[str, Path] = {}
    for key, value in table.items():
        if isinstance(key, str) and isinstance(value, str) and value:
            out[key] = Path(value).expanduser()
    return out


def source_env_var(checkout_id: str) -> str:
    """``SKILLEX_SOURCE_<ID>``, with every non-alphanumeric byte folded to ``_``."""
    slug = "".join(ch if ch.isalnum() else "_" for ch in checkout_id).upper()
    return f"SKILLEX_SOURCE_{slug}"


def checkout_candidates(
    entry: SourceEntry, *, overrides: Mapping[str, Path] | None = None
) -> list[Path]:
    """Local directories that might hold ``entry``'s repository, in precedence order.

    ``--checkout ID=PATH`` | ``$SKILLEX_SOURCE_<ID>`` | ``sources.local.toml`` |
    ``$SKILLEX_SOURCE_ROOT/<id>`` (default ``~/code/<id>``).

    The first two are EXCLUSIVE when present, for the reason
    ``PJ_SKILLS_REGISTRY_ROOT`` is: pinning one is a deliberate act, and a ladder
    that falls through it would vendor from a checkout the operator did not name.
    """
    cid = entry.checkout_id
    if overrides and cid in overrides:
        return [overrides[cid].expanduser()]
    env = os.environ.get(source_env_var(cid))
    if env:
        return [Path(env).expanduser()]
    candidates: list[Path] = []
    local = load_local_checkouts().get(cid)
    if local is not None:
        candidates.append(local)
    root = os.environ.get("SKILLEX_SOURCE_ROOT")
    base = Path(root).expanduser() if root else Path.home() / "code"
    candidates.append(base / cid)
    return candidates


def resolve_checkout(
    entry: SourceEntry, *, overrides: Mapping[str, Path] | None = None
) -> Path | None:
    """First candidate that exists as a directory, else None."""
    for candidate in checkout_candidates(entry, overrides=overrides):
        if candidate.is_dir():
            return candidate
    return None


def normalize_repo(url: str) -> str:
    """Collapse the spellings of one repository so a mismatch check is meaningful.

    ``git@github.com:delorenj/momo`` and ``https://github.com/delorenj/momo.git``
    are the same repository, and ``.gitmodules`` and ``remote.origin.url``
    disagree about the ``.git`` suffix for at least one of these four sources.
    """
    text = url.strip().rstrip("/")
    for scheme in ("https://", "http://", "ssh://git@", "ssh://", "git://"):
        if text.startswith(scheme):
            text = text[len(scheme) :]
            break
    else:
        if text.startswith("git@"):
            text = text[4:].replace(":", "/", 1)
    return text.removesuffix(".git").lower()


def catalog_root(explicit: Path | None, registry_roots_: Sequence[Path]) -> Path | None:
    """Where vendored content is written. Never the second rung of a ladder.

    Reading walks a ladder; writing must not. Picking "whichever registry rung
    happened to carry it" is right for resolution and disastrous for a write --
    it would land committed content in a stale cache clone. So: the explicit
    ``--catalog``, else the FIRST registry root, and nothing else.
    """
    if explicit is not None:
        return explicit.expanduser()
    for root in registry_roots_:
        return root / CATALOG_DIRNAME
    return None


# ---------------------------------------------------------------------------
# planning
# ---------------------------------------------------------------------------


def _refuse_tree_entry(
    reporter: Reporter, entry: SourceEntry, commit: str, item: TreeEntry, where: str
) -> bool:
    """Emit the symlink / gitlink refusal for one tree entry. True when refused."""
    if item.is_symlink:
        reporter.emit(
            Code.E_SOURCE_ENTRY_IS_LINK,
            f"{entry.name}: {where}/{item.path} is a symlink in {entry.repo} at {commit[:8]}",
            name=item.path,
            detail=(
                "Vendoring it would copy a path string, which is the machine-local "
                "breakage this feature exists to remove.",
            ),
            fix=(
                "declare the repository that AUTHORS the skill as its own [[source]]. "
                "33GOD/skills/ is a farm of 16 such links into pjangler, bloodbank, "
                "momo and 33god-platform -- name those instead."
            ),
        )
        return True
    if item.is_gitlink:
        reporter.emit(
            Code.E_SOURCE_ENTRY_IS_SUBMODULE,
            f"{entry.name}: {where}/{item.path} is a nested submodule "
            f"(gitlink {item.oid[:8]}) in {entry.repo} at {commit[:8]}",
            name=item.path,
            detail=("Its content is not in this repository's object database.",),
            fix=(f"declare {item.path!r} as its own [[source]] with its own repo and version."),
        )
        return True
    return False


def _discover_units(
    reporter: Reporter, reader: GitReader, entry: SourceEntry, checkout: Path, commit: str
) -> list[tuple[str, str]] | None:
    """``[(catalog_name, repo_path)]`` for a source with no explicit ``skills`` list."""
    try:
        listing = reader.ls_tree(checkout, commit, entry.subdir)
    except SourceReadError as e:
        reporter.emit(
            Code.E_SOURCE_SUBDIR_MISSING,
            f"{entry.name}: subdir {entry.subdir or '<repo root>'!r} does not exist "
            f"at {commit[:8]}",
            detail=(str(e),),
            fix=(
                f"check the path at that version: "
                f"git -C {checkout} ls-tree {commit[:8]} -- {entry.subdir or '.'}"
            ),
        )
        return None

    names: list[str] = []
    paths: dict[str, str] = {}
    refused = False
    for item in listing:
        if item.path.startswith(EXCLUDED_PREFIXES):
            # `.system/` and friends are never skills, in this walker or any other.
            continue
        if _refuse_tree_entry(reporter, entry, commit, item, entry.subdir or "<repo root>"):
            refused = True
            continue
        if not item.is_tree:
            continue
        if not is_safe_component(item.path):
            continue
        names.append(item.path)
        paths[item.path] = f"{entry.subdir}/{item.path}" if entry.subdir else item.path
    if refused:
        return None
    return [(name, paths[name]) for name in entry.filter_inventory(names)]


def _validate_unit_tree(
    reporter: Reporter,
    reader: GitReader,
    entry: SourceEntry,
    checkout: Path,
    commit: str,
    catalog_name: str,
    repo_path: str,
) -> str | None:
    """Full recursive check of one skill's tree. Returns its tree oid, or None."""
    try:
        listing = reader.ls_tree(checkout, commit, repo_path, recursive=True)
        oid = reader.tree_oid(checkout, commit, repo_path)
    except SourceReadError as e:
        reporter.emit(
            Code.E_SOURCE_SKILL_MISSING,
            f"{entry.name}: {repo_path!r} does not exist at {commit[:8]}",
            name=catalog_name,
            detail=(str(e),),
            fix=(
                f"check the path at that version: "
                f"git -C {checkout} ls-tree {commit[:8]} -- {repo_path}"
            ),
        )
        return None

    ok = True
    for item in listing:
        if _refuse_tree_entry(reporter, entry, commit, item, repo_path):
            ok = False
            continue
        if not is_safe_relpath(item.path):
            reporter.emit(
                Code.E_SOURCE_UNSAFE_MEMBER,
                f"{entry.name}: refusing member {item.path!r} of {repo_path}",
                name=catalog_name,
                fix="the source tree carries a name that cannot be written safely; fix it upstream.",
            )
            ok = False
    if not any(item.path == SKILL_FILENAME and item.kind == "blob" for item in listing):
        reporter.emit(
            Code.E_SOURCE_NOT_A_SKILL,
            f"{entry.name}: {repo_path} has no {SKILL_FILENAME} at its root",
            name=catalog_name,
            fix=(
                "point the source at a directory that IS a skill, or drop it from "
                "the manifest. A catalog entry without SKILL.md is not resolvable."
            ),
        )
        ok = False
    return oid if ok else None


def _classify(
    reporter: Reporter,
    catalog: Path,
    entry: SourceEntry,
    catalog_name: str,
    tree: str,
    *,
    adopt: bool,
    force: bool,
) -> VendorAction | None:
    """Decide what to do with ``catalog/<catalog_name>``, refusing rather than guessing."""
    live = catalog / catalog_name
    if live.is_symlink():
        return VendorAction.REPLACE_LINK
    if not live.exists():
        return VendorAction.CREATE
    if not live.is_dir():
        reporter.emit(
            Code.E_VENDOR_WOULD_CLOBBER,
            f"{catalog_name}: {live} exists and is not a directory",
            name=catalog_name,
            path=live,
            fix="remove or rename it, or drop the skill from the source.",
        )
        return None

    prov = read_provenance(live)
    if prov is None or not prov.is_vendored or prov.source != entry.name:
        if not adopt:
            held = "unmanaged local content" if prov is None else f"{prov.type!r} content"
            owner = f" owned by source {prov.source!r}" if prov and prov.source else ""
            reporter.emit(
                Code.E_VENDOR_WOULD_CLOBBER,
                f"{catalog_name}: all-skills/{catalog_name} is {held}{owner}, "
                f"not vendored from {entry.name!r}",
                name=catalog_name,
                path=live,
                fix=(
                    "remove or rename it, exclude the name from this source, or pass "
                    "--adopt to take it over (which REPLACES its content with the pin)."
                ),
            )
            return None
        return VendorAction.ADOPT

    try:
        on_disk = tree_digest(live)
    except PayloadError as e:
        reporter.emit(
            Code.E_VENDOR_WOULD_CLOBBER,
            f"{catalog_name}: cannot digest the existing directory: {e}",
            name=catalog_name,
            path=live,
            fix="remove the offending entry, then re-run.",
        )
        return None

    modified = prov.digest is not None and on_disk != prov.digest
    moved = prov.upstream_tree != tree
    if modified and not force:
        reporter.emit(
            Code.E_VENDOR_LOCAL_EDITS,
            f"{catalog_name}: edited locally since it was vendored from "
            f"{entry.name}@{(prov.upstream_commit or '?')[:8]}",
            name=catalog_name,
            path=live,
            detail=(
                f"recorded {prov.digest}",
                f"on disk  {on_disk}",
            ),
            fix=(
                f"push the edit to {entry.repo} and bump the source's version, or "
                "re-run with --force to discard it."
            ),
        )
        return None
    if not moved and not modified:
        return VendorAction.UNCHANGED
    return VendorAction.UPDATE


def plan_vendor(
    catalog: Path,
    manifest: SourcesManifest,
    reporter: Reporter,
    *,
    reader: GitReader,
    select: Sequence[str] = (),
    checkouts: Mapping[str, Path] | None = None,
    adopt: bool = False,
    force: bool = False,
    prune: bool = False,
) -> VendorPlan:
    """Resolve, enumerate and classify. Pure: nothing here writes anything.

    Every error is collected rather than raised, so one run tells you about all
    four broken sources instead of the first -- and any error at all means the
    caller performs ZERO mutation, which is ``sync``'s law applied unchanged.
    """
    plan = VendorPlan(catalog=catalog)

    try:
        assert_real_dir(catalog, "catalog")
    except PayloadError as e:
        reporter.emit(
            Code.E_VENDOR_CATALOG_INVALID,
            str(e),
            path=catalog,
            fix="pass --catalog, or set PJ_SKILLS_REGISTRY_ROOT to a real checkout.",
        )
        return plan

    by_name = manifest.by_name()
    if select:
        unknown = [name for name in select if name not in by_name]
        if unknown:
            reporter.emit(
                Code.E_SOURCE_UNKNOWN,
                f"no source named {', '.join(repr(n) for n in unknown)} in {manifest.path}",
                fix=f"declared sources are: {', '.join(sorted(by_name)) or '(none)'}.",
            )
            return plan
        entries = [by_name[name] for name in select]
    else:
        entries = list(manifest.sources)

    claimed: dict[str, str] = {}
    #: Sources that got all the way through resolution and enumeration without a
    #: single error. Only these may have orphans computed against them -- a source
    #: whose checkout is missing claims NOTHING this run, and scanning it would
    #: report every skill it owns as "no longer declared" and, under --prune,
    #: delete them. A failure to read must never look like a decision to drop.
    healthy: set[str] = set()

    for entry in entries:
        errors_before = len(reporter.errors())
        checkout = resolve_checkout(entry, overrides=checkouts)
        if checkout is None:
            tried = ", ".join(str(p) for p in checkout_candidates(entry, overrides=checkouts))
            if entry.optional:
                reporter.emit(
                    Code.W_SOURCE_OPTIONAL_MISSING,
                    f"{entry.name}: no local checkout found; skipped (optional)",
                    name=entry.name,
                    detail=(f"tried: {tried}",),
                )
                plan.resolutions.append(
                    SourceResolution(
                        entry.name, entry.repo, entry.version, None, None, skipped=True
                    )
                )
                continue
            reporter.emit(
                Code.E_SOURCE_CHECKOUT_MISSING,
                f"{entry.name}: no local checkout found",
                name=entry.name,
                detail=(f"tried: {tried}",),
                fix=(
                    f"clone it yourself -- skillex never clones -- with "
                    f"`git clone {entry.repo} ~/code/{entry.checkout_id}`, record it in "
                    f"{local_checkouts_path()}, or pass "
                    f"--checkout {entry.checkout_id}=<path>."
                ),
            )
            continue

        if not reader.is_repo(checkout):
            reporter.emit(
                Code.E_SOURCE_NOT_A_REPO,
                f"{entry.name}: {checkout} is not a git work tree",
                name=entry.name,
                path=checkout,
                fix="point the checkout at the repository root.",
            )
            continue

        try:
            commit = reader.resolve_commit(checkout, entry.version)
        except SourceReadError as e:
            reporter.emit(
                Code.E_SOURCE_REF_UNKNOWN,
                f"{entry.name}: version {entry.version!r} is not in the local object "
                f"store at {checkout}",
                name=entry.name,
                detail=(str(e),),
                fix=(
                    f"git -C {checkout} fetch --tags origin -- skillex will not fetch "
                    "for you; sync-skills.py is the only surface allowed to."
                ),
            )
            continue

        kind = reader.ref_kind(checkout, entry.version)
        plan.resolutions.append(
            SourceResolution(entry.name, entry.repo, entry.version, checkout, commit, kind)
        )
        if kind == "branch":
            reporter.emit(
                Code.W_SOURCE_REF_IS_BRANCH,
                f"{entry.name}: version {entry.version!r} is a branch, so the pin moves",
                name=entry.name,
                detail=(f"resolved to {commit}",),
                fix=(
                    "harmless -- the bytes are committed, so nothing changes until you "
                    "re-run vendor. Set version to a tag or a SHA to make it immutable."
                ),
            )
        origin = reader.origin_url(checkout)
        if origin and normalize_repo(origin) != normalize_repo(entry.repo):
            reporter.emit(
                Code.W_SOURCE_REMOTE_MISMATCH,
                f"{entry.name}: checkout's origin is {origin}, manifest declares {entry.repo}",
                name=entry.name,
                path=checkout,
                fix="fix whichever is wrong; the manifest value is what every receipt records.",
            )

        units: list[tuple[str, str]] | None
        if entry.skills:
            units = [(skill.name, entry.tree_path(skill)) for skill in entry.skills]
        else:
            units = _discover_units(reporter, reader, entry, checkout, commit)
        if units is None:
            continue

        for catalog_name, repo_path in units:
            if catalog_name in claimed:
                reporter.emit(
                    Code.E_VENDOR_NAME_COLLISION,
                    f"catalog name {catalog_name!r} is claimed by both "
                    f"{claimed[catalog_name]!r} and {entry.name!r}",
                    name=catalog_name,
                    fix=(
                        "exclude it from one source, or rename it there with an explicit "
                        "skills = [{ name = ..., dir = ... }] entry."
                    ),
                )
                continue
            claimed[catalog_name] = entry.name

            tree = _validate_unit_tree(
                reporter, reader, entry, checkout, commit, catalog_name, repo_path
            )
            if tree is None:
                continue
            action = _classify(
                reporter, catalog, entry, catalog_name, tree, adopt=adopt, force=force
            )
            if action is None:
                continue
            plan.ops.append(
                VendorOp(
                    action=action,
                    name=catalog_name,
                    source=entry.name,
                    repo=entry.repo,
                    version=entry.version,
                    commit=commit,
                    tree=tree,
                    repo_path=repo_path,
                    checkout=checkout,
                )
            )

        if len(reporter.errors()) == errors_before:
            healthy.add(entry.name)

    _plan_orphans(reporter, catalog, healthy, set(claimed), plan, prune=prune)
    plan.ops.sort(key=lambda op: (op.action.value, op.name))
    return plan


def _plan_orphans(
    reporter: Reporter,
    catalog: Path,
    healthy_sources: set[str],
    declared: set[str],
    plan: VendorPlan,
    *,
    prune: bool,
) -> None:
    """Catalog entries a selected source used to own and no longer declares.

    Receipt-driven and bounded: only a directory whose own ``.source.yaml`` names
    one of the sources in play, and never one that has been edited since it was
    vendored. Deleting is opt-in; the default is to say so and leave it alone.
    """
    for child in sorted(catalog.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        if child.name in declared or child.name.startswith(EXCLUDED_PREFIXES):
            continue
        prov = read_provenance(child)
        if prov is None or not prov.is_vendored or prov.source not in healthy_sources:
            continue
        if not prune:
            reporter.emit(
                Code.W_VENDOR_ORPHANED,
                f"{child.name}: vendored from source {prov.source!r}, which no longer declares it",
                name=child.name,
                path=child,
                fix="re-declare it in sources.toml, or re-run with --prune to remove it.",
            )
            continue
        try:
            on_disk = tree_digest(child)
        except PayloadError:
            on_disk = ""
        if prov.digest and on_disk != prov.digest:
            reporter.emit(
                Code.E_VENDOR_LOCAL_EDITS,
                f"{child.name}: orphaned AND edited locally; refusing to prune",
                name=child.name,
                path=child,
                fix=f"push the edit to {prov.upstream or 'its source repo'}, then re-run.",
            )
            continue
        plan.ops.append(
            VendorOp(action=VendorAction.PRUNE, name=child.name, source=prov.source or "")
        )


# ---------------------------------------------------------------------------
# applying
# ---------------------------------------------------------------------------


def stage_root(catalog: Path) -> Path:
    return catalog / STAGE_DIRNAME


def recover_stage(catalog: Path, reporter: Reporter) -> bool:
    """Roll back a crashed run's half-finished swap. True when it is safe to proceed.

    The swap is two renames per entry: live -> ``trash/<name>``, then
    ``new/<name>`` -> live. A crash between them leaves the catalog entry ABSENT
    and its old content in ``trash``, which is recoverable without a receipt --
    the trash directory *is* the receipt, and it is on the same filesystem as the
    thing it came from.
    """
    root = stage_root(catalog)
    if not root.exists():
        return True
    unresolved: list[str] = []
    for run in sorted(root.iterdir()):
        trash = run / "trash"
        if trash.is_dir():
            for saved in sorted(trash.iterdir()):
                live = catalog / saved.name
                if live.is_symlink() or live.exists():
                    continue
                try:
                    os.replace(saved, live)
                except OSError:
                    unresolved.append(saved.name)
    if unresolved:
        reporter.emit(
            Code.E_VENDOR_STAGE_DIRTY,
            f"a previous vendor run left {root} and it cannot be rolled back",
            path=root,
            detail=tuple(sorted(unresolved)),
            fix=f"inspect {root}, restore what you want, then remove the directory.",
        )
        return False
    shutil.rmtree(root, ignore_errors=True)
    return True


def apply_vendor(plan: VendorPlan, reporter: Reporter, *, reader: GitReader) -> None:
    """Materialize a clean plan. Callers must have verified there are zero errors.

    Staged first, swapped second. Every byte is written under
    ``all-skills/.vendor-stage/<pid>/`` and verified there; only then are two
    atomic renames per entry performed, on the same filesystem. A failure during
    staging leaves the catalog untouched.
    """
    catalog = plan.catalog
    writes = plan.writes
    prunes = plan.prunes
    if not writes and not prunes:
        return

    run = stage_root(catalog) / str(os.getpid())
    new = run / "new"
    trash = run / "trash"
    new.mkdir(parents=True, exist_ok=True)
    trash.mkdir(parents=True, exist_ok=True)

    try:
        for op in writes:
            _stage_one(op, new / op.name, reporter, reader=reader)
        for op in writes:
            live = catalog / op.name
            if live.is_symlink():
                live.unlink()
            elif live.exists():
                os.replace(live, trash / op.name)
            os.replace(new / op.name, live)
        for op in prunes:
            live = catalog / op.name
            if live.is_symlink():
                live.unlink()
            elif live.exists():
                os.replace(live, trash / op.name)
    finally:
        shutil.rmtree(run, ignore_errors=True)
        parent = stage_root(catalog)
        try:
            if parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
        except OSError:
            pass


def _stage_one(op: VendorOp, dest: Path, reporter: Reporter, *, reader: GitReader) -> None:
    assert op.checkout is not None
    reader.export(op.checkout, op.commit, op.repo_path, dest)
    if not (dest / SKILL_FILENAME).is_file():
        raise PayloadError(f"{op.name}: exported tree has no {SKILL_FILENAME}")
    upstream_receipt = dest / SOURCE_YAML
    if upstream_receipt.exists():
        # Two of the fifteen carry one INSIDE the foreign repo claiming
        # `type: local` about a repository that is not the catalog. Copying it
        # would publish a provenance record that is false about the file it sits
        # next to. Dropped, and excluded from the digest, so upstream adding or
        # removing one never reads as drift.
        upstream_receipt.unlink()
        reporter.emit(
            Code.W_VENDOR_DROPPED_SOURCE_YAML,
            f"{op.name}: dropped the upstream {SOURCE_YAML}; this catalog writes its own",
            name=op.name,
        )
    digest = tree_digest(dest)
    write_provenance(
        dest,
        Provenance(
            type=VENDORED,
            source=op.source,
            upstream=op.repo,
            upstream_version=op.version,
            upstream_commit=op.commit,
            upstream_tree=op.tree,
            upstream_path=op.repo_path,
            extracted_at=now_stamp(),
            digest=digest,
            modified_locally=False,
        ),
    )


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StatusRow:
    name: str
    source: str
    state: str
    commit: str | None = None
    upstream_commit: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "source": self.source,
            "state": self.state,
            "commit": self.commit,
            "upstream_commit": self.upstream_commit,
        }


def check_vendor(
    catalog: Path,
    manifest: SourcesManifest,
    reporter: Reporter,
    *,
    reader: GitReader | None = None,
    checkouts: Mapping[str, Path] | None = None,
    select: Sequence[str] = (),
) -> list[StatusRow]:
    """Offline verification of what the catalog holds against what it records.

    Needs no source repository, no network and no receipt outside the catalog: the
    digest in each ``.source.yaml`` is recomputed against the directory beside it.
    That is the machine-2 story -- clone the catalog and check it -- and it is the
    reason the receipt is committed rather than kept in XDG state.

    Passing ``reader`` additionally re-resolves each source's version and reports a
    pin that has fallen behind. That half needs the checkouts and is opt-in.
    """
    rows: list[StatusRow] = []
    by_name = manifest.by_name()
    if select:
        unknown = [name for name in select if name not in by_name]
        if unknown:
            reporter.emit(
                Code.E_SOURCE_UNKNOWN,
                f"no source named {', '.join(repr(n) for n in unknown)} in {manifest.path}",
                fix=f"declared sources are: {', '.join(sorted(by_name)) or '(none)'}.",
            )
            return rows
        entries = [by_name[name] for name in select]
    else:
        entries = list(manifest.sources)

    for entry in entries:
        head: str | None = None
        if reader is not None:
            checkout = resolve_checkout(entry, overrides=checkouts)
            if checkout is not None and reader.is_repo(checkout):
                try:
                    head = reader.resolve_commit(checkout, entry.version)
                except SourceReadError:
                    head = None

        for name in _declared_names(entry, catalog):
            live = catalog / name
            if live.is_symlink() or not live.exists():
                reporter.emit(
                    Code.E_VENDOR_NOT_VENDORED,
                    f"{name}: declared by source {entry.name!r} but is "
                    f"{'a symlink' if live.is_symlink() else 'missing'} in the catalog",
                    name=name,
                    path=live,
                    fix="run `skillex vendor sync` to materialize it.",
                )
                rows.append(StatusRow(name, entry.name, "not-vendored"))
                continue
            prov = read_provenance(live)
            if prov is None or not prov.is_vendored:
                reporter.emit(
                    Code.W_VENDOR_UNRECORDED,
                    f"{name}: real content with no vendored provenance record",
                    name=name,
                    path=live,
                    fix="run `skillex vendor sync --adopt` to bring it under the pin.",
                )
                rows.append(StatusRow(name, entry.name, "unrecorded"))
                continue
            try:
                on_disk = tree_digest(live)
            except PayloadError as e:
                reporter.emit(
                    Code.W_VENDOR_UNRECORDED,
                    f"{name}: cannot be digested: {e}",
                    name=name,
                    path=live,
                )
                rows.append(StatusRow(name, entry.name, "unreadable"))
                continue
            state = "ok"
            if prov.digest and on_disk != prov.digest:
                reporter.emit(
                    Code.W_VENDOR_LOCAL_EDITS,
                    f"{name}: edited since it was vendored from "
                    f"{entry.name}@{(prov.upstream_commit or '?')[:8]}",
                    name=name,
                    path=live,
                    detail=(f"recorded {prov.digest}", f"on disk  {on_disk}"),
                    fix=f"push the edit to {entry.repo}, or re-vendor with --force.",
                )
                state = "modified"
            if head is not None and prov.upstream_commit and head != prov.upstream_commit:
                reporter.emit(
                    Code.W_VENDOR_PIN_STALE,
                    f"{name}: pinned at {prov.upstream_commit[:8]}, {entry.name}'s "
                    f"{entry.version} is now {head[:8]}",
                    name=name,
                    fix="run `skillex vendor sync` and commit the catalog.",
                )
                state = "stale" if state == "ok" else state
            rows.append(StatusRow(name, entry.name, state, head, prov.upstream_commit))
    return rows


def _declared_names(entry: SourceEntry, catalog: Path) -> list[str]:
    """Catalog names ``entry`` declares, without touching a repository.

    With an explicit ``skills`` list this is exact. With discovery it cannot be --
    the answer lives in the source repo, which ``check`` deliberately does not
    need -- so it falls back to whatever the catalog already attributes to this
    source, which is precisely the set whose integrity is being checked.
    """
    if entry.skills:
        return [skill.name for skill in entry.skills]
    names: list[str] = []
    if not catalog.is_dir():
        return names
    for child in sorted(catalog.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        prov = read_provenance(child)
        if prov is not None and prov.is_vendored and prov.source == entry.name:
            names.append(child.name)
    return names


# ---------------------------------------------------------------------------
# relink
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RelinkOp:
    link: Path
    old: str
    new: str
    name: str

    def as_dict(self) -> dict[str, object]:
        return {"link": str(self.link), "old": self.old, "new": self.new, "name": self.name}


def _catalog_index(catalog: Path) -> dict[tuple[str, ...], set[str]]:
    """Path suffixes that identify a vendored catalog entry.

    Built from each entry's recorded ``upstream_path`` (and its basename, and the
    catalog name itself), so a composition link that points straight into the
    source repository -- bypassing ``all-skills/`` entirely, which 22 of them do --
    can be mapped back to the name it should now use.
    """
    index: dict[tuple[str, ...], set[str]] = {}

    def add(key: str, name: str) -> None:
        parts = tuple(p for p in key.split("/") if p)
        if parts:
            index.setdefault(parts, set()).add(name)

    if not catalog.is_dir():
        return index
    for child in sorted(catalog.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        add(child.name, child.name)
        prov = read_provenance(child)
        if prov is not None and prov.is_vendored and prov.upstream_path:
            add(prov.upstream_path, child.name)
            add(prov.upstream_path.rsplit("/", 1)[-1], child.name)
    return index


def _match(index: Mapping[tuple[str, ...], set[str]], target: str) -> set[str] | None:
    """Longest path-suffix of ``target`` present in the index."""
    parts = tuple(p for p in target.split("/") if p and p != ".")
    for length in range(min(len(parts), 4), 0, -1):
        hit = index.get(parts[-length:])
        if hit:
            return hit
    return None


def plan_relink(roots: Iterable[Path], catalog: Path, reporter: Reporter) -> list[RelinkOp]:
    """Rewrite composition symlinks that point outside the catalog.

    Vendoring alone does not close the measured regression: 22 of the 25 links
    that dangle on a second machine never touch ``all-skills/`` at all -- they
    point straight at ``~/code/33GOD``. Making the catalog real heals 3 of them.
    This heals the rest.

    Targets are read LEXICALLY (``os.readlink`` + ``normpath``, never
    ``Path.resolve``), which is ``compositions.py``'s rule: resolving would walk
    the whole chain before you can test where it goes. The link NAME is always
    preserved -- ``sets/min-global/pjangler`` keeps the name ``pjangler`` while its
    body becomes ``../../all-skills/project-jangler``.
    """
    index = _catalog_index(catalog)
    ops: list[RelinkOp] = []
    catalog_real = os.path.realpath(catalog)

    for root in roots:
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            here = Path(dirpath)
            for entry_name in sorted(set(dirnames) | set(filenames)):
                link = here / entry_name
                if not link.is_symlink():
                    continue
                body = os.readlink(link).rstrip("/")
                absolute = os.path.normpath(
                    body if os.path.isabs(body) else os.path.join(dirpath, body)
                )
                if absolute == catalog_real or absolute.startswith(catalog_real + os.sep):
                    continue
                hit = _match(index, absolute)
                if hit is None:
                    reporter.emit(
                        Code.W_RELINK_NO_CATALOG_ENTRY,
                        f"{link.name}: points outside the catalog at {body} and no "
                        f"vendored entry claims it",
                        name=link.name,
                        path=link,
                        fix="vendor the skill it points at, or repoint the link by hand.",
                    )
                    continue
                if len(hit) > 1:
                    reporter.emit(
                        Code.E_RELINK_AMBIGUOUS,
                        f"{link.name}: {body} matches {', '.join(sorted(hit))}",
                        name=link.name,
                        path=link,
                        fix="repoint it by hand; two catalog entries claim the same path.",
                    )
                    continue
                name = next(iter(hit))
                new = os.path.relpath(catalog / name, here)
                if new == body:
                    continue
                ops.append(RelinkOp(link=link, old=body, new=new, name=name))
    ops.sort(key=lambda op: str(op.link))
    return ops


def apply_relink(ops: Sequence[RelinkOp], reporter: Reporter) -> None:
    """Repoint each link atomically: create a sibling temp link, then rename over."""
    for op in ops:
        tmp = op.link.with_name(f".{op.link.name}.{os.getpid()}.tmp")
        tmp.unlink(missing_ok=True)
        os.symlink(op.new, tmp)
        os.replace(tmp, op.link)
        reporter.emit(
            Code.I_VENDOR_RELINKED,
            f"{op.link.name}: {op.old} -> {op.new}",
            name=op.link.name,
            path=op.link,
        )


def report_unchanged(plan: VendorPlan, reporter: Reporter) -> None:
    for op in plan.ops:
        if op.action is VendorAction.UNCHANGED:
            reporter.emit(
                Code.I_VENDOR_UNCHANGED,
                f"{op.name}: already at {op.source}@{op.commit[:8]}",
                name=op.name,
            )


__all__ = [
    "CATALOG_DIRNAME",
    "LOCAL_CHECKOUTS_FILENAME",
    "SOURCES_FILENAME",
    "STAGE_DIRNAME",
    "WRITING_ACTIONS",
    "RelinkOp",
    "SourceResolution",
    "StatusRow",
    "VendorAction",
    "VendorOp",
    "VendorPlan",
    "apply_relink",
    "apply_vendor",
    "catalog_root",
    "check_vendor",
    "checkout_candidates",
    "config_dir",
    "load_local_checkouts",
    "local_checkouts_path",
    "normalize_repo",
    "plan_relink",
    "plan_vendor",
    "recover_stage",
    "report_unchanged",
    "resolve_checkout",
    "source_env_var",
    "stage_root",
    "tree_digest",
]
