# Skill sweep

Every night at 02:40 ET an agent reviews a small cohort of skills in depth and fixes what it
finds. It covers every skill skillex manages (`skillex skill list`): wild and vendored catalog
skills in `all-skills/`, and repo-owned hubs in their own repos.

The clock is Candybar (`../skill-sweep.candybar.toml`). The agent is Hermes job `d4edbba767c1` in
the `skillex-pm` profile, pinned `scheduler: external`. The pass follows the interval-driver
pattern, so the deterministic work happens in `sweep.py` and the agent spends tokens only on
judgement.

| file | what |
|---|---|
| `sweep.py` | `--monitor` (gate), `--brief` (contract plus per-skill context), `--apply PLAN` (commit, push, record), `--scan DIR...` |
| `CONTRACT.md` | what the agent reviews, how it may fix, and the plan it writes |
| `ledger.json` | per skill: night reviewed, git tree hash, outcome, scan verdict, notes, commits |
| `log/<night>.md` | one report per night |
| `STATUS.md` | coverage, plus everything marked `needs-human` (the "Needs Jarad" list) |

Cost: the first proving pass (5 skills, three of them large game-framework hubs) used 11.2M
tokens, because it read whole repos. The contract now budgets about 40 tool calls per pass, and
the job caps 45 iterations and 6M tokens a day. Check what a night cost with
`candybar history skill-sweep`.

Runtime state, not committed, lives in `~/.local/state/skillex/skill-sweep/`: `cohort.json`,
the plans and `passes/`.

## The cohort

The default size is 4 (`SKILL_SWEEP_COHORT`). Seats are filled in this order:

1. Up to 2 skills Hermes' project-tier scanner calls `dangerous`. These are regressions: a
   quarantined project copy blocks the skill everywhere. A dangerous skill already reviewed at its
   current tree is waiting on its recorded `needs-human` item, so it doesn't take a seat again
   until it changes.
2. Then two queues take turns:
   - skills edited since their last review, oldest review first;
   - skills never reviewed, shuffled with the night as the seed, so the order is random but
     reproducible.
3. Then the skills reviewed longest ago.

At 4 a night, all ~490 skills get a first review in about four months. After that, a skill
comes back as soon as it changes.

A skill holding someone else's uncommitted work is skipped that night, because the applier
commits whole skill paths. The cohort is frozen in `cohort.json` the first time it is seen
each night. A second fire that night therefore prints the same monitor output, and Hermes
skips it at zero tokens.

## Where an edit lands

| owner | agent edits | applier commits |
|---|---|---|
| catalog (wild) | `all-skills/<skill>` | all-skills, then the submodule bump in skillex |
| hub | `<checkout>/skills/<hub>` | the owning repo |
| vendored, source on a branch the checkout is on | the upstream copy | upstream, then `skillex vendor sync` and the catalog copy |
| vendored, pinned or no checkout | nothing (review only) | nothing; fixes go in notes as `needs-human` |

The applier holds an edit back, records it as `needs-human`, and commits nothing for that skill
when any of these fail:

- a changed shell script fails `bash -n`;
- a changed Python file fails `py_compile`;
- a changed JSON file doesn't parse;
- the skill still scans `dangerous`.

## Run it by hand

```bash
cd ~/code/33GOD/candybar && uv run candybar run skill-sweep --wait     # a real pass
~/.hermes/hermes-agent/venv/bin/python -I ~/code/skillex/.candybars/skill-sweep/sweep.py --monitor
~/.hermes/hermes-agent/venv/bin/python -I ~/code/skillex/.candybars/skill-sweep/sweep.py --scan <skill-dir>
```

Use `SKILL_SWEEP_STATE=/tmp/x` to preview a cohort without touching the real state.
