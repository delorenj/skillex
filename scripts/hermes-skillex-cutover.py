#!/usr/bin/env python3
"""Explicit, preservation-first PM cutover. Preview by default; never restarts services.

Uses Skillex for selection/ownership and the fleet renderer for configuration.
Foreign objects are renamed into private quarantine, never deleted or adopted.
"""

import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import uuid
from pathlib import Path

# Mirrors src/core/profile-policy.ts: Hermes bookkeeping that is never a skill.
SAFE_METADATA = {
    ".usage.json",
    ".usage.json.lock",
    ".curator_state",
    ".curator_suppressed",
    ".sync_state",
}
SAFE_METADATA_DIRS = {".curator_backups"}


def safe_metadata(path):
    if path.is_symlink():
        return False
    if path.name in SAFE_METADATA:
        return path.is_file()
    return path.name in SAFE_METADATA_DIRS and path.is_dir()


def fingerprint(path):
    info = path.lstat()
    value = [info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns]
    if stat.S_ISLNK(info.st_mode):
        value.append(os.readlink(path))
    elif stat.S_ISREG(info.st_mode):
        value.append(hashlib.sha256(path.read_bytes()).hexdigest())
    elif stat.S_ISDIR(info.st_mode):
        value.append({p.name: fingerprint(p) for p in sorted(path.iterdir())})
    else:
        raise RuntimeError(f"unsupported special object: {path}")
    return value


def plan_root(profile, owned):
    if profile.is_symlink() or not profile.is_dir():
        raise RuntimeError(f"real named profile required: {profile}")
    root = profile / "skills"
    if root.is_symlink():
        return {"alias": True, "root": fingerprint(root), "children": {}}
    if not root.is_dir():
        raise RuntimeError(f"skills root missing or not a directory: {root}")
    children = {
        p.name: fingerprint(p)
        for p in sorted(root.iterdir())
        if p.name not in owned and not safe_metadata(p)
    }
    info = root.lstat()
    return {"alias": False, "root": [info.st_dev, info.st_ino, info.st_mode], "children": children}


def preserve_root(profile, plan, quarantine):
    root = profile / "skills"
    if plan["alias"]:
        if not root.is_symlink() or fingerprint(root) != plan["root"]:
            raise RuntimeError("root alias changed since preview")
    else:
        info = root.lstat()
        if [info.st_dev, info.st_ino, info.st_mode] != plan["root"]:
            raise RuntimeError("root changed since preview")
        for name, expected in plan["children"].items():
            if fingerprint(root / name) != expected:
                raise RuntimeError(f"child changed since preview: {name}")
    quarantine.mkdir(parents=True, mode=0o700, exist_ok=False)
    journal = {"profile": str(profile), "plan": plan, "completed": []}

    def save():
        destination = quarantine / "journal.json"
        temp = quarantine / ".journal.tmp"
        temp.write_text(json.dumps(journal, indent=2) + "\n")
        os.chmod(temp, 0o600)
        os.replace(temp, destination)

    save()
    if plan["alias"]:
        root.rename(quarantine / "skills-alias")
        journal["completed"].append("skills-alias")
        save()
        root.mkdir(mode=0o700)
    else:
        for name in plan["children"]:
            # Recheck immediately before rename; do not remove changed local bytes.
            if fingerprint(root / name) != plan["children"][name]:
                raise RuntimeError(f"child changed during preservation: {name}")
            (root / name).rename(quarantine / name)
            journal["completed"].append(name)
            save()
    return quarantine


def skill_delta(delta):
    value = copy.deepcopy(delta)
    skills = value.setdefault("skills", {})
    if not isinstance(skills, dict):
        raise RuntimeError("skills delta must be a mapping")
    skills["external_dirs"] = []
    return value


def load_renderer(source, fleet):
    os.environ["HERMES_FLEET_HOME"] = str(fleet)
    spec = importlib.util.spec_from_file_location("fleet_config_renderer", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the canonical config renderer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configure(profile, renderer, apply=False):
    with renderer.PROFILE_LOCK.ProfileConfigLock(profile):
        cfg = profile / "config.yaml"
        delta_path = profile / "config.delta.yaml"
        for p in (cfg, delta_path):
            if p.is_symlink() or not p.is_file():
                raise RuntimeError(f"regular generated config/delta required: {p}")
        if "GENERATED FILE" not in cfg.read_text()[:1000]:
            raise RuntimeError(
                f"non-generated config needs explicit config migration: {profile.name}"
            )
        base = renderer.load_yaml(renderer.BASE)
        current = renderer.load_yaml(cfg)
        old_delta = renderer.load_yaml(delta_path)
        if current != renderer.deep_merge(base, old_delta):
            raise RuntimeError(f"out-of-band config drift; absorb/inspect first: {profile.name}")
        delta = skill_delta(old_delta)
        expected = renderer.deep_merge(base, delta)
        before_other = copy.deepcopy(current)
        after_other = copy.deepcopy(expected)
        for value in (before_other, after_other):
            value.get("skills", {}).pop("external_dirs", None)
        if before_other != after_other:
            raise RuntimeError("renderer would change unrelated configuration")
        changed = current != expected or old_delta != delta
        if apply and changed:
            renderer.backup([cfg, delta_path], "skillex-only")
            temporary = profile / f".skills-delta-{uuid.uuid4().hex}"
            with temporary.open("x") as handle:
                os.chmod(temporary, 0o600)
                handle.write(renderer.dump_yaml(delta))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, delta_path)
            renderer.write_generated(cfg, expected)
        return changed


def cli(command):
    result = subprocess.run(command, text=True, capture_output=True, timeout=90)
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError(f"Skillex returned non-JSON: exit {result.returncode}") from None
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--fleet-home", type=Path, default=Path.home() / ".hermes")
    parser.add_argument("--registry-root", type=Path, required=True)
    parser.add_argument("--renderer", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.profile == "default" or not all(
        c.islower() or c.isdigit() or c in "-_" for c in args.profile
    ):
        raise RuntimeError("only explicit valid named PM profiles may be cut over")
    profile = args.fleet_home / "profiles" / args.profile
    command = ["node", str(args.registry_root / "dist/cli.js"), "profile"]
    shared = ["--hermes-root", str(args.fleet_home), "--registry-root", str(args.registry_root)]
    show = cli([*command, "show", args.profile, "--project", str(args.project), *shared, "--json"])
    if show["exit"] not in (0, 3, 6):
        raise RuntimeError(f"selection refused: {show['findings']}")
    data = show.get("data")
    if data is None or data.get("pending"):
        raise RuntimeError("unresolved profile or pending recovery requires inspection")
    owned = {
        item["name"]
        for item in (data.get("managed") or [])
        if item["state"] in ("unchanged", "update")
    }
    plan = plan_root(profile, owned)
    renderer = load_renderer(args.renderer, args.fleet_home)
    config_change = configure(profile, renderer)
    # Validate selection independently for an alias before changing its root.
    if plan["alias"]:
        validation = cli(
            [
                "node",
                "--input-type=module",
                "-e",
                "import {resolveSelection} from './dist/index.js'; const r=await resolveSelection({scope:'project',project:process.argv[1],registryRoot:process.argv[2]}); console.log(JSON.stringify(r));",
                str(args.project),
                str(args.registry_root),
            ]
        )
        if validation["exit"] != 0:
            raise RuntimeError(f"selection preflight refused: {validation['findings']}")
    summary = {
        "profile": args.profile,
        "project": str(args.project),
        "alias": plan["alias"],
        "preserve": sorted(plan["children"]),
        "owned": len(owned),
        "config_change": config_change,
        "applied": False,
    }
    if args.apply:
        stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        quarantine = args.fleet_home / ".skill-quarantine" / args.profile / stamp
        if plan["alias"] or plan["children"]:
            preserve_root(profile, plan, quarantine)
            summary["quarantine"] = str(quarantine)
        configure(profile, renderer, apply=True)
        result = cli(
            [
                *command,
                "sync",
                args.profile,
                "--project",
                str(args.project),
                *shared,
                "--skillex-only",
                "--json",
            ]
        )
        summary.update(
            applied=result["exit"] == 0, exit=result["exit"], findings=result["findings"]
        )
        if result["exit"] != 0:
            print(json.dumps(summary))
            return result["exit"]
        check = cli(
            [
                *command,
                "sync",
                args.profile,
                "--project",
                str(args.project),
                *shared,
                "--dry-run",
                "--json",
            ]
        )
        if check["exit"] != 0 or check["data"]["changes"]:
            raise RuntimeError("post-cutover sync is not converged")
        summary["idempotent"] = True
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(3) from None
