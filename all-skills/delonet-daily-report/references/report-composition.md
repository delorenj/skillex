# Report composition

## Reading order

| Task | Read |
|---|---|
| Emit section JSON | This file → `../assets/contracts/section-artifact.schema.json` |
| Aggregate a run | This file → `../assets/contracts/run-manifest.schema.json` |
| Render report | This file → `../assets/default-core-sections.json` → `../assets/contracts/daily-report.schema.json` |

## Composition lifecycle

1. Enumerate every configured core section and topic; never infer coverage from files on disk.
2. Validate each `SectionArtifact` and its expected topic ID.
3. Mark stale when `fresh_until` precedes aggregation time, the window is wrong, or the file belongs to another run date.
4. Write `RunManifest` with an entry for each expected section, including missing, invalid, stale, partial, and complete states.
5. Compose in default core section order, then configured topic order.
6. Render Markdown and structured `DailyReport`; archive both atomically with `reportctl archive --report REPORT.json --markdown REPORT.md`.

## Editorial rules

- Lead with material changes and explain why they matter.
- Cite every externally verifiable claim; preserve source metadata in structured output.
- Distinguish fact, source claim, and inference.
- Show stale/missing sections in “Coverage and freshness” instead of silently dropping them.
- Avoid repeating an event across sections; choose a primary section and cross-reference briefly.
- Say “No material update” only when sources were successfully checked.

Copy shipped defaults into required `core_sections` configuration. The aggregator prompt uses that exact ordered list. Operators may add or rename sections, but retain explicit coverage/freshness.
