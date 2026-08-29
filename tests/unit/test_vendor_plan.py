"""Planning: enumeration, the refusals, and "any error means zero mutation".

Every test here uses :class:`~tests.vendor_helpers.FakeGit` over directories in
``tmp_path``. Nothing touches the network, a git binary, or ``~/code/33GOD``.
"""

from __future__ import annotations

import os

import pytest

from skillex.core.diagnostics import EXIT_CONFIG, EXIT_REFUSED, Code, Reporter, exit_code_for
from skillex.core.loader import load_sources_manifest
from skillex.core.provenance import Provenance, write_provenance
from skillex.core.vendor import VendorAction, plan_vendor, tree_digest
from tests.conftest import snapshot
from tests.vendor_helpers import FakeGit, write_source_repo, write_source_skill

pytestmark = pytest.mark.usefixtures("sandbox")

REPO = "git@github.com:delorenj/pjangler.git"


def codes(reporter: Reporter) -> list[str]:
    return [f.code.value for f in reporter.findings]


def manifest_at(tmp_path, body: str):
    path = tmp_path / "sources.toml"
    path.write_text(body, encoding="utf-8")
    return load_sources_manifest(path)


def one_source(name="pjangler", **fields) -> str:
    lines = [
        "version = 1",
        "",
        "[[source]]",
        f'name = "{name}"',
        f'repo = "{REPO}"',
        'version = "main"',
    ]
    lines.extend(f"{k} = {v}" for k, v in fields.items())
    return "\n".join(lines) + "\n"


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "catalog"
    path.mkdir()
    return path


def plan_with(catalog, manifest, git, checkouts, **kw):
    reporter = Reporter()
    plan = plan_vendor(catalog, manifest, reporter, reader=git, checkouts=checkouts, **kw)
    return plan, reporter


# -- discovery, which is the default ----------------------------------------


def test_discovery_takes_every_skill_under_the_default_skills_directory(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}, "pjangler-dev": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    assert [(op.name, op.action) for op in plan.ops] == [
        ("mise-tasks", VendorAction.CREATE),
        ("pjangler-dev", VendorAction.CREATE),
    ]
    assert plan.ops[0].repo_path == "skills/mise-tasks"
    assert not reporter.errors()


def test_dot_and_underscore_prefixed_directories_are_never_skills(tmp_path, catalog):
    """pjangler/skills/.system/ exists and must not be vendored."""
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    (repo / "skills" / ".system").mkdir()
    (repo / "skills" / ".system" / "SKILL.md").write_text("x")
    (repo / "skills" / "_scratch").mkdir()
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, _ = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert [op.name for op in plan.ops] == ["mise-tasks"]


def test_include_then_exclude_narrows_discovery(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}, "b": {}, "c": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    body = one_source(include='["c", "a"]', exclude='["a"]')
    plan, _ = plan_with(catalog, manifest_at(tmp_path, body), git, {"pjangler": repo})
    assert [op.name for op in plan.ops] == ["c"]


# -- the two name hazards ----------------------------------------------------


def test_momo_projects_its_declared_name_not_its_directory_basename(tmp_path, catalog):
    repo = tmp_path / "momo"
    write_source_skill(repo, "skill", body="---\nname: momo\n---\n# momo\n")
    git = FakeGit()
    git.add(repo, tree=repo)
    body = one_source("momo", subdir='""', skills='[{ name = "momo", dir = "skill" }]')
    plan, reporter = plan_with(catalog, manifest_at(tmp_path, body), git, {"momo": repo})
    assert [(op.name, op.repo_path) for op in plan.ops] == [("momo", "skill")]
    assert not reporter.errors()


def test_the_frontmatter_name_is_never_consulted(tmp_path, catalog):
    """project-jangler's SKILL.md says `name: pjangler`; the catalog name wins."""
    repo = tmp_path / "pjangler"
    write_source_skill(repo / "skills", "project-jangler", body="---\nname: pjangler\n---\n# pj\n")
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, _ = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert [op.name for op in plan.ops] == ["project-jangler"]


# -- the refusals ------------------------------------------------------------


def test_a_symlink_farm_is_refused_and_nothing_is_planned(tmp_path, catalog):
    """33GOD/skills/ is sixteen mode-120000 blobs. Declaring it must fail loudly."""
    repo = tmp_path / "33GOD"
    (repo / "skills").mkdir(parents=True)
    real = write_source_skill(repo / "real", "hub")
    os.symlink(real, repo / "skills" / "hub")
    git = FakeGit()
    git.add(repo, tree=repo)
    before = snapshot(catalog)

    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source("33god")), git, {"33god": repo}
    )

    assert Code.E_SOURCE_ENTRY_IS_LINK.value in codes(reporter)
    assert plan.ops == []
    assert exit_code_for(reporter.findings) == EXIT_REFUSED
    assert snapshot(catalog) == before
    finding = next(f for f in reporter.findings if f.code is Code.E_SOURCE_ENTRY_IS_LINK)
    assert finding.fix and "[[source]]" in finding.fix


def test_a_symlink_nested_inside_an_otherwise_valid_skill_is_refused(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    os.symlink(tmp_path, repo / "skills" / "mise-tasks" / "refs")
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    assert Code.E_SOURCE_ENTRY_IS_LINK.value in codes(reporter)
    assert plan.ops == []


def test_a_nested_submodule_names_itself_and_says_to_declare_it_separately(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "33GOD", skills={"pjangler": {}})
    git = FakeGit()
    git.add(repo, tree=repo, gitlinks={"skills/pjangler"})
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source("33god")), git, {"33god": repo}
    )
    finding = next(f for f in reporter.findings if f.code is Code.E_SOURCE_ENTRY_IS_SUBMODULE)
    assert "pjangler" in finding.message
    assert finding.fix and "its own [[source]]" in finding.fix
    assert plan.ops == []


def test_a_directory_without_skill_md_is_refused(tmp_path, catalog):
    repo = tmp_path / "pjangler"
    (repo / "skills" / "notaskill").mkdir(parents=True)
    (repo / "skills" / "notaskill" / "README.md").write_text("x")
    git = FakeGit()
    git.add(repo, tree=repo)
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert Code.E_SOURCE_NOT_A_SKILL.value in codes(reporter)


def test_a_missing_subdir_is_a_config_error_with_the_command_to_check_it(tmp_path, catalog):
    repo = tmp_path / "pjangler"
    repo.mkdir()
    (repo / "other").mkdir()
    git = FakeGit()
    git.add(repo, tree=repo)
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    finding = next(f for f in reporter.findings if f.code is Code.E_SOURCE_SUBDIR_MISSING)
    assert finding.fix and "ls-tree" in finding.fix
    assert exit_code_for(reporter.findings) == EXIT_CONFIG


def test_an_explicitly_declared_skill_that_does_not_exist_is_a_config_error(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    body = one_source(skills='["a", "gone"]')
    _, reporter = plan_with(catalog, manifest_at(tmp_path, body), git, {"pjangler": repo})
    assert Code.E_SOURCE_SKILL_MISSING.value in codes(reporter)


def test_a_missing_checkout_refuses_and_prints_the_clone_to_run(tmp_path, catalog):
    git = FakeGit()
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {})
    finding = next(f for f in reporter.findings if f.code is Code.E_SOURCE_CHECKOUT_MISSING)
    assert finding.fix and "skillex never clones" in finding.fix
    assert finding.fix and "git clone" in finding.fix
    assert exit_code_for(reporter.findings) == EXIT_REFUSED


def test_an_optional_source_downgrades_a_missing_checkout_and_others_still_run(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    body = (
        one_source()
        + f'\n[[source]]\nname = "gone"\nrepo = "{REPO}"\nversion = "main"\noptional = true\n'
    )
    plan, reporter = plan_with(catalog, manifest_at(tmp_path, body), git, {"pjangler": repo})
    assert Code.W_SOURCE_OPTIONAL_MISSING.value in codes(reporter)
    assert not reporter.errors()
    assert [op.name for op in plan.ops] == ["a"]
    assert [r.skipped for r in plan.resolutions] == [False, True]


def test_an_unresolvable_version_says_to_fetch_it_yourself(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo, refs={"other": "0" * 40})
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    finding = next(f for f in reporter.findings if f.code is Code.E_SOURCE_REF_UNKNOWN)
    assert finding.fix and "git -C" in finding.fix and "fetch" in finding.fix
    assert finding.fix and "will not fetch for you" in finding.fix


def test_a_checkout_that_is_not_a_repository_is_refused(tmp_path, catalog):
    plain = tmp_path / "plain"
    plain.mkdir()
    _, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), FakeGit(), {"pjangler": plain}
    )
    assert Code.E_SOURCE_NOT_A_REPO.value in codes(reporter)


def test_two_sources_claiming_one_catalog_name_collide(tmp_path, catalog):
    a = write_source_repo(tmp_path, "a", skills={"dup": {}})
    b = write_source_repo(tmp_path, "b", skills={"dup": {}})
    git = FakeGit()
    git.add(a, tree=a)
    git.add(b, tree=b)
    body = one_source("a") + f'\n[[source]]\nname = "b"\nrepo = "{REPO}"\nversion = "main"\n'
    plan, reporter = plan_with(catalog, manifest_at(tmp_path, body), git, {"a": a, "b": b})
    assert Code.E_VENDOR_NAME_COLLISION.value in codes(reporter)
    assert exit_code_for(reporter.findings) == EXIT_CONFIG
    assert [op.name for op in plan.ops] == ["dup"]  # the first claim still planned


def test_an_unknown_source_selection_lists_what_is_declared(tmp_path, catalog):
    git = FakeGit()
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {}, select=("nope",))
    finding = next(f for f in reporter.findings if f.code is Code.E_SOURCE_UNKNOWN)
    assert finding.fix and "pjangler" in finding.fix


def test_a_catalog_that_is_a_symlink_is_refused(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    os.symlink(real, link)
    _, reporter = plan_with(link, manifest_at(tmp_path, one_source()), FakeGit(), {})
    assert Code.E_VENDOR_CATALOG_INVALID.value in codes(reporter)


# -- classification ----------------------------------------------------------


def test_an_existing_symlink_entry_is_classified_as_replace_link(tmp_path, catalog):
    """The starting state of all fifteen."""
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    os.symlink("/home/delorenj/code/33GOD/pjangler/skills/mise-tasks", catalog / "mise-tasks")
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    assert [op.action for op in plan.ops] == [VendorAction.REPLACE_LINK]
    assert not reporter.errors()


def test_unmanaged_local_content_is_never_silently_overwritten(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    write_source_skill(catalog, "mise-tasks", body="local hand-written content\n")
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    finding = next(f for f in reporter.findings if f.code is Code.E_VENDOR_WOULD_CLOBBER)
    assert finding.fix and "--adopt" in finding.fix
    assert plan.ops == []


def test_adopt_takes_over_unmanaged_content_only_when_asked(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    write_source_skill(catalog, "mise-tasks", body="local\n")
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}, adopt=True
    )
    assert [op.action for op in plan.ops] == [VendorAction.ADOPT]
    assert not reporter.errors()


def test_a_loose_file_where_a_skill_should_go_is_refused(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    (catalog / "mise-tasks").write_text("not a directory")
    git = FakeGit()
    git.add(repo, tree=repo)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    assert Code.E_VENDOR_WOULD_CLOBBER.value in codes(reporter)
    assert plan.ops == []


def vendored_copy(catalog, repo, git, name="mise-tasks", source="pjangler", commit="0" * 40):
    """Put a correctly-vendored copy of one skill in the catalog."""
    import shutil

    shutil.copytree(repo / "skills" / name, catalog / name)
    digest = tree_digest(catalog / name)
    write_provenance(
        catalog / name,
        Provenance(
            type="vendored",
            source=source,
            upstream=REPO,
            upstream_version="main",
            upstream_commit=commit,
            upstream_tree=git.tree_oid(repo, commit, f"skills/{name}"),
            upstream_path=f"skills/{name}",
            digest=digest,
        ),
    )
    return catalog / name


def test_an_unchanged_vendored_skill_is_a_no_op(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git)
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    assert [op.action for op in plan.ops] == [VendorAction.UNCHANGED]
    assert plan.writes == []
    assert not reporter.errors()


def test_an_upstream_move_is_an_update(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git)
    (repo / "skills" / "mise-tasks" / "SKILL.md").write_text("---\nname: mise-tasks\n---\nnew\n")
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    assert [op.action for op in plan.ops] == [VendorAction.UPDATE]
    assert not reporter.errors()


def test_a_locally_edited_vendored_skill_is_refused_and_names_the_repo(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    live = vendored_copy(catalog, repo, git)
    (live / "SKILL.md").write_text("---\nname: mise-tasks\n---\nhand edited\n")
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}
    )
    finding = next(f for f in reporter.findings if f.code is Code.E_VENDOR_LOCAL_EDITS)
    assert REPO in (finding.fix or "")
    assert finding.detail and any("on disk" in line for line in finding.detail)
    assert plan.ops == []


def test_force_discards_a_local_edit_only_when_asked(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"mise-tasks": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    live = vendored_copy(catalog, repo, git)
    (live / "SKILL.md").write_text("---\nname: mise-tasks\n---\nhand edited\n")
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo}, force=True
    )
    assert [op.action for op in plan.ops] == [VendorAction.UPDATE]
    assert not reporter.errors()


# -- orphans -----------------------------------------------------------------


def test_a_name_a_source_no_longer_declares_is_reported_not_removed(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}, "b": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git, name="a")
    vendored_copy(catalog, repo, git, name="b")
    body = one_source(skills='["a"]')
    plan, reporter = plan_with(catalog, manifest_at(tmp_path, body), git, {"pjangler": repo})
    assert Code.W_VENDOR_ORPHANED.value in codes(reporter)
    assert plan.prunes == []


def test_prune_removes_an_orphan_only_when_it_still_matches_its_pin(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}, "b": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git, name="a")
    vendored_copy(catalog, repo, git, name="b")
    body = one_source(skills='["a"]')
    plan, _ = plan_with(catalog, manifest_at(tmp_path, body), git, {"pjangler": repo}, prune=True)
    assert [op.name for op in plan.prunes] == ["b"]


def test_a_locally_edited_orphan_is_never_pruned(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}, "b": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git, name="a")
    live = vendored_copy(catalog, repo, git, name="b")
    (live / "SKILL.md").write_text("edited\n")
    body = one_source(skills='["a"]')
    plan, reporter = plan_with(
        catalog, manifest_at(tmp_path, body), git, {"pjangler": repo}, prune=True
    )
    assert plan.prunes == []
    assert Code.E_VENDOR_LOCAL_EDITS.value in codes(reporter)


def test_an_unreachable_source_never_orphans_its_own_skills(tmp_path, catalog):
    """A failure to READ must never look like a decision to DROP -- under --prune
    that would delete every skill the source owns."""
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git, name="a")
    plan, reporter = plan_with(
        catalog,
        manifest_at(tmp_path, one_source()),
        git,
        {"pjangler": tmp_path / "gone"},
        prune=True,
    )
    assert Code.E_SOURCE_CHECKOUT_MISSING.value in codes(reporter)
    assert Code.W_VENDOR_ORPHANED.value not in codes(reporter)
    assert plan.prunes == []


def test_a_skill_owned_by_another_source_is_not_an_orphan(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo)
    vendored_copy(catalog, repo, git, name="a", source="someone-else")
    _, reporter = plan_with(
        catalog, manifest_at(tmp_path, one_source(skills="[]")), git, {"pjangler": repo}
    )
    assert Code.W_VENDOR_ORPHANED.value not in codes(reporter)


# -- advisory warnings -------------------------------------------------------


def test_a_branch_version_warns_that_the_pin_moves(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo, kinds={"main": "branch"})
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert Code.W_SOURCE_REF_IS_BRANCH.value in codes(reporter)


def test_a_tag_version_does_not_warn(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo, kinds={"main": "tag"})
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert Code.W_SOURCE_REF_IS_BRANCH.value not in codes(reporter)


def test_a_remote_that_disagrees_with_the_manifest_warns(tmp_path, catalog):
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo, origin="git@github.com:someone/else.git")
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert Code.W_SOURCE_REMOTE_MISMATCH.value in codes(reporter)


def test_the_same_repo_spelled_two_ways_does_not_warn(tmp_path, catalog):
    """`.gitmodules` and `remote.origin.url` disagree about `.git` for momo."""
    repo = write_source_repo(tmp_path, "pjangler", skills={"a": {}})
    git = FakeGit()
    git.add(repo, tree=repo, origin="https://github.com/delorenj/pjangler")
    _, reporter = plan_with(catalog, manifest_at(tmp_path, one_source()), git, {"pjangler": repo})
    assert Code.W_SOURCE_REMOTE_MISMATCH.value not in codes(reporter)
