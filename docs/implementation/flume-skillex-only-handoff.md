# Flume PM delegation: enforce Skillex-only PM ownership

Operator explicitly authorized this work on 2026-10-01: "Fix everything";
Skillex-only PM skills mandatory, canonical defensive provisioning, and notify
Flume via flume-pm. Parent is skillex-pm, working in ~/code/skillex.

## Flume-owned task

Use TDD to repair Flume/template ownership seams. Follow repository rules, inspect
current Git state and preserve other agents' changes. No commit/push unless the
operator separately authorizes it. Return actual paths, tests and resulting
command handles through your normal completion report.

1. EnsureTemplateConfig.ts still emits retired canonical_skills_dir and
   symlinked_runtime_skills (including 33god-projects though directory is
   projects). Remove these keys from schema emission and retire them deliberately
   from existing host config without disturbing unrelated values. Retire stale
   pm_external_skill_dirs too. Fix docs/audits accordingly.
2. Canonical template 10-hermes-profile.sh creates with --no-alias but not
   --no-skills. Existing-profile rerun unconditionally removes gateway.pid,
   gateway_state.json, processes.json and state.db after skills sync: NEVER do
   that to an existing/live profile. Restrict initial cleanup to genuinely new
   provisioning and test the real caller's rerun behavior.
3. PM skills must be a real root projected exclusively by Skillex. No whole-root
   alias to default Hermes, no local shadow skills, no bundled seeding or archive
   discovered in active roots. Preserve unowned content; never blindly delete.
   Use Skillex commands and fail with actionable guidance rather than implement
   a second skills writer in the template. Existing whole-root aliases require
   explicit skillex migrate, not opportunistic edits in setup.
4. Parent is implementing `skillex profile sync NAME --project PATH
   --skillex-only`: persistent `<profile>/.skillex-only` and bundled optout;
   strict mode refuses foreign children, preserving existing generic mode for
   non-PM profiles. Coordinate package availability: installed 0.1.2 does not
   yet have the flag. Do not claim npm release/deployment until available. New
   template must fail closed if strict capability unavailable, not silently
   downgrade. Parent owns Skillex implementation, live PM preservation cutover,
   and catalog workflow guidance; you own Flume and canonical template.
5. Enforce the policy in Flume handbook/audit (including external_dirs that can
   expose unrelated skill roots). Document Skillex import/select/sync commands
   as the correct authoring/activation flow instead of Hermes local install.

## Evidence

- skillex-pm/skills -> ~/.hermes/skills. 22 of 26 visible PMs whole-root aliases.
- `skillex profile show skillex-pm --project ~/code/skillex` refuses
  E_PROFILE_SKILLS_ROOT. `skillex migrate --profile ... --project ...` preserves
  old children by forwarding links; migration alone is NOT Skillex-only.
- Hermes local definitions override external roots. Relative external_dirs
  resolve against HERMES_HOME, NOT terminal CWD. Fleet ./agents/skills is wrong.
- Native /skills list calls external Skillex names "local" when not recorded in
  Hermes manifests. Verify physical paths, not this label.
- Current step 10 in skillex: lines 49, 55-58, 61-65 are the relevant seams.
- Flume packages/flume-hr/src/hire/EnsureTemplateConfig.ts lines 90, 98.
- Prior worker found c27b8b0 replaced old shared-root alias writer; legacy state
  survives because new sync refuses it. No need to reintroduce old writer.

Do not rerun full step 10 or restart gateways as a skills-only repair. Parent
will preserve state and validate actual pinned Hermes discovery separately.
