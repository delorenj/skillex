# delorenj Skill Ecosystem

My [skill collection](./all-skills/) structured into categorized sets of compatible combinations.

## Definitions

- **Skill Root**: The skill path used by an agentic coding CLI containing a collection of skills. i.e. `/my-project/.agents/skills`, `~/.claude/skills`, etc.
- **`all-skills/`**: A git submodule that tracks my personal collection of [skills](https://github.com/delorenj/skills)
- **agentpack**: Similar to Claude's `Plugin`, but CLI-agnostic. Contains:
  - **skills**: A `Skill Root` containing a collection of non-overlapping synergistic skills.
  - **references/**: A set of supporting docs that the skills may refer to in cases where clarity is worth the token cost of extra context.
  - **hooks/**: CLI-specific hooks that are called by the agent. To make universal, all hooks must invoke a common set of scripts. While some CLIs may not support all hook events, we can't guarantee 100% parity, but we can mitigate by ensuring that all hook logic is shared from a single source.
  - **scripts/**: CLI-agnostic scripts that are called by the agent or it's hooks.
  - **commands/**: CLI-agnostic prompts that act as entry points for the agentpack's skills.
- **Meta Skill** - A special 'root' `SKILL.md` that is referenced as the entrypoint for large skills that span multiple files. It acts as a router designed to facilitate progressive discovery and minimize context clutter.

## Rules and Guidelines

- `Skill Roots` must be named `skills/`
- `Skill Roots` must not contain competing or overlapping skills. The exception is `[all-skills](./all-skills/)` which is a special case and by definition, contains all skills regardless of compatibility.
  - NOTE: Consider modifying how this is named/arranged around unix-like available/enabled pattern.
- There must be no duplicate skills.
- All skills are defined once in [all-skills](./all-skills/) and symlinked elsewhere when needed.

> WIP
> To be iterated on and refined over time
