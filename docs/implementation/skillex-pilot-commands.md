# Command-driven Skillex integration pilot

User authority: sets exclusively replace the canonical skill root; packs add
member links. The manifest selects a set with optional `"set": "name"` string,
not `sets: []` or an object. `packs` remains an array. Legacy `sets` declarations
are explicit normalization/migration input, never current writer output. All skill-operation mise tasks are retired, not repinned.
Holocene is the sole accepted live pilot. LifeLaunch was rejected as a throwaway
demo; its earlier task retirement is not pilot acceptance.

## State and command vocabulary

| Observed state | Repeatable remedy | Preservation boundary |
| --- | --- | --- |
| Skill-operation mise task or caller | `skillex integrations retire-mise --project PATH` then `--apply` | Unrelated tasks/config stay unchanged |
| Unowned canonical child links | `skillex root adopt --project PATH` then `--apply` | Canonical definitions, manifests and aliases unchanged |
| Renamed/broken child | Add `--map OLD=NEW` to root adoption | Explicit mapping only; original root quarantined |
| Old installer-owned skill family | Add paired `--replace-pack NAME@VERSION --replace-prefix NAME-` | User-approved semantic replacement; entire original retained outside discovery |
| GitHub skill subtree URL needing canonical import | `skillex import URL` | Direct copy with provenance, no fork and no activation |
| URL needing import plus activation | `skillex add URL [-p PATH|-g]` | Project by default inside a repo; global outside; existing canonical content reused |
| Skill root/path/repository needing a composition | `set create NAME --from-root PATH` / `pack create NAME --version VERSION --from SOURCE` | Compare same-name content; missing definitions need explicit `--import`; source never executed |
| Set selection | `enable set NAME --project PATH` or `enable set NAME -g` | Switch one scope's canonical root; foreign root refuses |
| Pack addition | `enable pack NAME@VERSION --project PATH` | Compose member links; derive a scope-owned set when base is shared |
| Verbose or legacy manifest | `normalize --project PATH [--base-set NAME]` then `--apply` | No widening; preserve inherited members; ambiguous legacy pack intent refuses |
| Agent still sees global-only skills | `clients isolate --client opencode --project PATH` then `--apply` | Own project permission rules only; conflicting foreign rules require explicit decision |
| Need runtime proof | `clients verify --client opencode --project PATH --session ID --agent build` | Evaluate real permission service, canonical paths and advertisement metadata; no inference |

Preview is default for adoption, normalization, client isolation and mise
retirement. Selection changes and composition edits need `--dry-run` explicitly.
`pack add REF MEMBERS...` edits pack membership; `enable pack REF` selects it.

## Pilot baseline (2026-10-11)

Holocene's `.agents/skills.json` inherits globally with no individual selections.
Its real root contains 129 children: 64 canonical symlinks (one broken `liam`)
and 65 BMAD installer directories. Six client roots alias it. Local `_bmad/`
customization must remain byte-for-byte unchanged.

Content comparison found 27 BMAD definitions identical except provenance, 17
with upstream version differences, and 21 deprecated forwarding stubs absent
from the catalog. User approved replacing that old family with frozen
`bmad@6.12.1-next.1`, preserving the entire original root. This does not authorize
upgrading BMAD from npm or rewriting `_bmad/`.

The old pinned `skills:sync` mise task was removed through the CLI and published
in Holocene commit `3b6f386`; parent pin updated in `33GOD` commit `e959f6f`.
Global and pilot skill roots were unchanged at this stage.

## Verification gates

1. Full Node lint/types/fixture suite, including installed-package declarations.
2. Root-cutover interruption, archive/receipt recovery and foreign-content tests.
3. Two-consumer derived-set isolation and failure-before-save tests.
4. Legacy normalization apply, inherited-membership and dormant-pack refusal.
5. Actual Holocene preview/apply/no-op using an installed package, not shell links.
6. OpenCode actual permission evaluation in Holocene and an untouched control.
7. Global/shared-source fingerprints and `_bmad/` content unchanged.

A permission-filtered skill set is not the same as `/api/skill` registration.
OpenCode 2.0.26 may truncate large JSON stdout to pipes; the CLI probe captures
regular-file output with a bounded subprocess deadline. Other clients are not
certified by OpenCode verification.

## Current limits

Retained Python code is migration evidence, not the corrected writer. No fleet
rollout, automatic consumer cutover, or system-global binary replacement follows
from passing fixtures. Old exclusive-pack roots refuse normalization until their
formerly dormant declarations receive an explicit membership decision. Quarantine
is durable recovery content, even when stored beside XDG migration receipts; do
not treat it as a disposable cache.

## Live progress (2026-10-11)

The installed pilot-only 0.3.0 CLI completed Holocene root adoption with explicit
BMAD replacement and `liam=liam-dev`. The original 129-entry root is retained at
`~/.local/state/skillex/migrations/v2/1c4e6c91c1a2fddcc6c8827c4ba37807f252f59508b995e03dc1df717fa4b7fa.root-cutover-1155b553-a785-4001-8c83-32eaa04eea6a-old`.

Root replacement and CLI normalization produced 121 preserved/current members,
one derived `min-global-91a161` set and two packs: `bmad@6.12.1-next.1` and
`holocene-extras@1.0.0` (14 previously local non-BMAD members). Normalize and
sync repeated with zero changes; global root identity and links stayed unchanged.

User then corrected the manifest spelling: the canonical field is optional
`set: string`. The schema, CLI, and normalization now implement that contract;
legacy `sets` is migration-only input. Holocene's live manifest was converted
through `normalize --apply`:

```json
{"set":"min-global-91a161","packs":["bmad@6.12.1-next.1","holocene-extras@1.0.0"]}
```

Root target, membership, and both repeat previews (normalize and sync) are
unchanged after conversion. The published, singular Holocene manifest is
`{"set":"min-global-91a161","packs":["bmad@6.12.1-next.1","holocene-extras@1.0.0"]}`
(Holocene `cbead4a`, parent `857882e`).

Live acceptance of the acquisition commands used the exact user URL against the
installed pilot-only CLI: `import` copied only the `skills/diagram-design`
subtree (SKILL.md, assets, references, scripts) into `all-skills/diagram-design`
with sanitized `url#commit` provenance; a repeat reported reuse without fetching.
`add --project /home/delorenj/code/33GOD/holocene` reused the canonical skill
(zero network), extended the scope-owned derived set by one member, and left the
manifest as `skills:["diagram-design"]`; the second add was a write-free no-op,
and normalize/sync repeats stayed empty. Skillex `9e88e5f`, Holocene `2f9371f`,
parent `f2a70f6` published the results. OpenCode isolation was applied with the user-authorized
`--override-permissions` (global allow-all preserved byte-for-byte; Holocene's
project `opencode.json` owns 123 deny/allow rules). Runtime verification through
the actual permission evaluator, using a fresh post-reload probe session, gave
exit 0: 179 skills registered, 180 permission checks, all expectations met —
122 selected skills advertised and permitted, all non-selected IDs (57) plus the
synthetic sentinel denied. An untouched control project still evaluates allow,
and the repeat isolate preview is empty. The earlier probe session predating the
location reload was correctly rejected rather than trusted.

## Review repairs (2026-10-11)

Reproduced failures, not fixture counts, drove fixes: tolerant legacy reads now
reach the manifest write boundary; legacy folds retain inherited members;
exclusive-pack aliases refuse dormant-intent reinterpretation; conflicting pack
versions refuse instead of dropping one; profile receipts accept set source
revisions. Derived membership and save-before-mutation repairs have dedicated
regressions. Client transport captures regular-file JSON with a hard deadline.
Completed cutover reports missing archives separately from missing ownership,
without falsely claiming the original is still preserved.
