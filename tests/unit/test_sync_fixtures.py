"""Smoke test for the sync fixture builders in tests/conftest.py.

Pins the ``sets/min-global`` shape in miniature: symlink members alongside a real
``.system/`` directory holding nested skills and a ``.lastagent`` file. The live
set has 36 members and 42 entries; the six-entry difference is
``EXCLUDED_PREFIXES``, and that is exactly what this asserts.
"""

from __future__ import annotations

from pathlib import Path

from skillex.core.compositions import walk_composition
from skillex.core.diagnostics import Reporter
from tests.conftest import Sandbox


def test_hidden_entries_are_not_members(
    sandbox: Sandbox,
    registry: Path,
    write_catalog,
    write_set,
) -> None:
    catalog = write_catalog(registry, "hindsight", "momo", "pjangler")

    set_dir = write_set(
        registry,
        "min-global",
        [
            ("link", "hindsight", catalog["hindsight"]),
            ("link", "momo", catalog["momo"]),
            ("link", "pjangler", catalog["pjangler"]),
            ("container", ".system", ["codex-a", "codex-b"]),
            ("file", ".lastagent", "claude\n"),
        ],
    )

    reporter = Reporter()
    members = walk_composition(set_dir, reporter, label="set 'min-global'")

    assert [m.name for m in members] == ["hindsight", "momo", "pjangler"]
    assert [m.target for m in members] == [
        catalog["hindsight"],
        catalog["momo"],
        catalog["pjangler"],
    ]
    assert not reporter.findings
    # The excluded entries really are on disk - they are skipped, not absent.
    assert (set_dir / ".system" / "codex-a" / "SKILL.md").is_file()
    assert (set_dir / ".lastagent").is_file()
    # The sandbox is hermetic: nothing points at the real home.
    assert Path.home() == sandbox.home
