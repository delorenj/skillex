"""Preservation-first Skillex-only cutover regression tests; no live host writes."""

import importlib.util
from pathlib import Path

import pytest


def helper():
    source = Path(__file__).parents[2] / "scripts/hermes-skillex-cutover.py"
    spec = importlib.util.spec_from_file_location("cutover", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_preview_leaves_alias_and_shared_catalog_untouched(tmp_path):
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "SKILL.md").write_text("foreign")
    profile = tmp_path / "pm"
    profile.mkdir()
    (profile / "skills").symlink_to(shared, target_is_directory=True)
    plan = helper().plan_root(profile, set())
    assert plan["alias"]
    assert (profile / "skills").is_symlink()
    assert (shared / "SKILL.md").read_text() == "foreign"
    helper().preserve_root(profile, plan, tmp_path / "quarantine")
    assert not (profile / "skills").is_symlink()
    assert (profile / "skills").is_dir()
    assert (shared / "SKILL.md").read_text() == "foreign"
    assert (tmp_path / "quarantine" / "skills-alias").is_symlink()


def test_real_root_and_owned_child_survive_preservation(tmp_path):
    profile = tmp_path / "pm"
    root = profile / "skills"
    root.mkdir(parents=True)
    target = tmp_path / "canonical"
    target.mkdir()
    (root / "owned").symlink_to(target)
    (root / "foreign").mkdir()
    (root / "foreign" / "SKILL.md").write_text("keep me")
    ino = root.stat().st_ino
    child = (root / "owned").lstat().st_ino
    module = helper()
    plan = module.plan_root(profile, {"owned"})
    module.preserve_root(profile, plan, tmp_path / "quarantine")
    assert root.stat().st_ino == ino
    assert (root / "owned").lstat().st_ino == child
    assert (tmp_path / "quarantine" / "foreign" / "SKILL.md").read_text() == "keep me"


def test_changed_preview_refuses_before_mutation(tmp_path):
    profile = tmp_path / "pm"
    root = profile / "skills"
    root.mkdir(parents=True)
    (root / "foreign").write_text("old")
    module = helper()
    plan = module.plan_root(profile, set())
    (root / "foreign").write_text("new content")
    with pytest.raises(RuntimeError, match="changed"):
        module.preserve_root(profile, plan, tmp_path / "quarantine")
    assert (root / "foreign").read_text() == "new content"
    assert not (tmp_path / "quarantine").exists()


def test_config_only_changes_skill_roots(tmp_path):
    module = helper()
    delta = {"voice": {"enabled": True}}
    updated = module.skill_delta(delta)
    assert updated == {"voice": {"enabled": True}, "skills": {"external_dirs": []}}
    assert delta == {"voice": {"enabled": True}}


def test_hermes_bookkeeping_is_not_quarantined_but_archives_are(tmp_path):
    profile = tmp_path / "pm"
    root = profile / "skills"
    (root / ".curator_backups" / "2026-10-01").mkdir(parents=True)
    for name in (".curator_state", ".curator_suppressed", ".sync_state", ".usage.json"):
        (root / name).write_text("{}")
    (root / ".archive" / "old").mkdir(parents=True)
    (root / ".hub").mkdir()
    real = tmp_path / "real-state"
    real.write_text("{}")
    (root / ".sync_state").unlink()
    (root / ".sync_state").symlink_to(real)
    plan = helper().plan_root(profile, set())
    assert sorted(plan["children"]) == [".archive", ".hub", ".sync_state"]
