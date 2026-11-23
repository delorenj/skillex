# SKRILL-55 — reviewed ordinary source delivery

## Authority and scope

Owner-authorized ordinary reviewed source delivery only: canonical skill guidance in
`delorenj/skills` and the standalone MCP package in `delorenj/skillex`. Public package
publishing, fleet activation, existing-index mutation, and ticket-state writes are
excluded. This executes the owner grant; independent review is not PM merge approval.

Outcome: MCP tools invoke the separately installed standalone CodeGraph Voyage CLI,
without requiring a target project's `tools/codegraph_voyage` module. Canonical guidance
explains separate environments, explicit project paths, credentials and stdio/SSE setup.
Acceptance: exact reviewed bytes; five tools over both installed transports; wheel/sdist
builds; unchanged fixture source DB; canonical selected skill parity; remote main and pin
verification; preservation of unrelated dirty files and existing recovery worktrees.
Merge order: skills main, then Skillex package/evidence/all-skills pin, then Skillex main.

## Exact source identities and integration

| Item | Identity |
| --- | --- |
| Skillex starting origin/main | `f10d3cc3140d3b9eacad580282f78e486430b8d0` |
| Skills starting origin/main / old gitlink | `266d33b4a458762a1c819e31d734898140640ca4` |
| Independently reviewed package | `69d917d79750b17342f2033dbefb1ca34046cd28` |
| Reviewed docs, in order | `ac79381f35069f56069b4659311cee1652184509`, `e70b191026093dbe0db60f5bf97530420a02ce4c` |
| Landed docs commits | `f62555f` then `c093b1c9ea7ccb3a0197eb3979071c5234da1b5a` |
| Integrated package commit | `41a4d94def3a78047ed413a66da8d2efa1bbae52` |

[Skills main landing](https://github.com/delorenj/skills/commit/c093b1c9ea7ccb3a0197eb3979071c5234da1b5a)
contains only the two owned docs paths beyond its baseline. The package integration
contains only these five owned paths beyond its baseline:

- `mcp-servers/codegraph-voyage-mcp/README.md`
- `mcp-servers/codegraph-voyage-mcp/pyproject.toml`
- `mcp-servers/codegraph-voyage-mcp/src/codegraph_voyage_mcp/server.py`
- `mcp-servers/codegraph-voyage-mcp/tests/test_server.py`
- `mcp-servers/codegraph-voyage-mcp/tests/test_protocol.py`

This evidence and the forward-only `all-skills` gitlink are the only additional root
changes. Neither preserved recovery branch was wholesale merged: both have unrelated
ancestor differences. New isolated delivery worktrees were created from freshly fetched
origin/main, and only the three exact ticket commits were cherry-picked with `-x`.

The first docs cherry-pick conflicted only in owned `codegraph-voyage/SKILL.md` because
main already had newer hooks wording. Resolution retained the first commit's hooks
paragraph for that intermediate commit; the second cherry-pick restored the reviewed
final wording. No final candidate bytes changed. `git diff --exit-code` against the
reviewed final candidate passed for both owned docs paths and all five package paths.
Any differing final bytes would require stopping for independent re-review.

Both integration worktrees ran `git pull --no-rebase origin main` before landing.
Skills main was fast-forward merged in the dirty canonical checkout without stashing,
branch switching or submodule recursion, then pushed from the isolated worktree:

```text
Updating 266d33b..c093b1c
Fast-forward
To https://github.com/delorenj/skills.git
   266d33b..c093b1c  main -> main
c093b1c9ea7ccb3a0197eb3979071c5234da1b5a refs/heads/main
```

The existing gitlink is an ancestor of the landed skills commit (`git merge-base
--is-ancestor 266d33b4a458762a1c819e31d734898140640ca4 c093b1c9ea7ccb3a0197eb3979071c5234da1b5a`, exit 0).
The new root gitlink uses a new disposable detached skills worktree in the isolated
root worktree; the existing dirty canonical skills checkout stays on `main`.

## Byte identities

SHA-256 of reviewed source, clean wheel installation, sdist installation, rebuilt
wheel member and rebuilt sdist member `server.py`:

```text
739345443c1dbb6ec13038048137cfb9c43c7beb32b0e31458c23c8242ae67f4
```

Canonical docs SHA-256 (both local canonical files and reviewed candidate match):

```text
4acf36cf87e40e90dcddb0d0010a560a48d63c6628a424defadf83a7840cf7a6  codegraph-voyage/SKILL.md
dc14687c950ee2885e5ea8d3da586dfa69e0871688b79f0f7df2e0a415c76c5d  codegraph-voyage/references/mcp-server.md
```

Selected source path, inspected without activation writes:
`/home/delorenj/code/skillex/.agents/skills/codegraph-voyage` resolves to
`/home/delorenj/code/skillex/all-skills/codegraph-voyage`.

`uv build mcp-servers/codegraph-voyage-mcp --out-dir "$TMPDIR/skrill55-delivery-dist"`
built both archives from the integrated candidate. Delivery archive SHA-256 values
(tar/zip timestamps mean rebuilt archive digests need not equal earlier build digests):

```text
a67237188dde29ee642216fe81480dfa01c6c4d57477ba6adfdcc62a8dcd0e52  codegraph_voyage_mcp-0.1.0-py3-none-any.whl
6f8e500b2bccd5e8bae6886baaafd3f62da3366b7c7f40be6271da393fc0ed22  codegraph_voyage_mcp-0.1.0.tar.gz
```

## Reproducible installed-package verification

Scratch root is `/home/delorenj/.hermes/profiles/skillex-pm/cache/scratch` (`$TMPDIR`),
never system `/tmp`. Existing separate environments:

- companion clean wheel: `$TMPDIR/skrill55-clean-wheel`
- companion sdist: `$TMPDIR/skrill55-sdist-env`
- standalone CLI: `$TMPDIR/skrill55-cli` (`codegraph-voyage==0.1.0`, editable installed
  from `/home/delorenj/code/codegraph-voyage`; used read-only, not modified here)
- CodeGraph executable: `/home/delorenj/.local/bin/codegraph`, version `1.4.1`

Companion metadata: `codegraph-voyage-mcp==0.1.0`, `mcp>=1.0,<2`,
`starlette>=0.27`, `uvicorn>=0.23`; console entry point
`codegraph_voyage_mcp.server:main`. The source candidate and installed companion
`server.py` hashes were checked before exercising either installation.

From the landed package directory, the following reproduce the delivery tests. Use
fresh scratch basetemp names if retaining an earlier pytest fixture tree is desired.

```bash
cd /home/delorenj/code/skillex/mcp-servers/codegraph-voyage-mcp
env -u PYTHONPATH PYTHONDONTWRITEBYTECODE=1 \
  CGV_MCP_TEST_BIN="$TMPDIR/skrill55-clean-wheel/bin" \
  CGV_MCP_TEST_CLI_BIN="$TMPDIR/skrill55-cli/bin" \
  "$TMPDIR/skrill55-clean-wheel/bin/python" -m pytest -q -s -p no:cacheprovider \
  --basetemp="$TMPDIR/skrill55-delivery-pytest-wheel" tests/
env -u PYTHONPATH PYTHONDONTWRITEBYTECODE=1 \
  CGV_MCP_TEST_BIN="$TMPDIR/skrill55-sdist-env/bin" \
  CGV_MCP_TEST_CLI_BIN="$TMPDIR/skrill55-cli/bin" \
  "$TMPDIR/skrill55-sdist-env/bin/python" -m pytest -q -s -p no:cacheprovider \
  --basetemp="$TMPDIR/skrill55-delivery-pytest-sdist" tests/
```

Executed against the integrated exact candidate: **27 passed in 3.32s** (clean wheel)
and **27 passed in 3.64s** (sdist), zero skips. Both produced:

```text
PROTOCOL_EVIDENCE stdio: {"explore": "authenticate", "explore_preview": "authenticate", "index": "2 documents", "listed": ["explore", "index", "search", "semantic_candidates", "status"], "search": "authenticate", "semantic_candidates": "authenticate", "status": "2 nodes, 2 embeddings"}; provider=localhost HTTP fixture (5 calls); real installed CLI; source_db_sha256_unchanged=true
PROTOCOL_EVIDENCE sse: {"explore": "authenticate", "explore_preview": "authenticate", "index": "2 documents", "listed": ["explore", "index", "search", "semantic_candidates", "status"], "search": "authenticate", "semantic_candidates": "authenticate", "status": "2 nodes, 2 embeddings"}; provider=localhost HTTP fixture (5 calls); real installed CLI; source_db_sha256_unchanged=true
```

Only disposable fixture sidecars were created. The fixture uses fixed four-dimensional
vectors served locally via OpenRouter-format HTTP with a disposable key; this is **not
live provider or embedding-quality verification**. No live provider was tested.

**Environment caveat:** `$TMPDIR/skrill55-wheel-env` is contaminated/stale. Its MCP
entrypoint targets the CLI distribution's competing server, and its server digest is
not this candidate's. Its two protocol failures are not clean candidate proof. The
separate byte-verified clean-wheel and sdist environments are the evidence above.
No claim is made about live hung-child timeout, disconnect soak, or unrelated ancestor
changes. No public wheel/sdist was published.

For a fresh companion installation, build the package, create two scratch venvs, and
install only the companion plus its test extras in each (keep the CLI in its own env):

```bash
uv build mcp-servers/codegraph-voyage-mcp --out-dir "$TMPDIR/skrill55-repro-dist"
uv venv "$TMPDIR/skrill55-repro-wheel"
uv pip install --python "$TMPDIR/skrill55-repro-wheel/bin/python" \
  "$TMPDIR/skrill55-repro-dist/codegraph_voyage_mcp-0.1.0-py3-none-any.whl[test]"
uv venv "$TMPDIR/skrill55-repro-sdist"
uv pip install --python "$TMPDIR/skrill55-repro-sdist/bin/python" \
  "$TMPDIR/skrill55-repro-dist/codegraph_voyage_mcp-0.1.0.tar.gz[test]"
# Repeat pytest commands with these companion bin directories and a separately
# installed codegraph-voyage CLI on CGV_MCP_TEST_CLI_BIN.
```

## Preservation and final readback procedure

Before mutation, `$TMPDIR/skrill55-preservation.py save` recorded file hashes/modes,
symlink targets, cached-diff hashes, branches, and existing worktree records/status/diff
hashes in `$TMPDIR/skrill55-preserved-state.json`:

```text
PRESERVATION_BASELINE sha256=5c159d6f383088ed6f3cd6bca72eb3c9cfc7d10df57ce11d441ffebe8e130532
skillex: branch=main unchanged_dirty_file_count=2 existing_worktree_count=8
skills: branch=main unchanged_dirty_file_count=38 existing_worktree_count=4
both cached_diff_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Repeated preservation checks passed after skills landing. Root dirty files are
`.lastagent` and `_bmad-output/implementation-artifacts/bloodbank-events.jsonl`.
Skills dirty content is `krebs/SKILL.md`, `skill-maintenance/SKILL.md`,
`subagent-driven-development/SKILL.md`, plus 35 pre-existing untracked project files.
No stashing/autostashing, resets, rebases, shared branch switches, cleanup of others'
files, or copying/moving existing worktrees is used. Existing recovery worktrees remain:

- `/home/delorenj/code/skillex/.worktrees/33GOD-35-mcp-standalone` at
  `69d917d79750b17342f2033dbefb1ca34046cd28`
- `/home/delorenj/code/skillex/all-skills/.worktrees/33GOD-35-mcp-guidance` at
  `e70b191026093dbe0db60f5bf97530420a02ce4c`

After root landing, independently read remote refs, compare owned local files and
selected canonical bytes against the exact candidates, check both gitlinks and
branches, rerun the package suite from root main, run the preservation check and
`git unpushed /home/delorenj/code/skillex`. That diagnostic scans all existing
worktrees; unrelated dirty/no-upstream/detached/old unpushed branches are preservation
requirements, not authority to change them. Confirm separately that both mains have
zero ahead/behind. Remove only the two new delivery worktrees and the new detached
pin worktree, then delete only their new merged branches. Do not bulk-prune.

## Repository pre-push environment repair (no source changes)

The first push attempt from the new isolated worktree stopped at Node build because
local `node_modules/typescript/bin/tsc` was absent. `npm ci --ignore-scripts --cache
"$TMPDIR/skrill55-npm-cache"` installed the exact lockfile dependencies only in that
new worktree (no source/lockfile changes; npm reported two moderate audit findings,
which were not repaired as unrelated scope).

The next normal hook run passed Biome/typecheck, Node **1,351 passed / 1 skipped /
0 failed**, Ruff, and mypy (42 source files), then Python returned **12 failed,
961 passed, 9 skipped**; its automatic `--lf` rerun reproduced all 12 failures in
`tests/unit/test_sync_aliases.py`. This is the unchanged origin/main guard
`if alias.parts and any(part in NEVER_TOUCH for part in alias.parts)` skipping
every path below the session's required `.hermes/.../scratch`. The source, tests,
and guard are identical to origin/main; no unrelated fix was made.

A private Bubblewrap mount aliases the **same required scratch storage** at
`/run/skrill55-scratch` solely inside the child mount namespace. This is not system
`/tmp`, a new host directory, activation, or a source change. A targeted real run
with this alias returned **22 passed in 0.44s** for the complete alias test module:

```bash
bwrap --bind / / --dev-bind /dev /dev --tmpfs /run \
  --bind "$TMPDIR" /run/skrill55-scratch \
  --setenv TMPDIR /run/skrill55-scratch \
  --chdir /home/delorenj/code/skillex/.worktrees/skrill55-delivery-package \
  env -u PYTHONPATH uv run pytest -q tests/unit/test_sync_aliases.py \
  --basetemp=/run/skrill55-scratch/skrill55-alias-namespace-probe
```

The initial namespace probe lacked `--dev-bind /dev /dev` and failed opening
`/dev/null`; the corrected alias probe passed. Binding the host root into a user
namespace exposed root-owned ancestors as unmapped UID 65534 and broke unrelated
Node receipt ownership checks. An isolated tmpfs root preserves the executing UID;
mounting the required scratch storage at `/scratch` and at the namespace's `/tmp`
also redirects the existing Node tests that hardcode `/tmp` without touching the
host's system temp directory. The corrected bounded probes passed: Node activation
state **27 passed / 1 skipped / 0 failed** and Python aliases **22 passed in 0.29s**.
The full ordinary push uses this tested namespace (no hook bypass):

```bash
bwrap --tmpfs / --ro-bind /usr /usr \
  --symlink usr/bin /bin --symlink usr/sbin /sbin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc /etc --bind /home /home --dev-bind /dev /dev \
  --proc /proc --ro-bind /sys /sys --bind /run /run \
  --bind "$TMPDIR" /scratch --bind "$TMPDIR" /tmp --setenv TMPDIR /scratch \
  --chdir /home/delorenj/code/skillex/.worktrees/skrill55-delivery-package \
  env -u PYTHONPATH git -c core.sshCommand='ssh -F /dev/null' push origin main
```

`ssh -F /dev/null` is a per-command adjustment: the namespace's unmapped root-owned
system SSH include otherwise fails its ownership check. A real `ls-remote` with
this setting succeeded, using the same GitHub host/user and default identity files;
no SSH/repository configuration was changed. The landed main package suite was also
run directly from `/home/delorenj/code/skillex/mcp-servers/codegraph-voyage-mcp`:
**27 passed in 3.12s**, including five tools over stdio and SSE.

## Independent review reports

The following are durable transcriptions of both independently supplied reports.
Original scratch report digests:

```text
b43e871782677f80a4a3e4d5648410a3366cdf56d3f834faa0b523f498dc250b  skrill55-spec-review.md
1d9ac54134c94f0d1b962519cff7b4ef2e547fc8cf492d97cc8a91d575373d97  skrill55-quality-review.md
```

### Independent SPEC/AC review

**Verdict: PASS for the exact package and docs candidates, with landing/activation pending.** No source, board, publication, fleet, or real-index writes were made by this review. This is not merge approval.

**Signed-off-by:** Hermes Agent — independent SPEC/AC reviewer (not implementer)
**Candidate identities:** package `69d917d79750b17342f2033dbefb1ca34046cd28` in `/home/delorenj/code/skillex/.worktrees/33GOD-35-mcp-standalone`; docs `e70b191026093dbe0db60f5bf97530420a02ce4c` in `/home/delorenj/code/skillex/all-skills/.worktrees/33GOD-35-mcp-guidance`. Compared final candidate paths with each repository's `origin/main`, not an ancestor snapshot. Package `origin/main=f10d3cc3140d3b9eacad580282f78e486430b8d0`; docs `origin/main=266d33b4a458762a1c819e31d734898140640ca4` at review time.

#### Reproduction and provenance

Scratch root: `/home/delorenj/.hermes/profiles/skillex-pm/cache/scratch` (`$TMPDIR`). Run these from `/home/delorenj/code/skillex/.worktrees/33GOD-35-mcp-standalone/mcp-servers/codegraph-voyage-mcp`, with the installed `codegraph` executable on PATH:

```bash
env -u PYTHONPATH PYTHONDONTWRITEBYTECODE=1 CGV_MCP_TEST_BIN=$TMPDIR/skrill55-clean-wheel/bin CGV_MCP_TEST_CLI_BIN=$TMPDIR/skrill55-cli/bin $TMPDIR/skrill55-clean-wheel/bin/python -m pytest -q -s -p no:cacheprovider --basetemp=$TMPDIR/skrill55-review-pytest-clean-wheel tests/
env -u PYTHONPATH PYTHONDONTWRITEBYTECODE=1 CGV_MCP_TEST_BIN=$TMPDIR/skrill55-sdist-env/bin CGV_MCP_TEST_CLI_BIN=$TMPDIR/skrill55-cli/bin $TMPDIR/skrill55-sdist-env/bin/python -m pytest -q -s -p no:cacheprovider --basetemp=$TMPDIR/skrill55-review-pytest-sdist tests/
```

Independently executed: clean-wheel **27 passed in 3.20s**; sdist **27 passed in 3.35s**. Each execution produced `PROTOCOL_EVIDENCE` for **stdio and SSE**: initialize/list five names; `status` 2 nodes then 2 embeddings; `index` 2 documents; `search`, `semantic_candidates`, preview and executed `explore` return `authenticate`; localhost HTTP OpenRouter-format embeddings fixture received 5 calls per transport; source DB SHA-256 unchanged. The fixture uses a disposable key and fixed 4-dimensional vectors, **not** a live provider. The installed standalone CLI is invoked as a subprocess, not mocked in these protocol tests. The source fixture has no `tools/` directory. The test temp roots are under scratch; only the disposable sidecar DB was created. Other 25 cases test schema, subprocess safety, invalid/missing arguments, missing CLI, nonzero exit, fake-provider refusal and timeout.

The candidate `server.py`, both final built archives (`$TMPDIR/skrill55-final-dist/codegraph_voyage_mcp-0.1.0-py3-none-any.whl` and `.tar.gz`), and installed clean-wheel/sdist server files matched byte-for-byte: SHA-256 `739345443c1dbb6ec13038048137cfb9c43c7beb32b0e31458c23c8242ae67f4`. Archive SHA-256: wheel `55d909d1a40347bacf35c249c8bd9745a492c5ef2db0ac8eb551b88143a5e118`; sdist `9f1bce59010e4a99a846b9f84ebb45191b8c3fafeb98a85dd675c84ddf835499`. Read-only metadata inspection of `$TMPDIR/skrill55-clean-wheel`: `codegraph-voyage-mcp==0.1.0`, `mcp>=1.0,<2`, `starlette>=0.27`, `uvicorn>=0.23`, `codegraph-voyage-mcp = codegraph_voyage_mcp.server:main`; entry-point `--help` succeeded. Existing build/install logs: `$TMPDIR/skrill55-build.log`, `skrill55-wheel-install.log` (installation actually into `skrill55-clean-wheel`), and `skrill55-sdist-install.log`.

#### Seven parent acceptance criteria

1. **PASS — canonical guidance and selection.** Candidate `codegraph-voyage/SKILL.md:10,67-71` covers standalone usage/CLI, interactive companion and separation from hooks; `references/mcp-server.md:3-62` gives install/client/tool details. `/home/delorenj/code/skillex/.agents/skills/codegraph-voyage` resolves to `/home/delorenj/code/skillex/all-skills/codegraph-voyage`, a canonical definition, not a copied skill. **Activation caveat:** the selected main checkout still has older guidance; it does not equal the docs candidate until the docs candidate is landed and the main submodule/selection is refreshed. This review judges the nominated candidate, not a claim that it is already active.
2. **PASS — distributions and official SDK.** `pyproject.toml:1-22` builds wheel/sdist with an official MCP SDK dependency and a console entry point. Inspected exact archive bytes, installed clean-wheel/sdist source, metadata and executed entry point; clean-wheel and sdist protocol suites passed. This does not claim publication.
3. **PASS — disposable standalone project.** `tests/test_protocol.py:59-69,194-250` builds a real CodeGraph DB via `codegraph init`, verifies no `tools/`, exercises installed CLI through MCP and checks the CodeGraph DB hash before/after; sidecar only is created.
4. **PASS — actual protocol and five tools.** `tests/test_protocol.py:110-177,194-250`: initialized official SDK ClientSession over both stdio and local SSE; enumerated five tools and invoked `index`, `search`, `semantic_candidates`, `status`, preview and executed `explore`; assertions check real installed CLI retrieval. Fixture embeddings are local, not live-provider proof.
5. **PASS — explicit paths, error boundaries and source safety.** `server.py:27-135,150-250,263-345` requires `project_path` on every schema and passes explicit `--project` on each command, checks missing data, validates arguments, invokes exec argument arrays without shell or credential arguments, surfaces missing CLI/nonzero return/timeout. `tests/test_server.py:44-198` covers these boundaries; protocol tests verify DB hash unchanged. No claim that arbitrary project paths are an access-control sandbox: SSE must remain localhost or be access-controlled as documented.
6. **PASS — coherent clean-env client setup.** Candidate `references/mcp-server.md:5-62` documents separate CLI/companion environments (both distributions publish a same-named MCP entry point), absolute companion path, CLI and CodeGraph PATH, provider credentials inherited from client environment, JSON stdio and SSE, explicit project path, `codegraph` for non-preview explore, and no old project-local module. `README.md:5-75` is consistent. `codegraph-voyage status --help` and `explore --help` in the installed CLI confirmed documented `--project`, provider/model/dimensions and `--dry-run`; real protocol exercises executed non-preview explore.
7. **PASS — reproducible scoped verification.** Both archive/installed-module correspondence and complete package tests were independently checked; fixture-vs-live limitation is explicit above and in README. No real index, provider service, fleet, source or board was touched. `git status --short` in both candidate worktrees returned empty after the probes. `git show --name-only HEAD^ HEAD` shows package commit touches only its five MCP paths and docs follow-up only the two named docs paths. Broad `origin/main..HEAD` includes old unrelated ancestor differences in both worktrees (including PM scripts); those are not changes from these two candidate commits and should not be merged wholesale. Preserve existing unrelated main state.

#### Finding requiring care, not a candidate failure

The preexisting scratch `$TMPDIR/skrill55-wheel-env` is **stale/contaminated**: its installed `codegraph_voyage_mcp/server.py` SHA-256 was `1c1fae56c29df3b20145e84acc05ee35cc1c5f2862a96828c58b9ea74cc76ce2`, and its `bin/codegraph-voyage-mcp` imports `codegraph_voyage.mcp_server:main` instead of this candidate's server. Running the requested example with that bin gave **2 protocol failures and 25 unit passes**, caused by `ModuleNotFoundError: mcp.server.mcpserver`. This is not evidence against the exact candidate: the independently inspected **clean** wheel installation (`skrill55-clean-wheel`) imports `codegraph_voyage_mcp.server:main`, matches archive/source bytes and passes all 27 tests. Do not cite the stale wheel-env's prior test log as wheel-candidate proof; use the verified clean-wheel command above. The distinct sdist env also matches and passes. No scratch environment was repaired or modified during this review beyond new disposable pytest temp roots.

**Remaining:** land the scoped package and docs commits through normal ownership/integration controls, then confirm the selected skill points at the newly landed definition. A live-provider run is deliberately not required and was not attempted.

### Independent quality and protocol review

Verdict: **PASS with an environment caveat**. No confirmed actionable defect in the repaired owned paths. The clean wheel and sdist installations each pass stdio/SSE protocol fixtures; no live provider or real index was used. Do not use the pre-existing contaminated `skrill55-wheel-env` as evidence of a clean wheel installation.

#### Scope and provenance

- Code: `/home/delorenj/code/skillex/.worktrees/33GOD-35-mcp-standalone`, HEAD `69d917d79750b17342f2033dbefb1ca34046cd28`; reviewed `git diff origin/main -- mcp-servers/codegraph-voyage-mcp/README.md mcp-servers/codegraph-voyage-mcp/pyproject.toml mcp-servers/codegraph-voyage-mcp/src/codegraph_voyage_mcp/server.py mcp-servers/codegraph-voyage-mcp/tests/test_server.py mcp-servers/codegraph-voyage-mcp/tests/test_protocol.py`. The branch has unrelated PM script deletions relative to `origin/main`; those were excluded from this review. Worktree status was clean before and after.
- Docs: `/home/delorenj/code/skillex/all-skills/.worktrees/33GOD-35-mcp-guidance`, HEAD `e70b191026093dbe0db60f5bf97530420a02ce4c`; reviewed `git diff origin/main -- codegraph-voyage/SKILL.md codegraph-voyage/references/mcp-server.md`; worktree clean. Docs correctly distinguish the separately installed CLI, separate environments, explicit project selection, `codegraph` for non-preview explore and fixture-only protocol verification.
- Source `server.py` SHA-256 `739345443c1dbb6ec13038048137cfb9c43c7beb32b0e31458c23c8242ae67f4`; installed sdist and clean-wheel `site-packages/codegraph_voyage_mcp/server.py` both have the same digest. `uv build --out-dir "$TMPDIR/skrill55-quality-dist"` succeeded for wheel and sdist, and the rebuilt wheel's `server.py` has that digest. The installed console script targets `codegraph_voyage_mcp.server:main` in the separate companion environments. The tested CLI binary is `$TMPDIR/skrill55-cli/bin/codegraph-voyage`; `--help` for index/search/status/explore confirms all generated option names (`--project`, `--provider`, `--model`, `--dimensions`, `--file-filter`, `--kind`, `--max-source-lines`, `--top-k`, `--max-files`, `--dry-run`, `--json`).

#### Reproduction and results

From `/home/delorenj/code/skillex/.worktrees/33GOD-35-mcp-standalone/mcp-servers/codegraph-voyage-mcp`, with the existing isolated installations:

```sh
env -u PYTHONPATH CGV_MCP_TEST_BIN=$TMPDIR/skrill55-sdist-env/bin CGV_MCP_TEST_CLI_BIN=$TMPDIR/skrill55-cli/bin $TMPDIR/skrill55-sdist-env/bin/python -m pytest -q -s tests/
env -u PYTHONPATH CGV_MCP_TEST_BIN=$TMPDIR/skrill55-clean-wheel/bin CGV_MCP_TEST_CLI_BIN=$TMPDIR/skrill55-cli/bin $TMPDIR/skrill55-clean-wheel/bin/python -m pytest -q -s tests/
```

**PASS:** each returned `27 passed` (3.29 s and 3.20 s, respectively), zero skips. Each installed companion's stdio and SSE clients listed five tools and successfully invoked `status`, `index`, `search`, `semantic_candidates`, `explore` preview and actual explore with explicit `project_path` on a disposable project without `tools/`. The real separately installed CLI made five localhost OpenRouter-format HTTP fixture requests per transport; this is NOT live embedding quality/provider validation. The source CodeGraph DB SHA-256 remained unchanged; the sidecar DB was created separately. `codegraph explore` was actually run for non-preview calls.

Independent edge probe, run from `/home/delorenj/code/skillex`:

```sh
env -u PYTHONPATH $TMPDIR/skrill55-clean-wheel/bin/python $TMPDIR/skrill55-edge-review.py
```

**PASS:** real installed stdio entrypoint reported MCP `isError` for absent project path, invalid directory, rejected fake provider, boolean `top_k`, and missing-provider subprocess failure (return code); removing the CLI directory from the child `PATH` produced an actionable missing-executable tool error. Disposable source DB bytes unchanged, no `tools/` directory. Probe script resides only in scratch. Unit suite also checks invalid args and simulated timeout kill/reap. Timeout was **not independently verified with a live hung child**: the timeout handler predates this repair (`origin/main` contains the same kill/communicate block), so its cancellation/grandchild edge cases are not attributed to SKRILL-55.

#### Environment failure distinguished from candidate

The originally named `$TMPDIR/skrill55-wheel-env` is **not clean**: it contains both `codegraph-voyage` and `codegraph-voyage-mcp` distributions; its `server.py` digest is `1c1fae56c29df3b20145e84acc05ee35cc1c5f2862a96828c58b9ea74cc76ce2`, not candidate digest. Its `bin/codegraph-voyage-mcp` imports `codegraph_voyage.mcp_server:main`, the CLI distribution's conflicting entry point. Running the same suite against that env yields `2 failed, 25 passed` (stdio `ModuleNotFoundError: mcp.server.mcpserver`, SSE exits 1). This demonstrates the documented same-environment collision, **not a candidate repair failure**. Re-run against `$TMPDIR/skrill55-clean-wheel/bin` as above; there only `codegraph-voyage-mcp` is installed and both protocols pass. Do not replace the clean result with the contaminated one or claim the named env passed.

No application files, commits, boards, providers, or non-disposable indexes were changed. Only scratch probe, build artifacts, and this report were created. Limits: fixture only (not live credentials/provider), no independent live subprocess timeout or client disconnect soak, no assessment of unrelated branch deletions.
