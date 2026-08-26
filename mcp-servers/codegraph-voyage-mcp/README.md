# codegraph-voyage-mcp

An MCP server that exposes the `codegraph-voyage` symbol-level semantic retrieval sidecar installed inside a target project.

## Requirements

- Python 3.10+
- A target project containing `.codegraph/codegraph.db`
- The sidecar package at `<project_path>/tools/codegraph_voyage/`

The MCP package depends on the official `mcp` Python SDK. The target sidecar itself remains stdlib-only.

## Install

```bash
cd /path/to/skillex/mcp-servers/codegraph-voyage-mcp
python3 -m pip install -e .
# or
uv pip install -e .
```

For development:

```bash
python3 -m pip install -e '.[test]'
pytest tests/
```

## Stdio transport

```bash
codegraph-voyage-mcp --transport stdio
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "codegraph-voyage": {
      "command": "codegraph-voyage-mcp",
      "args": ["--transport", "stdio"]
    }
  }
}
```

The server inherits `VOYAGE_API_KEY` from its environment. For the Voyage provider, load the variable from your secret manager before starting the server; never pass it as a tool argument.

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

Every tool requires `project_path` (and search/explore also require `query`). Before execution the server verifies `<project_path>/.codegraph/codegraph.db`. It runs argument arrays directly—never through a shell—with `cwd` and `PYTHONPATH` set to the project root. A failed subprocess reports its return code and stderr.

### Privacy

`provider: "fake"` is offline and appropriate for CI. `provider: "voyage"` sends locally sanitized source-derived text to Voyage AI and requires `VOYAGE_API_KEY` in the server environment.
