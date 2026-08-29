# ADR-0001: One Writable Skill Definition with Reference-Only Compositions

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** Jarad DeLorenzo

## Context

Skillex distributes the same skills across several agentic CLIs and across global
and project scopes. The repository currently expresses more than one ownership
model:

- `all-skills/` is described as the canonical skill collection, but some of its
  entries point to writable definitions in other repositories.
- Most skill sets are link farms, but some contain real `SKILL.md` definitions.
- Ordinary packs select skills by name, while the Hermes pack contains a copied,
  versioned skill payload and relies on recursive flattening.
- CLI roots sometimes alias one scope root and sometimes contain independent
  per-skill projections.

That ambiguity makes a green resolver or a live daemon insufficient evidence
that a skill has one source of truth. We need an ownership rule that can be
checked directly from the filesystem.

## Decision

The canonical pipeline is:

```text
one real definition in all-skills/
    -> reference-only compositions
    -> one .agents/skills activation root per scope
    -> directory-level CLI aliases
```

The following invariants are mandatory:

1. **`all-skills/` owns the bytes.** Every skill is a real directory at
   `all-skills/<canonical-name>/` and contains its only writable `SKILL.md` plus
   its skill-owned references, scripts, templates, and assets. A symlink in
   `all-skills/` is a migration defect, not a federated source-of-truth feature.
2. **Compositions never define skills.** `skill-sets/` and `packs/` may select
   canonical names in manifests and may expose directory symlinks to
   `all-skills/`. They must not contain a real `SKILL.md` anywhere.
3. **Packs remain useful, but reference-only.** An agentpack may own its manifest,
   provenance, hooks, commands, and pack-level support material. Its skill
   members are references. There is no sealed-snapshot exception for copied
   skill payloads.
4. **Reproducibility pins the catalog, not duplicate bytes.** A reproducible
   activation records the Git revision of the canonical `all-skills` repository
   together with the pack manifest revision. Versioned packs pin a composition;
   they do not vendor another skill tree.

   *Amendment (2026-08-29, `skillex vendor`).* A skill whose upstream lives in
   another repository adds a **third** pin alongside catalog-rev and
   pack-manifest-rev: the resolved upstream commit, recorded in
   `all-skills/<name>/.source.yaml`. This is consistent with the invariant rather
   than an exception to it, because the vendored bytes land in `all-skills/` as
   the one writable definition — the pin says where they came from, it does not
   create a second place they live. `all-skills/sources.toml` declares the
   sources; nothing is fetched, and `skillex vendor status` verifies the pin
   offline from the catalog alone.
5. **Composition expands to a flat name map.** Set and pack membership compiles
   to `canonical-name -> all-skills/<canonical-name>`. Duplicate names or two
   different targets for one name are errors.
6. **Each scope has one activation root.** The user scope uses
   `~/.agents/skills`; a project uses `<repo>/.agents/skills`.
7. **Two activation modes are supported and named.** In *whole-root alias mode*,
   `.agents/skills` aliases one reference-only composition such as
   `skill-sets/global`. In *composed projection mode*, the reconciler builds a
   real `.agents/skills/` directory whose children are canonical symlinks.
8. **CLI roots are aliases, not projections.** Claude, Codex, Gemini, Copilot,
   OpenCode, and Kimi skill roots alias the scope's `.agents/skills` directory.
9. **Generated roots have one writer.** Humans edit canonical skills,
   compositions, and manifests. The Skillex reconciler exclusively owns
   generated activation roots. Generated roots are read-only from the user's
   perspective.
10. **Project inheritance is a union, not a copy.** A project manifest may inherit
    global names and add or override explicit names in its compiled map; it does
    not copy global skill bytes into the project.

### Terminology

- **Canonical definition:** the real skill directory in `all-skills/`.
- **Composition:** a reference-only skill set or pack.
- **Activation root:** the one `.agents/skills` root consumed by a scope.
- **CLI alias:** a CLI-specific `skills/` path resolving to the activation root.

Calling all four of these things “canonical” is prohibited because it hides the
write boundary.

## Options Considered

### Option A: Strict physical ownership in `all-skills/` (accepted)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium migration, low steady-state complexity |
| Drift risk | Lowest; ownership is visible with filesystem inspection |
| Reproducibility | Pin catalog and composition Git revisions |
| Operability | One checker can enforce the complete rule |

**Pros:** one write location, simple mental model, immediate propagation, no
payload reconciliation.

**Cons:** external and upstream skills must be imported before activation; the
current repository needs migration.

### Option B: Permit sealed copied payloads in versioned packs (rejected)

| Dimension | Assessment |
| --- | --- |
| Complexity | High; checksums, flattening, promotion, and collision policy |
| Drift risk | Lower than mutable copies, but two byte owners still exist |
| Reproducibility | Self-contained snapshots |
| Operability | Resolver health does not prove source ownership |

**Pros:** faithful upstream snapshots and offline self-containment.

**Cons:** preserves the exact ambiguity Skillex is meant to remove; checksum
validity proves immutability, not canonical ownership.

### Option C: Federated writable definitions behind `all-skills/` links (rejected)

| Dimension | Assessment |
| --- | --- |
| Complexity | Low initial migration, high ongoing ownership complexity |
| Drift risk | Medium; catalog name and byte owner are separate concepts |
| Reproducibility | Requires pinning several repositories |
| Operability | Absolute links and repo moves break the namespace |

**Pros:** source projects retain local ownership.

**Cons:** `all-skills/` becomes only an index, aliases can duplicate targets,
and a repository scan no longer identifies the sole writable definition.

## Trade-off Analysis

Strict ownership spends migration effort once to eliminate a permanent class of
drift and explanation failures. The rejected snapshot model offered convenient
versioning, but versioning can be retained more cleanly by locking two Git
revisions: the composition and the canonical catalog. Pack-level code and
documentation remain pack-owned, so the decision removes duplicated *skill
definitions* without reducing agentpack capabilities.

## Consequences

- A real `SKILL.md` under `packs/` or `skill-sets/` is always an error.
- A skill-bearing symlink at the top of `all-skills/` is always an error.
- Upstream harvest workflows become import/promote workflows into
  `all-skills/`, followed by reference-only pack changes.
- Legacy `sealed`, payload checksum, and recursive pack-flatten behavior has no
  place in the target runtime and will be removed after live packs migrate.
- The repository may temporarily fail the topology checker during migration;
  that failure is evidence, not a reason to weaken the rule.
- Existing activation roots must converge on one alias/projection model per
  scope before topology checking becomes a required quality gate.

## Action Items

1. [x] Add `skillex topology check` with stable rule codes and JSON output.
2. [x] Revise the editable architecture diagram to show the write boundary,
   reference-only packs, both activation modes, and CLI aliases.
3. [~] Import or retire linked definitions currently exposed through
   `all-skills/`. **Machinery landed 2026-08-29**: `skillex vendor` copies a
   declared external repo's skills into `all-skills/` as real, pinned content
   (`docs/VENDORING.md`). This is the *execution* of this item, not an exception
   to invariant 1: after the migration there are zero symlinks in `all-skills/`.
   The content migration itself is a deliberate, reviewed commit in
   `delorenj/skills` and is not yet run — `docs/vendoring/sources.toml` is the
   ready declaration, and a dry run classifies all 15 as `replace-link`.
4. [ ] Promote Hermes snapshot leaves into `all-skills/`, reconcile name
   collisions, flatten its manifest to canonical names, and delete the payload.
5. [ ] Replace real definitions in `skill-sets/` with canonical references.
6. [ ] Reconcile global and project activation roots and CLI directory aliases.
7. [ ] Remove legacy self-contained payload/sealing code and its tests.
8. [ ] Add `topology:check` to the required `mise check` dependencies once the
   migration report is clean.
