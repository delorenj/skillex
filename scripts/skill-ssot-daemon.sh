#!/usr/bin/env bash
# skill-ssot-daemon.sh — inotify wrapper for skill_ssot.py rescue.
#
# Watches every existing path listed in ~/.config/skillex/ssot-watch-paths
# (one per line). On every new directory event, debounces 3s and calls
# `skill_ssot.py rescue <path>`. Falls back to a full sweep every 5 minutes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SKILL_SSOT_TOOL:-$SCRIPT_DIR/skill_ssot.py}"
PYTHON="${SKILL_SSOT_PYTHON:-/usr/bin/python3}"
DEBOUNCE_SECS="${SKILL_SSOT_DEBOUNCE:-3}"
SWEEP_INTERVAL="${SKILL_SSOT_SWEEP_INTERVAL:-300}"

mapfile -t WATCH_PATHS < <("$PYTHON" "$TOOL" list-paths)

if [ "${#WATCH_PATHS[@]}" -eq 0 ]; then
  echo "skill-ssot-daemon: no existing watch paths; nothing to do" >&2
  exit 1
fi

echo "skill-ssot-daemon: watching ${#WATCH_PATHS[@]} path(s)" >&2
for p in "${WATCH_PATHS[@]}"; do echo "  - $p" >&2; done

# Initial sweep so we catch anything that was dropped while the daemon was down.
"$PYTHON" "$TOOL" sweep || true

# inotifywait -t SWEEP_INTERVAL: emit a timeout (exit 2) every SWEEP_INTERVAL seconds.
# We use that as our cadence for periodic sweeps even when no events fire.
while true; do
  set +e
  EVENT="$(inotifywait -q -e create,moved_to --format '%w%f' -t "$SWEEP_INTERVAL" "${WATCH_PATHS[@]}")"
  rc=$?
  set -e

  if [ "$rc" -eq 2 ]; then
    # Timed out with no events. Periodic sweep.
    "$PYTHON" "$TOOL" sweep || true
    continue
  fi

  if [ "$rc" -ne 0 ] || [ -z "$EVENT" ]; then
    # Something unusual. Brief pause to avoid hot-looping if inotifywait is broken.
    sleep 5
    continue
  fi

  # Debounce: wait for the new directory to settle (cp -r still in progress, etc.)
  sleep "$DEBOUNCE_SECS"

  if [ -d "$EVENT" ] && [ ! -L "$EVENT" ]; then
    "$PYTHON" "$TOOL" rescue "$EVENT" || true
  fi
done
