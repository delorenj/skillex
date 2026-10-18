# SKRILL-30 — Q1–Q5 repair evidence

Repair worker output for the independent quality re-review HOLD
(`SKRILL-30-quality-rereview.md`). All five findings repaired, regression-tested,
and independently re-verified with fixed-behavior probes. Scope held to
`all-skills/html-artifact-delivery/` plus this report; no board calls, no
credentials/config reads, no `mc` commands, no network publication, no
activation, no commits/pushes. Existing tests were strengthened, never weakened.

## Repaired files (SHA-256 after repair)

| File | SHA-256 |
|---|---|
| `all-skills/html-artifact-delivery/scripts/publish_html_artifact.py` | `f66d42423ce5b05637f764707f0b7dd2c49a259c54f7ed420879c8f48408da7c` |
| `all-skills/html-artifact-delivery/tests/test_publish_html_artifact.py` | `c7f765d32a95af29551cd4fba849be0c3fcc253aba214f4cdbff7023d0a93d1b` |
| `all-skills/html-artifact-delivery/SKILL.md` | `b7c6587c5662f1fc800d5cf17da782c94fd674537cd444d95a99acf1ec5ab1e1` |

Skill directory remains untracked in the `all-skills` submodule (as in the
re-review); other pre-existing modified files in the submodule were untouched.

## Q1 (HIGH) — scan-to-read symlink race (AC4)

**Fix.** `scan_bundle()` no longer enumerates with `os.walk` + later
`Path.read_bytes()`. New `_collect_files()` does a depth-first descriptor
traversal: the bundle root is opened via `_open_bundle_root()` (component chain
from `/`, every hop `O_NOFOLLOW`), each child is opened relative to its parent
directory fd with `O_RDONLY|O_NOFOLLOW`, validated with `fstat`
(`stat.S_ISREG`, nlink, and inode/dev/mode identity vs the enumeration `lstat`),
and the initial bytes are read from that same validated handle (`_read_all`).
Paths are never re-opened between validation and the byte read, so a name
swapped to a symlink after enumeration is detected (`changed during scan
rejected: <rel>`; a symlink at open time yields `ELOOP` → `symlink rejected`)
and no outside bytes can be hashed, snapshotted, or uploaded. This is handle
binding, not another `is_symlink()` check. The private snapshot re-read in
`_snapshot()` was rebuilt the same way (`_open_bundle_root` +
`_open_rel_dir` + `O_NOFOLLOW` open + hash compare against the plan), so
upload bytes stay pinned to the validated hashes on the descriptor path too.
Added `MAX_DEPTH=64` and `MAX_READ_BYTES` (512 MiB) bounds; fd usage is
one-per-file during scan (verified 1501-file bundle plans cleanly; `ulimit -n`
is 1048576).

**Regression tests.** `test_q1_symlink_swap_between_enumeration_and_read_fails_closed`
(patches `os.open` to swap the name to an outside symlink immediately after the
validated open, before any read; asserts interleaving fired, exit 2, no upload
calls, no outside bytes anywhere), and `test_q1_scan_reads_bytes_from_validated_handles`
(`Path.read_bytes` patched to raise if the scan ever re-resolves a path).

## Q2 (MEDIUM) — other subprocess OS errors lose partial receipts (AC4)

**Fix.** `_run()` now translates every remaining `OSError` (PermissionError,
EAGAIN, ENOMEM, …) into `Failure(EXIT_REMOTE, "os_error", …, os_errno=…)` with
redaction; `upload()` additionally catches raw `OSError` from runners that
bypass `_run` and re-raises with full `uploaded`/`failed`/`not_attempted`
accounting and retry guidance. The SKILL.md partial-failure contract line now
says "any other OS error mid-upload".

**Regression tests.** `test_q2_permission_error_mid_upload_reports_partial_accounting`
(exit 5, `cause: os_error`, `uploaded: ['index.html']`, `failed: 's.css'`,
`not_attempted: ['z.js']`, `retry`, remote store contains exactly the one
uploaded object) and `test_q2_runner_oserror_bypassing_run_still_accounted`
(raw `OSError(EAGAIN)` from the runner still fully accounted).

## Q3 (MEDIUM) — srcset false success (AC2/AC4)

**Fix.** `_srcset_candidates()` is a real URL/descriptor state tokenizer, not a
global `data:` test with `re.split(r",(?=\s)")`. It tracks whether the current
candidate is still in its URL (keeping commas inside `data:` URL bodies) or in
the descriptor section; the first comma after descriptors separates candidates
even with no whitespace. `'data:image/png;base64,AAAA 1x,missing.png 2x'` now
yields both candidates; the existing comma-in-data-URI behavior (no phantom
`'AAAA'` candidate) is preserved.

**Regression tests.** `test_q3_srcset_second_candidate_without_space_is_required`
(absent second candidate blocks publish with `missing local asset …
'missing.png'`), `test_q3_srcset_second_candidate_present_publishes` (present
second candidate uploads and verifies), and
`test_q3_srcset_tokenization_cases` (with-space, no-space, data-URI with/without
trailing candidate, single URL, blank). The pre-existing
`test_srcset_data_uri_no_false_missing` still passes unchanged.

## Q4 (MEDIUM) — unreadable subtree silently omitted (AC2)

**Fix.** Enumeration is fd-based (`os.listdir(dir_fd)`, `os.open(dir_fd=…)`),
so an unreadable subdirectory surfaces as `EACCES` and raises structured
`Failure(EXIT_INVALID, "walk_failed", "cannot enumerate nested: permission
denied (EACCES)")` before any planning/upload: no partial publish of the
explicit bundle. Mode-000 *files* inside a readable directory keep the existing
per-file `unreadable file rejected` receipt entry. Fail-closed also covers
`EPERM`, `ELOOP` (symlink cycle), and other enumeration errors. SKILL.md now
lists the unreadable-subdirectory rejection.

**Regression test.** `test_q4_unreadable_subdirectory_fails_closed` (non-root;
mode-000 `nested/`, asserts `walk_failed` receipt naming `nested`, zero remote
calls, no `files` list).

## Q5 (LOW) — failed snapshot leaks its partial copy

**Fix.** `_snapshot()` owns cleanup: the whole body after `mkdtemp` is wrapped
so any failure (re-open error, read error, hash mismatch, anything) removes the
partial snapshot directory before propagating `bundle_changed`. `main()` also
guards its post-snapshot `rmtree` with `contextlib.suppress(OSError)`.

**Regression tests.** `test_q5_failed_snapshot_leaves_no_partial_copy`
(post-plan mutation before snapshot: exit 2 `bundle_changed`, zero transport
calls, zero snapshot dirs remaining) and
`test_q5_snapshot_failure_inside_cleanup_is_removed` (mutation injected
mid-snapshot during the copy loop; same assertions).

## Verification executed

```
cd /home/delorenj/code/skillex/all-skills
python3 -B -m unittest discover -s html-artifact-delivery/tests -v
# Ran 66 tests — OK (56 pre-existing + 10 new; 1 Q4 test skipped only under root; suite ran as non-root)

cd /home/delorenj/code/skillex/all-skills/html-artifact-delivery
python3 -B -m unittest discover -s tests
# Ran 66 tests — OK

python3 -B "$TMPDIR/skrill30-quality-probes.py"        # original reviewer probe, asserts the BUGS
# exit 1 at its first assertion (assert code == 0 and delivered and leaked) — expected nonzero after fixes

python3 -B "$TMPDIR/skrill30-quality-fix-verification.py"  # new probe, asserts the FIXED behavior
# exit 0; all five assertions pass; full JSON summary printed
```

Fixed-behavior probe: `$TMPDIR/skrill30-quality-fix-verification.py`
(`/home/delorenj/.hermes/profiles/skillex-pm/cache/scratch/skrill30-quality-fix-verification.py`).
It re-imports the existing `FakeRemote`, injects runner/fetch into `main()`,
uses only synthetic fixtures under `$TMPDIR`, and asserts: Q1 interleaving at
the validated open with zero uploads and zero outside bytes; Q2 receipt with
`uploaded/failed/not_attempted`; Q3 candidates
`['data:image/png;base64,AAAA', 'missing.png']` and a blocking error when
`missing.png` is absent; Q4 `walk_failed` with no transport calls; Q5 zero
remaining snapshot directories after failure. The original reviewer probe was
left byte-for-byte unchanged; the new proof is separate, per the repair
contract.

## Remaining limits (unchanged by this repair)

- Static discovery only; runtime `fetch()`/dynamic imports/JS-built URLs are
  still not followed (documented limit, tested).
- No atomic collision guard; concurrent publishes to one prefix can still race
  (documented; preflight catches the non-racing case).
- Enumeration now intentionally fails closed on unreadable subtrees — a
  behavior change vs. the old silent omission, matching AC2 completeness.
- AC5 activation and AC6 independent re-review + live smoke remain parent-owned
  gates and were not attempted here.
