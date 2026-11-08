---
title: 'SKRILL-20: Receipt-safe native profile cutover'
type: 'bugfix'
created: '2026-10-20'
status: 'ready-for-dev'
review_loop_iteration: 0
context: []
approval_actor: 'skillex-pm'
approval_basis: 'Delegated native correction authority; Pillars 1, 2, 3. No merge/deploy approval.'
---

<frozen-after-approval reason="operator-owned bounded intent; PM-authorized execution, no rollout">

## Intent

**Problem:** Strict profile inspection refuses foreign content before computing desired managed state. The Python cutover treats `managed:null` as zero owned children and would quarantine 107 exact receipt-owned links along with four foreign directories. A stale receipt project also makes implicit selection unsafe.

**Approach:** Reuse native receipt validation and ownership primitives independently of desired-state resolution. Preflight an explicit intended selection, preserve only foreign objects under the same native ownership concurrency boundary as ordinary sync, and retain recoverable, hash-verified quarantine evidence.

## Boundaries & Constraints

**Always:** Source work only in `/home/delorenj/code/skillex/.worktrees/skrill20-native-cutover`; catalog content only in that checkout's isolated `all-skills/` worktree. Preserve others' WIP. Parent owns existing SKRILL-20 and all board/lease transitions. Use codex exec for implementation, sandbox workspace-write; installed CLI supports no `--full-auto`. Scratch under `/home/delorenj/.hermes/profiles/skillex-pm/cache/scratch`. Evidence under `/home/delorenj/code/skillex/agents/hermes/pm/runtime/cutover-evidence/47b99b3e`. Record full Git revisions and real commands/results.

**Always:** Validate bound receipt schema/path, root device/inode and every claimed child's device/inode/raw link target, including absent/replaced claims. Desired managed state is not ownership. Pending/malformed ownership and any ambiguous claim fail closed. Validate intended selection independently before any preservation; do not infer it from the stale receipt association. Preserve exact owned links throughout quarantine. Coordinate with **ordinary native profile sync**, not solely the resync timer's private flock. Native ownership lock must cover final validation, preservation and subsequent native reconciliation; no unlocked gap or nested-lock deadlock. Minimal lock-held internal seam extraction is authorized when needed, not a redesign.

**Always:** Quarantine outside all discovery roots. Durable intent/completion journal, byte/hash evidence, and interrupted-operation recovery must prevent unjournaled loss, overwrite, or silent retry. Preserve root identity, payload bytes and raw links. Renderer remains config owner; unrelated config drift refuses. Fixture proof only; no live apply. Source/catalog changes may be committed locally on isolated branches for a verifiable revision, never merged/pushed/published. Do not move main source or main catalog HEAD (catalog moves trigger fleet resync).

**Ask First:** Real ambiguity that changes operator selection or broadens product/host scope; report genuine blockers rather than weakening acceptance.

**Never:** Touch any real profile/service, `pile-of-dumb-things-pm`, `tower-of-lost-things`, its activation roots or TOWE board; start game work; restart/kill/steal leases; fleet rollout/deploy; root adopt, manual profile links, receipt edits, removal of strict markers, or ownership inferred from targets/names. Do not mutate shared Hermes configuration or repair BMAD tooling.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected behavior | Failure handling |
|---|---|---|---|
| Incident fixture | Strict refusal, managed:null, valid107 links, four foreign dirs, stale project | Preview owns107; preserves only autonomous-ai-agents, delivery, delonet, intake | No live paths |
| Identity drift | Root/claimed link missing, replaced or retargeted | Refuse before preservation; changed bytes untouched | Cause named |
| Bad ownership | Missing/malformed receipt, pending recovery, unrelated refusal | Fail closed, no implicit adoption | No quarantine |
| Bad intended selection | Explicit project cannot resolve, real or alias root | No preservation/config/receipt writes | Actionable refusal |
| Concurrent native writer | Same native lock held or contested during cutover | One owner; ordinary sync cannot interleave | Bounded busy/refusal |
| Interrupted preservation | Failure before/after rename or journal update | Durable recovery evidence; safe deterministic retry/recovery or explicit refusal | No loss/overwrite |
| Successful fixture | Verified preserved foreign bytes outside roots | Native strict sync converges; repeat sync no-op | No unexpected changes |

</frozen-after-approval>

## Code Map

- `scripts/hermes-skillex-cutover.py:199-210`: unsafe managed-derived ownership. `plan_root`/`preserve_root:55-108` existing fingerprints/rename journal; durability and concurrency NOT yet proven.
- `src/core/profile-sync.ts:221-275,393-462`: observations classify exact claims; strict assertion precedes buildWork and leaves managed null. `:830-873`: native withLock sync entry; bounded lock-held extraction allowed.
- `src/core/profile-state.ts:85-196`: validated profile-specific receipt, root identity and pending state. `activation-ownership.ts:45-77`: entry/identity/matches. Do not confuse activation receipt validation with profile schema.
- `src/core/profile-types.ts:89-97`, `profiles.ts`, `src/core/lock.ts`: result/API and actual native profile lock resource `skillex:profiles:v2:<skillsRoot>`; non-reentrant.
- `tests/node/profile-fixture.mjs`, `profile-sync.test.mjs`, `profile-cli.test.mjs`; `tests/unit/test_hermes_skillex_cutover.py`: existing isolated tests. Main-level end-to-end regression missing.
- `docs/implementation/hermes-skillex-resync.md`: operational guidance; canonical `all-skills/skillex-skill-registry/SKILL.md` and `references/gotchas.md`: unsafe unconditional cutover recommendation.
- Read-only incident receipt: `/home/delorenj/code/33GOD/flume/agents/hermes/pm/runtime/repair-evidence/towe10-platform-prerequisite-20261020/receipt.json`. No need to re-inspect target profile.

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/profile-*.ts` and minimal associated CLI/export seam: validated receipt-derived ownership survives strict refusal; cutover shares native ownership critical section with sync.
- [ ] `scripts/hermes-skillex-cutover.py`: explicit selection gate, fail-closed identity/refusal checks, accurate preview, locked preservation/reconciliation, durable journal/recovery and hash proof. Preserve alias/config protections.
- [ ] `tests/node/profile*.mjs` and `tests/unit/test_hermes_skillex_cutover.py`: real end-to-end107/four/stale-project fixture and every matrix row, including native concurrency and fault injection. Do not only mock claimed JSON.
- [ ] `docs/implementation/hermes-skillex-cutover.md` or existing scoped doc, plus isolated canonical operational skill files: document actual supported contract and managed:null pitfall, recovery, no rollout authority.

**Acceptance Criteria:**
- Given incident fixture, when preview/apply runs in isolation, then only four foreign directories are quarantined and107 exact owned links retain identity through preservation.
- Given invalid selection/ownership or changed identities, when invoked, then preservation refuses without changing payload/config/receipt bytes.
- Given ordinary native sync competes, when cutover owns its critical section, then no native writer can interleave; verify contention, not merely a timer lock.
- Given injected interruptions, when inspected/retried, then journal proves each object's location/content and safe recovery/refusal; all foreign hashes and links match.
- Given successful fixture cutover, when repeated strict sync runs, then no managed changes remain; explicit intended selection supersedes stale association.
- Given canonical skill update, when read, then managed:null is never zero ownership and neither fixture PASS nor preview authorizes live/fleet apply.

## Spec Change Log

- PM corrected planning shortcut before implementation: resync flock/re-show is insufficient for native concurrency; existing non-fsynced journal is not proven durable. Restore full original acceptance, allow bounded lock-held seam, require fixture concurrency/fault/recovery proof. Main/catalog isolation and source-only scope remain.

## Design Notes

Prefer existing validated receipts and native locking. No supported zero-source path found: migration leaves foreign children; marker edit/adoption/manual quarantine are prohibited. Pattern: reuse existing Command entry and native critical-section boundary; no new speculative framework. Fresh SPEC then QUALITY reviewers are separate workers; neither gate can be self-cleared. PM approval is planning authority under Pillars1 bounded product prerequisite,2 platform-native correction,3 minimal seam; not merge approval.

## Verification

- `npm run check`: lint/type/build/full Node suite; record baseline failures separately.
- Build before targeted `node --test tests/node/profile-sync.test.mjs tests/node/profile-cli.test.mjs`.
- Run cutover pytest using available interpreter with pytest/yaml; no shared dependency repair. Include real CLI fixture preview/apply/repeat and fault/concurrency probes.
- Evidence: command logs, full source/catalog revisions, changed-file manifest, AC/test matrix, preservation hashes, remaining limits. Main HEADs unchanged. Stop after implementation handback for independent gates; no merge or remote operations.
