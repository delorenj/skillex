# SKRILL-30 — Independent final quality gate (after Q1–Q5 repairs)

**Verdict: PASS.** The second remediation is deployment-ready for the gates in
scope. AC5 (Skillex activation) and the AC6 live smoke remain intentionally
pending, parent-owned next steps — not gate failures.

Reviewer is fresh and independent of both the repair worker and both prior
reviewers. No code edits, commits, credentials, network, `mc` commands,
activation, or board calls. The only repository write is this report; the
probe lives in scratch.

## Artifacts verified

SHA-256 re-hashed by this reviewer and matching the repair report exactly:

| File | SHA-256 |
|---|---|
| `all-skills/html-artifact-delivery/scripts/publish_html_artifact.py` | `f66d42423ce5b05637f764707f0b7dd2c49a259c54f7ed420879c8f48408da7c` |
| `all-skills/html-artifact-delivery/tests/test_publish_html_artifact.py` | `c7f765d32a95af29551cd4fba849be0c3fcc253aba214f4cdbff7023d0a93d1b` |
| `all-skills/html-artifact-delivery/SKILL.md` | `b7c6587c5662f1fc800d5cf17da782c94fd674537cd444d95a99acf1ec5ab1e1` |

Inputs read: `SKRILL-30-quality-rereview.md` (HOLD, Q1–Q5),
`SKRILL-30-quality-rereview-repair.md`, `SKRILL-30-spec-final.md` (PASS), and
the six AC from `skrill30-description.html`. Evidence files live at the repo
root `_bmad-output/implementation-artifacts/issue-evidence/` (the ticket text's
skill-relative path is wrong; contents match by name).

## Independently executed

```
cd /home/delorenj/code/skillex/all-skills
python3 -B -m unittest discover -s html-artifact-delivery/tests
# Ran 66 tests in 0.056s — OK (no skips as non-root; reviewer uid is non-root)

python3 -B "$TMPDIR/skrill30-quality-final-probe.py"
# 11/11 checks passed, exit 0
```

## Code review of the actual repaired bytes

Read `publish_html_artifact.py` in full (1043 lines). Confirmations against
the code itself, not the repair prose:

- **Q1 fix is real handle binding.** `_collect_files()` (:481-584): fd-relative
  DFS, `O_NOFOLLOW|O_DIRECTORY` on every directory open, `O_NOFOLLOW` on every
  file open relative to the parent fd, `fstat` identity `(ino, dev, mode)` +
  nlink check against the enumeration `lstat`, bytes read only from the
  validated handle via `_read_all(fd)` (:467-478, honors `MAX_READ_BYTES`).
  `_open_bundle_root()` (:785-801) opens the bundle through a `/`-rooted
  `O_NOFOLLOW` chain, so directory components cannot be symlink-swapped
  either. `MAX_DEPTH=64`, `MAX_FILES=2000` bounds present.
- **Q2 fix covers the general OS-error class.** `_run()` (:740-753) translates
  every remaining `OSError` into `Failure(EXIT_REMOTE, "os_error", …)` with
  `redact()`; `upload()` (:879-912) additionally catches raw `OSError` from
  bypassing runners and re-raises with `uploaded`/`failed`/`not_attempted`
  plus retry guidance. `main()`'s outer `OSError` handler is now unreachable
  from the upload loop by construction, and even a bypass is JSON-reported.
- **Q3 fix is a real tokenizer.** `_srcset_candidates()` (:270-298) tracks
  URL vs descriptor state; commas inside `data:` URL bodies are kept,
  descriptor-terminating commas split candidates with or without whitespace.
- **Q4 fix is fail-closed enumeration.** `fail_closed()` (:492-502) maps
  EACCES/EPERM/ELOOP/other to structured `walk_failed` before any planning;
  no `os.walk` remains. Per-file unreadability stays a receipt error
  (:558-561) that blocks publish without hiding the rest.
- **Q5 fix owns cleanup.** `_snapshot()` (:820-876) wraps everything after
  `mkdtemp` in `except BaseException: rmtree; raise`; `main()` guards its
  post-publish `rmtree` with `contextlib.suppress(OSError)` (:1003-1005).
- SKILL.md contract lines updated: partial-failure reporting for "any other
  OS error mid-upload" (:83-86), unreadable-subdirectory rejection (:63-66),
  snapshot self-cleanup (:92-93).

All 10 new regression tests exist by name and assert genuine interleavings
(zero transport calls, zero uploads, receipt fields, leaked-dir checks) —
never weakened assertions.

## Fresh adversarial probes (third independent set)

`$TMPDIR/skrill30-quality-final-probe.py` — written by this reviewer with
deliberately different interleavings and fixtures from both prior probe sets:

| Check | Result |
|---|---|
| q1a: name → outside symlink swapped between enumeration `stat` and the open | PASS — exit 2, `symlink rejected`, 0 transport calls, 0 outside bytes |
| q1b: name → different regular file (`os.replace`, distinct inode) same window | PASS — exit 2, `changed during scan rejected`, 0 uploads |
| q2: `OSError(EAGAIN)` mid-upload at `s.css` with two later files | PASS — exit 5, `cause: os_error`, `uploaded:[index.html]`, `failed:s.css`, `not_attempted:[w.js,z.js]`, retry hint, store holds exactly the uploaded object |
| q3: 5 tokenizer shapes (no-space pair, data-URI second, lone data-URI, two data-URIs, plain) + absent first candidate blocks publish | PASS (6 checks) |
| q4: unreadable subdir two levels deep (`css/deep/`, distinct from the tested `nested/`) | PASS — exit 2 `walk_failed` naming `deep`, 0 transport calls |
| q5: source mutated after the snapshot already wrote one file (mid-copy window) | PASS — exit 2 `bundle_changed`, 0 leaked snapshot dirs, 0 transport calls |
| e2e: 4-object nested publish through injected FakeRemote | PASS — exit 0 `delivered:true`, all verified (status/MIME/SHA-256), entry URL `https://s3.delo.sh/projects/demo/{session}/report/index.html` |

11/11 passed. Offline, synthetic fixtures under `$TMPDIR` only; reuses the
suite's `FakeRemote` injection surface into `main()`.

## Probe-design errors investigated and closed (not code defects)

- Q1b first run "passed the identity check": my `unlink+copyfile` swap let the
  filesystem reuse the freed inode with identical mode, so the `fstat`
  identity tuple legitimately compared equal. Confirmed empirically
  (inode-reuse demo); retested with `os.replace` (guaranteed distinct inode)
  — the check fires. Importantly, even in the inode-reuse case the boundary
  holds: the `O_NOFOLLOW` fd-relative open cannot read outside the bundle, and
  whatever in-bundle bytes are read are hash-pinned into the plan and
  re-verified in `_snapshot`. The inode check is defense-in-depth, not the
  boundary control; no outside-bytes path exists.
- Q2 first run expected `not_attempted: []` with a failure injected at
  `z.js` — which sorts last in the plan, so an empty not-attempted list was
  correct accounting. My expectation was wrong, not the receipt. Re-injected
  at `s.css` (two later files) — accounting exact.

## Verified non-defects (checked, no action needed)

- A file that vanishes between `listdir` and `stat` is skipped (:518-519) —
  it was never validated or read, cannot be uploaded, and any reference to it
  fails validation as a missing asset. Fail-safe.
- `upload()`'s `plan["files"][len(uploaded)]` indexing is safe: upload is
  unreachable with an empty plan (entry must be present or errors block first).
- Snapshot mutation between write and `mc cp` is outside the threat model
  (0700 mkdtemp dir owned by the running user) and would be caught by the
  SHA-256 HTTPS verify step regardless.

## Gate disposition

- AC1–AC4, AC6 test clause: satisfied against actual code, 66/66 tests,
  11/11 fresh probes, both prior reviewers' evidence consistent with bytes
  on disk (hashes match).
- AC5 activation and the AC6 live smoke: **deliberately pending**, sequenced
  after this gate per the ticket. Deployment may proceed to those steps.
