---
name: "source-command-bmad-bmb-module"
description: "Plan, create, edit, or validate a BMAD module (routes to bmad-module-builder skill, v1.7.0)"
---

# source-command-bmad-bmb-module

Use this skill when the user asks to run the migrated source command `bmad-bmb-module`.

## Command Template

INVOKE the `bmad-module-builder` skill via the Skill tool. Pass any user arguments verbatim as the `args` parameter.

The skill auto-detects intent (Ideate / Create / Validate). If unclear, it presents options. No file path lookup is required — this command is a thin router to the v1.7.0 skill.
