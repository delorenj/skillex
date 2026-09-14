# SKRILL-16: Read-only diagnostics

Implemented for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-16](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/237ec990-0c2e-40b6-9701-14e267817396).

```sh
skillex status
skillex status --scope project --project /workspace/example --json
skillex explain example --project /workspace/example
skillex doctor --registry-root /workspace/skillex --sources-only --json
skillex doctor --scope both --project /workspace/example
```

All three commands inspect files without creating locks, writing receipts,
recovering journals, or repairing links. Scope selection matches sync:
`auto` inspects global and the nearest project, or global alone outside a
project. Explicit `--scope global|project|both` and `--project PATH` narrow
or select the requested scope. Project inspection retains global inheritance.

## Desired selection and actual activation

`status` combines the canonical resolver and sync planner with an independent
inspection of actual filesystem entries. A resolver or planner refusal does
not discard the observations that can still be made. Unknown desired counts
remain unknown, rather than appearing as an empty selection.

Each scope reports its manifest, activation root and mode, desired names,
actual entries, ownership counts, missing names, receipt state, pending
recovery, and supported CLI alias reachability. Ownership uses exact recorded
identities. A link into the catalog is not enough evidence to claim ownership.
Pack members belong to the composition; they are distinguished from foreign
activation entries and from the owned whole-root link.

An alias aimed directly at the current pack may reach its skills while
bypassing the scope root. Diagnostics reports that distinction and exit 6,
because the alias will not follow a later pack switch. Retargeting a foreign
alias remains an explicit migration action.

The public API is `inspectStatus(options)`. Its data contains the resolution
when available, inspected scopes, and proposed sync changes. The CLI renders
the same data without duplicating reconciliation logic.

## Explaining a skill

`explain NAME` reports the canonical target and each scope's effective,
excluded, dormant, unselected, or blocked state. It includes direct, set, pack,
and inherited contributions, exclusion declarations, activation observations,
and CLI reachability for the named skill. A root alias alone cannot make a
missing skill reachable.

An active exclusive pack can leave ordinary declarations dormant. Explanations
retain those declarations without treating them as effective selections.
Conflicting canonical definitions remain errors; diagnostics do not choose
a winner. Unknown canonical names receive an actionable missing-skill finding.

The public API is `explainSkill(name, options)`.

## Source and writer checks

`doctor` aggregates findings across canonical definitions, all set and pack
compositions, manifests, provenance, and activation. Hidden or dormant
composition directories still participate in the ownership audit. Embedded
definitions, dangling or off-catalog links, and pack manifest/link disagreement
remain failures. Optional metadata stays optional.

`--sources-only` checks source declarations, topology, and provenance without
inspecting activation, receipts, or runtime writers. Vendoring and migration
remain explicit commands in their own stories.

Configured legacy commands and running legacy processes are separate evidence.
Configured findings identify the applicable mise or user-service file and
line. Running findings identify an observed PID and writer entrypoint from a
bounded process inspection. An installed Python executable or old receipt
does not prove that a writer is running. An unavailable process observation
is reported as incomplete. A known legacy script behind a shell expression
that cannot be established as an invocation is reported as a candidate for
inspection, separately from confirmed configured commands and running writers.

The public API is `doctor(options)`. It returns source inspection counts,
activation status when requested, and writer observations, with diagnostics
in the shared result envelope. `DoctorOptions.processSnapshot` accepts an
optional provider of process-list text for isolated observations; the CLI
uses the normal bounded process inspection.

## Results and verification

All commands return the shared schema-2 envelope and keep JSON stdout free of
human text and ANSI formatting. Detected activation drift exits 6 by default.
Execution, invalid configuration, invariant refusal, and incomplete observation
or optional resolution retain their existing failure meanings before drift.
Cancellation exits 130. An excluded, dormant, or unselected explanation is not
itself a failure; other detected problems in the inspected scope still count.

Node 24.15.0 and 26.5.0 each pass 583 tests, with one filesystem-owner test
skipped because it requires root. C07 adds 17 status/explanation API cases,
43 doctor cases, and 18 installed CLI cases. The isolated package's public
declarations compile without Node type dependencies; Biome and TypeScript
checks pass.

The tests cover blocked resolution with useful observations, exact ownership
and pending journals, inherited and excluded canonical authority across
registries, pack counts and alias chains, and the precedence of independent
topology failures over incomplete optional resolution. Doctor fixtures cover
hidden source violations, provenance syntax and digest/mode changes, declared
registry selection, and configured/candidate/running writer distinctions.
Installed human/JSON scenarios and filesystem snapshots verify all three
commands and their zero-write behavior.

The retained Python reference passes 890 tests with five missing-pack fixture
skips, plus Ruff and mypy. The implementation commit and hosted Node 24/26
Linux/macOS CI are recorded on the ticket.

The read-only live source audit on 2026-09-14 inspected 216 canonical skills,
six sets, and five pack manifests. It returned exit 2 with 149 errors and one
digest-drift warning: 119 noncanonical references/embedded definitions,
19 missing upstream declarations, six missing skills, three missing pack skill
roots, one unsupported legacy field, and one invalid pack manifest. These
findings remain failures for the later migration story; the existing source
baseline has no success exemption.

A full live Node doctor invocation also inspected the global activation and
completed its process observation. It found three configured legacy-writer
references and no running legacy writers. Three configuration inputs could
not be fully inspected and retained explicit incomplete-observation findings.
This verifies the distinction between configuration and runtime evidence;
consumer migration and Python retirement remain later epic stories.
