# Drift detection

Drift is the gap between the world the SKILL.md was graduated against
and the world the replay run is hitting. Detecting it is what keeps
graduated skills honest — without drift detection, a skill quietly
degrades from "10x cheaper" to "10x cheaper *but wrong*."

## Three signals replay always watches

1. **Preflight failure.** Most direct. See `validation-checks.md`.
2. **Cost overshoot.** Wall time / token consumption blows past the
   graduated baseline.
3. **Output schema mismatch.** The records returned don't match the
   shape the skill claims to produce.

Any single signal trips re-graduation. Two together raise the
priority — the drift is real, not a flaky one-off.

## Cost overshoot, defined

Compare against the baseline in the graduated SKILL.md.

| Metric | Drift threshold |
|---|---|
| Wall seconds | run > baseline × 2 |
| Tokens (in + out) | run > baseline × 3 |
| Browser actions | run > baseline + 5 |
| Network requests | run > baseline × 2 |

Wall-time and token thresholds are intentionally lenient — the goal
is *not* to flag noise. A 10% slowdown is noise; a 200% slowdown is
drift.

## Output schema mismatch, defined

The graduated skill declares a record schema (the shape of each output
item). Replay validates each output record against the schema and
counts mismatches. Threshold:

- **> 5% of records fail validation** → drift.
- Below 5% → noise; surface in telemetry but don't trip re-graduation.

Schema validation is type-level, not content-level. `price` must
parse as currency; we don't care that today's prices are different
from graduation day's.

## False positives — how to dampen

Replay does *not* trip drift on a single observation. Two-of-three
heuristics:

- A drift signal must repeat across two consecutive runs **or**
- A single run must trip ≥ 2 of the three signal types.

This costs one extra run before the loop self-heals, in exchange for
not panicking on flaky network days.

The exception: a Tier-2 (marker selector missing) or Tier-3 (endpoint
shape changed) preflight failure trips re-graduation immediately. Those
are unambiguous.

## When to re-graduate vs. patch in place

Always re-graduate. Tactical patches accumulate.

If the temptation arises to "just update one selector and move on,"
that's the moment the skill starts lying — the provenance no longer
matches the artifact. The full re-graduation is fast (the discover
loop can use the previous SKILL.md as a hint, often converging in 1–2
iterations) and produces an honest record.

## Drift report

When replay decides to hand off, write one report:

```
site-skills/<domain>/runs/<date>-drift.md
```

Contents:

| | |
|---|---|
| Run date | YYYY-MM-DD HH:MM |
| Triggered by | preflight \| cost \| schema \| (multiple) |
| Failed checks | list of preflight check names that failed |
| Cost delta | { wall_pct: +220, tokens_pct: +340 } |
| Schema mismatches | N of M records |
| Latest passing run | YYYY-MM-DD (link to its telemetry) |
| Suggested re-graduation hints | what discovery should re-anchor on |

Discover, when called for re-graduation, reads this report and skips
candidates that the drift evidence already rules out.

## Drift vs. site outage

A site that's *down* isn't drifting. Replay distinguishes:

| Symptom | Drift | Outage |
|---|---|---|
| Preflight Tier-1 fails (status non-200) | no | yes |
| Preflight Tier-2 fails (marker gone) | yes | no |
| Preflight Tier-3 fails (endpoint moved) | yes | no |
| All checks succeed but the run hangs | maybe | maybe — retry once |
| All checks succeed and the run returns wrong shape | yes | no |

Outage → wait, retry. Drift → re-graduate.

## What drift detection does NOT cover

- **Soft semantic drift** — the data the site returns has subtly
  different meaning. Example: a "price" field starts including tax
  when it didn't before. Schema validation catches type mismatches,
  not semantic ones. Surface this through downstream consumers (the
  thing using the scraped data), not replay.
- **New features the site added.** If the site exposes a better path
  than the one we graduated, replay records it as a re-graduation
  candidate but does not act on it. Net-sleuth + a scheduled
  re-graduation handle this.
