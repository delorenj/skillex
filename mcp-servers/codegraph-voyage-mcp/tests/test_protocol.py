from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import subprocess
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import ClassVar

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client


class EmbeddingsHandler(BaseHTTPRequestHandler):
    calls: ClassVar[list[dict]] = []

    def do_POST(self):
        if self.path != "/embeddings":
            self.send_error(404)
            return
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.calls.append(payload)
        assert self.headers["Authorization"] == "Bearer disposable-fixture-key"
        vectors = [[1.0, 0.0, 0.0, 0.0] for _ in payload["input"]]
        body = json.dumps(
            {"data": [{"index": i, "embedding": v} for i, v in enumerate(vectors)]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


@contextmanager
def provider_fixture():
    EmbeddingsHandler.calls = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), EmbeddingsHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/embeddings"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def project(tmp_path):
    source = tmp_path / "src" / "auth.py"
    source.parent.mkdir()
    source.write_text("def authenticate(user):\n    return user == 'alice'\n")
    directory = tmp_path / ".codegraph"
    subprocess.run(["codegraph", "init", str(tmp_path)], check=True, capture_output=True, text=True)
    db = directory / "codegraph.db"
    assert db.is_file()
    assert not (tmp_path / "tools").exists()
    return tmp_path


@pytest.fixture
def installed_bins():
    prefix = os.environ.get("CGV_MCP_TEST_BIN")
    cli_prefix = os.environ.get("CGV_MCP_TEST_CLI_BIN")
    if not prefix or not cli_prefix:
        pytest.skip(
            "set CGV_MCP_TEST_BIN and CGV_MCP_TEST_CLI_BIN to separate installed venv/bin paths"
        )
    assert prefix is not None and cli_prefix is not None
    path = Path(prefix)
    cli = Path(cli_prefix)
    assert (path / "codegraph-voyage-mcp").is_file()
    assert (cli / "codegraph-voyage").is_file()
    return path, cli


def fixture_environment(bins, url):
    mcp_bin, cli_bin = bins
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.update(
        {
            "PATH": str(mcp_bin) + os.pathsep + str(cli_bin) + os.pathsep + env.get("PATH", ""),
            "OPENROUTER_BASE_URL": url,
            "OPENROUTER_API_KEY": "disposable-fixture-key",
        }
    )
    for key in ("VOYAGE_API_KEY", "AUTOMATICAI_API_KEY", "NEWAPI_API_KEY"):
        env.pop(key, None)
    return env


def text(result):
    assert not result.isError, result
    assert result.content
    return json.loads(result.content[0].text)


async def exercise(session, project):
    await asyncio.wait_for(session.initialize(), 15)
    tools = await asyncio.wait_for(session.list_tools(), 15)
    assert {tool.name for tool in tools.tools} == {
        "index",
        "search",
        "semantic_candidates",
        "status",
        "explore",
    }
    assert all("project_path" in tool.inputSchema["required"] for tool in tools.tools)
    args = {"project_path": str(project)}
    status = text(await asyncio.wait_for(session.call_tool("status", args), 20))
    assert "Nodes: 2" in status["stdout"]
    assert "Sidecar: NOT FOUND" in status["stdout"]
    index = text(
        await asyncio.wait_for(
            session.call_tool(
                "index",
                {
                    **args,
                    "provider": "openrouter",
                    "model": "fixture-4",
                    "dimensions": 4,
                },
            ),
            30,
        )
    )
    assert "Total documents: 2" in index["stdout"]
    assert "FAKE" not in index["stdout"]
    assert "fake" not in index["stdout"].lower()
    query = {
        **args,
        "query": "authenticate",
        "provider": "openrouter",
        "model": "fixture-4",
        "dimensions": 4,
    }
    for name in ("search", "semantic_candidates"):
        result = text(await asyncio.wait_for(session.call_tool(name, query), 30))
        assert any(item["name"] == "authenticate" for item in result["results"])
    preview = text(
        await asyncio.wait_for(
            session.call_tool(
                "explore",
                {
                    **query,
                    "dry_run": True,
                },
            ),
            30,
        )
    )
    assert "Explore query" in preview["stdout"] and "authenticate" in preview["stdout"]
    explored = text(await asyncio.wait_for(session.call_tool("explore", query), 35))
    assert "authenticate" in json.dumps(explored)
    status = text(await asyncio.wait_for(session.call_tool("status", args), 20))
    assert "Total embeddings: 2" in status["stdout"]
    return {
        "listed": sorted(t.name for t in tools.tools),
        "status": "2 nodes, 2 embeddings",
        "index": "2 documents",
        "search": "authenticate",
        "semantic_candidates": "authenticate",
        "explore_preview": "authenticate",
        "explore": "authenticate",
    }


async def wait_for_sse(port, process):
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError(f"SSE server exited {process.returncode}")
        try:
            _reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.close()
            await writer.wait_closed()
            return
        except OSError:
            await asyncio.sleep(0.1)
    raise AssertionError("SSE server did not bind localhost")


@pytest.mark.parametrize("transport", ["stdio", "sse"])
@pytest.mark.asyncio
async def test_installed_package_protocol(project, installed_bins, transport):
    db = project / ".codegraph" / "codegraph.db"
    original = hashlib.sha256(db.read_bytes()).hexdigest()
    with provider_fixture() as url:
        env = fixture_environment(installed_bins, url)
        mcp_bin, _ = installed_bins
        if transport == "stdio":
            params = StdioServerParameters(
                command=str(mcp_bin / "codegraph-voyage-mcp"),
                args=["--transport", "stdio"],
                env=env,
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    summary = await exercise(session, project)
        else:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen(
                [
                    str(mcp_bin / "codegraph-voyage-mcp"),
                    "--transport",
                    "sse",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                ],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            try:
                await wait_for_sse(port, process)
                async with sse_client(f"http://127.0.0.1:{port}/sse", timeout=15) as (read, write):
                    async with ClientSession(read, write) as session:
                        summary = await exercise(session, project)
            finally:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
        assert len(EmbeddingsHandler.calls) >= 4
        assert all(call["model"] == "fixture-4" for call in EmbeddingsHandler.calls)
    assert hashlib.sha256(db.read_bytes()).hexdigest() == original
    assert not (project / "tools").exists()
    assert (project / ".codegraph" / "codegraph-voyage.db").is_file()
    print(
        f"PROTOCOL_EVIDENCE {transport}: {json.dumps(summary, sort_keys=True)}; "
        f"provider=localhost HTTP fixture ({len(EmbeddingsHandler.calls)} calls); "
        "real installed CLI; source_db_sha256_unchanged=true"
    )
