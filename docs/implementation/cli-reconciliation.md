# SKRILL-14: Activation reconciliation

Implemented for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-14](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/a548274f-a4d9-4625-8920-f25fd1ac63d3).

`sync` applies `.agents/skills.json` to the selected activation roots and their
supported CLI aliases. Plain sync selects global plus the nearest project, or
global alone when no project manifest is found. Project-only writes still
resolve inherited global skills.

```sh
skillex sync --dry-run --json
skillex sync --scope project --project /workspace/example --dry-run --exit-code
skillex sync --scope both --registry-root /workspace/skillex
```

## Planning and scope

`planSync` is a read-only public core API. `sync` uses the same planner and
supports `dryRun`. Plans include canonical bindings, root transitions, CLI
aliases, receipt updates, and pending recovery. The public result names each
write scope and lists its changes; an unchanged activation has an empty change
list. `--dry-run --exit-code` returns 6 for drift and 0 for a converged result.
`--exit-code` without `--dry-run` is an argument error.

Actual sync holds one shared activation lock across its final input read,
preflight, and application. An externally returned plan is never accepted as
write authority. Every selected scope is preflighted before activation changes
start. Missing required inputs refuse the operation; incomplete optional
resolution remains visible as exit 4 and does not turn an unresolved pack into
an empty activation.

## Ownership and receipts

Node receipts use a separate versioned namespace under
`<XDG_STATE_HOME>/skillex/activations/v2/`, falling back to
`~/.local/state/skillex/activations/v2/`. Their identity is derived from the
canonical scope directory and literal `.agents/skills` path. Following the
activation symlink when choosing the receipt key would strand ownership during
a pack switch, so the key never follows it.

Receipts record filesystem identities and exact symlink contents for generated
objects. Canonical target paths and source revisions explain provenance; they
do not grant deletion authority. Correct preexisting references can satisfy a
selection while remaining unmanaged. A replaced object remains foreign even
when it points to the same canonical definition as the old owned link.

The persistence layer validates receipt format, scope, host, user, and paths,
then compares the prior file's identity and bytes before an atomic update.
Receipt state must remain outside source repositories. Reads and previews do
not create state directories. Python version 1 receipts are migration input
and never authorize ordinary Node sync to claim or prune content.

## Composed and pack activation

Composed scopes expose a real `.agents/skills/` directory containing canonical
child links. All selected scopes complete their additions and replacements
before ordinary stale links are pruned. Foreign children, including
installer-managed content, survive
ordinary reconciliation unless they collide with a requested binding.

An exclusive pack exposes its complete materialized `skills/` view through a
whole-root symlink. Activation first verifies agreement between the pack
manifest and its generated references. Replacing a composed root with a pack
requires an owned root containing only exact owned children. Switching an owned
pack root back to a composed selection prepares the complete replacement view
before the handoff.

Directory-to-symlink transitions require staging on the destination filesystem.
The reconciler records prepared identities and a pending operation before
publishing the replacement, and retires only recorded old objects afterward.
It does not recursively delete unexpected content. Temporary paths use
`.skillex-tmp-*`; the shared Git ignore policy excludes that runtime namespace
without ignoring `.agents/skills.json` or other source files.

The selected activation and CLI alias destinations must share the staging
directory's filesystem. Cross-device changes fail during preflight with
`E_ACTIVATION_FILESYSTEM`, before any activation or state writes.

Publication renames the prepared object after checking its identity, destination
parents, sources, and destination absence. This preserves the journaled symlink
inode on Linux and macOS; macOS's
[hard-link operation follows the source symlink](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/link.2).
The ownership lock coordinates Skillex writers. It does not make the final
absence check and rename atomic against unrelated filesystem writers.

The first Ctrl-C requests cancellation at a safe boundary and reports exit 130.
If writes have started, the result includes the completed changes and a partial
application finding. The next sync verifies the saved journal, recovers owned
objects, and resolves the current manifest again. A second Ctrl-C can terminate
the process immediately. Human output lists completed changes for an execution;
dry-run output lists the full proposed changes.

## Supported CLI aliases

Global aliases cover Claude, Codex, Gemini, Copilot, Kimi Code, Kimi, OpenClaw,
and OpenCode's global config path. Project aliases cover Claude, Codex, Gemini,
Copilot, OpenCode, and Kimi Code. One table is shared by reconciliation and
diagnostics.

Missing aliases point relatively to the scope's `.agents/skills`. Correct
relative or absolute aliases are retained. Foreign real CLI roots and wrong
links receive a clear refusal. Alias checks account for the planned topology,
so a link directly to the previous pack cannot silently stop following the
scope during a pack switch. Generic sync does not manage Hermes overlays or
other integrations with their own installation lifecycle.

## Acceptance evidence

Node 24.15.0 and 26.5.0 each pass 434 tests, with one filesystem-owner test
skipped because it requires root. This includes 34 reconciliation cases,
26 receipt cases, and 23 installed sync CLI cases. The installed package's
public declarations also compile in an isolated TypeScript consumer without
Node type dependencies. Biome and TypeScript checks pass.

Fixtures cover scope discovery, inheritance, exclusions, immutable previews,
idempotency, pack transitions, alias reachability, exact owned pruning,
foreign-content survival, and real catalog/pack Git revision receipts.
Injected failures exercise root replacement, source changes after journaling,
cross-device refusal, and preserving global stale links when a project addition
fails. Publication tests cover symlink-hard-link refusal and foreign content
appearing after a journal save. Child processes prove contention, interrupted
publication, dead-writer
recovery with changed manifest intent, and installed CLI SIGINT handling.

The retained Python reference passes 890 tests, with five missing-pack fixture
skips, plus Ruff and mypy. Hosted Node 24/26 Linux/macOS CI and the implementation
commit are recorded on the ticket. The shared staging-ignore rule is landed in
the agent configuration repository as `af12ff94e399dcd518059cf01e399aab6fcd81a8`.

These checks use isolated activation roots. Live catalog migration, ownership
adoption, consumer cutover, and Python retirement remain later epic stories.
