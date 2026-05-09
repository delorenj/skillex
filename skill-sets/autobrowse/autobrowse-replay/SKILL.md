---
name: autobrowse-replay
description: >
  Execute a graduated site SKILL.md against a fresh task on the same
  site, skipping discovery entirely. Loads the cached plan, runs
  cheap preflight checks first, executes the chosen path with
  per-step expect-predicate validation, and records cost telemetry
  so drift becomes visible. On preflight failure or mid-run drift
  signal, hands back to autobrowse-discover for re-graduation rather
  than silently degrading. This is where the savings show up — a
  healthy replay should beat the discovery-iteration-1 cost by 5–10x.
  Use whenever a site already has a graduated SKILL.md and a user
  wants to run a task on it. Do NOT use to "try out" a brand-new
  site — that's discover.
---

# autobrowse-replay

## Purpose

The whole point of the loop. Discovery is the cost; graduation is the
storage; replay is the payoff. Every replay run that completes via
the cached plan is a discovery tax not paid.

## Inputs

- **`site_skill`** (required): path to a graduated `site-skills/<domain>/SKILL.md`.
- **`task`** (optional): if the graduated skill's task scope already
  matches what the user wants, no override is needed. If the user
  wants a *different* task on the same site, replay refuses and
  hands off to discover with the new task.
- **`auth`** (optional, required if `auth_required: true` in the
  skill frontmatter).

## The replay algorithm

```
skill ← load(site_skill)
verify(skill.frontmatter)                 # required fields present
verify(task matches skill.task_scope)     # else hand off to discover

preflight ← run_preflight(skill.preflight_checks)
if preflight.failed:
    record_drift(preflight.failures)
    handoff_to(discover, reason="preflight_failed")
    return

trace ← execute(skill.fastest_path, validate_each_step=true)
if trace.failed_at_step S:
    if S has fallback in skill.fallback_path:
        trace ← execute(skill.fallback_path, validate_each_step=true)
        if trace.failed:
            handoff_to(discover, reason="both_paths_failed")
            return
    else:
        handoff_to(discover, reason="primary_failed_no_fallback")
        return

record_run_telemetry(trace)
check_drift(trace, skill.baseline)
return trace.output
```

## Preflight checks

`references/validation-checks.md` is the canonical guide. The short
version: each check from the SKILL.md `Preflight checks` section
runs in order, all must pass, total preflight budget ≤ 10 seconds.
Fail fast.

Replay treats preflight as the *contract* between graduation and
itself. If a check passes but the run still fails, the contract was
under-specified — graduate's responsibility, not replay's.

## Per-step validation

Every step in the cached plan has an `expect` predicate (graduate
refuses to write a SKILL.md without one). Replay runs the predicate
after each action; failure → halt, classify, decide.

The classification mirrors discover's failure taxonomy. The decision
table:

| Failure class on a replay step | Decision |
|---|---|
| `selector-not-found` | Try fallback path. If no fallback or fallback also fails → discover. |
| `timing` | One retry with raised wait specificity. Past one → discover. |
| `auth-wall` | Halt, escalate. Auth state is upstream of replay. |
| `rate-limited` | Honor `Retry-After`. Once. Past once → escalate. |
| `hidden-api-better` | Don't act on it during replay; record as a re-graduation candidate. |
| `layout-changed` | → discover. The skill is mis-anchored. |
| `bot-detection` | Halt, escalate. |
| `task-impossible` | Halt, escalate — the skill is wrong about the surface. |

## Drift detection

Three drift signals replay watches for. Any one trips re-graduation;
two together raise the urgency.

1. **Preflight check failed.** Most direct. Defined per-skill.
2. **Cost overshoot.** Wall time > baseline × 2, or token count >
   baseline × 3. Captured for free since replay records telemetry
   already.
3. **Output schema mismatch.** ≥ 5% of records fail the type check
   defined by the skill (e.g., `price` must parse as currency).

`references/drift-detection.md` covers the heuristics in detail,
including how to distinguish drift from a one-off site hiccup.

## Hand-off to discover

When replay decides the cached path is no longer valid, it does *not*
silently fall back to a fresh discovery. It:

1. Writes a drift report to `site-skills/<domain>/runs/<date>-drift.md`
   with the specific signals that tripped.
2. Notifies the user. Re-graduation is non-trivial; the user may want
   to schedule it or supply hints.
3. On user approval, calls `autobrowse-discover` with the original
   task and the drift report attached as additional context (so the
   loop knows what the prior selectors were and can re-anchor faster).
4. After discovery converges and graduate writes the new SKILL.md,
   replay re-runs the user's task against the new skill.

## Telemetry — every run

Replay writes one record per run to `site-skills/<domain>/runs/<date>-<id>.json`:

```json
{
  "site_skill_version": "<git sha or content hash>",
  "task": "<task description>",
  "outcome": "success" | "drift" | "escalated",
  "wall_seconds": 27.3,
  "tokens_in": 1900,
  "tokens_out": 220,
  "browser_actions": 3,
  "network_requests": 5,
  "preflight_passed": true,
  "fallback_used": false,
  "drift_signals": [],
  "baseline_delta": { "wall_pct": -62, "tokens_pct": -84 }
}
```

The `baseline_delta` is the metric that *proves the skill is paying
back*. Negative percentages = savings vs. graduation-day baseline.

## Idempotency

Replay is read-mostly by default. Side-effecting steps (form submits,
purchases, message sends) require the SKILL.md to mark them
`destructive: true`, and replay refuses to run them without an
explicit `--allow-destructive` flag. This is the same posture as
discover.

## What replay does NOT do

- Reinterpret the task. If the user's task is even slightly different
  from the graduated scope, hand off — don't improvise.
- Modify the SKILL.md. Re-graduation is graduate's job; replay only
  reports drift.
- Try to "heal" selectors on the fly. A site that needs healing needs
  a re-graduation. Tactical patches accumulate into a skill that
  silently lies.
- Iterate. Replay is single-shot per task (with one fallback tier).
  Iteration is discover's job.
