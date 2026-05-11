#!/usr/bin/env bash
# Apply monitor configuration dynamically without Hyprland relaunch.
# Usage: ./apply-monitor-config.sh
# Reads ~/.config/hypr/monitors.conf and applies each monitor line via hyprctl.

set -euo pipefail

CONFIG="${HOME}/.config/hypr/monitors.conf"

if [ ! -f "$CONFIG" ]; then
    echo "ERROR: $CONFIG not found"
    exit 1
fi

echo "Applying monitor config from $CONFIG..."

# Apply each monitor= line
grep -E '^\s*monitor\s*=' "$CONFIG" | while IFS= read -r line; do
    # Extract the value after "monitor = "
    value=$(echo "$line" | sed 's/^\s*monitor\s*=\s*//')
    echo "  -> $value"
    hyprctl keyword monitor "$value"
done

echo ""
echo "Restarting swaybg for wallpaper on all outputs..."
pkill -x swaybg 2>/dev/null || true
sleep 0.3

# Find background image from omarchy config
BG="${HOME}/.config/omarchy/current/background"
if [ -f "$BG" ]; then
    nohup swaybg -i "$BG" -m fill >/dev/null 2>&1 &
else
    echo "WARNING: No background found at $BG"
    echo "Start your wallpaper daemon manually."
fi

echo ""
echo "Done. Run 'hyprctl monitors' to verify."
