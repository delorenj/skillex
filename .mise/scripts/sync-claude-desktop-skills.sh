#!/usr/bin/env bash
# Sync skill-sets/global/ -> Claude Desktop skills dir (mirror mode).
#
# - Rewrites stale Linux absolute paths (/home/delorenj/code/skillex/...) to
#   this host's repo path so symlinks resolve on macOS.
# - Mirrors: adds missing, refreshes stale links, removes destination entries
#   no longer present in the source.
# - Hidden entries (dotfiles) in source are ignored.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/skill-sets/global"
DEST="${SKILLEX_CLAUDE_SKILLS_DIR:-$HOME/Library/Application Support/Claude/skills}"

# Stale path prefix that needs rewriting to this host's repo location.
STALE_PREFIX="/home/delorenj/code/skillex"

if [ ! -d "$SRC" ]; then
  echo "❌ source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

resolve_target() {
  # $1 = source symlink path. Echoes the absolute target this Mac should link to.
  local link="$1"
  local raw
  raw="$(readlink "$link")"

  # Rewrite stale Linux absolute paths to this host's repo.
  if [[ "$raw" == "$STALE_PREFIX"* ]]; then
    raw="${REPO_ROOT}${raw#$STALE_PREFIX}"
  fi

  # Resolve relative targets against the symlink's directory.
  if [[ "$raw" != /* ]]; then
    raw="$(cd "$(dirname "$link")" && cd "$(dirname "$raw")" && pwd)/$(basename "$raw")"
  fi

  echo "$raw"
}

added=0; refreshed=0; removed=0; skipped=0; unchanged=0

# Names seen in source — newline-delimited, surrounded by newlines for grep -F.
keep=$'\n'

# --- Pass 1: add/refresh from source ---
shopt -s nullglob
for entry in "$SRC"/*; do
  name="$(basename "$entry")"
  [[ "$name" == .* ]] && continue
  keep+="$name"$'\n'

  if [ -L "$entry" ]; then
    target="$(resolve_target "$entry")"
  elif [ -d "$entry" ]; then
    target="$entry"
  else
    echo "⏭  skip $name (not a dir or symlink)"
    skipped=$((skipped+1))
    continue
  fi

  if [ ! -e "$target" ]; then
    echo "⏭  skip $name (target missing: $target)"
    skipped=$((skipped+1))
    continue
  fi

  dest_link="$DEST/$name"
  if [ -L "$dest_link" ]; then
    current="$(readlink "$dest_link")"
    if [ "$current" = "$target" ]; then
      unchanged=$((unchanged+1))
      continue
    fi
    ln -sfn "$target" "$dest_link"
    echo "🔁 refreshed $name"
    refreshed=$((refreshed+1))
  elif [ -e "$dest_link" ]; then
    echo "⚠️  $name exists as non-symlink at destination; leaving alone"
    skipped=$((skipped+1))
  else
    ln -s "$target" "$dest_link"
    echo "➕ added $name"
    added=$((added+1))
  fi
done

# --- Pass 2: prune entries no longer in source (mirror) ---
for entry in "$DEST"/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name="$(basename "$entry")"
  [[ "$name" == .* ]] && continue
  if ! printf '%s' "$keep" | grep -qxF "$name"; then
    if [ -L "$entry" ]; then
      rm "$entry"
      echo "🗑  removed $name (no longer in source)"
      removed=$((removed+1))
    else
      echo "⚠️  $name is not a symlink; not removing"
    fi
  fi
done

echo ""
echo "✅ sync complete: +$added refreshed:$refreshed removed:$removed unchanged:$unchanged skipped:$skipped"
echo "   src:  $SRC"
echo "   dest: $DEST"
