#!/usr/bin/env bash
# hermes-base-guard.sh — forbids in-place edits of pack-owned base skills.
#
# The failure mode this closes: the skill curator opens a base SKILL.md inside a
# runtime skills/ dir and edits it in place. That silently forks the base (14 of
# 18 base dirs already diverged this way). This guard makes such an edit fail
# loudly and tells the curator to put the change in the OVERLAY or PROMOTE it to
# the next pack version instead.
#
# Wiring (pick one; recommended: all three):
#   1) skill_ssot.py hook  — call `hermes-base-guard.sh check-tree <runtime>` from
#      skill_ssot.py's sweep/doctor so `skillex` refuses to bless a divergent base.
#   2) pre-commit           — in any repo that vendors a runtime skills/ tree, run
#      `hermes-base-guard.sh check-staged` as a pre-commit hook.
#   3) fleet self-check     — 33god-agent-fleet-operations self-check calls
#      `check-tree` across all 22 runtimes and reports drift.
#
# It is a GUARD, not a mutator: it only reports/exits non-zero. Reconciliation is
# done by create-pack-plan.md step 4.

set -euo pipefail
PACK_VERSION="0.18.2"
PACK_DIR="${HERMES_BASE_PACK:-/home/delorenj/code/skillex/packs/hermes-base/${PACK_VERSION}}"
MANIFEST="${PACK_DIR}/MANIFEST.sha256"

treehash() { ( cd "$1" && find . -type f | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done | sha256sum | cut -d' ' -f1 ); }

# check-tree <runtime_skills_dir>: fail if any base-named dir exists in the runtime
# skills/ overlay AND its content differs from the pinned pack baseline.
check_tree() {
  local rt="$1" rc=0 h want name
  [ -f "$MANIFEST" ] || { echo "FATAL: manifest missing: $MANIFEST" >&2; exit 2; }
  while read -r want name; do
    [[ "$want" == \#* || -z "$want" ]] && continue
    local d="$rt/$name"
    [ -d "$d" ] || continue                 # not overlaid here — fine, it resolves via external_dirs
    h=$(treehash "$d")
    if [ "$h" != "$want" ]; then
      echo "BASE-EDIT DENIED: $rt/$name diverges from hermes-base@${PACK_VERSION}" >&2
      echo "  -> Do NOT edit a base skill in place. Either:" >&2
      echo "     (a) delete the local copy so it resolves read-only from the pack, or" >&2
      echo "     (b) if the change is a genuine shared improvement, PROMOTE it: bump the" >&2
      echo "         pack version and update MANIFEST.sha256, or" >&2
      echo "     (c) if it is agent-specific, rename it and keep it as an overlay-only skill." >&2
      rc=1
    fi
  done < "$MANIFEST"
  return $rc
}

# check-staged: same check, but only over base-named dirs touched in the git index.
check_staged() {
  local rt_root rc=0
  rt_root=$(git rev-parse --show-toplevel)
  local changed
  changed=$(git diff --cached --name-only | grep -E '(^|/)skills/[^/]+/' || true)
  [ -z "$changed" ] && return 0
  # collect distinct skills/<name> dirs that are base-owned
  while read -r rel; do
    local skdir; skdir=$(echo "$rel" | sed -E 's#(.*/skills/[^/]+)/.*#\1#')
    local name; name=$(basename "$skdir")
    grep -qE "  $name\$" "$MANIFEST" || continue
    local want; want=$(grep -E "  $name\$" "$MANIFEST" | awk '{print $1}')
    local h; h=$(treehash "$rt_root/$skdir")
    if [ "$h" != "$want" ]; then
      echo "pre-commit: base skill '$name' edited in place ($skdir) — forbidden. See hermes-base-guard." >&2
      rc=1
    fi
  done <<< "$changed"
  return $rc
}

case "${1:-}" in
  check-tree)   check_tree "${2:?usage: check-tree <runtime_skills_dir>}";;
  check-staged) check_staged;;
  *) echo "usage: $0 {check-tree <runtime_skills_dir>|check-staged}" >&2; exit 2;;
esac
