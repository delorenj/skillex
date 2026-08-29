# Vendoring external skill repositories

`skillex vendor` copies skills out of the repository that **authors** them into
`all-skills/` as real, committed content pinned to a version. Authoring continues
in the home repo; the catalog holds a copy that resolves on every machine.

## Why

`all-skills/` is a published git submodule (`delorenj/skills`). Fifteen of its
entries are symlinks with **absolute** targets into `~/code/33GOD`, so the
published catalog ships fifteen paths that resolve on exactly one machine.
Measured on a simulated second machine, before this feature:

| composition | members | usable off-machine |
| ----------- | ------- | ------------------ |
| `sets/min-global` | 38 | 26 |
| `sets/global` | 92 | 75 |

After `vendor sync` + `vendor relink`, measured the same way: **36** and **87**.
(The last five in `global` point at `CoachingAgentFramework` and `hyperframes`,
which no source declares yet; `vendor relink` reports them and leaves them alone.)

## The model

```
all-skills/sources.toml            DECLARATION  (committed, shared, no machine paths)
        │  skillex vendor sync
        ▼
all-skills/<name>/**               CONTENT      (committed, real files)
all-skills/<name>/.source.yaml     RECEIPT      (committed: which repo, which commit, what digest)

~/.config/skillex/sources.local.toml            (machine-local: where each checkout lives)
```

The declaration/receipt split is the same one `skillex sync` uses. It differs in
one place, deliberately: `core/state.py` keeps its receipt in `$XDG_STATE_HOME`
because it records what *this machine* wrote into an activation root. This
receipt records which bytes are in this *catalog commit* — identical on every
machine, changing only in the commit that changes the bytes, and reviewable in
that diff. It belongs in the repo.

## `sources.toml`

```toml
version = 1

[[source]]
name     = "pjangler"                              # source id; also the default checkout id
repo     = "git@github.com:delorenj/pjangler.git"  # provenance identity, never dialed
version  = "v1.4.2"                                # a git tag, branch, or commit SHA
subdir   = "skills"                                # DEFAULT: the repo's root-level skills/
checkout = "pjangler"                              # logical id, when it differs from `name`
include  = []                                      # discovery filters, applied in this order
exclude  = []
optional = false                                   # a missing checkout warns instead of failing
skills   = []                                      # explicit selection; omit to discover
```

| field | required | meaning |
| --- | --- | --- |
| `name` | yes | Unique across the file. Addresses the source in `--source`, and every receipt records it. |
| `repo` | yes | Must start with `https://`, `http://`, `ssh://`, `git://`, `git@` or `file://`. Recorded, compared to the checkout's `origin` (mismatch warns), and **never dialed**. |
| `version` | yes | The pin's target: tag, branch, or 40-hex SHA. `..` and a leading `-` are refused. The **resolved commit** is what the receipt records. |
| `subdir` | no, default `"skills"` | Repo-relative directory holding the skills. `""` means the repository root. |
| `checkout` | no, default `name` | Logical checkout id. Two sources may share one — 33GOD owns skills at two unrelated paths. |
| `skills` | no | Explicit selection. Each item is `"name"` or `{ name = "...", dir = "..." }`. Omit to discover every skill directory under `subdir`. |
| `include` / `exclude` | no | Applied in that order to a discovered inventory, preserving order. Mutually exclusive with `skills`. |
| `optional` | no | A missing checkout becomes `W_SOURCE_OPTIONAL_MISSING` and exit 4 instead of a refusal. |

### The catalog name comes from the manifest, and only from the manifest

Not the directory basename, and not the `SKILL.md` frontmatter. Both disagree with
the catalog on this machine, in opposite directions:

- `momo` — the source directory is named `skill`; the catalog name is `momo`.
- `project-jangler` — the directory is `project-jangler`; the frontmatter has read
  `name: pjangler`.

So `skills = [{ name = "momo", dir = "skill" }]`, and `dir` merely defaults to
`name` for everything else.

### Refused fields

Each raises `E_UNSUPPORTED_FIELD` (exit 2) carrying its own explanation, rather
than being silently ignored:

| field | why |
| --- | --- |
| `clone`, `fetch`, `auto_fetch` | skillex never clones or fetches. |
| `url` | renamed to `repo`. |
| `ref` | renamed to `version`; two fields could disagree about the pin. |
| `path` | ambiguous between the local checkout and the in-repo directory. |

## `.source.yaml`

Extends the one hand-written `type: vendored` record already in the catalog
(`all-skills/ego-browser`), which carried `upstream` and `upstream_version` and
nothing that made the claim checkable. Every key the other 162 records rely on
(`origin.type`, `origin.extracted_at`, `modified_locally`) is unchanged.

```yaml
# Provenance for this skill. Managed by `skillex vendor`; do not hand-edit.
origin:
  type: vendored
  source: momo                                     # the [[source]] name
  upstream: git@github.com:delorenj/momo.git
  upstream_version: main                           # as declared
  upstream_commit: f52d3baca62869cda598d2acd32b205befc9f72d   # RESOLVED
  upstream_tree: 74c192b5e2c6fd839d4848a9ffc5f254ec490f11     # cheap change detection
  upstream_path: skill                             # repo-relative source directory
  extracted_at: "2026-08-29T16:57:05+00:00"
  digest: sha256:62d08a3c51cb0c8010c1c04dd6cd3c930dcab243abe485cd1729de145a0ab0fa
modified_locally: false
```

Three things it fixes:

- **`upstream_commit`, not just a tag.** momo has zero tags; 33GOD and bloodbank
  have only date-stamped baselines. A resolved SHA is the only pin all four can
  express.
- **`digest` makes `modified_locally` computable.** It is `sha256` over
  `<mode> <sha256>  <relpath>` lines, sorted, with the root `.source.yaml`
  excluded and the executable bit **in** the digest (skills ship `scripts/`).
  `modified_locally` is still written for reader compatibility and is never
  trusted — `vendor status` recomputes.
- **It is rewritten on every sync.** `skill_ssot.py` returned early when the file
  existed, so every claim was frozen at extraction. That is why
  `project-lifecycle` still says `modified_locally: false` through a near-total
  rewrite.

An upstream `.source.yaml` shipped inside a source repo is **dropped**, not
copied: two of the fifteen carry one claiming `type: local` about a repository
that is not the catalog. It is also excluded from the digest, so upstream adding
or removing one is never drift.

## Commands

```
skillex vendor list    [--catalog P] [--sources P] [--checkout ID=PATH]... [--json]
skillex vendor status  [--catalog P] [--sources P] [--source NAME]... [--upstream]
                       [--strict] [--json] [-v]
skillex vendor sync    [--catalog P] [--sources P] [--source NAME]... [--checkout ID=PATH]...
                       [-n|--dry-run] [--adopt] [--force] [--prune] [--strict] [--json] [-v]
skillex vendor relink  [--root P] [--catalog P] [-n|--dry-run] [--json] [-v]
skillex vendor show    NAME [--catalog P] [--json]
```

| flag | meaning |
| --- | --- |
| `--catalog` | Where content is written. Default: the **first** registry root + `/all-skills`. Writing never walks the ladder — landing committed content in a stale cache clone is not a fallback. |
| `--sources` | The manifest. Default `<catalog>/sources.toml`. |
| `--checkout ID=PATH` | Highest-precedence checkout override, repeatable. |
| `-n` | Resolve and plan; write nothing. |
| `--adopt` | Take over an existing **unmanaged** catalog directory, replacing its content with the pin. |
| `--force` | Discard a local edit to an already-vendored skill. |
| `--prune` | Delete an entry a source no longer declares — only when it still matches its pin. |
| `--upstream` | `status` only: also re-resolve each version and report a stale pin. Needs the checkouts. |
| `--strict` | Promote vendor warnings to errors. Uses `VENDOR_STRICT_PROMOTES`, not `sync`'s `STRICT_PROMOTES`, which is reserved for topology violations. |

### Exit codes

Reused unchanged from `core/diagnostics.py`; no new code was added.

| code | when |
| --- | --- |
| 0 | clean |
| 1 | staging failed; nothing was swapped |
| 2 | `sources.toml` is wrong — fixed by editing a file |
| 3 | the disk or a repository holds something we will not touch — fixed by moving files |
| 4 | an `optional` source was skipped |
| 5 | another skillex process holds the lock |
| 6 | `status` found drift |

## Checkout resolution

`sources.toml` is committed, so it may not hold a path. Highest precedence first:

1. `--checkout ID=PATH` — exclusive.
2. `$SKILLEX_SOURCE_<ID>` (non-alphanumerics folded to `_`, uppercased) — exclusive.
3. `$XDG_CONFIG_HOME/skillex/sources.local.toml`, table `[checkouts]`.
4. `$SKILLEX_SOURCE_ROOT/<id>`, default `~/code/<id>`.

See `docs/vendoring/sources.local.toml.example`.

## Nothing is ever cloned or fetched

`paths.py` states it, `SkillEntry.from_spec` and `SetEntry.from_spec` repeat it in
refusal prose, and `skills.schema.json` says it twice. Vendoring is an addition to
that world, not a reversal of it. A version that is not in the local object store
is `E_SOURCE_REF_UNKNOWN` carrying the `git -C <checkout> fetch` you should run.

Two mechanisms, not one convention:

- `core/gitsource.py` holds an allowlist of git subcommands (`rev-parse`,
  `ls-tree`, `archive`, `config`, `cat-file`) checked at the single place that
  spawns a process. `fetch`, `clone`, `pull` and `remote` are not in it.
- Every subprocess runs with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`
  and `GIT_SSH_COMMAND=/bin/false`, so even a mis-declared ref cannot open a
  connection or hang on a prompt.

Content is read from `<commit>:<path>`, never from the worktree. The four source
repositories are, as of this writing, 42 and 6 entries dirty and one commit ahead
of the gitlinks recording them. Addressing a commit is the only way the result is
reproducible — and it is the only way to *see* that `33GOD/skills/` is sixteen
mode-`120000` blobs.

## Safety

- **Any error means zero mutation**, in every source. Enumeration and
  classification finish before a single byte is written.
- **Staged, then swapped.** Everything lands in `all-skills/.vendor-stage/<pid>/`
  and is verified there. The swap is two renames per entry on the same
  filesystem: `live -> trash`, `new -> live`. A crash in that window leaves the
  entry absent and its old content in `trash`; the next run rolls it back. The
  trash directory *is* the receipt, so no extra state file is needed.
- **A locally-modified vendored skill is never silently overwritten.** The
  recorded digest is recomputed on every run; a mismatch is
  `E_VENDOR_LOCAL_EDITS` naming the repo to push to. Only `--force` discards it.
- **Unmanaged content is never silently overwritten either.** A real directory
  with no vendored receipt is `E_VENDOR_WOULD_CLOBBER` until `--adopt`.
- **A source that could not be read never looks like a source that dropped
  skills.** Orphan detection runs only for sources that resolved and enumerated
  cleanly; otherwise a missing checkout plus `--prune` would delete everything it
  owns.

### Refusals worth naming

| code | fires on |
| --- | --- |
| `E_SOURCE_ENTRY_IS_LINK` | A mode-`120000` entry anywhere in the declared tree. **`33GOD/skills/` is sixteen of these.** The fix names the four repositories that actually own the content. |
| `E_SOURCE_ENTRY_IS_SUBMODULE` | A mode-`160000` gitlink. Nine of the fifteen live in nested submodules whose content is not in 33GOD's object database. |
| `E_SOURCE_NOT_A_SKILL` | The declared tree has no `SKILL.md` at its root. |
| `E_SOURCE_UNSAFE_MEMBER` | A tree member whose name cannot be written safely. |

## The migration

Not yet run. It is a reviewed content commit in `delorenj/skills`, deliberately
left to the operator.

```bash
# 0. one-time, machine-local
mkdir -p ~/.config/skillex
cp docs/vendoring/sources.local.toml.example ~/.config/skillex/sources.local.toml

# 1. in the catalog submodule
cp docs/vendoring/sources.toml all-skills/sources.toml
printf '\n# Vendoring stage; removed on every clean run.\n.vendor-stage/\n' >> all-skills/.gitignore

# 2. look before you leap
skillex vendor sync -n -v

# 3. vendor. --adopt is needed exactly once, for `agent-fleet-operations` and
#    `projects` -- already real directories, byte-identical to pjangler, and
#    recording nothing about where they came from.
skillex vendor sync --adopt

# 4. repoint the composition links that bypass the catalog entirely.
#    22 of them point straight at ~/code/33GOD; vendoring alone heals only 3.
skillex vendor relink -n
skillex vendor relink

# 5. verify with no source repo consulted, then commit both repos
skillex vendor status          # expect: 17 declared, 17 verified, exit 0
git -C all-skills add -A && git -C all-skills commit -m "vendor: 17 skills from 4 external sources"
git -C all-skills push
git add all-skills sets && git commit -m "chore: bump catalog gitlink; repoint sets/ at the catalog"
```

Dry-run plan, measured against the live checkout on 2026-08-29:

```
pjangler        git@github.com:delorenj/pjangler.git  @ v1.4.2 -> dbafc004
bloodbank       git@github.com:delorenj/bloodbank.git @ main   -> 4ee7bea3
momo            git@github.com:delorenj/momo.git      @ main   -> f52d3bac
33god-platform  git@github.com:delorenj/33GOD.git     @ main   -> 3516fa11
krebs           git@github.com:delorenj/33GOD.git     @ main   -> 3516fa11

adopt        × 2   agent-fleet-operations, projects
replace-link × 15  the fifteen absolute symlinks
```

### Steady state

Author in the home repo → push → `skillex vendor sync` → commit the catalog.
`skillex vendor status` in CI catches a hand-edit of vendored bytes
(`W_VENDOR_LOCAL_EDITS`) or, with `--upstream`, a catalog gone stale against its
declared version (`W_VENDOR_PIN_STALE`). Both exit 6.

## What this deliberately does not do

- **It does not run inside `skillex sync`.** Sync projects symlinks into
  activation roots constantly; vendoring writes committed content into a git
  repository the user reviews and pushes. Different blast radius, different
  cadence. `sync` never reads `sources.toml`.
- **It does not touch `skills.json` or `skills.schema.json`.** A source is a
  property of the *catalog*, which every machine shares by gitlink; putting it in
  a per-scope activation manifest would make machine 2 re-declare it.
- **It does not change `core/resolver.py`.** Vendoring is a no-op for resolution:
  the fifteen names simply start resolving to real directories,
  `Binding.outside_catalog` flips to `False`, and `W_SET_LINK_OUTSIDE_CATALOG`
  stops firing on its own. That is the design's main virtue.
