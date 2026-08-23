# The 0.44.3 CLI surface an agent should actually use

Most automation here reaches for polling when a push or a stable id would do. This is
the capability map, verified against the installed binary's `--help`.

## Identify a pane from inside it

Both are real environment variables inside any zellij pane:

```
$ZELLIJ_PANE_ID        # e.g. 3   — `set-pane-color` defaults to this
$ZELLIJ_SESSION_NAME   # e.g. Workspace
$ZELLIJ                # set at all → you are inside zellij
```

Guard every hook with `[ -n "${ZELLIJ:-}" ]` and wrap the call in
`timeout 1s … || true`. A hook must never block or fail an agent turn.

## Target a tab from outside

Prefer **stable ids** over positions. `position` is display metadata and changes when
tabs are reordered; `tab_id` does not.

```bash
zellij -s Workspace action list-tabs --json --panes --state   # ids, names, state
zellij -s Workspace action go-to-tab-by-id <id>
zellij -s Workspace action rename-tab-by-id <id> "name"
zellij -s Workspace action go-to-tab-name "Deckard"
zellij -s Workspace action query-tab-names
zellij -s Workspace action current-tab-info
zellij -s Workspace action list-panes --json
zellij -s Workspace action list-clients
```

`list-tabs --json` includes two fields nothing on this machine reads:

```
has_bell_notification   # persistent bell — an agent wants attention
is_flashing_bell        # transient, 400 ms
```

Those are the attention signal. See [attention.md](attention.md).

Always run these with `timeout` and `env -u ZELLIJ -u ZELLIJ_SESSION_NAME` when calling
from outside a pane, so a stale inherited env cannot retarget the call.

## Drive a pane

```bash
zellij action send-keys --pane-id terminal_3 Esc        # bulk-dismiss suspended panes
zellij action set-pane-color --pane-id 3 --bg '#3a1a1a' --fg '#ffd0d0'
zellij action set-pane-color --reset
zellij action focus-pane-id terminal_3
zellij action write-chars / paste / dump-screen
```

`set-pane-color` is the cheapest loud visual available with zero plugin work: a short
background hue cycle on the offending pane is impossible to miss. It defaults to
`$ZELLIJ_PANE_ID`, so a hook can colour its own pane with no lookup.

## Layouts at runtime — this fully works

The user's stated blocker ("I'd have to quit and risk my tabs") is not true on 0.44.3:

```bash
zellij action override-layout ./layouts/draft.kdl \
    --apply-only-to-active-tab \
    --retain-existing-terminal-panes    # panes not named by the layout survive

zellij action override-layout --layout-string '<raw kdl>'   # no file at all
zellij action new-tab --layout draft --cwd ~/code/foo       # try it in a throwaway tab
zellij action dump-layout > layouts/current.kdl             # capture what you have
```

`--retain-existing-terminal-panes` is the safety valve that makes this non-destructive.
Edit the file, re-run, watch it change — seconds, no restart.

Also available: `next-swap-layout` / `previous-swap-layout`, `stack-panes`.

`zellij action new-tab` has **no `--index`** — there is no CLI route to positional
insertion.

## Pipes — the push channel

```bash
zellij pipe --name <pipe> -- '<payload>'                       # all running plugins
zellij pipe --plugin file:/abs/path.wasm --name <pipe> -- '…'  # launches if not running
zellij pipe --plugin … --plugin-configuration k=v --name … -- '…'
tail -f log | zellij pipe --name logs --plugin …               # streams stdin
```

`--plugin-configuration` is part of plugin identity: the same wasm with different
configuration is a **different** plugin for routing purposes.

## Whole-session

```bash
zellij action save-session      # force serialization now — useful to test hooks
zellij action dump-layout
zellij action rename-session
zellij subscribe --pane-id 3 --format json --ansi   # live render stream (0.44.0+)
zellij watch                    # read-only attach
zellij web --start              # HTTP surface; token auth enforced
```

`save-session` is the fastest way to test a `post_command_discovery_hook` change
without waiting 60 s for the next tick.

`zellij subscribe` is an underused external feed: it streams a pane's viewport and
scrollback to any process, no plugin required.

## What plugins can and cannot do

From inside a WASM plugin:

- `set_timeout(f64)` needs no permission, fires `Event::Timer`; returning `true` from
  `update()` forces a re-render. Timer → mutate → re-render is a working animation loop
  at any framerate.
- Subscribable events: `TabUpdate`, `PaneUpdate`, `CommandChanged`,
  `CommandPaneExited` (carries exit code), `CwdChanged`, `PaneClosed`,
  `PermissionRequestResult`, `RunCommandResult`, `WebRequestResult`.
- **No sockets.** Plugins run under wasmi + wasmi_wasi with file I/O and env vars only.
  `web_request` and `run_command` are the sanctioned escape hatches; `run_command` to a
  helper binary makes any transport reachable in practice.
- `run_action(Action::MoveTab)` is a **silent no-op** from a plugin. Assume other
  client-relative actions may be too, and verify before relying on one.
- `TabInfo` exposes `position` but **no tab id**, which limits id-based actions from
  inside a plugin.

## Calling any of this from a hook

```bash
[ -n "${ZELLIJ:-}" ] || exit 0
timeout 1s zellij action … >/dev/null 2>&1 || true
```

Never let a zellij call fail an agent turn. If the session is wedged these calls hang,
and an unguarded hook hangs the agent with it — that is precisely how the 2026-08-23
outage stayed invisible for fourteen hours.
