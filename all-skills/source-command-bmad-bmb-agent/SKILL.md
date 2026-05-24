---
name: "source-command-bmad-bmb-agent"
description: "Build, edit, or analyze a BMAD agent (routes to bmad-agent-builder skill, v1.7.0)"
---

# source-command-bmad-bmb-agent

Use this skill when the user asks to run the migrated source command `bmad-bmb-agent`.

## Command Template

INVOKE the `bmad-agent-builder` skill via the Skill tool. Pass any user arguments verbatim as the `args` parameter.

The skill auto-detects intent (Create / Edit / Analyze). No file path lookup is required — this command is a thin router to the v1.7.0 skill.
