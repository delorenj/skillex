---
title: 'Stitch UX ideation integration'
type: 'feature'
created: '2026-11-01'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Install the official Stitch CLI and make it a reusable UX ideation producer in the existing 33GOD pipeline. Define `/stitch` once in `all-skills/stitch`, reference it from `sets/min-global`, route from `33god-hub`, and let BMAD UX's existing design handoff delegate to it. Captured intent leads to screens/variants, an explicit user selection, and reference artifacts that feed BMAD's authoritative DESIGN.md and EXPERIENCE.md; generated markup is not implementation authority.

Preserve all pre-existing WIP. Installation is not authorization to upload product data, generate remote screens, enable Stitch workspace loops, change event schemas, or roll out fleet profiles. Validate locally and with dry-run commands; report authentication as configured-but-unverified until an authenticated read succeeds. Keep credentials environment-only or 1Password-backed. Use supported Skillex commands to preview then add canonical membership; activate only the requested skill, never switch the user's global selection to min-global. Record the cross-component handoff in the platform changelog and a read-only drift check. Land this task's source changes and parent pins without absorbing unrelated edits.

</frozen-after-approval>

## Implementation Notes

- Discovery: official `@google/stitch@0.12.1` installed at `~/.local/bin/stitch`. Package skill reviewed as reference, not installed into discovery roots. Existing env credential is present but unverified; no remote generation or login run.
- Canonical owners: all-skills/stitch; all-skills/bmad-ux/SKILL.md + customize.toml; all-skills/33god-hub/SKILL.md. The existing bmad-ux handoff was manual. Add a supporting local Stitch reference and mark modified freeze provenance.
- Membership: `skillex set add min-global stitch` preview/apply. Current global manifest selects explicit skills, not min-global; preview adding only stitch rather than replacing a set or changing unrelated membership.
- Control plane: 33god-platform changes/ entry, CHANGELOG.pipeline.md and bounded backfill check under its existing runner; no bus changes, scheduling, or profile rollout.
- Verification: installed CLI help, screen/variant dry-runs, portable metadata and link checks, BMAD customization parsing, reference-only topology, platform validation/backfill, independent content review, final scoped git status and git unpushed report. Global unrelated dirt is reported, not committed.
- User selected preserving WIP and continuing at the dirty-checkout gate. Other session landed bmad-build repair and parent pin checkpoint separately; no edits to bmad-build here.
- Implemented canonical skill, hub routing, BMAD CLI/manual handoff and min-global membership. Nine offline contract tests pass; screen/variant dry-runs pass. Repeat membership preview plans no changes.
- Global activation preview REFUSED before mutation: E_OWNERSHIP_CHANGED at ~/.agents/skills/delonet-parental-controls. Preserved the entry and existing global selection; not claiming global/fleet activation. Source doctor exits 6 on existing and intentionally modified upstream provenance; no topology errors observed. Unrelated activity-report whitespace finding preserved.
- Advisor skill/command is not available in this session. Used the required independent same-model content review instead; no other review layers configured.

## Review Triage Log

- medium / patch: publication approval was implicit. Added separate public-delivery approval and private-file fallback; covered by offline contract test.
- medium / patch: promotion could invalidate provenance paths. Preserve original exports, promote copies, update handoff and append memlog event; covered by test.
- medium / patch: manual fallback lacked CLI-only metadata. Accept user-provided Canvas links and mark unavailable version/IDs explicitly; covered by test.
- low / patch: hub discovery description omitted new routing. Added Stitch UX ideation and BMAD handoffs without staging unrelated portability edits.
- medium / patch (platform): missing external source could be hidden by a forbidden match; retain NOT VERIFIED plus all findings. Added regression fixture.
- medium / patch (platform): absolute/parent/symlink escapes could certify files outside the declared source. Constrain resolved paths to external_root; added three escape fixtures.

## Delivery Verification

- Catalog landed/pushed on main: 5c73d31e411f581b6f96abcac6b381a27ffbee59. Skillex initial selection checkpoint: 25ab28197e5fd54ffc15aa3c9f5cb26f788dd0f1. Platform integration commit: 9489bb1 (33GOD owner repo).
- Final focused suites: nine Stitch handoff tests and six platform backfill tests pass. Platform manifest validates; live bounded source check reports OK skillex-stitch-ux-handoff-v1. Source doctor reports zero errors and no Stitch findings, but 26 upstream provenance warnings remain outside this slice.
- Whole platform backfill run remains nonzero for existing STALE gitignore-global-policy-v1 (`pjangler/.gitignore` contains `!.claude/`). Broader unittest discovery runs 16 tests with one import error in untouched test_enricher_llm: ModuleNotFoundError: No module named 'fastapi.concurrency'; 'fastapi' is not a package. Other 15 pass. Do not call the whole platform suite clean.
- Required git unpushed sweep reports unrelated dirty/unpushed/detached repositories throughout ~/code. Preserve these per the explicit WIP decision; task commits are pushed, but the machine-wide report is not clean. The stale platform-local skills/33god-hub copy is also left for an ownership migration, not silently treated as canonical.
