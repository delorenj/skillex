#!/usr/bin/env bash
# Install, remove or inspect the user-level service that keeps every Skillex-only
# Hermes desk converged with the all-skills catalog. Idempotent.
#
# Backend by OS (uname -s; SKILLEX_RESYNC_OS overrides, for tests):
#   Linux   systemd USER units (below)
#   Darwin  one LaunchAgent, io.33god.skillex-hermes-resync, generated at install
#           (it needs absolute paths and a real python3): WatchPaths on the same two
#           catalog files the .path unit watches, StartInterval 900 and RunAtLoad
#           (macOS has no candybar, so launchd also owns the schedule the retired
#           .timer used to). Same install | uninstall | status. See
#           docs/implementation/hermes-skillex-resync.md "macOS".
#
#   install-hermes-resync.sh install     link the units, daemon-reload, enable --now the .path
#                                        (the .timer is RETIRED: candybar owns the schedule —
#                                        33GOD/candybar deploy/migration/ledger.yaml, story 7.8)
#   install-hermes-resync.sh uninstall   disable --now, unlink the units and drop-ins
#   install-hermes-resync.sh status      units, last run and catalog freshness; exit 1 if unhealthy
#
# The units are SYMLINKED from this repo (the asm-sweep pattern): edit them here,
# run `install` again. They assume the checkout lives at ~/code/skillex with
# all-skills as a plain clone; when it does not (a submodule keeps its gitdir
# under .git/modules, or the repo sits elsewhere) `install` writes a drop-in that
# overrides just the paths, and removes it again once the layout is the default.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(dirname "$HERE")"
SRC="$REPO/systemd"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/skillex"
CTL="${SYSTEMCTL:-systemctl}"
DEFAULT_REPO="$HOME/code/skillex"
SERVICE=skillex-hermes-resync.service
TIMER=skillex-hermes-resync.timer
PATHU=skillex-hermes-resync.path
UNITS=("$SERVICE" "$TIMER" "$PATHU")
# The .timer is retired (candybar schedules the resync); only the .path trigger is enabled.
ENABLED=("$PATHU")

ctl() { "$CTL" --user "$@"; }
die() { echo "install-hermes-resync: $*" >&2; exit 1; }
# realpath -m is GNU-only (macOS realpath has no -m); python resolves the same way.
OS="${SKILLEX_RESYNC_OS:-$(uname -s)}"
# py3 ARGS...: the python for helper snippets. On macOS a bare python3 may be the
# Xcode stub, so use the interpreter resolve_python picks (below); elsewhere python3.
py3() {
  local interpreter=python3
  if [[ "$OS" == Darwin ]]; then interpreter="$(resolve_python 2>/dev/null || true)"; fi
  "${interpreter:-python3}" "$@"
}
same_path() {
  [[ "$(py3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1")" \
     == "$(py3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$2")" ]]
}

link_unit() {
  local src="$SRC/$1" dst="$DEST/$1"
  [[ -f "$src" ]] || die "missing unit $src"
  if [[ -L "$dst" ]]; then
    if [[ "$(readlink "$dst")" == "$src" ]]; then
      echo "ok       $dst"
    else
      ln -sfn "$src" "$dst"
      echo "relinked $dst -> $src"
    fi
  elif [[ -e "$dst" ]]; then
    die "$dst exists and is not a symlink; move it aside (the units are tracked in $SRC)"
  else
    ln -s "$src" "$dst"
    echo "linked   $dst -> $src"
  fi
}

# write_dropin UNIT NAME CONTENT: create or refresh $DEST/UNIT.d/NAME only when it differs.
write_dropin() {
  local dir="$DEST/$1.d" file="$DEST/$1.d/$2"
  mkdir -p "$dir"
  if [[ -f "$file" && "$(cat "$file")" == "$3" ]]; then
    echo "ok       $file"
  else
    printf '%s\n' "$3" >"$file"
    echo "wrote    $file"
  fi
}

drop_dropin() {
  local dir="$DEST/$1.d" file="$DEST/$1.d/$2"
  if [[ -e "$file" ]]; then
    rm -f "$file"
    rmdir "$dir" 2>/dev/null || true
    echo "removed  $file"
  fi
}

do_install_systemd() {
  local gitdir
  [[ -x /usr/bin/python3 ]] || die "/usr/bin/python3 not found (the service runs it by absolute path)"
  [[ -f "$REPO/scripts/hermes-skillex-resync.py" ]] || die "missing $REPO/scripts/hermes-skillex-resync.py"
  gitdir="$(git -C "$REPO/all-skills" rev-parse --absolute-git-dir 2>/dev/null)" \
    || die "$REPO/all-skills is not a git checkout; run: git -C $REPO submodule update --init all-skills"
  mkdir -p "$DEST"
  for unit in "${UNITS[@]}"; do link_unit "$unit"; done

  if same_path "$gitdir" "$DEFAULT_REPO/all-skills/.git"; then
    drop_dropin "$PATHU" 10-layout.conf
  else
    write_dropin "$PATHU" 10-layout.conf "[Path]
PathModified=
PathChanged=
PathModified=$gitdir/logs/HEAD
PathChanged=$gitdir/HEAD"
  fi
  if same_path "$REPO" "$DEFAULT_REPO"; then
    drop_dropin "$SERVICE" 10-layout.conf
  else
    write_dropin "$SERVICE" 10-layout.conf "[Service]
ExecStart=
ExecStart=/usr/bin/python3 -B $REPO/scripts/hermes-skillex-resync.py --settle 4
Environment=PJ_SKILLS_REGISTRY_ROOT=$REPO"
  fi

  ctl daemon-reload
  ctl reset-failed "${UNITS[@]}" 2>/dev/null || true
  ctl enable --now "${ENABLED[@]}"
  if ctl is-enabled "$TIMER" >/dev/null 2>&1; then
    echo "WARNING: $TIMER is retired — disable it: systemctl --user disable --now $TIMER" >&2
  fi
  echo "enabled  $PATHU (catalog HEAD: $gitdir); $TIMER stays retired (candybar owns the schedule)"
}

do_uninstall_systemd() {
  ctl disable --now "$TIMER" "${ENABLED[@]}" 2>&1 || true
  ctl stop "$SERVICE" 2>/dev/null || true
  for unit in "${UNITS[@]}"; do
    local dst="$DEST/$unit"
    if [[ -L "$dst" ]]; then
      if [[ "$(readlink "$dst")" == "$SRC/$unit" || ! -e "$dst" ]]; then
        rm -f "$dst"
        echo "removed  $dst"
      else
        echo "left     $dst (links to $(readlink "$dst"), not this repo)"
      fi
    elif [[ -e "$dst" ]]; then
      echo "left     $dst (not a symlink)"
    fi
  done
  drop_dropin "$PATHU" 10-layout.conf
  drop_dropin "$SERVICE" 10-layout.conf
  ctl daemon-reload
  ctl reset-failed "${UNITS[@]}" 2>/dev/null || true
  echo "uninstalled (the log and last-run file in $STATE are kept)"
}

# report_last_run: print the last run and catalog freshness; return 1 if the last run is missing or bad.
report_last_run() {
  local head=""
  head="$(git -C "$REPO/all-skills" rev-parse HEAD 2>/dev/null || true)"
  if ! py3 - "$STATE/hermes-resync.last.json" "$head" <<'PY'; then
import json
import sys

path, head = sys.argv[1], sys.argv[2]
try:
    last = json.load(open(path))
except (OSError, ValueError):
    print(f"last run  none recorded at {path}")
    sys.exit(1)
c = last.get("counts", {})
print(
    f"last run  {last.get('finished_at')} {last.get('status')} exit={last.get('exit')} "
    f"desks={c.get('total')} synced={c.get('synced')} "
    f"refused={c.get('refused')} error={c.get('error')} busy={c.get('busy')}"
)
seen = last.get("catalog_commit")
if head and seen and head != seen:
    print(f"catalog   MOVED since the last run (ran at {seen[:7]}, now {head[:7]}): the next trigger resyncs")
elif seen:
    print(f"catalog   {seen[:7]} (current)")
for desk in last.get("attention", []):
    print(f"ATTENTION {desk}")
sys.exit(0 if last.get("status") in ("ok", "partial") else 1)
PY
    return 1
  fi
  return 0
}

do_status_systemd() {
  local bad=0 unit enabled active
  for unit in "${ENABLED[@]}"; do
    enabled="$(ctl is-enabled "$unit" 2>&1 || true)"
    active="$(ctl is-active "$unit" 2>&1 || true)"
    printf '%-34s enabled=%-10s active=%s\n' "$unit" "$enabled" "$active"
    [[ "$enabled" == enabled && "$active" == active ]] || bad=1
  done
  for unit in "${UNITS[@]}"; do
    if [[ -L "$DEST/$unit" && "$(readlink "$DEST/$unit")" == "$SRC/$unit" ]]; then
      :
    else
      echo "NOT LINKED to this repo: $DEST/$unit"
      bad=1
    fi
  done
  ctl show "$SERVICE" -p Result -p ExecMainStatus -p ExecMainExitTimestamp --no-pager 2>/dev/null | sed 's/^/service   /' || true
  ctl list-timers "$TIMER" --no-pager 2>/dev/null | sed -n '1,2p' || true

  report_last_run || bad=1
  if [[ "$bad" -eq 0 ]]; then echo "healthy"; else echo "NOT HEALTHY"; fi
  return "$bad"
}

# ---------------------------------------------------------------- Darwin: launchd

LABEL="${SKILLEX_RESYNC_LABEL:-io.33god.skillex-hermes-resync}"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
DOMAIN="gui/$(id -u)"
INTERVAL_SECONDS=900

lctl() { "$LAUNCHCTL" "$@"; }

# A python that can run hermes-skillex-resync.py (3.11+: datetime.UTC). Never the
# /usr/bin/python3 Xcode stub, which opens an install dialog when run without the
# Command Line Tools and is 3.9 with them. Order: $RESYNC_PYTHON, Homebrew, mise,
# whatever `command -v python3` finds. The result is the interpreter's own
# sys.executable, so a mise or pyenv shim is not baked into the plist.
resolve_python() {
  local candidate resolved
  local -a candidates=()
  [[ -z "${RESYNC_PYTHON:-}" ]] || candidates+=("$RESYNC_PYTHON")
  candidates+=(/opt/homebrew/bin/python3 /usr/local/bin/python3)
  if command -v mise >/dev/null 2>&1; then
    candidates+=("$(mise which python3 2>/dev/null || true)")
  fi
  candidates+=("$HOME/.local/bin/python3" "$(command -v python3 2>/dev/null || true)")
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    [[ "$candidate" != /usr/bin/python3 ]] || continue
    resolved="$("$candidate" -c 'import sys; sys.exit(1) if sys.version_info < (3, 11) else print(sys.executable)' 2>/dev/null)" || continue
    [[ -n "$resolved" && -x "$resolved" ]] || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

# render_plist PYTHON GITDIR: the LaunchAgent, as XML, on stdout.
render_plist() {
  py3 - "$1" "$2" "$REPO" "$LABEL" "$INTERVAL_SECONDS" "$STATE" "$HOME" <<'PY'
import plistlib
import sys

python, gitdir, repo, label, interval, state, home = sys.argv[1:8]
path = ":".join(
    [
        f"{home}/.local/bin",
        f"{home}/.local/share/mise/shims",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
)
plist = {
    "Label": label,
    "ProgramArguments": [python, "-B", f"{repo}/scripts/hermes-skillex-resync.py", "--settle", "4"],
    # The two files the Linux .path unit watches: the append-only reflog (every commit, pull,
    # rebase, checkout) and HEAD (symbolic-ref moves it with no reflog entry). launchd runs the
    # job once per burst; events during a run are not queued, which is why the script re-checks
    # the catalog HEAD before it exits and StartInterval is the fallback.
    "WatchPaths": [f"{gitdir}/logs/HEAD", f"{gitdir}/HEAD"],
    "StartInterval": int(interval),
    "RunAtLoad": True,
    "WorkingDirectory": "/",
    "EnvironmentVariables": {"PJ_SKILLS_REGISTRY_ROOT": repo, "PATH": path},
    "ProcessType": "Background",
    "Nice": 10,
    "ThrottleInterval": 30,
    "StandardOutPath": f"{state}/hermes-resync.launchd.log",
    "StandardErrorPath": f"{state}/hermes-resync.launchd.log",
}
sys.stdout.buffer.write(plistlib.dumps(plist, sort_keys=False))
PY
}

launchd_loaded() { lctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

do_install_launchd() {
  local gitdir python expected verb
  [[ -f "$REPO/scripts/hermes-skillex-resync.py" ]] || die "missing $REPO/scripts/hermes-skillex-resync.py"
  gitdir="$(git -C "$REPO/all-skills" rev-parse --absolute-git-dir 2>/dev/null)" \
    || die "$REPO/all-skills is not a git checkout; run: git -C $REPO submodule update --init all-skills"
  python="$(resolve_python)" \
    || die "no python3 >= 3.11 found (not the /usr/bin/python3 Xcode stub): brew install python, or set RESYNC_PYTHON=/path/to/python3"
  mkdir -p "$AGENTS_DIR" "$STATE"
  expected="$(render_plist "$python" "$gitdir")"
  if [[ -f "$PLIST" && "$(cat "$PLIST")" == "$expected" ]]; then
    echo "ok       $PLIST"
    if launchd_loaded; then
      echo "loaded   $LABEL (python: $python, catalog HEAD: $gitdir)"
      return 0
    fi
  else
    verb=wrote
    [[ ! -e "$PLIST" ]] || verb=rewrote
    printf '%s\n' "$expected" >"$PLIST"
    chmod 644 "$PLIST"
    printf '%-8s %s\n' "$verb" "$PLIST"
    lctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi
  lctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap $DOMAIN $PLIST failed"
  lctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  echo "loaded   $LABEL (python: $python, catalog HEAD: $gitdir; WatchPaths + every ${INTERVAL_SECONDS}s + at load)"
}

do_uninstall_launchd() {
  lctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if [[ -e "$PLIST" || -L "$PLIST" ]]; then
    rm -f "$PLIST"
    echo "removed  $PLIST"
  fi
  echo "uninstalled (the log and last-run file in $STATE are kept)"
}

do_status_launchd() {
  local bad=0 python gitdir expected printed
  if launchd_loaded; then
    printed="$(lctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -nE 's/^[[:space:]]*(state|last exit code|runs) = /\1=/p' | tr '\n' ' ')"
    printf '%-34s loaded=yes %s\n' "$LABEL" "$printed"
  else
    printf '%-34s loaded=no\n' "$LABEL"
    bad=1
  fi
  if [[ ! -f "$PLIST" ]]; then
    echo "NOT INSTALLED: $PLIST"
    bad=1
  else
    gitdir="$(git -C "$REPO/all-skills" rev-parse --absolute-git-dir 2>/dev/null || true)"
    python="$(resolve_python || true)"
    expected=""
    [[ -z "$gitdir" || -z "$python" ]] || expected="$(render_plist "$python" "$gitdir")"
    if [[ -n "$expected" && "$(cat "$PLIST")" != "$expected" ]]; then
      echo "STALE    $PLIST differs from what install would write (python, repo or catalog gitdir moved): run install"
      bad=1
    fi
  fi
  report_last_run || bad=1
  if [[ "$bad" -eq 0 ]]; then echo "healthy"; else echo "NOT HEALTHY"; fi
  return "$bad"
}

# ---------------------------------------------------------------- dispatch

case "$OS" in
  Darwin) backend=launchd ;;
  Linux) backend=systemd ;;
  *) die "unsupported OS: $OS (Linux systemd and macOS launchd only)" ;;
esac

case "${1:-}" in
  install) "do_install_$backend" ;;
  uninstall) "do_uninstall_$backend" ;;
  status) "do_status_$backend" ;;
  *) echo "usage: ${0##*/} install | uninstall | status" >&2; exit 2 ;;
esac
