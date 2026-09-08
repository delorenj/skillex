# SKRILL-10: Node package foundation

Implemented 2026-09-08 for [CLI Revamp](../plan/cli-revamp.md).
Ticket: [SKRILL-10](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/62db948d-a9c0-4818-b3ac-06605716dd01).

The checkout now builds a publishable `@delorenj/skillex` npm package with a
`skillex` executable and an importable, typed ESM core. The executable supports
help, version, argument errors, and JSON result schema 2. Catalog resolution,
selection changes, sync, and migration remain in the subsequent stories.

## Implementation

- `src/cli.ts` uses Commander and emits either human output or one JSON envelope.
- `src/index.ts` exposes `makeResult`, `ExitCode`, `JSON_SCHEMA_VERSION`, `VERSION`,
  `Diagnostic`, `ResultEnvelope<T>`, and `ResultOptions`. Importing the core does
  not launch the CLI or print output.
- `scripts/build.mjs` emits compiled JavaScript with esbuild and declarations
  with TypeScript. Build output is untracked. The npm file allowlist includes
  only compiled runtime, declarations, schemas, and npm's package metadata/docs.
- `schemas/result.schema.json` defines the schema 2 envelope and documented
  process exits. The package also exports the existing `skills.schema.json`;
  SKRILL-11 owns its manifest-contract changes.
- `mise run check` combines Node checks and the retained Python characterization
  suite. The pre-push hook also requires both. `mise run build` builds Node;
  `mise run python:build` retains the Python package build during migration.
- `.github/workflows/node.yml` runs `npm ci` and `npm run check` on Linux/macOS
  with Node 24 and 26. Hosted execution is reported separately from local proof.

## Acceptance evidence

Local Linux verification:

| Check | Result |
| --- | --- |
| Node 24.15.0 installed-package suite | 21 passed |
| Node 26.5.0 installed-package suite | 21 passed |
| Biome and strict TypeScript | Passed |
| `mise run check` with both implementations | Passed |
| Python characterization suite | 890 passed, 5 skipped because versioned BMAD fixture packs are absent |
| Ruff and mypy | Passed; mypy checked 42 source files |

The package tests create an npm tarball and install it in a temporary consumer.
They execute its installed bin with only Node on PATH; attempts to invoke Python,
Python 3, or uv fail with `ENOENT`. Help, version, invalid arguments, JSON flag
ordering, core exports, and an independent TypeScript consumer are exercised.
Catalog, activation roots, manifests, HOME, and XDG directories are isolated;
their contents, links, modes, and modification times are checked after each CLI
or imported-core invocation. The fixture cleans up its temporary installation.

The test helper supports npm 11's array and npm 12's object form of `npm pack
--json`, so both runtime lines exercise the same artifact assertions.

## Delivery boundary

This ticket does not install a replacement for the operator's live executable,
publish to npm, rewrite activation roots, or delete Python. `uv run skillex`
remains the operational implementation until SKRILL-20 cuts over active
consumers. SKRILL-21 removes the legacy runtime after those consumers are proven.
The next implementation dependency is SKRILL-11, canonical manifest resolution.
