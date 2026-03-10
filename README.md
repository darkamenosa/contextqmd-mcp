# contextqmd-mcp

MCP server for local-first, version-aware library documentation. Install, search, and retrieve docs for any library directly from your AI coding assistant.

## What it does

ContextQMD is an alternative to context7 that keeps documentation local. It downloads doc packages from the [ContextQMD registry](https://github.com/tuyenhx/contextqmd-registry), indexes them with QMD (BM25 + vector + LLM reranking), and serves results through the Model Context Protocol.

## Install

```bash
npm install -g contextqmd-mcp
```

Or run directly with npx:

```bash
npx contextqmd-mcp
```

## MCP Configuration

Add to your MCP client configuration (e.g., Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "contextqmd": {
      "command": "npx",
      "args": ["-y", "contextqmd-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "contextqmd": {
      "command": "contextqmd-mcp"
    }
  }
}
```

### CLI Options

```
--transport <type>  Transport type: stdio (default) or http
--port <number>     HTTP port (default: 3001)
--registry <url>    Registry URL override
--token <token>     API token
--cache-dir <path>  Cache directory override
```

## Available Tools

| Tool | Description |
|------|-------------|
| `resolve_docs_library` | Resolve a library name or alias to a canonical library and version |
| `install_docs` | Install a documentation package (downloads manifest and pages, indexes for search) |
| `update_docs` | Update installed docs to latest version (checksum-aware, respects pins) |
| `search_docs` | Search installed documentation with multiple modes: fts, vector, hybrid, auto |
| `list_installed_docs` | List all locally installed documentation packages |
| `pin_docs_version` | Pin a library to prevent automatic updates |
| `hydrate_missing_page` | Fetch a specific page on demand (for slim installs) |

## Search Modes

- **auto** (default) -- Smart routing: short keyword queries use FTS, longer natural-language queries use vector/hybrid
- **fts** -- BM25 full-text search (fast, keyword-based)
- **vector** -- Semantic vector search (requires embeddings)
- **hybrid** -- Combined BM25 + vector with LLM reranking (best quality, slower)

## Example Workflow

1. Resolve a library: `resolve_docs_library({ name: "nextjs" })`
2. Install its docs: `install_docs({ library: "vercel/nextjs" })`
3. Search: `search_docs({ query: "server components", library: "vercel/nextjs" })`

## Configuration

Config file location: `~/.config/contextqmd/config.json`

```json
{
  "registry_url": "https://contextqmd.com",
  "local_cache_dir": "~/.cache/contextqmd"
}
```

Environment variables:
- `CONTEXTQMD_API_TOKEN` -- API token for authenticated endpoints

## Requirements

- Node.js >= 22.0.0

## License

MIT
