from __future__ import annotations

from pathlib import Path

from skillex.core.topology import TopologyCode, check_topology


def write_skill(root: Path, name: str) -> Path:
    skill = root / "all-skills" / name
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
    return skill


def base_repo(tmp_path: Path) -> Path:
    (tmp_path / "all-skills").mkdir()
    (tmp_path / "skill-sets").mkdir()
    (tmp_path / "packs").mkdir()
    return tmp_path


def codes(root: Path) -> set[TopologyCode]:
    return {finding.code for finding in check_topology(root, include_activation=False).findings}


def test_manifest_only_pack_and_symlink_set_are_reference_only(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    alpha = write_skill(root, "alpha")
    global_set = root / "skill-sets" / "global"
    global_set.mkdir()
    (global_set / "alpha").symlink_to(alpha)
    pack = root / "packs" / "dev"
    pack.mkdir()
    (pack / "pack.toml").write_text(
        '[pack]\nname = "dev"\n\n[freeform]\nskills = ["alpha"]\n',
        encoding="utf-8",
    )

    report = check_topology(root, include_activation=False)

    assert report.ok
    assert report.canonical_skills == 1
    assert report.pack_manifests == 1


def test_real_skill_inside_pack_is_rejected(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    write_skill(root, "alpha")
    embedded = root / "packs" / "legacy" / "alpha"
    embedded.mkdir(parents=True)
    (embedded / "SKILL.md").write_text("# duplicate\n", encoding="utf-8")

    assert TopologyCode.COMPOSITION_EMBEDDED_SKILL in codes(root)


def test_linked_catalog_definition_is_rejected(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    external = tmp_path / "external" / "alpha"
    external.mkdir(parents=True)
    (external / "SKILL.md").write_text("# external\n", encoding="utf-8")
    (root / "all-skills" / "alpha").symlink_to(external)

    assert TopologyCode.CATALOG_LINKED_DEFINITION in codes(root)


def test_missing_pack_reference_is_rejected(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    pack = root / "packs" / "dev"
    pack.mkdir()
    (pack / "pack.toml").write_text(
        '[pack]\nname = "dev"\n\n[freeform]\nskills = ["missing"]\n',
        encoding="utf-8",
    )

    assert TopologyCode.PACK_REFERENCE_MISSING in codes(root)


def test_dangling_composition_link_is_rejected(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    pack = root / "packs" / "dev"
    pack.mkdir()
    (pack / "missing").symlink_to(root / "all-skills" / "missing")

    assert TopologyCode.COMPOSITION_DANGLING_LINK in codes(root)


def test_skill_link_outside_catalog_is_rejected(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    external = tmp_path / "external" / "alpha"
    external.mkdir(parents=True)
    (external / "SKILL.md").write_text("# external\n", encoding="utf-8")
    group = root / "skill-sets" / "global"
    group.mkdir()
    (group / "alpha").symlink_to(external)

    assert TopologyCode.COMPOSITION_LINK_OUTSIDE_CATALOG in codes(root)


def test_cli_skill_root_must_alias_activation_root(tmp_path: Path) -> None:
    root = base_repo(tmp_path)
    write_skill(root, "alpha")
    (root / ".agents" / "skills").mkdir(parents=True)
    (root / ".claude" / "skills").mkdir(parents=True)

    report = check_topology(root)

    assert TopologyCode.CLI_ROOT_NOT_ALIAS in {finding.code for finding in report.findings}
