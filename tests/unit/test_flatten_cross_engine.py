"""PACKS-CONTRACT section 3b: cross-surface conformance.

Section 3b is implemented three times, in two languages and three repos:

    1. this engine            src/skillex/core/loader.py -> resolve_inventory()
    2. the fanout engine      pjangler templates/commonproject/template/.mise/
                              scripts/sync-skills.py -> flatten_pack_inventory()
    3. pjangler TypeScript    src/parity/pack.ts -> expandPackInventory()

Each used to own a private copy of the expected answer for the reference pack,
so all three could be green while disagreeing about it -- and they were: pjangler
capped the expansion at one level and asserted 67 leaves, while the two Python
engines descended and asserted 73. Both suites passed. Neither could see the
other, because no test ever compared one engine's output to another's.

These tests remove that blind spot from THIS side:

- `TestGoldenProjection` pins this engine to the SHARED golden file, which is the
  single place the reference pack's projection is written down. pjangler's suite
  reads the same file. There is no second constant to drift.
- `TestCrossEngineGate` shells pjangler's three-engine gate, so a regression in
  the TypeScript engine or in `sync-skills.py` fails THIS suite too.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from skillex.core.loader import load_pack_standalone, resolve_inventory

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REFERENCE_PACK = REPO_ROOT / "packs" / "hermes-base" / "0.18.2"

# The SSOT projection. Regenerate with:
#   uv run skillex pack inventory packs/hermes-base/0.18.2 --json \
#     > tests/fixtures/flatten-reference-hermes-base-0.18.2.json
# It is byte-for-byte that command's output, so it can never drift from the
# surface that produces it.
GOLDEN = REPO_ROOT / "tests" / "fixtures" / "flatten-reference-hermes-base-0.18.2.json"

# pjangler owns the TypeScript engine and vendors `sync-skills.py`, so its gate
# is the one place all three engines can be run side by side.
PJANGLER_ROOT = Path(os.environ.get("SKILLEX_PJANGLER_REPO", "/home/delorenj/code/33GOD/pjangler"))
CROSS_ENGINE_GATE = PJANGLER_ROOT / "tests" / "pack-flatten-cross-engine-regressions.mjs"


def _golden() -> dict:
    if not GOLDEN.is_file():
        pytest.skip(f"{GOLDEN} not present")
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


@pytest.mark.integration
class TestGoldenProjection:
    """This engine must reproduce the shared golden exactly -- pairs, not counts."""

    def test_engine_matches_the_shared_golden(self) -> None:
        if not REFERENCE_PACK.is_dir():
            pytest.skip(f"{REFERENCE_PACK} not present")
        golden = _golden()
        flat = resolve_inventory(load_pack_standalone(REFERENCE_PACK))

        assert flat.enabled is True
        # Sorted by relpath, matching `skillex pack inventory --json`. Comparing
        # the (name, relpath) PAIRS is the point: an equal count computed from
        # different paths is still a divergence, and a count assertion misses it.
        projected = sorted(
            ({"name": s.name, "relpath": s.relpath} for s in flat.skills),
            key=lambda s: s["relpath"],
        )
        assert projected == golden["skills"]
        assert golden["pack"] == "hermes-base"
        assert golden["version"] == "0.18.2"
        assert golden["flattened"] is True
        assert golden["declared"] == len(load_pack_standalone(REFERENCE_PACK).inventory)

    def test_golden_is_internally_coherent(self) -> None:
        """The fixture itself has to be a legal section 3b projection."""
        golden = _golden()
        names = [skill["name"] for skill in golden["skills"]]
        relpaths = [skill["relpath"] for skill in golden["skills"]]

        # A floor, because every other assertion in both repos is now DERIVED from
        # this file: a truncated or emptied golden would quietly weaken all of them
        # into tautologies instead of failing anything.
        assert len(golden["skills"]) >= 70, "the golden looks truncated"
        assert golden["declared"] == 18
        assert len(set(names)) == len(names), "a pack with duplicate leaf names is ambiguous"
        assert relpaths == sorted(relpaths), "the golden must be sorted by relpath"
        for skill in golden["skills"]:
            # The projected NAME is always the LEAF basename, at any depth.
            assert skill["relpath"].split("/")[-1] == skill["name"]
        # The reference pack is genuinely three deep; a golden that lost that
        # would stop exercising the descent at all.
        assert max(path.count("/") for path in relpaths) == 2

    def test_every_golden_leaf_really_holds_a_skill_md(self) -> None:
        if not REFERENCE_PACK.is_dir():
            pytest.skip(f"{REFERENCE_PACK} not present")
        for skill in _golden()["skills"]:
            leaf = REFERENCE_PACK / skill["relpath"]
            assert (leaf / "SKILL.md").is_file(), skill["relpath"]


@pytest.mark.integration
class TestCrossEngineGate:
    """Run the OTHER two engines and require byte-identical output.

    A constant is not evidence of agreement; only a diff is. This is the check
    that would have caught 67-vs-73 on the day it was introduced.
    """

    def test_all_three_engines_agree(self) -> None:
        if not CROSS_ENGINE_GATE.is_file():
            pytest.skip(f"{CROSS_ENGINE_GATE} not present")
        if shutil.which("node") is None:
            pytest.skip("node not available")
        if not (PJANGLER_ROOT / "dist" / "index.js").is_file():
            pytest.skip("pjangler is not built (npm run build)")

        result = subprocess.run(
            ["node", str(CROSS_ENGINE_GATE)],
            cwd=PJANGLER_ROOT,
            capture_output=True,
            text=True,
            timeout=600,
            # Point the gate back at THIS checkout, so the pack and the golden it
            # compares against are the ones this suite is testing.
            env={**os.environ, "PJ_SKILLEX_REPO": str(REPO_ROOT)},
        )
        assert result.returncode == 0, (
            "PACKS-CONTRACT 3b engines disagree\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
        assert "passed" in result.stdout, result.stdout
