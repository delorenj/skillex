"""``skillex vendor``: exit codes, ``--json``, and the checkout ladder.

These drive the real :class:`~skillex.core.gitsource.GitCli` against repositories
built with ``git init`` inside ``tmp_path``. ``git init`` is a local operation;
nothing here reaches the network, and :data:`gitsource._ALLOWED_VERBS` makes that
structural rather than aspirational.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from skillex.core.diagnostics import (
    EXIT_CONFIG,
    EXIT_DRIFT,
    EXIT_OK,
    EXIT_REFUSED,
)
from skillex.core.gitsource import SourceReadError
from skillex.core.vendor import local_checkouts_path, source_env_var
from tests.conftest import run_cli
from tests.vendor_helpers import write_source_skill

pytestmark = [
    pytest.mark.usefixtures("sandbox"),
    pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed"),
]

REPO = "git@github.com:delorenj/pjangler.git"

GIT_ENV = {
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
}


def git(repo, *args):
    subprocess.run(
        ["git", *args], cwd=repo, env={**os.environ, **GIT_ENV}, check=True, capture_output=True
    )


def init_repo(repo, *, tag: str | None = None):
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "init")
    if tag:
        git(repo, "tag", tag)
    return repo


@pytest.fixture
def fixture(tmp_path):
    """One source repo with two skills, a catalog, and a sources.toml."""
    repo = tmp_path / "src" / "pjangler"
    write_source_skill(repo / "skills", "mise-tasks", files={"scripts/go.sh": "#!/bin/sh\n"})
    os.chmod(repo / "skills" / "mise-tasks" / "scripts" / "go.sh", 0o755)
    write_source_skill(repo / "skills", "pjangler-dev")
    init_repo(repo, tag="v1.0.0")

    catalog = tmp_path / "all-skills"
    catalog.mkdir()
    sources = tmp_path / "sources.toml"
    sources.write_text(
        f'version = 1\n\n[[source]]\nname = "pjangler"\nrepo = "{REPO}"\nversion = "v1.0.0"\n'
    )
    return repo, catalog, sources


def vendor(*args, **kw):
    return run_cli("vendor", *args, **kw)


def base(catalog, sources, repo):
    return ["--catalog", str(catalog), "--sources", str(sources), "--checkout", f"pjangler={repo}"]


# -- list --------------------------------------------------------------------


def test_list_json_reports_where_each_source_resolves(fixture):
    repo, catalog, sources = fixture
    code, out = vendor("list", *base(catalog, sources, repo), "--json")
    payload = json.loads(out)
    assert code == EXIT_OK
    assert payload["schema"] == 1 and payload["ok"] is True
    row = payload["sources"][0]
    assert row["name"] == "pjangler"
    assert row["subdir"] == "skills"
    assert row["checkout"] == str(repo)


def test_list_reports_a_missing_checkout_without_failing(fixture):
    _, catalog, sources = fixture
    code, out = vendor("list", "--catalog", str(catalog), "--sources", str(sources), "--json")
    assert code == EXIT_OK
    assert json.loads(out)["sources"][0]["checkout"] is None


# -- sync --------------------------------------------------------------------


def test_dry_run_plans_everything_and_writes_nothing(fixture):
    repo, catalog, sources = fixture
    code, out = vendor("sync", *base(catalog, sources, repo), "-n", "--json")
    payload = json.loads(out)
    assert code == EXIT_OK
    assert payload["dry_run"] is True and payload["applied"] is False
    assert sorted(op["name"] for op in payload["ops"]) == ["mise-tasks", "pjangler-dev"]
    assert list(catalog.iterdir()) == []


def test_sync_lands_real_content_with_a_resolved_commit(fixture):
    repo, catalog, sources = fixture
    code, out = vendor("sync", *base(catalog, sources, repo), "--json")
    payload = json.loads(out)
    assert code == EXIT_OK and payload["applied"] is True
    assert (catalog / "mise-tasks" / "SKILL.md").is_file()
    assert os.access(catalog / "mise-tasks" / "scripts" / "go.sh", os.X_OK)
    commit = payload["sources"][0]["commit"]
    assert len(commit) == 40
    assert commit in (catalog / "mise-tasks" / ".source.yaml").read_text()


def test_a_tag_version_does_not_warn_about_a_moving_pin(fixture):
    repo, catalog, sources = fixture
    _, out = vendor("sync", *base(catalog, sources, repo), "-n", "--json")
    codes = {f["code"] for f in json.loads(out)["findings"]}
    assert "W_SOURCE_REF_IS_BRANCH" not in codes
    assert json.loads(out)["sources"][0]["ref_kind"] == "tag"


def test_an_unknown_version_refuses_and_names_the_fetch(fixture):
    repo, catalog, sources = fixture
    sources.write_text(sources.read_text().replace("v1.0.0", "v9.9.9"))
    code, out = vendor("sync", *base(catalog, sources, repo), "--json")
    payload = json.loads(out)
    assert code == EXIT_REFUSED
    finding = next(f for f in payload["findings"] if f["code"] == "E_SOURCE_REF_UNKNOWN")
    assert "fetch" in finding["fix"]
    assert list(catalog.iterdir()) == []


def test_broken_toml_is_a_config_error(fixture):
    repo, catalog, sources = fixture
    sources.write_text("[[source]\n")
    code, out = vendor("sync", *base(catalog, sources, repo), "--json")
    assert code == EXIT_CONFIG
    assert {f["code"] for f in json.loads(out)["findings"]} == {"E_SOURCES_PARSE"}


def test_a_refused_field_reports_as_an_unsupported_field(fixture):
    repo, catalog, sources = fixture
    sources.write_text(sources.read_text() + "clone = true\n")
    code, out = vendor("sync", *base(catalog, sources, repo), "--json")
    assert code == EXIT_CONFIG
    finding = next(f for f in json.loads(out)["findings"] if f["code"] == "E_UNSUPPORTED_FIELD")
    assert "never clones" in finding["message"]


def test_a_malformed_checkout_override_is_a_config_error(fixture):
    _repo, catalog, sources = fixture
    code, out = vendor(
        "sync", "--catalog", str(catalog), "--sources", str(sources), "--checkout", "oops", "--json"
    )
    assert code == EXIT_CONFIG
    assert "NAME=PATH" in json.loads(out)["findings"][0]["message"]


def test_source_narrows_the_run(fixture):
    repo, catalog, sources = fixture
    code, out = vendor("sync", *base(catalog, sources, repo), "--source", "pjangler", "--json")
    assert code == EXIT_OK
    code, out = vendor("sync", *base(catalog, sources, repo), "--source", "nope", "--json")
    assert code == EXIT_CONFIG
    assert {f["code"] for f in json.loads(out)["findings"]} == {"E_SOURCE_UNKNOWN"}


def test_a_local_edit_blocks_a_re_sync_until_forced(fixture):
    repo, catalog, sources = fixture
    vendor("sync", *base(catalog, sources, repo))
    (catalog / "mise-tasks" / "SKILL.md").write_text("hand edited\n")

    code, out = vendor("sync", *base(catalog, sources, repo), "--json")
    assert code == EXIT_REFUSED
    assert "E_VENDOR_LOCAL_EDITS" in {f["code"] for f in json.loads(out)["findings"]}
    assert (catalog / "mise-tasks" / "SKILL.md").read_text() == "hand edited\n"

    code, _ = vendor("sync", *base(catalog, sources, repo), "--force", "--json")
    assert code == EXIT_OK
    assert "hand edited" not in (catalog / "mise-tasks" / "SKILL.md").read_text()


# -- status ------------------------------------------------------------------


def test_status_verifies_a_fresh_catalog_with_no_source_repo_at_all(fixture, tmp_path):
    """The machine-2 story: clone the catalog, verify it, needing nothing else."""
    repo, catalog, sources = fixture
    vendor("sync", *base(catalog, sources, repo))
    shutil.rmtree(repo)

    code, out = vendor("status", "--catalog", str(catalog), "--sources", str(sources), "--json")
    payload = json.loads(out)
    assert code == EXIT_OK
    assert {row["state"] for row in payload["skills"]} == {"ok"}


def test_status_exits_6_on_a_hand_edit(fixture):
    repo, catalog, sources = fixture
    vendor("sync", *base(catalog, sources, repo))
    (catalog / "mise-tasks" / "SKILL.md").write_text("edited\n")
    code, out = vendor("status", "--catalog", str(catalog), "--sources", str(sources), "--json")
    assert code == EXIT_DRIFT
    assert "W_VENDOR_LOCAL_EDITS" in {f["code"] for f in json.loads(out)["findings"]}


def test_status_refuses_a_declared_name_that_is_still_a_symlink(fixture):
    _repo, catalog, sources = fixture
    sources.write_text(sources.read_text() + 'skills = ["mise-tasks"]\n')
    os.symlink("/home/delorenj/code/33GOD/pjangler/skills/mise-tasks", catalog / "mise-tasks")
    code, out = vendor("status", "--catalog", str(catalog), "--sources", str(sources), "--json")
    assert code == EXIT_REFUSED
    assert "E_VENDOR_NOT_VENDORED" in {f["code"] for f in json.loads(out)["findings"]}


def test_status_upstream_reports_a_stale_pin(fixture):
    repo, catalog, sources = fixture
    vendor("sync", *base(catalog, sources, repo))
    (repo / "skills" / "mise-tasks" / "SKILL.md").write_text("---\nname: mise-tasks\n---\nnew\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "move")
    sources.write_text(sources.read_text().replace('"v1.0.0"', '"main"'))

    code, out = vendor("status", *base(catalog, sources, repo), "--upstream", "--json")
    assert code == EXIT_DRIFT
    assert "W_VENDOR_PIN_STALE" in {f["code"] for f in json.loads(out)["findings"]}


def test_strict_promotes_a_vendor_warning_to_an_error(fixture):
    repo, catalog, sources = fixture
    vendor("sync", *base(catalog, sources, repo))
    (catalog / "mise-tasks" / "SKILL.md").write_text("edited\n")
    code, out = vendor(
        "status", "--catalog", str(catalog), "--sources", str(sources), "--strict", "--json"
    )
    assert code == EXIT_REFUSED
    finding = next(f for f in json.loads(out)["findings"] if f["code"] == "W_VENDOR_LOCAL_EDITS")
    assert finding["severity"] == "error" and finding["strict"] is True


# -- show --------------------------------------------------------------------


def test_show_prints_the_provenance_record(fixture):
    repo, catalog, sources = fixture
    vendor("sync", *base(catalog, sources, repo))
    code, out = vendor("show", "mise-tasks", "--catalog", str(catalog), "--json")
    payload = json.loads(out)
    assert code == EXIT_OK
    assert payload["origin"]["type"] == "vendored"
    assert payload["origin"]["upstream_path"] == "skills/mise-tasks"


def test_show_refuses_a_name_with_no_record(fixture):
    _, catalog, _ = fixture
    code, _ = vendor("show", "nope", "--catalog", str(catalog), "--json")
    assert code == EXIT_REFUSED


# -- the checkout ladder -----------------------------------------------------


def test_the_env_var_rung_is_used_when_no_override_is_given(fixture, monkeypatch):
    repo, catalog, sources = fixture
    monkeypatch.setenv(source_env_var("pjangler"), str(repo))
    code, _ = vendor("sync", "--catalog", str(catalog), "--sources", str(sources), "-n", "--json")
    assert code == EXIT_OK


def test_the_machine_local_config_rung_is_used(fixture):
    repo, catalog, sources = fixture
    config = local_checkouts_path()
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(f'[checkouts]\npjangler = "{repo}"\n')
    code, _ = vendor("sync", "--catalog", str(catalog), "--sources", str(sources), "-n", "--json")
    assert code == EXIT_OK


def test_a_malformed_local_config_degrades_rather_than_crashing(fixture):
    _repo, catalog, sources = fixture
    config = local_checkouts_path()
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text("[checkouts\n")
    code, out = vendor("sync", "--catalog", str(catalog), "--sources", str(sources), "--json")
    assert code == EXIT_REFUSED
    assert "E_SOURCE_CHECKOUT_MISSING" in {f["code"] for f in json.loads(out)["findings"]}


# -- json hygiene ------------------------------------------------------------


def test_json_output_is_never_soft_wrapped(fixture):
    """The whole reason --json goes through typer.echo and not console.print."""
    repo, catalog, sources = fixture
    _, out = vendor("sync", *base(catalog, sources, repo), "-n", "--json")
    payload = json.loads(out)
    for finding in payload["findings"]:
        assert "\n" not in finding.get("fix", "")
        assert "\n" not in finding["message"]


# -- the no-network guarantee ------------------------------------------------


def test_the_git_reader_refuses_a_network_verb():
    from skillex.core.gitsource import GitCli

    with pytest.raises(SourceReadError, match="may only run"):
        GitCli()._run(os.getcwd(), "fetch", "origin")
