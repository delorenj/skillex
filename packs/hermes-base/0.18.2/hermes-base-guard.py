#!/usr/bin/env python3
"""hermes-base-guard — forbid in-place edits of pack-owned base skills, PER-SKILL.

The pack (this script's parent dir) is the shared base. A runtime's local skills
overlay may extend or override base skills, but only as a NAME-DISJOINT copy
(scoped-name), never an in-place edit of a base-NAMED skill: hermes refuses a
same-name local↔pack collision in skill_view ("Ambiguous skill name"), and the
prompt index silently shadows it — so an in-place edit is a real drift bug (it
forked 14/18 base categories before the dedup). This guard denies any ACTIVE
local skill whose frontmatter `name:` matches a pack skill but whose content
differs.

Granularity is PER SKILL (each SKILL.md), mirroring hermes iter_skill_index_files
(excludes .archive/.git/support dirs). The dir-level predecessor false-positived
on partially-overridden category dirs (apple/creative/… hold many sub-skills).

Wiring (recommended: all three):
  1) skillex skill_ssot.py sweep/doctor -> check-tree each runtime before blessing.
  2) pre-commit hook -> check-staged in any repo vendoring a runtime skills/ tree.
  3) 33god-agent-fleet-operations self-check -> check-tree across all runtimes.

Usage:
  hermes-base-guard.py check-tree <runtime_skills_dir>   # fleet/daemon/self-check
  hermes-base-guard.py check-staged                      # git pre-commit
Exit 0 = clean; 1 = divergent base skill(s); 2 = usage error.
"""
from __future__ import annotations
import hashlib, os, re, subprocess, sys
from pathlib import Path

PACK = Path(__file__).resolve().parent

EXCLUDED = frozenset((
    ".archive", ".git", ".github", ".hub", ".mypy_cache", ".nox", ".pytest_cache",
    ".ruff_cache", ".tox", ".venv", "__pycache__", "node_modules", "site-packages", "venv",
))
SUPPORT = frozenset(("references", "templates", "assets", "scripts"))


def iter_skill_roots(d: Path):
    out = []
    for root, dirs, files in os.walk(str(d)):
        has = "SKILL.md" in files
        dirs[:] = [x for x in dirs if x not in EXCLUDED and not (has and x in SUPPORT)]
        if "SKILL.md" in files:
            out.append(Path(root) / "SKILL.md")
    return sorted(out)


def treehash(d: Path) -> str:
    lines = [hashlib.sha256(p.read_bytes()).hexdigest() + "  " + str(p.relative_to(d))
             for p in sorted(d.rglob("*")) if p.is_file()]
    lines.sort()
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def fname(smd: Path) -> str:
    try:
        t = smd.read_text(encoding="utf-8")
    except Exception:
        return smd.parent.name
    m = re.match(r"^---\s*\n(.*?)\n---", t, re.S)
    if m:
        mm = re.search(r"^name:\s*(.+?)\s*$", m.group(1), re.M)
        if mm:
            return mm.group(1).strip().strip("'\"")
    return smd.parent.name


def pack_index() -> dict[str, str]:
    return {fname(s): treehash(s.parent) for s in iter_skill_roots(PACK)}


def _deny(name: str, path: Path) -> None:
    print(f"BASE-EDIT DENIED: base skill '{name}' edited in place at {path}", file=sys.stderr)
    print("  Do NOT edit a base skill in place. Either:", file=sys.stderr)
    print("    (a) delete the local copy so it resolves read-only from the pack,", file=sys.stderr)
    print("    (b) PROMOTE a genuine shared improvement to a new pack version, or", file=sys.stderr)
    print("    (c) SCOPE it: rename the dir + frontmatter name to <name>-<agent>", file=sys.stderr)
    print("        (see hermes-runtime-templatize.py).", file=sys.stderr)


def check_tree(skills_dir: Path) -> int:
    idx, rc = pack_index(), 0
    for smd in iter_skill_roots(skills_dir):
        n = fname(smd)
        if n in idx and treehash(smd.parent) != idx[n]:
            _deny(n, smd.parent); rc = 1
    return rc


def check_staged() -> int:
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    changed = subprocess.check_output(["git", "diff", "--cached", "--name-only"], text=True).splitlines()
    idx, rc, seen = pack_index(), 0, set()
    for rel in changed:
        if "/skills/" not in ("/" + rel) and not rel.startswith("skills/"):
            continue
        p = (root / rel).parent
        while p != root and not (p / "SKILL.md").exists():
            p = p.parent
        if not (p / "SKILL.md").exists() or p in seen:
            continue
        seen.add(p)
        n = fname(p / "SKILL.md")
        if n in idx and treehash(p) != idx[n]:
            _deny(n, p); rc = 1
    return rc


def main() -> int:
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "check-tree":
        return check_tree(Path(a[1]))
    if len(a) == 1 and a[0] == "check-staged":
        return check_staged()
    print("usage: hermes-base-guard.py {check-tree <runtime_skills_dir>|check-staged}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
