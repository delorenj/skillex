#!/usr/bin/env bash
# Install, remove or inspect the live skill graph (`skillex graph --serve`) as systemd user
# units. Idempotent. The units are SYMLINKED from this repo: edit them here, run install again.
#
#   install-graph-service.sh install     link the units, daemon-reload, enable --now
#   install-graph-service.sh uninstall   disable --now and unlink
#   install-graph-service.sh status      unit state and a /healthz probe; exit 1 if unhealthy
#
# The page is published at https://skills.delo.sh/ by a Traefik file route (google-auth-owner)
# to host.docker.internal:18799. Linux only; it needs the installed launcher ~/.local/bin/skillex.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(dirname "$HERE")"
SRC="$REPO/systemd"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CTL="${SYSTEMCTL:-systemctl}"
SERVICE=skillex-graph.service
UNITS=(skillex-graph.service skillex-graph-upgrade.path skillex-graph-upgrade.service)
ENABLED=(skillex-graph.service skillex-graph-upgrade.path)
LISTEN="${SKILLEX_GRAPH_LISTEN:-172.17.0.1:18799}"

ctl() { "$CTL" --user "$@"; }
die() { echo "install-graph-service: $*" >&2; exit 1; }

link_unit() {
  local src="$SRC/$1" dst="$DEST/$1"
  [[ -f "$src" ]] || die "missing unit $src"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    echo "ok       $dst"
  elif [[ -e "$dst" && ! -L "$dst" ]]; then
    die "$dst exists and is not a symlink; move it aside (the units are tracked in $SRC)"
  else
    ln -sfn "$src" "$dst"
    echo "linked   $dst -> $src"
  fi
}

do_install() {
  [[ -x "$HOME/.local/bin/skillex" ]] \
    || die "$HOME/.local/bin/skillex is missing; run: python3 ~/code/33GOD/33god-platform/scripts/cli-launchers.py upgrade @delorenj/skillex"
  mkdir -p "$DEST"
  for unit in "${UNITS[@]}"; do link_unit "$unit"; done
  ctl daemon-reload
  ctl reset-failed "${UNITS[@]}" 2>/dev/null || true
  ctl enable --now "${ENABLED[@]}"
  ctl try-restart "$SERVICE"
  echo "enabled  $SERVICE on $LISTEN (https://skills.delo.sh/)"
}

do_uninstall() {
  ctl disable --now "${ENABLED[@]}" 2>&1 || true
  for unit in "${UNITS[@]}"; do
    local dst="$DEST/$unit"
    if [[ -L "$dst" && ( "$(readlink "$dst")" == "$SRC/$unit" || ! -e "$dst" ) ]]; then
      rm -f "$dst"
      echo "removed  $dst"
    elif [[ -e "$dst" || -L "$dst" ]]; then
      echo "left     $dst (not this repo's link)"
    fi
  done
  ctl daemon-reload
}

do_status() {
  local bad=0 unit
  for unit in "${ENABLED[@]}"; do
    printf '%-32s enabled=%-10s active=%s\n' "$unit" \
      "$(ctl is-enabled "$unit" 2>&1 || true)" "$(ctl is-active "$unit" 2>&1 || true)"
    [[ "$(ctl is-active "$unit" 2>&1 || true)" == active ]] || bad=1
  done
  if curl -fsS --max-time 5 "http://$LISTEN/healthz" >/dev/null; then
    echo "healthz  http://$LISTEN/healthz ok"
  else
    echo "healthz  http://$LISTEN/healthz FAILED"
    bad=1
  fi
  if [[ "$bad" -eq 0 ]]; then echo "healthy"; else echo "NOT HEALTHY"; fi
  return "$bad"
}

[[ "$(uname -s)" == Linux ]] || die "Linux (systemd) only"
case "${1:-}" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
  *) echo "usage: ${0##*/} install | uninstall | status" >&2; exit 2 ;;
esac
