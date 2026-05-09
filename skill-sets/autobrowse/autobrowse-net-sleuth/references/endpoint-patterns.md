# Hidden-endpoint patterns

A pattern catalog for the kinds of endpoints net-sleuth finds in HAR
traces. Each pattern lists the URL/header signature, what it usually
means, and how to treat it.

## REST-like patterns (preferred)

### `/api/v{N}/<resource>`

The clean case. Versioned, plural-noun resource path, JSON body.

- **Treat as:** primary candidate.
- **Watch for:** auth shape (cookie vs. token), pagination
  parameters (`?page`, `?cursor`, `?after`).
- **Example:** `/api/v1/listings?category=apartments&page=2`

### `/api/<resource>` (unversioned)

Slightly weaker because the author hasn't committed to a contract.

- **Treat as:** primary candidate; flag the lack of versioning.
- **Watch for:** the same response shape across multiple sessions.
  If shape varies day-to-day, demote.

### `/<resource>.json` or `/<resource>/index.json`

Common in static-rendered sites that pre-build JSON for the client.

- **Treat as:** medium confidence. Usually stable as long as the
  build process is.
- **Watch for:** build-hash in the URL (see "internal" patterns
  below) — that's not this pattern, it's a different one.

## GraphQL patterns

### `/graphql` POST with operation name

```http
POST /graphql
Content-Type: application/json
{ "operationName": "Listings", "variables": {...}, "query": "..." }
```

- **Treat as:** primary candidate if the query is *not* a persisted-
  hash variant.
- **Watch for:** rate limits (often per-operation), nested response
  shapes, `errors` array even on 200 responses.

### `/graphql` with persisted-query hash

```json
{ "extensions": { "persistedQuery": { "sha256Hash": "abc123..." } } }
```

- **Treat as:** demoted candidate. The hash changes when the schema
  changes; using it locks the skill to a specific schema version.
- **If used:** record the hash in the skill, expect re-graduation on
  any site update.

## Internal / framework patterns (usually demote)

### `/_next/data/<build-id>/<page>.json`

Next.js static-data path. The build-id changes on every deploy.

- **Treat as:** drop. The build-id makes the URL non-stable.
- **Exception:** sites that deploy infrequently — note in the skill,
  expect re-graduation on each deploy.

### `/__/...`, `/internal/...`, `/_/...`

Double-underscore or single-underscore prefixes signal "we reserve
the right to change this." Sites use them for internal RPCs.

- **Treat as:** drop unless no alternative exists.
- **If used:** flag aggressively; expect frequent re-graduation.

### Webpack-hashed query keys

URLs like `/_data?_csk=abc123` where `_csk` is a build hash.

- **Treat as:** drop. Build hashes invalidate every deploy.

## Mobile / partner patterns

### `api.<domain>` or `<region>-api.<domain>`

Subdomain APIs typically used by mobile apps. Often more stable than
web-internal APIs because they're consumed by app versions that can't
update on every deploy.

- **Treat as:** primary candidate, often higher confidence than the
  web-only API.
- **Watch for:** mobile-specific auth (signed requests, attestation
  headers). If those are required, the web agent can't use it.

### `<partner>.<domain>` or `developers.<domain>`

Documented partner APIs. Sanctioned, contractually stable.

- **Treat as:** highest confidence.
- **Watch for:** rate limits, API key requirements, ToS that may
  restrict the use case.

## Auth signature patterns

How endpoints announce what they want.

| Signal | Auth kind | Notes |
|---|---|---|
| `Authorization: Bearer ...` | Token | Most stable. Token in env var. |
| `Authorization: Basic ...` | Basic | Username/password; record in env. |
| `X-API-Key`, `X-Auth-Token`, `Api-Key` | Token | Same as Bearer; different header. |
| Session cookie only | Session | Works only inside an authed browser session. |
| `X-CSRF-Token` + cookie | Session+CSRF | Browser session required. |
| No auth headers, no cookie | None | Best case — preferred. |

If the endpoint ships a CSRF or attestation header, it expects to be
called from inside a real browser session. Net-sleuth records that
the skill must run inside a live browser context, not as a bare HTTP
fetch.

## Pagination patterns

| Pattern | Signature | Walk strategy |
|---|---|---|
| Page-number | `?page=N`, response has `total_pages` | Loop `1..total_pages`. |
| Offset-limit | `?offset=N&limit=M`, response has `total` | Loop until `offset >= total`. |
| Cursor | `?after=<token>`, response has `nextCursor` | Loop until `nextCursor: null`. |
| Link-header | `Link: <...>; rel="next"` | Follow until no `rel=next`. |
| Search-after (ES-style) | Body includes `search_after: [...]` | Repeat with last item's sort key. |
| None (single page) | No pagination params, full data | Single fetch. |

If response contains data but no obvious pagination, try common
parameters (`?page=2`, `?offset=N`, `?limit=N`). If two pages return
identical bodies → no real pagination, just the same response.

## Rate-limit signatures

Look for these on every candidate response:

- `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`
- `Retry-After`
- `RateLimit-Limit` (RFC 9239)
- Body messages: `"rate limit exceeded"`, `"too many requests"`

Record the observed limit in the skill so replay can pre-throttle.

## Stability anti-patterns (drop candidates)

- URL contains a per-session token: `/api/sessions/<random>/items`.
- URL contains a per-deploy build hash.
- Response body contains a CSRF/nonce that needs to be extracted from
  HTML first.
- Endpoint requires custom signed headers the browser computes from
  page-loaded JavaScript (anti-bot).
- Endpoint returns 200 with HTML on direct fetch but JSON only inside
  the browser session.

When dropping a candidate, record *why* in `candidates_dropped` so the
next graduation doesn't waste time re-evaluating it.
