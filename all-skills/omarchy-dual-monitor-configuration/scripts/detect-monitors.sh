#!/usr/bin/env bash
# Detect current Hyprland monitors and output key diagnostic info.
# Run on Omarchy/Hyprland systems.

set -euo pipefail

echo "=== Hyprland Monitor Detection ==="
echo ""

if ! command -v hyprctl &>/dev/null; then
    echo "ERROR: hyprctl not found. Are you running Hyprland?"
    exit 1
fi

# Get full monitor dump
MONITORS=$(hyprctl monitors)

echo "--- Connected Monitors ---"
echo "$MONITORS" | grep -E "^Monitor" | while read -r line; do
    name=$(echo "$line" | awk '{print $2}')
    echo "  $name"
done

echo ""
echo "--- Per-Monitor Details ---"
echo "$MONITORS" | awk '
/^Monitor/ {
    name=$2
    getline; print "  " name ": " $0
    getline; print "    " $0
    getline; print "    " $0
}
' | head -40

echo ""
echo "--- Available Refresh Rates (CRITICAL) ---"
echo "$MONITORS" | grep -A 2 "availableModes" | grep -v "^--$"

echo ""
echo "--- DRM Connector Status ---"
for f in /sys/class/drm/card*-*/status; do
    conn=$(basename "$(dirname "$f")")
    status=$(cat "$f")
    if [ "$status" = "connected" ]; then
        echo "  $conn: $status"
    fi
done

echo ""
echo "--- Suggested Config (template) ---"
echo "# Paste into ~/.config/hypr/monitors.conf"
echo "# ALWAYS verify availableModes before setting refresh rate!"
echo ""

echo "$MONITORS" | awk '
/^Monitor/ {
    name=$2
    getline
    match($0, /([0-9]+)x([0-9]+)@([0-9.]+)/, arr)
    res=arr[1]"x"arr[2]
    hz=arr[3]
    match($0, /at ([-0-9]+)x([-0-9]+)/, pos)
    match($0, /scale: ([0-9.]+)/, sc)
    scale=sc[1]
    if (scale == "") scale="1"
    print "monitor = " name ", " res "@" hz ", " pos[1] "x" pos[2] ", " scale
}
'
