"""Applying a plan: staging, the atomic swap, and crash recovery."""

from __future__ import annotations

import os

import pytest

from skillex.core.diagnostics import Code, Reporter
from skillex.core.loader import load_sources_manifest
from skillex.core.payload import PayloadError
from skillex.core.provenance import SOURCE_YAML, read_provenance
from skillex.core.vendor import (
    apply_vendor,
    plan_vendor,
    recover_stage,
    stage_root,
    tree_digest,
)
from tests.conftest import snapshot
from tests.vendor_helpers import FakeGit, write_source_repo, write_source_skill

pytestmark = pytest.mark.usefixtures("sandbox")

REPO = "git@github.com:delorenj/pjangler.git"

BODY = f"""
version = 1

[[source]]
name = "pjangler"
repo = "{REPO}"
version = "main"
"""


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "catalog"
    path.mkdir()
    return path


def run(tmp_path, catalog, repo, git, *, body: str = BODY, **kw):
    path = tmp_path / "sources.toml"
    path.write_text(body, encoding="utf-8")
    manifest = load_sources_manifest(path)
    reporter = Reporter()
    plan = plan_vendor(catalog, manifest, reporter, reader=git, checkouts={"pjangler": repo}, **kw)
    assert not reporter.errors(), [f.message for f in reporter.errors()]
    apply_vendor(plan, reporter, reader=git)
    return plan, reporter


def test_a_fresh_vendor_lands_real_files_and_a_correct_receipt(tmp_path, catalog):
    repo = write_source_repo(
        tmp_path, "pjangler", skills={"mise-tasks": {"references/a.md": "hello"}}
    )
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)

    live = catalog / "mise-tasks"
    assert live.is_dir() and not live.is_symlink()
    assert (live / "SKILL.md").is_file()
    assert (live / "references" / "a.md").read_text() == "hello"

    prov = read_provenance(live)
    assert prov is not None
    assert prov.is_vendored
    assert prov.source == "pjangler"
    assert prov.upstream == REPO
    assert prov.upstream_version == "main"
    assert prov.upstream_commit == "0" * 40
    assert prov.upstream_path == "skills/mise-tasks"
    assert prov.modified_locally is False
    # The digest is computable, not a frozen guess.
    assert prov.digest == tree_digest(live)


def test_the_executable_bit_survives_the_round_trip(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {"scripts/go.sh": "#!/bin/sh\n"}})
    os.chmod(repo / "skills" / "a" / "scripts" / "go.sh", 0o755)
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    assert os.access(catalog / "a" / "scripts" / "go.sh", os.X_OK)


def test_an_existing_symlink_entry_is_replaced_by_real_content(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    os.symlink("/home/delorenj/code/33GOD/pjangler/skills/mise-tasks", catalog / "mise-tasks")
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    live = catalog / "mise-tasks"
    assert not live.is_symlink()
    assert (live / "SKILL.md").is_file()


def test_an_upstream_source_yaml_is_dropped_and_replaced_with_ours(tmp_path, catalog):
    """Two of the fifteen carry one claiming `type: local` about a foreign repo."""
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    (repo / "skills" / "a" / SOURCE_YAML).write_text("origin:\n  type: local\n")
    git = FakeGit()
    git.add(repo, tree=repo)
    _, reporter = run(tmp_path, catalog, repo, git)
    assert Code.W_VENDOR_DROPPED_SOURCE_YAML in {f.code for f in reporter.findings}
    prov = read_provenance(catalog / "a")
    assert prov is not None and prov.is_vendored


def test_a_re_run_writes_nothing(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    before = snapshot(catalog)
    plan, _ = run(tmp_path, catalog, repo, git)
    assert plan.writes == []
    assert snapshot(catalog) == before


def test_an_update_replaces_content_and_rewrites_the_receipt(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {"x.md": "one"}})
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    first = read_provenance(catalog / "a")

    moved = write_source_repo(tmp_path, "pjangler-v2", skills={"a": {"x.md": "two"}})
    git.retarget(repo, "main", commit="1" * 40, tree=moved)
    run(tmp_path, catalog, repo, git)

    second = read_provenance(catalog / "a")
    assert (catalog / "a" / "x.md").read_text() == "two"
    assert first is not None and second is not None
    assert second.upstream_commit == "1" * 40
    assert second.digest != first.digest


def test_an_update_removes_a_file_upstream_deleted(tmp_path, catalog):
    """The swap replaces the directory wholesale; it is not a merge."""
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {"gone.md": "x"}})
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    assert (catalog / "a" / "gone.md").exists()

    moved = write_source_repo(tmp_path, "v2", skills={"a": {}})
    git.retarget(repo, "main", commit="1" * 40, tree=moved)
    run(tmp_path, catalog, repo, git)
    assert not (catalog / "a" / "gone.md").exists()


def test_adopt_replaces_the_unmanaged_directory_wholesale(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {"upstream.md": "u"}})
    write_source_skill(catalog, "a", files={"local-only.md": "l"})
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git, adopt=True)
    assert (catalog / "a" / "upstream.md").is_file()
    assert not (catalog / "a" / "local-only.md").exists()
    prov = read_provenance(catalog / "a")
    assert prov is not None and prov.is_vendored


def test_prune_removes_the_directory(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}, "b": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    body = BODY + '\nskills = ["a"]\n'
    plan, _ = run(tmp_path, catalog, repo, git, body=body, prune=True)
    assert [op.name for op in plan.prunes] == ["b"]
    assert (catalog / "a").is_dir()
    assert not (catalog / "b").exists()


def test_the_stage_directory_is_removed_on_a_clean_run(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    run(tmp_path, catalog, repo, git)
    assert not stage_root(catalog).exists()


def test_a_failure_during_staging_leaves_the_catalog_untouched(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}, "b": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    path = tmp_path / "sources.toml"
    path.write_text(BODY, encoding="utf-8")
    manifest = load_sources_manifest(path)
    reporter = Reporter()
    plan = plan_vendor(catalog, manifest, reporter, reader=git, checkouts={"pjangler": repo})
    before = snapshot(catalog)

    calls = {"n": 0}
    real_export = git.export

    def boom(checkout, commit, source_path, dest):
        calls["n"] += 1
        if calls["n"] == 2:
            raise PayloadError("disk full")
        real_export(checkout, commit, source_path, dest)

    git.export = boom  # type: ignore[method-assign]
    with pytest.raises(PayloadError):
        apply_vendor(plan, reporter, reader=git)

    # Nothing was swapped, and the stage was cleaned up behind us.
    assert snapshot(catalog) == before
    assert not stage_root(catalog).exists()


def test_a_crash_between_the_two_renames_is_rolled_back_by_the_next_run(tmp_path, catalog):
    """The swap is live -> trash, then new -> live. A crash in the window leaves
    the entry ABSENT and its old content in trash; trash IS the receipt."""
    write_source_skill(catalog, "a", body="old content\n")
    run_dir = stage_root(catalog) / "12345"
    (run_dir / "new").mkdir(parents=True)
    (run_dir / "trash").mkdir(parents=True)
    os.replace(catalog / "a", run_dir / "trash" / "a")
    assert not (catalog / "a").exists()

    reporter = Reporter()
    assert recover_stage(catalog, reporter) is True
    assert (catalog / "a" / "SKILL.md").read_text() == "old content\n"
    assert not stage_root(catalog).exists()
    assert not reporter.findings


def test_recovery_leaves_a_destination_that_already_exists_alone(tmp_path, catalog):
    """A crash AFTER the second rename: live is correct, trash is just garbage."""
    write_source_skill(catalog, "a", body="new content\n")
    run_dir = stage_root(catalog) / "12345"
    (run_dir / "trash").mkdir(parents=True)
    write_source_skill(run_dir / "trash", "a", body="old content\n")

    reporter = Reporter()
    assert recover_stage(catalog, reporter) is True
    assert (catalog / "a" / "SKILL.md").read_text() == "new content\n"
    assert not stage_root(catalog).exists()


def test_an_unrecoverable_stage_refuses_rather_than_guessing(tmp_path, catalog, monkeypatch):
    run_dir = stage_root(catalog) / "12345"
    (run_dir / "trash").mkdir(parents=True)
    write_source_skill(run_dir / "trash", "a")

    def boom(src, dst):
        raise OSError("cross-device link")

    monkeypatch.setattr(os, "replace", boom)
    reporter = Reporter()
    assert recover_stage(catalog, reporter) is False
    assert Code.E_VENDOR_STAGE_DIRTY in {f.code for f in reporter.findings}
    assert stage_root(catalog).exists()


def test_recovery_on_a_clean_catalog_is_a_no_op(tmp_path, catalog):
    reporter = Reporter()
    assert recover_stage(catalog, reporter) is True
    assert not reporter.findings
