#!/usr/bin/env bash
# Install, remove or inspect the systemd USER units that keep every Skillex-only
# Hermes desk converged with the all-skills catalog. Idempotent.
#
#   install-hermes-resync.sh install     link the units, daemon-reload, enable --now timer + path
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
ENABLED=("$TIMER" "$PATHU")

ctl() { "$CTL" --user "$@"; }
die() { echo "install-hermes-resync: $*" >&2; exit 1; }
same_path() { [[ "$(realpath -m -- "$1")" == "$(realpath -m -- "$2")" ]]; }

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

do_install() {
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
  echo "enabled  $TIMER (startup + every 15 min) and $PATHU (catalog HEAD: $gitdir)"
}

do_uninstall() {
  ctl disable --now "${ENABLED[@]}" 2>&1 || true
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

do_status() {
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

  local head=""
  head="$(git -C "$REPO/all-skills" rev-parse HEAD 2>/dev/null || true)"
  if ! python3 - "$STATE/hermes-resync.last.json" "$head" <<'PY'; then
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
    f"trigger={last.get('trigger')} desks={c.get('total')} synced={c.get('synced')} "
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
    bad=1
  fi
  if [[ "$bad" -eq 0 ]]; then echo "healthy"; else echo "NOT HEALTHY"; fi
  return "$bad"
}

case "${1:-}" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
  *) echo "usage: ${0##*/} install | uninstall | status" >&2; exit 2 ;;
esac
