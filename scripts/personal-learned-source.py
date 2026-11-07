#!/usr/bin/env python3
"""Identity-bound Git source for Hermes personal learned skills.

Migration is preview-only unless --apply. Check is a read-only writer preflight;
checkpoint stages only the owning identity's learned subtree in an isolated index.
"""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import yaml

SPEC = importlib.util.spec_from_file_location(
    "personal_learned_inventory", Path(__file__).resolve().with_name("personal-learned-inventory.py")
)
INVENTORY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INVENTORY)
Refusal = INVENTORY.InventoryError
NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def git(repo, *args, env=None):
    try:
        result = subprocess.run(["git", "-C", str(repo), *args], text=True,
                                capture_output=True, env=env, timeout=45)
    except subprocess.TimeoutExpired as exc:
        raise Refusal(f"git {args[0]} timed out after 45 seconds") from exc
    if result.returncode:
        raise Refusal(f"git {' '.join(args[:2])} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def identity_for(profile):
    profile = profile.absolute()
    INVENTORY.directory(profile)
    metadata = INVENTORY.mapping(profile / "profile.yaml")
    flume = metadata.get("flume")
    definition = flume.get("definition") if isinstance(flume, dict) else None
    if not isinstance(definition, str) or not Path(definition).is_absolute():
        raise Refusal("profile has no absolute identity definition")
    definition = Path(definition)
    identity = definition.parent
    if definition.name != "agent.yaml":
        raise Refusal("identity definition must be agent.yaml")
    name = metadata.get("name")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise Refusal("invalid personal identity name")
    if identity.name != name or identity.parent.name != "workforce":
        raise Refusal("definition does not identify a workforce desk")
    repo = identity.parent.parent
    if not repo.is_absolute() or git(repo, "rev-parse", "--show-toplevel") != str(repo):
        raise Refusal("identity is not in its own Git repository")
    # Reject symlink traversal through the identity path.
    for path in (repo, identity.parent, identity):
        INVENTORY.directory(path)
    INVENTORY.inventory(profile, identity, allow_bound=True)
    return name, identity, repo


def source_for(identity):
    return identity / "learned-skills"


def binding(profile, name, identity, repo):
    return {"schema": 1, "identity": name, "source": str(source_for(identity)),
            "repository": str(repo), "definition": str(identity / "agent.yaml")}


def bound(profile, expected):
    marker = profile / ".skillex-personal-source.json"
    INVENTORY.regular(marker)
    try:
        actual = json.loads(marker.read_text())
    except (ValueError, UnicodeError) as exc:
        raise Refusal(f"invalid personal source binding: {exc}") from exc
    if actual != expected:
        raise Refusal("personal source binding does not match validated identity")
    root = profile / "learned-skills"
    if not root.is_symlink() or os.readlink(root) != expected["source"]:
        raise Refusal("profile learned-skills is not bound to exact identity source")
    INVENTORY.directory(Path(expected["source"]))


def digest_tree(root):
    """Hash every file, including files outside skill directories; reject all links."""
    if not root.exists() and not root.is_symlink():
        return {}
    INVENTORY.directory(root)
    result = {}
    count = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            child = Path(base) / name
            mode = child.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise Refusal(f"link or special file in learned tree: {child}")
            count += 1
            if count > 20000:
                raise Refusal("learned tree exceeds 20000 entries")
            if stat.S_ISDIR(mode):
                result[child.relative_to(root).as_posix()] = "directory"
            elif stat.S_ISREG(mode):
                result[child.relative_to(root).as_posix()] = hashlib.sha256(child.read_bytes()).hexdigest()
    return result


@contextmanager
def locked(repo):
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    with (common / "skillex-personal-source.lock").open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def checkpoint_git(repo, name, *, include_definition=False):
    """Commit only this identity's learned subtree and registration."""
    with locked(repo):
        branch = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
        remote = git(repo, "config", f"branch.{branch}.remote")
        merge = git(repo, "config", f"branch.{branch}.merge")
        if remote == "." or not merge.startswith("refs/heads/"):
            raise Refusal("branch has no remote upstream")
        remote_branch = merge.removeprefix("refs/heads/")
        git(repo, "fetch", remote, remote_branch)
        remote_sha = git(repo, "rev-parse", "FETCH_HEAD")
        head = git(repo, "rev-parse", "HEAD")
        if git(repo, "merge-base", head, remote_sha) != remote_sha:
            raise Refusal("remote branch is ahead or diverged; reconcile before checkpoint")
        relative = f"workforce/{name}/learned-skills"
        registered = f"workforce/{name}/personal-learned-source.json"
        paths = [relative, registered]
        if include_definition:
            paths.append(f"workforce/{name}/agent.yaml")
        # The isolated index begins at HEAD, not the caller's staged changes.
        with tempfile.TemporaryDirectory(prefix="skillex-index-") as tmp:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "index"))
            git(repo, "read-tree", "HEAD", env=env)
            git(repo, "add", "-A", "--", *paths, env=env)
            staged = git(repo, "diff", "--cached", "--name-only", env=env)
            if staged:
                git(repo, "commit", "-m", f"chore(skills): checkpoint {name} personal learning\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>", env=env)
                # HEAD moved while the caller's original index was deliberately untouched.
                # Refresh only our path so unrelated staged bytes remain exactly staged.
                git(repo, "reset", "--mixed", "HEAD", "--", *paths)
        commit = git(repo, "rev-parse", "HEAD")
        # A failed push leaves the commit in place; a later checkpoint retries it.
        if commit != remote_sha:
            git(repo, "push", remote, f"HEAD:refs/heads/{remote_branch}")
        advertised = git(repo, "ls-remote", remote, f"refs/heads/{remote_branch}")
        if advertised.split("\t")[0] != commit:
            raise Refusal("remote branch does not contain checkpoint HEAD")
        return commit, True


def registration(identity, name):
    path = identity / "personal-learned-source.json"
    expected = {"schema": 1, "identity": name, "source": "learned-skills"}
    if path.exists() or path.is_symlink():
        INVENTORY.regular(path)
        if json.loads(path.read_text()) != expected:
            raise Refusal("identity source registration does not match validated identity")
    else:
        path.write_text(json.dumps(expected, sort_keys=True) + "\n")


def audit(profile, *, require_bound, proposed_name=None):
    name, identity, repo = identity_for(profile)
    expected = binding(profile, name, identity, repo)
    if require_bound:
        bound(profile, expected)
        path = identity / "personal-learned-source.json"
        INVENTORY.regular(path)
        if json.loads(path.read_text()) != {"schema": 1, "identity": name, "source": "learned-skills"}:
            raise Refusal("identity source registration does not match validated identity")
    root = source_for(identity) if require_bound else profile / "learned-skills"
    result = INVENTORY.inventory(profile, identity, allow_bound=require_bound)
    digest_tree(root)
    if proposed_name is not None:
        if not NAME.fullmatch(proposed_name):
            raise Refusal(f"invalid proposed skill name: {proposed_name}")
        selected = (INVENTORY.advertised_names(profile / "skills") |
                    INVENTORY.advertised_names(Path.home() / ".agents/skills"))
        if proposed_name in selected:
            raise Refusal(f"proposed skill collides with selected skill: {proposed_name}")
        if proposed_name in {item["name"] for item in result["skills"]}:
            raise Refusal(f"proposed skill already exists: {proposed_name}")
    return name, identity, repo, result, expected


def migrate(profile, apply):
    root = profile / "learned-skills"
    if root.is_symlink():
        name, _, repo, _, _ = audit(profile, require_bound=True)
        return checkpoint_git(repo, name) if apply else (None, False)
    name, identity, repo, _, expected = audit(profile, require_bound=False)
    source = source_for(identity)
    original = digest_tree(root)
    if source.exists() or source.is_symlink():
        existing = digest_tree(source)
        if not original:
            existing.pop(".gitkeep", None)
        if existing != original:
            raise Refusal("identity source already differs from original; refusing overwrite")
    if not apply:
        return None, False
    if not source.exists():
        if root.exists():
            shutil.copytree(root, source, symlinks=False)
        else:
            source.mkdir()
    if digest_tree(source) != original:
        raise Refusal("copy did not preserve all learned files")
    registration(identity, name)
    # Git does not track empty directories: retain an explicit empty source marker.
    if not original:
        (source / ".gitkeep").touch(exist_ok=True)
    # Recovery is verified BEFORE the Git checkpoint or activation.
    state_home = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    recovery_base = state_home / "skillex/personal-learning" / name
    recovery_base.mkdir(parents=True, exist_ok=True)
    recovery = recovery_base / datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    if root.exists():
        shutil.copytree(root, recovery)
    else:
        recovery.mkdir()
    if digest_tree(recovery) != original:
        raise Refusal("recovery snapshot differs from original")
    if digest_tree(root) != original:
        raise Refusal("original changed during transfer; recovery snapshot retained")
    # The original remains in place until Git durability is established.
    commit, pushed = checkpoint_git(repo, name, include_definition=True)
    if digest_tree(root) != original:
        raise Refusal("original changed during checkpoint; recovery snapshot retained")
    parked = recovery_base / (recovery.name + "-original")
    if root.exists():
        root.rename(parked)
    try:
        temp_link = profile / f".learned-skills-{os.getpid()}"
        temp_link.symlink_to(source, target_is_directory=True)
        temp_link.replace(root)
        temp_binding = profile / f".skillex-personal-source-{os.getpid()}.tmp"
        temp_binding.write_text(json.dumps(expected, sort_keys=True) + "\n")
        temp_binding.replace(profile / ".skillex-personal-source.json")
        audit(profile, require_bound=True)
    except Exception:
        if root.is_symlink():
            root.unlink()
        if not root.exists() and parked.exists():
            parked.rename(root)
        raise
    return commit, pushed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("migrate", "checkpoint", "check"):
        sub = commands.add_parser(command)
        sub.add_argument("--profile", type=Path, required=True)
        if command == "migrate":
            sub.add_argument("--apply", action="store_true")
        if command == "check":
            sub.add_argument("--name", help="preflight a new proposed skill name")
    args = parser.parse_args()
    response = {"ok": False, "commit": None, "pushed": False, "error": None}
    try:
        if args.command == "migrate":
            response["commit"], response["pushed"] = migrate(args.profile, args.apply)
        else:
            name, _, repo, _, _ = audit(
                args.profile, require_bound=True,
                proposed_name=getattr(args, "name", None))
            if args.command == "checkpoint":
                response["commit"], response["pushed"] = checkpoint_git(repo, name)
        response["ok"] = True
    except (Refusal, OSError, UnicodeError, ValueError, yaml.YAMLError) as exc:
        response["error"] = str(exc)
    print(json.dumps(response, sort_keys=True))
    return 0 if response["ok"] else 3


if __name__ == "__main__":
    sys.exit(main())
