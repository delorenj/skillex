"""Precedence, pack expansion and manifest guards: ``skillex.core.resolver``.

This module owns acceptance criteria 1-5. The law under test is stated in the
resolver's own docstring and is deliberately *one* rule -- positional overwrite
over a single ordered sequence of passes:

    pack (short-circuits everything)
      else:  inherited global  ->  sets in array order  ->  skills in array order

So every "X wins" assertion here is really an assertion about *pass order*, never
about alphabetical order, JSON key order, or which entry looks more specific.

Most tests call :func:`compose` directly because that is where the law lives.
Where the criterion is about *what ends up on disk* -- AC 4 and AC 5 -- the test
runs the real CLI and reads the symlink back with ``os.readlink``, because a plan
that says the right thing and an ``apply()`` that writes the wrong thing are
indistinguishable from the plan alone.
"""

from __future__ import annotations

import json
import os
from collections import OrderedDict
from pathlib import Path

import pytest

from skillex.core.diagnostics import Code, RefusalError, Reporter, Severity
from skillex.core.loader import load_skills_manifest
from skillex.core.models import (
    PackEntry,
    SetEntry,
    SkillEntry,
    UnsupportedFieldError,
)
from skillex.core.resolver import (
    Binding,
    Desired,
    alias_mode_eligible,
    compose,
    resolve_skill_entry,
)
from skillex.core.scope import Scope, global_scope, project_scope
from skillex.paths import registry_roots
from tests.conftest import Sandbox, write_manifest

# ---------------------------------------------------------------------------
# local helpers
#
# Deliberately thin: everything filesystem-shaped comes from tests/conftest.py.
# These only spare each test the four-line manifest -> load -> scope -> compose
# incantation, and hand back the Reporter so findings can be asserted by Code.
# ---------------------------------------------------------------------------


def _compose(
    manifest_path: Path,
    scope: Scope,
    **kwargs: object,
) -> tuple[Desired, Reporter]:
    reporter = Reporter()
    manifest = load_skills_manifest(manifest_path)
    desired = compose(manifest, scope, registry_roots(None), reporter, **kwargs)  # type: ignore[arg-type]
    return desired, reporter


def compose_global(
    sandbox: Sandbox, raw: object = None, **keys: object
) -> tuple[Desired, Reporter]:
    """Compile ``$HOME/.agents/skills.json`` at global scope."""
    path = sandbox.write_global_manifest(raw, **keys)  # type: ignore[arg-type]
    return _compose(path, global_scope())


def compose_project(
    sandbox: Sandbox,
    raw: object = None,
    *,
    name: str = "proj",
    **keys: object,
) -> tuple[Desired, Reporter]:
    """Compile ``<tmp>/projects/<name>/.agents/skills.json`` at project scope."""
    root = sandbox.project(name, manifest={})
    path = write_manifest(root, raw, **keys)  # type: ignore[arg-type]
    return _compose(path, project_scope(root))


def codes(reporter: Reporter) -> list[Code]:
    """Every emitted code, in emission order."""
    return [f.code for f in reporter.findings]


def one(reporter: Reporter, code: Code):
    """The single finding carrying ``code``. Fails loudly on 0 or 2+."""
    hits = [f for f in reporter.findings if f.code is code]
    assert len(hits) == 1, f"expected exactly one {code.value}, got {codes(reporter)}"
    return hits[0]


def warnings(reporter: Reporter) -> list[Code]:
    return [f.code for f in reporter.findings if f.severity is Severity.WARNING]


def outside(sandbox: Sandbox) -> Path:
    """A CWD that is inside no project, so a CLI run syncs global only."""
    path = sandbox.tmp / "elsewhere"
    path.mkdir(exist_ok=True)
    return path


# ===========================================================================
# AC 4 -- "If a set skill conflicts with another set's skill, the LATEST wins"
# ===========================================================================


def test_later_set_wins_and_records_a_shadow(sandbox, registry, write_catalog, write_set):
    catalog = write_catalog(registry, "old", "new")
    write_set(registry, "one", [("link", "dup", catalog["old"])])
    write_set(registry, "two", [("link", "dup", catalog["new"])])

    desired, _ = compose_global(sandbox, sets=["one", "two"])

    assert desired.bindings["dup"].target == catalog["new"]
    assert desired.bindings["dup"].origin.startswith("sets[1]")
    assert len(desired.shadows) == 1
    shadow = desired.shadows[0]
    assert shadow.name == "dup"
    assert shadow.loser.target == catalog["old"]
    assert shadow.winner.target == catalog["new"]
    assert shadow.divergent is True


def test_reversing_the_array_reverses_the_winner(sandbox, registry, write_catalog, write_set):
    """Positional, not alphabetical: "one" beats "two" only when it comes last."""
    catalog = write_catalog(registry, "old", "new")
    write_set(registry, "one", [("link", "dup", catalog["old"])])
    write_set(registry, "two", [("link", "dup", catalog["new"])])

    forward, _ = compose_global(sandbox, sets=["one", "two"])
    reverse, _ = compose_global(sandbox, sets=["two", "one"])

    assert forward.bindings["dup"].target == catalog["new"]
    assert reverse.bindings["dup"].target == catalog["old"]
    # ...and the winner is the one declared LAST, whatever its name sorts as.
    assert forward.bindings["dup"].origin.startswith("sets[1]")
    assert reverse.bindings["dup"].origin.startswith("sets[1]")


def test_a_repeated_set_name_wins_from_its_last_position(
    sandbox, registry, write_catalog, write_set
):
    """``["a", "b", "a"]`` -- the third pass is the winner, not the first."""
    catalog = write_catalog(registry, "from-a", "from-b")
    write_set(registry, "a", [("link", "dup", catalog["from-a"])])
    write_set(registry, "b", [("link", "dup", catalog["from-b"])])

    desired, reporter = compose_global(sandbox, sets=["a", "b", "a"])

    assert desired.bindings["dup"].target == catalog["from-a"]
    assert desired.bindings["dup"].origin.startswith("sets[2]")
    # Two overwrites happened, both divergent.
    assert codes(reporter).count(Code.W_SET_CONFLICT_RETARGET) == 2


def test_divergent_collision_names_both_targets(sandbox, registry, write_catalog, write_set):
    catalog = write_catalog(registry, "old", "new")
    write_set(registry, "one", [("link", "dup", catalog["old"])])
    write_set(registry, "two", [("link", "dup", catalog["new"])])

    _, reporter = compose_global(sandbox, sets=["one", "two"])

    finding = one(reporter, Code.W_SET_CONFLICT_RETARGET)
    assert finding.name == "dup"
    joined = "\n".join(finding.detail)
    assert str(catalog["old"]) in joined
    assert str(catalog["new"]) in joined
    assert finding.fix


def test_same_target_collision_is_info_and_emits_no_warning(
    sandbox, registry, write_catalog, write_set
):
    """The live ``global`` / ``min-global`` shape: 35 shared names, 0 divergent.

    Treating every collision as a conflict would print 35 warnings for a healthy
    manifest and train the eye to skip them, which is exactly what
    ``Shadow.divergent`` exists to prevent.
    """
    names = [f"shared-{i:02d}" for i in range(35)]
    catalog = write_catalog(registry, *names)
    members = [("link", name, catalog[name]) for name in names]
    write_set(registry, "global", members)
    write_set(registry, "min-global", members)

    desired, reporter = compose_global(sandbox, sets=["global", "min-global"])

    assert len(desired.bindings) == 35
    assert len(desired.shadows) == 35
    assert not any(s.divergent for s in desired.shadows)
    assert codes(reporter).count(Code.I_SET_REBIND) == 35
    assert warnings(reporter) == []


def test_a_dangling_member_in_a_later_set_does_not_displace_a_live_binding(
    sandbox, registry, write_catalog, write_set
):
    """The delodocs-vs-global case: latest *resolvable* declaration wins.

    ``sets/delodocs/hindsight`` is dangling today while ``sets/global/hindsight``
    is live. Under a naive positional overwrite the broken link would win and a
    dangling symlink would land in the activation root.
    """
    catalog = write_catalog(registry, "hindsight")
    write_set(registry, "global", [("link", "hindsight", catalog["hindsight"])])
    write_set(
        registry,
        "delodocs",
        [("dangling", "hindsight", registry / "all-skills" / "gone"), ("realdir", "d1")],
    )

    desired, reporter = compose_global(sandbox, sets=["global", "delodocs"])

    assert desired.bindings["hindsight"].target == catalog["hindsight"]
    assert desired.bindings["hindsight"].origin.startswith("sets[0]")
    # Dropped before precedence ran, so it never even became a shadow.
    assert desired.shadows == []
    assert Code.W_SET_MEMBER_DANGLING in codes(reporter)


def test_later_set_wins_on_disk(sandbox, registry, write_catalog, write_set, run_sync_json):
    """AC 4, end to end: read the symlink back, do not trust the plan."""
    catalog = write_catalog(registry, "old", "new")
    write_set(registry, "one", [("link", "dup", catalog["old"])])
    write_set(registry, "two", [("link", "dup", catalog["new"])])
    sandbox.write_global_manifest(sets=["one", "two"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, payload
    link = sandbox.global_root / "dup"
    assert link.is_symlink()
    assert os.readlink(link) == str(catalog["new"])


def test_a_dangling_later_member_leaves_the_live_link_on_disk(
    sandbox, registry, write_catalog, write_set, run_sync_json
):
    catalog = write_catalog(registry, "hindsight")
    write_set(registry, "global", [("link", "hindsight", catalog["hindsight"])])
    write_set(registry, "delodocs", [("dangling", "hindsight", registry / "all-skills" / "gone")])
    sandbox.write_global_manifest(sets=["global", "delodocs"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, payload
    link = sandbox.global_root / "hindsight"
    assert os.readlink(link) == str(catalog["hindsight"])
    # The projected link resolves: no dangling symlink reached the root.
    assert (link / "SKILL.md").is_file()
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == ["hindsight"]


# ===========================================================================
# AC 5 -- "If a set skill conflicts with an explicit individual skill,
#          the INDIVIDUAL one wins"
# ===========================================================================


@pytest.mark.parametrize(
    "skills_first", [True, False], ids=["skills-before-sets", "sets-before-skills"]
)
def test_individual_wins_regardless_of_json_key_order(
    sandbox, registry, write_catalog, write_set, skills_first
):
    """Precedence is by PASS, never by where the key sits in the file."""
    catalog = write_catalog(registry, "dup", "from-set")
    write_set(registry, "s", [("link", "dup", catalog["from-set"])])

    raw = {"skills": ["dup"], "sets": ["s"]} if skills_first else {"sets": ["s"], "skills": ["dup"]}
    desired, reporter = compose_global(sandbox, raw)

    assert desired.bindings["dup"].target == catalog["dup"]
    assert desired.bindings["dup"].stage == "skill"
    assert Code.I_SKILL_OVERRIDES_SET in codes(reporter)
    # An override by design is INFO, never a warning.
    assert warnings(reporter) == []


def test_an_individual_entry_beats_the_last_of_three_sets(
    sandbox, registry, write_catalog, write_set
):
    catalog = write_catalog(registry, "dup", "a", "b", "c")
    for name in ("a", "b", "c"):
        write_set(registry, f"set-{name}", [("link", "dup", catalog[name])])

    desired, _ = compose_global(sandbox, sets=["set-a", "set-b", "set-c"], skills=["dup"])

    assert desired.bindings["dup"].target == catalog["dup"]
    assert desired.bindings["dup"].origin.startswith("skills[0]")


def test_individual_wins_on_disk(sandbox, registry, write_catalog, write_set, run_sync_json):
    """AC 5, end to end."""
    catalog = write_catalog(registry, "dup", "from-set")
    write_set(registry, "s", [("link", "dup", catalog["from-set"])])
    sandbox.write_global_manifest(sets=["s"], skills=["dup"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, payload
    assert os.readlink(sandbox.global_root / "dup") == str(catalog["dup"])


# ===========================================================================
# AC 1 -- "sync all manifest `skills` to the skills/ path"
# ===========================================================================


def test_bare_name_resolves_from_the_catalog(sandbox, registry, write_catalog):
    catalog = write_catalog(registry, "hindsight")

    desired, reporter = compose_global(sandbox, skills=["hindsight"])

    assert desired.bindings["hindsight"].target == catalog["hindsight"]
    assert desired.bindings["hindsight"].outside_catalog is False
    assert reporter.findings == []


def test_slash_form_is_projected_by_basename(sandbox, registry, write_catalog, write_set):
    """``"sets/min-global/hindsight"`` projects ``hindsight`` and targets as written."""
    catalog = write_catalog(registry, "hindsight")
    set_dir = write_set(registry, "min-global", [("link", "hindsight", catalog["hindsight"])])

    desired, _ = compose_global(sandbox, skills=["sets/min-global/hindsight"])

    assert list(desired.bindings) == ["hindsight"]
    # The path is taken AS WRITTEN -- the entry points at the set member, not at
    # the canonical catalog directory behind it.
    assert desired.bindings["hindsight"].target == set_dir / "hindsight"


def test_registry_path_object_form_projects_under_the_declared_name(
    sandbox, registry, write_catalog
):
    """The projected name is ALWAYS the declared name, never the target basename."""
    catalog = write_catalog(registry, "project-jangler")

    desired, _ = compose_global(
        sandbox, skills=[{"name": "pjangler", "registry_path": "all-skills/project-jangler"}]
    )

    assert list(desired.bindings) == ["pjangler"]
    assert desired.bindings["pjangler"].target == catalog["project-jangler"]


def test_name_only_object_form_resolves_from_the_catalog(sandbox, registry, write_catalog):
    catalog = write_catalog(registry, "hindsight")

    desired, _ = compose_global(sandbox, skills=[{"name": "hindsight"}])

    assert desired.bindings["hindsight"].target == catalog["hindsight"]


def test_unresolvable_set_member_is_dropped_but_unresolvable_skill_is_an_error(
    sandbox, registry, write_set
):
    """The asymmetry is deliberate and is the whole point of this test.

    A set member is inventory: sync drops it and warns. A ``skills[]`` entry is an
    explicit, hand-written declaration, so honoring it silently would be a lie.
    """
    write_set(registry, "s", [("dangling", "ghost", registry / "all-skills" / "nope")])

    dropped, reporter = compose_global(sandbox, sets=["s"])
    assert "ghost" not in dropped.bindings
    assert Code.W_SET_MEMBER_DANGLING in codes(reporter)
    assert reporter.errors() == []

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=["ghost"])
    # E_SKILL_MISSING, not E_NO_REGISTRY: the checkouts are fine, the NAME is wrong.
    # The two codes send a reader to two different places.
    assert excinfo.value.finding.code is Code.E_SKILL_MISSING


def test_a_skills_entry_pointing_at_a_non_skill_is_an_error(sandbox, registry):
    (registry / "all-skills" / "hollow").mkdir(parents=True)

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=["hollow"])
    assert excinfo.value.finding.code is Code.E_TARGET_NOT_A_SKILL


@pytest.mark.parametrize(
    "spec",
    ["../../../etc/passwd", "/etc/passwd", "", "all-skills/./x", "a//b", "sets/../../x"],
)
def test_traversal_absolute_and_empty_shorthands_are_rejected(spec):
    with pytest.raises(ValueError):
        SkillEntry.from_spec(spec)


def test_an_unsafe_shorthand_fails_the_whole_manifest(sandbox, run_sync_json):
    """End to end: a rejected entry is a manifest error, not a silent drop."""
    sandbox.write_global_manifest(skills=["../../../etc/passwd"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 2
    # E_MANIFEST_INVALID, not E_MANIFEST_PARSE: the JSON is well-formed, it just
    # says something impossible. Both exit 2; the code says where to look.
    assert [f["code"] for f in payload["findings"]] == [Code.E_MANIFEST_INVALID.value]


def test_resolve_skill_entry_re_checks_the_relpath_itself(registry):
    """Defense in depth: the resolver never trusts a validated-elsewhere path.

    ``model_construct`` bypasses the field validator exactly as a future refactor
    or a new construction site could; ``resolve_skill_entry`` must still refuse.
    """
    entry = SkillEntry.model_construct(
        name="evil", source=None, registry_path="../../etc", raw_path=None
    )

    with pytest.raises(RefusalError) as excinfo:
        resolve_skill_entry(entry, 0, [registry])
    assert excinfo.value.finding.code is Code.E_UNSAFE_PATH


def test_a_pack_declared_through_skills_is_named_as_such(sandbox, registry, write_pack):
    """A generic 'no SKILL.md' error would send you looking in the wrong place."""
    write_pack(registry, "folder-curator", skills=["a"])

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=["packs/folder-curator"])

    finding = excinfo.value.finding
    assert finding.code is Code.E_PACK_VIA_SKILLS
    assert finding.detail == ("packs/folder-curator",)


@pytest.mark.parametrize(
    "source",
    [
        "git@github.com:delorenj/skillex.git",
        "https://github.com/delorenj/skillex.git",
        "ssh://git@example.com/x.git",
    ],
)
def test_a_remote_skill_source_is_refused(sandbox, registry, source):
    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=[{"name": "x", "source": source}])
    assert excinfo.value.finding.code is Code.E_REMOTE_SOURCE


def test_a_file_source_resolves(sandbox, registry, write_skill):
    external = write_skill(sandbox.tmp / "other-repo" / "skills", "hyperframes")

    desired, reporter = compose_global(
        sandbox, skills=[{"name": "hyperframes", "source": f"file://{external}"}]
    )

    assert desired.bindings["hyperframes"].target == external
    # It resolves from outside the catalog, and the binding says so.
    assert desired.bindings["hyperframes"].outside_catalog is True
    assert reporter.errors() == []


def test_a_remote_set_source_is_refused(sandbox, registry):
    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, sets=[{"name": "s", "source": "https://example.com/s.git"}])
    assert excinfo.value.finding.code is Code.E_REMOTE_SOURCE


# ===========================================================================
# AC 2 -- "It also syncs the contents of each set"
# ===========================================================================


def test_every_member_of_every_set_is_projected(sandbox, registry, write_catalog, write_set):
    catalog = write_catalog(registry, "a", "b", "c", "d")
    write_set(registry, "one", [("link", "a", catalog["a"]), ("link", "b", catalog["b"])])
    write_set(registry, "two", [("link", "c", catalog["c"]), ("link", "d", catalog["d"])])

    desired, _ = compose_global(sandbox, sets=["one", "two"])

    assert sorted(desired.bindings) == ["a", "b", "c", "d"]
    assert all(b.stage == "set" for b in desired.bindings.values())


def test_two_names_for_one_target_both_survive(sandbox, registry, write_catalog, write_set):
    """``sets/global`` really carries ``33god-projects`` and ``projects``, one target.

    ADR-0001 forbids two *targets* for one *name*, not two *names* for one target.
    """
    catalog = write_catalog(registry, "projects")
    write_set(
        registry,
        "global",
        [
            ("link", "33god-projects", catalog["projects"]),
            ("link", "projects", catalog["projects"]),
        ],
    )

    desired, reporter = compose_global(sandbox, sets=["global"])

    assert sorted(desired.bindings) == ["33god-projects", "projects"]
    assert {b.target for b in desired.bindings.values()} == {catalog["projects"]}
    assert reporter.findings == []


# ===========================================================================
# AC 3 -- "If a pack is defined, it trumps all above and replaces skills/"
# ===========================================================================


def test_a_pack_discards_sets_and_skills_and_says_what_it_dropped(
    sandbox, registry, write_catalog, write_set, write_pack
):
    write_catalog(registry, "curate", "from-set", "individual")
    write_set(registry, "s", [("link", "from-set", registry / "all-skills" / "from-set")])
    write_pack(registry, "folder-curator", declared=["curate"], extra_files={"README.md": "x\n"})

    desired, reporter = compose_project(
        sandbox, sets=["s"], skills=["individual"], packs=["folder-curator"]
    )

    assert list(desired.bindings) == ["curate"]
    assert all(b.stage == "pack" for b in desired.bindings.values())
    finding = one(reporter, Code.W_PACK_TRUMPS)
    assert finding.detail == ("sets[]: s", "skills[]: individual")


def test_a_pack_replaces_the_root_on_disk(
    sandbox, registry, write_catalog, write_set, write_pack, run_sync_json
):
    catalog = write_catalog(registry, "curate", "from-set")
    write_set(registry, "s", [("link", "from-set", catalog["from-set"])])
    write_pack(registry, "folder-curator", declared=["curate"])
    sandbox.write_global_manifest(sets=["s"], packs=["folder-curator"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, payload
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == ["curate"]
    assert os.readlink(sandbox.global_root / "curate") == str(catalog["curate"])


def test_two_packs_are_refused(sandbox, registry, write_pack):
    write_pack(registry, "one", skills=["a"])
    write_pack(registry, "two", skills=["b"])

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, packs=["one", "two"])
    assert excinfo.value.finding.code is Code.E_MULTIPLE_PACKS


# -- the four live pack shapes ---------------------------------------------


def test_manifest_only_pack_resolves_members_from_the_catalog(
    sandbox, registry, write_catalog, write_pack
):
    """``packs/folder-curator``: pack.toml + README only."""
    catalog = write_catalog(registry, "a", "b")
    write_pack(registry, "folder-curator", declared=["a", "b"], extra_files={"README.md": "# x\n"})

    desired, _ = compose_project(sandbox, packs=["folder-curator"])

    assert list(desired.bindings) == ["a", "b"]
    assert desired.bindings["a"].target == catalog["a"]
    assert desired.bindings["b"].target == catalog["b"]


def test_symlink_only_pack_without_a_pack_toml(sandbox, registry, write_catalog, write_pack):
    """``packs/Kurzgesagt``: no pack.toml, symlink children, two of them dangling.

    The globbed inventory returns ``[]`` for it (symlinks are invisible to that
    walker), so the composition reader has to handle it -- and the one
    trailing-slash link in the tree has to normalize.
    """
    catalog = write_catalog(registry, "hindsight")
    write_pack(
        registry,
        "Kurzgesagt",
        pack_toml=False,
        members=[
            ("link", "hindsight", "../../all-skills/hindsight/"),
            ("dangling", "ghost", registry / "all-skills" / "nope"),
        ],
    )

    desired, reporter = compose_project(sandbox, packs=["Kurzgesagt"])

    assert list(desired.bindings) == ["hindsight"]
    assert desired.bindings["hindsight"].target == catalog["hindsight"]
    assert Code.W_SET_MEMBER_DANGLING in codes(reporter)


def test_version_only_directory_layout_selects_the_version_dir(sandbox, registry, write_pack):
    """``packs/hermes-base/0.18.2``: the pack root holds only version directories."""
    pack_dir = write_pack(registry, "hermes-base", version="0.18.2", skills=["alpha"])
    assert pack_dir == registry / "packs" / "hermes-base" / "0.18.2"

    desired, _ = compose_project(sandbox, packs=["hermes-base"])

    assert list(desired.bindings) == ["alpha"]
    assert desired.bindings["alpha"].target == pack_dir / "alpha"


def test_pack_toml_with_no_version_key(sandbox, registry, write_pack):
    """``packs/torrent-movie``: a pack.toml that never declares a version."""
    pack_dir = write_pack(registry, "torrent-movie", skills=["x"])
    assert "version" not in (pack_dir / "pack.toml").read_text(encoding="utf-8")

    desired, _ = compose_project(sandbox, packs=["torrent-movie"])

    assert list(desired.bindings) == ["x"]
    assert desired.bindings["x"].target == pack_dir / "x"


# -- flatten ---------------------------------------------------------------


def test_flatten_expands_containers_to_leaves_and_never_into_a_skill(
    sandbox, registry, write_pack, write_skill
):
    """A three-level tree flattens to its leaves; a leaf's support tree does not.

    ``mlops/`` in the live pack carries three sub-containers each with their own
    leaves, which is why the walk descends while a node is still a container --
    and why it must stop the instant a node IS a skill, or every skill's
    ``references/`` and ``scripts/`` would become skills of their own.
    """
    pack_dir = write_pack(
        registry,
        "hermes-base",
        version="0.18.2",
        flatten=True,
        tree={
            "cat1": {"leaf1": None, "leaf2": None},
            "mlops": {"evaluation": {"e1": None, "e2": None}, "inference": {"i1": None}},
            "solo": None,
            "empty": {},
        },
    )
    # A leaf's own support tree, deliberately shaped like more skills.
    write_skill(pack_dir / "cat1" / "leaf1" / "references", "deep-reference")
    write_skill(pack_dir / "cat1" / "leaf1" / "scripts", "deep-script")

    desired, reporter = compose_project(sandbox, packs=["hermes-base"])

    assert sorted(desired.bindings) == ["e1", "e2", "i1", "leaf1", "leaf2", "solo"]
    assert len(desired.bindings) == 6
    assert "deep-reference" not in desired.bindings
    assert "deep-script" not in desired.bindings
    assert "references" not in desired.bindings
    # Depth 0, 1 and 2 leaves all land flat in the root.
    assert desired.bindings["solo"].target == pack_dir / "solo"
    assert desired.bindings["leaf1"].target == pack_dir / "cat1" / "leaf1"
    assert desired.bindings["e1"].target == pack_dir / "mlops" / "evaluation" / "e1"
    assert one(reporter, Code.W_PACK_EMPTY_CONTAINER).name == "empty"


def test_an_empty_container_warns_without_making_the_pack_unsyncable(
    sandbox, registry, write_pack, run_sync_json
):
    """Regression: ``W_PACK_EMPTY_CONTAINER`` is a WARNING, so sync must proceed.

    ``expand_pack`` left an empty container in ``remaining`` after flattening, and
    the unflattened member loop below refuses a directory with no ``SKILL.md``
    outright -- so one empty entry in an 18-entry pack refused the whole sync while
    the reporter insisted it was only a warning.
    """
    write_pack(
        registry,
        "hermes-base",
        version="0.18.2",
        flatten=True,
        tree={"cat1": {"leaf1": None}, "empty": {}},
    )
    sandbox.write_global_manifest(packs=["hermes-base"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, json.dumps(payload)
    assert Code.W_PACK_EMPTY_CONTAINER.value in [f["code"] for f in payload["findings"]]
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == ["leaf1"]


def test_flatten_leaves_land_flat_on_disk(sandbox, registry, write_pack, run_sync_json):
    pack_dir = write_pack(
        registry,
        "hermes-base",
        version="0.18.2",
        flatten=True,
        tree={"cat1": {"leaf1": None}, "solo": None},
    )
    sandbox.write_global_manifest(packs=["hermes-base"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, payload
    assert sorted(p.name for p in sandbox.global_root.iterdir()) == ["leaf1", "solo"]
    assert os.readlink(sandbox.global_root / "leaf1") == str(pack_dir / "cat1" / "leaf1")


# -- alias mode ------------------------------------------------------------


def _pack_bindings(pack_dir: Path, *names: str) -> OrderedDict[str, Binding]:
    return OrderedDict(
        (n, Binding(name=n, target=pack_dir / n, stage="pack", origin='packs[0] "p"'))
        for n in names
    )


def test_alias_mode_eligible_for_a_flat_global_pack(sandbox, registry, write_pack):
    pack_dir = write_pack(registry, "flat", skills=["a"])
    reporter = Reporter()

    eligible = alias_mode_eligible(
        global_scope(),
        pack_dir,
        PackEntry(name="flat"),
        False,
        _pack_bindings(pack_dir, "a"),
        reporter,
    )

    assert eligible is True
    assert reporter.findings == []


@pytest.mark.parametrize(
    ("kind", "flatten", "entry_kwargs"),
    [
        ("project", False, {}),
        ("global", True, {}),
        ("global", False, {"include": ("a",)}),
        ("global", False, {"exclude": ("a",)}),
    ],
    ids=["project-scope", "flatten", "include", "exclude"],
)
def test_alias_mode_is_declined_and_says_why(
    sandbox, registry, write_pack, kind, flatten, entry_kwargs
):
    pack_dir = write_pack(registry, "flat", skills=["a"])
    scope = global_scope() if kind == "global" else project_scope(sandbox.project("p"))
    reporter = Reporter()

    eligible = alias_mode_eligible(
        scope,
        pack_dir,
        PackEntry(name="flat", **entry_kwargs),
        flatten,
        _pack_bindings(pack_dir, "a"),
        reporter,
    )

    assert eligible is False
    assert one(reporter, Code.W_ALIAS_MODE_DECLINED).name == "flat"


def test_alias_mode_is_declined_when_members_live_outside_the_pack(
    sandbox, registry, write_catalog, write_pack
):
    catalog = write_catalog(registry, "a")
    pack_dir = write_pack(registry, "folder-curator", declared=["a"])
    reporter = Reporter()
    bindings: OrderedDict[str, Binding] = OrderedDict(
        a=Binding(name="a", target=catalog["a"], stage="pack", origin='packs[0] "folder-curator"')
    )

    eligible = alias_mode_eligible(
        global_scope(), pack_dir, PackEntry(name="folder-curator"), False, bindings, reporter
    )

    assert eligible is False
    assert Code.W_ALIAS_MODE_DECLINED in codes(reporter)


def test_an_eligible_global_pack_composes_as_an_alias(sandbox, registry, write_pack):
    pack_dir = write_pack(registry, "flat", skills=["a", "b"])

    desired, reporter = compose_global(sandbox, packs=["flat"])

    assert desired.mode == "alias"
    assert desired.alias_target == pack_dir
    assert desired.bindings == OrderedDict()
    assert Code.W_ALIAS_MODE_DECLINED not in codes(reporter)


def test_the_same_pack_composes_as_a_real_directory_at_project_scope(sandbox, registry, write_pack):
    """pjangler audits ``<repo>/.agents/skills`` and refuses a symlinked root."""
    pack_dir = write_pack(registry, "flat", skills=["a", "b"])

    desired, reporter = compose_project(sandbox, packs=["flat"])

    assert desired.mode == "composed"
    assert sorted(desired.bindings) == ["a", "b"]
    assert desired.bindings["a"].target == pack_dir / "a"
    assert Code.W_ALIAS_MODE_DECLINED in codes(reporter)


# ===========================================================================
# manifest-level guards
# ===========================================================================


def test_an_unknown_top_level_key_is_reported_not_ignored(sandbox, registry, write_catalog):
    """The published schema sets no ``additionalProperties: false``."""
    write_catalog(registry, "hindsight")

    desired, reporter = compose_global(sandbox, {"skils": ["hindsight"], "skills": []})

    assert desired.bindings == OrderedDict()
    assert one(reporter, Code.W_MANIFEST_UNKNOWN_KEY).path == sandbox.global_manifest


def test_a_declared_scope_that_disagrees_with_placement_warns(sandbox, registry):
    _, reporter = compose_global(sandbox, {"scope": "project"})

    assert Code.W_SCOPE_MISMATCH in codes(reporter)


def test_a_matching_declared_scope_is_silent(sandbox, registry):
    _, reporter = compose_global(sandbox, {"scope": "global"})

    assert reporter.findings == []


def test_inherit_global_on_a_global_manifest_is_meaningless(sandbox, registry):
    _, reporter = compose_global(sandbox, {"inherit_global": True})

    assert one(reporter, Code.W_INHERIT_ON_GLOBAL).path == sandbox.global_manifest


def test_inherit_global_on_a_project_manifest_is_not_flagged(sandbox, registry):
    _, reporter = compose_project(sandbox, {"inherit_global": False})

    assert Code.W_INHERIT_ON_GLOBAL not in codes(reporter)


# ===========================================================================
# _finalize -- structurally unsafe targets, whatever the manifest says
# ===========================================================================


def test_a_target_inside_the_registry_cache_is_refused(sandbox, registry, write_skill):
    """``sync-skills.py`` clones arbitrary remotes into ``~/.agents/.cache``."""
    cached = write_skill(
        sandbox.home / ".agents" / ".cache" / "registries" / "some_url" / "all-skills", "evil"
    )

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=[{"name": "evil", "source": f"file://{cached}"}])
    assert excinfo.value.finding.code is Code.E_UNSAFE_TARGET


def test_a_target_inside_another_projection_is_refused(sandbox, registry, write_skill):
    """Regenerating that projection would silently break this one."""
    other = write_skill(sandbox.tmp / "projects" / "other" / ".agents" / "skills", "thing")

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=[{"name": "thing", "source": f"file://{other}"}])
    assert excinfo.value.finding.code is Code.E_TARGET_IS_PROJECTION


def test_a_target_containing_the_activation_root_is_refused(sandbox, registry):
    """``$HOME/.agents`` contains ``$HOME/.agents/skills``: projecting it recurses."""
    ancestor = sandbox.home / ".agents"
    (ancestor / "SKILL.md").write_text("---\nname: anc\n---\n", encoding="utf-8")

    with pytest.raises(RefusalError) as excinfo:
        compose_global(sandbox, skills=[{"name": "anc", "source": f"file://{ancestor}"}])
    assert excinfo.value.finding.code is Code.E_RECURSIVE_PROJECTION


def test_refused_targets_leave_the_disk_untouched(
    sandbox, registry, write_skill, run_sync, snapshot
):
    """An ERROR means ZERO mutation -- not a partially written root."""
    other = write_skill(sandbox.tmp / "projects" / "other" / ".agents" / "skills", "thing")
    write_skill(registry / "all-skills", "safe")
    sandbox.write_global_manifest(skills=["safe", {"name": "thing", "source": f"file://{other}"}])
    before = snapshot(sandbox.home / ".agents")

    code, _ = run_sync(cwd=outside(sandbox))

    assert code == 3  # a refusal, not a config error
    assert snapshot(sandbox.home / ".agents") == before


# ===========================================================================
# models: schema fields sync accepts-and-refuses rather than ignores
# ===========================================================================


@pytest.mark.parametrize(
    "spec",
    [
        {"name": "s", "flatten": True},
        {"name": "s", "sealed": True},
        {"name": "s", "version": "1.0.0"},
        {"name": "s", "registry": "https://github.com/delorenj/skillex.git"},
    ],
    ids=["flatten", "sealed", "version", "registry"],
)
def test_unsupported_set_fields_are_refused_with_an_explanation(spec):
    """Silently ignoring these is the worst outcome: ``sets[].flatten`` would
    project ZERO skills and report success."""
    with pytest.raises(UnsupportedFieldError) as excinfo:
        SetEntry.from_spec(spec)
    message = str(excinfo.value)
    assert "is not supported." in message
    # An explanation, not just a refusal.
    assert len(message.split("is not supported.", 1)[1].strip()) > 40


def test_the_set_version_shorthand_is_refused():
    """``sets/`` has no version layout and the object form has no version field."""
    with pytest.raises(UnsupportedFieldError) as excinfo:
        SetEntry.from_spec("min-global@1.0.0")
    assert "1.0.0" in str(excinfo.value)


def test_a_bare_set_shorthand_still_works():
    assert SetEntry.from_spec("min-global").name == "min-global"


@pytest.mark.parametrize(
    "spec",
    [
        {"name": "x", "version": "main"},
        {"name": "x", "registry": "https://github.com/delorenj/skillex.git"},
    ],
    ids=["version", "registry"],
)
def test_unsupported_skill_fields_are_refused_with_an_explanation(spec):
    with pytest.raises(UnsupportedFieldError) as excinfo:
        SkillEntry.from_spec(spec)
    message = str(excinfo.value)
    assert "is not supported." in message
    assert len(message.split("is not supported.", 1)[1].strip()) > 40


# ===========================================================================
# AC 6 / AC 7 boundary: what compose() itself does with inheritance
# ===========================================================================


def test_a_project_inherits_global_bindings_as_a_union_with_canonical_targets(
    sandbox, registry, write_catalog
):
    """ADR-0001 rule 10: inheritance is a union, and targets stay CANONICAL.

    Chaining a project link through ``~/.agents/skills`` would break every project
    the next time the global root is regenerated.
    """
    catalog = write_catalog(registry, "hindsight", "local")
    inherited: OrderedDict[str, Binding] = OrderedDict(
        hindsight=Binding(
            name="hindsight",
            target=catalog["hindsight"],
            stage="skill",
            origin='skills[0] "hindsight"',
        )
    )
    root = sandbox.project("proj", manifest={})
    path = write_manifest(root, skills=["local"])

    desired, reporter = _compose(path, project_scope(root), inherited=inherited)

    assert sorted(desired.bindings) == ["hindsight", "local"]
    assert desired.bindings["hindsight"].stage == "inherited"
    assert desired.bindings["hindsight"].target == catalog["hindsight"]
    assert Code.W_INHERIT_DUPLICATES_GLOBAL in codes(reporter)


def test_no_inherit_drops_the_global_union(sandbox, registry, write_catalog):
    catalog = write_catalog(registry, "hindsight", "local")
    inherited: OrderedDict[str, Binding] = OrderedDict(
        hindsight=Binding(name="hindsight", target=catalog["hindsight"], stage="skill", origin="x")
    )
    root = sandbox.project("proj", manifest={})
    path = write_manifest(root, skills=["local"])

    desired, reporter = _compose(path, project_scope(root), inherited=inherited, inherit=False)

    assert list(desired.bindings) == ["local"]
    assert Code.W_INHERIT_DUPLICATES_GLOBAL not in codes(reporter)


def test_a_project_skill_overwrites_the_inherited_global_binding(sandbox, registry, write_catalog):
    """Inherited is pass 1; ``skills[]`` is the last pass, so the project wins."""
    catalog = write_catalog(registry, "hindsight", "hindsight-fork")
    inherited: OrderedDict[str, Binding] = OrderedDict(
        hindsight=Binding(
            name="hindsight", target=catalog["hindsight"], stage="skill", origin="global"
        )
    )
    root = sandbox.project("proj", manifest={})
    path = write_manifest(
        root, skills=[{"name": "hindsight", "registry_path": "all-skills/hindsight-fork"}]
    )

    desired, _ = _compose(path, project_scope(root), inherited=inherited)

    assert desired.bindings["hindsight"].target == catalog["hindsight-fork"]
    assert desired.bindings["hindsight"].stage == "skill"


def test_an_empty_manifest_projects_nothing_and_is_not_an_error(sandbox, registry):
    desired, reporter = compose_global(sandbox, {})

    assert desired.bindings == OrderedDict()
    assert reporter.findings == []


def test_a_missing_registry_is_an_error_before_anything_is_resolved(
    sandbox, registry, monkeypatch, tmp_path
):
    """``registry_roots()`` returns only EXISTING rungs; none means refuse."""
    monkeypatch.setenv("PJ_SKILLS_REGISTRY_ROOT", str(tmp_path / "no-such-registry"))
    path = sandbox.write_global_manifest(skills=["hindsight"])
    manifest = load_skills_manifest(path)

    with pytest.raises(RefusalError) as excinfo:
        compose(manifest, global_scope(), registry_roots(None), Reporter())
    assert excinfo.value.finding.code is Code.E_NO_REGISTRY


def test_the_json_payload_publishes_shadows(
    sandbox, registry, write_catalog, write_set, run_sync_json
):
    """``--json`` is a contract: the overwrite is visible without --explain."""
    catalog = write_catalog(registry, "old", "new")
    write_set(registry, "one", [("link", "dup", catalog["old"])])
    write_set(registry, "two", [("link", "dup", catalog["new"])])
    sandbox.write_global_manifest(sets=["one", "two"])

    code, payload = run_sync_json(cwd=outside(sandbox))

    assert code == 0, json.dumps(payload)
    shadows = payload["scopes"][0]["shadows"]
    assert len(shadows) == 1
    assert shadows[0]["name"] == "dup"
    assert shadows[0]["divergent"] is True
    assert shadows[0]["winner"].startswith("sets[1]")
    assert shadows[0]["loser"].startswith("sets[0]")
