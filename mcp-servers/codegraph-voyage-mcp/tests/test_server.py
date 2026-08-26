from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import mcp.types as types
import pytest
from codegraph_voyage_mcp.server import (
    TOOL_DEFINITIONS,
    execute_tool,
    list_tools,
    server,
)


def make_project(tmp_path):
    (tmp_path / ".codegraph").mkdir()
    (tmp_path / ".codegraph" / "codegraph.db").touch()
    (tmp_path / "tools" / "codegraph_voyage").mkdir(parents=True)
    return tmp_path


@pytest.mark.asyncio
async def test_tool_schemas_and_registration():
    tools = await list_tools()
    assert tools == TOOL_DEFINITIONS
    assert {tool.name for tool in tools} == {
        "index",
        "search",
        "semantic_candidates",
        "status",
        "explore",
    }
    assert types.ListToolsRequest in server.request_handlers
    assert types.CallToolRequest in server.request_handlers

    search = next(tool for tool in tools if tool.name == "search")
    assert search.inputSchema["required"] == ["project_path", "query"]
    assert search.inputSchema["properties"]["top_k"]["default"] == 10
    assert search.inputSchema["properties"]["json"]["default"] is True


@pytest.mark.asyncio
async def test_search_runs_safe_mocked_subprocess_and_parses_json(tmp_path):
    project = make_project(tmp_path)
    process = SimpleNamespace(
        returncode=0,
        communicate=AsyncMock(return_value=(b'[{"name": "AuthService"}]', b"")),
        kill=lambda: None,
    )

    with patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)) as spawn:
        result = await execute_tool(
            "search",
            {
                "project_path": str(project),
                "query": "auth service; echo not-a-shell",
                "provider": "fake",
                "top_k": 3,
            },
        )

    assert result == {"results": [{"name": "AuthService"}], "return_code": 0}
    spawn.assert_awaited_once()
    positional = spawn.await_args.args
    assert positional[:5] == (
        "python3",
        "-m",
        "tools.codegraph_voyage",
        "search",
        "auth service; echo not-a-shell",
    )
    assert "--json" in positional
    assert spawn.await_args.kwargs["cwd"] == str(project.resolve())
    assert spawn.await_args.kwargs["env"]["PYTHONPATH"] == str(project.resolve())
    assert "shell" not in spawn.await_args.kwargs


@pytest.mark.asyncio
async def test_missing_codegraph_db_is_actionable(tmp_path):
    (tmp_path / "tools" / "codegraph_voyage").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="CodeGraph DB not found"):
        await execute_tool("status", {"project_path": str(tmp_path)})


@pytest.mark.asyncio
async def test_nonzero_subprocess_includes_return_code(tmp_path):
    project = make_project(tmp_path)
    process = SimpleNamespace(
        returncode=7,
        communicate=AsyncMock(return_value=(b"", b"provider unavailable")),
        kill=lambda: None,
    )
    with patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)):
        with pytest.raises(RuntimeError, match="return code 7: provider unavailable"):
            await execute_tool("status", {"project_path": str(project)})
