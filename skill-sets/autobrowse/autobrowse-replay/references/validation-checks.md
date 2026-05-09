# Preflight validation checks

Preflight is the cheapest possible "is the world we graduated against
still the world we're looking at?" sanity check. It runs *before*
replay commits to a full task execution.

## Budget

- **Total preflight wall budget:** 10 seconds. If preflight can't
  decide in 10 seconds, the checks are too expensive — re-graduate
  with cheaper ones.
- **Per-check budget:** 2 seconds.
- **Network requests:** ≤ 3 total.

If preflight ever exceeds these, the SKILL.md is over-specified and
replay reports it as a graduation defect.

## Check tiers (cheapest first)

Replay runs the checks in this order, halts on first failure.

### Tier 1 — Reachability

```yaml
- name: landing-200
  type: http
  url: "{{landing_url}}"
  expect: { status: 200, max_seconds: 5 }
```

If this fails, the site is down or DNS-broken — not a drift signal,
just an outage. Replay reports it, retries once after 30s, then
halts.

### Tier 2 — Marker presence

```yaml
- name: marker-selector
  type: dom
  url: "{{landing_url}}"
  selector: "{{marker_selector}}"   # set at graduation, e.g. role=main
  expect: { resolves: true }
```

If the marker is gone, the page layout has changed enough that the
graduated skill is suspect. → drift.

### Tier 3 — Endpoint shape

Only if `fastest_path: api`.

```yaml
- name: endpoint-shape
  type: http
  url: "{{endpoint}}"
  expect:
    status: 200
    json_keys_include: ["{{key1}}", "{{key2}}"]
    max_seconds: 3
```

If the endpoint moved or its shape changed → drift, almost certainly
re-graduate.

### Tier 4 — Auth liveness

Only if `auth_required: true`.

```yaml
- name: auth-alive
  type: http
  url: "{{auth_check_url}}"
  expect: { status: 200, body_excludes: ["sign in", "log in"] }
```

If auth is dead, that's not drift — it's a credential refresh task.
Replay halts and asks the user.

### Tier 5 — Rate-limit baseline (optional)

If the graduated skill recorded a rate limit, an inexpensive head
request that confirms we're not already throttled.

```yaml
- name: not-throttled
  type: http
  url: "{{any-cheap-endpoint}}"
  method: HEAD
  expect: { status_in: [200, 204], header_excludes: { "X-RateLimit-Remaining": "0" } }
```

## Predicates that count

Replay's preflight engine should support these predicate kinds (all
constant-time or near-constant-time):

| Predicate | Example |
|---|---|
| `status` / `status_in` | `{ status: 200 }` |
| `max_seconds` | `{ max_seconds: 5 }` |
| `json_keys_include` | `{ json_keys_include: ["items", "total"] }` |
| `json_path_matches` | `{ json_path_matches: { "$.total >= 0": true } }` |
| `resolves` | DOM selector returns ≥1 node |
| `body_excludes` | Page body doesn't contain login-wall strings |
| `header_excludes` | Response header doesn't show throttling |

Avoid predicates that depend on *content equality* (the data changes;
the shape doesn't). Preflight checks shape, not content.

## What preflight does NOT check

- Full task feasibility — that's the run.
- Pagination behavior — too expensive; the run will catch it via the
  per-step `expect` predicates.
- Visual layout fidelity — irrelevant; we don't care if the page
  looks the same, only if our locators still resolve.
- Selectors deep in the page — only the marker. If a deep selector
  has drifted but the marker hasn't, the per-step `expect` catches it
  during the run.

## Failure handling

| Tier failed | Decision |
|---|---|
| 1 reachability | Retry once after 30s. Then halt as outage, not drift. |
| 2 marker | Drift. Hand off to discover. |
| 3 endpoint shape | Drift, urgent. The fastest path is invalid; re-graduate. |
| 4 auth | Halt, escalate to user (credential issue). |
| 5 throttling | Wait `Retry-After`, retry preflight once. Past once, halt. |

## When preflight passes but the run fails

That's a graduation defect — the SKILL.md said the world looks fine,
but the cached plan still didn't work. Three responses:

1. The drift report records "preflight false-negative" so the next
   graduation knows to add a tighter preflight check.
2. Replay still hands off to discover (the run failed; that's what
   matters).
3. The graduated skill is implicitly downgraded — the next replay
   sees a recent drift event and may be more aggressive about
   re-graduation.
