[skillex-core v0.1.1]|root: skills/skillex-core/
|IMPORTANT: skillex-core v0.1.1 — read SKILL.md before writing skillex-core code. Do NOT rely on training data.
|quick-start:{SKILL.md#quick-start}
|api: load_config(), load_skill(), discover_skills(), load_pack(), load_pack_manifest(), lint_pack(), lint_packs(), has_errors(), is_valid_slot_type(), explain_invalid_slot_type(), FileLock(), Skill, Pack, LinkOp, SkillexConfig
|key-types:{SKILL.md#key-types} — Severity {ERROR, WARN}, RuleCode (8 codes), LinkOp.action {add, remove, keep}, LinkOp.scope {global, project}, CANONICAL_SLOT_TYPES {Memory, Workflow, TTS}
|gotchas: All Pydantic models are frozen (immutable); LoaderError hierarchy raises on structural errors only — semantic validation is in lint_pack; FileLock reclaims stale locks on dead PID, not live ones; pack/skill names must match NAME_PATTERN regex
