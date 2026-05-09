# Failure taxonomy

Every failed iteration must be classified into exactly one of these
eight categories. "Other" is not a category — if a failure doesn't fit,
mark it `unknown` and escalate.

The reason for forced classification: the next-round rewrite is keyed on
the class. An unclassified failure can't be productively retried.

## 1. `selector-not-found`

**Symptom:** A locator returned 0 nodes (or threw "not visible" / "not
attached") on a page that loaded successfully.

**Diagnostic signals:**
- `document.querySelectorAll(selector).length === 0`
- Page HTML loaded normally; other selectors on the same page resolve.
- No redirect, no auth wall.

**Likely cause:** Brittle selector. A class name, an nth-child path, an
auto-generated ID. Or the element actually moved.

**Next-round rewrite:** Replace with a higher-stability locator, in
order of preference:
1. ARIA role + accessible name (`role=button name=/submit/i`)
2. `data-testid` / `data-test` attributes
3. Visible text content
4. Stable structural landmarks (`<main>`, `<nav>`, `<header>`)
5. Last resort: a relative path *from* one of the above

Add the original selector to `banned`.

## 2. `timing`

**Symptom:** Action ran, but on a stale or partially-hydrated DOM. Common
shapes: stale `value` from a controlled input, missing children inside a
list that was about to render, click fired on a now-detached node.

**Diagnostic signals:**
- A second-later snapshot would have shown the right state.
- Console shows hydration logs, framework re-renders, or async fetches
  resolving after the action.

**Next-round rewrite:** Replace any sleep with a `wait_for` predicate
keyed on the *thing you're waiting for* — a text appearance, a
network-idle window, a specific node count, an element to become
enabled. If a predicate already exists, raise its specificity (e.g.,
`wait_for_selector` → `wait_for_function(node => node.children.length >= 10)`).

## 3. `auth-wall`

**Symptom:** Redirect to `/login`, `/signin`, OAuth provider, or a 401/403
response.

**Diagnostic signals:**
- URL after navigation matches a known auth path.
- Response status 401/403 with `WWW-Authenticate` or a JSON `unauthorized`.

**Next-round rewrite:** Do not retry. Halt the loop. Escalate to the
user with: "site requires authentication for this task; please supply
credentials via {env var | session cookie | OAuth flow}."

## 4. `rate-limited`

**Symptom:** 429, or a 200 with a `rate limit` body, or progressively-
slower responses indicative of soft throttling.

**Diagnostic signals:**
- `Retry-After` header.
- `X-RateLimit-Remaining: 0` or similar.
- Response time grows non-linearly across requests.

**Next-round rewrite:** Honor `Retry-After`. Record the observed limit
(per-second / per-minute) so the graduated skill can pre-throttle.
Retry **once**; past one rate-limited iteration, escalate.

## 5. `hidden-api-better`

**Symptom:** The DOM path worked, but network capture shows a JSON
endpoint that returns the same data more cleanly.

**Diagnostic signals:**
- HAR contains XHR/fetch responses with the data shape the task wants.
- Endpoint path looks API-like (`/api/`, `/v1/`, `/graphql`).
- Response is JSON, not HTML.

**Next-round rewrite:** This is *not* a failure of the current path —
it's a discovery of a better one. Spawn a net-sleuth sub-iteration to
validate the endpoint (auth requirements, pagination shape, stability
markers). If the endpoint validates, swap the main path to use it; if
not, keep the DOM path but record the candidate in the graduated skill
as a future-better-path note.

## 6. `layout-changed`

**Symptom:** Selectors mostly resolve, but the *content* relationships
they encoded are wrong. Example: a selector that used to point to "price"
now points to "shipping cost" because the parent `<dl>` reordered.

**Diagnostic signals:**
- Returned data fails downstream type/shape checks but selectors aren't
  empty.
- Visual diff of the page vs. prior iteration shows reorganized elements.

**Next-round rewrite:** Re-anchor on the nearest stable semantic
landmark (e.g., `dt:has-text("Price") + dd` instead of `dl > dd:nth-child(3)`).
Rebuild downstream selectors as relative paths from the landmark.

## 7. `bot-detection`

**Symptom:** CAPTCHA shown, fingerprint challenge, Cloudflare interstitial,
"verifying your browser" page, or a sudden block at a previously-passing
URL.

**Diagnostic signals:**
- DOM contains CAPTCHA iframe (`google.com/recaptcha`, `hcaptcha.com`,
  Cloudflare's challenge widget).
- 403 with a challenge body.
- Response contains "verify you are human" / "checking your browser".

**Next-round rewrite:** Halt the loop. Do not attempt evasion. Escalate
to the user. Bot-detection circumvention is out-of-scope for this skill
set — both because it's typically a ToS violation and because graduated
skills built on evasion break the moment the site updates its detection.

## 8. `task-impossible`

**Symptom:** Discovery exhausted reasonable options and the data the
task asks for *isn't on the surface the task targets*.

**Diagnostic signals:**
- All visible elements + all observed network responses have been
  inspected; the requested data is not present.
- Site documentation or sitemap suggests the data is on a different
  surface (mobile app, partner API, paid endpoint).

**Next-round rewrite:** Halt and escalate with the specific gap and the
suggested alternative surface. Do not loop hoping the data will appear.

## `unknown` (escape hatch, forces escalation)

If a failure doesn't fit any of the above, mark it `unknown` and
escalate. Do not silently retry. The taxonomy will grow over time;
unknowns are how we discover what to add.
