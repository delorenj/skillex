#!/usr/bin/env bash
# Pre-push gate: Node check, then Python lint/types/tests, strictly one after another and
# under one per-checkout lock. Several agents push from this checkout; two overlapping gates
# share dist/, the Python suite drives dist/cli.js, and the Node build rewrites it, so an
# unserialized pair failed at random. Stop at the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."

lock="$(git rev-parse --git-dir)/skillex-pre-push.lock"
if [ -z "${SKILLEX_PRE_PUSH_LOCKED:-}" ]; then
  export SKILLEX_PRE_PUSH_LOCKED=1
  exec flock -w 3600 "$lock" "$0" "$@"
fi

npm run check
uv run ruff check .
uv run mypy src/skillex
# The conftest tripwire watches the REAL ~/.agents/skills mtime; another agent's legitimate
# global sync during the run trips it for an unrelated test. Rerun only what failed, once: a
# test that really writes the machine fails again, a coincidental writer does not.
uv run pytest -q || uv run pytest -q --lf
