# CLI Revamp tickets

Created and verified 2026-09-08 in Skillex (`SKRILL`), workspace `33god`.

**Epic: [SKRILL-9 — CLI Revamp](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/dd33b6f7-da3b-4a42-a4fa-94518ea341e9).**

Thirteen child stories: twelve new Backlog issues plus the existing SKRILL-8, whose original request, Todo state, and urgent priority are preserved. The epic is represented as a parent issue with the descriptive `epic` label because native issue types are unavailable on this Plane instance.

The [specification](../plan/cli-revamp.md) defines the retained behavior, new interfaces, defaults, and retirement gates. Implementation has not begun. Dependencies are recorded as clickable issue links in each description; these are not native blocker relations.

| Order | Ticket | Priority | Size / points | Depends on |
| --- | --- | --- | --- | --- |
| C01 | [SKRILL-10 — Build the Node CLI package and shared core entrypoint](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/62db948d-a9c0-4818-b3ac-06605716dd01) | high | M / 3 | None |
| C02 | [SKRILL-11 — Implement canonical manifest resolution and inheritance](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9) | high | L / 8 | [SKRILL-10](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/62db948d-a9c0-4818-b3ac-06605716dd01) |
| C03 | [SKRILL-12 — Add catalog discovery, skill scaffolding, and local import](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/045f95d2-2d6c-4bb7-9d8e-a7045be76e24) | medium | M / 5 | [SKRILL-11](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9) |
| C04 | [SKRILL-13 — Manage reference-only sets and versioned packs](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/2db60d04-477e-448a-bdd0-d04eaf3f0859) | medium | M / 5 | [SKRILL-11](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9), [SKRILL-12](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/045f95d2-2d6c-4bb7-9d8e-a7045be76e24) |
| C05 | [SKRILL-14 — Implement owned-link reconciliation and CLI aliases](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a548274f-a4d9-4625-8920-f25fd1ac63d3) | high | L / 8 | [SKRILL-11](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9) |
| C06 | [SKRILL-15 — Add immediate selection and inheritance commands](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a3480478-25a3-4e26-a869-ba8e8a2cbb21) | high | M / 5 | [SKRILL-13](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/2db60d04-477e-448a-bdd0-d04eaf3f0859), [SKRILL-14](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a548274f-a4d9-4625-8920-f25fd1ac63d3) |
| C07 | [SKRILL-16 — Provide status, explanations, and topology diagnostics](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/237ec990-0c2e-40b6-9701-14e267817396) | high | M / 5 | [SKRILL-11](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9), [SKRILL-14](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a548274f-a4d9-4625-8920-f25fd1ac63d3) |
| C08 | [SKRILL-17 — Port offline upstream vendoring and provenance](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/5f44fcce-d606-4723-96ca-230fb05d9132) | high | L / 8 | [SKRILL-11](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/9f99f363-1d09-422a-a98b-8330610f4bc9), [SKRILL-12](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/045f95d2-2d6c-4bb7-9d8e-a7045be76e24) |
| C09 | [SKRILL-8 — Sync Hermes profile skills from global and project selections](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/04fa44fa-7312-4d91-8e80-5506f22082d4) | urgent | M / 5 | [SKRILL-14](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a548274f-a4d9-4625-8920-f25fd1ac63d3), [SKRILL-16](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/237ec990-0c2e-40b6-9701-14e267817396) |
| C10 | [SKRILL-18 — Migrate legacy catalog, compositions, and ownership receipts](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/f29575b7-2222-471a-a336-19b14cf15821) | high | L / 8 | [SKRILL-13](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/2db60d04-477e-448a-bdd0-d04eaf3f0859), [SKRILL-16](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/237ec990-0c2e-40b6-9701-14e267817396), [SKRILL-17](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/5f44fcce-d606-4723-96ca-230fb05d9132) |
| C11 | [SKRILL-19 — Replace CommonProject and PJangler skill-engine integration](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/407575dc-2ef0-42e1-ad5c-972751dd3390) | high | L / 8 | [SKRILL-14](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a548274f-a4d9-4625-8920-f25fd1ac63d3), [SKRILL-15](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a3480478-25a3-4e26-a869-ba8e8a2cbb21), [SKRILL-16](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/237ec990-0c2e-40b6-9701-14e267817396), [SKRILL-8](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/04fa44fa-7312-4d91-8e80-5506f22082d4) |
| C12 | [SKRILL-20 — Install the Node CLI and cut over every active consumer](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/7782d08d-5994-4021-b155-c241c0348aca) | high | L / 8 | [SKRILL-18](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/f29575b7-2222-471a-a336-19b14cf15821), [SKRILL-19](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/407575dc-2ef0-42e1-ad5c-972751dd3390) |
| C13 | [SKRILL-21 — Remove legacy Python skill engines and prove retirement](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/1fc06148-b135-4151-bded-2bd54dc3ddaa) | high | M / 5 | [SKRILL-20](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/7782d08d-5994-4021-b155-c241c0348aca) |

Estimates are planning estimates, not elapsed-time commitments. They are stored in descriptions rather than forcing a project-specific Plane estimation scale.

## Story details

### SKRILL-10: Build the Node CLI package and shared core entrypoint

As the operator, I want an installable Node-only skillex executable and importable core so every consumer uses the same implementation.

**Affected repositories/targets:** skillex.

**Acceptance criteria**

1. Publishable @delorenj/skillex package exposes the skillex executable and typed ESM core exports; uses TypeScript, Commander, esbuild, and Node's test runner with Node >=24.
2. npm pack contains compiled runtime, types, schemas, and required assets without catalog snapshots, caches, secrets, or a Python/uv dependency.
3. Help, version, invalid-argument handling, JSON envelope schema 2, and the documented exit-code vocabulary work from an isolated installation.
4. Replace Python-specific development checks with Node equivalents incrementally; keep characterization fixtures available until final retirement.

**Validation:** Build, typecheck, Node 24/26 smoke tests, and an unpacked npm tarball executable test with Python/uv unavailable.

- Core implementation is added alongside Python initially; this ticket does not switch live activation roots.

### SKRILL-11: Implement canonical manifest resolution and inheritance

As a consumer, I want one canonical resolver for catalog names, sets, packs, inheritance, and exclusions so CLI and PJangler agree.

**Affected repositories/targets:** skillex.

**Acceptance criteria**

1. Shared core reads .agents/skills.json against skills.schema.json and adds scope-level exclude: string[].
2. Composed resolution orders inherited global names, declared sets, explicit skills, then exclusions; identical canonical references collapse and divergent targets for one canonical name fail.
3. One exclusive pack replaces the entire selection while retaining dormant ordinary selections for restoration; multiple packs and per-member pack filters fail explicitly.
4. Set include/exclude/optional semantics, required-missing failures, canonical name validation, and provenance/explanation data are covered by fixtures.
5. Explicit registry roots outrank discovery and never silently fall back; resolution remains offline and identifies the selected checkout.
6. Project discovery works from nested directories and respects nested Git boundaries; project-only write scope still resolves global inheritance. Legacy payload/source/slot fields receive actionable migration diagnostics.

**Validation:** Pure fixture tests for precedence, inheritance, exclusions, pack exclusivity, duplicate/divergent targets, absent sources, nested roots, and invalid explicit registry paths.

- This is the single resolver used by all later command families and exported to PJangler.

### SKRILL-12: Add catalog discovery, skill scaffolding, and local import

As a skill author, I want to find, inspect, create, and import skills into the sole catalog without editing activation directories.

**Affected repositories/targets:** skillex; skills (all-skills submodule for any authored/imported content).

**Acceptance criteria**

1. skill list --query and skill show report canonical names, descriptions, provenance, and composition references in human and JSON output.
2. skill create NAME writes a minimal valid SKILL.md under all-skills/ and never creates a definition under a set, pack, or activation root.
3. skill import PATH --name NAME imports local content with provenance, preserves executable modes, leaves the source intact, and refuses a conflicting existing catalog definition.
4. Dry-run produces the complete intended changes with no writes; malformed metadata and unsafe paths produce named diagnostics.

**Validation:** Temporary catalog tests for search/show, valid scaffolding, complete local import, modes, name collision refusal, and dry-run immutability.

- Scope enable/disable is separate from catalog definition creation.

### SKRILL-13: Manage reference-only sets and versioned packs

As the operator, I want to manage reusable sets and complete pack loadouts using canonical references rather than copied skill trees.

**Affected repositories/targets:** skillex.

**Acceptance criteria**

1. set list/show/create/add/remove manages sets/<name> membership with canonical links and idempotent repeated operations.
2. pack list/show/create/add/remove/verify uses pack.toml as membership authority and maintains reference-only skills/ child links; create accepts an explicit composition version.
3. Pack-level hooks, commands, and support assets remain pack-owned; no operation copies a real SKILL.md into a composition.
4. verify identifies missing members, embedded definitions, and manifest/link disagreement; unknown names and conflicting targets are refused before writes.
5. All changes support dry-run and JSON. There is no payload checksum/sealing/render or recursive runtime flattening command.

**Validation:** Set and pack lifecycle fixtures, version selection, reference-only ownership checks, support-asset preservation, and dry-run/idempotency tests.

- The old skill-sets/ spelling and copied pack inventories are migration input, not new runtime formats.

### SKRILL-14: Implement owned-link reconciliation and CLI aliases

As the operator, I want sync to converge global and project activation roots without deleting foreign content or racing another writer.

**Affected repositories/targets:** skillex.

**Acceptance criteria**

1. sync implements composed projection and exclusive-pack whole-root alias modes through one planner/applicator. Plain sync writes global plus the nearest project; explicit scope flags constrain writes.
2. The final read, plan, and apply occur under one ownership lock; contention has a bounded diagnostic and stale ownership is verified before recovery.
3. XDG receipts record owned links and source revisions; existing ownership is imported only through explicit migration. Pruning removes only recorded links.
4. Dry-run includes alias operations and writes nothing. Adds/replacements precede stale removals; interruption records honest partial state and a rerun converges.
5. Missing supported CLI aliases are created; correct relative/absolute aliases are retained. Foreign roots, foreign links, BMAD installer output, and Hermes overlays are preserved or cause a clear refusal.
6. Preflight rejects recursive topology, colliding real content, and unsafe destination chains before mutation and rechecks ownership at write boundaries.

**Validation:** Concurrency, dry-run, idempotency, interrupted recovery, stale-owned pruning, foreign-content survival, alias reachability, global/project/both scope, and recursive topology fixtures.

### SKRILL-15: Add immediate selection and inheritance commands

As the operator, I want enable/disable and inheritance commands to update a scope's declaration and apply the selection in one explicit action.

**Affected repositories/targets:** skillex.

**Acceptance criteria**

1. init creates the selected global/project manifest idempotently without overwriting existing selections; project inheritance defaults on.
2. enable/disable accepts skill, set, or pack references and edits one manifest. Default selection scope is nearest project, otherwise global; --scope explicitly chooses global or project.
3. Selection mutations validate the proposed manifest and complete operation plan before writes and immediately reconcile the selected scope. Preflight failure preserves manifest bytes and activation contents.
4. Disabling a skill removes its direct entry and records a local exclusion; enabling removes that exclusion and adds a canonical entry. Shared sets and global declarations are untouched by a project exclusion.
5. Enable pack retains ordinary selections as dormant state; disable pack restores them. Skill/set/inheritance edits with an active pack are refused with a concrete next action.
6. inherit on/off updates and reconciles only the selected project. Dry-run previews manifest and link changes together; execution interruption reports saved intent and converges on rerun.

**Validation:** End-to-end CLI scenarios for init, immediate enable/disable, inherited masking, re-enable, pack restoration, inheritance toggling, and failed/partial writes.

### SKRILL-16: Provide status, explanations, and topology diagnostics

As the operator or an automation client, I want one honest read-only view of desired skills, actual links, provenance, drift, and corrective actions.

**Affected repositories/targets:** skillex.

**Acceptance criteria**

1. status reports desired versus actual scope roots, counts, mode, owned/foreign entries, and supported CLI reachability.
2. explain NAME identifies declarations, canonical target, contributing sets/inheritance, exclusions, dormant pack selections, and blocking conditions.
3. doctor checks manifests, canonical ownership, reference-only compositions, aliases, provenance, and active legacy writers; --sources-only omits activation checks.
4. Read commands and sync output share documented JSON schema 2 with stable codes, data, paths, and fixes; stdout stays parseable without ANSI/progress text.
5. Exit codes distinguish configuration, refusal, partial, contention, drift, and interruption. Existing migration-baseline violations remain failures, never suppressed success.

**Validation:** Human/JSON CLI tests for missing roots, excluded names, source lookup failures, wrong aliases, copied payloads, legacy writer reports, drift exits, and zero filesystem mutation.

- No HTML server or automatic doctor repair mode; write actions are explicit commands or migrate.

### SKRILL-17: Port offline upstream vendoring and provenance

As the catalog maintainer, I want pinned upstream imports and offline provenance checks without another source of writable skill bytes.

**Affected repositories/targets:** skillex; skills (all-skills submodule when onboarding sources).

**Acceptance criteria**

1. vendor list/show/status/sync reads sources.toml and machine-local checkout mappings and supports selecting individual sources.
2. Resolve pins from available local Git checkouts and import committed trees; normal resolution/status/sync does not clone or fetch.
3. Receipts preserve upstream commit, tree/path, digest, executable bits, and local-edit detection; vendor status verifies catalog content without upstream checkout access.
4. Staging and preflight precede replacement. Adoption, discarding local edits, and pruning require their explicit options; ordinary sync never overwrites an unmanaged conflict.
5. Missing all-skills/sources.toml has a dedicated corrective diagnostic; the prepared declaration is validated and onboarded in the content-migration ticket.
6. Canonical imports, modes, and receipt updates are deterministic and support dry-run/JSON; relinking is delegated to the single migrate workflow.

**Validation:** Offline fixtures for pin resolution, missing declarations/checkouts, local edits, digest/mode changes, dry-run, staged failures, explicit adopt/force/prune, and status without upstream access.

### SKRILL-8: Sync Hermes profile skills from global and project selections

As the operator, I want each Hermes profile to receive global and project skills while retaining its required real skills directory and profile-owned skills.

**Affected repositories/targets:** skillex; hermes-agent-template and configured Hermes profile consumers.

**Acceptance criteria**

1. Reuse SKRILL-8 in CLI Revamp rather than creating a duplicate issue; preserve its original request.
2. profile list/show exposes profiles and their projection state. profile sync NAME --project PATH explicitly selects the profile and project; neither is inferred from an unrelated CWD.
3. The profile skills/ remains a real directory with the same inode. Resolve global then project names; profile-owned entries take precedence over managed collisions.
4. Link only the resolved managed names, record them in profile-specific XDG ownership state, and prune only stale links from those receipts.
5. Foreign profile files and Hermes runtime overlays survive byte-for-byte; generic CLI alias sync never manages them.
6. Dry-run and JSON show the winning source, preserved local entries, and proposed operations; repeated sync is idempotent.

**Validation:** Isolated profile tests for global/project union, collisions, local overrides, stale owned links, directory inode preservation, dry-run, and interruption recovery; live profile verification during rollout.

### SKRILL-18: Migrate legacy catalog, compositions, and ownership receipts

As the operator, I want an explicit migration path from the current mixed topology into the Node contract without lost skill content or invented ownership.

**Affected repositories/targets:** skillex; skills (all-skills submodule).

**Acceptance criteria**

1. migrate previews by default and writes only with --apply; produce a per-item migration inventory and verification receipts.
2. Onboard the prepared upstream declaration and convert linked/embedded skill definitions into real canonical catalog entries before replacing composition references.
3. Expand legacy container inventories once, convert pack manifests to canonical membership with skills/ links, and translate legacy skillex.toml selections and external-source references without carrying runtime slot/payload semantics forward.
4. Reuse identical canonical content; preserve differing content under source-qualified names. Missing or ambiguous mappings remain intact, are reported, and block affected cutover instead of being guessed or silently discarded.
5. Import validated Python ownership receipts and reconcile legacy activation/CLI roots only after all foreign or installer-owned content is accounted for.
6. Every migrated source and activation target passes the new topology checks. The measured 128 source findings are tracked individually to resolution; no baseline allowlist makes them green.

**Validation:** Migration fixture suite for both root modes, real directories, dangling/foreign links, duplicate/conflicting content, missing sources, receipt adoption, dry-run, resume/idempotency, and before/after content inventories.

- This ticket produces migration tooling plus the committed catalog/composition conversion. All edited catalog content belongs in the skills submodule and must be landed there before its parent pointer advances.

### SKRILL-19: Replace CommonProject and PJangler skill-engine integration

As the operator, I want new and migrated projects to use the same Node skill engine so bootstrapping or auditing cannot reinstall a retired writer.

**Affected repositories/targets:** CommonProject (canonical template); pjangler (core dependency, init/audit/migrate, packaged templates); hermes-agent-template (profile integration).

**Acceptance criteria**

1. Edit the canonical CommonProject template and propagate it into PJangler's packaged template; remove sync-skills.py/provision-packs.py and separate provisioning tasks from generated projects.
2. Keep one skills:sync task invoking pinned Node skillex with --scope project and an explicit config-root project path; remove automatic skill enter/watch hooks. Fresh bootstrap may call sync once explicitly.
3. PJangler imports the published Skillex core for resolution/inspection and updates init, audit, and migrate to the new manifest and alias contract instead of maintaining a second resolver or Python-script byte-parity rule.
4. The Hermes template uses the explicit profile projection contract and does not convert its runtime overlay into a directory alias.
5. Preserve unrelated CommonProject hooks and installer-owned BMAD behavior; a subsequent PJangler audit/migrate cannot restore removed Python engines.
6. Update schema/docs and component execution-ticket references required by the affected repositories; land all changed canonical template and package source repositories.

**Validation:** Fresh bootstrap, migration of an existing inherited project, repeated audit/migrate, nested-repository scope, BMAD installer coexistence, and packaged-template parity checks.

- Skillex owns this epic's acceptance. Create/link the required active component execution ticket on PJAN before that repository's implementation starts, following its AGENTS.md.

### SKRILL-20: Install the Node CLI and cut over every active consumer

As the operator, I want all active skill consumers on the Node CLI before the Python implementation is removed.

**Affected repositories/targets:** skillex; all active consumer repositories and active worktrees discovered by inventory; user runtime launchers, mise configuration, and skill-ssot service.

**Acceptance criteria**

1. Turn the candidate configuration scan into a deduplicated repository inventory plus an active-checkout/runtime checklist covering registered projects, worktrees, mise tasks, user services, and launcher/config references.
2. Explicitly classify historical/archived references; any reference still capable of executing a legacy writer is an active migration target regardless of directory naming.
3. Publish the tested @delorenj/skillex package and verify the installed skillex executable resolves to that exact version; replace the uv launcher and pin the Node package in consumers.
4. First verify the global scope, one existing inherited project, and one real Hermes profile; then complete every active-consumer checklist item with before/after skills, link targets, and invocation evidence.
5. Disable/remove legacy writer wiring before its target is handed to Node. Remove the old SSOT service and automatic rescue/watch paths; no simultaneous old/new writers or lasting compatibility shims remain.
6. Commit/push and land each affected source repository while preserving unrelated WIP. Verify all active checkouts consume the landed source rather than leaving a fixed sibling checkout beside a live legacy one.

**Validation:** Installed CLI and real consumer-path verification; repeated sync, CLI skill discovery, fresh process/entry behavior, profile visibility, and an exhaustive active-reference audit after migration.

- The initial scan had 70 file references, not 70 unique projects. Store completion evidence per consumer; do not treat a template-only fix as fleet migration.

### SKRILL-21: Remove legacy Python skill engines and prove retirement

As the operator, I want the retired Python skill engines and obsolete guidance removed so there is one supported operational path.

**Affected repositories/targets:** skillex; skills (canonical registry-operation skill documentation); any remaining source repository identified by the final audit.

**Acceptance criteria**

1. Remove the Python Skillex package, obsolete TOML/slot/activator/payload/sealing/flatten machinery, legacy sync/provision/rescue scripts, and tests/fixtures specific to retired semantics.
2. Remove temporary shims and obsolete packaging/tasks; preserve Python programs owned by individual catalog skills and unrelated infrastructure.
3. Update README, installation/migration docs, schemas, mise and hook checks, and canonical registry-operation skills to the final Node surface and ownership model.
4. Pass Node build/type/tests, npm artifact checks, supported OS checks, clean migrated topology, and the full active-consumer audit with no executable references to retired skill writers.
5. Run a fresh install and actual global/project/Hermes workflows with Python/uv unavailable; prove the running installed version matches the landed release.
6. Every child has linked acceptance evidence and related changes are on main and pushed. Close the epic only after installed/runtime evidence; tickets and documentation alone do not satisfy implementation.

**Validation:** Final package and runtime acceptance suite, Linux/macOS filesystem tests, consumer-reference scan, documentation command smoke checks, and per-repository landing audit.

- This is the only point at which obsolete characterization tests and the old implementation are deleted.

## Closeout requirements

For implementation, keep each changed repository tied to an active ticket, attach acceptance evidence, commit/push and land the changes on main, and preserve unrelated work. Do not close the epic based only on local tests, a published package, or a template change: installed global/project/profile paths and the complete active-consumer inventory must pass.
