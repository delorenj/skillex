# SKRILL-30 — Independent spec re-review (post-remediation)

Reviewer: independent spec-gate subagent (not the implementer). Read-only on code;
the only write is this report. No commits, board calls, activation, network
publication, credential reads, or `mc` invocations.

Scope: AC1–AC4 implementation compliance and AC6 offline-test readiness against
the **actual files** in `all-skills/html-artifact-delivery/`. AC5 global
activation and the AC6 live smoke are deliberate post-review gates owned by the
parent; they are assessed for readiness only, not as gaps.

**Verdict: PASS** for the implementation-readiness gate (AC1–AC4 compliant,
AC6 offline coverage complete). Ticket completion still requires the reserved
post-review steps listed at the end.

## What was independently executed (not taken from worker reports)

- `python3 -m unittest discover -s tests` from the skill dir → **56 tests, OK**
  (reproduces the parent's and remediation report's claim; includes
  `RegressionSKRILL30Tests` covering all three HOLD findings plus findings 5–7
  and the `delivered` flag).
- A separate offline probe suite (`$TMPDIR/skrill30-spec-probe.py`, fake
  `mc` runner + fake HTTPS fetch injected via `main()`; zero network, zero
  subprocess in plan mode) — **34/34 probes PASS**, covering every AC1–AC4
  clause. Three initial probe "failures" were bugs in my own assertions
  (alphabetical upload order `j.js` < `s.css`; a 1-char secret marker that
  trivially matched unrelated output) — the implementation behaved correctly
  in each case; corrected probes all pass.

## AC1 — canonical skill instructs universal use. PASS

- `SKILL.md:3` description: "Deliver every HTML artifact (reports, dashboards,
  docs, BMAD/worktree/hidden outputs, …). Use whenever you hand an HTML file to
  the user, whichever skill authored it" — trigger covers local, worktree,
  hidden-directory and BMAD outputs.
- `SKILL.md:8-14`: authoring stays separate ("composes with whichever skill
  authored the page"); explicitly disclaims enforcement ("This is guidance,
  not enforcement"), matching AC1's no-false-enforcement requirement.
- Exactly one definition in the repo: only `all-skills/html-artifact-delivery/`
  exists (`SKILL.md`, `scripts/`, `tests/`, `assets/sample-bundle/`); no other
  copy or set reference anywhere in the repo.

## AC2 — explicit bundle publishes under the fixed URL with verified remote fetch. PASS

Probes (code refs: `publish_html_artifact.py` `build_plan` :549-581,
`upload` :672-696, `verify` :709-735):

- Plan/publish keys preserve relative structure:
  `demo/{session}/probe/{index.html,a/s.css,a/app.js,a/m.mjs,img/x.svg}`;
  `entry_url` = `https://s3.delo.sh/projects/{slug}/{session}/probe/index.html`.
- Clean publish → `delivered: true` only after every object verifies HTTP 200 +
  exact MIME + byte-exact SHA-256; uploaded store bytes re-hash to the planned
  sha256 for all five files.
- Tampered entry bytes → exit 6, `delivered: false`; wrong MIME on CSS → exit 6
  with per-object `problem`. Bucket/base URL are non-overridable constants;
  anonymous HTTPS verification only (`default_fetch`, no credentials).

## AC3 — identity resolves from real evidence, fails closed. PASS

- Missing session env/flags → `session_missing`; two harness envs →
  `session_ambiguous`; conflicting `CODEX_THREAD_ID`/`CODEX_SESSION_ID` →
  `session_ambiguous` (probes; `resolve_session` :107-148). No invented
  fallback anywhere — absence is an error, not a minted ID.
- Project: `.project.json` slug/id from main worktree via Git `commondir`
  (:170-259); conflicting worktree metadata → `project_ambiguous`; missing →
  `project_missing`. Covered by `ProjectTests` (linked-worktree case included).
- Session mapping mirrors Bloodbank (`uuid` passthrough / `uuid5(NAMESPACE_URL,
  'bloodbank:{harness}:{native}')`, :99-104), regression-tested against the
  live-recorded Hermes native id.

## AC4 — boundary, credential/key rejection, validated bytes, structured failure. PASS

Probes against `scan_bundle` :447-528, `_dangerous` :441-444, `_snapshot`
:647-669, `upload` :672-696, `main` :758-817:

- Credential/key files rejected with content never echoed: `.s3cfg`, `.pgpass`,
  `secrets.toml`, `server.key`, PGP `key.asc` (PRIVATE KEY BLOCK regex :78),
  RSA `.pem`; secret bodies absent from the JSON receipt.
- Path escapes: `..` ref → error; symlinked file inside bundle → rejected;
  symlinked `--bundle` argument path → `bundle_invalid` before any scan.
- Validated-bytes upload: swapping `a/s.css`→external symlink after validation
  still uploads the validated `body{...}` bytes (0700 snapshot, re-hashed);
  post-plan mutation → `bundle_changed` exit 2, nothing uploaded; no
  `TOPSECRET` bytes ever reach the store.
- Partial accounting: timeout mid-loop and mc-error mid-loop both → exit 5 with
  `cause`, `uploaded: [index.html]`, `failed: j.js`, `not_attempted: [s.css]`,
  `retry` hint, `ok/delivered: false`. Collision → exit 3, zero `cp` calls.
  Plan mode never touches subprocess/network (probe asserts via injected
  fail-fast runner/fetch) and reports `delivered: false`.

## Prior quality-review findings — all remediated in code, not just report

| Finding | Status | Evidence |
|---|---|---|
| 1 HIGH credential files publishable / PGP miss | fixed | `DANGEROUS_NAMES`/`DANGEROUS_SUFFIXES`/`_dangerous`, `PRIVATE_KEY_RE` :69-78; probes + `test_credential_files_rejected`, `test_pgp_private_key_block_detected` |
| 2 MEDIUM timeout drops partial record | fixed | `upload()` wraps loop; probes above; `test_timeout_mid_upload_reports_partial_accounting`, `test_mc_missing_mid_upload_reports_partial_accounting` |
| 3 MEDIUM mutable-source race | fixed | `_snapshot()` :647-669 + upload from snapshot; probes; `test_upload_uses_validated_snapshot_not_live_paths`, `test_snapshot_detects_post_validation_change` |
| 4 LOW-MED traceback on unreadable file | fixed | OSError handling in scan + `main` :811-817; `test_unreadable_file_gets_json_receipt` |
| 5–7 LOW parser false positives / SVG | fixed | `JS_SCRIPT_TYPES`, `JS_IMPORT_RE` lookbehinds, `_srcset_candidates`, SVG parsing; tests present |

`SKILL.md` matches observed behavior (rejects list, snapshot/`bundle_changed`,
partial accounting, `delivered` semantics, exit codes) — spot-checked line by
line during probes.

## Non-blocking observations (recorded, not gating)

- `verify()` follows redirects without checking the final URL (prior INFO,
  unchanged). Byte-exact SHA-256 makes a wrong-body false-positive negligible.
- Preflight collision check is not atomic under concurrent publishes — already
  documented as a limit in `SKILL.md:79-81`.
- Snapshot re-hash closes the scan→upload race to the extent of the prior
  finding; a same-UID attacker racing the 0700 snapshot dir is outside the
  stated threat model.

## Remaining post-review checks (reserved for parent — not defects)

1. Independent **quality** re-review against the final files (this gate covers
   spec compliance only).
2. **AC5**: global Skillex activation after both reviews pass — must preserve
   unrelated selections, show a converged repeat preview, and resolve via
   supported client discovery. No activation has been applied (verified: no set
   or profile references exist yet), correctly awaiting the gates.
3. **AC6 final gate**: live smoke publication of `assets/sample-bundle` proving
   HTML+CSS+JS+image delivery, with URL and verification evidence recorded
   (prior smoke evidence predates the remediated code and must be re-run).
