# Cross-client skill parity (read-only pilot)

Skillex resolves a **deduplicated global + explicit project selection** for each
client. Project `inherit_global: false` and a project set control that project's
own materialization, not the universally available global selection. If the
same name selects different canonical definitions across scopes, the projection
refuses it; client-specific shadowing is not a repair. `skillex profile sync`
uses the same effective selection for Hermes's real, profile-owned `skills/`
directory. It does **not** alias the whole profile to the raw global root.

## Inspect without activating anything

Run the checkout CLI rather than assuming a globally installed `skillex` has
these changes. Supply the project and the actual Hermes profile explicitly:

```sh
cd ~/code/skillex
npm run build
node dist/cli.js clients parity --project ~/code/tolt --profile tolt-pm \
  --hermes-root ~/.hermes --registry-root ~/code/skillex --json
node dist/cli.js status --scope both --project ~/code/tolt --json
node dist/cli.js profile show tolt-pm --project ~/code/tolt \
  --hermes-root ~/.hermes --registry-root ~/code/skillex --json
```

`clients parity` is deliberately read-only and has no `--apply`. Its nonzero
exit is actionable: 3 for refused ownership, 6 for drift, 4 for incomplete
verification. `expected` is the selected membership, not everything a client
might advertise. Each `consumers[]` entry distinguishes selected paths from
foreign definitions, broken/unreachable paths and **canonical conflicts**, not
native winner/ambiguity verdicts. The JSON exposes `directoryName`,
`advertisedName` and `lookupNames` separately in `candidates`; a canonical
`project-jangler` link advertising `pjangler` is **present**, not missing:
Claude/Codex/Kimi look up `pjangler`, while Hermes also accepts the directory
name. This still produces a naming `metadataIssues` drift; it is not proof that
all clients expose the same name. A foreign
`alien/SKILL.md` advertising `name: role` is retained and can conflict with the
selected `role`. Missing mandatory client metadata is reported in
`metadataIssues` **and** remains missing membership where the client model
requires that metadata. The audit
checks the bounded user/project roots for Claude, Codex and Kimi plus the named
Hermes profile; it checks Hermes's project roots only when their project is
explicitly trusted in the profile config **and** `skills.project_discovery` is
not `false`. Trust expands `~` and `$VAR`/`${VAR}` against the inspection
environment (`options.env` or process environment), then compares real project
identities, including symlink paths. An unset variable remains literal as in
Hermes's `expandvars`; it does not grant trust. An ordinary profile whose
receipt and links converge still has **blocked** strict-policy evidence unless
both `.skillex-only` and `.no-bundled-skills` are regular files. Inspection does
not create or repair them. A link is not proof of a working
skill: metadata, target, selection, receipts and the real Hermes
profile root are checked separately. The audit cannot enumerate all Claude
plugins/synced content, Codex parent/admin roots, Kimi extra dirs/flags or
Hermes's loaded security quarantine (`quarantine: unknown`). Runtime always remains
`unverified`. Do not read `foreign` as permission to delete or adopt it.
`filesystem: matched` means only that the bounded canonical evidence matched;
it never implies an identical native resolver across these clients.

## Native evidence boundaries

No common native resolver or winner algorithm is implemented. The observer
compares canonical directory targets after client-specific metadata/root
inspection. `canonicalConflicts` conservatively reports a competing target even
where the client allows both or chooses a higher tier. The old `ambiguous` field
was removed because it implied a native refusal the audit could not establish.
Foreign copies, including byte-identical copies, are not canonical links.

- **Claude:** documented priority is enterprise > personal > project, not
  project > personal. An omitted name uses the directory name; an omitted
  description can use body text. This observer does not decide winners or
  reproduce plugin, reserved-name, visibility, path or malformed-YAML behavior.
- **Codex:** the authoritative docs require `name` and `description` in
  `SKILL.md`; no omitted-name directory fallback is assumed. Same-name skills
  can both appear in selectors. A canonical conflict is therefore not a native
  ambiguity/refusal assertion. Parent, admin, system roots and client config
  remain outside this bounded inspection.
- **Hermes:** trusted `.hermes/skills` and `.agents/skills` roots resolve and
  deduplicate by whole-root real identity. A whole-root alias does not add a
  candidate. For **distinct** roots containing per-skill symlinks to the same
  `SKILL.md`, the checked source has a real inconsistency: the prompt catalog's
  `resolve_skill_catalog` can label both ambiguous, while
  `_collect_skill_candidates` deduplicates resolved files before lookup and
  `pick_skill_candidate` gets one candidate. The audit reports this separately
  as `indexLookupDisagreements` with filesystem drift, not a definitive
  `skill_view` refusal. Byte-identical files at separate paths are still
  separate lookup candidates; they are not adopted, deduplicated by content, or
  treated as canonical. Directory and advertised-name aliases both matter.
  Security quarantine and session filters are not evaluated or bypassed.

### Kimi versions are not interchangeable

The host's `command -v kimi` was `/home/delorenj/.kimi-code/bin/kimi` and
`kimi --version` returned **2.1.1**. The older Python module/review evidence
(1.47.0) is not evidence about that executable. The diagnostic exposes an
**explicit evidence dialect**, never invokes Kimi and never detects its version:

```sh
# Default: published Kimi Code 2.1.1 source contract
node dist/cli.js clients parity --project PATH --profile NAME --kimi-dialect code-2.1 --json
# Only when deliberately auditing the legacy Python CLI contract
node dist/cli.js clients parity --project PATH --profile NAME --kimi-dialect python-1.47 --json
```

| Evidence dialect | User roots | Project roots | Directory-form metadata |
| --- | --- | --- | --- |
| `code-2.1` (default) | `~/.kimi-code/skills`, `~/.agents/skills` | `.kimi-code/skills`, `.agents/skills` | Explicit nonempty name + description required |
| `python-1.47` | `.kimi`, `.claude`, `.codex` brand roots; first directory of `~/.config/agents/skills`, `~/.agents/skills` generic group | `.kimi`, `.claude`, `.codex` brand roots; **only** `.agents/skills` generic group | Name falls back to directory; description can fall back to body |

The legacy audit includes available brand roots conservatively; the
`merge_all_available_skills` setting can change which participate. The preferred
`.config` directory is a **user-only** rule; an empty project `.config` never
hides project `.agents`. Files and dangling links do not satisfy `isDirectory`.
Code 2.1 does not use legacy `.config` preference or directory-form fallback.
`KIMI_CODE_HOME`, extra roots, CLI overrides, flat Markdown skills, case
normalization, type/visibility settings and actual native winners remain
unverified. Choose the dialect explicitly for other installations and collect
fresh-session evidence; neither dialect certifies a binary/session match.

### Traced definitions and authoritative references

- [Claude skill discovery/frontmatter](https://code.claude.com/docs/en/skills).
- [Codex skill metadata/discovery](https://developers.openai.com/codex/build-skills).
- [Kimi Code 2.1.1 tagged source](https://github.com/MoonshotAI/kimi-code/tree/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f):
  `packages/agent-core-v2/src/features/skill/catalog/{skillRoots,parser}.ts`
  and `docs/en/customization/skills.md`. This tag, not current `main`, backs the
  default evidence dialect.
- [Legacy Kimi Python 1.47.0 source](https://github.com/MoonshotAI/kimi-cli/blob/36c91b3874369babf2d80b140fe4bcc7be5ff8f0/src/kimi_cli/skill/__init__.py):
  `_get_user_generic_skills_dir_candidates`,
  `_get_project_generic_skills_dir_candidates`, `find_first_existing_dir`,
  `_parse_skill_content`.
- [Hermes skills documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
  and read-only local checkout `/home/delorenj/.hermes/hermes-agent`:
  `agent/skill_utils.py` (`_project_trusted_dirs_from_config`,
  `_current_project_root`, `_candidate_project_skills_dirs`,
  `get_skill_search_roots`, `resolve_skill_catalog`, `pick_skill_candidate`),
  `tools/skills_tool.py` (`_collect_skill_candidates`). Actual source metadata,
  not the catalog's canonical-directory convention, supplies native names.

## Fixture verification

All mutation examples below require separate live authorization. Regression
syncs exercise disposable fixtures only. Use an owned temp directory outside
source repositories; never disable the receipt ownership guard:

```sh
export TMPDIR=/path/to/owned/non-repository/scratch
export SKILLEX_TEST_TMPDIR="$TMPDIR"
npm run build
node --test tests/node/client-parity.test.mjs tests/node/profile-sync.test.mjs tests/node/diagnostics-cli.test.mjs
heavy npm run check
```

Fixtures normalize real paths. They retain a client alias if ordinary sync
already created it, and only add a missing fixture-owned alias when the
protected `.hermes` scratch ancestor makes generic sync skip it. The
out-of-project resolver test has its own empty Git boundary so an ambient home
manifest cannot leak in through temp ancestors. No runtime guard is relaxed.
Cross-registry union tests exercise inherited and opted-out project selections:
alpha stays bound to source registry A, beta to B, strict sync succeeds, and the
second preview is empty. Universal globals and strict foreign preservation are
unchanged.

## Read-only live pilot inventory: TOLT / `tolt-pm`

Checkout CLI audit (`--project ~/code/tolt --profile tolt-pm
--hermes-root ~/.hermes --registry-root ~/code/skillex --json`) returned exit **3**,
not parity. The effective selection has **116** canonical names. All four
bounded observers report **zero missing canonical links** and zero unreachable
entries; this does not certify uniform advertised names or runtime loading.

| Consumer | Filesystem | Foreign entries | Canonical conflicts | Naming metadata issues |
| --- | --- | ---: | ---: | ---: |
| Claude | drift | 57 | 44 | 4 |
| Codex | drift | 57 | 44 | 4 |
| Kimi (`code-2.1` evidence) | drift | 57 | 44 | 4 |
| Hermes (`tolt-pm`) | blocked | 44 | 44 | 4 |

Two selected canonical directories, `project-jangler` and `projects`, have
frontmatter names `pjangler` and `33god-projects`. Each appears in both the
inspected global and project roots (four naming issues per client), with exact
canonical targets: they are **not missing files**. Claude/Codex/Kimi's bounded
lookup evidence uses the advertised names; Hermes includes both the directory
and advertised aliases. A native session/winner remains unverified.

The 44 project BMAD copies under `~/code/tolt/.agents/skills` have noncanonical
targets and collide with selected names; Hermes sees them in a trusted project
root as well as its managed profile links. These are foreign content, not links
the strict receipt may adopt or delete. The 57 Claude/Codex/Kimi foreign entries
also include global `.system` and `synced` containers and additional global
skills (for example Stripe integrations); entry counts are per observer, not
unique files. The strict profile has regular `.skillex-only` and
`.no-bundled-skills` markers and a real skills directory, but `profile show`
returns **3**: preserved `.hub` is an unowned strict-policy blocker. Its
bookkeeping `.bundled_manifest`, `.curator_state`, `.locks`, `.usage.json`, and
`.usage.json.lock` are separately preserved. Hermes `skills.disabled` may
suppress names. Canonical `status --scope both` returns **6** and plans four
changes: global and project receipt refreshes, plus project `.kimi/skills`
creation/link. No preview was applied.

**Decision before pilot activation:** have the project content owner review a
preserving migration of the 44 copied BMAD definitions, and the profile owner
review `.hub` through the existing cutover preview; decide how to handle other
foreign global roots separately. Have the scope owner review the four canonical
activation operations and advertised-name aliases before any separately
authorized apply. Do not rename frontmatter merely to silence the audit without
verifying consumers. Fresh sessions and `skill_view`/quarantine checks are still
required. This inventory is read-only and time-bounded; rerun it before acting.

## Bounded repair, only after owner approval

Start with one desk and one project. Record `clients parity`, `status` and
`profile show` JSON, then preview each proposed writer through the checkout CLI:

```sh
node dist/cli.js sync --scope global --dry-run --json
node dist/cli.js sync --scope project --project ~/code/tolt --dry-run --json
node dist/cli.js profile sync tolt-pm --project ~/code/tolt \
  --hermes-root ~/.hermes --registry-root ~/code/skillex \
  --skillex-only --dry-run --json
```

Do **not** apply a preview with unowned `.hub`, `.archive`, copied project BMADs,
foreign global `.system`/synced skills, nonempty `external_dirs` or `create_dir`,
missing strict markers, or divergent canonical names. The strict receipt is
not an adoption ticket. Have the relevant content/config owner decide how to
preserve and move each foreign entry outside every discovery root; use the
existing cutover tool's preview and locked config renderer rather than an
unreviewed manual cleanup. Never disable Hermes security scanning to turn a
quarantined skill green. Do not install this checkout or restart a gateway as
part of a read-only audit.

Once the preview is reviewed and activation is separately authorized, apply
only those exact global/project/profile sync commands without `--dry-run`.
Repeat `status`, `profile show` and `clients parity`; a second profile sync
preview should show no operations. In **fresh client sessions** bound to the
same project, check a representative global-only name, a project-only name and
a shared name in Claude/Codex/Kimi. In a fresh Hermes session for the named
profile, compare its prompt catalog and call `skill_view` on each probe:
`skill_view` may reject a catalog entry due to quarantine or ambiguity. Record
the exact runtime results rather than promoting filesystem parity to success.
Hermes's loaded profile and project trust are session-fixed; a running session
can retain a stale injected catalog after filesystem changes.
