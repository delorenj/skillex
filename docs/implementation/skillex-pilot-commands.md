# Command-driven Skillex integration pilot

User authority: sets exclusively replace the canonical skill root; packs add
member links. All skill-operation mise tasks are retired, not repinned.
Holocene is the sole accepted live pilot. LifeLaunch was rejected as a throwaway
demo; its earlier task retirement is not pilot acceptance.

## State and command vocabulary

| Observed state | Repeatable remedy | Preservation boundary |
| --- | --- | --- |
| Skill-operation mise task or caller | `skillex integrations retire-mise --project PATH` then `--apply` | Unrelated tasks/config stay unchanged |
| Unowned canonical child links | `skillex root adopt --project PATH` then `--apply` | Canonical definitions, manifests and aliases unchanged |
| Renamed/broken child | Add `--map OLD=NEW` to root adoption | Explicit mapping only; original root quarantined |
| Old installer-owned skill family | Add paired `--replace-pack NAME@VERSION --replace-prefix NAME-` | User-approved semantic replacement; entire original retained outside discovery |
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

Live root cutover and runtime proof remain outstanding until recorded below.

## Review repairs (2026-10-11)

Reproduced failures, not fixture counts, drove fixes: tolerant legacy reads now
reach the manifest write boundary; legacy folds retain inherited members;
exclusive-pack aliases refuse dormant-intent reinterpretation; conflicting pack
versions refuse instead of dropping one; profile receipts accept set source
revisions. Derived membership and save-before-mutation repairs have dedicated
regressions. Client transport captures regular-file JSON with a hard deadline.
Completed cutover reports missing archives separately from missing ownership,
without falsely claiming the original is still preserved.
