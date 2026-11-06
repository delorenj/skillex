# SKRILL-32/33: Repo-owned hub skills (link sources) and hub lint

Implemented 2026-11-05 per [ADR-0002: Repo-Owned Hub Skills](../architecture/ADR-0002-repo-owned-hub-skills.md).

A skill about a codebase lives in that codebase at `<repo>/skills/<hub>/` and is
selected through the catalog by name. `all-skills/` keeps wild and vendored
skills only. One name still resolves to exactly one directory; the ownership
location changed, the SSOT invariant did not.

## Declaring a link source

`all-skills/sources.toml` reuses the vendoring declaration with a new `mode`:

```toml
version = 1

[[source]]
name = "heyma"
repo = "git@github.com:delorenj/HeyMa.git"
checkout = "HeyMa"      # logical ID, resolved per machine like vendoring
mode = "link"           # default "vendor"; "link" = the working tree is the definition
skills = ["heyma"]      # required in link mode; link mode never discovers names
# subdir defaults to "skills"; version is optional and unused in link mode
```

Link-mode rules, enforced at declaration parse time (`E_SOURCES_MANIFEST_INVALID`):

- `skills` is required and non-empty, and each skill's directory must equal its
  name (`{ name = "heyma", dir = "wax" }` is refused; link mode never renames).
- `version` may be omitted; if present it must still be a safe Git pin.
- A name declared by a link source cannot be declared by any other source.
  Vendoring such a name is refused, never silently preferred.

Checkout selection is unchanged from vendoring: `--checkout ID=PATH`, then
`SKILLEX_SOURCE_<ID>`, then `$XDG_CONFIG_HOME/skillex/sources.local.toml
[checkouts]`, then `$SKILLEX_SOURCE_ROOT/ID` or `~/code/ID`.

## Identity verification

A link checkout is the definition, so its identity is verified, not assumed
(`src/core/owned-sources.ts`):

- `STALE-CHECKOUT.md` at the checkout root refuses with
  `E_SOURCE_CHECKOUT_STALE`.
- The checkout must be the top level of a Git working tree
  (`E_SOURCE_CHECKOUT_INVALID`); an enclosing repository is never borrowed.
- `remote.origin.url`, normalized across `git@` and `https` forms, must equal
  the declared `repo` (`E_SOURCE_IDENTITY_MISMATCH`).
- Any symlink inside the skill whose target leaves the checkout refuses with
  `E_OWNED_SKILL_ESCAPE`. The hub itself must be a real directory with a real
  `SKILL.md` (`E_NONCANONICAL_REFERENCE`).

Resolution failures are loud and shaped by the declaration: a required source
with no checkout is `E_SOURCE_CHECKOUT_MISSING` (refused); an optional one
makes the skill `E_SKILL_MISSING`. `skill list` omits an unavailable optional
source; everything else refuses.

## Resolution

`canonicalSkill` checks `all-skills/` first, then the owned index. A name in
both raises `E_DIVERGENT_CANONICAL_NAME` — no shadowing, no precedence. Catalog
entries report `owner: { kind: "catalog", ... }`; repo-owned skills report
`owner: { kind: "repo", source, repo, checkout, commit }` in `skill list`,
`skill show`, and `skill explain`.

Resolution reads `all-skills/sources.toml` tolerantly: a manifest that cannot
be read or parsed declares no owned names (so catalog-only selections still
sync), and `doctor`/`vendor` report it strictly. Declare a source
`optional = true` when only some machines have its checkout.

Activation is unchanged. Sync writes the same relative links, now pointing into
the owning repo (`~/HeyMa/.agents/skills/heyma -> ../../skills/heyma`), and
receipts record the owning repo's HEAD through the existing
`dirname(binding.path)` source evidence. Because the link follows the live
checkout, that HEAD moving on its own never makes a receipt pending (`status`,
`profile show` stay at exit 0); the fresh commit is written the next time the
receipt is rewritten for a link change. The owning repo's checkout root is a
forbidden receipt root like the catalog itself; a project that is the owning
repository still activates its own hub through an ordinary relative link.

Sets and packs refuse repo-owned members with
`E_OWNED_SKILL_IN_COMPOSITION` (phase 1; phase 2 generates their link farms per
machine). Select hubs through a manifest's `skills:` list.

## Vendor commands and link sources

`vendor sync`, `vendor status`, `vendor inspect`, and `vendor prune` skip link
sources. Sync reports them as `{ linked: true, skipped: true }` with an
`I_SOURCE_LINKED` info finding and never copies their bytes into `all-skills/`.
Status lists their skills with state `"linked"` and shows checkout detail only
under `--upstream`. `doctor --sources-only` does not flag link sources as
digest drift; it counts them under `repoOwnedSkills` and lints each available
hub instead.

## Hub lint (`skillex skill lint`)

`skillex skill lint <name>` lints a declared repo-owned hub in its owning
checkout; `skillex skill lint --path <dir>` lints any hub directory (a wild hub
directly under the registry's `all-skills/` skips the repository rules
`E_HUB_COUNT` and `W_HUB_PROVENANCE`); passing
both or neither is `E_USAGE`. `--max-lines` overrides the 500-line budget.
Exit codes follow the envelope: errors refuse (3), warnings drift (6), info
and clean succeed (0). `skillex doctor` runs the same rules for every link
source with an available checkout.

| Code | Rule |
|---|---|
| `E_HUB_COUNT` | `<repo>/skills/` holds exactly one directory with a `SKILL.md` |
| `E_HUB_NAME` | directory name = declared name = frontmatter `name` |
| `E_HUB_FRONTMATTER` | `name` and `description` present; name a canonical skill name ≤ 64 chars; description ≤ 1024 chars |
| `W_HUB_SIZE` | `SKILL.md` over the line budget (default 500, target 200) |
| `E_HUB_REFERENCE_MISSING` | a relative Markdown link does not resolve inside the hub |
| `E_HUB_REFERENCE_ESCAPE` | an absolute (`/`, `~`) or leaving relative link |
| `W_HUB_ORPHAN` | a Markdown file under `references/` or `subskills/` that no link or code-span path names |
| `E_HUB_NESTED_SKILL` | a `SKILL.md` below the hub root (use `SUBSKILL.md`) |
| `E_HUB_SKILL_REF_UNKNOWN` | a "load the \`x\` hub/skill" phrase naming nothing resolvable |
| `E_HUB_SYMLINK` | a symlink anywhere in the hub tree |
| `W_HUB_PROVENANCE` | a `.source.yaml` in a repo-owned skill |

Only Markdown inline links and reference definitions outside fenced code blocks
and inline code spans are checked; URLs, `//` hosts and `#anchors` are not
filesystem references. Files under top-level `examples/`, `templates/` and
`assets/` are not scanned.
