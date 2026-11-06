# Hub Skill Standard

How to write the one skill a repo owns. The decision behind it is
[ADR-0002](../architecture/ADR-0002-repo-owned-hub-skills.md); this page is the
how-to. HeyMa (`~/HeyMa/skills/heyma/`) is the reference implementation.

## Before you write anything: where does it live?

Ask: **which repo changes when this skill is wrong?**

| Answer | Home |
|---|---|
| One repo | `<repo>/skills/<hub>/` — a reference or sub-skill in that repo's hub |
| A submodule of a repo | the submodule's own hub; the parent hub routes to it by name |
| Several repos, one platform | the platform repo's hub, which routes to each component hub |
| None (a method, a style, a vendor API) | a **wild skill** in `all-skills/<name>/` |

If the repo already has a hub, you are adding a route, not a skill.

## Layout

```text
<repo>/skills/<hub>/
  SKILL.md                 router
  references/<topic>.md    leaf docs (may nest: references/passes/catalog.md)
  scripts/                 executables
  examples/                optional
  subskills/<name>/
    SUBSKILL.md            skill-shaped (name + description frontmatter), loaded by path
    references/ scripts/ tests/
```

- Never a nested `SKILL.md` (recursive scanners would list it). Sub-skill entry
  files are `SUBSKILL.md`.
- No symlinks inside the hub. No `.source.yaml`.
- Every file under `references/` and `subskills/` is linked from somewhere.

**Reference or sub-skill?** A reference answers a question ("what are the call
outcomes?"). A sub-skill is a procedure with its own judgment, steps and tools
("diagnose an outage", "create an enrichment pass"): something you would have
made a separate skill before.

## The router (`SKILL.md`)

Target under 200 lines. Lint warns at 500. Sections, in this order:

1. **Frontmatter.** `name` = the hub name. `description` ≤1024 characters,
   keyword-dense: the subject, its components, the verbs people will use, the
   symptoms they will report. This is the only text an agent sees before it
   decides to load the hub, so name every component and every common symptom.
2. **One paragraph: what this is.** What the system does and the one or two
   facts every route needs.
3. **Rules that apply everywhere.** Hoisted invariants ("the source audio is
   never deleted", "green is not evidence"). Short, imperative, each one a line.
4. **Where truth lives.** A table of retrieval sources: the CLI command, ledger,
   log or file that answers questions authoritatively, so the agent asks the
   system before reading prose.
5. **Route table.** One row per situation: *when you are…* → *read this one
   file*. Default instruction: read exactly one row, then come back.
6. **Combinations.** The few tasks that need two or three files, named once.
7. **Out of scope.** What this hub does not cover and which hub or wild skill does
   (by name).
8. **Gotchas.** The traps that cost real time, one line each, each with the
   reference that explains it.

Template:

````markdown
---
name: <hub>
description: <Subject> — <what it does>. Covers <component>, <component>, <component>. Use for <verbs>: <symptom>, <symptom>, <task>, <task>.
---

# <Subject>

<One paragraph: what it is, where it runs, the one fact every route needs.>

## Rules on every route

- <invariant>
- <invariant>

## Ask the system first

| Question | Ask |
|---|---|
| <is it healthy?> | `<command>` |

## Routes — read exactly one, then come back

| When you are… | Read |
|---|---|
| <situation> | [references/<topic>.md](references/<topic>.md) |
| <procedure> | [subskills/<name>/SUBSKILL.md](subskills/<name>/SUBSKILL.md) |

## Common combinations

| Task | Read, in order |
|---|---|
| <task> | `references/a.md`, then `references/b.md` |

## Not here

| Topic | Go to |
|---|---|
| <topic> | the `<other-hub>` hub (`skillex skill show <other-hub>` prints its path) |

## Gotchas

- <trap> → `references/<topic>.md`
````

## References

- Lead with the answer, then the detail. An agent reads a reference to act.
- Each reference stands alone: it may link siblings, but never needs one to make
  sense.
- Name commands, files and line-stable identifiers (function names, unit names),
  not line numbers.
- Date anything time-sensitive ("disabled since 2026-11-03") so a reader can tell
  stale from current.
- Prefer tables for catalogs (passes, reason codes, units, commands).

## Pointing at other skills

The name is the identity, a path is a hint.

- Inside the hub: relative paths (`references/calls.md`).
- Another hub or a wild skill: "load the `vinyl` hub" + how to find it
  (`skillex skill show vinyl`), or a repo-relative path when it is a submodule
  (`components/vinyl/skills/vinyl/SKILL.md`).
- Never `../sibling/SKILL.md` and never `.agents/skills/<name>`: both only work if
  the other skill happens to be activated next to this one.

## Keep it true

The hub lives beside the code so it can be tested like code. Every hub should
have drift guards in the repo's own test suite. HeyMa's check:

- every `wax` subcommand in the argparse tree appears in `references/cli.md`;
- every pass YAML in `passes.d/` appears in the pass catalog, with its enabled state;
- every relative link in the hub resolves, there is exactly one `SKILL.md`, and
  nothing under `references/` or `subskills/` is orphaned;
- code that names the hub (ticket bodies, doctor output) names a path that exists.

When you change behaviour, change the route or reference in the same commit.

## Activation

Declare the repo once in `all-skills/sources.toml` with `mode = "link"`, map the
checkout in `~/.config/skillex/sources.local.toml` if it is not at
`~/code/<checkout>`, then select the hub by name in a manifest's `skills:` list
and `skillex sync`. See ADR-0002 §4.
