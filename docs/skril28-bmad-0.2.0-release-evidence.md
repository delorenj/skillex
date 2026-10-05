# SKRILL-28 — Skillex v0.2.0 BMAD Release Evidence

Release: `0.2.0` · Date: 2026-10-04 · Scope: BMAD freeze/status/explain + catalog refresh (primary unchanged, accepted freeze).

## Catalog component (delorenj/skills)
- Commit: `83658e49fff1ababbf4b1ded4ba86bb0b737d410` (main, pushed, verified via `git ls-remote`)
- Content: exactly the 47 pack members of `bmad@6.12.1-next.1` (420 files; no caches/`.lastagent`/secrets; extras `bmad-agent-git-archeologist`, `bmad-html-workspace` intentionally NOT committed — existing unrelated dirs).

## Registry pack (this repo)
- `packs/bmad/6.12.1-next.1/`: reference-only — 47 skill symlinks into `all-skills/`, 47 OpenCode command shims, `runtime/_bmad` 23 authentic files (sha256 inventory in `runtime/README.md`, verified 23/23), `pack.toml` authored contract.
- `pack verify bmad@6.12.1-next.1` → ok, findings [].
- Retired `packs/.archived-bmad-6.12.1-next.1/` moved outside discovery to `/tmp/skillex020-live-backup-0700/retired-pack/` (recoverable bytes; removes doctor E_PACK_LAYOUT).
- `sets/bmad-6.12.1-next.1/`: 47 member refs. Old untracked `sets/bmad-6.12.1-next.0/` left uncommitted (not an active selection).

## Live IdealScenario convergence (real env: HOME/XDG defaults)
- `sync --scope project --registry-root <repo>`: exactly 2 changes (remove owned dangling `liam` link + write receipt); repeat dry-run 0 changes / 0 findings; 111 entries (110 valid links + `.system`); global scope untouched.
- Legacy BMAD client commands removed after 0700 backup: 415 files (`.claude/commands` 60, `.codex/prompts` 55, `.crush/commands` 60, `.gemini/commands` 60, `.augment/commands` 60, `.qwen/commands` 60, `.opencode/command` 60) → `/tmp/skillex020-live-backup-0700/legacy-commands/`; remaining legacy `bmad-*` count 0; `.codex/auth.json`/config/cache untouched; fresh `.opencode/commands` (47) intact.
- Preservation: 79 _bmad-output/memory/other + 45 custom/user + 6 unrelated catalog dirty paths unchanged (parent-verified hashes).
- `bmad status`: 47 traced, 0 drifted.

## npm
- Published tarball built after the release commit (gitHead = release SHA); see `npm view @delorenj/skillex@0.2.0` for version/dist.tarball/dist.integrity/gitHead.

## Exclusions (deliberate)
`.opencode/`, `_bmad` local trees, `.momo/`, `conflict.log`, `.codegraph`, `_bmad-output/`, logs/credentials, `node_modules`, `.worktrees`, old packs/old sets, min-global symlinks (3 tracked changes restored to baseline), 6 unrelated catalog edits, 2 extra bmad dirs.
