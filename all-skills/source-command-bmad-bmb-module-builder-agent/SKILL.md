---
name: "source-command-bmad-bmb-module-builder-agent"
description: "Module Builder agent (routes to bmad-module-builder skill, v1.7.0)"
---

# source-command-bmad-bmb-module-builder-agent

Use this skill when the user asks to run the migrated source command `bmad-bmb-module-builder.agent`.

## Command Template

INVOKE the `bmad-module-builder` skill via the Skill tool. Pass any user arguments verbatim as the `args` parameter.

In v1.7.0 the legacy "agent" persona is consolidated into the skill itself. This file remains so the slash command keeps resolving — it's a thin router.
