# codegraph-voyage-mcp

An MCP server for the separately installed `codegraph-voyage` CLI. The target project needs a CodeGraph database but no project-local Python module.

## Requirements

- Python 3.10+
- A target project containing `.codegraph/codegraph.db`
- An installed `codegraph-voyage` console command on the MCP server's `PATH` (install separately, preferably in its own environment: the published `codegraph-voyage` distribution also declares a conflicting `codegraph-voyage-mcp` entry point). `codegraph` is also needed for non-preview `explore` and for initializing an index.

The MCP package depends on the official `mcp` Python SDK. `codegraph-voyage` uses its standalone CLI and creates only its own sidecar database under the project; the CodeGraph source DB is read-only.

## Install

```bash
# From this package directory, build both distributions and install into clean environments.
uv build --out-dir /path/to/dist
uv venv /path/to/mcp-env --python 3.12
uv pip install --python /path/to/mcp-env/bin/python /path/to/dist/codegraph_voyage_mcp-*.whl
uv venv /path/to/cli-env --python 3.12
uv pip install --python /path/to/cli-env/bin/python codegraph-voyage
# Both commands must resolve from PATH; keep the MCP environment before the CLI environment.
export PATH="/path/to/mcp-env/bin:/path/to/cli-env/bin:$PATH"
command -v codegraph-voyage-mcp codegraph-voyage
```

Installing `codegraph-voyage` into the **same** environment as the MCP wheel can overwrite the MCP console script with the CLI distribution's different server. Keep the environments separate and order `PATH` as above. The CLI's provider key is inherited in the environment; no key is passed as a tool parameter. The CLI is not bundled in this wheel.

For development, install `pytest` and `pytest-asyncio` into the MCP environment and run `python -m pytest tests/`. Set `CGV_MCP_TEST_BIN=/path/to/mcp-env/bin` and `CGV_MCP_TEST_CLI_BIN=/path/to/cli-env/bin` to exercise the installed wheel/sdist against a disposable CodeGraph project. Protocol tests invoke real installed CLI code with a localhost OpenRouter-format HTTP provider fixture; they do **not** call a live embeddings provider. They require `codegraph` on `PATH` and verify that the original CodeGraph DB bytes remain unchanged.

## Stdio transport

```bash
codegraph-voyage-mcp --transport stdio
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "codegraph-voyage": {
      "command": "/path/to/mcp-env/bin/codegraph-voyage-mcp",
      "args": ["--transport", "stdio"],
      "env": {"PATH": "/path/to/mcp-env/bin:/path/to/cli-env/bin:/usr/local/bin:/usr/bin:/bin"}
    }
  }
}
```

The server inherits the provider's API key (`VOYAGE_API_KEY`, `OPENROUTER_API_KEY` or `AUTOMATICAI_API_KEY`) from its environment. Load the variable from your secret manager before starting the server; never pass it as a tool argument. Add the installed `codegraph` binary's directory to the `PATH` above when using non-preview `explore`; the CLI may be in a different directory than `/usr/local/bin` or `/usr/bin`.

## SSE transport

```bash
codegraph-voyage-mcp --transport sse --host 127.0.0.1 --port 8765
```

The SSE endpoint is `http://127.0.0.1:8765/sse`, with client messages posted through `/messages/`. Bind to a non-loopback interface only behind appropriate network controls.

## Tools

| Tool | Purpose |
|---|---|
| `index` | Build/update embeddings; supports provider, model, dimensions, file/kind filters, and source-line limits. |
| `search` | Hybrid lexical/vector search; structured JSON is the default. |
| `semantic_candidates` | Alias of `search` with the same schema. |
| `status` | Human-readable CodeGraph and sidecar status. |
| `explore` | Hybrid retrieval followed by `codegraph explore`, or a dry-run preview. |

Every tool requires `project_path` (and search/explore also require `query`). Before execution the server verifies `<project_path>/.codegraph/codegraph.db`. It runs `codegraph-voyage` from the server's `PATH` using argument arrays (never a shell), with `--project` and `cwd` set to the requested project root. The CLI inherits provider credentials from the server environment. A failed subprocess reports its return code and stderr.

### Privacy

The providers are `voyage` (default), `openrouter` and `automaticai`. Each sends locally sanitized source-derived text to a remote embeddings API and needs its key in the server environment. There is deliberately no `fake` provider here: its vectors are hashes of the text, not embeddings, and used to pollute real indexes.
