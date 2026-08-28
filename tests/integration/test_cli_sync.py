"""End-to-end integration tests for ``skillex sync`` (``commands/sync.py``).

Everything here drives the real typer command through :func:`tests.conftest.run_sync`
and then asserts on **what is on disk** (``lstat``/``readlink``/``iterdir``) or on the
published ``--json`` contract. Nothing asserts on rendered message text: the codes are
the contract, the prose is not.

Every test depends on ``sandbox``, which repoints ``HOME``, ``XDG_STATE_HOME`` and
``PJ_SKILLS_REGISTRY_ROOT`` into ``tmp_path``. Without it these tests would rewrite the
author's real ``~/.agents/skills``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from skillex.core.diagnostics import (
    EXIT_CONFIG,
    EXIT_DRIFT,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_REFUSED,
    STRICT_PROMOTES,
    Code,
)
from skillex.core.state import state_path_for
from tests.conftest import Sandbox

# ---------------------------------------------------------------------------
# local helpers - shapes unique to this file
# ---------------------------------------------------------------------------


@pytest.fixture
def outside(sandbox: Sandbox) -> Path:
    """A CWD that is inside no project at all.

    ``find_project`` walks UP from here and finds no ``.agents/skills.json`` and no
    repo boundary before ``/``, so only the global scope is in play - the AC-6 case
    ("if the cwd has no manifest, the global skills are assumed"). It is deliberately
    NOT ``tmp_path`` itself, whose ``home/`` child carries the global manifest and
    would therefore be reported as a project one level below.
    """
    path = sandbox.tmp / "elsewhere"
    path.mkdir(exist_ok=True)
    return path


def codes(payload: dict) -> list[str]:
    """``findings[].code`` in emission order."""
    return [f["code"] for f in payload["findings"]]


def code_counts(payload: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for finding in payload["findings"]:
        out[finding["code"]] = out.get(finding["code"], 0) + 1
    return out


def severities(payload: dict) -> dict[str, set[str]]:
    """``{code: {severity, ...}}`` - how a run actually classified each code."""
    out: dict[str, set[str]] = {}
    for finding in payload["findings"]:
        out.setdefault(finding["code"], set()).add(finding["severity"])
    return out


def entries(root: Path) -> list[str]:
    return sorted(p.name for p in root.iterdir())


def flat(text: str) -> str:
    """Output with every run of whitespace removed.

    Rich soft-wraps a long path across lines; no path in these fixtures contains a
    space, so collapsing whitespace makes a substring assertion immune to the width
    the console happened to pick.
    """
    return "".join(text.split())


# ---------------------------------------------------------------------------
# THE GOLDEN TEST - the live sets/min-global shape, end to end
# ---------------------------------------------------------------------------


def test_golden_min_global_projects_thirty_six_members(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_skill,
    write_set,
    run_sync_json,
) -> None:
    """``sets/min-global``: 36 members, 10 outside the catalog, hidden entries dropped.

    The live set holds 42 directory entries: 36 projectable members, a real
    ``.system/`` directory of six Codex-managed skills, and a ``.lastagent`` marker
    file. It must project 36 - the six-entry difference is ``EXCLUDED_PREFIXES``.
    """
    catalog = write_catalog(registry, *[f"cat-{i:02d}" for i in range(26)])

    # 10 members resolving OUTSIDE all-skills/, exactly as 10 of the live 36 do
    # (they point into ~/code/33GOD/*). `momo` reproduces the odd-link-name shape:
    # the target basename is "skill", the PROJECTED name is the link name.
    other = sandbox.tmp / "other-repo" / "skills"
    external = {name: write_skill(other, name) for name in [f"ext-{i:02d}" for i in range(9)]}
    external["momo"] = write_skill(other / "momo", "skill")

    members = [("link", name, path) for name, path in catalog.items()]
    members += [("link", name, path) for name, path in external.items()]
    members += [
        ("container", ".system", [f"codex-{i}" for i in range(6)]),
        ("file", ".lastagent", "claude\n"),
    ]
    set_dir = write_set(registry, "min-global", members)
    assert len(list(set_dir.iterdir())) == 38  # 36 members + .system + .lastagent

    sandbox.write_global_manifest(scope="global", sets=["min-global"])

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_OK
    assert payload["ok"] is True

    root = sandbox.global_root
    projected = entries(root)
    assert len(projected) == 36
    assert all((root / name).is_symlink() for name in projected)
    assert ".system" not in projected
    assert ".lastagent" not in projected

    # The projected name is the LINK name, and the target is ONE hop from the set.
    assert os.readlink(root / "momo") == str(external["momo"])
    assert os.readlink(root / "cat-00") == str(catalog["cat-00"])

    assert code_counts(payload)[Code.W_SET_LINK_OUTSIDE_CATALOG.value] == 10
    assert Code.W_SET_MEMBER_DANGLING.value not in codes(payload)


def test_golden_second_run_is_a_no_op(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync,
    snapshot,
) -> None:
    """Convergence: a second sync of an unchanged manifest rewrites nothing.

    Asserted by inode, not by an empty plan - a plan can be empty while ``apply``
    writes behind its back, and a replaced-then-restored link is a new inode.
    """
    catalog = write_catalog(registry, "alpha", "beta")
    write_set(
        registry,
        "gset",
        [("link", "alpha", catalog["alpha"]), ("link", "beta", catalog["beta"])],
    )
    sandbox.write_global_manifest(sets=["gset"])

    assert run_sync(cwd=outside)[0] == EXIT_OK
    before = snapshot(sandbox.global_root)
    assert run_sync(cwd=outside)[0] == EXIT_OK
    assert snapshot(sandbox.global_root) == before


# ---------------------------------------------------------------------------
# --json
# ---------------------------------------------------------------------------


def test_json_parses_and_carries_the_published_contract(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync,
) -> None:
    """``--json`` is one parseable object carrying schema/ok/exit/scopes/counts/ops."""
    catalog = write_catalog(registry, "alpha", "beta")
    write_set(
        registry,
        "gset",
        [("link", "alpha", catalog["alpha"]), ("link", "beta", catalog["beta"])],
    )
    sandbox.write_global_manifest(sets=["gset"])

    code, out = run_sync("--json", cwd=outside)
    payload = json.loads(out)  # guards Rich soft-wrapping a long path mid-token

    assert code == EXIT_OK
    assert payload["schema"] == 1
    assert payload["ok"] is True
    assert payload["exit"] == EXIT_OK
    assert payload["dry_run"] is False
    assert isinstance(payload["findings"], list)

    assert len(payload["scopes"]) == 1
    scope = payload["scopes"][0]
    assert scope["scope"] == "global"
    assert scope["root"] == str(sandbox.global_root)
    assert scope["manifest"] == str(sandbox.global_manifest)
    assert scope["mode"] == "composed"
    assert scope["applied"] is True
    assert scope["counts"]["add"] == 2
    assert scope["counts"]["remove"] == 0
    assert {op["name"] for op in scope["ops"]} == {"alpha", "beta"}
    assert {op["action"] for op in scope["ops"]} == {"add"}
    assert scope["ops"][0]["to"] in {str(catalog["alpha"]), str(catalog["beta"])}
    assert all(alias["path"].startswith(str(sandbox.home)) for alias in scope["aliases"])


def test_json_is_emitted_on_a_refusal_with_ok_false(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync,
) -> None:
    """A refusal still produces machine-readable output, not a bare stack trace."""
    catalog = write_catalog(registry, "alpha")
    write_set(registry, "gset", [("link", "alpha", catalog["alpha"])])
    sandbox.write_global_manifest(sets=["gset"])
    # Something skillex could not have written, and no receipt saying otherwise.
    (sandbox.global_root / "hand-made").mkdir(parents=True)

    code, out = run_sync("--json", cwd=outside)
    payload = json.loads(out)

    assert code == EXIT_REFUSED
    assert payload["ok"] is False
    assert payload["exit"] == EXIT_REFUSED
    assert Code.E_UNMANAGED_ROOT.value in codes(payload)
    # ZERO mutation: the refusal fired before anything was projected.
    assert entries(sandbox.global_root) == ["hand-made"]


# ---------------------------------------------------------------------------
# --explain
# ---------------------------------------------------------------------------


def test_explain_prints_provenance_and_implies_dry_run(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync,
) -> None:
    """``--explain`` shows entry, hops, one-hop target and projected path, and writes nothing."""
    catalog = write_catalog(registry, "project-jangler")
    set_dir = write_set(registry, "gset", [("link", "pjangler", catalog["project-jangler"])])
    sandbox.write_global_manifest(sets=["gset"])

    code, out = run_sync("--explain", "pjangler", cwd=outside)
    body = flat(out)

    assert code == EXIT_OK
    assert "pjangler" in out
    assert "sets[0]" in body  # the declaring entry
    assert str(set_dir / "pjangler") in body  # the composition member that was read
    assert "hop1->" in body  # the resolved chain
    assert str(catalog["project-jangler"]) in body  # the ONE-HOP target
    assert str(sandbox.global_root / "pjangler") in body  # where it would be projected

    # --explain implies --dry-run: the root was never created.
    assert not sandbox.global_root.exists()
    assert not state_path_for(sandbox.global_root).exists()


def test_explain_for_a_name_that_is_not_projected_exits_nonzero(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync,
) -> None:
    catalog = write_catalog(registry, "alpha")
    write_set(registry, "gset", [("link", "alpha", catalog["alpha"])])
    sandbox.write_global_manifest(sets=["gset"])

    code, _ = run_sync("--explain", "nowhere", cwd=outside)

    assert code != EXIT_OK
    assert not sandbox.global_root.exists()


# ---------------------------------------------------------------------------
# --strict
# ---------------------------------------------------------------------------


def test_strict_promotes_exactly_the_named_codes_and_mutates_nothing(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_skill,
    write_set,
    run_sync,
    run_sync_json,
    snapshot,
) -> None:
    """``--strict`` escalates the topology warnings in ``STRICT_PROMOTES`` and only those.

    The same run also raises ``W_SET_OPTIONAL_MISSING``, which is deliberately NOT in
    the set: it describes the environment, not the composition, and failing on it
    would make --strict useless as a topology gate.
    """
    catalog = write_catalog(registry, "alpha")
    external = write_skill(sandbox.tmp / "other-repo" / "skills", "roaming")
    write_set(
        registry,
        "mixed",
        [
            ("link", "alpha", catalog["alpha"]),
            ("link", "roaming", external),  # W_SET_LINK_OUTSIDE_CATALOG  (promoted)
            ("realdir", "embedded"),  # W_SET_EMBEDDED_DEFINITION  (promoted)
        ],
    )
    sandbox.write_global_manifest(
        sets=["mixed", {"name": "absent-set", "optional": True}]  # W_SET_OPTIONAL_MISSING
    )

    before = snapshot(sandbox.home)

    # The human renderer groups by severity, so it must survive a WARNING-coded
    # finding that reports ERROR severity.
    human_code, human_out = run_sync("--strict", cwd=outside)
    assert human_code == EXIT_REFUSED
    assert Code.W_SET_LINK_OUTSIDE_CATALOG.value in human_out
    assert "error" in human_out

    code, payload = run_sync_json("--strict", cwd=outside)

    assert code == EXIT_REFUSED
    assert payload["ok"] is False

    by_severity = severities(payload)
    promoted = {code_ for code_, levels in by_severity.items() if "error" in levels}
    assert promoted == {
        Code.W_SET_LINK_OUTSIDE_CATALOG.value,
        Code.W_SET_EMBEDDED_DEFINITION.value,
    }
    assert promoted <= {c.value for c in STRICT_PROMOTES}
    # The code is the published contract and must survive promotion unrenamed.
    assert by_severity[Code.W_SET_OPTIONAL_MISSING.value] == {"warning"}

    # ZERO mutation, and not even an alias was created.
    assert snapshot(sandbox.home) == before
    assert not sandbox.global_root.exists()


def test_strict_ignores_a_warning_outside_the_promote_set(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    run_sync_json,
) -> None:
    """A warning that is not in ``STRICT_PROMOTES`` must not fail the run."""
    catalog = write_catalog(registry, "alpha")
    sandbox.write_global_manifest(
        sets=[{"name": "absent-set", "optional": True}],
        skills=["alpha"],
    )

    code, payload = run_sync_json("--strict", cwd=outside)

    assert code == EXIT_OK
    assert Code.W_SET_OPTIONAL_MISSING.value in codes(payload)
    assert severities(payload)[Code.W_SET_OPTIONAL_MISSING.value] == {"warning"}
    # And the run actually did its job rather than merely not failing.
    assert os.readlink(sandbox.global_root / "alpha") == str(catalog["alpha"])


# ---------------------------------------------------------------------------
# --forget
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# exit codes
# ---------------------------------------------------------------------------


def test_exit_2_on_unparseable_manifest(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json
) -> None:
    sandbox.write_global_manifest("{ this is not json")

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_CONFIG
    assert Code.E_MANIFEST_PARSE.value in codes(payload)
    assert not sandbox.global_root.exists()


def test_exit_2_on_a_refused_unsupported_field(
    sandbox: Sandbox, registry: Path, outside: Path, run_sync_json
) -> None:
    """``sets[].flatten`` is accepted by the schema and refused by sync.

    Silently ignoring it would project ZERO skills and report success, because the
    flatten walker never follows a symlink and a set is entirely symlinks.

    It carries its OWN code: the JSON parsed fine and the field is in the published
    schema, so ``E_MANIFEST_PARSE`` would send the reader looking for a syntax error
    that is not there. Both are config errors, so the exit code is 2 either way.
    """
    sandbox.write_global_manifest(sets=[{"name": "gset", "flatten": True}])

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_CONFIG
    assert codes(payload) == [Code.E_UNSUPPORTED_FIELD.value]
    # The authored explanation survives the trip through the loader intact --
    # both the field that was refused and the REASON, which is the half that
    # makes the refusal actionable. (Folded in from an equivalent test in
    # test_sync_resolver.py that ran the same scenario through the same
    # run_sync_json entry point but accepted `E_UNSUPPORTED_FIELD or
    # E_MANIFEST_PARSE`; that disjunction's second branch is unreachable, since
    # sync.py tests `isinstance(e.__cause__, UnsupportedFieldError)` first, so
    # it could not fail if the mapping regressed to the generic code.)
    assert "flatten" in payload["findings"][0]["message"]
    assert "project zero skills" in payload["findings"][0]["message"]
    assert not sandbox.global_root.exists()


def test_exit_3_on_a_disk_refusal(
    sandbox: Sandbox, registry: Path, outside: Path, write_catalog, run_sync_json
) -> None:
    write_catalog(registry, "alpha")
    sandbox.write_global_manifest(skills=["alpha"])
    (sandbox.global_root / "hand-made").mkdir(parents=True)

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_REFUSED
    assert Code.E_UNMANAGED_ROOT.value in codes(payload)


def test_config_error_and_disk_refusal_do_not_collapse_to_one_code(
    sandbox: Sandbox, registry: Path, outside: Path, write_catalog, run_sync_json
) -> None:
    """2 is fixed by editing JSON; 3 is fixed by moving files. The split is the contract."""
    write_catalog(registry, "alpha")

    sandbox.write_global_manifest("{ not json at all")
    config_code, config_payload = run_sync_json(cwd=outside)

    sandbox.write_global_manifest(skills=["alpha"])
    (sandbox.global_root / "hand-made").mkdir(parents=True)
    refusal_code, refusal_payload = run_sync_json(cwd=outside)

    assert config_code == EXIT_CONFIG
    assert refusal_code == EXIT_REFUSED
    assert config_code != refusal_code
    assert codes(config_payload) != codes(refusal_payload)


def test_exit_4_with_skip_occupied(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync_json,
) -> None:
    """``--skip-occupied`` projects the free names, leaves the occupied one, exits 4."""
    catalog = write_catalog(registry, "alpha", "beta")
    write_set(
        registry,
        "gset",
        [("link", "alpha", catalog["alpha"]), ("link", "beta", catalog["beta"])],
    )
    sandbox.write_global_manifest(sets=["gset"])
    occupied = sandbox.global_root / "alpha"
    occupied.mkdir(parents=True)
    (occupied / "SKILL.md").write_text("# hand written\n", encoding="utf-8")

    # Without the flag the same tree is a refusal, so the exit code is meaningful.
    assert run_sync_json(cwd=outside)[0] == EXIT_REFUSED

    code, payload = run_sync_json("--skip-occupied", cwd=outside)

    assert code == EXIT_PARTIAL
    assert {op["action"] for op in payload["scopes"][0]["ops"]} == {"add", "blocked"}
    assert not occupied.is_symlink()
    assert (occupied / "SKILL.md").read_text(encoding="utf-8") == "# hand written\n"
    assert os.readlink(sandbox.global_root / "beta") == str(catalog["beta"])


def test_exit_6_only_when_dry_run_finds_drift(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    run_sync,
    snapshot,
) -> None:
    catalog = write_catalog(registry, "alpha")
    write_set(registry, "gset", [("link", "alpha", catalog["alpha"])])
    sandbox.write_global_manifest(sets=["gset"])

    before = snapshot(sandbox.home)
    drifted, _ = run_sync("--dry-run", "--exit-code", cwd=outside)
    assert drifted == EXIT_DRIFT
    assert snapshot(sandbox.home) == before  # --dry-run changed nothing

    assert run_sync(cwd=outside)[0] == EXIT_OK

    converged, _ = run_sync("--dry-run", "--exit-code", cwd=outside)
    assert converged == EXIT_OK


# ---------------------------------------------------------------------------
# BOTH SCOPES PREFLIGHT BEFORE EITHER MUTATES
# ---------------------------------------------------------------------------


def test_broken_project_manifest_leaves_the_global_root_completely_untouched(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    write_manifest,
    run_sync,
    run_sync_json,
    snapshot,
) -> None:
    """The single most important property: read everything, then write, or write nothing.

    Global is resolved and diffed first, and it has real pending drift here. A
    project manifest that fails to parse afterwards must not leave the global root
    half-written.
    """
    catalog = write_catalog(registry, "alpha", "beta")
    set_dir = write_set(registry, "gset", [("link", "alpha", catalog["alpha"])])
    sandbox.write_global_manifest(sets=["gset"])

    project = sandbox.project("proj", manifest={"sets": []})
    assert run_sync(cwd=project)[0] == EXIT_OK
    before = snapshot(sandbox.global_root)
    assert "alpha" in before

    # Global now has one pending ADD, so a run that got as far as writing would be
    # visible on disk...
    os.symlink(str(catalog["beta"]), set_dir / "beta")
    # ...and the project manifest is broken.
    write_manifest(project, "{{{ not json")

    code, payload = run_sync_json(cwd=project)

    assert code == EXIT_CONFIG
    assert Code.E_MANIFEST_PARSE.value in codes(payload)

    # The global scope planned the write and did not perform it.
    global_scope = payload["scopes"][0]
    assert global_scope["scope"] == "global"
    assert global_scope["counts"]["add"] == 1
    assert global_scope["applied"] is False

    assert snapshot(sandbox.global_root) == before
    assert not (sandbox.global_root / "beta").exists()


# ---------------------------------------------------------------------------
# inherit_global
# ---------------------------------------------------------------------------


def _two_scope_registry(sandbox: Sandbox, registry: Path, write_catalog, write_set) -> dict:
    """global: gset{alpha, beta}; project: pset{gamma, beta -> a DIFFERENT target}."""
    catalog = write_catalog(registry, "alpha", "beta", "gamma", "beta-fork")
    write_set(
        registry,
        "gset",
        [("link", "alpha", catalog["alpha"]), ("link", "beta", catalog["beta"])],
    )
    write_set(
        registry,
        "pset",
        [("link", "gamma", catalog["gamma"]), ("link", "beta", catalog["beta-fork"])],
    )
    sandbox.write_global_manifest(sets=["gset"])
    return catalog


def test_inherit_global_defaults_to_true_and_unions_global_into_the_project(
    sandbox: Sandbox, registry: Path, write_catalog, write_set, run_sync_json
) -> None:
    """AC 7: a project manifest syncs BOTH scopes, and the project map is a union."""
    catalog = _two_scope_registry(sandbox, registry, write_catalog, write_set)
    project = sandbox.project("proj", manifest={"sets": ["pset"]})

    code, payload = run_sync_json(cwd=project)
    project_root = sandbox.project_root_of(project)

    assert code == EXIT_OK
    assert [s["scope"] for s in payload["scopes"]] == ["global", "project"]
    assert entries(sandbox.global_root) == ["alpha", "beta"]
    assert entries(project_root) == ["alpha", "beta", "gamma"]
    assert Code.W_INHERIT_DUPLICATES_GLOBAL.value in codes(payload)
    # alpha reached the project only by inheritance.
    assert os.readlink(project_root / "alpha") == str(catalog["alpha"])


def test_a_project_entry_overrides_an_inherited_name(
    sandbox: Sandbox, registry: Path, write_catalog, write_set, run_sync
) -> None:
    catalog = _two_scope_registry(sandbox, registry, write_catalog, write_set)
    project = sandbox.project("proj", manifest={"sets": ["pset"]})

    assert run_sync(cwd=project)[0] == EXIT_OK

    project_root = sandbox.project_root_of(project)
    assert os.readlink(project_root / "beta") == str(catalog["beta-fork"])
    # The global root keeps its own answer; the override is scoped to the project.
    assert os.readlink(sandbox.global_root / "beta") == str(catalog["beta"])


def test_inherited_targets_are_canonical_and_never_chain_through_the_global_root(
    sandbox: Sandbox, registry: Path, write_catalog, write_set, run_sync
) -> None:
    """ADR-0001 rule 10: inheritance is a union, not a copy.

    A project link that pointed at ``~/.agents/skills/<name>`` would break every
    project the next time the global root is regenerated.
    """
    catalog = _two_scope_registry(sandbox, registry, write_catalog, write_set)
    project = sandbox.project("proj", manifest={"sets": ["pset"]})

    assert run_sync(cwd=project)[0] == EXIT_OK

    project_root = sandbox.project_root_of(project)
    for name in entries(project_root):
        target = Path(os.readlink(project_root / name))
        assert target.parent != sandbox.global_root
        assert str(sandbox.global_root) not in str(target)
    assert os.readlink(project_root / "alpha") == str(catalog["alpha"])


def test_inherit_global_false_isolates_the_project_but_still_writes_global(
    sandbox: Sandbox, registry: Path, write_catalog, write_set, run_sync_json
) -> None:
    catalog = _two_scope_registry(sandbox, registry, write_catalog, write_set)
    project = sandbox.project("proj", manifest={"inherit_global": False, "sets": ["pset"]})

    code, payload = run_sync_json(cwd=project)
    project_root = sandbox.project_root_of(project)

    assert code == EXIT_OK
    assert entries(project_root) == ["beta", "gamma"]  # no alpha
    assert os.readlink(project_root / "beta") == str(catalog["beta-fork"])
    # The global root is still reconciled - isolation is not a reason to leave it stale.
    assert entries(sandbox.global_root) == ["alpha", "beta"]
    assert Code.W_INHERIT_DUPLICATES_GLOBAL.value not in codes(payload)


def test_no_inherit_flag_isolates_the_project_for_one_run(
    sandbox: Sandbox, registry: Path, write_catalog, write_set, run_sync
) -> None:
    _two_scope_registry(sandbox, registry, write_catalog, write_set)
    project = sandbox.project("proj", manifest={"sets": ["pset"]})
    project_root = sandbox.project_root_of(project)

    assert run_sync("--no-inherit", cwd=project)[0] == EXIT_OK
    assert entries(project_root) == ["beta", "gamma"]
    assert entries(sandbox.global_root) == ["alpha", "beta"]

    # ...and it really is one run: the manifest still says inherit.
    assert run_sync(cwd=project)[0] == EXIT_OK
    assert entries(project_root) == ["alpha", "beta", "gamma"]


# ---------------------------------------------------------------------------
# packs
# ---------------------------------------------------------------------------


def test_a_pack_at_project_scope_projects_a_real_directory(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_pack,
    run_sync_json,
) -> None:
    """pjangler audits ``<repo>/.agents/skills`` and refuses a symlinked one.

    A symlinked project root breaks ``pj audit`` and every mise enter hook in every
    adopting repo, so alias mode is declined at project scope whatever the pack looks
    like.
    """
    catalog = write_catalog(registry, "cat-a", "cat-b")
    write_pack(
        registry,
        "folder-curator",
        declared=["cat-a", "cat-b"],
        extra_files={"README.md": "# folder-curator\n"},
    )
    sandbox.write_global_manifest()
    project = sandbox.project("proj", manifest={"packs": ["folder-curator"]})

    code, payload = run_sync_json(cwd=project)
    project_root = sandbox.project_root_of(project)

    assert code == EXIT_OK
    assert project_root.is_dir()
    assert not project_root.is_symlink()
    assert entries(project_root) == ["cat-a", "cat-b"]
    assert os.readlink(project_root / "cat-a") == str(catalog["cat-a"])
    assert Code.W_ALIAS_MODE_DECLINED.value in codes(payload)
    assert payload["scopes"][1]["mode"] == "composed"


def test_a_pack_trumps_sets_and_skills(
    sandbox: Sandbox,
    registry: Path,
    outside: Path,
    write_catalog,
    write_set,
    write_pack,
    run_sync_json,
) -> None:
    """AC 3: a declared pack replaces the root, and says so."""
    catalog = write_catalog(registry, "alpha", "cat-a")
    write_set(registry, "gset", [("link", "alpha", catalog["alpha"])])
    write_pack(registry, "folder-curator", declared=["cat-a"])
    sandbox.write_global_manifest(packs=["folder-curator"], sets=["gset"], skills=["alpha"])

    code, payload = run_sync_json(cwd=outside)

    assert code == EXIT_OK
    assert Code.W_PACK_TRUMPS.value in codes(payload)
    assert entries(sandbox.global_root) == ["cat-a"]


def test_a_self_contained_pack_aliases_the_global_root(
    sandbox: Sandbox, registry: Path, outside: Path, write_pack, run_sync
) -> None:
    """The contrast case for the project-scope test above: global scope MAY alias."""
    pack_dir = write_pack(registry, "selfpack", skills=["p1", "p2"])
    sandbox.write_global_manifest(packs=["selfpack"])

    code, _ = run_sync(cwd=outside)

    assert code == EXIT_OK
    assert sandbox.global_root.is_symlink()
    assert os.readlink(sandbox.global_root) == str(pack_dir)
