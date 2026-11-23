from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import mcp.types as types
import pytest
from codegraph_voyage_mcp.server import (
    TOOL_DEFINITIONS,
    ToolExecutionError,
    _run_command,
    execute_tool,
    list_tools,
    server,
)


def make_project(tmp_path):
    (tmp_path / ".codegraph").mkdir()
    (tmp_path / ".codegraph" / "codegraph.db").touch()
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
                "provider": "voyage",
                "top_k": 3,
            },
        )

    assert result == {"results": [{"name": "AuthService"}], "return_code": 0}
    spawn.assert_awaited_once()
    positional = spawn.await_args.args
    assert positional[:3] == (
        "codegraph-voyage",
        "search",
        "auth service; echo not-a-shell",
    )
    assert positional[positional.index("--project") + 1] == str(project.resolve())
    assert "--json" in positional
    assert spawn.await_args.kwargs["cwd"] == str(project.resolve())
    assert "env" not in spawn.await_args.kwargs
    assert "shell" not in spawn.await_args.kwargs
    assert "api_key" not in positional


@pytest.mark.asyncio
async def test_missing_codegraph_db_is_actionable(tmp_path):
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


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["index", "search", "semantic_candidates", "explore"])
async def test_fake_provider_is_refused_without_spawning_anything(tmp_path, tool):
    project = make_project(tmp_path)
    arguments = {"project_path": str(project), "provider": "fake"}
    if tool != "index":
        arguments["query"] = "anything"
    with patch("asyncio.create_subprocess_exec", new=AsyncMock()) as spawn:
        with pytest.raises(RuntimeError, match="test-only"):
            await execute_tool(tool, arguments)
    spawn.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_defaults_to_a_real_one(tmp_path):
    project = make_project(tmp_path)
    process = SimpleNamespace(
        returncode=0, communicate=AsyncMock(return_value=(b"ok", b"")), kill=lambda: None
    )
    with patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)) as spawn:
        await execute_tool("status", {"project_path": str(project)})
        await execute_tool("index", {"project_path": str(project)})
    index_call = spawn.await_args_list[-1].args
    assert index_call[index_call.index("--provider") + 1] == "voyage"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["index", "search", "semantic_candidates", "status", "explore"])
async def test_all_tools_accept_standalone_project(tmp_path, name):
    project = make_project(tmp_path)
    args = {"project_path": str(project)}
    if name not in {"index", "status"}:
        args["query"] = "authentication"
    output = b"[]" if name in {"search", "semantic_candidates"} else b"ok"
    process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(output, b"")))
    with patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)) as spawn:
        await execute_tool(name, args)
    command = spawn.await_args.args
    assert command[0] == "codegraph-voyage"
    assert command[command.index("--project") + 1] == str(project)
    assert "tools.codegraph_voyage" not in command


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["index", "search", "semantic_candidates", "status", "explore"])
async def test_missing_project_path_is_rejected_before_spawn(name):
    with patch("asyncio.create_subprocess_exec", new=AsyncMock()) as spawn:
        with pytest.raises(ToolExecutionError, match="project_path is required"):
            await execute_tool(name, {"query": "hello"})
    spawn.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments, message",
    [
        ({"query": ""}, "query must not be empty"),
        ({"query": "ok", "top_k": True}, "top_k must be a positive integer"),
        ({"query": "ok", "json": "yes"}, "json must be a boolean"),
        ({"query": "ok", "model": "a\x00b"}, "model must not contain NUL"),
    ],
)
async def test_invalid_search_arguments_do_not_spawn(tmp_path, arguments, message):
    project = make_project(tmp_path)
    with patch("asyncio.create_subprocess_exec", new=AsyncMock()) as spawn:
        with pytest.raises(ToolExecutionError, match=message):
            await execute_tool("search", {"project_path": str(project), **arguments})
    spawn.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_installed_cli_is_actionable(tmp_path):
    project = make_project(tmp_path)
    with patch("asyncio.create_subprocess_exec", new=AsyncMock(side_effect=FileNotFoundError)):
        with pytest.raises(ToolExecutionError, match="install codegraph-voyage"):
            await execute_tool("status", {"project_path": str(project)})


@pytest.mark.asyncio
async def test_timeout_kills_and_reaps_subprocess(tmp_path):
    project = make_project(tmp_path)
    killed = []
    process = SimpleNamespace(
        returncode=None, communicate=AsyncMock(), kill=lambda: killed.append(True)
    )

    async def timeout(coro, *, timeout):
        coro.close()
        raise TimeoutError

    with (
        patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)),
        patch("asyncio.wait_for", new=timeout),
    ):
        with pytest.raises(
            ToolExecutionError, match="timed out after 0s; subprocess was terminated"
        ):
            await _run_command(project, ["codegraph-voyage", "status"], timeout=0.01)
    assert killed == [True]
    assert process.communicate.await_count == 1
