# Hermes Skillex-only desk auto-resync

Implemented 2026-10-02 at the operator's request ("Definitely need an auto resync").

## The problem

A strict Hermes desk (a real `~/.hermes/profiles/<name>/` with regular-file
`.skillex-only` and `.no-bundled-skills` markers) keeps a Skillex receipt that
records the `all-skills` commit it was last synced against. So **any commit to
the catalog** makes every strict desk "sync pending": `skillex profile show`
exits 6 with a single `write-receipt` change and no link changes, and flume's
`hermes.runtime-singleton` audit rule goes red until someone runs a strict sync
per desk. Nothing did it automatically.

## What runs

| Unit | Role |
| --- | --- |
| `skillex-hermes-resync.path` | Fires when the catalog's HEAD moves (inotify on its reflog and `HEAD`). |
| `skillex-hermes-resync.timer` | Fallback: 2 min after the user manager starts, then at :07 :22 :37 :52, `Persistent`. |
| `skillex-hermes-resync.service` | `Type=oneshot`, `Nice=10`, `TimeoutStartSec=15min`, `Restart=no`. Runs `scripts/hermes-skillex-resync.py --settle 4`. |

Install, inspect and remove (units are symlinked from `systemd/`):

```sh
scripts/install-hermes-resync.sh install     # link, daemon-reload, enable --now timer + path
scripts/install-hermes-resync.sh status      # units, last run, catalog freshness; exit 1 if unhealthy
scripts/install-hermes-resync.sh uninstall
mise run hermes:resync -- --dry-run          # preview against the real fleet; writes nothing
```

`install` starts one run at once: the timer's `OnStartupSec` has long elapsed,
so enabling it fires it. The units say `%h/code/skillex`. When the repo is elsewhere, or `all-skills` is
a submodule whose gitdir lives under `.git/modules` (a `.git` *file*), `install`
writes `<unit>.d/10-layout.conf` with the resolved paths and removes it again
when the layout is the default.

### Why the path unit watches what it watches

A receipt records exactly one fact about the catalog, its HEAD commit, and
HEAD's reflog is append-only. Measured on a scratch repo with real path units:

| Operation | `PathModified logs/HEAD` | `PathChanged HEAD` |
| --- | --- | --- |
| commit, amend, reset, `update-ref` of the checked-out branch | fires | |
| fast-forward / merge / rebase pull | fires | |
| checkout, switch, detached checkout | fires | fires |
| `git fetch`, a commit in another repo | no | no |
| `git gc` (expires reflog entries) | fires, harmless: HEAD unchanged | |

`PathChanged` on `HEAD` also covers `git symbolic-ref`, which moves HEAD with no
reflog entry. systemd's `$TRIGGER_UNIT` is no evidence of which unit started a
run (with both a timer and a path unit on one service it named the timer for a
path-started run), so the record carries `previous_catalog_commit`,
`catalog_commit` and `catalog_moved_at` instead: a run that started seconds after
`catalog_moved_at`, with a different `previous_catalog_commit`, was the path unit.

**Events that arrive while the service runs are not queued** (systemd stops
watching while the triggered unit is active). Three mitigations: `--settle 4`
debounces a burst (an eight-commit rebase starts one run), the script re-reads
the catalog HEAD after each pass and goes round again, up to `--max-passes 3`,
when it moved, and the timer catches whatever is left. Selection edits (`sets/`,
`.agents/skills.json`) need no catalog commit and are caught by the timer alone.

`TriggerLimitBurst=20` per 5 min is a circuit breaker for a loop that keeps
writing the reflog: past it the path unit FAILS and stops watching until
restarted (`install` does that, and `status` reports it) while the timer keeps
going. A run takes 10 to 20 seconds, so a legitimate burst of catalog commits
stays far below it.

## What it does per desk

Desks are `~/.hermes/profiles/*` that are real directories with a
regular-file `.skillex-only`. Anything else is skipped without a skillex call
(a legacy desk, one mid-cutover, a symlinked marker: listed under `skipped`).
The project is the one Skillex recorded for the desk (`skillex profile list`),
never a guess. Every call carries `--hermes-root`, `--registry-root` and
`PJ_SKILLS_REGISTRY_ROOT=~/code/skillex`.

| `skillex profile show NAME --project REPO --json` | Action | desk status |
| --- | --- | --- |
| exit 0 | nothing | `ok` |
| exit 6 (plain drift) | `profile sync NAME --project REPO --skillex-only`, then show again; require exit 0 | `synced` (or `error` if not converged) |
| exit 3 (foreign/unowned entries, broken strict policy) | **never touched** | `refused` |
| exit 3, 4, 5 first time | asked once more after `--retry-delay` (another writer mid-flight); not a sync | |
| anything else, timeout, non-JSON | **never touched** | `error` |
| sync exit 3 | | `refused` |
| sync or show exit 5 (lock held) | retried next run | `busy` |

It never deletes, adopts, quarantines or repairs anything: the only writer is
Skillex's own strict sync, which refuses foreign content by itself, and it never
restarts a gateway. A failing desk does not stop the next one.

`skillex` is found without a shell: `$SKILLEX_BIN`, a `skillex` on `PATH`, the
mise shim, then `mise which skillex`; a real binary that meets Node 20 gets a
Node 24 directory put in front, and anything older than 0.1.3 is refused. The
child gets an allowlisted environment (no credentials). Proven under
`env -i HOME=$HOME PATH=/usr/bin:/bin`.

## Evidence

State directory: `$XDG_STATE_HOME/skillex` (default `~/.local/state/skillex`).

* `hermes-resync.jsonl`: append-only, one `run` line per real run plus one
  `desk` line for every desk that was `synced`, `refused`, `error` or `busy`
  (current desks are not logged). Rotated to `.1` past 4 MiB.
* `hermes-resync.last.json`: the last real run in full (`run` fields plus
  `results`, every desk), replaced atomically. A `busy` run does not replace it.
* `~/.hermes/.skillex-resync.lock`: whole-run non-blocking `flock`; held means a
  peer is running, so this run exits 0 as `busy`. `--dry-run` takes no lock and
  writes nothing.

`run` record (schema 1): `schema, event:"run", run_id, started_at, finished_at,
duration_ms, trigger` (`systemd` when a unit started it, else `manual`)`, dry_run,
status, exit, hermes_root, registry_root, catalog_commit` (all-skills HEAD when the
last pass ended)`, previous_catalog_commit` (the previous real run's)`,
catalog_moved_at` (ISO UTC, when HEAD last moved, from its reflog)`,
skillex:{bin,version}, passes,
settled, skipped:[{desk,reason}], counts:{total,ok,synced,would_sync,refused,error,busy},
attention:[desk], message`. `status` is `ok` (exit 0), `partial` (exit 0, some
desk was busy), `attention` (exit 1, a desk needs a human), `error` (exit 2, could
not start: no usable skillex, no catalog, lock unusable) or `busy` (exit 0).

`desk` record: `event:"desk", run_id, ts, desk, project, status, show_exit,
sync_exit?, verify_exit?, changes?:{action:count}, findings?:[{code,severity,message,path}],
reason?, duration_ms`. `status` is `ok|synced|would-sync|refused|error|busy`.

Reading it:

```sh
journalctl --user -u skillex-hermes-resync.service -n 20 --no-pager   # one summary line per run
jq -c 'select(.event=="desk")' ~/.local/state/skillex/hermes-resync.jsonl | tail
jq '{status,finished_at,trigger,catalog_commit,counts,attention}' ~/.local/state/skillex/hermes-resync.last.json
```

## Exit 3 (`refused`) and what to do

Exit 3 means the desk's strict policy is violated, not that the catalog moved:
an unowned entry in `skills/` (a local skill, a stray directory, a Hermes
`.archive` or `.hub` that the curator created), a non-empty
`skills.external_dirs`, or a policy marker that is not a regular file. The
`reason` and `findings[].path` name the entry. The resync leaves it alone.

**Never hand-edit a strict desk** and never delete the entry to make the red go
away. Preserve it with the cutover script, which moves unowned content into
`~/.hermes/.skill-quarantine/<profile>/<stamp>/` and re-pins the delta; preview
first, then apply:

```sh
python3 ~/code/skillex/scripts/hermes-skillex-cutover.py --profile NAME --project REPO \
  --registry-root ~/code/skillex \
  --renderer ~/code/33GOD/hermes-agent-template/scripts/hermes-profile-config.py
# add --apply once the preview lists what you expect
```

Then run the resync again (`mise run hermes:resync`). Other statuses: `error`
with "no recorded project" means the receipt is gone (sync that desk by hand
once with `--project`); "not converged after sync" means skillex accepted the sync
but the desk still reports drift (look at its findings); a timeout points at a
hung skillex or a stuck lock.
