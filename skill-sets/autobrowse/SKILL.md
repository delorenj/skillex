---
name: autobrowse
description: >
  Hub skill for self-graduating browser agents — the Autobrowse loop adapted
  to skillex. A browser agent attempts a real task on a real site, iterates
  3–5 rounds with failure-driven retries, then writes the converged path to
  a portable site SKILL.md so every future agent skips the discovery tax.
  Routes to four child skills that own each phase of the lifecycle:
  discover (iterative exploration), graduate (distill discovery into a site
  SKILL.md), replay (execute a graduated skill + detect drift), and
  net-sleuth (find hidden JSON endpoints buried in network traffic). Load
  when the user mentions web scraping, browser automation, site agents,
  Playwright/Puppeteer/Browserbase, "the agent forgot the site," "graduate
  this skill," recurring scrapers, hidden APIs, or any task where the same
  agent re-discovers the same site on every run.
---

# Autobrowse — Self-Graduating Browser Skill Loop

The Autobrowse insight, applied to skillex: **the markdown file IS the
memory.** Every browser agent before this paid the discovery tax on every
session. Autobrowse pays it once, writes it down, and lets every future
agent skip straight to the answer.

## The lifecycle (four phases, four child skills)

```
   ┌── discover ──┐    ┌── graduate ──┐    ┌── replay ──┐
   │ try → fail → │ -> │ converge →   │ -> │ load skill │
   │ learn → retry│    │ write SKILL  │    │ run task   │
   └──────────────┘    └──────────────┘    └─────┬──────┘
            ↑                                    │
            └────── drift detected ──────────────┘
                    (skill-heal: re-graduate)
```

`net-sleuth` runs **inside** `discover` (and sometimes `replay`) — it's the
heuristic that turns "28-page scrape" into "one fetch."

## Triage — which child to load

| Task signal | Load |
|---|---|
| Brand-new site, no existing skill, user wants automation working | **discover** → then **graduate** |
| Discovery is converging (≥2 successful runs) and you need to crystallize the lesson | **graduate** |
| A graduated site skill already exists; user wants to run a task on that site | **replay** (it loads the skill, validates, falls back to discover if drift) |
| User says "the agent keeps re-figuring out the site" / "every run is a cold start" | **discover** + **graduate** (this is exactly the cycle they're missing) |
| User wants to find a hidden API / JSON endpoint to replace HTML scraping | **net-sleuth** (standalone use) or **discover** (in-loop) |
| A previously-graduated skill broke after a site redesign | **replay** with `--heal` (delegates back to discover) |

## When NOT to use this skill set

- One-shot, never-to-be-repeated browser task. Graduation has fixed cost; if
  there's no run-2, the loop never pays back.
- Sites you don't have authorization to automate. The graduation artifact is
  durable and shared — confirm ToS and scope before saving it as a skill.
- Tasks that require a human-in-the-loop on every run (multi-factor with
  unpredictable challenges, CAPTCHA-on-every-action). Graduate the *prep*
  steps, surface the human handoff, but don't try to automate past it.

## Cross-cutting rules (apply in every child skill)

These show up everywhere — internalize once at the hub level.

- **Iteration cap is non-negotiable.** Default 5 rounds. Past round 5
  without convergence → escalate, do not loop forever. Each round costs
  tokens; an agent that runs 20 rounds has paid the discovery tax with
  interest.
- **The site SKILL.md is the deliverable, not the run output.** A run that
  scrapes 1000 listings but doesn't update the site skill has wasted the
  graduation opportunity. Always write the lesson down.
- **Prefer the smallest stable surface.** Hidden JSON endpoint > stable
  semantic selector (role/label/data-testid) > brittle CSS selector >
  XPath chain > visual/coordinate fallback. The graduated skill records
  the highest-quality path that worked, *plus* one tier of fallback.
- **Validate before trusting the cache.** Before replay reuses a graduated
  path, run the skill's `preflight` checks — page title, marker selector,
  endpoint shape. A 200 OK on the wrong content is worse than a 500.
- **Authorization context goes in the frontmatter.** `auth_required`,
  `rate_limit`, `tos_url` fields on the site skill so future agents see
  the constraints before they start.
- **Network capture is part of every discovery run.** Even if the chosen
  path is DOM-based, the trace lets `net-sleuth` retro-find a faster path
  on the next graduation.
- **Cost telemetry beats vibes.** Record `tokens_in`, `tokens_out`,
  `wall_seconds`, `iteration_count` on every run. The graduated skill's
  value is in the savings — measure them.

## Discovery hints

If unsure which child applies, look for these cues:

- User pastes a URL + a task description, no prior artifacts → **discover**
- A `site-skills/<domain>/SKILL.md` already exists in the project → **replay**
- User mentions "Network tab," "XHR," "/api/," "GraphQL," or a 28-page
  pagination they want to collapse → **net-sleuth**
- User says "this used to work" + a previously-working scraper → **replay**
  (with drift detection / heal path)

## Shared artifacts

All four child skills read and write the same on-disk shape:

```
site-skills/<domain>/
├── SKILL.md                    # the graduated site skill
├── discoveries/
│   ├── 2026-05-09-iter1.json   # raw run trace per attempt
│   ├── 2026-05-09-iter1.har    # network capture
│   └── 2026-05-09-iter1.md     # human-readable failure analysis
└── runs/
    └── 2026-05-09-replay.json  # post-graduation run telemetry
```

The `references/site-skill.template.md` at this hub is the canonical
template every graduation produces.

## Provenance

Inspired by Browserbase's Autobrowse open-source release. The graduation
loop, iteration cap, and "markdown-is-memory" framing are theirs. This
skill set adapts the pattern to skillex's CLI-agnostic skill model so a
graduated site skill is a first-class skillex citizen — slottable,
lintable, distributable.
