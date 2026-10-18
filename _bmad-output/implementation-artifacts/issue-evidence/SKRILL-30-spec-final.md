# SKRILL-30 — Independent spec re-review (final, after Q1–Q5 repairs)

**Verdict: PASS** for the independent spec gate. Implementation-ready; AC5
(Skillex global activation) and AC6 (live smoke) deliberately follow this gate
and are **out of scope here by design**, not deficiencies. No code edits,
commits, credentials, network, activation, or board calls were made.

## Scope and method

- Six AC from the supplied description (`skrill30-description.html`).
- Repair evidence read: `SKRILL-30-quality-rereview.md` (HOLD, Q1–Q5) and
  `SKRILL-30-quality-rereview-repair.md` (all five repaired).
- Files reviewed against SHA-256 in the repair report — **exact match**:
  - `scripts/publish_html_artifact.py` → `f66d4242…48da7c`
  - `tests/test_publish_html_artifact.py` → `c7f765d3…0a93d1b`
  - `SKILL.md` → `b7c6587c…ab1e1`
- Independent test run (this reviewer, not the repair worker):

  ```
  cd /home/delorenj/code/skillex/all-skills
  python3 -B -m unittest discover -s html-artifact-delivery/tests
  # Ran 66 tests in 0.052s — OK  (matches the claimed 66; no skips as non-root)
  ```

- Fresh adversarial probes written by this reviewer (not reused from the
  repair worker or the previous reviewer):
  `$TMPDIR/skrill30-spec-final-probe.py`. Injected fake runner/fetch into
  `main()`, synthetic fixtures under `$TMPDIR` only, no real transport.
  28 checks; 27 passed outright. The 28th ("Q3 absent 2x candidate blocks
  publish") initially expected exit 0 + `publishable: false`; actual behavior
  is stricter — exit 2 fail-closed with
  `missing local asset 'missing.png'` in errors — which satisfies AC2/AC4.
  Semantically 28/28 pass.

## AC-by-AC evidence

**AC1 — canonical skill instructs delivery; authoring separate.** `SKILL.md`
frontmatter description ("Use whenever you hand an HTML file to the user,
whichever skill authored it") plus body ("Delivery policy for **any** HTML…
A local path or `file://` link is not a delivery"; composes with BMAD,
dashboards, reports, docs, build tools). Explicitly states "This is guidance,
not enforcement" — matching the AC's carve-out that discovery is not claimed as
hard enforcement. `all-skills/html-artifact-delivery` is the only location
matching that name in the repo (single search hit), so the "one canonical
definition" precondition of AC5 holds. **PASS.**

**AC2 — explicit bundle publishes beneath the prefix, paths preserved,
remotely verified.** End-to-end probe (`--publish` through injected
FakeRemote + fetch): exit 0, `delivered: true`, all 4 objects
(index.html, css/s.css, i.png, a.js — nested relative path preserved)
verified `ok: true` (status/MIME/SHA-256 via `verify()`, `publish_html_artifact.py:925-951`).
`entry_url` = `https://s3.delo.sh/projects/demo/{bb-session-id}/report/index.html`.
Plan-only run: exit 0, `delivered: false`. **PASS.**

**AC3 — identity from real evidence; missing/conflicting fails closed; no
invented fallback.** `resolve_session()` (:113-154): explicit UUID vs
harness/native mutual exclusion (`session_ambiguous`), missing →
`session_missing`, multiple harness envs → `session_ambiguous`; UUID passthrough
or `uuid5(NAMESPACE_URL, "bloodbank:{harness}:{native}")` matching Bloodbank
hooks; provenance recorded in the receipt. `resolve_project()` (:233-265):
slug preferred over id, conflicting worktree metadata → `project_ambiguous`,
explicit `--project` disagreement → fail. Probes confirmed `session_missing`
and `session_ambiguous` fail-closed. Existing tests cover the project variants
(13 tests, `test_slug_preferred_over_id` … `test_explicit_project`). **PASS.**

**AC4 — bundle boundary, credential/key rejection, validated-bytes upload,
structured partial-failure reporting.**
- Boundary is now handle-bound, not path-re-check-bound. `_collect_files()`
  (:481-584): fd-relative depth-first traversal, `O_NOFOLLOW` on every open,
  `fstat` identity check (ino/dev/mode + nlink) against the enumeration
  `lstat`, bytes read only from validated handles (`_read_all`), name-swap
  races → `changed during scan rejected`; symlinked-directory components
  unreachable (`ELOOP`). My Q1a probe (swap `a.png` → symlink to an outside
  file immediately after enumeration, before the open): exit 2, zero
  transport calls, zero uploads, no outside bytes anywhere. Q1b (swap to a
  *different regular file*, same race): exit 2 `changed during scan rejected`,
  no uploads — the inode-identity check catches non-symlink swaps the original
  fix idea would have missed.
- `_snapshot()` (:820-876) re-opens through `_open_bundle_root` +
  `_open_rel_dir` with `O_NOFOLLOW`, re-hashes against the plan, and removes
  the partial snapshot on **every** failure path (whole body wrapped after
  `mkdtemp`); `main()` guards its `rmtree` with `contextlib.suppress(OSError)`.
  Q5 probe: post-plan mutation → exit 2 `bundle_changed`, zero leaked
  `html-artifact-delivery-*` dirs in `$TMPDIR`.
- Credential/key rejection: `DANGEROUS_NAMES` (:75-81: `.s3cfg`, `.pgpass`,
  `id_rsa`, `.htpasswd`, …), `DANGEROUS_SUFFIXES` (.pem/.key/.env/…),
  `PRIVATE_KEY_MARK/RE` content scan; covered by existing tests
  (`test_credential_files_rejected`, `test_pgp_private_key_block_detected`).
- Partial-failure accounting: `_run()` (:740-753) normalizes every remaining
  `OSError` (PermissionError, EAGAIN, ENOMEM, …) into `Failure(EXIT_REMOTE,
  "os_error")`; `upload()` (:879-912) additionally catches raw `OSError` from
  bypassing runners and re-raises with full `uploaded`/`failed`/
  `not_attempted` + retry guidance. Q2 probe (raw `PermissionError` on
  `s.css` mid-upload): exit 5, `cause: os_error`,
  `uploaded: ['index.html']`, `failed: 's.css'`, `not_attempted: ['z.js']`,
  retry hint, remote held exactly the one uploaded object.
- No path escapes: entry validated (`..`/absolute/control-chars rejected,
  :600), `..`/root-relative/`file:`/localhost/insecure-http refs rejected in
  `_check_ref` (covered by existing tests `test_traversal_root_relative…`,
  `test_symlinks_rejected`, `test_entry_and_artifact_validation`).
- Q4: unreadable subdirectory → structured `walk_failed` failure
  (`cannot enumerate nested: permission denied (EACCES)`) **before** any
  transport; probe confirmed exit 2, zero transport calls.
- `delivered: true` only on verified publish; plan and every failure emit
  `delivered: false` (probe-confirmed; `test_delivered_flag_false…`).
**PASS.**

**AC6 (tests + reviews) — first clause satisfied to this gate.** 66/66 tests
pass independently (56 pre-existing + 10 new Q1–Q5 regressions, all present
by name: `test_q1_symlink_swap_between_enumeration_and_read_fails_closed`,
`test_q2_permission_error_mid_upload_reports_partial_accounting`,
`test_q3_srcset_second_candidate_without_space_is_required` (+present-variant
+ tokenization cases), `test_q4_unreadable_subdirectory_fails_closed`,
`test_q5_failed_snapshot_leaves_no_partial_copy` + mid-cleanup variant).
Both regression families the AC names (quality-review regressions and the
new Q1–Q5) are covered. Independent quality re-review verdicts are recorded;
this report is the independent spec re-review that AC6 requires before AC5.
The live smoke is correctly sequenced after these gates and is not assessable
here. **PASS to gate** (live smoke pending by design).

**AC5 — assessed for implementation readiness only.** One canonical
definition exists (single `html-artifact-delivery` directory in the repo);
skill is currently untracked in the `all-skills` submodule (consistent with
both prior reports; activation via Skillex is parent-owned and deliberately
deferred until this gate passes). No activation state was touched or
inspected beyond a filename search. **READY, not yet delivered (by design).**

## Notable strengths of the repairs (independently confirmed)

- Q1b regular-file swap: the `fstat` inode/dev/mode identity check closes a
  hole the re-review's suggested "another `is_symlink()` check" would have
  left open — this is genuinely better than the narrow correction asked for.
- Q3 tokenizer is real URL/descriptor state machine; my 5 tokenization cases
  (data-URI+second candidate, no-space separators, data-URI alone, single
  URL, blank segment) all pass, and the original comma-in-data-URI regression
  is preserved.
- Receipts stay structured and redacted (`redact()` on every OS-error path).

## Residual notes (non-blocking, documented in SKILL.md Limits)

- Static discovery only; `fetch()`/dynamic imports not followed (documented,
  tested).
- No atomic concurrent-publish collision guard (documented; preflight catches
  the non-racing case).
- Unreadable subtrees now fail closed — intended behavior change per AC2
  completeness.

## Verdict

**PASS.** All in-scope AC (1–4, AC6 review/test clause) are satisfied against
the actual code and independently executed tests/probes. AC5 activation and
the AC6 live smoke follow this gate per the ticket sequence. Artifacts:
`$TMPDIR/skrill30-spec-final-probe.py` (probe), this report.
