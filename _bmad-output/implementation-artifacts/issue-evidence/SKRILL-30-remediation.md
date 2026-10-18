# SKRILL-30 — Remediation evidence (quality-review HOLD items)

Worker: sole SKRILL-30 implementation subagent (this session).
Scope honored: edits only in `all-skills/html-artifact-delivery/` plus this report.
No commits, no pushes, no S3/network publication, no `mc` invocation, no
credential/config reads, no activation, no board or lease writes. All tests run
offline with fake transports (FakeRemote runner/fetch injected via `main()`).

## What was run (actual commands, from `all-skills/html-artifact-delivery/`)

```
python3 -m unittest discover -s tests        # Ran 56 tests — OK
python3 -m unittest discover -s tests -v     # per-test listing, all ok
python3 scripts/publish_html_artifact.py --bundle assets/sample-bundle \
  --entry index.html --artifact smoke --project demo \
  --bb-session-id 11111111-2222-4333-8444-555555555555
# -> ok: True, delivered: False, publishable: True, 4 files, entry_url correct
```

Baseline before edits: 42 tests OK (reproduced the prior claim). After
remediation: **56 tests OK** (42 existing unchanged + 14 new regression tests,
1 root-guarded skip logic included in the 56).

## Findings → fixes (all in `scripts/publish_html_artifact.py` unless noted)

| # | Review finding | Fix | Regression test |
|---|---|---|---|
| 1 HIGH | `.s3cfg`, `.pgpass`, `secrets.toml` publishable; PGP key pattern miss | `.s3cfg`/`.pgpass` in `DANGEROUS_NAMES`; `secrets.*` and `.env` suffix patterns in `_dangerous`; `PRIVATE_KEY_RE` now matches `PRIVATE KEY BLOCK-----` (PGP armor); dotfiles and `.map/.ts/.tsx/.jsx` get explicit public-exposure `warnings` | `test_credential_files_rejected`, `test_pgp_private_key_block_detected`, `test_source_and_dotfiles_warned_not_blocked` |
| 2 MEDIUM | Timeout mid-upload drops partial record | `upload()` wraps the whole loop: any mid-loop failure (mc error, timeout via `_run`, missing binary) re-raised as `upload_failed` exit 5 with `cause`, `uploaded`, `failed`, `not_attempted` | `test_timeout_mid_upload_reports_partial_accounting`, `test_mc_missing_mid_upload_reports_partial_accounting` |
| 3 MEDIUM | Source can be swapped (symlink/race) between validation and upload | New `_snapshot()`: copies every validated file to a 0700 temp dir and re-hashes; upload reads the snapshot, not live paths; changed/unreadable post-validation source → `bundle_changed` exit 2 before any upload | `test_upload_uses_validated_snapshot_not_live_paths` (swaps `s.css`→external symlink mid-upload; published bytes stay `body{}`, no TOPSECRET), `test_snapshot_detects_post_validation_change` |
| 4 LOW-MED | Unreadable file → traceback, no JSON | `scan_bundle` catches `OSError` per file → `unreadable file rejected` error entry; `_git_main_worktree` reads wrapped; `main()` has `except OSError` and `except TimeoutExpired` JSON fallbacks | `test_unreadable_file_gets_json_receipt` (skipped under root) |
| 5 LOW | JS parser false positives block valid bundles | `JS_IMPORT_RE` lookbehinds reject `.`/`[`/quote-backed occurrences (`var kw=["import",...]`); non-JS `<script type>` (JSON/importmap/template) no longer captured as JS via `JS_SCRIPT_TYPES` | `test_js_keyword_array_not_unresolved`, `test_non_js_script_blocks_not_scanned_as_js` |
| 6 LOW | `srcset` data: URI false error | `_srcset_candidates()` splits on comma-followed-by-whitespace when `data:` present | `test_srcset_data_uri_no_false_missing` |
| 7 LOW | Standalone SVG dependencies unscanned | `.svg` files parsed by `_RefParser` (attrs, inline CSS, `<?xml-stylesheet?>` via `handle_pi`) | `test_standalone_svg_dependencies_scanned`, `test_svg_xml_stylesheet_scanned` |
| 8 INFO | redirects followed silently | not changed (SHA-256 exact match already guards); review listed as informational | — |
| ticket | "no plan-only result claims delivery" | `delivered` flag: `true` only after upload+verify success; `false` on plan and every failure path | `test_delivered_flag_false_for_plan_and_failures_true_for_verified_publish` |

`SKILL.md` updated to match behavior: scan-rejects list (new credential names,
PGP armor, unreadable files, SVG refs, non-JS script blocks, dotfile/map
warnings), partial-failure accounting (timeout/mc-missing included),
snapshot/`bundle_changed` behavior, `delivered` semantics, exit-code wording.

## Files changed

- `all-skills/html-artifact-delivery/scripts/publish_html_artifact.py` (repair)
- `all-skills/html-artifact-delivery/tests/test_publish_html_artifact.py` (+`RegressionSKRILL30Tests`)
- `all-skills/html-artifact-delivery/SKILL.md` (docs match behavior)
- `_bmad-output/implementation-artifacts/issue-evidence/SKRILL-30-remediation.md` (this report)

## Notes for reviewers

- Exit-code contract refined: exit 4 = remote failure before any upload;
  any failure during the upload loop = exit 5 with full accounting.
- Snapshot lives under `TMPDIR` (profile scratch), mode 0700, removed in a
  `finally` on every path including collision/verify failure.
- AC5 global activation and AC6 independent spec/quality review + live smoke
  remain reserved for the parent. Nothing here claims ticket completion.
