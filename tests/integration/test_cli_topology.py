from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from skillex.cli import app

runner = CliRunner()


def test_topology_json_remains_parseable_when_report_fails(tmp_path: Path) -> None:
    (tmp_path / "all-skills").mkdir()
    (tmp_path / "skill-sets").mkdir()
    pack = tmp_path / "packs" / "broken"
    pack.mkdir(parents=True)
    (pack / "pack.toml").write_text(
        '[pack]\nname = "broken"\n\n[freeform]\nskills = ["missing"]\n',
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        ["topology", "check", "--root", str(tmp_path), "--sources-only", "--json"],
    )

    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert payload["errors"] == 1
    assert payload["findings"][0]["code"] == "PACK_REFERENCE_MISSING"
