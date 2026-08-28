"""Scope discovery: which activation roots one `skillex sync` invocation writes.

Covers AC 6 ("no manifest in the cwd -> global is assumed") and AC 7 ("a project
manifest -> both project and global") exhaustively, plus the four guards that keep
the upward walk from producing something absurd:

* the walk STOPS at ``$HOME`` (otherwise ``$HOME/.agents/skills.json`` makes every
  directory under home "a project" whose root IS the global root);
* ``~/.agents`` and everything beneath it is never a project;
* a git repo with no manifest is not a skillex project, and syncing from inside one
  must not create a ``.agents/`` nobody asked for;
* a manifest inside a registry's source trees is a refusal, not a target.

The deep-cwd test is a REGRESSION test: the incumbent ``pack activate --scope
project`` used a raw ``Path.cwd()`` and would have projected into
``<repo>/src/a/b/c/.agents/skills``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from skillex.core.diagnostics import EXIT_CONFIG, EXIT_OK, EXIT_REFUSED, Code, RefusalError
from skillex.core.scope import (
    MANIFEST_RELPATH,
    ScopeKind,
    discover_scopes,
    find_project,
    is_registry_internal,
    is_within,
    probe_child_projects,
    refused_roots,
)
from skillex.paths import find_manifest_root, registry_roots
from tests.conftest import Sandbox, codes_in, write_manifest

# ---------------------------------------------------------------------------
# local fixtures + helpers - shapes unique to this file
# ---------------------------------------------------------------------------


def deep(root: Path, *parts: str) -> Path:
    """``root/<parts...>``, created. The ``<repo>/src/a/b/c`` shape."""
    path = root.joinpath(*parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


def scope_labels(plan) -> list[str]:
    return [s.label for s in plan.scopes]


def json_scopes(payload) -> list[str]:
    return [s["scope"] for s in payload["scopes"]]


def registry_internal_project(registry: Path, *parts: str) -> Path:
    """A directory inside the registry that carries its own ``.agents/skills.json``."""
    victim = registry.joinpath(*parts)
    victim.mkdir(parents=True, exist_ok=True)
    write_manifest(victim, {})
    return victim


# ===========================================================================
# is_within - lexical, filesystem-free, prefix-safe
# ===========================================================================


@pytest.mark.parametrize(
    ("path", "ancestor", "expected"),
    [
        (Path("/a/b/c"), Path("/a/b"), True),
        (Path("/a/b"), Path("/a/b"), True),  # a path is within itself
        (Path("/a/b/c/d/e"), Path("/a"), True),
        (Path("/a"), Path("/a/b"), False),  # ancestor is the deeper one
        (Path("/x/y"), Path("/a/b"), False),
        (Path("/a/bc"), Path("/a/b"), False),  # NAME PREFIX, not a child
        (Path("/a/b-suffix"), Path("/a/b"), False),
        (Path("/"), Path("/a"), False),
        (Path("/a/b"), Path("/"), True),
    ],
)
def test_is_within_is_lexical(path: Path, ancestor: Path, expected: bool) -> None:
    assert is_within(path, ancestor) is expected


def test_is_within_never_touches_the_filesystem() -> None:
    """None of these paths exist; the answer must still be correct."""
    ghost = Path("/definitely/not/here")
    assert not ghost.exists()
    assert is_within(ghost / "deeper", ghost) is True
    assert is_within(Path("/definitely/not/hereafter"), ghost) is False


# ===========================================================================
# refused_roots
# ===========================================================================


def test_refused_roots_tracks_the_patched_home(sandbox: Sandbox) -> None:
    refused = refused_roots()
    assert sandbox.home in refused
    assert sandbox.home / ".agents" in refused
    assert Path("/") in refused


def test_the_walk_never_escapes_the_sandbox(sandbox: Sandbox) -> None:
    """Canary for the sandbox seal: no scope may name a path outside tmp_path.

    The seal itself lives in ``make_sandbox`` in ``tests/conftest.py`` (it was
    local to this module until the whole sync suite was assembled -- every module
    is exposed, not just this one). Its comment explains why a bare ``.git``
    marker at ``tmp_path`` is load-bearing: pytest's basetemp is inside the real
    ``$HOME`` on this machine, so an unsealed upward walk adopts the REAL
    ``~/.agents/skills.json`` as "the project".

    If this fails, a sync test is one ``apply()`` away from rewriting the real
    ``~/.agents/skills``.
    """
    workspace = sandbox.tmp / "projects"
    assert find_project(workspace, registry_roots(None)) is None

    plan = discover_scopes(workspace, registry_roots=registry_roots(None))
    for scope in plan.scopes:
        assert is_within(scope.root, sandbox.tmp), scope.root


# ===========================================================================
# find_project / find_manifest_root - the upward walk
# ===========================================================================


def test_no_manifest_anywhere_is_not_a_project(sandbox: Sandbox, registry: Path) -> None:
    bare = sandbox.project("bare", manifest=None)
    assert find_project(bare, registry_roots(None)) is None
    assert find_project(deep(bare, "src", "a"), registry_roots(None)) is None
    assert registry is not None  # registry fixture keeps the sandbox hermetic


def test_manifest_at_the_repo_root_is_found(sandbox: Sandbox) -> None:
    project = sandbox.project("proj", manifest={})
    assert find_project(project) == project
    assert find_manifest_root(project) == project


def test_walk_up_from_a_deep_subdirectory_finds_the_repo(sandbox: Sandbox) -> None:
    """REGRESSION: `pack activate --scope project` used a raw Path.cwd()."""
    project = sandbox.project("proj", manifest={})
    nested = deep(project, "src", "a", "b", "c")

    assert find_project(nested) == project
    assert find_manifest_root(nested) == project
    # The bug being pinned: the answer is NOT the directory you happen to stand in.
    assert find_project(nested) != nested


def test_walk_stops_at_home(sandbox: Sandbox) -> None:
    """$HOME/.agents/skills.json must not make $HOME/scratch "a project"."""
    sandbox.write_global_manifest({})
    scratch = deep(sandbox.home, "scratch")

    assert sandbox.global_manifest.is_file()
    assert find_project(scratch) is None
    # find_manifest_root has no such stop -- which is exactly why scope.py cannot
    # use it directly. Pinned so the difference stays deliberate.
    assert find_manifest_root(scratch) == sandbox.home


def test_home_itself_is_never_a_project(sandbox: Sandbox) -> None:
    sandbox.write_global_manifest({})
    assert find_project(sandbox.home) is None


def test_dot_agents_is_never_a_project(sandbox: Sandbox) -> None:
    """Even with a literal ~/.agents/.agents/skills.json on disk."""
    agents = sandbox.home / ".agents"
    write_manifest(agents, {})
    assert (agents / MANIFEST_RELPATH).is_file()

    assert find_project(agents) is None


def test_nothing_under_dot_agents_is_a_project(sandbox: Sandbox) -> None:
    buried = deep(sandbox.home, ".agents", "skills", "some-skill", "scripts")
    assert find_project(buried) is None


def test_git_repo_without_a_manifest_stops_the_walk(sandbox: Sandbox) -> None:
    """A repo that does not use skillex is not a skillex project."""
    outer = sandbox.project("outer", manifest={})
    inner = outer / "vendor" / "checkout"
    inner.mkdir(parents=True)
    (inner / ".git").mkdir()

    # Without the boundary the nested checkout would adopt its host's manifest.
    assert find_project(inner) is None
    assert find_project(deep(inner, "src")) is None
    assert find_project(outer) == outer


def test_skillex_toml_also_stops_the_walk(sandbox: Sandbox) -> None:
    outer = sandbox.project("outer", manifest={})
    inner = outer / "sub"
    inner.mkdir()
    (inner / ".skillex.toml").write_text("", encoding="utf-8")
    assert find_project(inner) is None


# ===========================================================================
# is_registry_internal
# ===========================================================================


@pytest.mark.parametrize("internal", ["all-skills", "sets", "packs", "skill-sets"])
def test_registry_subtrees_are_internal(sandbox: Sandbox, registry: Path, internal: str) -> None:
    victim = registry / internal / "whatever"
    victim.mkdir(parents=True)
    assert is_registry_internal(victim, [registry]) is True
    assert is_registry_internal(registry / internal, [registry]) is True


def test_a_plain_project_is_not_registry_internal(sandbox: Sandbox, registry: Path) -> None:
    project = sandbox.project("proj", manifest={})
    assert is_registry_internal(project, [registry]) is False


def test_registry_internal_falls_back_to_structure(sandbox: Sandbox, tmp_path: Path) -> None:
    """An unknown checkout is still recognized by its shape, with no roots given."""
    other = tmp_path / "unknown-checkout"
    (other / "all-skills" / "impeccable").mkdir(parents=True)
    (other / "packs" / "hermes-base").mkdir(parents=True)

    assert is_registry_internal(other / "all-skills" / "impeccable", []) is True
    assert is_registry_internal(other / "packs" / "hermes-base", []) is True
    # A "packs" directory with no sibling all-skills/ is somebody else's packs.
    stray = tmp_path / "elsewhere" / "packs" / "thing"
    stray.mkdir(parents=True)
    assert is_registry_internal(stray, []) is False


def test_registry_internal_manifest_at_catalog_root_refuses(
    sandbox: Sandbox, registry: Path
) -> None:
    """Real trap #1: all-skills/.agents/skills.json (the catalog submodule)."""
    victim = registry_internal_project(registry, "all-skills")

    with pytest.raises(RefusalError) as excinfo:
        find_project(victim, registry_roots(None))
    assert excinfo.value.finding.code is Code.E_REGISTRY_INTERNAL


def test_registry_internal_manifest_inside_a_skill_refuses(
    sandbox: Sandbox, registry: Path
) -> None:
    """Real trap #2: all-skills/<skill>/scripts/.agents/skills.json."""
    victim = registry_internal_project(registry, "all-skills", "impeccable", "scripts")

    with pytest.raises(RefusalError) as excinfo:
        find_project(victim, registry_roots(None))
    assert excinfo.value.finding.code is Code.E_REGISTRY_INTERNAL


def test_registry_internal_cwd_without_a_manifest_is_just_none(
    sandbox: Sandbox, registry: Path
) -> None:
    """No manifest inside the registry -> None, not a refusal."""
    inside = registry / "all-skills" / "impeccable"
    inside.mkdir(parents=True)
    assert find_project(inside, registry_roots(None)) is None


# ===========================================================================
# probe_child_projects - reporting only, never adoption
# ===========================================================================


def test_probe_finds_direct_children_only(sandbox: Sandbox, registry: Path) -> None:
    alpha = sandbox.project("alpha", manifest={})
    beta = sandbox.project("beta", manifest={})
    sandbox.project("plain", manifest=None)
    grandchild = sandbox.tmp / "projects" / "alpha" / "nested"
    grandchild.mkdir()
    write_manifest(grandchild, {})

    found = probe_child_projects(sandbox.tmp / "projects", registry_roots(None))
    assert found == sorted([alpha, beta])


def test_probe_skips_symlinked_children(sandbox: Sandbox, registry: Path) -> None:
    real = sandbox.project("real", manifest={})
    link = sandbox.tmp / "projects" / "linked"
    link.symlink_to(real)

    found = probe_child_projects(sandbox.tmp / "projects", registry_roots(None))
    assert found == [real]


def test_probe_skips_registry_internal_children(sandbox: Sandbox, registry: Path) -> None:
    registry_internal_project(registry, "all-skills")
    registry_internal_project(registry, "sets")
    assert probe_child_projects(registry, registry_roots(None)) == []


def test_probe_on_an_unreadable_directory_is_empty(sandbox: Sandbox) -> None:
    assert probe_child_projects(sandbox.tmp / "does-not-exist") == []


# ===========================================================================
# discover_scopes
# ===========================================================================


def test_auto_without_a_project_yields_global_only(sandbox: Sandbox) -> None:
    bare = sandbox.project("bare", manifest=None)
    plan = discover_scopes(bare, registry_roots=registry_roots(None))

    assert scope_labels(plan) == ["global"]
    assert plan.scopes[0].kind is ScopeKind.GLOBAL
    assert plan.scopes[0].root == sandbox.global_root
    assert plan.scopes[0].base is None


def test_auto_inside_a_project_yields_both_global_first(sandbox: Sandbox) -> None:
    project = sandbox.project("proj", manifest={})
    plan = discover_scopes(project, registry_roots=registry_roots(None))

    assert scope_labels(plan) == ["global", "project"]
    assert plan.scopes[1].root == sandbox.project_root_of(project)
    assert plan.scopes[1].base == project
    assert plan.scopes[1].manifest_path == project / MANIFEST_RELPATH


def test_auto_from_a_deep_subdirectory_projects_into_the_repo(sandbox: Sandbox) -> None:
    project = sandbox.project("proj", manifest={})
    nested = deep(project, "src", "a", "b", "c")
    plan = discover_scopes(nested, registry_roots=registry_roots(None))

    assert plan.scopes[1].root == project / ".agents" / "skills"
    assert plan.scopes[1].root != nested / ".agents" / "skills"


def test_scope_global_inside_a_project_yields_one_scope(sandbox: Sandbox) -> None:
    project = sandbox.project("proj", manifest={})
    plan = discover_scopes(project, scope="global", registry_roots=registry_roots(None))
    assert scope_labels(plan) == ["global"]


def test_scope_project_inside_a_project_drops_global(sandbox: Sandbox) -> None:
    project = sandbox.project("proj", manifest={})
    plan = discover_scopes(project, scope="project", registry_roots=registry_roots(None))
    assert scope_labels(plan) == ["project"]


def test_scope_project_without_a_project_refuses(sandbox: Sandbox) -> None:
    bare = sandbox.project("bare", manifest=None)
    with pytest.raises(RefusalError) as excinfo:
        discover_scopes(bare, scope="project", registry_roots=registry_roots(None))
    assert excinfo.value.finding.code is Code.E_NO_PROJECT_MANIFEST


def test_explicit_project_without_a_manifest_refuses(sandbox: Sandbox) -> None:
    bare = sandbox.project("bare", manifest=None)
    with pytest.raises(RefusalError) as excinfo:
        discover_scopes(bare, project=bare, registry_roots=registry_roots(None))
    assert excinfo.value.finding.code is Code.E_NO_PROJECT_MANIFEST


def test_explicit_project_overrides_the_cwd(sandbox: Sandbox) -> None:
    elsewhere = sandbox.project("elsewhere", manifest={})
    bare = sandbox.project("bare", manifest=None)
    plan = discover_scopes(bare, project=elsewhere, registry_roots=registry_roots(None))

    assert scope_labels(plan) == ["global", "project"]
    assert plan.scopes[1].base == elsewhere
    assert plan.findings == []


def test_one_child_project_is_reported_not_adopted(sandbox: Sandbox) -> None:
    child = sandbox.project("only", manifest={})
    plan = discover_scopes(sandbox.tmp / "projects", registry_roots=registry_roots(None))

    assert scope_labels(plan) == ["global"]
    assert [f.code for f in plan.findings] == [Code.I_PROJECT_BELOW_CWD]
    assert plan.findings[0].path == child


def test_many_child_projects_are_info_never_an_error(sandbox: Sandbox) -> None:
    """AC 6: `cd ~/code && skillex sync` must stay a plain, successful global sync."""
    for name in ("a", "b", "c"):
        sandbox.project(name, manifest={})
    plan = discover_scopes(sandbox.tmp / "projects", registry_roots=registry_roots(None))

    assert scope_labels(plan) == ["global"]
    assert [f.code for f in plan.findings] == [Code.I_SIBLING_PROJECTS]
    assert plan.findings[0].severity.name == "INFO"
    assert plan.findings[0].detail == ("a", "b", "c")


def test_sibling_detail_is_truncated_at_ten(sandbox: Sandbox) -> None:
    for index in range(11):
        sandbox.project(f"p{index:02d}", manifest={})
    plan = discover_scopes(sandbox.tmp / "projects", registry_roots=registry_roots(None))

    detail = plan.findings[0].detail
    assert len(detail) == 11
    assert detail[-1] == "..."


def test_child_probe_is_skipped_for_scope_global(sandbox: Sandbox) -> None:
    sandbox.project("only", manifest={})
    plan = discover_scopes(
        sandbox.tmp / "projects", scope="global", registry_roots=registry_roots(None)
    )
    assert plan.findings == []


def test_child_probe_is_skipped_when_a_project_was_found(sandbox: Sandbox) -> None:
    project = sandbox.project("proj", manifest={})
    write_manifest(deep(project, "sub"), {})
    plan = discover_scopes(project, registry_roots=registry_roots(None))

    assert scope_labels(plan) == ["global", "project"]
    assert plan.findings == []


def test_discover_scopes_refuses_a_registry_internal_cwd(sandbox: Sandbox, registry: Path) -> None:
    victim = registry_internal_project(registry, "all-skills")
    with pytest.raises(RefusalError) as excinfo:
        discover_scopes(victim, registry_roots=registry_roots(None))
    assert excinfo.value.finding.code is Code.E_REGISTRY_INTERNAL


# ===========================================================================
# end to end - AC 6 and AC 7 through the CLI
# ===========================================================================


def test_cli_no_manifest_anywhere_syncs_global_only(sandbox: Sandbox, run_sync_json) -> None:
    """AC 6. Exit 0, one scope, and the global root exists afterwards."""
    bare = sandbox.project("bare", manifest=None)
    code, payload = run_sync_json(cwd=bare)

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global"]
    assert payload["scopes"][0]["root"] == str(sandbox.global_root)
    assert sandbox.global_root.is_dir()
    assert not sandbox.global_root.is_symlink()
    assert not (bare / ".agents").exists()


def test_cli_project_manifest_syncs_both(sandbox: Sandbox, run_sync_json) -> None:
    """AC 7."""
    project = sandbox.project("proj", manifest={})
    code, payload = run_sync_json(cwd=project)

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global", "project"]
    assert sandbox.global_root.is_dir()
    assert sandbox.project_root_of(project).is_dir()


def test_cli_deep_cwd_writes_the_repo_root_not_the_cwd(sandbox: Sandbox, run_sync_json) -> None:
    """REGRESSION: no .agents/skills may appear at <repo>/src/a/b/c."""
    project = sandbox.project("proj", manifest={})
    nested = deep(project, "src", "a", "b", "c")

    code, payload = run_sync_json(cwd=nested)

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global", "project"]
    assert sandbox.project_root_of(project).is_dir()
    for part in ("src", "src/a", "src/a/b", "src/a/b/c"):
        assert not (project / part / ".agents").exists()


def test_cli_from_home_scratch_yields_one_scope(sandbox: Sandbox, run_sync_json) -> None:
    """The $HOME stop: without it this returns two scopes on the SAME root."""
    sandbox.write_global_manifest({})
    scratch = deep(sandbox.home, "scratch")

    code, payload = run_sync_json(cwd=scratch)

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global"]
    assert not (scratch / ".agents").exists()


def test_cli_git_repo_without_manifest_creates_no_dot_agents(
    sandbox: Sandbox, run_sync_json
) -> None:
    bare = sandbox.project("bare", manifest=None)
    assert (bare / ".git").is_dir()

    code, payload = run_sync_json(cwd=bare)

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global"]
    assert not (bare / ".agents").exists()


def test_cli_many_sibling_projects_is_a_successful_global_sync(
    sandbox: Sandbox, run_sync_json
) -> None:
    """AC 6: `cd ~/code && skillex sync`. Never an error."""
    projects = [sandbox.project(name, manifest={}) for name in ("a", "b", "c")]

    code, payload = run_sync_json(cwd=sandbox.tmp / "projects")

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global"]
    assert Code.I_SIBLING_PROJECTS.value in codes_in(payload)
    assert Code.I_PROJECT_BELOW_CWD.value not in codes_in(payload)
    for project in projects:
        assert not sandbox.project_root_of(project).exists()


def test_cli_one_child_project_is_reported_not_adopted(sandbox: Sandbox, run_sync_json) -> None:
    child = sandbox.project("only", manifest={})

    code, payload = run_sync_json(cwd=sandbox.tmp / "projects")

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global"]
    assert Code.I_PROJECT_BELOW_CWD.value in codes_in(payload)
    assert not sandbox.project_root_of(child).exists()


@pytest.mark.parametrize(
    "parts",
    [
        ("all-skills",),
        ("all-skills", "impeccable", "scripts"),
    ],
    ids=["catalog-root", "inside-a-skill"],
)
def test_cli_registry_internal_manifest_refuses_and_writes_nothing(
    sandbox: Sandbox, registry: Path, run_sync_json, parts: tuple[str, ...]
) -> None:
    victim = registry_internal_project(registry, *parts)

    code, payload = run_sync_json(cwd=victim)

    assert code == EXIT_REFUSED
    assert codes_in(payload) == [Code.E_REGISTRY_INTERNAL.value]
    assert payload["scopes"] == []
    # ERROR means ZERO mutation, in either scope.
    assert not sandbox.global_root.exists()
    assert not (victim / ".agents" / "skills").exists()


def test_cli_scope_project_without_a_project_is_a_config_error(
    sandbox: Sandbox, run_sync_json
) -> None:
    bare = sandbox.project("bare", manifest=None)

    code, payload = run_sync_json("--scope", "project", cwd=bare)

    assert code == EXIT_CONFIG
    assert codes_in(payload) == [Code.E_NO_PROJECT_MANIFEST.value]
    assert not sandbox.global_root.exists()


def test_cli_scope_global_inside_a_project_writes_only_global(
    sandbox: Sandbox, run_sync_json
) -> None:
    project = sandbox.project("proj", manifest={})

    code, payload = run_sync_json("--scope", "global", cwd=project)

    assert code == EXIT_OK
    assert json_scopes(payload) == ["global"]
    assert sandbox.global_root.is_dir()
    assert not sandbox.project_root_of(project).exists()


def test_cli_explicit_project_without_a_manifest_is_a_config_error(
    sandbox: Sandbox, run_sync_json
) -> None:
    target = sandbox.project("no-manifest", manifest=None)
    bare = sandbox.project("bare", manifest=None)

    code, payload = run_sync_json("--project", str(target), cwd=bare)

    assert code == EXIT_CONFIG
    assert codes_in(payload) == [Code.E_NO_PROJECT_MANIFEST.value]
    assert not sandbox.global_root.exists()


# ---------------------------------------------------------------------------
# narrowing what is WRITTEN must not change what is RESOLVED
# ---------------------------------------------------------------------------


def test_scope_project_still_inherits_the_global_map(
    sandbox, registry, write_catalog, write_set, run_sync_json
) -> None:
    """``--scope project`` narrows the WRITE set, never the resolution.

    Regression. ``inherit_global`` defaults to true, and the global map used to be
    computed only as a side effect of global being in the write set. Under
    ``--scope project`` it was therefore never computed, so the project map came
    out EMPTY -- and because an empty desired map prunes, a project root a previous
    full sync had populated would be emptied. A flag that means "touch less" turned
    into one that deleted more.
    """
    write_catalog(registry, "alpha", "beta")
    write_set(registry, "base", [("link", "alpha", registry / "all-skills" / "alpha")])
    sandbox.write_global_manifest(sets=["base"])
    project = sandbox.project("proj", manifest={"inherit_global": True, "skills": []})

    code, payload = run_sync_json(
        "--scope", "project", "--project", str(project), "--dry-run", cwd=project
    )

    assert code == 0
    assert [s["scope"] for s in payload["scopes"]] == ["project"], "global must not be written"
    assert {op["name"] for op in payload["scopes"][0]["ops"]} == {"alpha"}


def test_scope_project_with_no_inherit_is_empty_not_accidental(
    sandbox, registry, write_catalog, write_set, run_sync_json
) -> None:
    """The empty result must come from ``--no-inherit``, not from a skipped scope."""
    write_catalog(registry, "alpha")
    write_set(registry, "base", [("link", "alpha", registry / "all-skills" / "alpha")])
    sandbox.write_global_manifest(sets=["base"])
    project = sandbox.project("proj", manifest={"inherit_global": True, "skills": []})

    code, payload = run_sync_json(
        "--scope", "project", "--project", str(project), "--no-inherit", "--dry-run", cwd=project
    )

    assert code == 0
    assert payload["scopes"][0]["ops"] == []
