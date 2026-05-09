---
name: autobrowse-net-sleuth
description: >
  Hidden-API hunter. Inspects HAR/network traces from a discovery run
  (or a live browser session) to find stable JSON/GraphQL endpoints
  that return the same data the user is currently scraping from the
  DOM. The "28-page scrape collapses into one fetch" path. Validates
  candidate endpoints for auth requirements, pagination shape,
  rate limits, and stability indicators, then proposes them as the
  fastest_path tier in a graduated SKILL.md. Use mid-discovery when
  the agent's DOM path works but the network tab shows promising
  XHR responses, OR standalone when a user explicitly asks "is there
  a hidden API for this site?"
---

# autobrowse-net-sleuth

## Purpose

The discovery-loop trick that broke the demo: an agent watching the
network tab tries something a person never would, and finds an
undocumented endpoint humans missed for years. This skill formalizes
the heuristics so the trick is reproducible, not lucky.

## Inputs

- A HAR (HTTP Archive) file, OR a live browser session with network
  capture enabled.
- The data shape the user wants — the same `success_criteria` the
  discover loop uses (e.g. "list of records with title, price, url").

## The hunt

```
all_responses ← parse_har(har_file)
candidates    ← filter(all_responses, looks_like_data_endpoint)
ranked        ← rank(candidates, by=stability_signals)
for endpoint in ranked:
    validation ← validate(endpoint, against=success_criteria)
    if validation.passes:
        return endpoint
return null  # no winner; stick with DOM
```

## "Looks like a data endpoint" — the filter

A response is a candidate if it satisfies *all* of:

- Status 200, content-type `application/json` or `application/graphql-response+json`.
- Method `GET` (preferred) or `POST` (acceptable for GraphQL).
- Body parses as JSON.
- Body size ≥ 500 bytes (filters out heartbeats, telemetry pings).
- URL path looks API-like — heuristics:
  - Contains `/api/`, `/v1/`, `/v2/`, `/graphql`, `/rest/`.
  - OR is a top-level domain match returning JSON to an XHR.
  - OR is a subdomain like `api.<domain>` or `<thing>-api.<domain>`.
- Body shape contains structures that *match what the user wants* —
  arrays of objects with similar keys to the target data shape.

Single-record endpoints (item details) are weaker candidates than
list endpoints, but still useful — record both.

## Stability ranking

Among the candidates, prefer endpoints with:

| Signal | Weight | Notes |
|---|---|---|
| `Cache-Control` with a non-zero `max-age` | high | Implies the site treats this as stable. |
| Versioned URL (`/v1/`, `/2024-09-01/`) | high | Authors signaling commitment to a contract. |
| Documented at site's `/api`, `/developers`, `/dev` | very high | Best case — fully sanctioned. |
| Server-side pagination (`?page=`, `?cursor=`) | high | Mature endpoint design. |
| Auth via stable token (`Bearer`, `X-API-Key`) | medium | Stable but raises auth complexity. |
| Auth via session cookie | medium | Works but couples to a logged-in browser. |
| No auth at all | mixed | Convenient but often means the endpoint is a side effect of public-render path; can disappear without warning. |
| Internal-looking URL (`/_next/data/`, `/__/`, hashed query keys) | low | Private; can change weekly. |
| GraphQL with persisted-query hashes | low | Hash changes invalidate the request. |

`references/endpoint-patterns.md` has the full pattern catalog with
specific shapes to match.

## Validation steps

Before recommending an endpoint, confirm — in order:

1. **Reproducibility.** Hit the endpoint twice with no browser
   context. Same shape twice → reproducible. Different → likely
   coupled to session state; demote.
2. **Pagination.** If the response contains a subset of the data, find
   the pagination mechanism. Page-number, cursor, offset/limit. Walk
   2–3 pages to confirm the mechanism works.
3. **Coverage.** The endpoint returns the *same data* the user wants,
   not a subset. Compare to a DOM-extracted record — fields, types,
   value matches.
4. **Rate limit.** Make 5 requests in quick succession and look for
   rate-limit headers, 429s, or progressively-slower responses.
   Record the observed limit.
5. **Auth.** Strip the session cookie / Authorization header and
   retry. If it still works → no-auth path; preferred. If it 401s →
   record what auth is needed.

An endpoint that fails reproducibility or coverage → drop. An endpoint
that fails pagination → useful as a single-record path but not a
list-replacement.

## What net-sleuth produces

A structured report appended to the discovery directory:

```
site-skills/<domain>/discoveries/<date>-netsleuth.md
```

Format:

```yaml
endpoints_found: 3
recommended_primary: "/api/v1/listings"
recommended_alternatives:
  - "/api/v1/listings/{id}"   # for detail pages
candidates_dropped:
  - url: "/_next/data/...listings.json"
    reason: "internal Next.js path; build-id in URL changes per deploy"

primary:
  url: "/api/v1/listings"
  method: GET
  pagination: { kind: cursor, param: "after", response_field: "nextCursor" }
  auth: { kind: none }
  rate_limit: "60/min observed; 429 above"
  json_shape:
    items: [{ id, title, price, postedAt, url }]
    total: integer
    nextCursor: string|null
  stability_signals: ["versioned URL", "Cache-Control: max-age=60", "server-side pagination"]
  reproduces_without_browser: true
```

The graduate skill reads this report and uses it as the basis for
the SKILL.md's `fastest_path` if the recommendation passed validation.

## Hand-offs

- **→ autobrowse-graduate** with the recommended endpoint and its
  validation evidence.
- **→ autobrowse-discover** if the endpoint requires auth in a way
  the current run can't satisfy — discover surfaces the auth
  requirement; net-sleuth re-runs once auth is provided.

## Standalone use

Net-sleuth runs outside the discover loop too. A user can point it
at:

- A HAR file they captured manually ("I saved this from DevTools,
  what's in it?").
- A site they want assessed for hidden-API potential before deciding
  whether to invest in graduation.

Standalone runs produce the same report format, with no implicit
hand-off to graduate.

## What net-sleuth refuses

- Endpoints behind explicit "no scraping / no automated access"
  language in the site's robots.txt or ToS the user hasn't waved off.
- Endpoints discovered by sniffing traffic from another user's
  session (only the agent's own session is fair game).
- Endpoints that require bypassing a CAPTCHA or fingerprint
  challenge to reach. Those aren't "hidden APIs" — they're
  fortified ones, and the line between use and abuse is short.
