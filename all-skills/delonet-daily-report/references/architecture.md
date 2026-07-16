# Architecture

## Reading order

| Task | Read |
|---|---|
| Learn components and ownership | This file → `report-composition.md` |
| Change scheduler behavior | This file → `journalist-lifecycle.md` |
| Change config or artifact shapes | This file → `../assets/contracts/*.schema.json` |

## Data flow

```text
JSON config (source of truth)
  ├─ ddr:journal:<topic-id> (durable Hermes cron, one per enabled topic)
  │    └─ three ephemeral investigators, batched when available
  │         └─ SectionArtifact JSON
  └─ ddr:daily (one durable Hermes cron)
       ├─ validates freshness and contracts
       ├─ writes RunManifest JSON
       └─ composes + archives DailyReport
```

Use configuration to derive desired jobs. Reconciliation compares desired jobs with a Hermes snapshot, removes duplicate managed jobs, edits drifted jobs, and removes stale managed names. Never alter jobs outside the `ddr:` namespace.

## Filesystem contract

Resolve `artifact_dir` and `archive_dir` from the operator-owned config:

```text
<artifact_dir>/<YYYY-MM-DD>/sections/<topic-id>.json
<artifact_dir>/<YYYY-MM-DD>/run-manifest.json
<archive_dir>/<YYYY>/<MM>/<YYYY-MM-DD>.md
<archive_dir>/<YYYY>/<MM>/<YYYY-MM-DD>.report.json
```

Write producer artifacts atomically. A partially written artifact is invalid, never best effort.

## Contract ownership

- `SectionArtifact`: one journalist run, one topic, evidence-backed findings and explicit freshness.
- `RunManifest`: aggregator audit trail covering every configured core section and topic.
- `DailyReport`: final structured report plus rendered Markdown archive path.

Treat JSON Schemas in `assets/contracts/` as normative. Keep prose subordinate to those contracts.
