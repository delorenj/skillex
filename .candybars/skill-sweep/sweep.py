#!/usr/bin/env python3
"""Nightly skill sweep: one cohort of skills gets an in-depth agent review each night.

The universe is every skill skillex manages (`skillex skill list`): wild and vendored
catalog skills in all-skills/ plus repo-owned hubs. Three modes, interval-driver style
(~/.agents/skills/interval-driver):

  --monitor       tonight's cohort, one stable line per skill. Hermes hashes it; an
                  unchanged cohort (already swept tonight) never starts the agent.
  --brief         the pass contract plus, per cohort skill: owner, where to edit, files,
                  Hermes scan findings, graph findings and the last review's notes.
                  Writes the cohort file the applier enforces.
  --apply PLAN    the agent's plan JSON in, the driver acts: gates each edited skill
                  (scan not dangerous, bash -n, py_compile), commits only cohort paths
                  in each owning repo, pushes, re-vendors vendored skills, records the
                  ledger, writes log/<date>.md and STATUS.md, commits the desk.

Cohort: every skill the Hermes project-tier scanner calls dangerous (a regression, capped),
then alternating between skills edited since their last review (oldest first) and skills
never reviewed (seeded-random per night, so the order is random but reproducible), then
the longest-unreviewed. Every skill is reviewed once before any is reviewed twice.

Runs under Hermes' venv python so it can import the scanner:
  ~/.hermes/hermes-agent/venv/bin/python -I .candybars/skill-sweep/sweep.py --brief
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

HOME = Path.home()
DESK = Path(__file__).resolve().parent
REGISTRY = DESK.parent.parent  # ~/code/skillex
CATALOG = REGISTRY / "all-skills"
HERMES_AGENT = Path(os.environ.get("HERMES_AGENT_ROOT", HOME / ".hermes/hermes-agent"))
STATE = Path(os.environ.get("SKILL_SWEEP_STATE", HOME / ".local/state/skillex/skill-sweep"))
SCAN_CACHE = HOME / ".cache/skillex/skill-sweep/scan-cache"
LEDGER = DESK / "ledger.json"
CONTRACT = DESK / "CONTRACT.md"
COHORT_SIZE = int(os.environ.get("SKILL_SWEEP_COHORT", "4"))
MAX_DANGEROUS = 2  # regressions jump the queue, but one broken repo must not eat every night
TZ = __import__("zoneinfo").ZoneInfo("America/New_York")  # the night is named in ET


def night() -> str:
    return os.environ.get("SKILL_SWEEP_NIGHT") or dt.datetime.now(TZ).date().isoformat()


def run(argv, cwd=None, check=True, env=None) -> str:
    out = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True)
    if check and out.returncode != 0:
        raise RuntimeError(
            f"{' '.join(map(str, argv))} (in {cwd}): rc={out.returncode}\n{out.stderr.strip()}"
        )
    return out.stdout


# ── skillex ───────────────────────────────────────────────────────────────────


def skillex(*args) -> dict:
    """Run the installed skillex under Node >= 24 from /, as hermes-skillex-resync.py does."""
    exe = (
        os.environ.get("SKILLEX_BIN")
        or shutil.which("skillex")
        or str(HOME / ".local/share/mise/shims/skillex")
    )
    node_bins = sorted((HOME / ".local/share/mise/installs/node").glob("24*/bin"))
    env = dict(os.environ)
    if node_bins:
        env["PATH"] = f"{node_bins[-1]}:{env.get('PATH', '/usr/bin:/bin')}"
    env["MISE_TRUSTED_CONFIG_PATHS"] = env.get("MISE_TRUSTED_CONFIG_PATHS", "")
    out = subprocess.run(
        [exe, *args, "--json", "--registry-root", str(REGISTRY)],
        cwd="/",
        env=env,
        capture_output=True,
        text=True,
    )
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"skillex {' '.join(args)}: rc={out.returncode}\n{out.stderr.strip()[:2000]}"
        ) from exc


def checkout_map() -> dict:
    p = HOME / ".config/skillex/sources.local.toml"
    try:
        return tomllib.loads(p.read_text()).get("checkouts", {})
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def sources() -> dict:
    try:
        return {
            s["name"]: s
            for s in tomllib.loads((CATALOG / "sources.toml").read_text()).get("source", [])
        }
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def inventory() -> list[dict]:
    """Every managed skill with the repo that owns its bytes and where an edit must land."""
    data = skillex("skill", "list")["data"]["skills"]
    checkouts, srcs = checkout_map(), sources()
    skills = []
    for s in data:
        path = Path(s["path"])
        owner = s.get("owner") or {}
        origin = (s.get("provenance") or {}).get("origin") or {}
        item = {
            "name": s["name"],
            "path": str(path),
            "kind": "catalog",
            "repo": str(CATALOG),
            "rel": str(path.relative_to(CATALOG)) if path.is_relative_to(CATALOG) else path.name,
            "edit": str(path),
            "source": None,
        }
        if owner.get("kind") == "repo" and owner.get("checkout"):
            repo = Path(owner["checkout"])
            item.update(
                kind="hub",
                repo=str(repo),
                rel=str(path.relative_to(repo)),
                source=owner.get("source"),
            )
        elif origin.get("type") == "vendored" and origin.get("source"):
            src = srcs.get(origin["source"], {})
            ck = src.get("checkout", origin["source"])
            upstream = Path(checkouts.get(ck, HOME / "code" / ck))
            upath = upstream / origin.get("upstream_path", "")
            top = (
                subprocess.run(
                    ["git", "-C", str(upath), "rev-parse", "--show-toplevel"],
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                if upath.is_dir()
                else ""
            )
            branch = (
                subprocess.run(
                    ["git", "-C", top, "branch", "--show-current"], capture_output=True, text=True
                ).stdout.strip()
                if top
                else ""
            )
            version = src.get("version", "")
            if top and branch and branch == version:
                # Editable: the source tracks a branch and the checkout is on it, so `vendor sync`
                # imports the fix. The upstream path may sit inside a submodule of the checkout.
                item.update(
                    kind="vendored",
                    source=origin["source"],
                    upstream=top,
                    checkout=f"{ck}={upstream}",
                    upstream_rel=str(upath.resolve().relative_to(Path(top).resolve())),
                    edit=str(upath),
                )
            else:
                why = (
                    "upstream checkout missing"
                    if not top
                    else f"source pinned to {version[:12]}, checkout on {branch or 'a detached HEAD'}"
                )
                item.update(kind="vendored-readonly", source=origin["source"], why=why)
        skills.append(item)
    return skills


def tree(repo: str, rel: str) -> str:
    out = subprocess.run(
        ["git", "-C", repo, "rev-parse", f"HEAD:{rel}"], capture_output=True, text=True
    )
    return out.stdout.strip() if out.returncode == 0 else "untracked"


# ── scanner ───────────────────────────────────────────────────────────────────


def scanner():
    sys.path.insert(0, str(HERMES_AGENT))
    import logging

    logging.disable(logging.CRITICAL)
    from tools.skills_guard import scan_skill_cached

    return scan_skill_cached


def scan(scan_fn, path: str) -> dict:
    try:
        result, _ = scan_fn(Path(path), source="project-local", cache_dir=SCAN_CACHE)
    except Exception as exc:  # the loader fails closed, so do we
        return {
            "verdict": "dangerous",
            "findings": [
                {
                    "severity": "critical",
                    "id": "scan_error",
                    "file": "",
                    "line": 0,
                    "match": str(exc)[:200],
                }
            ],
        }
    keep = [f for f in result.findings if f.severity in ("critical", "high")]
    return {
        "verdict": result.verdict,
        "findings": [
            {
                "severity": f.severity,
                "id": f.pattern_id,
                "file": f.file,
                "line": f.line,
                "match": (f.match or "")[:140],
            }
            for f in keep
        ],
    }


# ── ledger / cohort ───────────────────────────────────────────────────────────


def load_json(p: Path, default):
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return default


def select(skills: list[dict], ledger: dict, scans: dict, when: str) -> list[dict]:
    rng = random.Random(f"skill-sweep:{when}")
    by_name = {s["name"]: s for s in skills}
    dangerous = sorted(
        n
        for n, r in scans.items()
        if r["verdict"] == "dangerous"
        # already reviewed at this exact tree: it waits on a recorded needs-human, not on us
        and (ledger.get(n) or {}).get("tree") != (by_name.get(n) or {}).get("tree")
    )[:MAX_DANGEROUS]
    changed, fresh, reviewed = [], [], []
    for s in skills:
        if s["name"] in dangerous:
            continue
        entry = ledger.get(s["name"])
        if not entry:
            fresh.append(s["name"])
        elif entry.get("tree") != s["tree"]:
            changed.append((entry.get("reviewed", ""), s["name"]))
        else:
            reviewed.append((entry.get("reviewed", ""), s["name"]))
    rng.shuffle(fresh)
    changed = [n for _, n in sorted(changed)]
    reviewed = [n for _, n in sorted(reviewed)]
    picks = list(dangerous)
    queues = [changed, fresh]
    turn = 0
    while len(picks) < max(COHORT_SIZE, len(dangerous)) and (changed or fresh):
        q = queues[turn % 2] or queues[(turn + 1) % 2]
        picks.append(q.pop(0))
        turn += 1
    while len(picks) < COHORT_SIZE and reviewed:
        picks.append(reviewed.pop(0))
    return [by_name[n] for n in picks]


def foreign_dirty(skills: list[dict]) -> set[str]:
    """Skills holding someone else's uncommitted work. The applier commits whole skill paths,
    so a skill another agent is mid-edit on waits for a later night."""
    status: dict[str, list[str]] = {}
    busy = set()
    for s in skills:
        repo = s.get("upstream") or s["repo"]
        rel = s.get("upstream_rel") if s.get("upstream") else s["rel"]
        if repo not in status:
            out = subprocess.run(
                ["git", "-C", repo, "status", "--porcelain", "-uall"],
                capture_output=True,
                text=True,
            ).stdout
            status[repo] = [line[3:].split(" -> ")[-1].strip('"') for line in out.splitlines()]
        if any(p == rel or p.startswith(rel.rstrip("/") + "/") for p in status[repo]):
            busy.add(s["name"])
    return busy


def cohort(scan_fn=None) -> tuple[list[dict], dict]:
    """Tonight's cohort, frozen at first sight so a re-fire the same night sees the same lines."""
    frozen = load_json(STATE / "cohort.json", {})
    if frozen.get("night") == night():
        return frozen["skills"], frozen["stats"]
    skills = inventory()
    for s in skills:
        s["tree"] = tree(s["repo"], s["rel"])
    scan_fn = scan_fn or scanner()
    scans = {s["name"]: scan(scan_fn, s["path"]) for s in skills}
    busy = foreign_dirty(skills)
    picked = select(
        [s for s in skills if s["name"] not in busy],
        load_json(LEDGER, {}),
        {n: r for n, r in scans.items() if n not in busy},
        night(),
    )
    for s in picked:
        s["scan"] = scans[s["name"]]
    stats = {
        "total": len(skills),
        "busy": sorted(busy),
        "dangerous": sorted(n for n, r in scans.items() if r["verdict"] == "dangerous"),
    }
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "cohort.json").write_text(
        json.dumps({"night": night(), "skills": picked, "stats": stats}, indent=1)
    )
    return picked, stats


# ── modes ─────────────────────────────────────────────────────────────────────


def mode_monitor() -> None:
    picked, stats = cohort()
    print(f"night {night()}")
    for s in picked:
        print(f"{s['name']} {s['tree'][:12]} {s['scan']['verdict']}")
    print(f"dangerous {len(stats['dangerous'])}")


def files_of(path: str) -> list[str]:
    root = Path(path)
    out = []
    for p in sorted(root.rglob("*")):
        if any(
            part in (".git", "__pycache__", "node_modules") for part in p.relative_to(root).parts
        ):
            continue
        if p.is_symlink():
            out.append(f"{p.relative_to(root)} -> {os.readlink(p)}")
        elif p.is_file():
            out.append(f"{p.relative_to(root)} ({p.stat().st_size} B)")
    return out[:80] + ([f"... {len(out) - 80} more"] if len(out) > 80 else [])


def graph_findings(names: list[str]) -> dict:
    try:
        data = skillex("graph", "--context", "catalog", "--focus", ",".join(names), "--depth", "0")[
            "data"
        ]
    except Exception as exc:
        return {"_error": [str(exc)[:300]]}
    found = {}
    for n in data.get("nodes", []):
        if n.get("name") in names and n.get("findings"):
            found.setdefault(n["name"], []).extend(
                f"{f['code']}: {f['message']}" for f in n["findings"]
            )
    return found


def mode_brief() -> None:
    picked, stats = cohort()
    when = night()
    if (STATE / f"plan-{when}.applied.json").exists():
        print(
            f"Tonight's sweep ({when}) is already applied. Write no plan; reply `already swept {when}`."
        )
        return
    ledger = load_json(LEDGER, {})
    gf = graph_findings([s["name"] for s in picked]) if picked else {}
    print(
        CONTRACT.read_text()
        .replace("{PLAN}", str(STATE / f"plan-{when}.json"))
        .replace("{SWEEP}", f"{HERMES_AGENT}/venv/bin/python -I {DESK}/sweep.py")
    )
    print(
        f"\n# Tonight: {when}. {len(picked)} of {stats['total']} skills. "
        f"Dangerous right now: {', '.join(stats['dangerous']) or 'none'}. "
        f"Skipped (another agent's uncommitted work): {len(stats.get('busy', []))}.\n"
    )
    if not picked:
        print("Nothing to review. Write no plan; reply `nothing to sweep`.")
    for s in picked:
        print(f"## {s['name']}\n")
        print(f"- owner: {s['kind']}" + (f" (source `{s['source']}`)" if s.get("source") else ""))
        if s["kind"] == "vendored":
            print(
                f"- EDIT HERE (upstream, the source of truth): {s['edit']}\n"
                f"- catalog copy (do not edit; the applier re-vendors it): {s['path']}"
            )
        elif s["kind"] == "vendored-readonly":
            print(
                f"- path: {s['path']} (vendored; {s['why']}. Review only, edit nothing. Put each fix you "
                f"would make in notes and mark the skill needs-human)"
            )
        else:
            print(f"- path: {s['path']}")
        print(f"- scan: {s['scan']['verdict']}")
        crit = [f for f in s["scan"]["findings"] if f["severity"] == "critical"]
        high = [f for f in s["scan"]["findings"] if f["severity"] != "critical"]
        for f in crit + high[:8]:
            print(f"  - {f['severity']} {f['id']} {f['file']}:{f['line']} `{f['match']}`")
        if len(high) > 8:
            print(f"  - ... {len(high) - 8} more high findings (`--scan` lists them all)")
        for line in gf.get(s["name"], []):
            print(f"- graph: {line}")
        prev = ledger.get(s["name"])
        if prev:
            print(
                f"- last review {prev.get('reviewed')}: {prev.get('outcome')}; "
                + "; ".join(prev.get("notes", [])[:5])
            )
        print("- files:")
        for f in files_of(s["edit"] if s["kind"] == "vendored" else s["path"]):
            print(f"  - {f}")
        print()


def gate(path: Path, changed: list[str], scan_fn) -> list[str]:
    problems = []
    for rel in changed:
        f = path / rel
        if not f.is_file():
            continue
        if f.suffix in (".sh", ".bash"):
            r = subprocess.run(["bash", "-n", str(f)], capture_output=True, text=True)
            if r.returncode:
                problems.append(f"bash -n {rel}: {r.stderr.strip()[:200]}")
        elif f.suffix == ".py":
            r = subprocess.run(
                [sys.executable, "-m", "py_compile", str(f)], capture_output=True, text=True
            )
            if r.returncode:
                problems.append(f"py_compile {rel}: {r.stderr.strip()[:200]}")
        elif f.suffix == ".json":
            try:
                json.loads(f.read_text())
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                problems.append(f"json {rel}: {exc}")
    res = scan(scan_fn, str(path))
    if res["verdict"] == "dangerous":
        problems.append(
            "still dangerous: "
            + ", ".join(
                f"{f['id']}@{f['file']}:{f['line']}"
                for f in res["findings"]
                if f["severity"] == "critical"
            )
        )
    for pyc in path.rglob("__pycache__"):
        shutil.rmtree(pyc, ignore_errors=True)
    return problems


def dirty(repo: str, rel: str) -> list[str]:
    out = run(["git", "-C", repo, "status", "--porcelain", "-uall", "--", rel or "."])
    files = []
    for line in out.splitlines():
        p = line[3:].split(" -> ")[-1].strip('"')
        files.append(str(Path(p).relative_to(rel)) if rel and p.startswith(rel + "/") else p)
    return files


def commit(repo: str, paths: list[str], message: str) -> str:
    run(["git", "-C", repo, "add", "-A", "--", *paths])
    staged = run(["git", "-C", repo, "diff", "--cached", "--name-only", "--", *paths]).strip()
    if not staged:
        return ""
    run(["git", "-C", repo, "commit", "-q", "-m", message, "--", *paths])
    sha = run(["git", "-C", repo, "rev-parse", "--short", "HEAD"]).strip()
    push(repo)
    return run(["git", "-C", repo, "rev-parse", "--short", "HEAD"]).strip() or sha


def push(repo: str, tries: int = 3) -> None:
    """Rebase onto upstream and push; a racing pusher or a slow pre-push hook gets retries."""
    err = ""
    for _ in range(tries):
        run(["git", "-C", repo, "pull", "-q", "--rebase", "--autostash"], check=False)
        out = subprocess.run(["git", "-C", repo, "push", "-q"], capture_output=True, text=True)
        if out.returncode == 0:
            return
        err = out.stderr.strip()[-500:]
    raise RuntimeError(f"push failed in {repo} after {tries} tries: {err}")


TRAILER = "\n\nSkill-Sweep: nightly cohort review (.candybars/skill-sweep in skillex)"


def land(s: dict, outcome: str, notes: list, changes: list, commits: list, scan_fn, lines: list):
    """Gate and commit one skill's edits where its bytes live; re-vendor a vendored one."""
    name = s["name"]
    if s["kind"] == "vendored-readonly":
        stray = dirty(s["repo"], s["rel"])
        if stray:
            notes = [
                f"edited a read-only vendored copy; left uncommitted: {', '.join(stray[:5])}",
                *notes,
            ]
            outcome = "needs-human"
        lines.append(f"RECORDED {name}: {outcome} (read-only)")
        return outcome, notes
    edit_repo, edit_rel = (
        (s["upstream"], s["upstream_rel"]) if s["kind"] == "vendored" else (s["repo"], s["rel"])
    )
    changed = dirty(edit_repo, edit_rel)
    if not changed:
        if outcome == "fixed":
            outcome, notes = "clean", [*notes, "plan said fixed, but nothing changed on disk"]
        lines.append(f"RECORDED {name}: {outcome}")
        return outcome, notes
    problems = gate(Path(s["edit"]), changed, scan_fn)
    if problems:
        lines.append(f"HELD {name}: {'; '.join(problems)}")
        return "needs-human", [f"gate held the edits uncommitted: {p}" for p in problems] + notes
    msg = (
        f"fix({name}): nightly skill sweep\n\n"
        + "\n".join(f"- {c}" for c in changes)
        + TRAILER
        + "\n\nCo-Authored-By: skillex-pm skill sweep <noreply@delo.sh>"
    )
    sha = commit(edit_repo, [edit_rel or "."], msg)
    if not sha:
        lines.append(f"RECORDED {name}: {outcome} (no staged change)")
        return outcome, notes
    commits.append(f"{Path(edit_repo).name}@{sha}")
    lines.append(f"COMMITTED {name} -> {Path(edit_repo).name}@{sha}")
    if outcome == "clean":  # something was committed, so it was not clean
        outcome = "fixed"
    if s["kind"] == "vendored":
        res = skillex("vendor", "sync", "--source", s["source"], "--checkout", s["checkout"])
        if not res.get("ok"):
            return "needs-human", [
                *notes,
                f"re-vendor of {s['source']} failed; catalog copy is stale: "
                + json.dumps(res.get("findings", []))[:300],
            ]
        vsha = commit(
            str(CATALOG), [s["rel"]], f"chore({name}): re-vendor after skill sweep fix{TRAILER}"
        )
        if vsha:
            commits.append(f"all-skills@{vsha}")
            lines.append(f"REVENDORED {name} -> all-skills@{vsha}")
    return outcome, notes


def mode_apply(plan_path: str) -> None:
    plan_file = Path(plan_path)
    plan = json.loads(plan_file.read_text())
    cohort_doc = load_json(STATE / "cohort.json", {})
    when = cohort_doc.get("night") or night()
    allowed = {s["name"]: s for s in cohort_doc.get("skills", [])}
    archive = STATE / "passes"
    archive.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    shutil.copy2(plan_file, archive / f"{stamp}.json")
    plan_file.rename(plan_file.with_suffix(".applied.json"))

    scan_fn = scanner()
    ledger = load_json(LEDGER, {})
    rows, lines = [], []
    for item in plan.get("skills", []):
        name = item.get("name")
        s = allowed.get(name)
        if not s:
            lines.append(f"REFUSED {name}: not in tonight's cohort")
            continue
        outcome = item.get("outcome", "clean")
        notes = [str(n) for n in item.get("notes", [])][:10]
        changes = [str(c) for c in item.get("changes", [])][:20]
        commits: list[str] = []
        try:
            outcome, notes = land(s, outcome, notes, changes, commits, scan_fn, lines)
        except Exception as exc:  # one skill's push conflict must not lose the night's ledger
            outcome = "needs-human"
            notes = [f"applier failed, edits left uncommitted: {str(exc)[:300]}", *notes]
            lines.append(f"FAILED {name}: {str(exc).splitlines()[0][:200]}")
        after = scan(scan_fn, s["path"])
        prev = ledger.get(name) or {}
        if prev.get("reviewed") == when:  # a re-apply tonight keeps what the first one landed
            commits = list(dict.fromkeys([*prev.get("commits", []), *commits]))
            changes = list(dict.fromkeys([*prev.get("changes", []), *changes]))
        ledger[name] = {
            "reviewed": when,
            "tree": tree(s["repo"], s["rel"]),
            "outcome": outcome,
            "verdict": after["verdict"],
            "changes": changes,
            "notes": notes,
            "commits": commits,
        }
        rows.append((name, s["kind"], outcome, after["verdict"], changes, notes, commits))

    LEDGER.write_text(json.dumps(dict(sorted(ledger.items())), indent=1) + "\n")
    log_dir = DESK / "log"
    log_dir.mkdir(exist_ok=True)
    log = [
        f"# Skill sweep {when}\n",
        f"{plan.get('note', '').strip()}\n" if plan.get("note") else "",
        "| skill | owner | outcome | scan | commits |",
        "|---|---|---|---|---|",
    ]
    log += [f"| {n} | {k} | {o} | {v} | {' '.join(c) or '-'} |" for n, k, o, v, _, _, c in rows]
    for n, _, _, _, changes, notes, _ in rows:
        if changes or notes:
            log.append(f"\n## {n}\n")
            log += [f"- {c}" for c in changes] + [f"- note: {x}" for x in notes]
    (log_dir / f"{when}.md").write_text("\n".join(log) + "\n")
    write_status(ledger)

    if (
        run(["git", "-C", str(CATALOG), "rev-parse", "HEAD"]).strip()
        != run(["git", "-C", str(REGISTRY), "ls-tree", "HEAD", "all-skills"]).split()[2]
    ):
        desk_extra = ["all-skills"]
    else:
        desk_extra = []
    rel_desk = str(DESK.relative_to(REGISTRY))
    sha = commit(
        str(REGISTRY),
        [
            f"{rel_desk}/ledger.json",
            f"{rel_desk}/log/{when}.md",
            f"{rel_desk}/STATUS.md",
            *desk_extra,
        ],
        f"chore(skill-sweep): {when}, {len(rows)} skills reviewed{TRAILER}",
    )
    lines.append(f"DESK skillex@{sha or 'unchanged'}")
    print("\n".join(lines))


def write_status(ledger: dict) -> None:
    total = None
    try:
        total = len(skillex("skill", "list")["data"]["skills"])
    except Exception:
        pass
    open_items = sorted((n, e) for n, e in ledger.items() if e.get("outcome") == "needs-human")
    out = [
        "# Skill sweep status\n",
        f"Reviewed at least once: {len(ledger)}" + (f" of {total}" if total else "") + ".\n",
        "Generated by `sweep.py --apply` each night; edit nothing here by hand.\n",
        "## Needs Jarad\n" if open_items else "## Needs Jarad\n\nNothing open.\n",
    ]
    for n, e in open_items:
        out.append(f"- **{n}** ({e.get('reviewed')}): " + "; ".join(e.get("notes", [])))
    (DESK / "STATUS.md").write_text("\n".join(out) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--monitor", action="store_true")
    g.add_argument("--brief", action="store_true")
    g.add_argument("--apply", metavar="PLAN")
    g.add_argument(
        "--scan", metavar="DIR", nargs="+", help="scan skill dirs the way Hermes' project tier does"
    )
    a = ap.parse_args()
    if a.scan:
        fn = scanner()
        for d in a.scan:
            print(json.dumps({"dir": d, **scan(fn, d)}, indent=1))
    elif a.monitor:
        mode_monitor()
    elif a.brief:
        mode_brief()
    else:
        mode_apply(a.apply)


if __name__ == "__main__":
    main()
