#!/usr/bin/env python3
"""Keep every Skillex-only Hermes desk converged with the catalog, unattended.

A strict desk (a real ~/.hermes/profiles/<name>/ holding a regular-file
`.skillex-only` marker) records the all-skills commit it was last synced
against, so ANY commit to the catalog leaves every desk "sync pending"
(`skillex profile show` exit 6) and turns flume's hermes.runtime-singleton red
until someone runs a strict sync per desk. This script is that someone; the
systemd units under systemd/ run it when the catalog HEAD moves and on a timer.

Per strict desk, against the project Skillex recorded for it:

  show exit 0   converged: nothing to do
  show exit 6   plain drift: `profile sync --skillex-only`, then show again and
                require exit 0
  show exit 3   foreign/unowned entries or a broken strict policy: NEVER touched
  anything else NEVER touched; recorded loudly and the next desk proceeds

A desk without a regular-file marker (a legacy desk, or one mid-cutover) is
skipped without a single skillex call. Nothing here deletes, adopts, quarantines
or repairs content: the only writer is Skillex's own strict sync, which refuses
foreign content by itself. Fix a refused desk with
scripts/hermes-skillex-cutover.py, never by hand.

Evidence, in ~/.local/state/skillex/ (or $XDG_STATE_HOME/skillex):
  hermes-resync.jsonl      one `run` line per run plus one `desk` line for every
                           desk that was synced, refused, errored or busy
  hermes-resync.last.json  the last real run in full, replaced atomically
--dry-run writes none of it (no log, no last-run file, no lock).

Exit status: 0 converged (or a peer holds the lock: "busy"), 1 a desk needs a
human, 2 the run could not start (no usable skillex, no Hermes root, bad input).
"""

import argparse
import contextlib
import datetime
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import NamedTuple

SCHEMA = 1
MIN_SKILLEX = (0, 1, 3)  # first release that enforces the strict policy markers
STRICT_MARKER = ".skillex-only"
LOG_NAME = "hermes-resync.jsonl"
LAST_NAME = "hermes-resync.last.json"
LOCK_NAME = ".skillex-resync.lock"
LOG_ROTATE_BYTES = 4 * 1024 * 1024
MAX_FINDINGS = 5

EXIT_OK, EXIT_ATTENTION, EXIT_ENV = 0, 1, 2

# Skillex exit codes (src/core/result.ts).
SX_OK, SX_REFUSED, SX_PARTIAL, SX_LOCK_BUSY, SX_DRIFT = 0, 3, 4, 5, 6
# Read-only `show` answers that another writer (a cutover, a provisioning rerun,
# a neighbouring sync) causes transiently; asking again a moment later is safe.
TRANSIENT_SHOW = {SX_REFUSED, SX_PARTIAL, SX_LOCK_BUSY}

# The child gets an allowlisted environment: a user service inherits the manager
# environment, which carries credentials skillex has no business seeing.
ENV_PASS = re.compile(
    r"^(HOME|USER|LOGNAME|LANG|LC_.*|TMPDIR|TZ|NO_COLOR|XDG_.*|MISE_.*|SKILLEX_.*)$"
)
DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"


class Ran(NamedTuple):
    rc: int | None  # None: the process never produced an exit status
    out: str
    err: str
    fault: str | None  # None, "timeout" or "spawn"


class Outcome(NamedTuple):
    exit: int | None
    data: dict
    findings: list
    fault: str | None  # None, "timeout", "spawn" or "non-json"
    detail: str


class SkillexUnavailableError(RuntimeError):
    """No usable skillex CLI; the message lists everything that was tried."""


def stamp(moment=None):
    moment = moment or datetime.datetime.now(datetime.UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def run_capture(argv, env, timeout, cwd="/"):
    """Run argv; on timeout kill its whole process group. Never raises."""
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=cwd,
            start_new_session=True,
        )
    except OSError as error:
        return Ran(None, "", f"{type(error).__name__}: {error}", "spawn")
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        out, err = proc.communicate()
        return Ran(None, out or "", err or "", "timeout")
    return Ran(proc.returncode, out or "", err or "", None)


def child_env(environ, registry_root):
    env = {key: value for key, value in environ.items() if ENV_PASS.match(key)}
    env["PATH"] = environ.get("PATH") or DEFAULT_PATH
    env["PJ_SKILLS_REGISTRY_ROOT"] = str(registry_root)
    return env


def parse_version(text):
    found = re.match(r"\s*v?(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(part) for part in found.groups()) if found else None


def probe(argv0, env):
    """`skillex --version` is cheap and proves Node can run the CLI: (version, problem)."""
    ran = run_capture([argv0, "--version"], env, 30)
    if ran.fault:
        return None, f"--version {ran.fault}: {ran.err.strip()[:160]}"
    text = (ran.out or ran.err).strip()
    if ran.rc != 0:
        return None, (text.splitlines() or [f"--version exit {ran.rc}"])[0][:200]
    version = text.splitlines()[0] if text else ""
    wanted = ".".join(map(str, MIN_SKILLEX))
    parsed = parse_version(version)
    if parsed is None or parsed < MIN_SKILLEX:
        return None, f"reports {version!r}; the strict policy needs skillex {wanted} or newer"
    return version, None


def node_dirs(environ, home, mise, env):
    """Directories holding a Node that a bare `skillex` script could run on, best first."""
    if mise:
        ran = run_capture([mise, "which", "node"], env, 20)
        if ran.rc == 0 and ran.out.strip():
            yield Path(ran.out.strip()).parent
    data = Path(environ.get("MISE_DATA_DIR") or home / ".local/share/mise")

    def order(node):
        return tuple(int(part) for part in re.findall(r"\d+", node.parent.parent.name))

    installed = sorted((data / "installs/node").glob("*/bin/node"), key=order, reverse=True)
    yield from (node.parent for node in installed)


def resolve_skillex(environ, registry_root):
    """Find a working skillex without any interactive shell setup.

    Order: $SKILLEX_BIN (an explicit override is never second-guessed), a skillex
    on PATH, the mise shim, `mise which skillex`. A real binary met on a bare PATH
    may find Node 20 first; the probe then looks for a newer Node and puts it in
    front. Returns (argv0, env, version) or raises SkillexUnavailableError.
    """
    home = Path(environ.get("HOME") or Path.home())
    env = child_env(environ, registry_root)
    mise = shutil.which("mise", path=env["PATH"]) or str(home / ".local/bin/mise")
    mise = mise if os.access(mise, os.X_OK) else None
    tried = []

    def attempt(label, argv0):
        version, problem = probe(argv0, env)
        if problem and "Node 24" in problem:
            for directory in node_dirs(environ, home, mise, env):
                lifted = dict(env, PATH=f"{directory}:{env['PATH']}")
                lifted_version, still = probe(argv0, lifted)
                if still is None:
                    return argv0, lifted, lifted_version
        if problem:
            tried.append(f"{label} {argv0}: {problem}")
            return None
        return argv0, env, version

    explicit = environ.get("SKILLEX_BIN")
    if explicit:
        resolved = explicit if os.sep in explicit else shutil.which(explicit, path=env["PATH"])
        if not resolved or os.path.isdir(resolved) or not os.access(resolved, os.X_OK):
            raise SkillexUnavailableError(f"SKILLEX_BIN={explicit} is not an executable file")
        got = attempt("SKILLEX_BIN", resolved)
        if got:
            return got
        raise SkillexUnavailableError("SKILLEX_BIN does not run: " + "; ".join(tried))

    found = shutil.which("skillex", path=env["PATH"])
    if found:
        got = attempt("PATH", found)
        if got:
            return got
    else:
        tried.append("PATH: no skillex on " + env["PATH"])
    shims = [
        Path(environ["MISE_DATA_DIR"]) / "shims" if environ.get("MISE_DATA_DIR") else None,
        Path(environ["XDG_DATA_HOME"]) / "mise/shims" if environ.get("XDG_DATA_HOME") else None,
        home / ".local/share/mise/shims",
    ]
    for shims_dir in dict.fromkeys(path for path in shims if path):
        shim = shims_dir / "skillex"
        if not os.access(shim, os.X_OK):
            tried.append(f"mise shim {shim}: not an executable file")
            continue
        got = attempt("mise shim", str(shim))
        if got:
            return got
    if mise:
        ran = run_capture([mise, "which", "skillex"], env, 20)
        path = ran.out.strip()
        if ran.rc == 0 and path and os.access(path, os.X_OK):
            got = attempt("mise which", path)
            if got:
                return got
        else:
            tried.append(f"mise which skillex: {(ran.err.strip() or 'no output')[:160]}")
    else:
        tried.append("mise: not found on PATH or at ~/.local/bin/mise")
    raise SkillexUnavailableError(
        "no usable skillex CLI (set SKILLEX_BIN or install @delorenj/skillex with mise): "
        + "; ".join(tried)
    )


class Skillex:
    """Thin, never-raising wrapper over `skillex profile ...`."""

    def __init__(self, argv0, env, hermes_root, registry_root, timeout):
        self.argv0, self.env, self.timeout = argv0, env, timeout
        self.shared = ["--hermes-root", str(hermes_root), "--registry-root", str(registry_root)]

    def profile(self, *args):
        argv = [self.argv0, "profile", *args, *self.shared, "--json"]
        ran = run_capture(argv, self.env, self.timeout)
        if ran.fault:
            detail = ran.err.strip()[:200] or f"{ran.fault} after {self.timeout:g}s"
            return Outcome(None, {}, [], ran.fault, detail)
        try:
            envelope = json.loads(ran.out)
            if not isinstance(envelope, dict):
                raise ValueError("not an object")
        except ValueError:
            snippet = (ran.err or ran.out).strip().replace("\n", " ")[:200]
            return Outcome(ran.rc, {}, [], "non-json", snippet or f"exit {ran.rc}, no output")
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        findings = envelope.get("findings") if isinstance(envelope.get("findings"), list) else []
        return Outcome(ran.rc, data, findings, None, "")

    def show(self, name, project, retry_delay=0):
        """`profile show`, asked twice when the answer smells like another writer mid-flight."""
        args = ["show", name, *(["--project", project] if project else [])]
        outcome = self.profile(*args)
        if outcome.fault is None and outcome.exit in TRANSIENT_SHOW:
            time.sleep(retry_delay)
            outcome = self.profile(*args)
        return outcome


def brief(findings):
    kept = []
    for finding in findings[:MAX_FINDINGS]:
        if isinstance(finding, dict):
            row = {
                key: finding[key]
                for key in ("code", "severity", "message", "path")
                if finding.get(key)
            }
            if "message" in row:
                row["message"] = str(row["message"])[:240]
            kept.append(row)
    return kept


def change_counts(data):
    counts = {}
    for change in data.get("changes") or []:
        if isinstance(change, dict):
            action = str(change.get("action"))
            counts[action] = counts.get(action, 0) + 1
    return counts


def strict_marker(desk_dir):
    """True for a real directory holding a regular-file (not symlinked) marker."""
    marker = desk_dir / STRICT_MARKER
    return (
        not desk_dir.is_symlink()
        and desk_dir.is_dir()
        and marker.is_file()
        and not marker.is_symlink()
    )


def enumerate_desks(hermes_root):
    """(strict desk names, skipped [{desk, reason}]) from <hermes_root>/profiles."""
    strict, skipped = [], []
    for entry in sorted((hermes_root / "profiles").iterdir(), key=lambda path: path.name):
        marker = entry / STRICT_MARKER
        if not entry.is_dir():
            continue  # the per-profile config lock files Hermes keeps beside the desks
        if entry.is_symlink():
            skipped.append({"desk": entry.name, "reason": "not a real profile directory"})
        elif strict_marker(entry):
            strict.append(entry.name)
        elif marker.exists() or marker.is_symlink():
            skipped.append({"desk": entry.name, "reason": f"{STRICT_MARKER} is not a regular file"})
        else:
            skipped.append({"desk": entry.name, "reason": f"no {STRICT_MARKER} marker"})
    return strict, skipped


def recorded_projects(skillex):
    """name -> the project Skillex recorded for it, from one `profile list`; None if unreadable."""
    listing = skillex.profile("list")
    profiles = listing.data.get("profiles")
    if listing.fault or not isinstance(profiles, list):
        return None
    found = {}
    for item in profiles:
        if isinstance(item, dict) and isinstance(item.get("profile"), dict):
            found[item["profile"].get("name")] = item.get("project")
    return found


def desk_stub(name, status, reason):
    return {
        "event": "desk",
        "desk": name,
        "project": None,
        "status": status,
        "show_exit": None,
        "reason": reason,
    }


def resync_desk(skillex, name, project, desk_dir, dry_run, retry_delay):
    """Converge one desk. Returns its record; never raises into the caller's loop."""
    started = time.monotonic()
    record = {"event": "desk", "desk": name, "project": project, "status": "error"}
    record["show_exit"] = None

    def finish(status, reason=None):
        record["status"] = status
        if reason:
            record["reason"] = reason
        record["duration_ms"] = int((time.monotonic() - started) * 1000)
        return record

    def first_reason(fallback):
        return (record.get("findings") or [{}])[0].get("message") or fallback

    try:
        if not project:
            project = skillex.show(name, None, retry_delay).data.get("project")
            record["project"] = project
        if not project:
            return finish(
                "error",
                "Skillex has no recorded project for this desk (missing or unreadable receipt); "
                f"run: skillex profile sync {name} --project REPO --skillex-only",
            )
        shown = skillex.show(name, project, retry_delay)
        record["show_exit"] = shown.exit
        if shown.fault:
            return finish("error", f"skillex profile show {shown.fault}: {shown.detail}")
        if shown.exit == SX_OK:
            return finish("ok")
        record["findings"] = brief(shown.findings)
        reason = first_reason(f"skillex profile show exit {shown.exit}")
        if shown.exit == SX_REFUSED:
            return finish("refused", reason)
        if shown.exit == SX_LOCK_BUSY:
            return finish("busy", "another skillex writer holds this desk; retried on the next run")
        if shown.exit != SX_DRIFT:
            return finish("error", f"skillex profile show exit {shown.exit}: {reason}")
        record["changes"] = change_counts(shown.data)
        if dry_run:
            return finish("would-sync")
        if not strict_marker(desk_dir):
            return finish("error", f"{STRICT_MARKER} vanished before the sync; left alone")
        synced = skillex.profile("sync", name, "--project", project, "--skillex-only")
        record["sync_exit"] = synced.exit
        if synced.fault:
            return finish("error", f"skillex profile sync {synced.fault}: {synced.detail}")
        if synced.exit != SX_OK:
            record["findings"] = brief(synced.findings) or record["findings"]
            reason = first_reason(f"skillex profile sync exit {synced.exit}")
            if synced.exit == SX_REFUSED:
                return finish("refused", reason)
            if synced.exit == SX_LOCK_BUSY:
                return finish("busy", "another skillex writer holds this desk; retried next run")
            return finish("error", f"skillex profile sync exit {synced.exit}: {reason}")
        verified = skillex.show(name, project, retry_delay)
        record["verify_exit"] = verified.exit
        if verified.fault or verified.exit != SX_OK:
            return finish(
                "error", f"not converged after sync: show exit {verified.exit} {verified.detail}"
            )
        return finish("synced")
    except Exception as error:  # one desk must never stop the others
        return finish("error", f"{type(error).__name__}: {error}")


def catalog_head(registry_root, env):
    argv = ["git", "-C", str(registry_root / "all-skills"), "rev-parse", "HEAD"]
    ran = run_capture(argv, env, 15)
    head = ran.out.strip()
    return head if ran.rc == 0 and re.fullmatch(r"[0-9a-f]{40,64}", head) else None


def catalog_moved_at(registry_root, env):
    """When the catalog's HEAD last moved (its reflog), as an ISO UTC stamp; None if unknown."""
    argv = ["git", "-C", str(registry_root / "all-skills")]
    ran = run_capture([*argv, "reflog", "-1", "--format=%gd", "--date=unix", "HEAD"], env, 15)
    found = re.fullmatch(r"HEAD@\{(\d+)\}", ran.out.strip())
    if ran.rc != 0 or not found:
        return None
    return stamp(datetime.datetime.fromtimestamp(int(found.group(1)), datetime.UTC))


def previous_catalog_commit(last_file):
    """The catalog commit the previous real run converged to, from its last-run file."""
    try:
        return json.loads(last_file.read_text(encoding="utf-8")).get("catalog_commit")
    except (OSError, ValueError, AttributeError):
        return None


def merge(previous, current):
    """A desk synced on an earlier pass and found converged on this one stays `synced`."""
    if previous and previous["status"] == "synced" and current["status"] == "ok":
        return previous
    return current


def count_by_status(results):
    counts = dict.fromkeys(("ok", "synced", "would_sync", "refused", "error", "busy"), 0)
    counts["total"] = len(results)
    for record in results:
        counts[record["status"].replace("-", "_")] += 1
    return counts


@contextlib.contextmanager
def exclusive(path):
    """Non-blocking whole-run flock; yields False when a peer holds it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()} {stamp()}\n".encode())
        yield True
    finally:
        os.close(fd)


def append_log(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        if path.stat().st_size > LOG_ROTATE_BYTES:
            os.replace(path, path.with_name(path.name + ".1"))
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("".join(json.dumps(record, sort_keys=True) + "\n" for record in records))


def write_last(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def summary_line(run):
    counts = run["counts"]
    labels = (
        ("synced", "synced"),
        ("would_sync", "would sync"),
        ("refused", "refused"),
        ("error", "error"),
        ("busy", "busy"),
        ("ok", "current"),
    )
    parts = [f"{counts[key]} {label}" for key, label in labels if counts[key]]
    head = (run.get("catalog_commit") or "unknown")[:7]
    status = run["status"]
    label = status.upper() if status in ("attention", "error") else status
    text = f"hermes-skillex-resync: {label}{' DRY RUN' if run['dry_run'] else ''}"
    text += f" - {counts['total']} strict desks"
    text += f" ({', '.join(parts)})" if parts else ""
    passes = run["passes"]
    text += f", catalog {head}, {passes} pass{'es' if passes != 1 else ''}"
    return text + f", {run['duration_ms'] / 1000:.1f}s"


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        epilog="Exit: 0 converged or busy, 1 a desk needs a human, 2 could not start.",
    )
    add = parser.add_argument
    add(
        "--profile", action="append", default=[], metavar="NAME", help="only this desk (repeatable)"
    )
    add("--dry-run", action="store_true", help="report what would be synced; write nothing")
    add(
        "--json", action="store_true", help="print the run record, desks included, as one JSON line"
    )
    add("--hermes-root", "--fleet-home", dest="hermes_root", type=Path, default=None)
    add(
        "--registry-root",
        type=Path,
        default=None,
        help="default: $PJ_SKILLS_REGISTRY_ROOT or ~/code/skillex",
    )
    add("--state-dir", type=Path, default=None, help="log and last-run directory")
    add("--lock-file", type=Path, default=None, help="default: <hermes-root>/.skillex-resync.lock")
    add("--timeout", type=float, default=90, help="seconds allowed for one skillex call")
    add("--deadline", type=float, default=600, help="seconds allowed for the whole run")
    add("--settle", type=float, default=0, help="debounce: wait this long before looking")
    add("--retry-delay", type=float, default=3, help="pause before re-asking a transient answer")
    add("--max-passes", type=int, default=3, help="go round again while the catalog HEAD moves")
    return parser.parse_args(argv)


def main(argv=None, environ=None):
    args = parse_args(argv)
    environ = dict(os.environ if environ is None else environ)
    home = Path(environ.get("HOME") or Path.home())
    hermes_root = (args.hermes_root or home / ".hermes").expanduser()
    registry_root = args.registry_root or Path(
        environ.get("PJ_SKILLS_REGISTRY_ROOT") or home / "code/skillex"
    )
    registry_root = registry_root.expanduser()
    state_home = Path(environ.get("XDG_STATE_HOME") or home / ".local/state")
    state_dir = (args.state_dir or state_home / "skillex").expanduser()
    started = time.monotonic()
    now = datetime.datetime.now(datetime.UTC)
    run = {
        "schema": SCHEMA,
        "event": "run",
        "run_id": f"{now:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}",
        "started_at": stamp(now),
        # systemd's $TRIGGER_UNIT names the timer for a path-started run when a service has
        # both (measured 2026-10-02), so it is no evidence; catalog_moved_at is.
        "trigger": "systemd" if environ.get("INVOCATION_ID") else "manual",
        "dry_run": args.dry_run,
        "hermes_root": str(hermes_root),
        "registry_root": str(registry_root),
        "catalog_commit": None,
        "previous_catalog_commit": None,
        "catalog_moved_at": None,
        "skillex": None,
        "passes": 0,
        "settled": True,
        "skipped": [],
    }
    results = {}

    def finish(status, code, message=None, last=True):
        run.update(status=status, exit=code, finished_at=stamp())
        run["duration_ms"] = int((time.monotonic() - started) * 1000)
        run["counts"] = count_by_status(list(results.values()))
        run["attention"] = sorted(
            desk["desk"] for desk in results.values() if desk["status"] in ("refused", "error")
        )
        run["message"] = message or summary_line(run)
        full = dict(run, results=[results[name] for name in sorted(results)])
        if not args.dry_run:
            lines = [
                dict(desk, run_id=run["run_id"], ts=run["finished_at"])
                for desk in full["results"]
                if desk["status"] != "ok"
            ]
            try:
                append_log(state_dir / LOG_NAME, [*lines, run])
                if last:
                    write_last(state_dir / LAST_NAME, full)
            except OSError as error:
                print(f"hermes-skillex-resync: cannot write evidence: {error}", file=sys.stderr)
        loud = status in ("attention", "error")
        if args.json:
            print(json.dumps(full, sort_keys=True), flush=True)
        else:
            print(run["message"], file=sys.stderr if loud else sys.stdout, flush=True)
            for desk in full["results"]:
                if desk["status"] in ("refused", "error"):
                    why = desk.get("reason", "")
                    print(
                        f"  ATTENTION {desk['desk']}: {desk['status']} - {why}",
                        file=sys.stderr,
                        flush=True,
                    )
        return code

    if not (hermes_root / "profiles").is_dir():
        text = f"no profiles directory under {hermes_root}"
        return finish("error", EXIT_ENV, f"hermes-skillex-resync: ERROR - {text}")
    if not (registry_root / "all-skills").is_dir():
        text = f"no all-skills catalog under {registry_root}"
        return finish("error", EXIT_ENV, f"hermes-skillex-resync: ERROR - {text}")

    if args.settle > 0 and not args.dry_run:
        time.sleep(args.settle)  # debounce: a burst of catalog writes becomes one run
    with contextlib.ExitStack() as stack:
        if not args.dry_run:
            lock_file = (args.lock_file or hermes_root / LOCK_NAME).expanduser()
            try:
                free = stack.enter_context(exclusive(lock_file))
            except OSError as error:
                return finish(
                    "error", EXIT_ENV, f"hermes-skillex-resync: ERROR - lock {lock_file}: {error}"
                )
            if not free:
                run["catalog_commit"] = catalog_head(
                    registry_root, child_env(environ, registry_root)
                )
                # A busy run says nothing about the fleet: the peer's last.json stands.
                text = (
                    f"hermes-skillex-resync: busy - another resync holds {lock_file}; nothing done"
                )
                return finish("busy", EXIT_OK, text, last=False)
        try:
            argv0, env, version = resolve_skillex(environ, registry_root)
        except SkillexUnavailableError as error:
            return finish("error", EXIT_ENV, f"hermes-skillex-resync: ERROR - {error}")
        run["skillex"] = {"bin": argv0, "version": version}
        run["previous_catalog_commit"] = previous_catalog_commit(state_dir / LAST_NAME)
        skillex = Skillex(argv0, env, hermes_root, registry_root, args.timeout)

        desks, run["skipped"] = enumerate_desks(hermes_root)
        for name in args.profile:
            if name not in desks:
                reason = f"not a strict desk (no regular-file {STRICT_MARKER} marker)"
                results[name] = desk_stub(name, "error", reason)
        if args.profile:
            desks = [name for name in desks if name in args.profile]
        projects = recorded_projects(skillex) if desks else {}
        deadline = started + args.deadline
        for number in range(1, max(1, args.max_passes) + 1):
            before = catalog_head(registry_root, env)
            for name in desks:
                if time.monotonic() > deadline:
                    reason = f"run deadline of {args.deadline:g}s exceeded before this desk"
                    results.setdefault(name, desk_stub(name, "error", reason))
                    continue
                record = resync_desk(
                    skillex,
                    name,
                    (projects or {}).get(name),
                    hermes_root / "profiles" / name,
                    args.dry_run,
                    args.retry_delay,
                )
                results[name] = merge(results.get(name), record)
            after = catalog_head(registry_root, env)
            run.update(passes=number, catalog_commit=after, settled=before == after)
            run["catalog_moved_at"] = catalog_moved_at(registry_root, env)
            if run["settled"] or args.dry_run or not desks:
                break
        counts = count_by_status(list(results.values()))
        if counts["refused"] or counts["error"]:
            return finish("attention", EXIT_ATTENTION)
        return finish("partial" if counts["busy"] else "ok", EXIT_OK)


if __name__ == "__main__":
    raise SystemExit(main())
