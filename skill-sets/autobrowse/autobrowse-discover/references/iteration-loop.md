# Iteration loop protocol

The discovery loop is the heart of Autobrowse. This document is the
authoritative spec for how it runs.

## State carried across iterations

Each iteration starts with the accumulated state from prior rounds:

```ts
type LoopState = {
  task: string;                 // original user task, unchanged
  url: string;
  successCriteria: Criterion[]; // self-checkable predicates
  attempts: Attempt[];          // one per prior iteration
  banned: Strategy[];           // approaches that already failed; do not retry
  promising: Hint[];            // signals to follow next round
  budget: { iterationsLeft: number; tokensLeft: number };
};
```

The `banned` set is what makes failure productive. An agent that doesn't
remember what it already tried will retry it. Every failed iteration
contributes one or more entries to `banned`.

## Convergence rule

A run is **converged** when ANY of:

1. **Two consecutive successful iterations** with substantially the same
   plan (allowing for waits/timing tweaks). This is the default.
2. **One successful iteration** *plus* an explicit reproducibility
   argument: the plan uses no random/time-dependent inputs, the
   selectors are role/test-id (not nth-child), and the network trace
   shows deterministic responses. Document the argument in the iteration
   report — graduate will read it.
3. **One successful iteration via a hidden-API path** (net-sleuth).
   Hidden APIs are inherently more stable than DOM; one success is
   enough if the endpoint returned the expected JSON shape.

If none of these hold by round 5, **escalate, don't loop**.

## Plan-propose step

Before each iteration's `execute`, propose a plan. The plan is an
ordered list of actions with success predicates, not free-form intent:

```yaml
plan:
  - step: "navigate to landing"
    action: { goto: "{{url}}" }
    expect: { url_matches: "^https://{{domain}}/", status: 200 }

  - step: "dismiss cookie banner if present"
    action: { click_if_visible: "[role=dialog] button[aria-label*=accept]" }
    expect: { selector_gone: "[role=dialog]" }

  - step: "load all listings"
    action: { fetch: "/api/v1/listings?page=all" }       # tried iter 3
    expect: { json_keys_include: ["items", "total"] }
    fallback:
      action: { paginate_dom: "[role=list] [role=listitem]" }
      expect: { count_at_least: 10 }
```

Plans are structured because:
- They diff cleanly between iterations (so the loop can show *what
  changed*).
- They translate directly into the graduated SKILL.md without rewrite.
- The `expect` predicates double as success checks, no separate
  evaluator needed.

## Failure → next-round transformation

For each failure class (see `failure-taxonomy.md`), the loop has a
canonical "what to try next" rewrite:

| Failure class | Next-round rewrite |
|---|---|
| selector-not-found | Replace selector with a higher-stability locator one tier up. Add to `banned`. |
| timing | Replace `sleep` (if any) with `wait_for` predicate; if predicate already, raise its specificity. |
| auth-wall | Halt loop, escalate. Never retry. |
| rate-limited | Read `Retry-After`, back off, record limit, retry once. Past once → escalate. |
| hidden-api-better | Spawn a net-sleuth sub-iteration, then continue main loop. |
| layout-changed | Re-anchor on the nearest stable semantic landmark; rebuild downstream selectors relative to it. |
| bot-detection | Halt loop, escalate. Never try to evade. |
| task-impossible | Halt loop, escalate with the specific gap. |

If a failure doesn't fit any class → it's class `unknown`, which forces
escalation. We do not have a "try random stuff" branch on purpose.

## Budget

Default budget per discovery run:

| Resource | Default | Override |
|---|---|---|
| Iterations | 5 | `--max-iterations` (hard ceiling 8, never higher) |
| Tokens | 100k | `--max-tokens` |
| Wall seconds | 600 | `--max-wall-seconds` |

Hitting any limit → escalate. The whole skill set is built on the bet
that *bounded discovery + cached graduation* beats *unbounded retry*.

## What "escalate" means

Stop the loop. Write `<Y>-summary.md` with:

- The task and URL.
- Iterations attempted, with the failure class for each.
- The current `banned` and `promising` sets.
- A specific question or constraint for the human user (e.g., "auth
  required — please supply credentials," or "the listings endpoint is
  hard-paginated to 50; is server-side total acceptable?").
- A *non-graduated* suggestion list — what would unblock convergence.

Never silently mark an escalated run as converged. The graduate skill
refuses to operate on a non-converged summary.

## Reproducibility hygiene

The loop is supposed to be reproducible: same task, same site, same
budget → similar number of iterations to converge. If two consecutive
runs of the same task take wildly different iteration counts, that's a
signal the site is unstable — flag it in the graduated skill so replay
will be conservative about caching.
