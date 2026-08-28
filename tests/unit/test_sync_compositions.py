"""The composition walker: :mod:`skillex.core.compositions`.

Every test here pins one of the three rules the module docstring calls
load-bearing:

**(a)** the projected name is the LINK NAME, never the target's basename;
**(b)** two names may share one target and both survive;
**(c)** the binding target is ONE hop from the composition entry.

Fixture shapes are the live ones measured on the author's machine --
``sets/min-global``'s ``.system/`` + ``.lastagent``, ``sets/hyperframes``'s
symlinked set directory, ``sets/n8n``'s embedded real directories,
``sets/delodocs``'s dangling members, ``sets/cloudflare-focused``'s top-level
``SKILL.md`` -- built programmatically, never committed.
"""

from __future__ import annotations

import os
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from skillex.core.compositions import (
    EXCLUDED_PREFIXES,
    MAX_SYMLINK_HOPS,
    Member,
    lexical_link_target,
    resolve_chain,
    walk_composition,
)
from skillex.core.diagnostics import Code, RefusalError, Reporter
from tests.conftest import Sandbox

# ---------------------------------------------------------------------------
# local helpers
# ---------------------------------------------------------------------------


def walk(comp_dir: Path, *, label: str = "set 'fixture'", allow_embedded: bool = True):
    """``walk_composition`` with a fresh reporter. Returns ``(members, reporter)``."""
    reporter = Reporter()
    members = walk_composition(comp_dir, reporter, label=label, allow_embedded=allow_embedded)
    return members, reporter


def codes(reporter: Reporter) -> list[Code]:
    """Every emitted code, in emission order. Assert on enum members, not text."""
    return [f.code for f in reporter.findings]


def names(members: list[Member]) -> list[str]:
    return [m.name for m in members]


def by_name(members: list[Member]) -> dict[str, Member]:
    return {m.name: m for m in members}


def findings_for(reporter: Reporter, code: Code):
    return [f for f in reporter.findings if f.code is code]


# ===========================================================================
# (a) THE PROJECTED NAME IS THE LINK NAME -- the single most important rule
# ===========================================================================


def test_projected_name_is_the_link_name_never_the_targets_basename(
    registry: Path,
    write_skill,
    write_catalog,
    write_set,
) -> None:
    """``momo -> .../momo/skill`` projects ``momo``, NOT ``skill``.

    Taking ``target.name`` would publish three skills called ``skill``,
    ``project-jangler`` and ``projects``. All three live renames are here:
    ``momo -> 33GOD/momo/skill``, ``pjangler -> all-skills/project-jangler``,
    ``33god-projects -> all-skills/projects``.
    """
    catalog = write_catalog(registry, "project-jangler", "projects")
    # all-skills/momo/skill/SKILL.md -- the target's basename is "skill".
    momo_target = write_skill(registry / "all-skills" / "momo", "skill")

    set_dir = write_set(
        registry,
        "min-global",
        [
            ("link", "momo", momo_target),
            ("link", "pjangler", catalog["project-jangler"]),
            ("link", "33god-projects", catalog["projects"]),
        ],
    )

    members, reporter = walk(set_dir)

    assert names(members) == ["33god-projects", "momo", "pjangler"]
    # ...and every one of those names differs from its target's basename.
    assert [m.target.name for m in members] == ["projects", "skill", "project-jangler"]
    for member in members:
        assert member.name != member.target.name
    assert codes(reporter) == []


def test_link_name_wins_on_disk_end_to_end(
    sandbox: Sandbox,
    registry: Path,
    write_skill,
    write_set,
    run_sync_json,
) -> None:
    """The same rule, asserted against the activation root's actual inodes."""
    momo_target = write_skill(registry / "all-skills" / "momo", "skill")
    write_set(registry, "min-global", [("link", "momo", momo_target)])
    sandbox.write_global_manifest(sets=["min-global"])

    cwd = sandbox.project("no-manifest", manifest=None)
    code, payload = run_sync_json(cwd=cwd)

    assert code == 0, payload
    projected = sandbox.global_root / "momo"
    assert projected.is_symlink()
    assert Path(os.readlink(projected)) == momo_target
    # The basename name was never created.
    assert not (sandbox.global_root / "skill").exists()
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == ["momo"]


# ===========================================================================
# (b) two names, one target
# ===========================================================================


def test_two_names_one_target_both_survive(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """``sets/global`` really holds ``33god-projects`` and ``projects`` on one dir.

    ADR-0001 forbids two *targets* for one *name*, not two *names* for one
    target. Deduplicating by realpath here would silently drop one of them.
    """
    catalog = write_catalog(registry, "projects")
    set_dir = write_set(
        registry,
        "global",
        [
            ("link", "33god-projects", catalog["projects"]),
            ("link", "projects", catalog["projects"]),
        ],
    )

    members, reporter = walk(set_dir, label="set 'global'")

    assert names(members) == ["33god-projects", "projects"]
    assert {m.target for m in members} == {catalog["projects"]}
    assert codes(reporter) == []


def test_two_names_one_target_both_land_on_disk(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_set,
    run_sync_json,
) -> None:
    catalog = write_catalog(registry, "projects")
    write_set(
        registry,
        "global",
        [
            ("link", "33god-projects", catalog["projects"]),
            ("link", "projects", catalog["projects"]),
        ],
    )
    sandbox.write_global_manifest(sets=["global"])

    code, payload = run_sync_json(cwd=sandbox.project("no-manifest", manifest=None))

    assert code == 0, payload
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == [
        "33god-projects",
        "projects",
    ]
    for name in ("33god-projects", "projects"):
        link = sandbox.global_root / name
        assert link.is_symlink()
        assert Path(os.readlink(link)) == catalog["projects"]


# ===========================================================================
# EXCLUDED_PREFIXES
# ===========================================================================


def test_dot_and_underscore_entries_are_never_members(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """The ``min-global`` arithmetic: 3 links + ``.system/`` + ``.lastagent`` -> 3.

    ``.system/`` holds six real nested skill dirs and is still not descended
    into; ``.lastagent`` is a plain file. Neither is a member, and neither
    produces a finding -- hidden entries are *expected*, not anomalous.
    """
    catalog = write_catalog(registry, "hindsight", "momo", "pjangler")
    set_dir = write_set(
        registry,
        "min-global",
        [
            ("link", "hindsight", catalog["hindsight"]),
            ("link", "momo", catalog["momo"]),
            ("link", "pjangler", catalog["pjangler"]),
            ("container", ".system", ["a", "b", "c", "d", "e", "f"]),
            ("file", ".lastagent", "claude\n"),
            ("realdir", "_scratch"),
            ("link", "_hidden-link", catalog["hindsight"]),
        ],
    )

    members, reporter = walk(set_dir, label="set 'min-global'")

    assert names(members) == ["hindsight", "momo", "pjangler"]
    assert codes(reporter) == []
    # The six nested skills exist and were simply not walked.
    assert len(list((set_dir / ".system").iterdir())) == 6


def test_excluded_prefixes_are_dot_and_underscore() -> None:
    assert EXCLUDED_PREFIXES == (".", "_")


# ===========================================================================
# top-level SKILL.md
# ===========================================================================


def test_toplevel_skill_md_is_not_a_member(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """``sets/cloudflare-focused`` holds its own hub ``SKILL.md``.

    That makes the set directory look like a skill; it is still not a member,
    and the violation is reported rather than silently tolerated.
    """
    catalog = write_catalog(registry, "cf")
    set_dir = write_set(
        registry,
        "cloudflare-focused",
        [
            ("file", "SKILL.md", "# cloudflare hub\n"),
            ("link", "cf", catalog["cf"]),
        ],
    )

    members, reporter = walk(set_dir, label="set 'cloudflare-focused'")

    assert names(members) == ["cf"]
    assert codes(reporter) == [Code.W_SET_TOPLEVEL_FILE]
    assert findings_for(reporter, Code.W_SET_TOPLEVEL_FILE)[0].path == set_dir / "SKILL.md"


def test_other_toplevel_files_are_silently_ignored(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """Only ``SKILL.md`` earns a finding; ``README.md`` is just a file."""
    catalog = write_catalog(registry, "cf")
    set_dir = write_set(
        registry,
        "docs",
        [("file", "README.md", "# notes\n"), ("link", "cf", catalog["cf"])],
    )

    members, reporter = walk(set_dir)

    assert names(members) == ["cf"]
    assert codes(reporter) == []


# ===========================================================================
# the set directory itself is a symlink (sets/hyperframes)
# ===========================================================================


def test_symlinked_set_directory_still_yields_members(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """``sets/hyperframes -> ~/code/hyperframes/skills``.

    Resolving the CONTAINER once and then reading its children lexically is
    what makes this shape yield members instead of zero; ``assert_real_dir``
    on the set path would reject it outright.
    """
    catalog = write_catalog(registry, "hf-a", "hf-b", "hf-c")
    body = sandbox.tmp / "other-repo" / "skills"
    set_dir = write_set(
        registry,
        "hyperframes",
        [
            ("link", "hf-a", catalog["hf-a"]),
            ("link", "hf-b", catalog["hf-b"]),
            ("link", "hf-c", catalog["hf-c"]),
        ],
        as_symlink_to=body,
    )

    assert set_dir.is_symlink()
    members, reporter = walk(set_dir, label="set 'hyperframes'")

    assert len(members) > 0
    assert names(members) == ["hf-a", "hf-b", "hf-c"]
    assert codes(reporter) == []
    # link_path is rooted at the RESOLVED container, not the sets/ alias.
    assert by_name(members)["hf-a"].link_path == body.resolve() / "hf-a"


def test_symlinked_set_directory_pointing_at_nothing_yields_no_members(
    sandbox: Sandbox,
    registry: Path,
) -> None:
    """A dangling set directory is empty, not a crash."""
    sets_dir = registry / "sets"
    sets_dir.mkdir(parents=True, exist_ok=True)
    set_dir = sets_dir / "gone"
    os.symlink(str(sandbox.tmp / "nowhere" / "skills"), set_dir)

    members, reporter = walk(set_dir)

    assert members == []
    assert codes(reporter) == []


def test_missing_composition_directory_yields_no_members(registry: Path) -> None:
    members, reporter = walk(registry / "sets" / "never-created")

    assert members == []
    assert codes(reporter) == []


# ===========================================================================
# embedded real directories (sets/n8n) and containers (.system-shaped)
# ===========================================================================


def test_embedded_real_skill_dir_projects_with_a_warning(
    registry: Path,
    write_set,
) -> None:
    """``sets/n8n`` is 14/14 real directories. Warn and project -- never refuse."""
    set_dir = write_set(
        registry,
        "n8n",
        [("realdir", "n8n-a"), ("realdir", "n8n-b")],
    )

    members, reporter = walk(set_dir, label="set 'n8n'")

    assert names(members) == ["n8n-a", "n8n-b"]
    assert codes(reporter) == [
        Code.W_SET_EMBEDDED_DEFINITION,
        Code.W_SET_EMBEDDED_DEFINITION,
    ]
    embedded = by_name(members)["n8n-a"]
    assert embedded.embedded is True
    assert embedded.target == set_dir / "n8n-a"
    assert embedded.chain == (set_dir / "n8n-a",)


def test_embedded_definition_does_not_also_warn_outside_catalog(
    registry: Path,
    write_set,
) -> None:
    """An embedded dir is by construction outside ``all-skills/``.

    Emitting both codes would double-report one violation, so the outside-catalog
    warning is suppressed for embedded members even though the flag is set.
    """
    set_dir = write_set(registry, "n8n", [("realdir", "n8n-a")])

    members, reporter = walk(set_dir, label="set 'n8n'")

    assert by_name(members)["n8n-a"].outside_catalog is True
    assert Code.W_SET_LINK_OUTSIDE_CATALOG not in codes(reporter)


def test_embedded_real_skill_dir_is_dropped_when_not_allowed(
    registry: Path,
    write_set,
) -> None:
    set_dir = write_set(registry, "n8n", [("realdir", "n8n-a")])

    members, reporter = walk(set_dir, label="set 'n8n'", allow_embedded=False)

    assert members == []
    assert codes(reporter) == [Code.W_SET_EMBEDDED_DEFINITION]


def test_real_dir_without_skill_md_is_a_container_and_is_skipped(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """Flattening a *set* is unsupported, so a container has nothing to descend into."""
    catalog = write_catalog(registry, "keep")
    set_dir = write_set(
        registry,
        "delodocs",
        [
            ("container", "bundle", ["leaf-a", "leaf-b"]),
            ("link", "keep", catalog["keep"]),
        ],
    )

    members, reporter = walk(set_dir, label="set 'delodocs'")

    assert names(members) == ["keep"]
    assert codes(reporter) == [Code.W_SET_CONTAINER_SKIPPED]
    finding = findings_for(reporter, Code.W_SET_CONTAINER_SKIPPED)[0]
    assert finding.name == "bundle"
    assert finding.path == set_dir / "bundle"
    # The leaves are NOT projected under their own names either.
    assert "leaf-a" not in names(members)


# ===========================================================================
# unresolvable members are dropped BEFORE precedence runs
# ===========================================================================


def test_dangling_member_is_dropped_and_reported(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """``sets/delodocs/hindsight`` is dangling while ``sets/global/hindsight`` is live.

    Dropping here, before precedence, is what stops "latest declaration wins"
    from letting the broken link beat the working one.
    """
    catalog = write_catalog(registry, "live")
    set_dir = write_set(
        registry,
        "delodocs",
        [
            ("dangling", "hindsight", registry / "all-skills" / "gone"),
            ("link", "live", catalog["live"]),
        ],
    )

    members, reporter = walk(set_dir, label="set 'delodocs'")

    assert names(members) == ["live"]
    assert codes(reporter) == [Code.W_SET_MEMBER_DANGLING]
    finding = findings_for(reporter, Code.W_SET_MEMBER_DANGLING)[0]
    assert finding.name == "hindsight"
    assert finding.path == set_dir / "hindsight"
    # The dangling link is still on disk; it was skipped, not repaired.
    assert (set_dir / "hindsight").is_symlink()
    assert not (set_dir / "hindsight").exists()


def test_link_to_a_directory_without_skill_md_is_dropped(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """The link resolves, the directory exists -- and no CLI could read it."""
    catalog = write_catalog(registry, "good")
    hollow = sandbox.tmp / "hollow"
    hollow.mkdir()
    (hollow / "README.md").write_text("no SKILL.md here\n", encoding="utf-8")

    set_dir = write_set(
        registry,
        "mixed",
        [("link", "good", catalog["good"]), ("link", "hollow", hollow)],
    )

    members, reporter = walk(set_dir)

    assert names(members) == ["good"]
    assert codes(reporter) == [Code.W_TARGET_NO_SKILL_MD]
    finding = findings_for(reporter, Code.W_TARGET_NO_SKILL_MD)[0]
    assert finding.name == "hollow"
    # `path` is the RESOLVED target, so the message points at the real problem.
    assert finding.path == hollow


def test_link_to_a_plain_file_is_dropped(
    sandbox: Sandbox,
    registry: Path,
    write_set,
) -> None:
    loose = sandbox.tmp / "loose.md"
    loose.write_text("# not a skill dir\n", encoding="utf-8")
    set_dir = write_set(registry, "mixed", [("link", "loose", loose)])

    members, reporter = walk(set_dir)

    assert members == []
    assert codes(reporter) == [Code.W_TARGET_NO_SKILL_MD]


# ===========================================================================
# outside the catalog
# ===========================================================================


def test_target_outside_all_skills_is_projected_with_a_warning(
    sandbox: Sandbox,
    registry: Path,
    write_skill,
    write_catalog,
    write_set,
) -> None:
    """10 of ``min-global``'s 36 members resolve outside ``all-skills/``.

    Refusing would make the set unsyncable; the member is projected and the
    topology violation is reported (``--strict`` promotes it).
    """
    catalog = write_catalog(registry, "inside")
    outside = write_skill(sandbox.tmp / "other-repo" / "skills", "outside")
    set_dir = write_set(
        registry,
        "min-global",
        [("link", "inside", catalog["inside"]), ("link", "outside", outside)],
    )

    members, reporter = walk(set_dir, label="set 'min-global'")

    assert names(members) == ["inside", "outside"]
    assert by_name(members)["outside"].outside_catalog is True
    assert by_name(members)["inside"].outside_catalog is False
    assert codes(reporter) == [Code.W_SET_LINK_OUTSIDE_CATALOG]
    finding = findings_for(reporter, Code.W_SET_LINK_OUTSIDE_CATALOG)[0]
    assert finding.name == "outside"
    assert finding.path == outside


def test_one_finding_per_offending_name_not_one_per_code(
    sandbox: Sandbox,
    registry: Path,
    write_skill,
    write_set,
) -> None:
    """The reporter is a list, not a set: 3 out-of-catalog links = 3 findings."""
    external = sandbox.tmp / "other-repo" / "skills"
    members_spec = [("link", n, write_skill(external, n)) for n in ("a", "b", "c")]
    set_dir = write_set(registry, "min-global", members_spec)

    members, reporter = walk(set_dir)

    assert names(members) == ["a", "b", "c"]
    assert codes(reporter) == [Code.W_SET_LINK_OUTSIDE_CATALOG] * 3
    assert [f.name for f in reporter.findings] == ["a", "b", "c"]


# ===========================================================================
# (c) lexical_link_target -- ONE hop, normalized, never resolve()
# ===========================================================================


def test_lexical_link_target_follows_exactly_one_hop(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """member -> a -> b. The target is ``a``, never ``b``.

    Zero hops would chain every projection through the composition (retargeting
    a set would silently rebind live activations); full resolution would erase
    the ``all-skills`` indirection that is a skill's canonical identity.
    """
    catalog = write_catalog(registry, "b")
    # all-skills/a -> all-skills/b
    a = registry / "all-skills" / "a"
    os.symlink(str(catalog["b"]), a)

    set_dir = write_set(registry, "hop", [("link", "member", a)])

    assert lexical_link_target(set_dir, "member") == a
    assert lexical_link_target(set_dir, "member") != catalog["b"]

    members, _ = walk(set_dir)
    member = by_name(members)["member"]
    assert member.target == a
    # ...while the chain records every hop, for --explain.
    assert member.chain == (set_dir / "member", a, catalog["b"])


def test_lexical_link_target_strips_a_trailing_slash(
    registry: Path,
    write_catalog,
    write_pack,
) -> None:
    """``packs/Kurzgesagt/hindsight -> ../../all-skills/hindsight/``.

    Without the strip the stored target and the recomputed one would be
    differently-spelled equal paths, so every run would see a mismatch and
    rewrite the link forever.
    """
    catalog = write_catalog(registry, "hindsight")
    pack_dir = write_pack(
        registry,
        "Kurzgesagt",
        pack_toml=False,
        members=[("link", "hindsight", "../../all-skills/hindsight/")],
    )

    raw = os.readlink(pack_dir / "hindsight")
    assert raw.endswith("/"), "the fixture must reproduce the trailing slash verbatim"

    target = lexical_link_target(pack_dir, "hindsight")
    assert target == catalog["hindsight"]
    assert not str(target).endswith("/")
    assert target.is_absolute()

    members, _ = walk(pack_dir, label="pack 'Kurzgesagt'")
    assert by_name(members)["hindsight"].target == catalog["hindsight"]


def test_lexical_link_target_resolves_a_relative_link_body(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    catalog = write_catalog(registry, "hindsight", "momo")
    set_dir = write_set(
        registry,
        "relative",
        [
            ("link", "hindsight", catalog["hindsight"]),
            ("link", "momo", catalog["momo"]),
        ],
        relative_links=True,
    )

    assert not os.path.isabs(os.readlink(set_dir / "hindsight"))
    assert lexical_link_target(set_dir, "hindsight") == catalog["hindsight"]
    assert lexical_link_target(set_dir, "hindsight").is_absolute()
    # No `..` survives normalization.
    assert ".." not in lexical_link_target(set_dir, "momo").parts

    members, reporter = walk(set_dir)
    assert [m.target for m in members] == [catalog["hindsight"], catalog["momo"]]
    assert codes(reporter) == []


def test_lexical_link_target_never_invents_a_path_for_a_dangling_link(
    registry: Path,
    write_set,
) -> None:
    """``resolve(strict=False)`` would hand back a plausible-looking nonexistent path."""
    ghost = registry / "all-skills" / "ghost"
    set_dir = write_set(registry, "delodocs", [("dangling", "ghost", ghost)])

    assert lexical_link_target(set_dir, "ghost") == ghost
    assert not ghost.exists()


# ===========================================================================
# resolve_chain
# ===========================================================================


def test_resolve_chain_walks_three_hops(
    registry: Path,
    write_catalog,
) -> None:
    catalog = write_catalog(registry, "final")
    base = registry / "all-skills"
    os.symlink(str(catalog["final"]), base / "hop2")
    os.symlink(str(base / "hop2"), base / "hop1")
    os.symlink(str(base / "hop1"), base / "hop0")

    chain, final = resolve_chain(base / "hop0")

    assert final == catalog["final"]
    assert chain == (
        base / "hop0",
        base / "hop1",
        base / "hop2",
        catalog["final"],
    )


def test_resolve_chain_reports_a_broken_chain_as_none(registry: Path) -> None:
    base = registry / "all-skills"
    os.symlink(str(base / "nowhere"), base / "hop1")
    os.symlink(str(base / "hop1"), base / "hop0")

    chain, final = resolve_chain(base / "hop0")

    assert final is None
    assert chain == (base / "hop0", base / "hop1", base / "nowhere")


def test_resolve_chain_refuses_a_two_node_cycle(registry: Path) -> None:
    """``Path.resolve`` raises a bare ``OSError(ELOOP)`` with no chain to show."""
    base = registry / "all-skills"
    os.symlink(str(base / "b"), base / "a")
    os.symlink(str(base / "a"), base / "b")

    with pytest.raises(RefusalError) as excinfo:
        resolve_chain(base / "a")

    finding = excinfo.value.finding
    assert finding.code is Code.E_SYMLINK_CYCLE
    assert finding.path == base / "a"
    assert finding.detail == (
        f"-> {base / 'a'}",
        f"-> {base / 'b'}",
        f"-> {base / 'a'}",
    )
    assert finding.fix is not None


def test_resolve_chain_refuses_a_self_link(registry: Path) -> None:
    base = registry / "all-skills"
    os.symlink(str(base / "ouroboros"), base / "ouroboros")

    with pytest.raises(RefusalError) as excinfo:
        resolve_chain(base / "ouroboros")

    finding = excinfo.value.finding
    assert finding.code is Code.E_SYMLINK_CYCLE
    assert finding.detail == (
        f"-> {base / 'ouroboros'}",
        f"-> {base / 'ouroboros'}",
    )


def test_resolve_chain_refuses_when_the_hop_budget_is_exhausted(
    registry: Path,
    write_catalog,
) -> None:
    """An acyclic chain longer than the budget is indistinguishable from a loop."""
    catalog = write_catalog(registry, "final")
    base = registry / "all-skills"
    previous = catalog["final"]
    for index in range(6):
        link = base / f"hop{index}"
        os.symlink(str(previous), link)
        previous = link

    # The full budget resolves it...
    _, final = resolve_chain(previous)
    assert final == catalog["final"]

    # ...a small one refuses, and shows exactly the hops it walked.
    with pytest.raises(RefusalError) as excinfo:
        resolve_chain(previous, max_hops=2)

    finding = excinfo.value.finding
    assert finding.code is Code.E_SYMLINK_CYCLE
    assert len(finding.detail) == 3  # the start plus two walked hops
    assert "exceeds 2 hops" in finding.message


def test_max_symlink_hops_is_generous_enough_for_the_live_tree() -> None:
    """Real chains on this machine run to three; the budget is 16."""
    assert MAX_SYMLINK_HOPS >= 3


def test_walk_composition_propagates_a_cycle_refusal(
    registry: Path,
    write_set,
) -> None:
    base = registry / "all-skills"
    os.symlink(str(base / "b"), base / "a")
    os.symlink(str(base / "a"), base / "b")
    set_dir = write_set(registry, "looped", [("link", "looped", base / "a")])

    with pytest.raises(RefusalError) as excinfo:
        walk(set_dir)

    assert excinfo.value.finding.code is Code.E_SYMLINK_CYCLE


# ===========================================================================
# member names
# ===========================================================================


def test_unsafe_member_name_is_skipped(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """A name with surrounding whitespace is not one safe path component."""
    catalog = write_catalog(registry, "ok")
    set_dir = write_set(
        registry,
        "odd",
        [
            ("link", "ok", catalog["ok"]),
            ("link", "trailing ", catalog["ok"]),
        ],
    )

    members, reporter = walk(set_dir)

    assert names(members) == ["ok"]
    assert codes(reporter) == [Code.W_SET_MEMBER_UNSAFE_NAME]
    assert findings_for(reporter, Code.W_SET_MEMBER_UNSAFE_NAME)[0].name == "trailing "


@pytest.mark.parametrize("bad", ["Uppercase", "-leading-dash", "trailing-dash-"])
def test_noncanonical_member_name_is_skipped(
    bad: str,
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """Safe as a path component, but not a name a skill may be PROJECTED under."""
    catalog = write_catalog(registry, "ok")
    set_dir = write_set(
        registry,
        "odd",
        [("link", "ok", catalog["ok"]), ("link", bad, catalog["ok"])],
    )

    members, reporter = walk(set_dir)

    assert names(members) == ["ok"]
    assert codes(reporter) == [Code.W_SET_MEMBER_NONCANONICAL_NAME]
    finding = findings_for(reporter, Code.W_SET_MEMBER_NONCANONICAL_NAME)[0]
    assert finding.name == bad
    assert finding.path == set_dir / bad


@pytest.mark.parametrize("good", ["33god-projects", "n8n", "a.b_c-d", "x"])
def test_canonical_member_names_survive(
    good: str,
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """A name that validates in a manifest must project -- dots and underscores included."""
    catalog = write_catalog(registry, "target")
    set_dir = write_set(registry, "odd", [("link", good, catalog["target"])])

    members, reporter = walk(set_dir)

    assert names(members) == [good]
    assert codes(reporter) == []


def test_a_bad_name_is_reported_once_and_never_resolved(
    registry: Path,
    write_set,
) -> None:
    """The name gate runs BEFORE the link is followed: one finding, not two."""
    set_dir = write_set(
        registry,
        "odd",
        [("dangling", "Uppercase", registry / "all-skills" / "gone")],
    )

    members, reporter = walk(set_dir)

    assert members == []
    assert codes(reporter) == [Code.W_SET_MEMBER_NONCANONICAL_NAME]


# ===========================================================================
# determinism
# ===========================================================================


def test_output_is_sorted_by_name_regardless_of_creation_order(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """Two runs over the same shape must produce byte-identical projections."""
    wanted = ["zulu", "alpha", "mike", "33god-projects", "n8n", "bravo"]
    catalog = write_catalog(registry, *wanted)
    set_dir = write_set(registry, "shuffled", [("link", n, catalog[n]) for n in wanted])

    members, reporter = walk(set_dir)

    assert names(members) == sorted(wanted)
    assert codes(reporter) == []
    # And a second walk agrees, entry for entry.
    again, _ = walk(set_dir)
    assert [(m.name, m.target) for m in again] == [(m.name, m.target) for m in members]


def test_findings_are_emitted_in_name_order_too(
    sandbox: Sandbox,
    registry: Path,
    write_skill,
    write_set,
) -> None:
    external = sandbox.tmp / "other-repo" / "skills"
    write_skill(external, "zeta")
    set_dir = write_set(
        registry,
        "mixed",
        [
            ("link", "zeta", external / "zeta"),
            ("dangling", "alpha", registry / "all-skills" / "gone"),
            ("container", "mike", ["leaf"]),
        ],
    )

    members, reporter = walk(set_dir)

    assert names(members) == ["zeta"]
    assert codes(reporter) == [
        Code.W_SET_MEMBER_DANGLING,  # alpha
        Code.W_SET_CONTAINER_SKIPPED,  # mike
        Code.W_SET_LINK_OUTSIDE_CATALOG,  # zeta
    ]
    assert [f.name for f in reporter.findings] == ["alpha", "mike", "zeta"]


# ===========================================================================
# the live shapes, at their real arithmetic
# ===========================================================================


def test_min_global_projects_36_of_42_entries(
    sandbox: Sandbox,
    registry: Path,
    write_skill,
    write_catalog,
    write_set,
) -> None:
    """The headline count: 42 entries on disk, 36 members, 10 outside the catalog.

    The six-entry difference is entirely :data:`EXCLUDED_PREFIXES` -- six
    top-level hidden entries, one of which (``.system/``) is a real directory
    holding six more skills that are never descended into.
    """
    inside_names = [f"skill-{i:02d}" for i in range(26)]
    outside_names = [f"ext-{i:02d}" for i in range(10)]
    catalog = write_catalog(registry, *inside_names)
    external = sandbox.tmp / "other-repo" / "skills"
    outside = {n: write_skill(external, n) for n in outside_names}

    specs = [("link", n, catalog[n]) for n in inside_names]
    specs += [("link", n, outside[n]) for n in outside_names]
    specs += [
        ("container", ".system", ["c1", "c2", "c3", "c4", "c5", "c6"]),
        ("file", ".lastagent", "claude\n"),
        ("file", ".gitignore", "*\n"),
        ("file", ".stignore", "*\n"),
        ("realdir", "_staging"),
        ("container", "_drafts", ["d1"]),
    ]
    set_dir = write_set(registry, "min-global", specs)

    assert len(list(os.scandir(set_dir))) == 42
    members, reporter = walk(set_dir, label="set 'min-global'")

    assert len(members) == 36
    assert names(members) == sorted(inside_names + outside_names)
    assert sum(m.outside_catalog for m in members) == 10
    assert codes(reporter) == [Code.W_SET_LINK_OUTSIDE_CATALOG] * 10


def test_delodocs_shape_dangling_and_embedded_together(
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    """``sets/delodocs``: 10 links of which 2 dangle, plus 5 real dirs -> 13 members."""
    link_names = [f"doc-{i:02d}" for i in range(8)]
    catalog = write_catalog(registry, *link_names)
    real_names = [f"real-{i}" for i in range(5)]

    specs = [("link", n, catalog[n]) for n in link_names]
    specs += [
        ("dangling", "hindsight", registry / "all-skills" / "gone"),
        ("dangling", "ghost", registry / "all-skills" / "nope"),
    ]
    specs += [("realdir", n) for n in real_names]
    set_dir = write_set(registry, "delodocs", specs)

    members, reporter = walk(set_dir, label="set 'delodocs'")

    assert len(members) == 13
    assert names(members) == sorted(link_names + real_names)
    assert [m.name for m in members if m.embedded] == sorted(real_names)
    assert codes(reporter).count(Code.W_SET_MEMBER_DANGLING) == 2
    assert codes(reporter).count(Code.W_SET_EMBEDDED_DEFINITION) == 5
    assert Code.W_SET_LINK_OUTSIDE_CATALOG not in codes(reporter)
    # The dangling `hindsight` never becomes a member, so a later-declared
    # working `hindsight` cannot lose to it under "latest declaration wins".
    assert "hindsight" not in names(members)


# ===========================================================================
# Member is a value object
# ===========================================================================


def test_member_is_frozen(registry: Path, write_catalog, write_set) -> None:
    catalog = write_catalog(registry, "ok")
    set_dir = write_set(registry, "odd", [("link", "ok", catalog["ok"])])
    member = walk(set_dir)[0][0]

    with pytest.raises(FrozenInstanceError):
        member.name = "other"  # type: ignore[misc]

    assert member.link_path == set_dir / "ok"
    assert member.chain[0] == set_dir / "ok"
    assert member.chain[-1] == catalog["ok"]
