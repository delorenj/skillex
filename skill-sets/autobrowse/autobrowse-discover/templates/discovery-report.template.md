# Discovery report — iteration {{N}}

| | |
|---|---|
| Task | {{task}} |
| URL | {{url}} |
| Date | {{YYYY-MM-DD}} |
| Tool | {{playwright|puppeteer|browserbase|...}} |
| Outcome | `success` \| `failure` \| `partial` |
| Failure class | {{from failure-taxonomy.md, or `null` on success}} |
| Tokens in / out | {{N}} / {{M}} |
| Wall seconds | {{N}} |
| Browser actions | {{N}} |
| Network requests | {{N}} |

## Plan attempted

```yaml
{{the structured plan from iteration-loop.md, verbatim}}
```

## What happened

One or two paragraphs. Be specific about *which step failed* and *what
the page looked like at the moment of failure*. Reference DOM snapshots
or HAR entries by index (`HAR[12]`, `dom-snapshot-3.html`).

## Diagnosis (failure runs only)

- **Class:** `{{class}}` (one of the eight in failure-taxonomy.md, or
  `unknown`)
- **Evidence:** specific log lines, status codes, selector returns
  pointing at the diagnosis.
- **Confidence:** `high` \| `medium` \| `low` — low confidence is fine,
  but it weakens the next-round rewrite.

## What to try next round

- **Banned strategies** added by this iteration: {{list}}
- **Promising signals** added by this iteration: {{list}}
- **Proposed rewrite:** {{the canonical rewrite for the diagnosed class
  from failure-taxonomy.md, with site-specific specifics filled in}}

## Reproducibility (success runs only)

If marking success, answer these explicitly. Graduate reads them.

- Did the plan use any random or time-of-day-dependent inputs? {{yes/no
  + details}}
- Are all selectors role / test-id / stable-text based? {{yes/no +
  exceptions}}
- Did the network trace look deterministic (same shape, no flaky 5xx)?
  {{yes/no}}
- Confidence this run is reproducible: `high` \| `medium` \| `low`.

## Artifacts produced

- `discoveries/{{date}}-iter{{N}}.json` — structured trace
- `discoveries/{{date}}-iter{{N}}.har` — network capture
- `discoveries/{{date}}-iter{{N}}-dom-*.html` — DOM snapshots at each
  failure point (failure runs only)
- `discoveries/{{date}}-iter{{N}}-screenshot-*.png` — screenshots at
  failure points (failure runs only)
