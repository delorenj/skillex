"""Official MCP SDK server for a project-local codegraph-voyage sidecar."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mcp.types as types
from mcp.server import Server

SERVER_NAME = "codegraph-voyage"
DEFAULT_PROVIDER = "fake"
DEFAULT_MODEL = "voyage-code-4"
DEFAULT_DIMENSIONS = 512
DEFAULT_TOP_K = 10
DEFAULT_MAX_FILES = 12

server = Server(SERVER_NAME, version="0.1.0")


def _object_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


PROJECT_PATH = {
    "type": "string",
    "minLength": 1,
    "description": "Absolute or relative path to a project containing .codegraph/codegraph.db",
}
PROVIDER = {"type": "string", "enum": ["fake", "voyage"], "default": DEFAULT_PROVIDER}
MODEL = {"type": "string", "minLength": 1, "default": DEFAULT_MODEL}
DIMENSIONS = {"type": "integer", "minimum": 1, "default": DEFAULT_DIMENSIONS}
QUERY = {"type": "string", "minLength": 1}
TOP_K = {"type": "integer", "minimum": 1, "default": DEFAULT_TOP_K}
FILE_FILTER = {"type": ["string", "null"], "default": None}
KIND = {
    "type": ["string", "null"],
    "default": None,
    "description": "Optional comma-separated CodeGraph node kinds",
}

TOOL_DEFINITIONS = [
    types.Tool(
        name="index",
        description="Build or incrementally update codegraph-voyage symbol embeddings.",
        inputSchema=_object_schema(
            {
                "project_path": PROJECT_PATH,
                "provider": PROVIDER,
                "model": MODEL,
                "dimensions": DIMENSIONS,
                "file_filter": FILE_FILTER,
                "kind": KIND,
                "max_source_lines": {
                    "type": ["integer", "null"],
                    "minimum": 1,
                    "default": None,
                },
            },
            ["project_path"],
        ),
    ),
    types.Tool(
        name="search",
        description="Run hybrid lexical/vector code search and return semantic candidates.",
        inputSchema=_object_schema(
            {
                "project_path": PROJECT_PATH,
                "query": QUERY,
                "provider": PROVIDER,
                "model": MODEL,
                "dimensions": DIMENSIONS,
                "top_k": TOP_K,
                "json": {"type": "boolean", "default": True},
                "file_filter": FILE_FILTER,
                "kind": KIND,
            },
            ["project_path", "query"],
        ),
    ),
    types.Tool(
        name="semantic_candidates",
        description="Alias of search for hybrid semantic candidate retrieval.",
        inputSchema=_object_schema(
            {
                "project_path": PROJECT_PATH,
                "query": QUERY,
                "provider": PROVIDER,
                "model": MODEL,
                "dimensions": DIMENSIONS,
                "top_k": TOP_K,
                "json": {"type": "boolean", "default": True},
                "file_filter": FILE_FILTER,
                "kind": KIND,
            },
            ["project_path", "query"],
        ),
    ),
    types.Tool(
        name="status",
        description="Show human-readable CodeGraph and codegraph-voyage sidecar status.",
        inputSchema=_object_schema({"project_path": PROJECT_PATH}, ["project_path"]),
    ),
    types.Tool(
        name="explore",
        description="Run hybrid retrieval followed by codegraph explore, or preview it.",
        inputSchema=_object_schema(
            {
                "project_path": PROJECT_PATH,
                "query": QUERY,
                "provider": PROVIDER,
                "model": MODEL,
                "dimensions": DIMENSIONS,
                "top_k": TOP_K,
                "max_files": {
                    "type": "integer",
                    "minimum": 1,
                    "default": DEFAULT_MAX_FILES,
                },
                "dry_run": {"type": ["boolean", "null"], "default": None},
            },
            ["project_path", "query"],
        ),
    ),
]


@dataclass(frozen=True)
class CommandResult:
    return_code: int
    stdout: str
    stderr: str


class ToolExecutionError(RuntimeError):
    """An actionable error safe to return through MCP."""


def _safe_text(value: Any, name: str, *, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise ToolExecutionError(f"{name} is required")
        return None
    if not isinstance(value, str):
        raise ToolExecutionError(f"{name} must be a string")
    value = value.strip() if required else value
    if required and not value:
        raise ToolExecutionError(f"{name} must not be empty")
    if "\x00" in value:
        raise ToolExecutionError(f"{name} must not contain NUL bytes")
    if len(value) > 16_384:
        raise ToolExecutionError(f"{name} is too long")
    return value


def _positive_int(value: Any, name: str, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ToolExecutionError(f"{name} must be a positive integer")
    return value


def _project_root(value: Any) -> Path:
    raw = _safe_text(value, "project_path", required=True)
    assert raw is not None
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        raise ToolExecutionError(f"project_path is not a directory: {root}")
    codegraph_db = root / ".codegraph" / "codegraph.db"
    if not codegraph_db.is_file():
        raise ToolExecutionError(
            f"CodeGraph DB not found at {codegraph_db}. Run `codegraph init` or `codegraph sync` first."
        )
    module_dir = root / "tools" / "codegraph_voyage"
    if not module_dir.is_dir():
        raise ToolExecutionError(
            f"codegraph-voyage sidecar not found at {module_dir}; install it in the target project first."
        )
    return root


def _common_arguments(arguments: Mapping[str, Any]) -> list[str]:
    provider = arguments.get("provider", DEFAULT_PROVIDER)
    if provider not in {"fake", "voyage"}:
        raise ToolExecutionError("provider must be 'fake' or 'voyage'")
    model = _safe_text(arguments.get("model", DEFAULT_MODEL), "model", required=True)
    dimensions = _positive_int(arguments.get("dimensions"), "dimensions", DEFAULT_DIMENSIONS)
    return [
        "--provider",
        str(provider),
        "--model",
        str(model),
        "--dimensions",
        str(dimensions),
    ]


def _optional_flag(command: list[str], flag: str, value: Any, name: str) -> None:
    safe = _safe_text(value, name)
    if safe is not None:
        command.extend([flag, safe])


async def _run_command(root: Path, command: list[str], *, timeout: float = 600.0) -> CommandResult:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(root)
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(root),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=timeout
            )
        except TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise ToolExecutionError(
                f"codegraph-voyage timed out after {timeout:.0f}s; subprocess was terminated"
            ) from exc
    except FileNotFoundError as exc:
        raise ToolExecutionError("python3 executable was not found on the MCP server PATH") from exc

    if process.returncode is None:
        raise ToolExecutionError("codegraph-voyage subprocess ended without a return code")
    result = CommandResult(
        return_code=process.returncode,
        stdout=stdout_bytes.decode("utf-8", errors="replace").strip(),
        stderr=stderr_bytes.decode("utf-8", errors="replace").strip(),
    )
    if result.return_code != 0:
        detail = result.stderr or result.stdout or "no subprocess output"
        raise ToolExecutionError(
            f"codegraph-voyage failed with return code {result.return_code}: {detail}"
        )
    return result


def _parse_json(stdout: str, command_name: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        excerpt = stdout[:500] if stdout else "<empty stdout>"
        raise ToolExecutionError(
            f"{command_name} succeeded but returned invalid JSON: {exc}. stdout: {excerpt}"
        ) from exc


async def execute_tool(name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a tool request, run the sidecar, and normalize its result."""
    root = _project_root(arguments.get("project_path"))
    command = ["python3", "-m", "tools.codegraph_voyage"]

    if name == "index":
        command.extend(["index", *_common_arguments(arguments)])
        _optional_flag(command, "--file-filter", arguments.get("file_filter"), "file_filter")
        _optional_flag(command, "--kind", arguments.get("kind"), "kind")
        if arguments.get("max_source_lines") is not None:
            command.extend(
                [
                    "--max-source-lines",
                    str(_positive_int(arguments["max_source_lines"], "max_source_lines", 200)),
                ]
            )
        result = await _run_command(root, command)
        return {"stdout": result.stdout, "return_code": result.return_code}

    if name in {"search", "semantic_candidates"}:
        query = _safe_text(arguments.get("query"), "query", required=True)
        command.extend(["search", str(query), *_common_arguments(arguments)])
        command.extend(
            ["--top-k", str(_positive_int(arguments.get("top_k"), "top_k", DEFAULT_TOP_K))]
        )
        _optional_flag(command, "--file-filter", arguments.get("file_filter"), "file_filter")
        _optional_flag(command, "--kind", arguments.get("kind"), "kind")
        wants_json = arguments.get("json", True)
        if not isinstance(wants_json, bool):
            raise ToolExecutionError("json must be a boolean")
        if wants_json:
            command.append("--json")
        result = await _run_command(root, command)
        if wants_json:
            return {"results": _parse_json(result.stdout, name), "return_code": result.return_code}
        return {"stdout": result.stdout, "return_code": result.return_code}

    if name == "status":
        command.append("status")
        result = await _run_command(root, command, timeout=120.0)
        return {"stdout": result.stdout, "return_code": result.return_code}

    if name == "explore":
        query = _safe_text(arguments.get("query"), "query", required=True)
        command.extend(["explore", str(query), *_common_arguments(arguments)])
        command.extend(
            ["--top-k", str(_positive_int(arguments.get("top_k"), "top_k", DEFAULT_TOP_K))]
        )
        command.extend(
            [
                "--max-files",
                str(_positive_int(arguments.get("max_files"), "max_files", DEFAULT_MAX_FILES)),
            ]
        )
        dry_run = arguments.get("dry_run")
        if dry_run is not None and not isinstance(dry_run, bool):
            raise ToolExecutionError("dry_run must be a boolean or null")
        if dry_run:
            command.append("--dry-run")
        result = await _run_command(root, command)
        if dry_run:
            return {"stdout": result.stdout, "return_code": result.return_code}
        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError:
            parsed = {"stdout": result.stdout}
        return {"result": parsed, "return_code": result.return_code}

    raise ToolExecutionError(f"unknown tool: {name}")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return TOOL_DEFINITIONS


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return await execute_tool(name, arguments)


async def run_stdio() -> None:
    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def create_sse_app() -> Any:
    from mcp.server.sse import SseServerTransport
    from starlette.applications import Starlette
    from starlette.responses import Response
    from starlette.routing import Mount, Route

    transport = SseServerTransport("/messages/")

    async def handle_sse(request: Any) -> Response:
        async with transport.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(streams[0], streams[1], server.create_initialization_options())
        return Response()

    return Starlette(
        routes=[
            Route("/sse", endpoint=handle_sse, methods=["GET"]),
            Mount("/messages/", app=transport.handle_post_message),
        ]
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="MCP server for codegraph-voyage")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)

    if args.transport == "stdio":
        asyncio.run(run_stdio())
        return

    import uvicorn

    uvicorn.run(create_sse_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
