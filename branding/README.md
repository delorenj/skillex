# Skillex branding

`skillex-mark.svg` is the canonical Skillex mark: a hexagon hub with an amber core and three spokes to its vertices: one skill root fanned out to every agent. Picked by Jarad on 2026-10-19 from three drafts (HOLOC-15).

It is the avatar of `skillex-pm` on the Holocene Agent Pad, set through Holocene's avatar setter (holocene.delo.sh/settings).
To change it, edit the SVG here, render a square JPEG with the `hermes-project-avatar` skill's converter and upload it there:

```bash
python3 ~/.agents/skills/hermes-project-avatar/scripts/telegram_avatar.py convert \
  --svg branding/skillex-mark.svg --out /tmp/skillex-avatar.jpg --pad 6
curl -X PUT -H 'Content-Type: image/jpeg' --data-binary @/tmp/skillex-avatar.jpg \
  http://127.0.0.1:4000/api/modules/avatars/<agent-id>
```
