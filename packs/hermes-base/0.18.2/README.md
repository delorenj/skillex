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
├── hermes-base-guard.py    # per-skill guard: forbids in-place edits of base skills
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
- **Overlay** (each runtime's local `skills/`): writable, agent-specific. Add
  new skills freely. But an override of a base skill must be a **scoped-name
  copy** (`<name>-<agent>`, dir + frontmatter `name:`), **not** a same-name
  in-place edit: the prompt index would silently shadow the base while
  `skill_view` refuses the collision as "Ambiguous". `hermes-runtime-templatize.py`
  does this scoping automatically; the guard enforces it.

  *Granularity is per-SKILL:* 14 of the 18 base dirs are categories holding
  multiple sub-skills (73 total), and hermes keys identity on each `SKILL.md`
  frontmatter `name:` — so dedup/override/guard all operate on sub-skills, never
  whole category dirs.

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

`hermes-base-guard.py check-tree <runtime>/skills` (exit 1 on violation) fails if
any **active** local skill's frontmatter `name:` matches a pack skill but its
content differs — i.e. a base skill edited in place. It computes the pack's
per-skill baseline dynamically from this dir (no separate manifest), and mirrors
hermes `iter_skill_index_files` (excludes `.archive`/support dirs) so it sees
exactly the skills hermes does. `check-staged` runs the same check over the git
index. Wire it into `skill_ssot.py` (sweep/doctor), a pre-commit hook, and the
`33god-agent-fleet-operations` self-check.
