---
title: Correct Skillex integration through one repeatable pilot
type: bugfix
created: 2026-10-10
status: draft
review_loop_iteration: 0
context:
  - AGENTS.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Skillex implements reversed set/pack semantics. Faulty writers create stale roots, duplicate inherited skills and verbose manifests; manual repair leaves recurrence intact.

**Approach:** Correct selection and activation, encapsulate reusable remediation commands, and dogfood them on LifeLaunch only. Every violation gets a stable diagnostic, cause explanation and invocable remedy. Iterate until this pilot is correct before rollout.

## Boundaries & Constraints

**Always:** Sets exclusively replace canonical roots; packs add member symlinks. Definitions live in `all-skills/`. Project operations preserve global roots. Adding a pack to a shared set derives a scope-owned reference-only set and switches only that scope (user decision). Preserve foreign content, receipts, recovery and unrelated WIP. Simplification preserves effective membership and provenance; repeated global membership becomes a global-set reference.

**Ask First:** Destructive retirement, ambiguous identities/membership, or rollout beyond the pilot. Unsupported client isolation is a capability failure, not authorization to change global discovery.

**Never:** Hand-edit pilot JSON/links as remediation; choose the first of multiple sets; write through shared-set aliases; mistake passing legacy tests for correctness; mutate other projects or fleet profiles.

## I/O & Edge-Case Matrix

| State | Behavior |
| --- | --- |
| One set | Root links to set skill root; project set replaces inherited selection |
| Multiple packs | Deduplicated member links; existing real-root identity preserved |
| Pack atop shared set | Derive/select scope-owned set; other consumers unchanged |
| Multiple sets / old pack-root alias | Diagnose legacy meaning; explicit CLI normalization, never silently awaken dormant intent |
| Individual global/group members | Exact membership-preserving replacement with set/pack references; residual skills retained |
| Broken/foreign/local entry | Inventory; explicit import/mapping/preservation, never guessed renames or deletion |
| Project set plus global scanner | Supported project-local discovery control; unsupported clients reported honestly |
| Interrupted/repeated command | Recover saved intent; write-free repeat; honest partial results |

</frozen-after-approval>

## Code Map

- `src/core/{selection,manifest,resolution}.ts`, `skills.schema.json`: inverted cardinality and singular pack; update shared contracts together.
- `src/core/reconciliation.ts`, `activation-*.ts`: reuse journaled transitions/ownership. Verify each pack against its own members, not the whole scope.
- `src/core/selection-{commands,manifest}.ts`: snapshot-safe manifest transaction.
- `src/core/{composition-mutation,sets,packs,catalog-write,vendor-git}.ts`: reference/import primitives; existing sets have flat roots, not necessarily `skills/` children.
- `src/core/{migration-*,diagnostics*,profile-*}.ts`: retain legacy receipt readability; Hermes keeps its real per-profile projection.
- `src/commands/{selections,compositions}.ts`, `src/{cli,index}.ts`: CLI/API/scope plumbing.
- `tests/node/`: retain preservation/recovery tests; replace reversed semantic expectations.

## Tasks & Acceptance

**Execution:**
- [ ] Correct schema, resolver, reconciler and diagnostics end-to-end. Add typed command objects with plan/apply/verify around existing primitives, not a replacement transaction framework.
- [ ] Make `enable set` switch roots; `enable pack` add independently. Add consistent `-g/--global`, global-root invocation and conflicting-selector refusal. Keep `pack add REF MEMBERS...` for composition membership.
- [ ] Extend `set create` / `pack create` with `--from-root PATH` and repeatable `--from SOURCE` (paths or Git repos). Acquire remotely only when explicitly requested; pin commit/provenance; reject conflicts; never execute imports. Sync stays offline.
- [ ] Implement `normalize [--project PATH|-g] --dry-run|--apply`: inventory, deterministic exact-membership grouping, derivation, safe activation and machine-readable remedies. Read invalid legacy states even when ordinary sync refuses them. Explicit mapping/preservation commands handle broken or unowned roots; no registry-wide migration shortcut.
- [ ] Implement project-set client capability adapter, first OpenCode. Preserve sibling settings; verify effective advertisement/loading, not merely raw discovery. Report other clients as supported only with evidence.
- [ ] Review and land small increments, install through existing package workflow, then dogfood exclusively on `/home/delorenj/code/LifeLaunch`. Update docs/skills from observed behavior.

**Acceptance Criteria:**
- Given two scopes sharing a set, when one adds a pack, then it switches to a derived set and shared source/other consumer remain unchanged.
- Given isolated global/project fixtures, when `-g` selects a set, then only global changes; when project selects a set, then global identity/content remain unchanged and supported-client visibility excludes global-only skills.
- Given legacy manifests/stale roots, when normalization previews/applies, then every membership/preservation change is explicit, refusal is write-free, and repeat preview is empty.
- Given LifeLaunch's inherited manifest, 66 links and broken `liam`, when CLI remedies run, then retained skills are accounted for, tested-client discovery has no duplicates, and unrelated project/global state is unchanged.

## Spec Change Log

## Design Notes

Test global operations in isolated homes first. Derived sets record ownership/base membership. Resolve global-set identity explicitly while the global manifest is invalid. `inherit_global: false` alone cannot suppress client discovery. Preserve LifeLaunch's untracked transcript.

## Verification

- `npm run check`: corrected contracts plus preservation/recovery tests.
- Installed CLI fixtures: creation, normalization, scope isolation, no-op repeats.
- Pilot: before/after effective visibility, shared/global fingerprints, CLI transcript.
- Scoped `git unpushed`: publish task commits; preserve unrelated findings.
