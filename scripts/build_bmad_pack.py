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
import io
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path
from typing import NamedTuple

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


def manifest_rows(content: bytes) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(content.decode("utf-8"), newline="")))


def entry_kind(path: Path) -> str:
    mode = path.lstat().st_mode
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "non-regular"


def require_regular_file(path: Path) -> None:
    try:
        kind = entry_kind(path)
    except FileNotFoundError as error:
        raise ValueError(f"Required BMAD install artifact is missing: {path}") from error
    if kind != "file":
        raise ValueError(f"BMAD install artifact must be a regular file: {path} ({kind})")


def require_directory(path: Path) -> None:
    try:
        kind = entry_kind(path)
    except FileNotFoundError as error:
        raise ValueError(f"Required BMAD install artifact is missing: {path}") from error
    if kind != "directory":
        raise ValueError(f"BMAD install artifact must be a real directory: {path} ({kind})")


class SourceMetadata(NamedTuple):
    version: str
    skill_names: tuple[str, ...]
    declared_files: tuple[tuple[str, str], ...]
    payload_modes: tuple[tuple[str, int], ...]
    manifest_sha256: str
    files_manifest_sha256: str
    skill_manifest_sha256: str


def read_source_metadata(source: Path, expected_version: str) -> SourceMetadata:
    config_root = source / "_bmad" / "_config"
    install_manifest = config_root / "manifest.yaml"
    file_manifest = config_root / "files-manifest.csv"
    skill_manifest = config_root / "skill-manifest.csv"
    skills_root = source / ".agent" / "skills"

    for required in (install_manifest, file_manifest, skill_manifest):
        require_regular_file(required)
    require_directory(skills_root)

    install_bytes = install_manifest.read_bytes()
    files_bytes = file_manifest.read_bytes()
    skills_bytes = skill_manifest.read_bytes()
    actual_version = installation_version_from_bytes(install_bytes, install_manifest)
    if actual_version != expected_version:
        raise ValueError(
            f"BMAD installation is {actual_version}, expected {expected_version}"
        )

    skill_names = tuple(sorted(row["name"] for row in manifest_rows(skills_bytes)))
    if len(skill_names) != len(set(skill_names)):
        raise ValueError("BMAD skill manifest contains duplicate skill names")
    declared_files = tuple(
        (row["path"], row["hash"]) for row in manifest_rows(files_bytes)
    )
    payload_modes = tuple(sorted(regular_tree_modes(skills_root).items()))
    return SourceMetadata(
        version=actual_version,
        skill_names=skill_names,
        declared_files=declared_files,
        payload_modes=payload_modes,
        manifest_sha256=hashlib.sha256(install_bytes).hexdigest(),
        files_manifest_sha256=hashlib.sha256(files_bytes).hexdigest(),
        skill_manifest_sha256=hashlib.sha256(skills_bytes).hexdigest(),
    )


def regular_tree_modes(root: Path) -> dict[str, int]:
    modes: dict[str, int] = {}

    def visit(directory: Path) -> bool:
        contains_file = False
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            kind = entry_kind(path)
            if kind == "directory":
                if not visit(path):
                    raise ValueError(
                        f"Rendered pack payload may not contain empty directories: {path}"
                    )
                contains_file = True
            elif kind == "file":
                modes[path.relative_to(root).as_posix()] = stat.S_IMODE(
                    path.lstat().st_mode
                )
                contains_file = True
            else:
                raise ValueError(
                    "Rendered pack payload entries must be regular files/directories: "
                    f"{path} ({kind})"
                )
        return contains_file

    visit(root)
    return modes


def installation_version_from_bytes(content: bytes, path: Path) -> str:
    match = VERSION_RE.search(content.decode("utf-8"))
    if match is None:
        raise ValueError(f"Unable to read installation version from {path}")
    return match.group(1)


def copy_regular_tree(source: Path, target: Path) -> None:
    """Copy a tree without ever following symlinks or special files."""

    require_directory(source)
    target.mkdir(parents=False)
    for child in sorted(source.iterdir(), key=lambda path: path.name):
        kind = entry_kind(child)
        destination = target / child.name
        if kind == "directory":
            copy_regular_tree(child, destination)
        elif kind == "file":
            shutil.copy2(child, destination, follow_symlinks=False)
        else:
            raise ValueError(
                f"Rendered pack payload entries must be regular files/directories: "
                f"{child} ({kind})"
            )


def validate_staged_payload(payload_root: Path, metadata: SourceMetadata) -> int:
    require_directory(payload_root)
    skill_dirs: list[Path] = []
    for path in sorted(payload_root.iterdir(), key=lambda item: item.name):
        kind = entry_kind(path)
        if kind != "directory":
            raise ValueError(f"Rendered skill entry must be a directory: {path} ({kind})")
        if not path.name.startswith("bmad-"):
            raise ValueError(f"Unexpected rendered skill directory: {path}")
        skill_dirs.append(path)

    actual_names = tuple(path.name for path in skill_dirs)
    if actual_names != metadata.skill_names:
        missing = sorted(set(metadata.skill_names) - set(actual_names))
        extra = sorted(set(actual_names) - set(metadata.skill_names))
        raise ValueError(
            f"Rendered skill set differs from manifest; missing={missing}, extra={extra}"
        )

    attestations: dict[str, set[str]] = {}
    for declared_path, digest in metadata.declared_files:
        for skill_name in metadata.skill_names:
            marker = f"{skill_name}/"
            if marker in declared_path:
                suffix = declared_path[declared_path.index(marker) :]
                attestations.setdefault(suffix, set()).add(digest)
                break

    expected_modes = dict(metadata.payload_modes)
    actual_suffixes: set[str] = set()

    payload_files = 0
    for skill in skill_dirs:
        skill_md = skill / "SKILL.md"
        require_regular_file(skill_md)
        for path in sorted(skill.rglob("*")):
            kind = entry_kind(path)
            if kind == "directory":
                continue
            if kind != "file":
                raise ValueError(
                    f"Rendered pack payload entries must be regular files/directories: "
                    f"{path} ({kind})"
                )
            payload_files += 1
            suffix = f"{skill.name}/{path.relative_to(skill).as_posix()}"
            actual_suffixes.add(suffix)
            digest = sha256(path)
            if digest not in attestations.get(suffix, set()):
                raise ValueError(
                    "Rendered file is not path-and-hash attested by "
                    f"files-manifest.csv: {path} ({digest})"
                )
            actual_mode = stat.S_IMODE(path.lstat().st_mode)
            if expected_modes.get(suffix) != actual_mode:
                raise ValueError(
                    f"Rendered file mode changed while staging: {path} ({actual_mode:o})"
                )

    if payload_files == 0:
        raise ValueError(f"BMAD installation contains no rendered skill files: {payload_root}")
    if actual_suffixes != set(attestations) or actual_suffixes != set(expected_modes):
        missing = sorted(set(attestations) - actual_suffixes)
        extra = sorted(actual_suffixes - set(attestations))
        raise ValueError(
            f"Rendered payload inventory differs from manifests; missing={missing}, extra={extra}"
        )
    return payload_files


def validate_source(source: Path, expected_version: str) -> tuple[list[Path], int]:
    skills_root = source / ".agent" / "skills"
    metadata = read_source_metadata(source, expected_version)
    with tempfile.TemporaryDirectory(prefix="bmad-source-validation-") as temp_dir:
        staged = Path(temp_dir) / "skills"
        copy_regular_tree(skills_root, staged)
        payload_files = validate_staged_payload(staged, metadata)
    return [skills_root / name for name in metadata.skill_names], payload_files


def toml_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def render_pack_toml(
    version: str,
    skill_names: list[str],
    payload_files: int,
    metadata: SourceMetadata,
) -> str:
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
        f"installation_manifest_sha256 = {toml_string(metadata.manifest_sha256)}",
        f"files_manifest_sha256 = {toml_string(metadata.files_manifest_sha256)}",
        f"skill_manifest_sha256 = {toml_string(metadata.skill_manifest_sha256)}",
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
        relative = path.relative_to(root)
        kind = entry_kind(path)
        if relative == Path("SHA256SUMS"):
            continue
        if kind == "file":
            entries.append(f"{sha256(path)}  {path.relative_to(root).as_posix()}")
        elif kind != "directory":
            raise ValueError(f"Pack metadata may not contain {kind} entries: {path}")
    return "\n".join(entries) + "\n"


def materialize_pack(source: Path, target: Path, version: str) -> None:
    metadata = read_source_metadata(source, version)
    skills_root = source / ".agent" / "skills"
    target.mkdir(parents=True)
    staged_payload = target / ".payload-staging"
    copy_regular_tree(skills_root, staged_payload)
    payload_files = validate_staged_payload(staged_payload, metadata)
    for skill_name in metadata.skill_names:
        os.replace(staged_payload / skill_name, target / skill_name)
    staged_payload.rmdir()

    names = list(metadata.skill_names)
    (target / "pack.toml").write_text(
        render_pack_toml(version, names, payload_files, metadata), encoding="utf-8"
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
        expected_kind = entry_kind(expected_path)
        actual_kind = entry_kind(actual_path)
        if expected_kind != actual_kind:
            differences.append(f"type differs: {relative}")
            continue
        expected_mode = stat.S_IMODE(expected_path.lstat().st_mode)
        actual_mode = stat.S_IMODE(actual_path.lstat().st_mode)
        if expected_mode != actual_mode:
            differences.append(f"mode differs: {relative}")
        if expected_kind == "file" and expected_path.read_bytes() != actual_path.read_bytes():
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
