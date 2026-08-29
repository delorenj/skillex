"""Relink: repointing composition links that bypass the catalog.

Vendoring alone heals 3 of the 25 links that dangle on a second machine. The other
22 point straight at ``~/code/33GOD`` and never touch ``all-skills/``. This is the
half that closes the measured 36 -> 26 and 90 -> 75 regression.
"""

from __future__ import annotations

import os

import pytest

from skillex.core.diagnostics import Code, Reporter
from skillex.core.provenance import Provenance, write_provenance
from skillex.core.vendor import apply_relink, plan_relink
from tests.conftest import snapshot
from tests.vendor_helpers import write_source_skill

pytestmark = pytest.mark.usefixtures("sandbox")

THIRTY3GOD = "/home/delorenj/code/33GOD"


@pytest.fixture
def tree(tmp_path):
    """A catalog with three vendored entries and a sets/ directory to repoint."""
    catalog = tmp_path / "all-skills"
    catalog.mkdir()
    for name, upstream_path, source in (
        ("mise-tasks", "skills/mise-tasks", "pjangler"),
        ("project-jangler", "skills/project-jangler", "pjangler"),
        ("momo", "skill", "momo"),
    ):
        write_source_skill(catalog, name)
        write_provenance(
            catalog / name,
            Provenance(type="vendored", source=source, upstream_path=upstream_path),
        )
    (tmp_path / "sets" / "min-global").mkdir(parents=True)
    (tmp_path / "packs" / "p").mkdir(parents=True)
    return tmp_path, catalog


def link(at, name, target):
    os.symlink(target, at / name)
    return at / name


def relink(tmp_path, catalog):
    reporter = Reporter()
    return plan_relink([tmp_path / "sets", tmp_path / "packs"], catalog, reporter), reporter


def test_an_absolute_link_into_a_source_repo_is_repointed_at_the_catalog(tree):
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "mise-tasks", f"{THIRTY3GOD}/pjangler/skills/mise-tasks")
    ops, reporter = relink(tmp_path, catalog)
    assert [(op.link.name, op.new) for op in ops] == [("mise-tasks", "../../all-skills/mise-tasks")]
    apply_relink(ops, reporter)
    assert os.readlink(sets / "mise-tasks") == "../../all-skills/mise-tasks"


def test_the_link_name_is_preserved_when_it_differs_from_the_catalog_name(tree):
    """`sets/min-global/pjangler -> .../skills/project-jangler`: the projected name
    is the LINK name, never the target's basename (compositions.py rule (a))."""
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "pjangler", f"{THIRTY3GOD}/skills/project-jangler")
    ops, reporter = relink(tmp_path, catalog)
    apply_relink(ops, reporter)
    assert (sets / "pjangler").is_symlink()
    assert os.readlink(sets / "pjangler") == "../../all-skills/project-jangler"
    assert not (sets / "project-jangler").exists()


def test_momo_resolves_through_its_recorded_upstream_path(tree):
    """`sets/global/momo -> .../33GOD/momo/skill`; the basename is `skill`."""
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "momo", f"{THIRTY3GOD}/momo/skill")
    ops, reporter = relink(tmp_path, catalog)
    apply_relink(ops, reporter)
    assert os.readlink(sets / "momo") == "../../all-skills/momo"


def test_a_two_hop_farm_target_still_maps_to_the_owning_entry(tree):
    """The catalog links go via 33GOD/skills/, which is itself a link farm."""
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "mise-tasks", f"{THIRTY3GOD}/skills/mise-tasks")
    ops, _ = relink(tmp_path, catalog)
    assert [op.name for op in ops] == ["mise-tasks"]


def test_links_already_pointing_into_the_catalog_are_left_alone(tree):
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "mise-tasks", "../../all-skills/mise-tasks")
    before = snapshot(tmp_path / "sets")
    ops, reporter = relink(tmp_path, catalog)
    assert ops == []
    assert not reporter.findings
    assert snapshot(tmp_path / "sets") == before


def test_an_absolute_link_that_already_lands_in_the_catalog_is_left_alone(tree):
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "mise-tasks", str(catalog / "mise-tasks"))
    ops, _ = relink(tmp_path, catalog)
    assert ops == []


def test_a_link_no_vendored_entry_claims_is_reported_and_untouched(tree):
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "nope", "/home/delorenj/code/CoachingAgentFramework/skills/nope")
    before = snapshot(tmp_path / "sets")
    ops, reporter = relink(tmp_path, catalog)
    assert ops == []
    assert Code.W_RELINK_NO_CATALOG_ENTRY in {f.code for f in reporter.findings}
    assert snapshot(tmp_path / "sets") == before


def test_an_ambiguous_target_refuses_rather_than_picking_one(tree):
    tmp_path, catalog = tree
    write_source_skill(catalog, "rival")
    write_provenance(
        catalog / "rival",
        Provenance(type="vendored", source="other", upstream_path="skills/mise-tasks"),
    )
    sets = tmp_path / "sets" / "min-global"
    link(sets, "mise-tasks", f"{THIRTY3GOD}/pjangler/skills/mise-tasks")
    ops, reporter = relink(tmp_path, catalog)
    assert ops == []
    assert Code.E_RELINK_AMBIGUOUS in {f.code for f in reporter.findings}


def test_packs_are_walked_too(tree):
    tmp_path, catalog = tree
    pack = tmp_path / "packs" / "p"
    link(pack, "momo", f"{THIRTY3GOD}/momo/skill")
    ops, reporter = relink(tmp_path, catalog)
    apply_relink(ops, reporter)
    assert os.readlink(pack / "momo") == "../../all-skills/momo"


def test_relink_is_idempotent(tree):
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "momo", f"{THIRTY3GOD}/momo/skill")
    ops, reporter = relink(tmp_path, catalog)
    apply_relink(ops, reporter)
    after = snapshot(tmp_path / "sets")
    again, _ = relink(tmp_path, catalog)
    assert again == []
    assert snapshot(tmp_path / "sets") == after


def test_planning_alone_mutates_nothing(tree):
    tmp_path, catalog = tree
    sets = tmp_path / "sets" / "min-global"
    link(sets, "momo", f"{THIRTY3GOD}/momo/skill")
    before = snapshot(tmp_path / "sets")
    relink(tmp_path, catalog)
    assert snapshot(tmp_path / "sets") == before


def test_a_symlinked_set_directory_is_itself_a_candidate(tree):
    """`sets/hyperframes` is a symlinked set root in the live tree."""
    tmp_path, catalog = tree
    link(tmp_path / "sets", "aliased", f"{THIRTY3GOD}/momo/skill")
    ops, _ = relink(tmp_path, catalog)
    assert [(op.link.name, op.new) for op in ops] == [("aliased", "../all-skills/momo")]


def test_a_catalog_entry_with_no_receipt_still_matches_by_its_own_name(tmp_path):
    catalog = tmp_path / "all-skills"
    catalog.mkdir()
    write_source_skill(catalog, "hindsight")
    (tmp_path / "sets" / "s").mkdir(parents=True)
    link(tmp_path / "sets" / "s", "hindsight", "/somewhere/else/hindsight")
    reporter = Reporter()
    ops = plan_relink([tmp_path / "sets"], catalog, reporter)
    assert [op.new for op in ops] == ["../../all-skills/hindsight"]
