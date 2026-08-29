"""``tree_digest``: what it is sensitive to, and what it deliberately is not."""

from __future__ import annotations

import os

import pytest

from skillex.core.payload import PayloadError
from skillex.core.provenance import SOURCE_YAML, Provenance, write_provenance
from skillex.core.vendor import tree_digest
from tests.vendor_helpers import write_source_skill


def test_the_digest_is_stable_across_creation_order(tmp_path):
    a = write_source_skill(tmp_path / "a", "s", files={"x.md": "1", "refs/y.md": "2"})
    b = tmp_path / "b" / "s"
    b.mkdir(parents=True)
    (b / "refs").mkdir()
    (b / "refs" / "y.md").write_text("2")
    (b / "x.md").write_text("1")
    (b / "SKILL.md").write_text((a / "SKILL.md").read_text())
    assert tree_digest(a) == tree_digest(b)


def test_the_executable_bit_is_in_the_digest(tmp_path):
    """Skills ship scripts/. A lost +x is a real breakage a bytes-only digest
    cannot see, which is why this is not just render_sha256sums."""
    skill = write_source_skill(tmp_path, "s", files={"scripts/go.sh": "#!/bin/sh\n"})
    plain = tree_digest(skill)
    os.chmod(skill / "scripts" / "go.sh", 0o755)
    assert tree_digest(skill) != plain


def test_any_content_change_moves_the_digest(tmp_path):
    skill = write_source_skill(tmp_path, "s", files={"x.md": "one"})
    before = tree_digest(skill)
    (skill / "x.md").write_text("two")
    assert tree_digest(skill) != before


def test_a_new_or_removed_file_moves_the_digest(tmp_path):
    skill = write_source_skill(tmp_path, "s")
    before = tree_digest(skill)
    (skill / "extra.md").write_text("")
    after = tree_digest(skill)
    assert after != before
    (skill / "extra.md").unlink()
    assert tree_digest(skill) == before


def test_the_root_source_yaml_is_excluded_so_writing_it_is_not_a_fixpoint(tmp_path):
    skill = write_source_skill(tmp_path, "s")
    before = tree_digest(skill)
    write_provenance(skill, Provenance(type="vendored", digest=before))
    assert tree_digest(skill) == before


def test_a_nested_source_yaml_is_still_content(tmp_path):
    """Only the ROOT one is ours; one inside references/ is the skill's own."""
    skill = write_source_skill(tmp_path, "s")
    before = tree_digest(skill)
    (skill / "refs").mkdir()
    (skill / "refs" / SOURCE_YAML).write_text("x")
    assert tree_digest(skill) != before


def test_a_symlink_anywhere_inside_is_refused_not_followed(tmp_path):
    skill = write_source_skill(tmp_path, "s")
    (tmp_path / "elsewhere.md").write_text("x")
    os.symlink(tmp_path / "elsewhere.md", skill / "link.md")
    with pytest.raises(PayloadError, match="may not contain symlinks"):
        tree_digest(skill)


def test_a_symlinked_subdirectory_is_refused(tmp_path):
    skill = write_source_skill(tmp_path, "s")
    (tmp_path / "other").mkdir()
    os.symlink(tmp_path / "other", skill / "refs")
    with pytest.raises(PayloadError, match="may not contain symlinks"):
        tree_digest(skill)


def test_an_empty_directory_digests_without_crashing(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert tree_digest(empty).startswith("sha256:")
