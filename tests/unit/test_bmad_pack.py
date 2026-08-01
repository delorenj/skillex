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
