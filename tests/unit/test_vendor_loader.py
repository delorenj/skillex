"""``load_sources_manifest``: the TOML idiom, and how each failure is reported."""

from __future__ import annotations

import pytest

from skillex.core.loader import SourcesError, SourcesParseError, load_sources_manifest
from skillex.core.models import UnsupportedFieldError

#: The declaration this feature was built for: four repositories, five skill
#: roots, seventeen skills. Kept here verbatim so a change to the models that
#: would break the real migration breaks a test first.
REAL_SOURCES = """
version = 1

[[source]]
name    = "pjangler"
repo    = "git@github.com:delorenj/pjangler.git"
version = "v1.4.2"
skills  = [
  "agent-fleet-operations",
  "hermes-pm-template-maintenance",
  "mise-task-managing",
  "mise-tasks",
  "mise-versioning",
  "pjangler-dev",
  "pjangler-parity-rules",
  "project-jangler",
  "projects",
]

[[source]]
name    = "bloodbank"
repo    = "git@github.com:delorenj/bloodbank.git"
version = "main"
skills  = ["bloodbank-integration", "bloodbank-sdk-generation"]

[[source]]
name    = "momo"
repo    = "git@github.com:delorenj/momo.git"
version = "main"
subdir  = ""
skills  = [{ name = "momo", dir = "skill" }]

[[source]]
name     = "33god-platform"
repo     = "git@github.com:delorenj/33GOD.git"
version  = "main"
checkout = "33GOD"
subdir   = "33god-platform/skills"
skills   = ["33god-hub", "merge-forward", "skillex-skill-registry"]

[[source]]
name     = "krebs"
repo     = "git@github.com:delorenj/33GOD.git"
version  = "main"
checkout = "33GOD"
subdir   = "krebs/skills"
skills   = ["project-lifecycle", "task-triage"]
"""


def write(tmp_path, body: str):
    path = tmp_path / "sources.toml"
    path.write_text(body, encoding="utf-8")
    return path


def test_the_real_declaration_parses(tmp_path):
    manifest = load_sources_manifest(write(tmp_path, REAL_SOURCES))
    assert [s.name for s in manifest.sources] == [
        "pjangler",
        "bloodbank",
        "momo",
        "33god-platform",
        "krebs",
    ]
    assert sum(len(s.skills) for s in manifest.sources) == 17
    by_name = manifest.by_name()
    assert by_name["momo"].subdir == ""
    assert by_name["momo"].tree_path(by_name["momo"].skills[0]) == "skill"
    assert by_name["krebs"].checkout_id == by_name["33god-platform"].checkout_id == "33GOD"
    # The default the user asked for, unstated in four of the five blocks.
    assert by_name["pjangler"].subdir == "skills"


def test_a_missing_file_names_the_path(tmp_path):
    with pytest.raises(SourcesError, match="sources manifest not found"):
        load_sources_manifest(tmp_path / "nope.toml")


def test_broken_toml_is_a_parse_error_carrying_the_path(tmp_path):
    path = write(tmp_path, "[[source]\nname = ")
    with pytest.raises(SourcesParseError, match=str(path)):
        load_sources_manifest(path)


def test_a_parse_error_is_still_a_sources_error(tmp_path):
    """Subclassed so every ``except SourcesError`` keeps catching it."""
    with pytest.raises(SourcesError):
        load_sources_manifest(write(tmp_path, "="))


def test_source_must_be_an_array_of_tables(tmp_path):
    with pytest.raises(SourcesError, match="array of tables"):
        load_sources_manifest(write(tmp_path, 'source = "pjangler"'))


def test_version_must_be_an_integer(tmp_path):
    with pytest.raises(SourcesError, match="'version' must be an integer"):
        load_sources_manifest(write(tmp_path, 'version = "one"'))


def test_a_field_validation_failure_names_the_index(tmp_path):
    body = '[[source]]\nname = "a"\nrepo = "git@x:y"\nversion = "a..b"\n'
    with pytest.raises(SourcesError, match=r"invalid source\[0\]"):
        load_sources_manifest(write(tmp_path, body))


def test_a_refused_field_is_re_raised_verbatim_with_the_cause_intact(tmp_path):
    body = '[[source]]\nname = "a"\nrepo = "git@x:y"\nversion = "m"\nclone = true\n'
    with pytest.raises(SourcesError, match="never clones") as excinfo:
        load_sources_manifest(write(tmp_path, body))
    # The command layer keys E_UNSUPPORTED_FIELD off exactly this.
    assert isinstance(excinfo.value.__cause__, UnsupportedFieldError)


def test_duplicate_source_names_are_rejected(tmp_path):
    block = '[[source]]\nname = "a"\nrepo = "git@x:y"\nversion = "m"\n'
    with pytest.raises(SourcesError, match="duplicate source name"):
        load_sources_manifest(write(tmp_path, block + block))


def test_unknown_top_level_keys_are_recorded_not_rejected(tmp_path):
    manifest = load_sources_manifest(write(tmp_path, 'version = 1\nsorce = "typo"\n'))
    assert manifest.unknown_keys == ("sorce",)


def test_an_empty_manifest_is_legal(tmp_path):
    assert load_sources_manifest(write(tmp_path, "version = 1\n")).is_empty
