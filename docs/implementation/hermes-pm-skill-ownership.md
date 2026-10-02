# Hermes PM skill ownership diagnosis

Observed 2026-10-01. The original diagnosis below records the pre-cutover
state, not the current topology. The mandatory policy is now applied to 25
project-associated PMs; see rollout verification below. Default Hermes and
its shared catalog remain untouched.

## Runtime paths

- `$HERMES_HOME/skills/` is the active profile's local skill root.
- `~/.hermes/skills/` is that root for the default profile only.
- `~/.hermes/profiles/<name>/skills/` is the named profile's local root.
- `~/.hermes/hermes-agent/skills/` is bundled source content in the code
  checkout. Install/update can copy it into local roots; it is not the normal
  runtime registry.
- `skills.external_dirs` adds directories alongside the local root. Local
  definitions win same-name collisions. Relative external paths resolve
  against the active Hermes home, not the project working directory.

Current upstream docs also describe trusted project discovery and
`skills.create_dir`. The pinned fleet runtime must be checked independently:
its skill-list implementation here scans local plus external roots.

Authoritative docs:
https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/

## Live evidence

- `skillex-pm/skills` is a whole-root symlink to `~/.hermes/skills`.
- Of 26 visible `*-pm` profiles, 22 have whole-root skills aliases. Only
  `flume-pm` has a recorded Skillex profile projection.
- The pinned fleet runtime resolves external roots to `~/.agents/skills` only.
  Its configured `./agents/skills` does not resolve to the project's
  `.agents/skills` directory.
- The pinned runtime's effective skill scan returned 157 enabled names for
  `skillex-pm`. This is a merged view, not the selected Skillex inventory.
- The external root is not completely clean either: recursive discovery finds
  `.trash` and other unowned nested entries. Seven names occur under `.trash`:
  built-in-browser, chrome-browser, computer-use, deep-research, hindsight,
  sandbox-awareness, and shadcn-components. The pinned Hermes scanner excludes
  several administrative directories but not `.trash`.
- `/skills list` classifies a name as hub-installed, builtin, or local using
  Hermes's hub lock and bundled manifest. External Skillex definitions can be
  labelled local; the label does not reveal physical ownership.
- `skillex profile show skillex-pm --project <skillex repo>` refuses the whole
  skills-root alias with `E_PROFILE_SKILLS_ROOT`.
- Migration preview proposes a real root but preserves every old child through
  forwarding links. Ordinary profile sync preserves local overrides. Neither
  operation eliminates the inherited bundled catalog by itself.

## Completed correction

`sets/global/liam` was a dangling reference to `all-skills/liam`. It was replaced
with `sets/global/liam-dev -> ../../all-skills/liam-dev`. Both global and
min-global now resolve the canonical `liam-dev` skill. `skill show liam-dev`
returns exit 0, and source doctor no longer reports missing/dangling Liam.

## Original target recommendation (superseded by mandatory policy)

1. Preserve the default profile's skill root and all authored local content.
2. Give each PM a real local `skills/` root and explicitly decide whether any
   existing local skills should remain active. Preserve removed-from-discovery
   content for review; do not delete shared skills through a profile alias.
3. Opt PM profiles out of bundled seeding with `.no-bundled-skills` using
   Hermes's supported command. Opt-out alone does not remove existing content.
4. Reconcile only the selected global plus associated project names via
   `skillex profile sync <name> --project <repo>`, after preview and ownership
   inspection. Verify second-run idempotency and the actual pinned Hermes scan.
5. Remove or isolate foreign archive/trash entries in external activation roots
   only after an ownership decision. Check native source paths, not UI labels.
6. Repair the owning fleet provisioning/configuration path before fleet-wide
   backfill, so future hires do not reproduce the old topology. Do not hand-edit
   generated profile config.yaml or restart live gateways as an incidental step.

## Applied rollout

The operator resolved the policy: all PMs are Skillex-only, with no local
skill overlays. `scripts/hermes-skillex-cutover.py` previews by default and
moves unowned content into `~/.hermes/.skill-quarantine/<profile>/<stamp>/`.
Whole-root aliases themselves are parked; their shared targets are untouched.
Real directories and receipt-owned child inodes are preserved. Each cutover
has a journal. Config changes use the canonical per-profile lock/renderer and
only override `skills.external_dirs: []`. Services/runtime databases are not
reset.

Twenty-five project-associated PMs passed cutover, second-run no-op preview,
and installed Hermes discovery probes. `skillex-pm` now exposes exactly 56
unique selected skills from its sole real profile root. Default profile and
non-PM assistants are unchanged. Remaining unregistered legacy profiles
require an explicit project association rather than a guessed one.

`--skillex-only` persists `.skillex-only` and `.no-bundled-skills`. Ordinary
show/sync then refuses unowned skill payloads and external discovery roots.
The capability ships in `@delorenj/skillex@0.1.3` (npm 0.1.2 predates it). PM
setup fails closed on stale CLI capability and uses `profile create --no-skills`.

Hermes writes bookkeeping into the skills root that is never a skill: the
curator's `.curator_state` appeared in 15 of the 25 strict desks within two
hours of the cutover and made strict show/sync refuse them. 0.1.3 tolerates
`.usage.json`, `.usage.json.lock`, `.curator_state`, `.curator_suppressed`,
`.sync_state` (regular files) and `.curator_backups/` (directory). `.hub` and
`.archive` stay refused; either one means content moved in or out of the
projection. Note the curator treats Skillex links as agent-created skills and
may archive an unused one after `curator.archive_after_days`; strict show then
refuses with `.archive`, which is the intended alarm.

Template step 10 on an existing desk: `profile show` exit 0 or 6 (pending
sync) proceeds, anything else stops before mutation. A desk with a regular
`.skillex-only` marker gets the idempotent skills policy plus strict preview
and sync and nothing else (byte and inode no-op when converged). A desk without
the marker resumes the full provisioning path only when its skills root holds
no local entries; otherwise it is refused toward the cutover script.

Catalog commits no longer need a human: every commit to `all-skills` leaves each
strict desk "sync pending" (show exit 6, a lone `write-receipt` change), and
`scripts/hermes-skillex-resync.py` now converges them automatically from a user
path unit and a timer. A desk it cannot sync (exit 3, foreign content) is left
untouched and reported. See [hermes-skillex-resync.md](hermes-skillex-resync.md).

Flume received a durable Bloodbank invocation with the owning template writer,
retired host-config keys, pinned bootstrap-name mismatch, and review/handbook
acceptance criteria. Its upstream release/pin/backfill follow-up is distinct
from the already-applied profile cutover.


## Verification

- Installed Skillex discovers `liam-dev` in both sets with no findings.
- 68 profile tests passed (48 CLI/discovery plus 20 sync cases).
- Parent and catalog `git diff --check` passed.
- Source doctor reports only digest-drift warnings after the Liam repair;
  authored/catalog modifications were not discarded to clear those warnings.
