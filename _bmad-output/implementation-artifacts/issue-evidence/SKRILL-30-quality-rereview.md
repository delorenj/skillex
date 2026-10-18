# SKRILL-30 — Independent quality re-review

**Verdict: HOLD. Do not activate globally yet.**

The original 56 tests pass, including the named remediation regressions. Independent
adversarial probes nevertheless reproduce a remaining out-of-bundle upload race,
lost partial-upload accounting, and a new `srcset` false-success regression. These
are implementation defects, not objections to the deliberately deferred activation
or live smoke.

## Scope and execution

Reviewed the six ticket AC from the supplied description, the original quality
review, remediation report, independent spec re-review, and the actual canonical
skill, script, and tests. The skill directory is currently untracked in the
`all-skills` submodule, so this review identifies the working files by SHA-256:

| File under `all-skills/html-artifact-delivery/` | SHA-256 |
|---|---|
| `scripts/publish_html_artifact.py` | `8ea2ef19020af742db640877ddd7d7545ae6fdf4e455ff66a57c6f2e185f3476` |
| `tests/test_publish_html_artifact.py` | `3d6a3f6ce2fdf1293165a5bfb12de18fc1aff9b1751478e59c20124d7eeb0169` |
| `SKILL.md` | `82ec88008e7ef696381c5f30e7cc7d168acb8199abdbe74e4bc6c7ca19ca9763` |

Executed independently:

```sh
cd /home/delorenj/code/skillex/all-skills
python3 -B -m unittest discover -s html-artifact-delivery/tests -v
# Ran 56 tests in 0.056s — OK; no skips

cd /home/delorenj/code/skillex
python3 -B "$TMPDIR/skrill30-quality-probes.py"
# exit 0; all five assertions reproduce the defects described below
```

Probe source:
`/home/delorenj/.hermes/profiles/skillex-pm/cache/scratch/skrill30-quality-probes.py`.
It imports the existing `FakeRemote`, injects both runner and fetch into `main()`,
and uses only synthetic fixtures beneath `$TMPDIR`. Assertions intentionally
assert the observed defective behavior, not that quality passed. No real transport,
`mc` command, alias inspection, credential read, activation, board call, source
edit, repository commit, or publish was performed. Existing tests make Git fixture
commits only in scratch repositories. This report is the only repository write.

## Blocking findings

### Q1 — HIGH: boundary validation and the first byte read still race (AC4)

**Location:** `scripts/publish_html_artifact.py:463-485,491-507,655-668`.

`scan_bundle()` checks symlink/type/name safety during enumeration, saves only
relative names, and subsequently calls `Path.read_bytes()`. The later read follows
symlinks, including ones introduced after enumeration. `_snapshot()` then follows
the same source again and compares it to the hash of those already-outside bytes.
Both passes therefore agree and verification reports success.

**Deterministic reproduction:** start with `index.html` referencing ordinary
`a.png`. Immediately before the scanner's first `read_bytes(a.png)`, replace
`a.png` with a symlink to a synthetic text file outside the explicit bundle. The
probe wraps `Path.read_bytes` only to schedule this filesystem interleaving; it
calls the real reader, real scanner, real snapshot and real verifier. The outside
fixture contains `SYNTHETIC_OUTSIDE_BOUNDARY`, not a real secret.

**Actual result:** exit **0**, `delivered: true`, `errors: []`; fake remote contains
the outside fixture bytes as `.../report/a.png`. The uploaded digest and remote
verification both pass. This is not an attacker mutating the private snapshot;
it is a source-path race before that snapshot exists. The remediation closes the
post-validation upload race but leaves a boundary-check-to-read race in validation.

**Narrow correction:** acquire validated regular-file handles without following
symlinks, including directory components, and validate/copy bytes from those
handles into the private snapshot. Bind name/boundary validation and content
validation to the same opened objects. Another path-based `is_symlink()` check
alone leaves the same race. Add this interleaving as a regression, in addition to
the existing post-snapshot mutation test.

### Q2 — MEDIUM: other subprocess OS failures still lose partial receipts (AC4)

**Location:** `scripts/publish_html_artifact.py:609-615,678-695,782,811-817`;
`SKILL.md:82-85` promises every partial failure is accounted for.

`_run()` translates timeout and `FileNotFoundError`, but not `PermissionError` or
other `OSError` subclasses from `subprocess.run`. `upload()` catches only
`Failure`. An executable that loses execute permission or an OS process-creation
failure after an earlier upload takes the outer `os_error` path. The completed
list is local to `upload()` and is discarded before assignment to `plan['uploaded']`.

**Reproduction:** bundle `index.html`, `s.css`, `z.js`; fake runner successfully
stores `index.html`, then raises
`PermissionError(errno.EACCES, 'Permission denied', 'mc')` for the `s.css` copy.

**Actual result:** fake remote contains `index.html`; exit **1**,
`delivered: false`, and only:

```json
{"kind":"os_error","message":"PermissionError: [Errno 13] Permission denied: 'mc'","exit_code":1}
```

No `uploaded`, `failed`, `not_attempted`, or retry hint occurs in the receipt.
The timeout/missing-binary fixes pass but do not fulfill the general partial-failure
contract.

**Narrow correction:** normalize subprocess OS errors into `Failure` inside
`_run()`, or catch them inside `upload()` while its progress is available. Return
exit 5 with `uploaded: ['index.html']`, `failed: 's.css'`,
`not_attempted: ['z.js']`, a safe cause and retry guidance.

### Q3 — MEDIUM: srcset remediation skips a required image and claims delivery (AC2/AC4)

**Location:** `scripts/publish_html_artifact.py:264-285,311-313`;
`tests/test_publish_html_artifact.py:636-642` exercises only a space after the comma.

Whenever `data:` occurs anywhere in a `srcset`, the new branch splits candidates
only at commas followed by whitespace. HTML srcset candidate separators need not
have that whitespace. Once the URL and `1x` descriptor end, the next comma is a
separator even without a following space.

**Reproduction:** an otherwise empty bundle containing:

```html
<img srcset="data:image/png;base64,AAAA 1x,missing.png 2x">
```

No `missing.png` exists. `_srcset_candidates()` yields only
`['data:image/png;base64,AAAA']`, so the scanner ignores the 2x candidate.

**Actual result:** exit **0**, `delivered: true`, `errors: []`; only `index.html`
is uploaded and verified. The page's required 2x image was neither validated nor
published. This is a regression introduced by the data-URI remediation, not a
documented runtime/computed-JS limitation.

**Narrow correction:** tokenize srcset URL/descriptor states instead of testing
for `data:` globally and splitting on comma-plus-space. At minimum add absent and
present second-candidate tests with `1x,missing.png 2x`, preserving the existing
comma-in-data-URI regression test.

### Q4 — MEDIUM: unreadable directories are silently omitted from the explicit bundle (AC2)

**Location:** `scripts/publish_html_artifact.py:463` (`os.walk` has no `onerror`).

**Reproduction:** create `index.html` and `nested/extra.html`, make `nested/`
mode 000, publish as the non-root user. The fixture restores permissions afterward.

**Actual result:** exit **0**, `delivered: true`, `errors: []`, and the sole
planned/uploaded file is `index.html`. `os.walk()` silently discards the directory
access error. The supplied explicit bundle is not published completely. The new
unreadable-file regression only covers a readable directory containing a mode-000
file; it does not cover an unreadable subtree. A direct reference to an omitted
file would fail later, but unlinked pages/runtime-loaded assets in a complete
build output are silently lost.

**Narrow correction:** supply an `onerror` handler that records or raises a
structured validation failure; no upload should occur if the explicit tree cannot
be enumerated. Add a non-root unreadable-subdirectory test.

## Additional confirmed finding

### Q5 — LOW: failed snapshot creation leaks its partial copy on disk

**Location:** `scripts/publish_html_artifact.py:655-669,779-788`.

`main()` enters its cleanup `try/finally` only after `_snapshot()` returns.
If copy/read/hash validation raises inside `_snapshot()`, the temp directory is
never returned and never removed. This contradicts the remediation report's
claim of cleanup on every path.

**Reproduction:** mutate `s.css` after planning but immediately before
`_snapshot()`; record the real `mkdtemp` path without changing creation semantics.

**Actual result:** exit **2**, `bundle_changed`, no transport calls, but one
0700 `html-artifact-delivery-*` directory remains containing the mismatched,
unvalidated synthetic bytes. The probe removes its own leaked directory after
checking. This is not a public leak, but failed attempts retain copies and can
accumulate disk use.

**Narrow correction:** own cleanup inside `_snapshot()` until successful return,
or use a `TemporaryDirectory` context spanning snapshot creation and publication.
A failure-path test should assert no new snapshot directory remains.

## Verified remediations and gate disposition

- The known `.s3cfg`, `.pgpass`, `secrets.toml`, and PGP-key regression tests pass;
  this review found no additional confirmed credential-name defect.
- Post-snapshot source mutation does not change the uploaded bytes. Q1 is a
  different interleaving, before the scan's byte read.
- Timeout and missing-binary partial receipts pass their tests; Q2 is a different
  OS exception that still bypasses accounting.
- Existing MIME, HTTP-status, SHA-256, collision, identity, SVG and plan-only
  `delivered: false` tests pass. These checks do not cover Q1/Q3/Q4 false success.
- AC1 guidance/authoring separation and AC3 identity behavior have no new finding
  in this bounded review. AC4 fails on Q1/Q2; AC2 completeness fails on Q3/Q4.
- **AC5 activation and AC6 live smoke are correctly deferred, not reasons for
  HOLD.** The code-quality defects above are the reasons. Repair the blocking
  findings, add their regression tests and obtain an independent re-review before
  activation; then run the reserved live smoke against those final bytes.
