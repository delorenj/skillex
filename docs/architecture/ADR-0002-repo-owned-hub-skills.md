# ADR-0002: Repo-Owned Hub Skills

- **Status:** Accepted (direction set by the user, 2026-11-05). Implementation tracked on the SKRILL board.
- **Date:** 2026-11-05
- **Deciders:** Jarad DeLorenzo
- **Supersedes:** ADR-0001 invariant 1 ("`all-skills/` owns the bytes") and ADR-0001's
  rejection of Option C (federated definitions). Every other ADR-0001 invariant stands.
- **First adopter:** HeyMa (`~/HeyMa/skills/heyma/`).

## Context

ADR-0001 made SSOT checkable by putting every skill's bytes in `all-skills/` and
making everything else a link. That kept one copy per name, but it put the copy in
the wrong place for any skill about a codebase:

- The skill and its subject change in different repos and different commits.
  `wax-pipeline`, `heyma-pipeline-doctor` and `create-enrichment-pass` described
  HeyMa, lived in `all-skills/`, and drifted: a pass list five passes short, a
  45-second deadline that is now 180, a `wax reset` command that never existed.
- Vendoring fixed the location for some repos but re-created the copy. On
  2026-11-05 `doctor --sources-only` reported 25 `W_SKILL_DIGEST_DRIFT`, and
  `33god-hub`'s catalog copy carried local edits its upstream never saw.
- One subject split into several skills, each selected separately. Callers had to
  pick by use case ("pipeline" vs "doctor" vs "create a pass"), and selecting all
  of them loaded three descriptions where one router would do.

The principle is right. The location is wrong.

## Decision

**A skill lives where its subject is maintained.** SSOT is unchanged: one name,
one writable directory, everything else is a generated link. What changes is
which directory.

### 1. Ownership

1. **Repo-owned skill.** A skill about a codebase lives in that codebase at
   `<repo>/skills/<hub>/`. It is committed, reviewed and tested with the code it
   describes. Its bytes exist nowhere else: not copied into `all-skills/`, not
   vendored.
2. **One hub per repo.** `<repo>/skills/` holds exactly one top-level skill
   directory, the **hub**. Its name is the repo's subject in kebab case (the
   pjangler project id where one exists): `heyma`, `vinyl`, `skillex`. A
   component inside a repo is a route inside that repo's hub, not a second hub.
3. **A repo with its own repo gets its own hub.** A submodule is a separate repo
   and keeps its own hub (`HeyMa/components/vinyl/skills/vinyl/`). The parent hub
   routes to it by name; it does not absorb or copy it.
4. **Wild skill.** A skill with no owning codebase (a writing style, a vendor API
   guide, a working method) stays in `all-skills/`, which is now the home of wild
   skills and vendored third-party skills only. Before creating a wild skill, ask
   which repo would change if the skill were wrong. If one answers, it is not
   wild. That friction is intended.
5. **No shadowing.** A name resolves to exactly one directory across `all-skills/`
   and every repo-owned source. A name present in both is a refusal
   (`E_DIVERGENT_CANONICAL_NAME`), never a precedence rule.

### 2. Hub anatomy

```text
<repo>/skills/<hub>/
  SKILL.md                 the router: frontmatter + route tables, target <200 lines, lint at 500
  references/              leaf docs, loaded only when a route says so
  scripts/                 executables the hub or a reference tells the agent to run
  examples/                optional worked examples
  subskills/<name>/
    SUBSKILL.md            a full skill body (name + description frontmatter), loaded by path
    references/ scripts/ tests/   owned by that sub-skill
```

- **The hub is a router.** It states what the subject is, hoists the rules that
  apply on every route, and then routes: each row names a situation and the one
  file to read for it. "Read exactly one row" is the default; a combination table
  covers the common multi-file cases.
- **Sub-skills are lazy by construction.** Their entry file is `SUBSKILL.md`, not
  `SKILL.md`, so no discovery scanner lists them. This is not cosmetic: Hermes
  discovers skills with `rglob("SKILL.md")` and exempts only `references/`,
  `templates/`, `assets/` and `scripts/` directly under a skill
  (`hermes-agent/agent/skill_utils.py`, `is_skill_support_path`), so a nested
  `SKILL.md` anywhere else would be auto-listed and the hub would stop being the
  only entry point. A sub-skill is promoted to its own skill by moving it and
  renaming the file; its frontmatter already makes it skill-shaped.
- **Loading a sub-skill or reference = reading a file.** The hub tells the agent
  to read `subskills/doctor/SUBSKILL.md` (a path relative to the hub). This is
  the "point an agent at a SKILL.md on disk" pattern that already works, made
  the standard.
- **Hub size budget.** `SKILL.md` under 200 lines. Facts that need more than a
  route row and a one-line rule belong in a reference.

### 3. References between skills

| From → to | Write it as | Never |
|---|---|---|
| hub → its own file | relative path inside the hub: `references/calls.md` | an absolute path |
| hub → another hub or a wild skill | the skill **name** in backticks, plus a path hint: "load the `vinyl` hub (`skillex skill show vinyl` prints its path)" | `../sibling/SKILL.md`, `.agents/skills/<name>`, a bare machine path as the only handle |
| parent repo hub → submodule hub | the name, plus the repo-relative path: `components/vinyl/skills/vinyl/SKILL.md` | copying the child's content |

The name is the identity; a path is a hint. Sibling-relative links
(`../wax-pipeline/SKILL.md`) only work when both skills happen to be activated
into the same root, which is exactly the coupling this ADR removes.

### 4. Declaration and resolution

Repo-owned sources are declared once, by repo identity, in
`all-skills/sources.toml`, reusing the vendoring declaration with a new mode:

```toml
[[source]]
name = "heyma"
repo = "git@github.com:delorenj/HeyMa.git"
checkout = "HeyMa"
mode = "link"          # default "vendor"; "link" = the working tree is the definition
skills = ["heyma"]     # the hub; directory name must equal the skill name
# subdir defaults to "skills"; version is not used in link mode
```

- **The catalog publishes identity, never a machine path.** The checkout is
  resolved per machine by the existing vendoring resolver: `--checkout`, then
  `SKILLEX_SOURCE_<ID>`, then `~/.config/skillex/sources.local.toml [checkouts]`,
  then `~/code/<checkout>`.
- **Identity is verified, not assumed.** In link mode a checkout whose
  `remote.origin.url` does not match `repo` is refused, and so is a checkout
  containing `STALE-CHECKOUT.md` (the default rule would otherwise bind HeyMa to
  the retired `~/code/HeyMa`).
- **Activation is unchanged.** Sync writes the same relative links it writes
  today, now pointing into the owning repo:
  `~/HeyMa/.agents/skills/heyma -> ../../skills/heyma`,
  `~/.agents/skills/heyma -> ../../HeyMa/skills/heyma`. Receipts record the owning
  repo's HEAD, as they already do for `dirname(binding.path)`.
- **Phase 1:** a repo-owned skill is selectable through a manifest's `skills:`
  list. Sets and packs refuse it with a clear code, because their link farms are
  committed and a committed link into another repo is machine-specific.
  **Phase 2:** packs list member names in `pack.toml` and generate their link
  farms per machine (gitignored), so a pack can mix hubs and wild skills.
  **Phase 2 for sets (implemented 2026-11-10):** a set declares each owned member
  as a `/<name>` line in its own committed `.gitignore`; the member link into the
  checkout is generated per machine and ignored by that same line, so membership
  is committed and the machine path never is. See
  [link sources](../implementation/link-sources.md). Packs remain phase 1.

### 5. Answering ADR-0001's objection to Option C

ADR-0001 rejected federated definitions because "absolute links and repo moves
break the namespace". That was true of the federated pattern it was looking at:
hand-made absolute links committed into the catalog. It is not true here:

- Nothing committed contains a machine path. The declaration names a repo; each
  machine maps it to a checkout.
- Activation roots were always generated and machine-local. A repo move (HeyMa
  has moved twice: `code/33GOD/HeyMa` → `code/HeyMa` → `~/HeyMa`) is one line in
  `sources.local.toml` and one `skillex sync`, and `skillex doctor` names the
  broken source until then.
- The failure is loud: an unresolvable required source is an error at resolve
  time, not a dangling link discovered by an agent mid-task.

### 6. Lint

`skillex skill lint <name>` and `skillex doctor` check every repo-owned hub:

| Code | Rule |
|---|---|
| `E_HUB_COUNT` | `<repo>/skills/` contains exactly one directory with a `SKILL.md` |
| `E_HUB_NAME` | directory name = declared name = frontmatter `name` |
| `E_HUB_FRONTMATTER` | `name` and `description` present; name matches `skillName`, ≤64 chars; description ≤1024 chars |
| `W_HUB_SIZE` | `SKILL.md` over 500 lines (target is 200) |
| `E_HUB_REFERENCE_MISSING` | a relative link in the hub, a reference or a sub-skill does not resolve |
| `E_HUB_REFERENCE_ESCAPE` | a relative link leaves the hub directory |
| `W_HUB_ORPHAN` | a file under `references/` or `subskills/` that nothing links to |
| `E_HUB_NESTED_SKILL` | a `SKILL.md` below the hub root (use `SUBSKILL.md`) |
| `E_HUB_SKILL_REF_UNKNOWN` | a backticked skill name in a "load the `x` hub/skill" phrase that resolves nowhere |
| `E_HUB_SYMLINK` | a symlink anywhere in the hub tree |
| `W_HUB_PROVENANCE` | a `.source.yaml` in a repo-owned skill (provenance is the repo itself) |

The owning repo should also carry its own drift guards: tests that fail when the
hub's command list, pass catalog or paths disagree with the code (HeyMa's
`components/wax/tests/skill_hub_test.py` is the reference implementation).

### 7. Migration of an existing skill family

1. Author the hub in the owning repo; port the old skills' content into
   references and sub-skills, fixing what drifted on the way.
2. Replace each old `all-skills/<old>/SKILL.md` with a redirect stub (a short
   body: "moved to the `<hub>` hub; read `<path>`") so the 40-odd roots and desks
   that still select the old name keep working.
3. Declare the source, select the hub, swap selections, `skillex sync`.
4. Update text consumers (other skills, AGENTS.md files, code that names the skill).
5. Delete the stubs once `rg` and `skillex explain` show no consumer.

## Consequences

- `AGENTS.md` "All skills are defined once in all-skills" is replaced by "Each
  skill is defined once, in the repo that owns its subject; `all-skills/` holds
  wild and vendored skills".
- Skill review happens in the subject repo's history, beside the code change that
  made the skill wrong. Drift guards become ordinary tests.
- A link-mode skill exposes the owning repo's **working tree**, including
  uncommitted edits, to every scope that selects it. Under the commit-and-push-
  always rule that is a feature: the skill is as current as the code.
- Vendoring remains for third-party upstreams and for repos not yet migrated.
  Migrating a vendored repo-owned skill to link mode removes its digest drift
  class entirely.
- Packs gain value in phase 2 (mix hubs and wild skills) but should become rare:
  a well-routed hub per repo is the default unit of selection.

## Alternatives considered

- **Keep `all-skills/` as the byte owner, add drift tests in each repo.** Keeps
  two homes for one subject; the test can only detect drift after the fact.
- **Commit symlinks from `all-skills/` into repos.** ADR-0001's original
  objection applies: machine paths in a committed catalog.
- **Several skills per repo, chosen by use case.** The status quo that produced
  three overlapping HeyMa skills. A router with lazy sub-skills gives the same
  separation without asking the caller to choose.
- **Nested `SKILL.md` sub-skills.** Rejected because recursive scanners (Hermes)
  list them, defeating lazy loading; see §2.

## References

- ADR-0001: `docs/architecture/ADR-0001-reference-only-skill-topology.md`
- Hub authoring standard: `docs/skills/hub-skill-standard.md`
- Design precedents: `docs/skills/skill-creator-refactor-report.md`,
  `docs/skills/cloudflare-hub-architecture-analysis.md`,
  `docs/skills/33god-skill-hierarchy-boundaries.md`
