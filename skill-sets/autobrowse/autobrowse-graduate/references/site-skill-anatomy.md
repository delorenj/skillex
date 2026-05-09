# Site SKILL.md anatomy

The graduated SKILL.md is the deliverable of the entire Autobrowse
loop. This document spells out what each section is for, what belongs
in it, and what doesn't. Use the template at
`../../references/site-skill.template.md` for the exact layout.

## Frontmatter (YAML)

The frontmatter is what skillex's loader and linter read. It must be
valid YAML and must include:

| Field | Required | Why |
|---|---|---|
| `name` | yes | Skillex skill name; convention `site-<domain-slug>`. Lowercase, dashes only. |
| `description` | yes | Read by the *router agent* — the one deciding whether to load this skill. Must mention the site and the task. ≤80 words. |
| `auth_required` | yes | `true` / `false`. Replay reads this before attempting; flips behavior on credential-presence checks. |
| `rate_limit` | yes | Free-text observed limit. `none observed` is a valid answer. |
| `tos_url` | yes | URL to the site's terms / API docs. Future agents read it before extending the skill. |
| `fastest_path` | yes | `api`, `dom`, or `hybrid`. Replay's optimizer keys on this. |

Optional fields that earn their keep:

- `tags` — for skillex skill discovery; e.g. `[scraping, listings, e-commerce]`.
- `requires_session` — `true` if the skill won't work without an
  authenticated browser context the user maintains.

## Task scope

One sentence the next agent reads first. Be specific about *what data
the skill returns* or *what action the skill performs*, not how it
does it. The "how" is in the rest of the file.

Bad: "Automate the listings page."
Good: "Return all open listings in a category as `{title, price,
posted_at, url}` records, paginated until the site stops returning new
items."

## Preflight checks

Cheap validations that prove the site looks like the one we graduated
against. Replay runs these first and skips the full task on any failure
(falling back to discover).

Rules of thumb:

- **Cheap.** Each check ≤ 1 second wall time, ≤ 1 network request.
- **Specific.** A 200 response is not a check; the *body shape* is.
- **Layered.** Cheapest first (URL reachable) → most specific (endpoint
  shape matches).

3–5 checks is the sweet spot. Past 5, replay's preflight starts
costing as much as a full run.

## Fastest-known path

The converged plan. Use the structured-plan format from the discover
skill's `iteration-loop.md`:

```yaml
- step: "<one-line human-readable description>"
  action: { <verb>: <args> }
  expect: { <predicate>: <args> }
```

Verbs the discover loop emits map 1:1 to verbs replay can execute.
Common ones: `goto`, `click`, `fill`, `wait_for_selector`,
`wait_for_function`, `fetch`, `paginate_dom`, `scroll_into_view`.

Each step has an `expect` predicate. No `expect` → not allowed in a
graduated skill. The predicates are how replay knows mid-run that
something has drifted.

## Why this path

One paragraph. The single most useful line is *why this path beat the
alternatives*. The next agent — or the next graduation — uses this to
decide whether to stick with this approach or revisit.

Examples of what to write:

> "Chose the /api/v1/listings endpoint over DOM scraping: returns the
> same fields, no auth, server-paginated, observed stable shape across
> 3 weeks of network captures. DOM path works but takes 28 page loads
> for the same data."

## Fallback path

Exactly one. Past one, you're hedging.

Use the same structured-plan format. Mark this section
`# Fallback path (one tier)` so the linter / replay can find it.

If the chosen path is `fastest_path: api`, the fallback is usually a
DOM path. If chosen is DOM, the fallback is typically a more
conservative DOM walk (e.g., role-based instead of test-id-based) — *a
different tier*, not just "the same plan with longer waits."

## Selectors / endpoints registry

A table per resource, with stability notes. The notes are the part
that earns the most over time — they're what tell the next graduation
"this selector survived the 2024-Q3 redesign, anchor on it."

Required columns:

| Column | Purpose |
|---|---|
| Surface | What the locator targets, in plain English. |
| Locator | The selector or URL. |
| Stability notes | What's been seen historically. Update on every re-graduation. |

## Known failure modes

Symptoms, causes, responses. The discover skill's failure taxonomy
(`autobrowse-discover/references/failure-taxonomy.md`) is the source
material; pull in only the failure classes that *actually triggered*
during this site's discovery.

Format each entry as a tight 3-line block:

- **Symptom:** what the next agent will see.
- **Cause:** what's actually going on.
- **Response:** what to do (often "abort and surface to user" — that's
  fine, it's still useful to a future agent).

## Cost / time baseline

Three numbers that matter:

- **Wall seconds per run** — how long a successful replay takes.
- **Tokens** — should be near-zero for replay (it's loading the skill,
  not re-discovering).
- **Iteration count for replay** — should be 0. Replay either works
  via the cached plan or hands off to discover.

Capturing these makes drift detection possible. If a replay run blows
past wall × 2 → preflight has missed something, re-graduate.

## Re-graduation triggers

The conditions under which replay should *stop trying* the cached
path and hand back to discover. Each trigger is one bullet, specific
enough to be machine-checkable:

- "Preflight check N fails on two consecutive runs."
- "Wall time > 2× baseline."
- "Output schema mismatch on > 5% of records."
- "Selector X returns 0 nodes on a page where the marker selector
  resolved."

These triggers are how the system stays accurate over time. Without
them, a graduated skill silently degrades.

## Provenance

Append-only. Every (re-)graduation adds a row, never overwrites. The
provenance lets a maintainer see "this skill was graduated 3 times in
the last 6 months — the site is unstable, factor that into our
roadmap."

## What never goes in a site SKILL.md

- Chain-of-thought from the agent that graduated it.
- "TODO: clean this up later." A graduated skill is presumed clean; if
  it's not, don't graduate yet.
- Multiple alternative phrasings of the same step. One canonical step.
- Login credentials, OAuth tokens, cookies, headers containing
  secrets. Reference by env var name only.
- Sample output data beyond a 1–2 record example. Future agents fetch
  fresh data; old sample data goes stale and misleads.
