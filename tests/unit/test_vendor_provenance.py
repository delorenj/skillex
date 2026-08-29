"""``.source.yaml``: the four shapes already on disk, and the one this writes."""

from __future__ import annotations

from skillex.core.provenance import (
    HEADER,
    SOURCE_YAML,
    Provenance,
    parse_provenance,
    read_provenance,
    render_provenance,
    write_provenance,
)

# The shapes measured in the live catalog, reproduced verbatim. Every one must
# parse; a reader that crashes on the 121-instance shape is unusable.
LOCAL = """\
# Provenance for this skill. Managed by skill_ssot.py.
origin:
  type: local
  extracted_at: 2026-05-16T08:07:42+00:00
modified_locally: false
"""

LOCAL_NO_STAMP = "origin:\n  type: local\nmodified_locally: false\n"

ADHOC_RESCUED = """\
origin:
  type: adhoc
  extracted_at: 2026-08-11T16:04:15+00:00
  rescued_from: "/home/delorenj/code/skillex/skill-sets/global/orchestration"
modified_locally: false
"""

ADHOC_AUTHORED = """\
origin:
  type: adhoc
  extracted_at: 2026-08-04T00:00:00+00:00
  authored_in: "/home/delorenj/code/33GOD/skills/skillex-skill-registry"
modified_locally: false
"""

#: The one hand-written `vendored` record in the catalog -- the shape this
#: feature extends rather than replaces.
EGO_BROWSER = """\
# Provenance for this skill. Managed by skill_ssot.py.
origin:
  type: vendored
  upstream: https://github.com/citrolabs/ego-lite
  upstream_version: v1.2.3
  extracted_at: 2026-08-14T00:00:00+00:00
modified_locally: true
notes: >
  Upstream is macOS-only. references/upstream-SKILL.md is verbatim upstream.
"""

FLOW_STYLE = "origin: {type: local, extracted_at: 2026-05-16T08:07:42+00:00}\n"


def test_every_shape_in_the_live_catalog_parses():
    assert parse_provenance(LOCAL).type == "local"
    assert parse_provenance(LOCAL_NO_STAMP).extracted_at is None
    assert parse_provenance(ADHOC_RESCUED).type == "adhoc"
    assert parse_provenance(ADHOC_AUTHORED).type == "adhoc"
    assert parse_provenance(FLOW_STYLE).type == "local"


def test_the_existing_vendored_record_parses_and_keeps_its_keys():
    prov = parse_provenance(EGO_BROWSER)
    assert prov is not None
    assert prov.is_vendored
    assert prov.upstream == "https://github.com/citrolabs/ego-lite"
    assert prov.upstream_version == "v1.2.3"
    assert prov.modified_locally is True
    assert prov.notes and "macOS-only" in prov.notes
    # The three keys it lacks are exactly the gap this feature closes.
    assert prov.upstream_commit is None
    assert prov.upstream_path is None
    assert prov.digest is None


def test_a_record_that_does_not_parse_degrades_to_none_and_never_raises():
    assert parse_provenance("origin: [unclosed") is None
    assert parse_provenance("just a string") is None
    assert parse_provenance("") is None
    assert parse_provenance("origin: 3\nmodified_locally: 7\n") is not None


def test_a_missing_or_unreadable_file_degrades_to_none(tmp_path):
    assert read_provenance(tmp_path) is None
    (tmp_path / SOURCE_YAML).write_bytes(b"\xff\xfe truncated")
    assert read_provenance(tmp_path) is None


def test_round_trip_preserves_every_field(tmp_path):
    prov = Provenance(
        type="vendored",
        source="pjangler",
        upstream="git@github.com:delorenj/pjangler.git",
        upstream_version="v1.4.2",
        upstream_commit="e" * 40,
        upstream_tree="a" * 40,
        upstream_path="skills/mise-tasks",
        extracted_at="2026-08-29T00:00:00+00:00",
        digest="sha256:" + "b" * 64,
        modified_locally=False,
        notes="a note",
    )
    write_provenance(tmp_path, prov)
    assert read_provenance(tmp_path) == prov


def test_the_header_names_this_tool_and_not_the_dead_script(tmp_path):
    write_provenance(tmp_path, Provenance(type="vendored"))
    body = (tmp_path / SOURCE_YAML).read_text()
    assert body.startswith(HEADER)
    assert "skillex vendor" in body
    assert "skill_ssot" not in body


def test_writing_is_not_write_once(tmp_path):
    """``skill_ssot.py:92`` returned early when the file existed, freezing every
    claim at extraction time. That is the bug; this must not reproduce it."""
    write_provenance(tmp_path, Provenance(type="vendored", upstream_commit="a" * 40))
    write_provenance(tmp_path, Provenance(type="vendored", upstream_commit="b" * 40))
    prov = read_provenance(tmp_path)
    assert prov is not None and prov.upstream_commit == "b" * 40


def test_scalars_that_would_confuse_yaml_are_quoted():
    body = render_provenance(
        Provenance(
            type="vendored",
            upstream="git@github.com:delorenj/momo.git",
            digest="sha256:abc",
            extracted_at="2026-08-29T00:00:00+00:00",
        )
    )
    parsed = parse_provenance(body)
    assert parsed is not None
    assert parsed.upstream == "git@github.com:delorenj/momo.git"
    assert parsed.digest == "sha256:abc"
    assert parsed.extracted_at == "2026-08-29T00:00:00+00:00"


def test_absent_fields_are_omitted_rather_than_written_as_null():
    body = render_provenance(Provenance(type="local"))
    assert "upstream" not in body
    assert "null" not in body
    assert "modified_locally: false" in body
