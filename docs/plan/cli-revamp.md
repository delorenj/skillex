# CLI Revamp

Status: ready for implementation; this document plans the work and does not claim the Node CLI is implemented.
Owner: Jarad DeLorenzo. Planned 2026-09-06; finalized 2026-09-08.
Board: Skillex (`SKRILL`), workspace `33god`.
Delivery breakdown: [CLI Revamp tickets](../tasks/cli-revamp-tickets.md).

## Outcome and decisions

Replace the Python Skillex CLI and legacy sync/provisioning scripts with one Node CLI that owns catalog operations, reference-only compositions, scope selections, reconciliation, diagnostics, vendoring, and Hermes profile projection. Migrate the shared templates and active consumers before removing the old runtime.

| Decision | Resolution | Basis |
| --- | --- | --- |
| Product scope | Full lifecycle, including management of sets, packs, and scope selections | User selected |
| Retirement boundary | All active consumers, including CommonProject/PJangler and related services | User selected |
| Background behavior | Explicit commands; retire the SSOT rescue daemon | User selected |
| Selection changes | Enable/disable updates the manifest and applies the selected scope immediately | User selected |
| Plain `sync` inside a project | Reconcile both global and nearest project roots | User selected |
| Hermes | Include existing SKRILL-8; real profile skill directory with managed child links | User selected |
| Pack semantics | Keep packs as exclusive complete loadouts; sets are composable | Default retained from current manifest contract; final question was unanswered |
| Disabling inherited skills | Add a scope-local exclusion without changing the shared source | Default chosen after final question was unanswered |
| Acquisition | Vendoring reads explicitly available local Git checkouts; no implicit clone or fetch | Preserve current operational boundary |

The ownership contract remains [ADR-0001](../architecture/ADR-0001-reference-only-skill-topology.md): `all-skills/` owns writable skill definitions; compositions reference them; each ordinary scope exposes one `.agents/skills`; supported CLI roots alias it. Hermes profiles are an explicit consumer exception: their real directory and profile-owned content survive, while Skillex manages only its recorded child links.

### Verified starting point

- The Python CLI already has a useful manifest reconciler and upstream provenance machinery. The revamp carries forward their intended behavior, not every legacy command or flag.
- The 2026-09-06 read-only sync preview resolved 46 global names and planned 46 project additions. Neither scope was modified.
- The source-only topology audit found 128 violations: 106 embedded definitions, 17 missing pack references, three off-catalog composition links, and two dangling links. This is a migration baseline, never an allowed-success baseline.
- `vendor status` currently cannot find `all-skills/sources.toml`; the prepared declaration is under `docs/vendoring/`. Source onboarding must be completed rather than reporting vendoring as already operational.
- A targeted configuration scan found 70 candidate references to Python-era skill commands, including templates, services, and multiple worktrees. This is not 70 distinct active projects; deduplicate by repository and classify active versus historical before rollout.
- The old SSOT service is installed but was inactive and disabled. CommonProject and PJangler still generate Python provisioning and sync enter hooks.
- The live board identifier is `SKRILL`; the stale local `SKIPM` binding is corrected with this plan. The Plane instance has parent issues but no native epic/issue-type API, so the epic is a parent issue carrying the descriptive `epic` label.

## CLI surface

Ship `@delorenj/skillex` with the executable `skillex`. Use TypeScript, ESM, Commander, an esbuild build, and Node's test runner. Require Node 24 or newer; test Node 24 and the installed Node 26 line. Node 24 is an LTS line ([Node release schedule](https://nodejs.org/en/about/previous-releases)). Ship compiled JavaScript, public core types, and schemas in the npm package; build output stays untracked.

| Commands | User-visible function |
| --- | --- |
| `init [--scope global\|project] [--project PATH]` | Create the selected scope's `.agents/skills.json` without replacing an existing manifest. A new project inherits global skills by default. |
| `skill list [--query TEXT]`, `skill show NAME` | Browse canonical names, descriptions, provenance, and references from sets/packs. |
| `skill create NAME`, `skill import PATH --name NAME` | Scaffold a canonical skill or import local content into `all-skills/`; record provenance and refuse an existing-name collision. Import does not delete the source. |
| `set list\|show\|create\|add\|remove` | Inspect and maintain `sets/<name>` as canonical skill references. Add/remove changes membership, never skill-definition bytes. |
| `pack list\|show\|create\|add\|remove\|verify` | Maintain reference-only pack manifests and their `skills/` links. `create NAME --version VERSION` creates a composition version; support assets stay pack-owned. |
| `enable <skill\|set\|pack> REF`, `disable <skill\|set\|pack> REF` | Change one scope's selection and immediately reconcile that scope. With no scope flag, target the nearest project manifest, otherwise global. An explicit `--scope global\|project` selects one manifest and one write target. |
| `inherit on\|off [--project PATH]` | Change project inheritance and reconcile that project without editing global selection. |
| `sync [--scope auto\|global\|project\|both] [--project PATH]` | Reconcile desired names, owned links, and supported CLI aliases. Default `auto` writes global plus the nearest project, or global alone outside a project. |
| `status`, `explain NAME` | Show desired versus actual activation and why a name is present, excluded, shadowed, or blocked, including its canonical path and CLI reachability. |
| `doctor [--sources-only]` | Check topology, manifests, aliases, provenance, and competing legacy writers. Always read-only; give concrete corrective commands. |
| `vendor list\|show\|status\|sync` | Inspect declared upstream sources, verify pinned content offline, and import an explicitly selected upstream revision into the catalog. |
| `profile list`, `profile show NAME`, `profile sync NAME --project PATH` | Inspect and reconcile a Hermes profile's real `skills/` directory from global and project selections while preserving profile-owned content. The project argument is required for profile sync. |
| `migrate [--project PATH] [--registry-root PATH] [--apply]` | Preview or explicitly apply conversion of legacy manifests, content ownership, activation roots, receipts, and links. Replaces the old rescue/relink workflows. |

Read commands provide `--json`. Mutating commands provide `--dry-run` and `--json`; `migrate` previews by default and requires `--apply` to write. `sync --dry-run --exit-code` reports drift with exit 6. Help describes the manifest and roots each command will affect. Catalog/composition commands edit source declarations; they do not fan out writes to every consumer. Consumers converge through explicit scope sync.

Do not surface slots, old `pack activate/deactivate`, a separate provision command, payload rendering/sealing, recursive runtime pack flattening, an HTML status server, a watch daemon, or arbitrary per-CLI adapter configuration. No replacement background rescue service is part of this epic.

## Shared implementation contract

### Manifest, catalog, and composition

- Keep `.agents/skills.json` and `skills.schema.json` as the selection interface. Remove `skillex.toml` from the target runtime. `sets/` is the current composition location; the old `skill-sets/` spelling is migration input only.
- Add a top-level `exclude: string[]` field. In composed mode, resolve inherited global names, then sets in declaration order, then explicit skills, then apply exclusions. Identical canonical references collapse to one binding; a canonical name resolving to different definition bytes is an error. Provenance records every contribution.
- `disable skill NAME` removes its direct entry and persists an exclusion, including when it is inherited or provided by a set. `enable skill NAME` removes that exclusion and adds the explicit canonical reference. Exclusions in global selection affect inherited content; a project may explicitly enable the canonical skill again.
- Retain `packs` with at most one entry. An enabled pack replaces the full selection, including inheritance and exclusions, while preserving the ordinary selection in the manifest for later restoration. Disable the pack to resume that ordinary selection. Reject skill/set/inheritance mutations while a pack is active rather than accepting ineffective edits. Pack include/exclude options are not supported in exclusive mode.
- A pack's manifest is its membership authority; `pack ...` maintains a reference-only `skills/` directory for whole-root alias activation. Composed mode uses a real activation directory containing canonical links. Pack verification detects manifest/link disagreement and any embedded real `SKILL.md`.
- Resolve only canonical catalog definitions in normal operation. Reject legacy external source fields, copied payload policies, and unsupported fields with a named migration action. Preserve useful set filtering/optional semantics. Missing required references fail preflight; unresolved optional references remain visible in diagnostics.
- Resolution, inspection, and sync are offline. An explicit registry root is authoritative. Preserve existing registry discovery through `PJ_SKILLS_REGISTRY_ROOT`, configured local registry caches, and the installed/discovered registry checkout during migration; report the actual selected root and searched candidates. Never silently fall through an explicitly supplied but invalid root.
- Publish a small core API from the same npm package for manifest resolution, catalog/composition inspection, planning, reconciliation, and diagnostics. PJangler consumes this core instead of duplicating resolution or importing Python scripts. CLI formatting stays outside it.

### Mutation and recovery

- Selection commands validate the proposed manifest and complete filesystem plan before any write. Under one ownership lock, reread inputs, persist intent atomically, apply links, and update receipts. Validation/collision refusal leaves the manifest and roots unchanged. If execution is interrupted after intent is saved, report partial application and make the next sync converge; never claim transaction-wide rollback that did not occur.
- Keep ownership receipts in XDG state, outside repositories. Migrate existing Python receipts explicitly; do not claim unrelated files just because their paths look managed. Hold the lock across the final read/plan/write boundary, with bounded contention and stale-lock recovery that verifies the original owner is gone.
- Add or replace owned links before removing stale owned links. Preserve foreign real directories, foreign symlinks, and installer-managed content such as project BMAD output. Reject recursive source/destination topology and revalidate directory ownership at mutation boundaries. Prune only receipt-owned links.
- Treat alias repair as part of the planned operation. Create missing aliases and retain already-correct relative or absolute aliases; do not move foreign real CLI directories aside during ordinary sync. Those require explicit migration after their contents are accounted for.
- Maintain one shared supported-alias table for sync and doctor. Preserve the current six project integrations and working global aliases, including existing Kimi/OpenClaw compatibility aliases. Generic scope sync never manages Hermes runtime overlays or unrelated retired CLI directories.
- Project-only sync still resolves global inheritance; narrowing write scope never empties the inherited map. Discover the nearest manifest from nested directories without crossing an unrelated nested Git repository. `--project` is the explicit override. Missing or ambiguous requested projects fail with a clear action.
- Hermes profile resolution is global, then project, with existing profile-owned skills winning over managed entries. Keep the real profile directory and its inode. Use separate receipts for managed children; neither profile content nor generic Hermes overlay roots become CLI aliases.

### Provenance and output

- Preserve `all-skills/sources.toml`, machine-local checkout mappings, and `.source.yaml` receipts containing upstream commit, source path, digest, and executable-mode information. The committed catalog and pack revisions are recorded in activation receipts. Missing source declarations receive a dedicated actionable diagnostic.
- `vendor status` verifies catalog content without upstream access. `vendor sync` reads committed trees from available checkouts, stages changes, checks local edits, then applies. Adopt, discard-local-edits, and prune remain explicit options; none is the default. Composition relinking belongs to `migrate` rather than a second catalog writer.
- JSON schema version 2 uses `schema`, `command`, `ok`, `exit`, `data`, and `findings`; diagnostics retain meaningful existing symbolic codes and include paths and corrective actions. Human progress goes to stderr in JSON mode. No ANSI or prose contaminates stdout.
- Preserve exit meanings: 0 success, 1 execution failure, 2 invalid configuration/arguments, 3 refused operation or violated invariant, 4 partial/optional skip, 5 lock contention, 6 detected drift, 130 interruption. Never return success for unresolved required work.

## Migration, rollout, and acceptance

1. Build the Node package alongside the Python implementation. Use existing tests as characterization evidence; port the behaviors retained above and write changed-contract tests for deliberate removals. Do not preserve obsolete semantics merely to keep a legacy test green.
2. Provide a migration inventory with per-repository and per-scope receipts. Complete upstream declarations, import remaining embedded definitions into `all-skills/`, expand legacy container inventories once, and convert packs/sets to references. Reuse identical canonical content; import different content under a source-qualified canonical name, never overwrite an existing definition. Missing or ambiguous source mappings fail that migration item and block its cutover rather than guessing or dropping skills.
3. Update CommonProject's canonical templates, propagate them through PJangler, and update PJangler init/audit/migrate to the shared Node contract. Keep a single `skills:sync` task with explicit project targeting. Remove skill enter hooks, automatic skill watch tasks, and separate provisioning tasks. Fresh bootstrap may explicitly run sync once; merely entering a directory must not mutate skills.
4. Inventory active consumers across registered project roots, active worktrees, user services, mise tasks, and launcher/config references. Deduplicate by Git repository while checking every active checkout's runtime wiring. Record historical/archived references separately; none may remain capable of invoking a legacy writer. Migrate the global root, a representative inherited project, and a Hermes profile first, then complete the recorded active-consumer checklist.
5. Publish the tested npm package, replace the installed uv entrypoint, and pin the Node dependency in consuming templates/projects. Remove the disabled SSOT service and stale launchers as part of cutover. Do not run the old and new reconcilers against the same target. Any temporary redirect shim is removed before epic closure.
6. Delete Python Skillex runtime/pack-payload machinery, legacy sync/provision/SSOT scripts, obsolete tests and fixtures, and misleading docs after consumers pass. Python scripts belonging to individual catalog skills or unrelated project infrastructure are outside this removal.
7. Update the registry-operation skills from their canonical `all-skills/` sources, installation docs, schema docs, and mise/check hooks. Commit and push each touched source repository, advance submodule pointers, and land implementation work on main. Preserve unrelated work throughout.

Required evidence includes:

- Isolated npm-package install and executable smoke tests with Python and uv unavailable; Node 24/26 checks, Linux integration checks, and macOS filesystem/CLI checks.
- CLI scenarios for init, browse, import, composition edits, immediate enable/disable, inherited exclusions, exclusive-pack restoration, and offline vendoring.
- Nested-directory discovery; global/project/both targeting; project-only inheritance; wrong or missing explicit registry roots; malformed and unsupported manifests; duplicate references and divergent canonical targets.
- Dry-run filesystem immutability; second-sync idempotency; concurrent invocations; interruption/recovery; missing and incorrect aliases; stale owned links; foreign content and reserved installer content surviving unchanged.
- Hermes global/project union, profile-owned collision precedence, removal of only stale managed links, and preservation of its real directory.
- Migration refuses ambiguous content, preserves pins/modes, and produces a clean topology report for every migrated source and target. Known baseline violations cannot be downgraded to success.
- Fresh CommonProject/PJangler bootstrap and audit, one inherited existing project, and the completed active-consumer inventory. No active command/config invokes the retired Python skill engines; no skill watcher or rescue service is left running.

The epic closes only after the Node package is installed and verified through those actual consumer paths, every child ticket has acceptance evidence, and all related source changes are landed. Ticket creation and this specification are planning delivery only.
