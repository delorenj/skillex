# Journalist lifecycle

## Reading order

| Task | Read |
|---|---|
| Add/update/remove a topic | This file |
| Reconcile cron | This file → `safety-gotchas.md` |
| Understand job prompts | This file → `investigator-workflow.md` |

## Owned jobs

- Create one `ddr:journal:<id>` Hermes cron job for every configured topic.
- Pause jobs for disabled topics; resume them when enabled.
- Keep exactly one `ddr:daily` aggregator, paused when `daily.enabled` is false.
- Fix `ddr:daily` at `0 7 * * *` in `America/New_York`; reportctl rejects other zones or aggregator schedules because Hermes has no per-job timezone flag.
- Remove managed jobs for deleted topics. Never mutate names outside `ddr:journal:` and `ddr:daily`.

## Topic commands

```bash
scripts/reportctl --config /path/report.json topic add ai-agents "AI Agents" \
  --prompt "Material agent platform releases and research" \
  --source https://example.org/releases --schedule "15 6 * * *"
scripts/reportctl --config /path/report.json topic update ai-agents --schedule "30 6 * * *"
scripts/reportctl --config /path/report.json topic pause ai-agents
scripts/reportctl --config /path/report.json topic resume ai-agents
scripts/reportctl --config /path/report.json topic remove ai-agents
```

Every mutation validates the full config and uses atomic replacement. Duplicate IDs fail without changing the file.

## Reconciliation

Use `plan` first. Supply `--jobs snapshot.json` in automation/tests, where the snapshot is an array of `{id,name,schedule,prompt,enabled,deliver,workdir}` objects. Without it, `reportctl` reads `hermes cron list --all`; if the installed output cannot be parsed safely, export a JSON snapshot rather than guessing.

The stable plan orders duplicate removals, stale removals, creates, edits, pauses, and resumes by job name and ID. `reconcile --apply` maps actions to `hermes cron create|edit|pause|resume|remove` and sets `HERMES_TIMEZONE=America/New_York` for every Hermes invocation. Re-running against resulting state must produce an empty plan.

Journalist prompts name the reporting window, sources, three investigator roles, exact section path, and contract. Aggregator prompts validate every expected section, mark stale/missing manifest entries, and archive JSON plus Markdown.
