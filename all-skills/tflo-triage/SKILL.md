---
name: tflo-triage
description: Triage workflow for the tflo (Intelliforia Trello Flow) module. Score open Trello cards on the Intelliforia board and claim the top-scoring one, transitioning the FSM from idle to implementing. The actual scoring + claim mutation logic lives in scripts/trello.py; this SKILL describes how the orchestrator invokes it and routes the outcome.
---

# tflo-triage — Pick the next ticket

## Overview

Workflow that scores open cards on the Intelliforia Trello board (https://trello.com/b/jLl1NE0Z/intelforia) and claims the top one. On claim it moves the card to `In-Progress`, creates a git branch, writes the FSM state to `_bmad/memory/tflo/current-ticket.md`, and hands control back to the orchestrator with the ticket loaded in `implementing` phase.

The actual scoring + claim logic lives in `scripts/trello.py`. This SKILL.md tells the orchestrator (the running Claude context) how to invoke it and what to do with the output.

## Preconditions

- `_bmad/memory/tflo/current-ticket.md` does NOT exist (or shows `phase: idle`). If a ticket is active, abort or resume first via the orchestrator.
- `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID` env vars are set (already exported from `~/.config/zshyzsh/secrets.zsh`).
- We're in the intelliforia repo and on a sane base branch (e.g. `main` or `staging` — not on a stale ticket branch).

## Capabilities

### Dry-run (default for safety)

Show ranked top-N candidates without claiming.

```bash
mise run tflo:dry-run
```

Output: markdown table with rank, total score, card name, list rank, and the per-component breakdown (position / Pri / Bug / Free / Mine).

Use when:
- The user asks "what should I work on next?"
- You want to validate scoring before claiming
- The user is browsing the backlog

### Claim the top card

Score the source list, move the top card from `To-Do` to `In-Progress`, create branch, write memory, comment on Trello.

Preview (no mutations):
```bash
uv run python scripts/trello.py claim
```

Execute (real mutations):
```bash
uv run python scripts/trello.py claim --yes
```

Output on success:
```
✓ Claimed [N] '<card name>'
  Branch:  <idShort>-<kebab-name> (checked out)
  Memory:  <path to current-ticket.md>
```

After successful claim, FSM is at `implementing`. Hand off to `tflo-implement`.

### Manual pick (specific card)

Not yet implemented as a CLI flag. Workaround: ask the user to drag their preferred card to position #1 in `To-Do`, then re-run `claim`. Position dominates scoring, so #1 always wins.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `current-ticket.md exists at <path>` | A previous ticket is in flight | Run `tflo abort` first, or invoke orchestrator's `resume` capability |
| `List not found on board: 'To-Do'` | Board structure changed | Re-run `mise run tflo:list-lists`, update config defaults |
| `Missing required env var: TRELLO_*` | Creds missing | Source `~/.config/zshyzsh/secrets.zsh` or set env vars manually |
| HTTP 401 / 403 from Trello | Token expired or revoked | Regenerate Trello token, update env |
| HTTP 5xx | Trello transient | Retry. If persistent, surface to human. |

## Inputs

- (none) for default dry-run
- `--source-list NAME` to score a different list
- `--target-list NAME` to claim into a different list
- `--yes` to execute mutations

## Outputs

- Updated `_bmad/memory/tflo/current-ticket.md` (FSM source of truth, includes `previous_list` and `claimed_from_branch` for abort reversibility)
- New git branch checked out (`<idShort>-<kebab-name>`, capped at 60 chars)
- Comment posted on the Trello card
- Append to `_bmad/memory/tflo/tickets/<idShort>/transitions.jsonl`

## Handoff

After successful claim, the orchestrator should invoke `tflo-implement` next. The current-ticket.md file is the source of truth for what to implement.

## Related

- Reverse this transition with `python scripts/trello.py abort --yes`
- See orchestrator: `tflo-agent-orchestrator`
- Module plan: `_bmad-output/planning-artifacts/module-plan-trello-lifecycle-2026-05-06.md`
