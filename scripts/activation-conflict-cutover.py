#!/usr/bin/env python3
"""Preserve legacy activation containers, then hand ownership to Skillex sync.

Only four explicitly named project/root pairs are supported. Never remove a skill
payload or mutate a manifest. Preview is read-only; --apply needs --backup-root.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

PROJECTS = {
    "tolt/lost-things-forge": ".agents/skills",
    "sidepiece": ".kimi/skills",
    "skillex": ".kimi/skills",
    "slowburns": ".kimi/skills",
}
BASE = Path("/home/delorenj/code")


def inventory(path: Path) -> dict:
    """No-follow tree digest; link destinations are separately checked for visibility."""
    if path.is_symlink():
        return {"kind": "link", "target": os.readlink(path)}
    if path.is_file():
        return {"kind": "file", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    if path.is_dir():
        return {"kind": "directory", "children": {p.name: inventory(p) for p in sorted(path.iterdir())}}
    raise ValueError(f"Unsupported or missing object: {path}")


def visible(path: Path) -> dict[str, str]:
    if not path.is_dir():
        raise ValueError(f"Discovery root is not accessible: {path}")
    result = {}
    for child in path.iterdir():
        skill = child / "SKILL.md"
        if skill.is_file():
            result[child.name] = hashlib.sha256(skill.read_bytes()).hexdigest()
    return result


def run_sync(project: Path, apply: bool) -> dict:
    proc = subprocess.run(
        [os.environ.get("SKILLEX_BIN", "skillex"), "sync", "--scope", "project", "--project", str(project),
         *([] if apply else ["--dry-run"]), "--json"],
        capture_output=True, text=True, cwd="/", check=False,
    )
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Skillex returned non-JSON (exit {proc.returncode}): {proc.stderr[:300]}") from exc
    if proc.returncode or not data.get("ok"):
        raise ValueError(f"Skillex sync refused (exit {proc.returncode}): {data.get('findings')}")
    return data


def cutover(project: Path, backup_root: Path | None = None, apply: bool = False) -> dict:
    project = project.resolve(strict=True)
    relative = project.relative_to(BASE).as_posix()
    if relative not in PROJECTS:
        raise ValueError("Only the four audited project roots are supported")
    alias = project / PROJECTS[relative]
    canonical = project / ".agents/skills"
    # A completed cutover can be previewed without touching an existing backup.
    if alias.is_symlink() and alias.resolve() == canonical.resolve() and alias != canonical:
        return {"project": relative, "status": "already-aliased", "sync": run_sync(project, False)}
    if alias == canonical and alias.is_dir() and not alias.is_symlink():
        return {"project": relative, "status": "already-cut-over", "sync": run_sync(project, False)}
    if not alias.exists() and not alias.is_symlink():
        raise ValueError(f"Missing activation container: {alias}")
    if alias == canonical:
        if not alias.is_symlink() or os.readlink(alias) != "../skills" or alias.resolve() != project / "skills":
            raise ValueError("Expected only the audited ../skills root alias")
    elif not alias.is_dir() or alias.is_symlink():
        raise ValueError("Expected a real legacy client directory")
    if not canonical.is_dir() or (alias != canonical and canonical.is_symlink()):
        raise ValueError("Expected an existing real canonical directory")
    before = visible(alias)
    union = visible(canonical) | visible(Path.home() / ".agents/skills")
    missing = sorted(set(before) - set(union))
    if missing:
        raise ValueError(f"Legacy visible skill names absent from canonical/global union: {missing}")
    differing = sorted(name for name, digest in before.items() if union[name] != digest)
    tree = inventory(alias)
    result = {"project": relative, "status": "ready", "alias": str(alias), "inventory": tree,
              "visible": before, "source_variants": differing, "backup": None}
    if not apply:
        return result
    if backup_root is None or not backup_root.is_absolute():
        raise ValueError("--apply requires an absolute --backup-root outside every discovery root")
    backup_root = backup_root.resolve(strict=True)
    if backup_root.is_symlink() or not backup_root.is_dir() or backup_root.is_relative_to(project):
        raise ValueError("Backup root must be an existing real directory outside the project")
    global_discovery = (Path.home() / ".agents/skills").resolve()
    if backup_root == global_discovery or backup_root.is_relative_to(global_discovery):
        raise ValueError("Backup root cannot be inside global skill discovery")
    if backup_root.stat().st_dev != alias.parent.stat().st_dev:
        raise ValueError("Backup root must be on the same filesystem for atomic rename")
    dest = backup_root / (relative.replace("/", "--") + "--" + alias.parent.name + "--skills")
    record = backup_root / (dest.name + ".json")
    if dest.exists() or dest.is_symlink() or record.exists():
        raise ValueError("Backup destination or record already exists; never overwrite preserved content")
    # The recovery note is durable before modifying the activation path. It is
    # intentionally not a Skillex ownership receipt and makes no ownership claim.
    recovery = {"project": str(project), "original": str(alias), "preserved": str(dest),
                "inventory": tree, "visible": before, "source_variants": differing, "created_at": int(time.time()),
                "recovery": "Inspect the preserved object and sync receipt; restore only after moving the current root aside."}
    fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(recovery, stream, indent=2, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.rename(alias, dest)
    result["backup"] = str(dest)
    if inventory(dest) != tree:
        raise ValueError(f"Preserved tree changed; recovery at {dest}")
    try:
        sync = run_sync(project, True)
        after = visible(canonical)
        global_visible = visible(Path.home() / ".agents/skills")
        # Local repo-owned definitions can be selected by the project manifest;
        # compare source identity via the canonical projection, not just global.
        if set(before) - set(after | global_visible):
            raise ValueError("Skill names lost visibility after sync; preserved original is available")
        result.update(status="applied", sync=sync, repeat=run_sync(project, False))
    except Exception:
        # Never replace a newly created root or fake rollback after sync.
        raise ValueError(f"Cutover needs inspection; preserved original at {dest}; recovery note {record}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-root", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(cutover(args.project, args.backup_root, args.apply), indent=2, sort_keys=True))
        return 0
    except (ValueError, OSError) as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
