# ADR-0003: Personal Learned Skills Belong to Named Identities

- **Status:** Accepted operator direction; runtime/source integration pending (SKRILL-47).
- **Date:** 2026-11-07
- **Decider:** Repository owner
- **Related:** [ADR-0001](ADR-0001-reference-only-skill-topology.md),
  [ADR-0002](ADR-0002-repo-owned-hub-skills.md).

## Context

A project-manager post is associated with a project and gets its scoped skills
from that project's selection. A named Flume/Hermes agent is a person-like
identity: its work can span unrelated projects, and its accumulated procedures
must not depend on its current directory or post.

The operator explicitly wants Hermes's autonomous/asynchronous learning retained
for named agents, while applying Skillex's checked, versioned source ownership.
Tolerating files in a runtime directory alone does not provide that ownership.

## Decision

1. **Keep personal learning.** Named agents may create and improve learned skills
   through the supported Hermes writer, including background work. Do not turn
   learning off to make an ownership audit green. Existing write approval and
   content validation still apply; this decision does not bypass them.
2. **Own by identity, not project.** A named agent's learned collection belongs
   to its stable personal identity. It follows that identity across projects
   and posts, separate from project selection and project memory. Do not infer
   identity merely from a profile directory's spelling.
3. **Git is durable source.** Personal definitions must live in a Git-backed
   source, be checked, committed and pushed. Runtime-only learned directories
   are migration inputs, not the intended durable source. A dirty local Git
   directory without a pushed checkpoint does not satisfy this requirement.
4. **One writable source.** Hermes remains the learning author; Skillex owns
   source registration, activation and discovery reconciliation. A generated
   profile projection must not become a second writable canonical copy. Do not
   redirect writes into a shared set, pack or global activation root.
5. **Personal availability is not global publication.** An agent's collection
   augments universal global skills and its approved role/project selection;
   it does not automatically become available to every employee. Collisions
   need explicit resolution, never silent shadowing or overwriting of a selected
   skill. The automatic author must support edits and nested category layouts,
   not only one-time imports of flat names.
6. **No loss during migration.** Inventory and preserve every existing skill and
   supporting file, including legacy category trees. Validate byte-preserving
   transfer and discovery, retain recovery outside active discovery roots, and
   verify repeated sync and repeated learning converge without duplicates.
7. **PM authority stays separate.** This decision grants personal learning to
   named identities; it does not implicitly broaden project-PM writing authority.
   Existing PM-authored material must be preserved while its proper owner is
   determined, not deleted as a side effect.
8. **Failures stay visible.** Validation, collision, Git checkpoint and push
   failures must identify the affected identity and preserve the learned work.
   Do not report successful durable learning while content remains runtime-only
   or unpushed. New recurring execution, if needed, uses Candybar; do not add a
   second scheduler just to checkpoint skills.

## Bundled skills are not learned skills

Hermes ships a stock skill collection with its installation. On ordinary
profiles its bundled-skill seeding code can copy that collection into the
profile. The profile marker `.no-bundled-skills` opts out of most such seeding;
`.skillex-only` suppresses bundled seeding altogether. Skillex establishes both
when creating a strict projection so another writer cannot repopulate that
managed root with stock copies.

Neither marker is a switch that disables `skill_manage` or personal learning.
The 0.4.3 refusal when an already-strict profile loses `.no-bundled-skills` is a
policy-consistency check. It must not be described as disabling learned skills.
This decision does not request removing those markers or changing their repair
policy.

## Implementation boundary and acceptance

At investigation time, the nine named profiles use `skills.create_dir:
learned-skills`. Four contain 21 learned `SKILL.md` definitions (Marge Simpson 2,
n8n specialist 1, Peter Griffin 6, rererere 12); the other five contain none.
They are currently runtime files, not Git-tracked personal source. Seven
profiles also have a legacy `skills/autonomous-ai-agents/` category tree;
classify and preserve it separately, not as newly learned content.

Flume already has personal identity desks under `~/.agents/workforce/<name>/`
in the agents Git repository. That is a candidate durable owner, **not a deployed
source migration**. Existing repo-link sources support explicitly selected flat,
globally unique skill names, not a fully automatic identity-scoped collection.
Configuration alone is therefore insufficient for the final contract.

Implementation must prove:

- source ownership and personal identity resolution independent of current CWD;
- asynchronous creation and subsequent edits through the real Hermes writer;
- safe supported config rendering rather than hand-edited generated files;
- metadata/content validation, collision refusal and visible failed checkpoints;
- Git commits and remote push containing the actual learned definitions;
- no-loss import of existing definitions and their supporting files;
- discovery after a new project/post assignment and after strict profile resync;
- no unintended global activation and no copied second canonical definitions;
- ordinary PM behavior unchanged unless separately authorized.

Tracked in **SKRILL-47**. Acceptance of this ADR is not a claim that the live
migration, auto-checkpoint writer or full runtime integration is implemented.
