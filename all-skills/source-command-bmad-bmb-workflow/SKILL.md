---
name: "source-command-bmad-bmb-workflow"
description: "Build, modify, quality-check, or convert a BMAD workflow/skill (routes to bmad-workflow-builder skill, v1.7.0)"
---

# source-command-bmad-bmb-workflow

Use this skill when the user asks to run the migrated source command `bmad-bmb-workflow`.

## Command Template

INVOKE the `bmad-workflow-builder` skill via the Skill tool. Pass any user arguments verbatim as the `args` parameter.

The skill auto-detects intent (Build / Modify / Quality check / Analyze / Convert). No file path lookup is required — this command is a thin router to the v1.7.0 skill.
