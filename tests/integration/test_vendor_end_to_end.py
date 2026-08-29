"""The machine-2 story, end to end, against real git repositories.

Reproduces the measured shape of the live tree in miniature:

* four repositories at five skill roots, exactly as ``all-skills/``'s 15 symlinks
  actually resolve (pjangler, bloodbank, momo, and 33GOD at two paths);
* a ``33GOD/skills/`` that is a committed symlink farm, so declaring the obvious
  thing fails loudly instead of publishing path strings;
* a catalog whose entries start as absolute symlinks;
* a ``sets/`` whose links bypass the catalog entirely, which is why 22 of the 25
  machine-2 dangles are not healed by vendoring alone.

Then it deletes every source repository and asserts the catalog and the sets both
still work -- which is the whole point of the feature.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from skillex.core.diagnostics import EXIT_OK, EXIT_REFUSED
from tests.conftest import run_cli, snapshot
from tests.vendor_helpers import write_source_skill

pytestmark = [
    pytest.mark.integration,
    pytest.mark.usefixtures("sandbox"),
    pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed"),
]

GIT_ENV = {
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
}


def commit(repo):
    env = {**os.environ, **GIT_ENV}
    for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "init"]):
        subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)
    return repo


SOURCES = """
version = 1

[[source]]
name    = "pjangler"
repo    = "git@github.com:delorenj/pjangler.git"
version = "main"
skills  = ["mise-tasks", "project-jangler"]

[[source]]
name    = "bloodbank"
repo    = "git@github.com:delorenj/bloodbank.git"
version = "main"

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

[[source]]
name     = "krebs"
repo     = "git@github.com:delorenj/33GOD.git"
version  = "main"
checkout = "33GOD"
subdir   = "krebs/skills"
"""

#: What the catalog holds after vendoring.
EXPECTED = {
    "mise-tasks",
    "project-jangler",
    "bloodbank-integration",
    "momo",
    "33god-hub",
    "task-triage",
}

#: What ``sets/min-global`` projects. Note ``pjangler``, not ``project-jangler``:
#: the projected name is the LINK name, and 33god-hub is in the catalog but not in
#: this set.
PROJECTED = {"mise-tasks", "bloodbank-integration", "momo", "pjangler", "task-triage"}


@pytest.fixture
def world(tmp_path, sandbox):
    """Four repos, a catalog of absolute symlinks, and a sets/ that bypasses it."""
    src = tmp_path / "src"

    pjangler = src / "pjangler"
    write_source_skill(pjangler / "skills", "mise-tasks", files={"scripts/go.sh": "#!/bin/sh\n"})
    os.chmod(pjangler / "skills" / "mise-tasks" / "scripts" / "go.sh", 0o755)
    write_source_skill(
        pjangler / "skills", "project-jangler", body="---\nname: pjangler\n---\n# pj\n"
    )
    commit(pjangler)

    bloodbank = src / "bloodbank"
    write_source_skill(bloodbank / "skills", "bloodbank-integration")
    commit(bloodbank)

    momo = src / "momo"
    write_source_skill(momo, "skill", body="---\nname: momo\n---\n# momo\n")
    commit(momo)

    god = src / "33GOD"
    write_source_skill(god / "33god-platform" / "skills", "33god-hub")
    write_source_skill(god / "krebs" / "skills", "task-triage")
    # The farm: 33GOD/skills/ is 16 absolute symlinks, and it is committed.
    (god / "skills").mkdir(parents=True)
    os.symlink(god / "33god-platform" / "skills" / "33god-hub", god / "skills" / "33god-hub")
    commit(god)

    catalog = sandbox.all_skills
    catalog.mkdir(parents=True, exist_ok=True)
    for name, target in (
        ("mise-tasks", pjangler / "skills" / "mise-tasks"),
        ("project-jangler", pjangler / "skills" / "project-jangler"),
        ("bloodbank-integration", bloodbank / "skills" / "bloodbank-integration"),
        ("momo", momo / "skill"),
        ("33god-hub", god / "skills" / "33god-hub"),
        ("task-triage", god / "krebs" / "skills" / "task-triage"),
    ):
        os.symlink(target, catalog / name)

    # sets/min-global: three links straight into the source repos (the 22-link
    # class), one alias whose NAME differs from the catalog name, and one link
    # that already goes through the catalog (the 3-link class).
    sets = sandbox.registry / "sets" / "min-global"
    sets.mkdir(parents=True, exist_ok=True)
    os.symlink(momo / "skill", sets / "momo")
    os.symlink(pjangler / "skills" / "project-jangler", sets / "pjangler")
    os.symlink(god / "krebs" / "skills" / "task-triage", sets / "task-triage")
    os.symlink("../../all-skills/mise-tasks", sets / "mise-tasks")
    os.symlink("../../all-skills/bloodbank-integration", sets / "bloodbank-integration")

    sources = tmp_path / "sources.toml"
    sources.write_text(SOURCES)
    checkouts = [
        arg
        for name, path in (
            ("pjangler", pjangler),
            ("bloodbank", bloodbank),
            ("momo", momo),
            ("33GOD", god),
        )
        for arg in ("--checkout", f"{name}={path}")
    ]
    return sandbox, catalog, sources, checkouts, src


def vendor(*args):
    return run_cli("vendor", *args)


def test_declaring_the_symlink_farm_refuses_loudly(world, tmp_path):
    """The mistake the obvious manifest makes. It must fail, not publish paths."""
    sandbox, catalog, _sources, _checkouts, _src = world
    bad = tmp_path / "bad.toml"
    bad.write_text(
        'version = 1\n\n[[source]]\nname = "33god"\n'
        'repo = "git@github.com:delorenj/33GOD.git"\nversion = "main"\n'
    )
    before = snapshot(catalog)
    code, out = vendor(
        "sync",
        "--catalog",
        str(catalog),
        "--sources",
        str(bad),
        "--checkout",
        f"33god={sandbox.tmp / 'src' / '33GOD'}",
        "--json",
    )
    payload = json.loads(out)
    assert code == EXIT_REFUSED
    finding = next(f for f in payload["findings"] if f["code"] == "E_SOURCE_ENTRY_IS_LINK")
    assert "[[source]]" in finding["fix"]
    assert snapshot(catalog) == before


def test_the_catalog_and_the_sets_both_survive_losing_every_source_repo(world):
    sandbox, catalog, sources, checkouts, src = world

    # 1. vendor: fifteen symlinks become real content.
    code, out = vendor(
        "sync", "--catalog", str(catalog), "--sources", str(sources), *checkouts, "--json"
    )
    payload = json.loads(out)
    assert code == EXIT_OK, out
    assert {op["name"] for op in payload["ops"]} == EXPECTED
    assert all(op["action"] == "replace-link" for op in payload["ops"])
    assert not any(p.is_symlink() for p in catalog.iterdir())

    # The two name hazards landed under their DECLARED names.
    assert (catalog / "momo" / "SKILL.md").is_file()  # source dir was `skill`
    assert "name: pjangler" in (catalog / "project-jangler" / "SKILL.md").read_text()
    assert os.access(catalog / "mise-tasks" / "scripts" / "go.sh", os.X_OK)

    # 2. relink: the composition links that bypassed the catalog.
    code, out = vendor(
        "relink", "--catalog", str(catalog), "--root", str(sandbox.registry), "--json"
    )
    assert code == EXIT_OK, out
    relinked = {op["link"].rsplit("/", 1)[-1] for op in json.loads(out)["relinks"]}
    assert relinked == {"momo", "pjangler", "task-triage"}

    sets = sandbox.registry / "sets" / "min-global"
    # The link NAME is preserved even where it differs from the catalog name.
    assert os.readlink(sets / "pjangler") == "../../all-skills/project-jangler"
    assert os.readlink(sets / "momo") == "../../all-skills/momo"

    # 3. machine 2: no source repositories at all.
    shutil.rmtree(src)
    for member in sets.iterdir():
        assert member.resolve().is_dir(), f"{member.name} dangles without the source repos"

    code, out = vendor("status", "--catalog", str(catalog), "--sources", str(sources), "--json")
    assert code == EXIT_OK, out
    assert {row["state"] for row in json.loads(out)["skills"]} == {"ok"}


def test_sync_projects_every_member_once_the_catalog_is_real(world):
    """The regression the whole feature exists to close: 36 -> 26 becomes 36."""
    sandbox, catalog, sources, checkouts, src = world
    sandbox.write_global_manifest({"scope": "global", "sets": ["min-global"], "skills": []})

    vendor("sync", "--catalog", str(catalog), "--sources", str(sources), *checkouts)
    vendor("relink", "--catalog", str(catalog), "--root", str(sandbox.registry))
    shutil.rmtree(src)

    code, out = run_cli("sync", "--json", cwd=sandbox.tmp)
    payload = json.loads(out)
    assert code == EXIT_OK, out
    linked = {op["name"] for scope in payload["scopes"] for op in scope["ops"]}
    assert linked == PROJECTED

    # Every projected name resolves to real content, and none of it is a link
    # out of the catalog, so W_SET_LINK_OUTSIDE_CATALOG has nothing to say.
    for name in PROJECTED:
        assert (sandbox.global_root / name).resolve().joinpath("SKILL.md").is_file()
    assert "W_SET_LINK_OUTSIDE_CATALOG" not in {f["code"] for f in payload["findings"]}


def test_a_second_vendor_run_is_a_no_op(world):
    _, catalog, sources, checkouts, _ = world
    vendor("sync", "--catalog", str(catalog), "--sources", str(sources), *checkouts)
    before = snapshot(catalog)
    code, out = vendor(
        "sync", "--catalog", str(catalog), "--sources", str(sources), *checkouts, "--json"
    )
    payload = json.loads(out)
    assert code == EXIT_OK
    assert payload["counts"]["unchanged"] == len(EXPECTED)
    assert payload["applied"] is False
    assert snapshot(catalog) == before
