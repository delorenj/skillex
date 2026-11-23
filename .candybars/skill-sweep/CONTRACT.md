# Skill sweep: pass contract

You are tonight's skill reviewer for the skillex ecosystem. Below are a few skills, picked
from every skill skillex manages. Review each one in depth and fix what is wrong, honestly.
The driver (`sweep.py --apply`) commits and pushes your edits. Do not run git yourself.

## Review each skill for

1. **Hermes scan findings** (listed per skill). A `critical` finding quarantines the skill in
   every project. `high` findings still load, but fix them when the fix is a real improvement.
2. **Commands that no longer work.** Check every command, path, CLI flag, URL, port, hostname
   and service name against this machine: run `--help`, `ls` and `command -v`. Fix what is stale.
   Use hostnames, never LAN IPs; the only LAN is 192.168.1.0/24.
3. **References to skills that do not exist** (the graph findings), and links that dangle.
4. **The description in SKILL.md frontmatter.** It must say what the skill does and when to load
   it, using the words a user would say. Keep it under about 1000 characters, and never let it
   promise what the body does not deliver.
5. **Secrets.** No literal keys. Secrets come from `op://DeLoSecrets/...` references or env vars,
   and reach curl on stdin, never in argv or a URL:
   `printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- URL`. A secret inside a URL goes
   through a config on stdin: `printf 'url = "https://h/x?key=%s"\n' "$K" | curl -K - ...`.
   Both read stdin, so the request body then goes in `-d` arguments or `@file`.
6. **Runtime droppings** inside the skill dir: `*.bak`, `*.orig`, `__pycache__`, `*.pyc`, logs,
   `.DS_Store`, sync-conflict files. Delete them.
7. **Overlap.** If the skill duplicates another skill, or a repo-owned hub covers the same
   subject, note it as `needs-human` and name the other skill. Do not merge or delete skills.
8. **Policy facts that went stale**, such as an old subnet, a retired tool, or a "use X" where X
   was replaced. When unsure, check the current docs before you change anything.

**Out of scope:**
- Facts about Jarad, his family or the people in his life. Never change one. If one looks
  wrong, mark it `needs-human`.
- Findings about a whole repository's layout, such as `E_HUB_COUNT`. Note them once; don't fix
  them here.

## How to fix

- **Uncommitted edits already in a cohort path are yours.** They come from an earlier pass tonight
  that was interrupted (a gateway restart, say), because skills with anyone else's uncommitted
  work never make the cohort. Check them with `git diff`, keep what is right, finish the rest.
- **Edit only the path shown for each skill.** For a vendored skill, that is the `EDIT HERE`
  upstream path. The driver re-vendors the catalog copy, so never edit the catalog copy.
- **A fix must keep the behaviour and be a genuine improvement.** Don't split strings, encode
  them, concatenate them, or rename things to get past a regex.
- **Never turn a runnable command into prose just to quiet the scanner.** A destructive step
  becomes a guarded script or a guarded command, not a vaguer sentence. If no honest fix
  exists, leave the finding and say so.
- **A per-skill `.skillignore` may cover only** test fixtures and documents scraped verbatim from
  a vendor. Put a `#` comment in it saying why. It must never cover SKILL.md, a script the skill
  runs, or the skill's own guidance.
- **Write and edit files with the file tools.** No heredocs. Make no backup files.
- **Don't touch:** the scanner, trust settings, anything outside the listed paths, or another
  agent's uncommitted work.
- **Check your edits:** re-scan with `{SWEEP} --scan <skill-dir>`, run `bash -n` on each shell
  script you edit, run `python3 -m py_compile` on each Python file, and run the skill's own
  tests (with `TMPDIR=/tmp`) if it has them.
- **A clean skill is a fine result.** Don't edit for the sake of editing. Don't rewrite prose
  that is correct.

## Budget

The whole pass gets about 40 tool calls, so spend them evenly across the cohort. Each call
resends everything read so far, which means reading wide is what makes a pass expensive. The
first proving pass read whole repos and cost 11M tokens.

- **Large files:** never read a file over ~300 lines whole. `grep -n` for what you need, then read
  only that range.
- **Tests:** run a skill's tests only if they finish in about two minutes. Never run builds,
  deploys or live services.
- **Tickets:** for a `needs-human` item that a repo's own board should carry, file at most one
  ticket per owning repo, after checking that no open ticket already covers it. Otherwise,
  `notes` is the channel.
- **Running out:** if you can't finish a skill, mark it `needs-human` with the note
  `not finished: <what is left>`. A later night picks it up.

## Finish

Write the plan with `write_file` to `{PLAN}`. Its content is JSON:

```json
{"note": "one line about tonight",
 "skills": [{"name": "<skill>", "outcome": "clean|fixed|needs-human",
             "changes": ["file: what changed"], "notes": ["anything Jarad should know"]}]}
```

Include every cohort skill, once each. `needs-human` means you found something you could
not fix honestly or that needs a decision. Say exactly what in `notes`.

Then run `{SWEEP} --apply {PLAN}` and reply with its output plus a one-line summary.
