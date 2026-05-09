---
name: site-{{domain-slug}}
description: >
  Graduated browser-automation skill for {{domain}}. Encodes the
  converged path for: {{task-description}}. Iterations to converge:
  {{iteration_count}}. Discovered: {{discovery_date}}. Replace this
  description with the actual converged task scope before commit.
auth_required: {{true|false}}
rate_limit: "{{e.g. 60/min observed; back off above}}"
tos_url: "{{https://example.com/terms}}"
fastest_path: "{{api|dom|hybrid}}"
---

# site-{{domain-slug}}

## Task scope

What this skill does, in one sentence the next agent reads first.

> Example: "Scrape all open listings in a Craigslist category as
> structured records: title, price, posted_at, url, image_urls."

## Preflight checks (run before trusting this skill)

The replay skill runs these in order; any failure → fall through to the
discover skill.

1. **Page reachable.** `GET {{landing_url}}` returns 200 within 10s.
2. **Marker present.** Selector `{{marker_selector}}` resolves on the
   landing page (proves layout is recognizable).
3. **Endpoint shape stable** (if `fastest_path = api`). `GET {{endpoint}}`
   returns JSON matching `{{json_shape_summary}}`.
4. **Auth alive** (if `auth_required = true`). The session cookie/token
   is present and not expired.

## Fastest-known path

The converged route the agent should attempt first.

```
{{step-by-step instructions in the language of the chosen tool —
playwright, puppeteer, fetch, etc. Be concrete about waits, selectors,
and what success looks like at each step.}}
```

### Why this path

One paragraph on *why* the loop converged here, not on the alternatives
tried. Example: "The /api/v1/listings endpoint returns the same data
the DOM does, paginated server-side, with no auth. One request replaces
28 page loads."

## Fallback path (one tier)

If the fastest path fails preflight or returns unexpected shape, run
this. Two fallbacks is one too many — past two, re-graduate.

```
{{the second-best path the loop converged on, typically DOM-based with
stable semantic selectors.}}
```

## Selectors / endpoints registry

| Surface | Locator | Stability notes |
|---|---|---|
| Listing container | `{{role=list}}` or `[data-testid="..."]` | Renamed 2024-Q3 from `.posts`; semantic role is stable. |
| Pagination next | `{{...}}` | — |
| Hidden listings API | `GET /api/v1/...` | Discovered by net-sleuth iter 3; no auth, returns JSON. |
| Detail-page main | `{{...}}` | — |

## Known failure modes

Things the discovery loop hit during graduation, with the response that
made them go away. The next agent reads these *before* trying anything.

- **Symptom:** {{e.g. "redirects to /login"}}.
  **Cause:** {{e.g. "session cookie expired"}}.
  **Response:** {{e.g. "abort and surface auth handoff to user"}}.
- **Symptom:** ... **Cause:** ... **Response:** ...

## Cost / time baseline

Captured at graduation. Replay should beat these. If a replay run blows
past these by >2x → drift suspected, trigger preflight re-check.

| Metric | Discovery (iter 1) | Graduated baseline | Notes |
|---|---|---|---|
| Wall seconds | {{N}} | {{M}} | Per-run, not per-record. |
| Tokens in/out | {{N}} | {{M}} | Replay should be near-zero discovery cost. |
| Iterations | {{1..5}} | 0 | Replay loads, validates, executes. |

## Re-graduation triggers

When replay should hand off to discover instead of just running.

- Preflight check fails twice consecutively.
- Wall time exceeds graduated baseline × 2.
- Output schema mismatch on > 5% of records.
- A selector in the registry returns 0 nodes on a non-empty page.

## Provenance

| | |
|---|---|
| Discovered by | autobrowse-discover, {{date}} |
| Graduated by | autobrowse-graduate, {{date}} |
| Iterations | {{1..5}} |
| HAR trace | `discoveries/{{date}}-iter{{N}}.har` |
| Discovery report | `discoveries/{{date}}-iter{{N}}.md` |
| Browser tool | {{playwright|puppeteer|browserbase|...}} |
