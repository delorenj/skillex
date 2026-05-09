---
name: autobrowse-graduate
description: >
  Distill a converged discovery run into a portable, reusable site
  SKILL.md that future agents load before they start. Reads the per-
  iteration reports and HAR traces from autobrowse-discover, picks the
  highest-stability path that worked, encodes it as deterministic steps
  + selectors registry + preflight checks + fallback path, and writes
  it as a frontmatter-tagged skill that integrates with skillex like
  any other skill. Refuses to run on a non-converged discovery (≥2
  successful iterations OR 1 success with reproducibility argument).
  Use when discovery is done and you need to crystallize the lesson.
  Do NOT use mid-discovery — graduating an unstable path produces a
  skill that lies, which is worse than no skill.
---

# autobrowse-graduate

## Purpose

Turn ephemeral discovery into durable memory. The graduation step is
where the loop pays back: every minute spent here saves orders of
magnitude on every future replay.

## Inputs

A `site-skills/<domain>/discoveries/` directory containing at minimum:

- One `<date>-iterN.md` report marked `outcome: success`
- The corresponding HAR for that iteration
- A `<date>-summary.md` from the discover skill marked `converged: true`

If any of these are missing → refuse to graduate, return to discover.

## Refusal conditions

The skill refuses (and the agent must escalate) if any of:

- The summary says `converged: false`. Graduate is not allowed to
  "decide for itself" that a run was good enough.
- Only one iteration succeeded *and* its reproducibility section
  marks `confidence: low`. Low-confidence single-success → at least
  one more iteration is needed.
- The successful path used coordinate clicks, nth-child selectors with
  `n > 3`, or `sleep` with no `wait_for` predicate. These are flagged
  in the report; graduating them produces a skill that breaks weekly.
- The network trace contains an auth credential the discover skill
  failed to redact. Refuse and require redaction.

## Output

A single file: `site-skills/<domain>/SKILL.md`, conforming to the
template at `../references/site-skill.template.md`.

Plus an updated `site-skills/<domain>/CHANGELOG.md` recording:

- Date, iteration_count it took to converge, baseline cost numbers,
  the chosen path tier (api / dom / hybrid), the reason that tier was
  chosen over the alternatives.

## The graduation algorithm

```
inputs ← read(discoveries/)
candidates ← extract_paths(inputs)              # one per successful iteration
ranked    ← rank(candidates, by=stability_tier) # api > role > test-id > class > xpath
chosen    ← ranked[0]
fallback  ← ranked[1] if ranked[1] != null and tier(ranked[1]) ≥ "test-id" else null

preflight_checks ← derive_preflight(chosen, inputs)
known_failures   ← collect_failures(inputs)     # one per failed iteration
selectors_table  ← extract_selectors(chosen, fallback)
endpoints_table  ← extract_endpoints(inputs.har)
baseline_costs   ← summarize_costs(inputs)

write SKILL.md from template, populated with:
    chosen, fallback, preflight_checks, known_failures,
    selectors_table, endpoints_table, baseline_costs
```

`references/site-skill-anatomy.md` documents each section's purpose
and the rules for what goes where.

## Stability ranking

When discovery surfaced multiple successful paths, graduate chooses the
most stable one. The ranking, top to bottom (most → least stable):

1. **Hidden / documented JSON API.** One request, deterministic shape,
   typically server-paginated. Mark `fastest_path: api`.
2. **ARIA role + accessible name.** Stable across redesigns that keep
   the page accessible.
3. **`data-testid` / `data-test`.** Author-controlled; stable as long
   as the test suite uses it.
4. **Stable visible text.** Fragile to copy edits but robust to
   restructuring.
5. **Class names + structural selectors.** Default-fragile; use only
   when nothing higher works.
6. **XPath chains.** Last resort; declare in the skill that
   re-graduation is likely within a quarter.

The chosen path is the highest-tier candidate that succeeded *and*
reproduced (≥2 iterations, or 1 with high reproducibility confidence).

## What goes in the SKILL.md (and what doesn't)

**In:**
- The converged plan as a deterministic step list with `expect`
  predicates after each action.
- Preflight checks (the cheap pre-replay validations that catch drift
  before a full run).
- Selectors registry — every selector the chosen and fallback paths
  use, with a stability note per row.
- Endpoints registry — every API URL touched, with auth requirements,
  pagination shape, and observed rate limits.
- Known failure modes from discovery — the symptoms, causes, and
  responses, so the next agent doesn't re-discover them.
- Cost / time baseline (so replay can detect drift by cost).
- One re-graduation trigger list.

**Out:**
- Chain-of-thought from discovery. The graduated skill is for
  *future* agents; their reasoning is their own.
- Speculative paths discovery considered but didn't try. Either it
  worked (in) or it didn't (out).
- Auth credentials, even partially. Reference env vars or vault
  keys by name only.
- Three or more fallback paths. Past one fallback, you're hedging on
  a shaky foundation; re-graduate instead.

## Hand-offs

- **→ autobrowse-replay** the moment the SKILL.md is written. Every
  graduation should be followed by a replay run on a fresh task to
  verify the skill works for an agent that wasn't part of discovery.
- **→ user** if any refusal condition triggers. Be specific about which
  one and how to remedy.

## Quality bar (graduate's responsibility)

A graduated skill is "good" when:

1. A different agent loading it cold can complete the task without
   reading any discovery artifact.
2. Replay's preflight catches site changes *before* a wasted full run.
3. The cost baseline is met within ±20% on a new replay.
4. The known-failures section anticipates ≥80% of what a fresh discovery
   would re-discover today.

If any of these don't hold on the first replay, that's a graduation
defect — re-run graduate, don't paper over it.
