# delorenj Skill Ecosystem

My [skill collection](./all-skills/) structured into categorized sets of compatible combinations.

## Definitions

These definitions were explicitly confirmed by the user on 2026-10-10. They
outrank contrary implementation behavior, older docs, tests, and recalled memory.

- **Skill Root**: A directory where an agent looks for skills, almost always named `skills/`.
- **Global Skill Root**: A directory an agent automatically loads skills from regardless of project scope.
- **Canonical Skill Root**: Skillex's SSOT skill root: `~/.agents/skills/` globally, or `<project>/.agents/skills/` locally. Agent-specific discovery roots alias this root.
- **Skill Set**: Replaces a skill root. Selecting one in the manifest replaces `.agents/skills/` with a symlink to the set's skill root. **Sets are mutually exclusive.**
- **Skill Pack**: Populates an existing skill root with per-skill symlinks. A pack containing ten distinct additional skills adds ten links, not a root replacement. **Packs are composable.**
- **`all-skills/`**: The Git submodule holding canonical skill definitions from [skills](https://github.com/delorenj/skills). This definition catalog is not the canonical discovery root.
- **agentpack**: A skill pack with CLI-agnostic support assets, similar to Claude's `Plugin`. Its skills retain additive pack semantics. Contains:
  - **skills**: A `Skill Root` containing a collection of non-overlapping synergistic skills.
  - **references/**: A set of supporting docs that the skills may refer to in cases where clarity is worth the token cost of extra context.
  - **hooks/**: CLI-specific hooks that are called by the agent. To make universal, all hooks must invoke a common set of scripts. While some CLIs may not support all hook events, we can't guarantee 100% parity, but we can mitigate by ensuring that all hook logic is shared from a single source.
  - **scripts/**: CLI-agnostic scripts that are called by the agent or it's hooks.
  - **commands/**: CLI-agnostic prompts that act as entry points for the agentpack's skills.
- **Meta Skill** - A special 'root' `SKILL.md` that is referenced as the entrypoint for large skills that span multiple files. It acts as a router designed to facilitate progressive discovery and minimize context clutter.

## Rules and Guidelines

- **No skill-operation mise tasks (2026-10-10).** Treat existing skill-management tasks as wrong and remove them and their task-call edges, not their version pins alone. Use `skillex` directly; never recreate mise wrappers. Preserve unrelated tasks and tool/runtime installation. Detect and remediate through `skillex integrations retire-mise` (preview, then `--apply`), within the authorized pilot/rollout scope. Fix generators when in scope so tasks cannot return.

- Skill roots are almost always named `skills/`; Skillex's canonical roots are specifically `.agents/skills/`.
- **Sets select the root; packs add skills to it.** This distinction applies in both global and project scopes. Do not infer semantics from legacy exclusive-pack or additive-set behavior.
- Preview before applying selection changes. A plan that reverses these operations is implementation drift, not product authority. Inheritance, name collisions, and pack additions through shared set targets need explicit policy; do not invent it.
- `Skill Roots` must not contain competing or overlapping skills. The exception is `[all-skills](./all-skills/)` which is a special case and by definition, contains all skills regardless of compatibility.
  - NOTE: Consider modifying how this is named/arranged around unix-like available/enabled pattern.
- There must be no duplicate skills.
- All skills are defined once in [all-skills](./all-skills/) and symlinked elsewhere when needed.
- Skill sets and agentpacks are reference-only compositions. They may own
  composition metadata and pack-level support assets, but must never contain a
  real `SKILL.md`; there is no snapshot-pack exception.
- The enforceable ownership contract is
  [ADR-0001](./docs/architecture/ADR-0001-reference-only-skill-topology.md).

> WIP
> To be iterated on and refined over time
