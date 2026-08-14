# Remote architecture — how the bridge works

## Why a bridge exists

ego lite ships **only as a macOS application**. Verified 2026-08-14:

- The only binaries published are macOS disk images at
  `cdn.ego.app/setup/macos/{arm64,x64}/*.dmg`.
- Upstream's `install.sh` calls `hdiutil` and `ditto` (both macOS-only) and
  extracts the `ego-browser` CLI from *inside* the `.app` bundle — so the CLI is
  a Mach-O client to a native Mac app, not a portable Node tool.
- The GitHub release archives (`ego-browser-v1.2.3.zip`) contain **no binaries
  at all** — only `SKILL.md`, per-site "learnings", and that macOS installer.
- `lite.ego.app` offers a Mac build only; Windows is a waitlist. Linux is not
  mentioned.

The fleet's agent hosts (`big-chungus`, `ai`) are Linux. Rather than give up the
canonical-browser goal or fragment it per host, the browser lives in exactly one
place — the MacBook that already holds the real Chrome profile — and every host
reaches it through `scripts/ego-browser`.

## The path a call takes

```
agent (any host)
  └─ ego-browser nodejs <<'EOF' … EOF
       └─ buffer stdin, append to audit.log
            └─ ssh -T carries-macbook-air.burro-salmon.ts.net
                 └─ exec '/Applications/ego lite.app/…/ego-browser' nodejs
                      └─ ego lite (Aqua session) drives the real profile
```

Run **on** a Mac that has ego lite, the shim detects it and execs the local
binary directly — ssh is never involved. The same command therefore works
everywhere, which is the point.

## Configuration

Precedence: environment > `~/.config/ego-browser/config.env` > built-in default.

| Variable | Meaning | Default |
| --- | --- | --- |
| `EGO_BROWSER_HOST` | Mac that owns the browser | `carries-macbook-air.burro-salmon.ts.net` |
| `EGO_BROWSER_REMOTE_BIN` | Skip discovery, use this path | auto-discovered, cached |
| `EGO_BROWSER_SSH_OPTS` | Extra ssh flags | `-o ConnectTimeout=10 -o BatchMode=yes` |
| `EGO_BROWSER_WAIT` | Seconds to wait for a sleeping Mac | `0` |
| `EGO_BROWSER_DISABLE` | `1` hard-stops the bridge | `0` |

## Remote binary discovery

A non-interactive ssh session does not source an interactive shell rc, so the
`ego-browser` command registered during GUI onboarding is often **not on PATH**.
The shim therefore searches, in order: `~/.local/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`, then `command -v`, then inside the app bundles
(`/Applications/ego lite.app/Contents/**`). The result is cached to
`~/.config/ego-browser/remote.env`.

If ego lite moves, delete that cache file or set `EGO_BROWSER_REMOTE_BIN`.

## First-time setup

1. **Ensure ssh works.** `ssh carries-macbook-air.burro-salmon.ts.net true`
   must succeed non-interactively (key-based). Enable Remote Login on the Mac:
   *System Settings → General → Sharing → Remote Login*.
2. **Install ego lite:** `ego-browser install` — runs upstream's installer on
   the Mac over ssh.
3. **Complete GUI onboarding** *on the Mac*: open ego lite, import Chrome data
   (this is what gives agents the logged-in profile), register the CLI.
4. **Verify:** `ego-browser doctor` — all six checks should pass.

Steps 1 and 3 are inherently hands-on: the first needs a macOS setting toggled,
the second is a GUI wizard. Neither can be driven from Linux.

## Keeping the Mac available

The bridge is only as good as the Mac's uptime. Worth setting on that machine:

- **Prevent sleep** while on power: `sudo pmset -c sleep 0 disablesleep 0`, or
  *System Settings → Displays → Advanced → Prevent automatic sleeping on power
  adapter*. A closed lid on battery will still drop it off the tailnet.
- **Tailscale on login**, so it rejoins after a reboot without a human.

## Known caveat: the launchd GUI session

This is the one risk that could not be tested while the Mac was offline, so it
is called out rather than assumed away.

On macOS, a process started from a plain ssh session lands in a different
launchd bootstrap namespace than the GUI (Aqua) session. CLIs that talk to a
GUI app's Mach services sometimes fail there with a connection error, even
though the same command works in Terminal.app on the Mac.

Whether this bites depends on how `ego-browser` reaches ego lite. If it uses a
local TCP/WebSocket port (typical for a Chromium-derived app), plain ssh works
fine. If it uses a Mach service, it may not.

**`ego-browser doctor` distinguishes the two cases**: check 5 exercises the Node
runtime, check 6 exercises the live browser connection. Runtime OK + browser
FAIL is the signature of this problem.

Remedies, cheapest first:

1. Keep the Mac **logged in to its GUI session** with ego lite running. Once an
   Aqua session exists, ssh-launched clients can usually reach it.
2. Launch the app from the ssh session so it inherits a usable context:
   `ssh mac 'open -a "ego lite"'` — `open` hands off to the GUI session.
3. If neither works, wrap the remote call in `launchctl asuser $(id -u) …`.
   Note this requires root on the Mac, so it means a passwordless-sudo rule for
   that one command — do that only if 1 and 2 both fail.

## Deliberate non-goals

- **No stealth.** No fingerprint spoofing, no captcha solving, no OTP
  interception. ego lite works by being a genuine browser on a genuine profile;
  gates are cleared by the human. Adding evasion would break both the security
  model and the reason this approach is trustworthy in the first place.
- **No silent fallback.** When the Mac is down, the bridge fails loudly. A
  fallback to headless Chrome or WebFetch would silently swap an authenticated
  session for an anonymous one and return confidently wrong results.
