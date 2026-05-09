# Skillex

CLI-agnostic skill package manager. One pack declaration, identical capability delivery across every agentic CLI you use (Claude, Codex, OpenCode, with more on the way).

**Status:** MVP in progress. See `docs/prd/skillex-mvp.md` and `docs/plan/skillex-mvp-plan.md`.

## Experimental: BMAD HTML Workspace Skill

This repo now includes an experimental skill scaffold at `skills/bmad-html-workspace/` for teams that want a single-file HTML "project cockpit" instead of fragmented Markdown outputs.

Start with:
- `skills/bmad-html-workspace/SKILL.md`
- `skills/bmad-html-workspace/references/app-model.md`
- `skills/bmad-html-workspace/templates/workspace.template.html`

## Experimental: Autobrowse Skill Set

Skill set at `skill-sets/autobrowse/` adapting Browserbase's Autobrowse loop to skillex: a browser agent runs a real task, iterates 3–5 rounds against failures, then graduates the converged path into a per-site `SKILL.md` that future agents load before they start. The markdown file is the memory.

Four child skills cover the lifecycle:
- `autobrowse-discover/` — failure-driven exploration loop (capped at 5 iterations)
- `autobrowse-graduate/` — distill discovery into a portable site `SKILL.md`
- `autobrowse-replay/` — execute the graduated skill, detect drift, hand back to discover when needed
- `autobrowse-net-sleuth/` — find hidden JSON endpoints buried in network traffic

Start with the hub at `skill-sets/autobrowse/SKILL.md` and the shared site-skill template at `skill-sets/autobrowse/references/site-skill.template.md`.
