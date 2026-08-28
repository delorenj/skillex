"""Reading a reference-only composition: `sets/<name>/`, and symlink-shaped packs.

**This walker is not** :func:`skillex.core.loader.flatten_inventory` **and must
never become it.** That function's ``_expand_container`` skips every symlink
unconditionally, which is correct for a pack (a pack's declared inventory is real
directories) and catastrophically wrong for a set: a set is *entirely* symlinks, so
``flatten_inventory(sets/min-global)`` returns **zero** skills. It is also frozen --
a live three-engine test pins it byte-for-byte against pjangler's
``expandPackInventory`` and ``sync-skills.py``'s ``flatten_pack_inventory``.

Three rules here are easy to get wrong and each is load-bearing:

**(a) The projected name is the LINK NAME, never the target's basename.**
``sets/min-global/momo -> 33GOD/momo/skill`` must project ``momo``; taking the
basename would publish a skill called ``skill``. Same for ``pjangler ->
project-jangler`` and ``33god-projects -> projects``.

**(b) Two names may share one target and both survive.** ``sets/global`` really
contains ``{33god-agent-fleet-operations, agent-fleet-operations}`` pointing at one
directory. Never deduplicate by realpath: ADR-0001 forbids two *targets* for one
*name*, not two *names* for one target.

**(c) One hop -- not zero, not all.** The binding target is the set link's own
target (``all-skills/hindsight``), never the set member path itself and never the
fully-resolved final directory. Zero hops would chain every projection through the
composition, so retargeting a set would silently rebind live activations; full
resolution would erase the canonical indirection that makes ``all-skills`` the one
place a skill's identity lives.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from skillex.core.diagnostics import Code, Finding, RefusalError, Reporter
from skillex.core.models import PROJECTION_NAME_PATTERN, is_safe_component

SKILL_FILENAME = "SKILL.md"

#: Entry-name prefixes never projected, at every depth.
#:
#: Kills ``.system/`` (six real Codex-managed skills plus a marker file) and
#: ``.lastagent``. This is why ``min-global`` projects 36 members and not 42. The
#: published schema's flatten prose does not mention hidden entries; it should.
EXCLUDED_PREFIXES = (".", "_")

#: Symlink hops followed before declaring a cycle. Real chains on this machine run
#: to three (``all-skills/33god-agent-fleet-operations -> 33GOD/skills/... ->
#: 33GOD/pjangler/skills/...``), so the budget is generous; exhausting it is, for
#: our purposes, indistinguishable from a loop.
MAX_SYMLINK_HOPS = 16


@dataclass(frozen=True)
class Member:
    """One resolvable member of a composition, before precedence is applied."""

    #: The PROJECTED name. Always the entry's own name in the composition.
    name: str
    #: Absolute, normalized, ONE HOP from the composition entry.
    target: Path
    #: The composition entry that was read, for ``--explain``.
    link_path: Path
    #: Every hop walked during validation, for ``--explain``. Never the target.
    chain: tuple[Path, ...]
    #: True when the target does not live under an ``all-skills/`` catalog.
    outside_catalog: bool
    #: True when the member is a real directory embedded in the composition
    #: (an ADR-0001 violation that is tolerated so today's tree stays syncable).
    embedded: bool = False


def lexical_link_target(base: Path, name: str) -> Path:
    """Absolute, normalized target of the symlink at ``base/name``. One hop.

    Normalization is not cosmetic: ``packs/Kurzgesagt/hindsight`` is written
    ``../../all-skills/hindsight/`` -- the one trailing-slash link in the tree --
    and without the strip every run would compare a stored target against a
    differently-spelled equal path, see a mismatch, and rewrite the link forever.

    Never :meth:`Path.resolve`. Resolving walks the whole chain *before* you can
    test where it goes, and on a dangling link ``resolve(strict=False)`` invents a
    plausible-looking path that does not exist.
    """
    raw = os.readlink(base / name).rstrip("/")
    joined = raw if os.path.isabs(raw) else os.path.join(base, raw)
    return Path(os.path.normpath(joined))


def resolve_chain(
    path: Path, max_hops: int = MAX_SYMLINK_HOPS
) -> tuple[tuple[Path, ...], Path | None]:
    """Walk a symlink chain. Returns ``(chain, final)``; ``final`` is None if broken.

    A validation and ``--explain`` device only -- its output is never written as a
    target (see rule (c) in the module docstring).

    :raises RefusalError: ``E_SYMLINK_CYCLE`` on a repeat or on budget exhaustion.
        :meth:`Path.resolve` surfaces this as a bare ``OSError(ELOOP)`` with no
        chain to show the user, which is why this is hand-rolled.
    """
    chain: list[Path] = [path]
    current = path
    for _ in range(max_hops):
        if not current.is_symlink():
            return (tuple(chain), current if current.exists() else None)
        raw = os.readlink(current).rstrip("/")
        joined = raw if os.path.isabs(raw) else os.path.join(current.parent, raw)
        nxt = Path(os.path.normpath(joined))
        if nxt in chain:
            raise RefusalError(
                Finding(
                    code=Code.E_SYMLINK_CYCLE,
                    message=f"symlink cycle at {path}",
                    path=path,
                    detail=tuple(f"-> {p}" for p in [*chain, nxt]),
                    fix="repair the link, or exclude the member from the set.",
                )
            )
        chain.append(nxt)
        current = nxt
    raise RefusalError(
        Finding(
            code=Code.E_SYMLINK_CYCLE,
            message=f"symlink chain at {path} exceeds {max_hops} hops",
            path=path,
            detail=tuple(f"-> {p}" for p in chain),
            fix="repair the link, or exclude the member from the set.",
        )
    )


def _is_catalog_target(target: Path) -> bool:
    return "all-skills" in target.parts


def walk_composition(
    comp_dir: Path,
    reporter: Reporter,
    *,
    label: str,
    allow_embedded: bool = True,
) -> list[Member]:
    """Every projectable member of a composition directory, sorted by name.

    Members that cannot resolve are **dropped here, before precedence runs**, and
    reported. That ordering is the difference between two live sets behaving and
    misbehaving: ``sets/delodocs/hindsight`` is dangling today while
    ``sets/global/hindsight`` is live, so under a naive positional overwrite with
    ``sets: ["global", "delodocs"]`` the *broken* link would win and a dangling
    symlink would land in the activation root. The rule is therefore **latest
    RESOLVABLE declaration wins**.
    """
    # The composition directory ITSELF may be a symlink -- verified,
    # `sets/hyperframes -> ~/code/hyperframes/skills`. Resolving the container once
    # and then treating its children lexically is what makes that shape yield 13
    # members instead of 0. `assert_real_dir` would reject it outright.
    base = comp_dir.resolve() if comp_dir.is_symlink() else comp_dir
    if not base.is_dir():
        return []

    out: list[Member] = []
    with os.scandir(base) as entries:
        children = sorted(entries, key=lambda e: e.name)

    for entry in children:
        name = entry.name
        if name.startswith(EXCLUDED_PREFIXES):
            continue

        if entry.is_file(follow_symlinks=False):
            if name == SKILL_FILENAME:
                # A composition holding its own SKILL.md is an ADR-0001 violation
                # (`sets/cloudflare-focused` and `sets/product-manager` both do),
                # but it is never a *member*: a set directory does not become
                # projectable just because someone dropped a hub skill in it.
                reporter.emit(
                    Code.W_SET_TOPLEVEL_FILE,
                    f"{label} contains its own {SKILL_FILENAME}",
                    path=base / name,
                    fix=f"move it into all-skills/ and symlink it back into {label}.",
                )
            continue

        if not is_safe_component(name):
            reporter.emit(
                Code.W_SET_MEMBER_UNSAFE_NAME,
                f"{label}: member name {name!r} is not one safe path component",
                name=name,
                path=base / name,
                fix="rename the entry.",
            )
            continue
        if not PROJECTION_NAME_PATTERN.match(name):
            reporter.emit(
                Code.W_SET_MEMBER_NONCANONICAL_NAME,
                f"{label}: member name {name!r} cannot be projected",
                name=name,
                path=base / name,
                detail=(f"must match {PROJECTION_NAME_PATTERN.pattern}",),
                fix="rename the entry to lowercase alphanumerics, '.', '-' or '_'.",
            )
            continue

        if entry.is_symlink():
            target = lexical_link_target(base, name)
            chain, final = resolve_chain(base / name)
            if final is None:
                reporter.emit(
                    Code.W_SET_MEMBER_DANGLING,
                    f"{label}: {name} points at nothing",
                    name=name,
                    path=base / name,
                    detail=(f"-> {os.readlink(base / name)}",),
                    fix="repair the link, or exclude the member.",
                )
                continue
            if not (final / SKILL_FILENAME).is_file():
                reporter.emit(
                    Code.W_TARGET_NO_SKILL_MD,
                    f"{label}: {name} resolves to a directory with no {SKILL_FILENAME}",
                    name=name,
                    path=final,
                    fix="point it at a real skill directory, or exclude the member.",
                )
                continue
            embedded = False
        elif entry.is_dir(follow_symlinks=False):
            child = Path(entry.path)
            if not (child / SKILL_FILENAME).is_file():
                # A container. Flattening a *set* is unsupported (see SetEntry), so
                # there is nothing to descend into; say so rather than silently
                # projecting a directory no CLI can read.
                reporter.emit(
                    Code.W_SET_CONTAINER_SKIPPED,
                    f"{label}: {name} is a container, not a skill",
                    name=name,
                    path=child,
                    fix="flatten is not supported for sets; declare the leaves directly.",
                )
                continue
            if not allow_embedded:
                reporter.emit(
                    Code.W_SET_EMBEDDED_DEFINITION,
                    f"{label}: {name} is a real skill directory inside a composition",
                    name=name,
                    path=child,
                    fix="move it into all-skills/ and symlink it back.",
                )
                continue
            # WARN AND PROJECT. Verified: sets/n8n is 14/14 real directories,
            # sets/hyperframes 13/13, sets/delodocs 5. Refusing would make three of
            # seven live sets unsyncable, and `topology check` is already the
            # enforcer for this rule. --strict turns the warning into an error.
            reporter.emit(
                Code.W_SET_EMBEDDED_DEFINITION,
                f"{label}: {name} is a real skill directory inside a composition",
                name=name,
                path=child,
                fix="move it into all-skills/ and symlink it back; --strict makes this an error.",
            )
            target, chain, embedded = child, (child,), True
        else:
            continue

        member = Member(
            name=name,
            target=target,
            link_path=base / name,
            chain=chain,
            outside_catalog=not _is_catalog_target(target),
            embedded=embedded,
        )
        if member.outside_catalog and not embedded:
            reporter.emit(
                Code.W_SET_LINK_OUTSIDE_CATALOG,
                f"{label}: {name} resolves outside all-skills/",
                name=name,
                path=target,
                fix="import it into all-skills/ and repoint the set; --strict makes this an error.",
            )
        out.append(member)
    return out


__all__ = [
    "EXCLUDED_PREFIXES",
    "MAX_SYMLINK_HOPS",
    "SKILL_FILENAME",
    "Member",
    "lexical_link_target",
    "resolve_chain",
    "walk_composition",
]
