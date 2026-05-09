---
name: autobrowse-discover
description: >
  Failure-driven exploration loop for browser tasks on a site that has no
  graduated skill yet. Runs the same task 3–5 times against the live site,
  treating each failure as signal: parses the error, updates the plan,
  retries with a different approach. Captures DOM snapshots, network
  traces, and structured failure analysis on every iteration so the next
  phase (graduate) has enough material to write a durable site SKILL.md.
  Hard caps iterations at 5 — past that, escalates instead of looping.
  Use when a user asks to scrape/automate a site for the first time, when
  no `site-skills/<domain>/SKILL.md` exists, or when replay's drift
  detection has invalidated an existing skill and a re-graduation is
  needed. Do NOT use when a graduated skill already exists and is healthy
  — load `autobrowse-replay` instead.
---

# autobrowse-discover

## Purpose

Pay the discovery tax once, with full instrumentation, so the lesson is
salvageable. A run that succeeds on iteration 1 with no notes is *worse*
than a run that fails three times and produces a clean failure taxonomy —
the failures are what make the eventual SKILL.md robust.

## Inputs

- **`task`** (required): natural-language task description. Must include
  success criteria the agent can self-verify (e.g. "list of ≥10 records,
  each with title and price").
- **`url`** (required): canonical entry point.
- **`auth`** (optional): credentials or session bootstrap instructions.
  If the site requires auth, the loop captures the post-auth state but
  never logs the secret material.
- **`tool`** (optional, default playwright): browser automation tool.
  The discovery loop is tool-agnostic; the graduated skill records
  whichever one was used.

## The iteration loop

Hard cap: **5 rounds.** Each round produces one trace file, one HAR, and
one failure-or-success report.

```
round = 1
while round ≤ 5:
    plan ← propose plan(task, accumulated_findings)
    trace ← execute(plan, capture=[dom, network, console])
    save trace as discoveries/<date>-iter<round>.{json,har}
    result ← evaluate(trace, success_criteria)

    if result.success:
        save discoveries/<date>-iter<round>.md as SUCCESS report
        if round ≥ 2 OR confidence ≥ 0.9:
            break  # converged
        # else: re-run once more to confirm reproducibility

    else:
        diagnosis ← classify_failure(trace)
        save discoveries/<date>-iter<round>.md as FAILURE report
        accumulated_findings.add(diagnosis, what-not-to-try-again)
        round += 1

if round > 5:
    escalate(accumulated_findings)  # do NOT loop further
```

`references/iteration-loop.md` has the full protocol, including the
convergence rule (≥2 successful iterations before graduation, OR one
success with explicitly-listed reasons it's reproducible).

## Failure taxonomy

Every failed iteration must be classified. Free-text "it didn't work" is
not allowed — that's the signal that gets lost on every other browser
agent. See `references/failure-taxonomy.md` for the eight canonical
categories. Common ones:

- **Selector-not-found.** Element isn't on the page or has been renamed.
  Response: switch to a higher-stability locator (role > test-id > class).
- **Timing.** Action ran before the relevant DOM was hydrated.
  Response: add a wait-for predicate, not a `sleep`.
- **Auth-wall.** Got redirected to login. Response: surface to user;
  do not retry against the auth wall.
- **Rate-limited / 429.** Back off; record the limit; do not retry tight.
- **Hidden-API-better.** DOM works but network capture shows a JSON
  endpoint that returns the same data. Response: hand off to net-sleuth
  for a follow-up iteration *as a different path*, not as a retry.
- **Layout-changed.** Selector exists but content shape moved.
  Response: re-anchor on a stable semantic landmark.
- **Bot-detection.** CAPTCHA, fingerprint challenge. Response: surface
  to user; do not try to evade.
- **Task-impossible.** The task as stated cannot be done from this
  surface (e.g., data isn't on the page at all). Response: escalate
  with the gap clearly stated.

## Outputs

For task `T` on domain `D`, on date `Y`:

```
site-skills/<D>/discoveries/
├── <Y>-iter1.json    # full plan + actions + results, structured
├── <Y>-iter1.har     # network capture (HAR 1.2)
├── <Y>-iter1.md      # human-readable report (failure or success)
├── <Y>-iter2.{json,har,md}
├── ...
└── <Y>-summary.md    # convergence summary, one paragraph + iteration table
```

The summary is what `autobrowse-graduate` reads first. It's a small file
on purpose — graduate's job is to compress this into a durable SKILL.md.

The `<Y>-iter*.md` files use the template at
`templates/discovery-report.template.md`.

## Network capture is mandatory

Even when the task succeeds via DOM on iteration 1, capture the HAR. The
graduation step uses it to look for stable JSON endpoints (see
`autobrowse-net-sleuth`); without it, you're locked into the brittlest
path the agent first found.

## Cost telemetry

Record on every iteration:

```json
{
  "iteration": 3,
  "tokens_in": 12400, "tokens_out": 1800,
  "wall_seconds": 71,
  "browser_actions": 24,
  "network_requests": 87,
  "outcome": "success" | "failure",
  "failure_class": "selector-not-found" | null,
  "next_action": "retry-with-role-locator" | "graduate" | "escalate"
}
```

These numbers are how the graduated skill proves its value — replay
should beat them by 5–10x.

## Hand-offs

- **→ autobrowse-graduate** when the loop converges (≥2 successful runs
  or 1 success + explicit reproducibility argument).
- **→ autobrowse-net-sleuth** mid-loop when the HAR shows a candidate
  endpoint worth a dedicated iteration.
- **→ user (escalation)** when round 5 ends without convergence,
  auth-wall hits without supplied credentials, or bot-detection trips.

## Guardrails

- Never iterate past round 5. The whole point is to *cap* the discovery
  tax, not pay it forever.
- Never retry tight against an explicit rate-limit. Honor `Retry-After`,
  back off, and record the rate for the graduated skill.
- Never submit forms, post content, or trigger purchases/billing flows
  during discovery without explicit user confirmation. Discovery is
  read-mostly by default.
- Never store credentials in the discovery report. Reference an env var
  or vault key by name only.
