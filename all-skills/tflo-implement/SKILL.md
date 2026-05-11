---
name: tflo-implement
description: Implementation workflow for the tflo (Intelliforia Trello Flow) module. Routes the active ticket through the appropriate subagent chain based on its detected type (code/bug/feature/refactor/discovery/design/doc), produces the deliverable artifacts (architect plan, test plan, dev story, code commits OR analysis doc OR design doc), and transitions the FSM from implementing to verifying. The type field in current-ticket.md determines which chain runs.
---

# tflo-implement — Build the deliverable for the active ticket

## Overview

Routes the active ticket through a type-aware subagent chain and produces the deliverable artifacts. For code-shaped tickets that means: research → architect plan → test plan → dev story → commits. For non-code tickets (discovery, design, doc) the chain skips test/code generation and produces a different artifact.

All subagent invocations originate from this skill (the orchestrator runs the Skill / Agent tools). Subagent outputs land in `_bmad/memory/tflo/tickets/{idShort}/`.

## Preconditions

- `_bmad/memory/tflo/current-ticket.md` exists with `phase: implementing`
- Branch in current-ticket.md is checked out (`git rev-parse --abbrev-ref HEAD` matches `branch`)
- `type` field is populated (set at claim by detect_ticket_type)

If preconditions fail, abort or fix manually. Don't silently re-detect type — it would diverge from the recorded value.

## Type-routing matrix

| Type | Chain | Deliverable | Branch lands code? |
|---|---|---|---|
| `code`, `feature` | architect → tea → create-story → dev-story | commits + story.md + plans | yes |
| `bug` | architect (root-cause) → tea (regression test required) → create-story → dev-story | commits including failing-then-passing regression test + story.md | yes |
| `refactor` | architect (scope assessment) → dev-story (no behavior change) | commits + brief story.md (no AC change) | yes |
| `discovery` | architect (synthesis) → produce deliverable | `tickets/{id}/deliverable.md` (markdown analysis/recommendations doc) | no |
| `design` | bmad-bmm-ux-designer.agent → produce design | `tickets/{id}/design.md` (or excalidraw via bmad-bmm-create-excalidraw-*) | no |
| `doc` | bmad-bmm-tech-writer-tech-writer.agent → produce doc in `docs/` | new file in `docs/<area>/<title>.md` | yes (commit the doc) |

## Capabilities

### Research (all types except trivial bugs)

Read the card description, scan related code paths, surface relevant files. Save findings to `_bmad/memory/tflo/tickets/{idShort}/research.md`.

For code-typed tickets: grep for symbols mentioned in the card name; read tests in the affected area; check git log for recent activity. For discovery/design: read the user-facing context (UI screens, related Trello cards). For doc: locate the existing docs the new content should live near.

### Architect consult (all types)

Invoke the architect subagent with this brief:

```
You are reviewing ticket [idShort]: <name>
Type: <type>
Description: <card.desc>
Research findings: <research.md path>
Prior verify failure (if cycle ≥ 2): <verify-log.md last entry, structured>

Produce a plan with:
- Goal restated in 1 sentence
- Approach (numbered steps)
- Alternatives considered (and why rejected)
- Risks / non-obvious considerations
- For non-code tickets: success criteria for the deliverable artifact (no AC checklist)

Write to tickets/{idShort}/architect-plan.md.
```

Subagent: `bmad-bmm-architect.agent` (Winston). Falls back to general-purpose if the BMAD agent isn't installed.

### Test engineer consult (code/feature/bug only)

Skip for refactor (tests already exist; just must keep passing), discovery, design, doc.

Invoke `bmad-bmm-tea.agent` (Murat) with this brief:

```
You are designing tests for ticket [idShort]: <name>
Type: <type>
Architect plan: <architect-plan.md path>

Produce a test plan with:
- Unit tests (function/class level)
- Integration tests (component boundaries)
- E2E / smoke tests if user-facing
- For bugs: a regression test that fails on current main and passes after the fix
- Coverage targets (if measurable)

Write to tickets/{idShort}/test-plan.md.
```

### Story creation (code/feature/bug/refactor/doc)

Invoke `bmad-bmm-create-story` with the architect plan + test plan as input. Output is a BMAD-format story at `tickets/{idShort}/story.md` with explicit acceptance criteria.

For discovery and design: skip story creation. The deliverable doc IS the story.

### Implement / produce deliverable

Type-routed:
- **code/feature/bug/refactor**: invoke `bmad-bmm-dev-story` with the story file. Commits land on the active ticket branch.
- **discovery**: invoke architect (or general-purpose Agent with analyst persona) to write the deliverable doc to `tickets/{idShort}/deliverable.md`. Optionally commit the doc to the ticket branch so it ships with the PR.
- **design**: invoke `bmad-bmm-ux-designer.agent` to produce design doc / mockup. Optionally use `bmad-bmm-create-excalidraw-wireframe` for visuals.
- **doc**: invoke `bmad-bmm-tech-writer-tech-writer.agent` to write the documentation file in `docs/<area>/<title>.md`. Commit the file to the ticket branch.

### Hand off to verify

Update `current-ticket.md` to `phase: verifying`. Append transition. Invoke `tflo-verify`.

## Retry behavior (cycle 2 or 3)

If the orchestrator re-enters this skill because verify failed and `retry_count < 3`:

1. Read the last entry in `verify-log.md`
2. Feed the structured failure context into the architect consult: "Cycle {N} of 3. Previous verify failed on: {failed_tests}, {failed_ac}, {lint_errors}. Refine the plan."
3. Architect produces a refined plan (overwrites `architect-plan.md` with a new section)
4. Re-run the appropriate subagent chain from architect onwards
5. Increment `retry_count` in current-ticket.md

If `retry_count` would exceed 3, escalate to human instead of re-running.

## Failure modes

| Symptom | Action |
|---|---|
| Architect returns "ticket as written cannot be done" | Escalate. Write `tickets/{id}/escalation.md` with the architect's reasoning. Don't proceed. |
| Test engineer and architect disagree on approach | Surface both opinions to user. Pause. |
| dev-story produces commits that don't match story AC | Pause. Don't auto-transition. |
| Subagent invocation errors out | Retry once. If still failing, escalate. |
| Doc/design subagent unavailable | Fall back to general-purpose Agent with appropriate persona prompt. Logged warning. |

## Inputs

- `_bmad/memory/tflo/current-ticket.md` (active ticket)
- `_bmad/memory/tflo/verify-log.md` (if retry)

## Outputs

- `_bmad/memory/tflo/tickets/{id}/research.md`
- `_bmad/memory/tflo/tickets/{id}/architect-plan.md`
- `_bmad/memory/tflo/tickets/{id}/test-plan.md` (code/feature/bug only)
- `_bmad/memory/tflo/tickets/{id}/story.md` (code/feature/bug/refactor/doc)
- `_bmad/memory/tflo/tickets/{id}/deliverable.md` (discovery only)
- `_bmad/memory/tflo/tickets/{id}/design.md` (design only)
- For doc-typed tickets: a new file under `docs/`
- Commits on the ticket branch (code-typed only)
- Updated `current-ticket.md` with `phase: verifying`
- Comment on the Trello card summarizing what was implemented

## Handoff

After successful implement, the orchestrator invokes `tflo-verify`.
