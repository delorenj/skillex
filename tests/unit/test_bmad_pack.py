from __future__ import annotations

import csv
import hashlib
import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "build_bmad_pack.py"
SPEC = importlib.util.spec_from_file_location("build_bmad_pack", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
build_bmad_pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_bmad_pack)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def source_fixture(tmp_path: Path, content: bytes = b"---\nname: bmad-one\n---\n") -> Path:
    source = tmp_path / "source"
    skill_file = source / ".agent" / "skills" / "bmad-one" / "SKILL.md"
    skill_file.parent.mkdir(parents=True)
    skill_file.write_bytes(content)
    config = source / "_bmad" / "_config"
    config.mkdir(parents=True)
    (config / "manifest.yaml").write_text(
        "installation:\n  version: 6.10.1-next.31\n", encoding="utf-8"
    )
    write_csv(
        config / "skill-manifest.csv",
        ["canonicalId", "name", "description", "module", "path"],
        [
            {
                "canonicalId": "bmad-one",
                "name": "bmad-one",
                "description": "fixture",
                "module": "core",
                "path": "core/bmad-one/SKILL.md",
            }
        ],
    )
    write_csv(
        config / "files-manifest.csv",
        ["type", "name", "module", "path", "hash"],
        [
            {
                "type": "md",
                "name": "SKILL",
                "module": "core",
                "path": "core/bmad-one/SKILL.md",
                "hash": hashlib.sha256(content).hexdigest(),
            }
        ],
    )
    return source


def test_build_is_reproducible_and_immutable(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    repo = tmp_path / "skillex"

    target = build_bmad_pack.build_or_check(source, repo, "6.10.1-next.31", check=False)

    assert (target / "bmad-one" / "SKILL.md").is_file()
    assert "bmad-one/SKILL.md" in (target / "SHA256SUMS").read_text()
    build_bmad_pack.build_or_check(source, repo, "6.10.1-next.31", check=True)
    with pytest.raises(ValueError, match="Refusing to replace immutable"):
        build_bmad_pack.build_or_check(source, repo, "6.10.1-next.31", check=False)


def test_rejects_unattested_rendered_bytes(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    (source / ".agent" / "skills" / "bmad-one" / "SKILL.md").write_text(
        "tampered\n", encoding="utf-8"
    )

    with pytest.raises(ValueError, match="not path-and-hash attested"):
        build_bmad_pack.validate_source(source, "6.10.1-next.31")


def test_rejects_skill_set_drift(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    extra = source / ".agent" / "skills" / "bmad-extra" / "SKILL.md"
    extra.parent.mkdir(parents=True)
    extra.write_text("extra\n", encoding="utf-8")

    with pytest.raises(ValueError, match="differs from manifest"):
        build_bmad_pack.validate_source(source, "6.10.1-next.31")


def test_rejects_unauthenticated_empty_directory(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    (source / ".agent" / "skills" / "bmad-one" / "empty").mkdir()

    with pytest.raises(ValueError, match="empty directories"):
        build_bmad_pack.build_or_check(source, tmp_path / "skillex", "6.10.1-next.31", check=False)


def test_rejects_source_mutation_during_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = source_fixture(tmp_path)
    repo = tmp_path / "skillex"
    source_skill = source / ".agent" / "skills" / "bmad-one" / "SKILL.md"
    original_copy2 = build_bmad_pack.shutil.copy2
    mutated = False

    def mutating_copy(source_path: Path, target_path: Path, **kwargs: object) -> Path:
        nonlocal mutated
        if Path(source_path) == source_skill and not mutated:
            source_skill.write_text("mutated during copy\n", encoding="utf-8")
            mutated = True
        return original_copy2(source_path, target_path, **kwargs)

    monkeypatch.setattr(build_bmad_pack.shutil, "copy2", mutating_copy)
    with pytest.raises(ValueError, match="not path-and-hash attested"):
        build_bmad_pack.build_or_check(source, repo, "6.10.1-next.31", check=False)
    assert not (repo / "packs" / "bmad" / "6.10.1-next.31").exists()


def test_rejects_symlink_substitution(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    skill_file = source / ".agent" / "skills" / "bmad-one" / "SKILL.md"
    real_file = source / "real-skill.md"
    real_file.write_bytes(skill_file.read_bytes())
    skill_file.unlink()
    skill_file.symlink_to(real_file)

    with pytest.raises(ValueError, match="regular files/directories"):
        build_bmad_pack.build_or_check(source, tmp_path / "skillex", "6.10.1-next.31", check=False)


def test_rejects_mode_mutation_during_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = source_fixture(tmp_path)
    source_skill = source / ".agent" / "skills" / "bmad-one" / "SKILL.md"
    original_copy2 = build_bmad_pack.shutil.copy2
    mutated = False

    def mutating_copy(source_path: Path, target_path: Path, **kwargs: object) -> Path:
        nonlocal mutated
        if Path(source_path) == source_skill and not mutated:
            source_skill.chmod(0o755)
            mutated = True
        return original_copy2(source_path, target_path, **kwargs)

    monkeypatch.setattr(build_bmad_pack.shutil, "copy2", mutating_copy)
    with pytest.raises(ValueError, match="mode changed while staging"):
        build_bmad_pack.build_or_check(source, tmp_path / "skillex", "6.10.1-next.31", check=False)


def test_compare_trees_detects_symlinks_and_mode_drift(tmp_path: Path) -> None:
    expected = tmp_path / "expected"
    actual = tmp_path / "actual"
    expected.mkdir()
    actual.mkdir()
    expected_file = expected / "tool.py"
    actual_file = actual / "tool.py"
    expected_file.write_text("print('ok')\n", encoding="utf-8")
    actual_file.write_text("print('ok')\n", encoding="utf-8")
    expected_file.chmod(0o755)
    actual_file.chmod(0o644)

    assert build_bmad_pack.compare_trees(expected, actual) == ["mode differs: tool.py"]

    actual_file.unlink()
    actual_file.symlink_to(expected_file)
    assert build_bmad_pack.compare_trees(expected, actual) == ["type differs: tool.py"]


def test_tree_manifest_excludes_only_root_checksum_file(tmp_path: Path) -> None:
    root = tmp_path / "pack"
    nested = root / "bmad-one"
    nested.mkdir(parents=True)
    (root / "SHA256SUMS").write_text("old\n", encoding="utf-8")
    (nested / "SHA256SUMS").write_text("payload\n", encoding="utf-8")

    manifest = build_bmad_pack.tree_manifest(root)

    assert "bmad-one/SHA256SUMS" in manifest
    assert "  SHA256SUMS\n" not in manifest
