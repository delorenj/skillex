---
pipeline-status:
  - new
---
# Known Monitor Quirks (Omarchy/Hyprland)

## Dell AW3418DW
- **Native res**: 3440x1440
- **Refresh**: **49.99Hz only** at native (EDID does not list 60Hz)
- **Scale**: 1.0
- **Connector**: DisplayPort
- **Quirk**: Forcing 60Hz = "no signal"
- **Working config**:
  ```ini
  monitor = DP-3, 3440x1440@49.99, 1440x0, 1
  ```

## BOE NE135A1M-NY1 (Microsoft Surface Laptop Panel)
- **Native res**: 2880x1920
- **Refresh**: 120Hz
- **Scale**: 2.0 (HiDPI)
- **Connector**: eDP (internal)
- **Working config**:
  ```ini
  monitor = eDP-1, 2880x1920@120, 0x0, 2
  ```

## General Rules
- Always check `hyprctl monitors | grep availableModes` before committing to a refresh rate
- If a monitor supports VRR/FreeSync, the advertised rates may differ from EDID
- USB-C/DP alt-mode docks sometimes limit refresh rates below what the panel supports
