# SKRILL-30 — Deployment evidence (AC5 global activation + AC6 final live smoke)

Actor: skillex-pm deployment verification worker (session 20261017_161701_bd2159)
Date: 2026-10-17 (America/New_York)

## Scope honored

- No source edits, no commits, no pushes. Helper hash re-verified before use:
  `sha256(all-skills/html-artifact-delivery/scripts/publish_html_artifact.py) = f66d42423ce5b05637f764707f0b7dd2c49a259c54f7ed420879c8f48408da7c` (matches parent's reviewed hash).
- No bucket, policy, or infrastructure changes. No Hermes profile config changes. No credential access: the `mc delo` alias was used only through the approved helper; alias/config was never listed or read; no credential values appear in this evidence.
- All scratch artifacts under `$TMPDIR` (`/home/delorenj/.hermes/profiles/skillex-pm/cache/scratch/`); receipt copy at `/tmp/skrill30-ac6-receipt.json`.

## AC5 — Global activation via Skillex

CLI: repo-local Node build `cd ~/code/skillex && node dist/cli.js` (no `skillex` on PATH; `command -v skillex` empty). Help read before use.

1. **Preview (required)** `enable skill html-artifact-delivery -g --dry-run --json` → exit 0, exactly 3 changes:
   - `write-manifest /home/delorenj/.agents/skills.json`
   - `create-link /home/delorenj/.agents/skills/html-artifact-delivery -> /home/delorenj/code/skillex/all-skills/html-artifact-delivery`
   - `write-receipt .../activations/v2/76eb1c23983cccd313658ce0c6ce9dc1a827d45653974d0a52f0d8be71accff4.json`
   No removals, no rewrites. Proceeded.
2. **Apply** same command without `--dry-run` → exit 0, same 3 changes applied; symlink created.
3. **Selection preservation (before vs after manifest):** parsed from pre-apply `status --json` vs current manifest — before 64 skills, after 65; added exactly `['html-artifact-delivery']`; removed `[]`; `packs: ['bmad@6.12.1-next.1']` preserved; no `sets`. All 64 pre-existing selections intact.
4. **Repeat preview convergence** `sync --scope global --dry-run --json` → exit 0, planned managed changes: **0** (converged). Global plan lists 112 composed skills incl. `html-artifact-delivery`; `dryRun: true, applied: []`.
5. **Client discovery:** `status --scope global --json` → exit 0. Actual root entry: `~/.agents/skills/html-artifact-delivery` kind=link, target canonical, reachable=true, ownership=owned. Counts: desired 112 / actual 125 / owned 66 / foreign 59 / missing 0. Receipt state `valid`, pending null. All 8 client aliases reachable and rooted at `~/.agents/skills`: `.claude/skills`, `.codex/skills`, `.gemini/skills`, `.copilot/skills`, `.kimi-code/skills`, `.kimi/skills`, `.openclaw/skills`, `.config/opencode/skills`. Spot check: `~/.claude/skills/html-artifact-delivery/SKILL.md` resolves with canonical frontmatter.
   Note: `status` with auto scope (global+project) exits 3 due to **pre-existing** skillex project-root drift (project manifest `skills: []`, 63 inherited-missing); unrelated to this task, not remediated, global scope alone is clean.

## AC6 — Fresh synthetic live publication

Identity provenance (real, not minted):
- Project slug `skillex` resolved by the helper from `/home/delorenj/code/skillex/.project.json:project_id`.
- Bloodbank session `db31c489-fbe6-5aa0-933e-b775364c3136` passed explicitly via `--bb-session-id`. This is the **documented originating ticket session** (native 20261017_134801_419ca7, live CandyStore event fc1d3fa1-6f77-4ca6-8dfc-b80b3f884723) per SKRILL-30-html-artifact-delivery.md — reused as authorized provenance, not claimed as newly minted. (This worker's own session 20261017_161701_bd2159 maps to 4ca09c83-f132-5b05-a6fd-867fbfdcd699 and was NOT used.)

Bundle: public synthetic `all-skills/html-artifact-delivery/assets/sample-bundle` (index.html + assets/css/style.css + assets/js/app.js + assets/img/badge.svg).

Offline plan (exit 0): `errors: []`, `warnings: []`, `external_resources: []`, `unresolved: []`, `publishable: true`, `delivered: false`, 4 objects.

Publish (exit 0): receipt `mode: publish, ok: true, delivered: true`, 4/4 uploaded, per-object anonymous verification `status: 200`, correct MIME (`text/html`, `text/css`, `text/javascript`, `image/svg+xml`), `sha256_match: true`.

**Exact URLs** (prefix `https://s3.delo.sh/projects/skillex/db31c489-fbe6-5aa0-933e-b775364c3136/ac6-final-smoke/`):
- Entry: https://s3.delo.sh/projects/skillex/db31c489-fbe6-5aa0-933e-b775364c3136/ac6-final-smoke/index.html
- https://s3.delo.sh/projects/skillex/db31c489-fbe6-5aa0-933e-b775364c3136/ac6-final-smoke/assets/css/style.css
- https://s3.delo.sh/projects/skillex/db31c489-fbe6-5aa0-933e-b775364c3136/ac6-final-smoke/assets/js/app.js
- https://s3.delo.sh/projects/skillex/db31c489-fbe6-5aa0-933e-b775364c3136/ac6-final-smoke/assets/img/badge.svg

SHA-256 (plan = verified remote):
- index.html `71c8129b88568e0c33d7ba4f7314952950b585e49fae857e4365360154d7f1a5`
- style.css `e2035397364d825244cdfdc2d296e966d3e788223d63f01b6e7c8e440b5ae84d`
- app.js `52806488678101cb7c2c8c3c8465b931bb5afbfe83d25b27c6f53e43032a2cce`
- badge.svg `886ab8b36201334548a541b913ea56133ec11e136ef93195df154a290db9b0a7`

**Independent re-verification** (worker-side anonymous fetch, `Cache-Control: no-cache`, hashing served bytes against plan hashes): all 4 → HTTP 200 + exact MIME + SHA-256 MATCH. ALL PASS.

Commands:
```
python3 all-skills/html-artifact-delivery/scripts/publish_html_artifact.py \
  --bundle all-skills/html-artifact-delivery/assets/sample-bundle --entry index.html \
  --artifact ac6-final-smoke --project-root "$PWD" \
  --bb-session-id db31c489-fbe6-5aa0-933e-b775364c3136 --publish   # (and without --publish for plan)
```

Collision guard re-check: re-publish to same prefix → exit 3, `failure.kind: collision` (existing_count 4), `delivered: false`, 0 uploads.

Bucket posture unchanged: anonymous bucket listing HTTP 403; nonexistent object HTTP 404; no policy/bucket/infra edits.

Browser smoke (kapture, Chrome tab 876687258, opened then closed):
- Rendered DOM: `<body data-delivery-check="ready">`; CSS `styled`, Image `loaded`, JavaScript `running` (all three markers `class="status ok"`).
- `watch_console` 2000 ms: `logs: []` — no console output or errors.
- Screenshot saved: `$TMPDIR/skrill30-browser.png` (PNG 1920x827).

Receipts: `$TMPDIR/skrill30-plan.json`, `$TMPDIR/skrill30-live-publish.json`, `$TMPDIR/skrill30-collision.json`, copy `/tmp/skrill30-ac6-receipt.json`.

## Unresolved / out of scope

- Credential rotation from the prior security incident remains **unverified/not performed** (no rotation permissions; not claimed).
- Ticket not marked done (parent owns board state).
- Pre-existing skillex project-root status drift and skillex-pm profile strict-sync refusal (unrelated `.bundled_manifest`) untouched, per authorization.
