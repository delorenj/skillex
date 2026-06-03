#!/usr/bin/env python3
"""skill_ssot.py — Single-source-of-truth enforcer for the skillex ecosystem.

Invariant: every skill exists exactly once in $SKILLS_AVAILABLE/<name>/.
Anywhere else a skill appears (skill-sets/*, ~/.claude/skills/, etc.) it must be
a symlink into $SKILLS_AVAILABLE.

Commands:
    backfill            Write .source.yaml (origin.type=local) for skills missing one.
    sweep [PATH ...]    Scan watch paths (or given paths). Rescue strays.
    rescue PATH         Rescue a single directory (called by the inotify daemon).
    list-paths          Print configured watch paths that actually exist.
    doctor              Report invariant violations without fixing.

Config:
    $SKILLS_AVAILABLE or skillex.toml [skillex].skills_root  -> SSoT location.
    ~/.config/skillex/ssot-watch-paths                       -> watch list (one per line).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "skillex"
WATCH_LIST_PATH = CONFIG_DIR / "ssot-watch-paths"
SKILLEX_TOML = CONFIG_DIR / "skillex.toml"

SKILL_MARKER_FILES = ("SKILL.md", "SKILL.yaml", "SKILL.yml")
SOURCE_YAML = ".source.yaml"
QUARANTINE_DIR_NAME = ".quarantine"
CONFLICTS_DIR_NAME = ".conflicts"
RESERVED_GENERATED_PREFIXES = ("source-command-",)


# ----------------------------- path resolution ------------------------------ #

def skills_available() -> Path:
    env = os.environ.get("SKILLS_AVAILABLE")
    if env:
        return Path(env).expanduser().resolve()
    if SKILLEX_TOML.is_file():
        with SKILLEX_TOML.open("rb") as f:
            data = tomllib.load(f)
        root = data.get("skillex", {}).get("skills_root")
        if root:
            return Path(root).expanduser().resolve()
    return Path("/home/delorenj/code/skillex/all-skills").resolve()


def watch_paths() -> list[Path]:
    if WATCH_LIST_PATH.is_file():
        paths: list[Path] = []
        for line in WATCH_LIST_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            paths.append(Path(line).expanduser())
        return paths
    return []


def existing_watch_paths() -> list[Path]:
    return [p for p in watch_paths() if p.is_dir() and not p.is_symlink()]


# ----------------------------- helpers -------------------------------------- #

def log(level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"{ts} [{level}] {msg}", file=sys.stderr if level != "info" else sys.stdout, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def looks_like_skill(d: Path) -> bool:
    return any((d / fn).is_file() for fn in SKILL_MARKER_FILES)


def is_reserved_generated_skill(name: str) -> bool:
    return any(name.startswith(prefix) for prefix in RESERVED_GENERATED_PREFIXES)


def write_source_yaml(skill_dir: Path, origin_type: str, rescued_from: Path | None = None) -> None:
    """Hand-write a minimal YAML doc. Stdlib-only to keep the script dep-free."""
    out = skill_dir / SOURCE_YAML
    if out.exists():
        return
    lines = [
        "# Provenance for this skill. Managed by skill_ssot.py.",
        "origin:",
        f"  type: {origin_type}",
        f"  extracted_at: {now_iso()}",
    ]
    if rescued_from is not None:
        # Quote path defensively (no special-char escaping needed for typical FS paths).
        lines.append(f"  rescued_from: \"{rescued_from}\"")
    lines.append("modified_locally: false")
    lines.append("")
    out.write_text("\n".join(lines))


def quarantine(path: Path, reason: str) -> Path:
    """Move `path` into $SKILLS_AVAILABLE/.quarantine/<ts>_<reason>/<name>/. Returns new location."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_origin = str(path.parent).replace("/", "_").strip("_")
    qroot = skills_available() / QUARANTINE_DIR_NAME / f"{ts}_{reason}_{safe_origin}"
    qroot.mkdir(parents=True, exist_ok=True)
    dest = qroot / path.name
    shutil.move(str(path), str(dest))
    return dest


# ----------------------------- core rescue ---------------------------------- #

def rescue_one(path: Path) -> tuple[str, str]:
    """Process a single candidate directory. Returns (action, detail)."""
    if not path.exists():
        return ("skip", "vanished")
    if path.is_symlink():
        return ("skip", "already a symlink")
    if not path.is_dir():
        return ("skip", "not a directory")
    name = path.name
    if name.startswith("."):
        return ("skip", "hidden")
    if not looks_like_skill(path):
        return ("skip", "no SKILL marker")
    if is_reserved_generated_skill(name):
        quarantined = quarantine(path, reason="reserved-generated")
        return ("quarantined", f"{path} parked at {quarantined}; no active symlink created")

    ssoT = skills_available()
    target = ssoT / name

    # Refuse to act on something that's already inside the SSoT directly.
    try:
        path.resolve().relative_to(ssoT)
        return ("skip", "inside SSoT")
    except ValueError:
        pass

    if not target.exists():
        # Move into SSoT, write provenance, symlink back.
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(target))
        write_source_yaml(target, origin_type="adhoc", rescued_from=path)
        os.symlink(target, path)
        return ("rescued", f"{path} -> {target}")

    # Target already exists. Quarantine the new arrival (never delete) and symlink to the existing skill.
    quarantined = quarantine(path, reason="duplicate")
    os.symlink(target, path)
    return ("dedup", f"{path} symlinked to {target}; original parked at {quarantined}")


# ----------------------------- commands ------------------------------------- #

def cmd_backfill(_args: argparse.Namespace) -> int:
    ssoT = skills_available()
    if not ssoT.is_dir():
        log("error", f"skills root does not exist: {ssoT}")
        return 2
    written = 0
    skipped = 0
    for child in sorted(ssoT.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if not looks_like_skill(child):
            continue
        if (child / SOURCE_YAML).exists():
            skipped += 1
            continue
        write_source_yaml(child, origin_type="local")
        written += 1
    log("info", f"backfill: wrote {written}, skipped {skipped} (already had .source.yaml) in {ssoT}")
    return 0


def cmd_sweep(args: argparse.Namespace) -> int:
    targets = [Path(p).expanduser() for p in args.paths] if args.paths else existing_watch_paths()
    if not targets:
        log("error", "no watch paths to sweep")
        return 2
    total = {"rescued": 0, "dedup": 0, "skip": 0}
    for root in targets:
        if not root.is_dir():
            log("warn", f"watch path missing: {root}")
            continue
        for entry in sorted(root.iterdir()):
            action, detail = rescue_one(entry)
            total[action] = total.get(action, 0) + 1
            if action != "skip":
                log("info", f"{action}: {detail}")
    log("info", f"sweep complete: {total}")
    return 0


def cmd_rescue(args: argparse.Namespace) -> int:
    action, detail = rescue_one(Path(args.path).expanduser())
    if action == "skip":
        log("debug", f"skip {args.path}: {detail}")
    else:
        log("info", f"{action}: {detail}")
    return 0


def cmd_list_paths(_args: argparse.Namespace) -> int:
    for p in existing_watch_paths():
        print(p)
    return 0


def cmd_doctor(_args: argparse.Namespace) -> int:
    ssoT = skills_available()
    issues = 0
    for root in existing_watch_paths():
        for entry in sorted(root.iterdir()):
            if entry.is_symlink():
                target = entry.resolve()
                try:
                    target.relative_to(ssoT)
                except ValueError:
                    log("warn", f"{entry}: symlink points outside SSoT -> {target}")
                    issues += 1
                if not target.exists():
                    log("warn", f"{entry}: dangling symlink -> {target}")
                    issues += 1
            elif entry.is_dir() and not entry.name.startswith("."):
                log("warn", f"{entry}: real directory (not a symlink) -- needs rescue")
                issues += 1
    if not (ssoT / QUARANTINE_DIR_NAME).exists():
        pass
    else:
        items = list((ssoT / QUARANTINE_DIR_NAME).iterdir())
        if items:
            log("info", f"quarantine has {len(items)} batches awaiting review: {ssoT / QUARANTINE_DIR_NAME}")
    log("info", f"doctor: {issues} issue(s)")
    return 0 if issues == 0 else 1


# ----------------------------- entry ---------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("backfill", help="write .source.yaml for skills missing one").set_defaults(func=cmd_backfill)

    sp_sweep = sub.add_parser("sweep", help="one-pass scan; rescue strays")
    sp_sweep.add_argument("paths", nargs="*", help="override watch paths (default: configured)")
    sp_sweep.set_defaults(func=cmd_sweep)

    sp_rescue = sub.add_parser("rescue", help="rescue a single directory")
    sp_rescue.add_argument("path")
    sp_rescue.set_defaults(func=cmd_rescue)

    sub.add_parser("list-paths", help="print existing configured watch paths").set_defaults(func=cmd_list_paths)
    sub.add_parser("doctor", help="report invariant violations").set_defaults(func=cmd_doctor)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
