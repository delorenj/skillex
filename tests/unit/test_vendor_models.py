"""``sources.toml``'s models: what validates, what is refused, and why."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from skillex.core.models import (
    SourceEntry,
    SourceSkill,
    SourcesManifest,
    UnsupportedFieldError,
)

REPO = "git@github.com:delorenj/pjangler.git"


def entry(**overrides: object) -> SourceEntry:
    base: dict[str, object] = {"name": "pjangler", "repo": REPO, "version": "main"}
    base.update(overrides)
    return SourceEntry.model_validate(base)


# -- the default the user asked for -----------------------------------------


def test_subdir_defaults_to_the_repos_root_level_skills_directory():
    assert entry().subdir == "skills"
    assert entry().tree_path(SourceSkill(name="mise-tasks")) == "skills/mise-tasks"


def test_empty_subdir_means_the_repository_root():
    """momo has no skills/ at all; its single skill sits at the top level."""
    momo = entry(name="momo", subdir="", skills=[{"name": "momo", "dir": "skill"}])
    assert momo.tree_path(momo.skills[0]) == "skill"


# -- the two name hazards ----------------------------------------------------


def test_catalog_name_is_independent_of_the_source_directory():
    """momo: the directory is `skill`, the catalog name is `momo`."""
    skill = SourceSkill.from_spec({"name": "momo", "dir": "skill"})
    assert skill.name == "momo"
    assert skill.relpath == "skill"


def test_string_shorthand_uses_the_name_as_the_directory():
    skill = SourceSkill.from_spec("mise-tasks")
    assert (skill.name, skill.relpath) == ("mise-tasks", "mise-tasks")


def test_catalog_name_uses_the_projection_pattern_so_it_is_guaranteed_to_project():
    SourceSkill(name="33god-hub")
    SourceSkill(name="a.b_c")
    for bad in ("Bad", "a/b", "-x", "x-", ""):
        with pytest.raises(ValidationError):
            SourceSkill(name=bad)


def test_source_directory_must_be_one_safe_component():
    for bad in ("a/b", "..", ".", "", "a\\b"):
        with pytest.raises(ValidationError):
            SourceSkill(name="ok", dir=bad)


# -- field validation --------------------------------------------------------


def test_version_accepts_a_tag_a_branch_and_a_sha_but_not_a_range_or_a_flag():
    for good in ("v1.4.2", "main", "origin/main", "e3aab0b" * 5 + "abcde", "release/1.4"):
        entry(version=good)
    for bad in ("--upload-pack=x", "a..b", "", "-x"):
        with pytest.raises(ValidationError):
            entry(version=bad)


def test_repo_must_look_like_a_git_remote():
    for good in ("https://github.com/x/y", "git@github.com:x/y.git", "file:///tmp/x"):
        entry(repo=good)
    with pytest.raises(ValidationError, match="provenance identity"):
        entry(repo="/home/delorenj/code/33GOD")


def test_subdir_rejects_traversal():
    for bad in ("../x", "/abs", "a//b", "a/../b", "a\\b"):
        with pytest.raises(ValidationError):
            entry(subdir=bad)


def test_checkout_is_a_logical_id_not_a_path():
    assert entry(checkout="33GOD").checkout_id == "33GOD"
    assert entry().checkout_id == "pjangler"
    with pytest.raises(ValidationError, match="never a path"):
        entry(checkout="~/code/33GOD")


def test_two_sources_may_share_one_checkout():
    """33GOD owns skills at two unrelated paths: two sources, one working copy."""
    a = entry(name="33god-platform", checkout="33GOD", subdir="33god-platform/skills")
    b = entry(name="krebs", checkout="33GOD", subdir="krebs/skills")
    assert a.checkout_id == b.checkout_id == "33GOD"


def test_explicit_skills_and_include_exclude_are_mutually_exclusive():
    with pytest.raises(ValidationError, match="already the selection"):
        entry(skills=[{"name": "a"}], include=["a"])


def test_duplicate_catalog_names_inside_one_source_are_rejected():
    with pytest.raises(ValidationError, match="duplicate catalog name"):
        entry(skills=[{"name": "a"}, {"name": "a", "dir": "b"}])


def test_filter_inventory_applies_include_then_exclude_preserving_order():
    e = entry(include=["c", "a"], exclude=["a"])
    assert e.filter_inventory(["a", "b", "c"]) == ["c"]
    assert entry().filter_inventory(["b", "a"]) == ["b", "a"]


def test_models_are_frozen():
    with pytest.raises(ValidationError):
        entry().name = "other"  # type: ignore[misc]


# -- accept-and-refuse -------------------------------------------------------


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [
        ("clone", True, "never clones"),
        ("fetch", True, "never clones"),
        ("auto_fetch", True, "never clones"),
        ("url", "https://x/y", "Renamed to 'repo'"),
        ("ref", "main", "Renamed to 'version'"),
        ("path", "/home/x", "Ambiguous"),
    ],
)
def test_refused_fields_explain_themselves(field, value, needle):
    """A field in the neighbourhood of the schema is refused, never ignored."""
    spec = {"name": "x", "repo": REPO, "version": "main", field: value}
    with pytest.raises(UnsupportedFieldError, match=needle):
        SourceEntry.from_spec(spec)


def test_a_non_array_skills_field_is_a_plain_validation_error():
    with pytest.raises(ValueError, match="must be an array"):
        SourceEntry.from_spec({"name": "x", "repo": REPO, "version": "main", "skills": "a"})


def test_a_skills_entry_that_is_neither_a_string_nor_a_table_is_rejected():
    with pytest.raises(ValueError, match="string or a table"):
        SourceEntry.from_spec({"name": "x", "repo": REPO, "version": "main", "skills": [3]})


# -- manifest ----------------------------------------------------------------


def test_manifest_indexes_by_name_and_reports_emptiness(tmp_path):
    manifest = SourcesManifest(path=tmp_path / "sources.toml", sources=(entry(),))
    assert manifest.by_name()["pjangler"].repo == REPO
    assert not manifest.is_empty
    assert SourcesManifest(path=tmp_path / "s.toml").is_empty
