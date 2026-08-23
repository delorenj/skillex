# Agent panes, resurrection, and why ESC gets pressed sixteen times

## The mechanism

Zellij serializes a session every 60 s (`serialization_interval`, default 60000 ms) to
`~/.cache/zellij/contract_version_1/Workspace/session-layout.kdl`, plus one
`initial_contents_N` file per pane holding its scrollback.

To learn what a pane is running it calls `ps -ao ppid,args` and takes the child of the
pane's shell. **That means it records the resolved process, not what you typed.**

The user's agents are launched through zsh *function* wrappers in
`~/.config/zshyzsh/lastagent.zsh` (`claude`, `codex`, `kimi`, `agy`, `copilot`,
`hermes`, `opencode`), each of which prepends a permission-bypass flag. So `ps` — and
therefore the serialized layout — sees:

```kdl
pane command="claude" cwd="/home/delorenj/code/project-delorenj" {
    args "--dangerously-skip-permissions"
    start_suspended true
}
pane command="node" cwd="code/deckard" {
    args ".../codex" "--dangerously-bypass-approvals-and-sandbox" "resume"
    start_suspended true
}
pane command="kimi-code" { start_suspended true }
```

Three failures in one:

1. `start_suspended true` is on every command pane. Zellij does **not** auto-run them;
   it shows a "press ENTER to run" prompt. That prompt is what gets ESC'd away.
2. The recorded argv has no resume flag. Pressing ENTER would start a *fresh*
   conversation, losing the one that was in that pane.
3. `kimi-code` is not even on `PATH` — that pane could never have restarted.

Of ~17 tabs only 6 have command panes. The other 11 are plain shells and already
restore cleanly with their scrollback.

## The fix, in two halves

### `agent-pane` — a stable argv

`~/.config/zellij/scripts/agent-pane` (symlinked into `~/.local/bin`).

```
agent-pane [--fresh] <claude|codex|kimi|agy|gemini|copilot|hermes|opencode> [args…]
```

It reads `./.lastagent`, and if the marker names *this* agent it appends that agent's
resume flag — reusing the mapping already written in `agent-continue`. `--fresh`
suppresses that.

Two deliberate design points that are easy to undo by accident:

- **It does not `exec`.** Staying alive as the parent is exactly what makes `ps` report
  `agent-pane claude` instead of `claude`. Adding an `exec` silently reverts the whole
  fix.
- **It traps `INT` with a no-op handler (`trap ':' INT`), not `trap '' INT`.** An
  *ignored* signal is inherited across `exec`, which would leave Ctrl-C dead inside the
  agent itself. A *handled* signal resets to default for the child.

### `post_command_discovery_hook` — for panes already running the old way

Set in `config.kdl`:

```kdl
post_command_discovery_hook "/home/delorenj/.config/zellij/scripts/resurrect-command-hook.sh"
```

Contract, verified against 0.44.3 source
(`zellij-server/src/os_input_output.rs::run_command_hook`):

- zellij runs `sh -c "<hook>"` with `RESURRECT_COMMAND=<argv, space-joined>`
- trimmed stdout **replaces** the command in the serialized layout
- a non-zero exit makes zellij log an error and keep the original — so the safe failure
  mode is "echo the input back, exit 0"

**Performance is a real constraint, not a nicety.** The hook is invoked once per *line
of `ps -ao ppid,args`* — every process on the machine — on every serialization tick.
This box runs ~2,566 processes. The script is therefore pure POSIX `case` and parameter
expansion with **zero** subshells; measured at 474 µs, ≈1.2 s of CPU per minute. Adding
a single `grep`/`sed`/`$(…)` multiplies by the whole process table. Do not "clean it
up" with a pipeline.

## The limit: it is not retroactive

The hook can only rewrite a pane that has a **live process**, because zellij discovers
commands from `ps`. A pane already sitting suspended has nothing to discover, so zellij
carries its stale command forward verbatim and the hook never sees it.

Verified on 2026-08-23: after wiring the hook and forcing
`zellij action save-session`, exactly one pane rewrote — the one with a live process:

```kdl
pane command="agent-pane" cwd="code/deckard" { args "codex" }
```

The other five, already suspended, were unchanged.

**Editing `session-layout.kdl` by hand does not help.** Zellij regenerates the entire
file from in-memory state on each tick, so on-disk edits are overwritten.

The convergent path: dismiss the suspended panes once, then launch through
`agent-pane`, and it is permanent from there. To dismiss in bulk rather than by hand:

```bash
zellij action send-keys --pane-id <id> Esc
```

Enumerate ids from `zellij action list-panes --json`.

## Serialization knobs currently set

```kdl
session_serialization        true
serialize_pane_viewport      true
scrollback_lines_to_serialize 10000
on_force_close               "detach"     # correct — keep it
```

`serialize_pane_viewport` + 10k lines is what makes the Workspace cache ~65 MB. That is
a deliberate trade for restored scrollback, not a leak. The *cruft* is the 300+ other
session dirs, not this one.
