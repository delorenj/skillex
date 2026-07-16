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

Use `plan` first. Supply `--jobs snapshot.json` for read-only planning, where snapshots may be an array or native Hermes `{jobs:[...]}` with nested schedules. `reconcile --apply` rejects snapshots, takes a profile-scoped lock, refreshes `$HERMES_HOME/cron/jobs.json`, and only then computes mutations.

The stable plan orders duplicate removals, stale removals, creates, edits, pauses, and resumes by job name and ID. Managed jobs attach `delonet-daily-report` with `--skill`; apply preflight requires that skill under the active `$HERMES_HOME/skills`. Applying also requires the active profile’s `config.yaml` (or gateway environment) to declare `America/New_York`; Hermes bridges that profile setting into its DST-aware scheduler. `reportctl` refuses an unset or different observable timezone.

Journalist prompts name the reporting window, sources, three investigator roles, exact section path, and contract. Aggregator prompts validate every expected section, mark stale/missing manifest entries, and archive JSON plus Markdown.
