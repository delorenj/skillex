---
name: omarchy-dual-monitor-configuration
description: Configure and troubleshoot dual-monitor setups on Omarchy Linux (Hyprland). Use when the user needs to set up an external monitor as primary, position displays (left/right), fix "no signal", blank screens, cursor bounds issues, or apply monitor layout changes without relaunching Hyprland. Covers Hyprland monitor config, swaybg wallpaper daemon, positive-coordinate layouts, EDID refresh rate validation, and dynamic config application via hyprctl.
pipeline-status:
  - new
---

# Omarchy Dual-Monitor Configuration

Configure and troubleshoot dual-monitor setups on Omarchy (Hyprland) without needing a full session relaunch.

## Quick Reference

| Problem | Quick Fix |
|---------|-----------|
| External shows "no signal" | Check `availableModes` in `hyprctl monitors` — use a listed refresh rate |
| Monitor active but blank | Restart `swaybg`; check workspace isn't empty |
| Cursor drifts off edge | Switch to **positive coordinates only** |
| Changes not applying | Use `scripts/apply-monitor-config.sh` |
| Need to detect layout | Run `scripts/detect-monitors.sh` |

## Core Principles

1. **Always validate refresh rates** against `hyprctl monitors` → `availableModes`
2. **Use positive coordinates only** — avoid negative `x` positions
3. **Restart swaybg** after any monitor topology change
4. **Apply dynamically** with `hyprctl keyword monitor` instead of requiring relaunch

## Detect Current State

```bash
# Run the bundled script
./scripts/detect-monitors.sh

# Or manually:
hyprctl monitors          # Full monitor dump
hyprctl workspaces        # Which workspaces are on which monitor
hyprctl clients           # Window positions and sizes
```

## Apply Config Without Relaunch

```bash
# Edit ~/.config/hypr/monitors.conf, then apply dynamically:
./scripts/apply-monitor-config.sh
```

This script:
1. Reads each `monitor =` line from `monitors.conf`
2. Applies via `hyprctl keyword monitor`
3. Kills and restarts `swaybg` so wallpaper paints on all outputs

## Common Layouts

### Laptop Left, External Right (Recommended)

```ini
monitor = eDP-1, 2880x1920@120, 0x0, 2
monitor = DP-3, 3440x1440@49.99, 1440x0, 1
env = GDK_SCALE,1
```

- Laptop at origin (`0x0`)
- External offset by laptop's effective width (`2880 / 2 = 1440`)
- Both coordinates positive — no cursor bounds issues

### External Only (Disable Laptop)

```ini
monitor = DP-3, 3440x1440@49.99, 0x0, 1
monitor = eDP-1, disable
env = GDK_SCALE,1
```

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for detailed diagnosis of:
- "No signal" on external monitor
- Active but blank display
- Cursor bounds problems
- Changes not persisting
- Laptop lid-closed behavior

## Known Monitor Quirks

See [references/known-monitors.md](references/known-monitors.md) for EDID-validated configs for specific panels.

Current entries:
- **Dell AW3418DW**: 3440x1440 @ **49.99Hz only** (not 60Hz)
- **BOE NE135A1M-NY1** (Surface laptop panel): 2880x1920 @ 120Hz, scale 2.0

## Template

Copy [assets/monitors.conf.template](assets/monitors.conf.template) to `~/.config/hypr/monitors.conf` as a starting point.
