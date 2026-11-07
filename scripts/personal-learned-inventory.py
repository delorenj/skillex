#!/usr/bin/env python3
"""Read-only, fail-closed inventory for migrating a named agent's learned skills.

This is an admission probe, not a writer, activation adapter, or Git checkpoint.
No source or profile directory is changed by this command.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

import yaml

SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def advertised_names(selected: Path) -> set[str]:
    """Include both directory names and the public names advertised by selections."""
    names = set()
    if not selected.exists() and not selected.is_symlink():
        return names
    # Selection roots and projected leaves can be approved aliases. Resolve only
    # in this read-only inventory, with cycle/size bounds; never in author trees.
    selected = selected.resolve(strict=True)
    directory(selected)
    pending = [selected]
    visited = set()
    count = 0
    while pending:
        root = pending.pop().resolve(strict=True)
        if root in visited:
            continue
        visited.add(root)
        for child in root.iterdir():
            count += 1
            if count > 20000:
                raise InventoryError("selected skill tree exceeds 20000 entries")
            if child.name.startswith(".") or not child.is_dir():
                continue
            names.add(child.name)
            skill = child / "SKILL.md"
            if skill.is_file():
                content = skill.read_text(encoding="utf-8")
                if content.startswith("---\n") and "\n---\n" in content[4:]:
                    front = yaml.safe_load(content[4:].split("\n---\n", 1)[0])
                    if isinstance(front, dict) and isinstance(front.get("name"), str):
                        names.add(front["name"])
            else:
                pending.append(child)
    return names


class InventoryError(Exception):
    pass


def directory(path: Path) -> None:
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise InventoryError(f"expected real directory: {path}")


def regular(path: Path) -> None:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise InventoryError(f"expected regular file: {path}")


def mapping(path: Path) -> dict:
    regular(path)
    data = yaml.safe_load(path.read_bytes())
    if not isinstance(data, dict):
        raise InventoryError(f"expected YAML mapping: {path}")
    return data


def inventory(profile: Path, identity: Path, *, allow_bound: bool = False) -> dict:
    directory(profile)
    directory(identity)
    metadata = mapping(profile / "profile.yaml")
    contract = mapping(identity / "contract.yaml")
    name = contract.get("id")
    if not isinstance(name, str) or not SKILL_NAME.fullmatch(name):
        raise InventoryError("identity contract has invalid id")
    if identity.name != name or metadata.get("name") != name:
        raise InventoryError("profile and contract do not bind the same identity")
    flume = metadata.get("flume")
    if not isinstance(flume, dict) or flume.get("employment") != "portable-specialist":
        raise InventoryError("profile is not a named portable specialist")
    definition = flume.get("definition")
    if definition != str(identity / "agent.yaml"):
        raise InventoryError("profile definition does not bind this identity desk")
    regular(identity / "agent.yaml")
    root = profile / "learned-skills"
    if root.is_symlink():
        if not allow_bound or root.resolve() != (identity / "learned-skills").resolve():
            raise InventoryError(f"learned root must be a real directory or admitted bound link: {root}")
        directory(root.resolve())
    elif root.exists():
        directory(root)
    else:
        return {"identity": name, "profile": str(profile), "source": str(identity),
                "skills": [], "entry_count": 0}
    selected_names = advertised_names(profile / "skills") | advertised_names(Path.home() / ".agents/skills")
    skills = []
    names = set()
    count = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        base_path = Path(base)
        for child_name in dirs + files:
            child = base_path / child_name
            mode = child.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise InventoryError(f"learned tree contains link or special file: {child}")
            count += 1
            if count > 20000:
                raise InventoryError("learned tree exceeds 20000 entries")
        if "SKILL.md" not in files:
            continue
        relative = base_path.relative_to(root)
        if relative == Path("."):
            raise InventoryError("learned root cannot itself be a skill")
        skill_name = base_path.name
        if not SKILL_NAME.fullmatch(skill_name) or skill_name in names or skill_name in selected_names:
            raise InventoryError(f"invalid, duplicate or selected skill name: {skill_name}")
        names.add(skill_name)
        # YAML frontmatter, not the entire Markdown document, is a mapping.
        content = (base_path / "SKILL.md").read_text(encoding="utf-8")
        if not content.startswith("---\n") or "\n---\n" not in content[4:]:
            raise InventoryError(f"missing skill frontmatter: {base_path}")
        frontmatter = yaml.safe_load(content[4:].split("\n---\n", 1)[0])
        if (not isinstance(frontmatter, dict) or frontmatter.get("name") != skill_name
                or not isinstance(frontmatter.get("description"), str)
                or not frontmatter["description"].strip()):
            raise InventoryError(f"skill metadata name or description is invalid: {base_path}")
        payload = []
        for walk_base, _subdirs, subfiles in os.walk(base_path, followlinks=False):
            for filename in sorted(subfiles):
                file = Path(walk_base) / filename
                regular(file)
                payload.append({
                    "path": file.relative_to(root).as_posix(),
                    "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                })
        skills.append({"name": skill_name, "directory": relative.as_posix(), "files": payload})
    return {"identity": name, "profile": str(profile), "source": str(identity),
            "skills": sorted(skills, key=lambda row: row["directory"]), "entry_count": count}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inventory(args.profile, args.identity), sort_keys=True))
    except (InventoryError, OSError, UnicodeError, yaml.YAMLError) as exc:
        print(f"personal learning inventory refused: {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
