# hermes-base Pack

Version-pinned, **read-only base skill set** for the 22-agent Hermes PM fleet.
Harvested from `hermes-agent 0.18.2` (`~/.hermes/hermes-agent/skills`). Shared by
every runtime through `config.yaml` → `skills.external_dirs`, exactly like the
existing `bmad/6.10.2` pin.

## Layout

```
packs/hermes-base/0.18.2/
├── pack.toml               # manifest ([pack]/[source]/[freeform]/[promote_candidates]/[policy])
├── README.md               # this file
├── MANIFEST.sha256         # per-skill treehash baseline (the guard's source of truth)
├── hermes-base-guard.sh    # forbids in-place edits of base skills
├── apple/ SKILL.md …       # 18 pristine upstream skill dirs
├── autonomous-ai-agents/
└── … (16 more)
```

The version directory (`0.18.2`) is what agents pin — same shape as
`packs/bmad/6.10.2`. Bumping upstream = a new sibling version dir, never an
in-place edit.

## The base / overlay contract

- **Base** (this pack): the 18 upstream skills, byte-identical to
  `~/.hermes/hermes-agent/skills` minus `index-cache` (a cache artifact, not a
  skill). Read-only. One copy for the whole fleet.
- **Overlay** (each runtime's local `skills/`): writable, agent-specific. The
  local skill **wins** on name collision — an agent may shadow a base skill by
  putting a dir of the same name in its overlay, but it may **not edit the base
  dir in place** (that forks the base invisibly).

## Wire an agent to the pack

In the runtime `config.yaml`:

```yaml
skills:
  external_dirs:
  - /home/delorenj/code/skillex/skill-sets/global/.system
  - /home/delorenj/code/skillex/packs/bmad/6.10.2
  - /home/delorenj/code/skillex/packs/hermes-base/0.18.2   # <-- add
```

Then delete the agent's now-redundant local base copies (see the create-pack
plan, step 4) so they resolve from the pack.

## Promote candidates (not yet shipped)

Seven dirs are byte-identical shared additions across every agent that has them
but are **not** upstream: `diagramming`, `domain`, `gaming`, `gifs`,
`inference-sh`, `mcp`, `red-teaming`. They are listed in `[promote_candidates]`
and staged for a future `0.18.2+build.1` after curator review. Keeping them out
of `[freeform].skills` keeps this pack a verifiable mirror of upstream.

## Guard

`hermes-base-guard.sh check-tree <runtime>/skills` fails if any base-named dir in
a runtime overlay diverges from `MANIFEST.sha256`. Wire it into `skill_ssot.py`
(sweep/doctor), a pre-commit hook, and the fleet self-check.
