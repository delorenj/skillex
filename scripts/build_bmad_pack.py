#!/usr/bin/env python3
"""Build and verify an immutable Skillex pack from a BMAD installation.

The BMAD installer renders agent-facing skills into ``.agent/skills``. This
tool validates those rendered bytes against the install manifests before they
become a versioned, shared Skillex pack. Project repositories can then keep
small symlink projections instead of vendoring thousands of generated files.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import re
import shutil
import tempfile
from pathlib import Path

VERSION_RE = re.compile(r"^\s{2}version:\s*([^\s#]+)\s*$", re.MULTILINE)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installation_version(manifest_path: Path) -> str:
    match = VERSION_RE.search(manifest_path.read_text(encoding="utf-8"))
    if match is None:
        raise ValueError(f"Unable to read installation version from {manifest_path}")
    return match.group(1)


def manifest_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def validate_source(source: Path, expected_version: str) -> tuple[list[Path], int]:
    config_root = source / "_bmad" / "_config"
    install_manifest = config_root / "manifest.yaml"
    file_manifest = config_root / "files-manifest.csv"
    skill_manifest = config_root / "skill-manifest.csv"
    skills_root = source / ".agent" / "skills"

    for required in (install_manifest, file_manifest, skill_manifest, skills_root):
        if not required.exists():
            raise ValueError(f"Required BMAD install artifact is missing: {required}")

    actual_version = installation_version(install_manifest)
    if actual_version != expected_version:
        raise ValueError(
            f"BMAD installation is {actual_version}, expected {expected_version}"
        )

    skills = sorted(
        path
        for path in skills_root.iterdir()
        if path.is_dir() and path.name.startswith("bmad-")
    )
    linked_skills = [path for path in skills if path.is_symlink()]
    if linked_skills:
        raise ValueError(f"Rendered source skills must be real directories: {linked_skills}")
    actual_names = {path.name for path in skills}
    declared_names = {row["name"] for row in manifest_rows(skill_manifest)}
    if actual_names != declared_names:
        missing = sorted(declared_names - actual_names)
        extra = sorted(actual_names - declared_names)
        raise ValueError(f"Rendered skill set differs from manifest; missing={missing}, extra={extra}")

    declared_files = manifest_rows(file_manifest)
    payload_files = 0
    for skill in skills:
        if not (skill / "SKILL.md").is_file():
            raise ValueError(f"Rendered skill has no SKILL.md: {skill}")
        for path in sorted(skill.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Rendered pack payload may not contain symlinks: {path}")
            if path.is_file():
                payload_files += 1
                digest = sha256(path)
                suffix = f"{skill.name}/{path.relative_to(skill).as_posix()}"
                matching_rows = [
                    row for row in declared_files if row["path"].endswith(suffix)
                ]
                if not any(row["hash"] == digest for row in matching_rows):
                    raise ValueError(
                        "Rendered file is not path-and-hash attested by "
                        f"files-manifest.csv: {path} ({digest})"
                    )

    if payload_files == 0:
        raise ValueError(f"BMAD installation contains no rendered skill files: {skills_root}")
    return skills, payload_files


def toml_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def render_pack_toml(
    version: str,
    skill_names: list[str],
    payload_files: int,
    source: Path,
) -> str:
    config_root = source / "_bmad" / "_config"
    lines = [
        "[pack]",
        'name = "bmad"',
        f"version = {toml_string(version)}",
        'description = "Immutable BMAD agent-skill payload, shared through symlink projections."',
        "",
        "[source]",
        'upstream = "bmad-method"',
        f"upstream_version = {toml_string(version)}",
        'rendered_from = ".agent/skills"',
        f"payload_files = {payload_files}",
        f"installation_manifest_sha256 = {toml_string(sha256(config_root / 'manifest.yaml'))}",
        f"files_manifest_sha256 = {toml_string(sha256(config_root / 'files-manifest.csv'))}",
        f"skill_manifest_sha256 = {toml_string(sha256(config_root / 'skill-manifest.csv'))}",
        "",
        "[freeform]",
        "skills = [",
        *[f"  {toml_string(name)}," for name in skill_names],
        "]",
        "",
        "[policy]",
        "immutable = true",
        'project_projection = "symlink"',
        "",
    ]
    return "\n".join(lines)


def render_readme(version: str, skill_count: int, payload_files: int) -> str:
    return f"""# BMAD {version} skill pack

Immutable, manifest-attested agent-skill payload rendered by
`bmad-method@{version}`. It contains {skill_count} skills and {payload_files}
files. Project repositories should link their agent skill directories to these
top-level `bmad-*` directories; they should not copy or edit this payload.

Rebuild or verify it from the original BMAD installation:

```bash
python scripts/build_bmad_pack.py SOURCE_PROJECT {version}
python scripts/build_bmad_pack.py --check SOURCE_PROJECT {version}
```

`SHA256SUMS` covers every payload and metadata file except itself.
"""


def tree_manifest(root: Path) -> str:
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            entries.append(f"{sha256(path)}  {path.relative_to(root).as_posix()}")
    return "\n".join(entries) + "\n"


def materialize_pack(source: Path, target: Path, version: str) -> None:
    skills, payload_files = validate_source(source, version)
    target.mkdir(parents=True)
    for skill in skills:
        shutil.copytree(skill, target / skill.name, copy_function=shutil.copy2)

    names = [path.name for path in skills]
    (target / "pack.toml").write_text(
        render_pack_toml(version, names, payload_files, source), encoding="utf-8"
    )
    (target / "README.md").write_text(
        render_readme(version, len(names), payload_files), encoding="utf-8"
    )
    (target / "SHA256SUMS").write_text(tree_manifest(target), encoding="utf-8")


def compare_trees(expected: Path, actual: Path) -> list[str]:
    expected_paths = {path.relative_to(expected) for path in expected.rglob("*")}
    actual_paths = {path.relative_to(actual) for path in actual.rglob("*")}
    differences = [f"missing: {path}" for path in sorted(expected_paths - actual_paths)]
    differences.extend(f"unexpected: {path}" for path in sorted(actual_paths - expected_paths))
    for relative in sorted(expected_paths & actual_paths):
        expected_path = expected / relative
        actual_path = actual / relative
        if expected_path.is_dir() != actual_path.is_dir():
            differences.append(f"type differs: {relative}")
        elif expected_path.is_file() and expected_path.read_bytes() != actual_path.read_bytes():
            differences.append(f"content differs: {relative}")
    return differences


def build_or_check(source: Path, repo_root: Path, version: str, check: bool) -> Path:
    target = repo_root / "packs" / "bmad" / version
    with tempfile.TemporaryDirectory(prefix=f"bmad-{version}-") as temp_dir:
        candidate = Path(temp_dir) / version
        materialize_pack(source, candidate, version)
        if check:
            if not target.is_dir():
                raise ValueError(f"Checked-in BMAD pack is missing: {target}")
            differences = compare_trees(candidate, target)
            if differences:
                preview = "\n".join(differences[:20])
                raise ValueError(f"Checked-in BMAD pack is not reproducible:\n{preview}")
        else:
            if target.exists():
                raise ValueError(f"Refusing to replace immutable BMAD pack: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(candidate, target)
    return target


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without changing files")
    parser.add_argument("source", type=Path, help="project containing the BMAD installation")
    parser.add_argument("version", help="exact BMAD installation version")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Skillex checkout root",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    target = build_or_check(
        args.source.resolve(), args.repo_root.resolve(), args.version, args.check
    )
    action = "verified" if args.check else "built"
    print(f"BMAD pack {action}: {target}")


if __name__ == "__main__":
    main()
