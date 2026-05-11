---
pipeline-status:
  - new
---
# Hyprland Dual-Monitor Troubleshooting

## "No Signal" on External Monitor

### Most Common Cause: Wrong Refresh Rate

Before setting any resolution, check `hyprctl monitors` → `availableModes`.
If your desired `resolution@refresh` combo is **not in that list**, the monitor
will show "no signal" — even though Hyprland thinks the output is active.

**Example:** Dell AW3418DW lists `3440x1440@49.99Hz` but **not** `@60`.
Forcing `@60` = instant black screen / no signal.

### Fix

```bash
# Check what the monitor actually supports
hyprctl monitors | grep -A 2 "availableModes"

# Use a supported rate
hyprctl keyword monitor DP-3,3440x1440@49.99,1440x0,1
```

### Second Most Common: DPMS Sleep

```bash
# Wake the monitor
hyprctl dispatch dpms off DP-3
sleep 2
hyprctl dispatch dpms on DP-3
```

### Third: Output Stuck

```bash
# Hard cycle the output
hyprctl keyword monitor DP-3,disable
sleep 1
hyprctl keyword monitor DP-3,3440x1440@49.99,1440x0,1
```

## Monitor Is Active But Appears Blank

- **Workspaces**: Empty workspaces are black in Hyprland. Move a window there:
  `hyprctl dispatch moveworkspacetomonitor 2 eDP-1`
- **Wallpaper**: `swaybg` may not paint new outputs after monitor changes.
  Restart it: `pkill swaybg && swaybg -i ~/.config/omarchy/current/background -m fill &`

## Cursor Disappears Off Edge / Wrong Bounds

- **Negative coordinates** (`-1440x0`) can cause cursor/bounds issues.
- **Fix**: Use **only positive coordinates**.
  - Laptop at `0x0`
  - External at `[laptop_width]x0` (e.g., `1440x0` for 2880px laptop at scale 2)

## Changes Not Applying

- `hyprctl reload` **does** pick up `monitors.conf` if sourced in `hyprland.conf`
- But some changes (like monitor positions) may leave stale state
- **Fix**: Use `scripts/apply-monitor-config.sh` to apply dynamically
- Or add a `monitor = ,preferred,auto,1` fallback rule to catch edge cases

## Laptop Lid Closed = No Signal on External?

- Some laptops disable the GPU output when lid is closed
- **Fix**: Keep lid slightly open, or disable laptop panel in software:
  `monitor = eDP-1,disable`
