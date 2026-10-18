# SKRILL-30 — HTML artifact delivery

Actor: skillex-pm

## Contract
- Trigger on delivery of any HTML artifact, irrespective of authoring tool, worktree, hidden directory or BMAD output location.
- Publish a complete explicit bundle (HTML, CSS, JS, images and other required assets) below https://s3.delo.sh/projects/{project-slug}/{Bloodbank-session-UUID}/.
- Preserve relative paths; return an exact HTML entrypoint URL and verify remote bytes/types. Local paths alone are not delivery.
- Keep authoring separate from delivery. No hard-enforcement claim from skill discovery alone.
- Resolve real project/session identity and fail on ambiguity; never mint an unrelated random ID.
- Add one canonical skill to global selection through Skillex, preserving all unrelated work.

## Verified infrastructure
- projects bucket did not exist initially (authenticated mc listing and stat).
- Operator explicitly selected a new dedicated projects bucket with public read-only access.
- Created via mc mb delo/projects. Read-back policy contains only s3:GetObject on arn:aws:s3:::projects/* for anonymous principal.
- Anonymous bucket listing remains HTTP 403 by design.
- Anonymous PUT probe returned HTTP 403; authenticated stat confirmed no probe object was created.
- Decision event 9659836b-c076-484b-9ce9-40ff2abce388 was read back from CandyStore with correct skillex-pm attribution and repo=skillex.
- Existing mc alias delo reaches https://s3.delo.sh. No credential values belong in this evidence.
- S3 endpoint health at localhost:9012 is HTTP 200.

## Identity evidence
Bloodbank clients/base.py:182-187 preserves UUID native IDs; otherwise UUID5(NAMESPACE_URL, 'bloodbank:{harness}:{native-id}'). HermesAdapter delegates this method.
Persisted current hook state has native session 20261017_134801_419ca7 and cwd /home/delorenj/code/skillex.
Canonical session UUID: db31c489-fbe6-5aa0-933e-b775364c3136. Confirmed by live CandyStore event fc1d3fa1-6f77-4ca6-8dfc-b80b3f884723 (bloodbank.agent.tool.requested), not merely computed.
.project.json project_id: skillex (not board identifier SKRILL).

## Global activation baseline
Global sync dry-run converged, zero changes. Claude, Codex, Gemini, Copilot, Kimi, OpenClaw and OpenCode discovery aliases resolve to ~/.agents/skills.
Own Hermes profile strict sync currently refuses an unrelated unowned .bundled_manifest. No remediation or profile mutation authorized by this evidence; global roots are separate.

## Verification gates
Initial helper: 32 tests passed parent-side. Offline plan includes HTML/CSS/JS/SVG and correct project/session. Global activation preview contains only manifest addition, one canonical link and receipt update; no removals.
First real smoke uploaded all four objects. CSS/JS/SVG public SHA+MIME verification passed; HTML failed SHA because Cloudflare injected its analytics beacon. A separate no-cache,no-transform HTML transport probe returned byte-identical public HTML. Strict verification remains required; sole remediation worker is adding no-transform rather than stripping injected content.
Browser rendered CSS=styled, Image=loaded, JavaScript=running on first smoke; console reported root favicon 403, so sample will use a relative SVG favicon.
Parent also reproduced empty-file digest and trailing-newline slug bugs; queued fixes plus endpoint validation, unresolved external-asset publish refusal, symlink ancestor refusal and malformed-preflight fail-closed.
Independent SPEC review: PASS against remediated 42-test version (report /tmp/skrill30-spec-result.txt). Parent reran 42 tests PASS.
Corrected live full bundle: https://s3.delo.sh/projects/skillex/db31c489-fbe6-5aa0-933e-b775364c3136/delivery-smoke-v2/index.html — all four objects HTTP 200 with matching MIME and SHA256. Receipt /tmp/skrill30-live-v2.json. Browser DOM confirms CSS styled, Image loaded, JavaScript running; error console empty, all artifact requests 200. Screenshot /tmp/skrill30-browser.png.
Second publish to same prefix refused with collision exit 3 and no upload. Bucket policy readback remains GetObject-only.
Independent quality HOLD: credential guard misses common files/PGP keys; timeout drops partial upload receipt; source can mutate into external symlink between scan and upload. Three remediation attempts stalled without changes and were stopped. No active worker remains. SKRILL-30 returned to Todo and driver lease released. Global activation NOT APPLIED. Resume with one bounded worker for credential guards, validated private snapshot, error/partial accounting and delivered flag; then independent re-review and final live smoke. Existing source remains the 42-test version reviewed HOLD.

## Security incident
Delegated implementer printed a credential-bearing mc alias listing in its tool transcript despite a prohibition. Parent instructed it to stop credential inspection, not repeat values, and disclosed the incident to the operator. Credentials should be rotated through the existing 1Password-managed procedure; no automatic rotation performed in this task.
