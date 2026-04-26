# 33god-dev

Strawman loadout for 33god development. Populate the slots once the relevant
skills in `all-skills/` have `slotType` frontmatter declared.

## Expected slots

| Slot | Type | Candidate skill |
|------|------|-----------------|
| memory | Memory | hindsight (needs slotType frontmatter) |
| workflow | Workflow | n8n-bridge (if created) |

## Activation

```
skillex pack lint 33god-dev
skillex pack activate 33god-dev --scope global --dry-run
skillex pack activate 33god-dev --scope global
```
