# contextqmd-mcp

MCP server for local-first, version-aware library documentation. Install, search, and retrieve docs for any library directly from your AI coding assistant.

## What it does

ContextQMD is an alternative to context7 that keeps documentation local. It downloads doc packages from the [ContextQMD registry](https://github.com/darkamenosa/contextqmd-registry), indexes them with QMD (BM25 + vector + LLM reranking), and serves results through the Model Context Protocol.

Install flow is bundle-first:

1. search the library catalog and choose a library/version
2. fetch manifest
3. download a `tar.gz` docs bundle when available
4. verify SHA256 checksum and unpack into the local cache
5. index with QMD
6. search locally

If a compatible bundle is missing, the server falls back to `page-index` plus per-page fetches. Installs are atomic with rollback on failure.

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
| `search_libraries` | Search the remote library catalog. Returns candidates with versions, aliases, source metadata, and local install status. |
| `install_docs` | Install a documentation package. Bundle-first with SHA256 verification; falls back to page API. Atomic with rollback. Idempotent — skips if already installed with same manifest checksum. |
| `update_docs` | Update installed docs to latest version or refresh when manifest checksum changes. Rolls back on failure. |
| `search_docs` | Search installed documentation locally. Returns page-level results with snippets, line anchors, and scores. Supports auto/fts/vector/hybrid modes. |
| `get_doc` | Read a bounded slice from a locally installed page by `doc_path` or `page_uid`. Supports sequential reads (`from_line`/`max_lines`) and context windows (`around_line`/`before`/`after`). |
| `list_installed_docs` | List all locally installed documentation packages with metadata. |
| `remove_docs` | Remove an installed documentation version or all versions for a library. Cleans up both cache and search index. |

## Search Modes

`search_docs` supports four modes via the `mode` parameter:

- **auto** (default) — Smart routing based on query classification: short keyword queries use FTS, conceptual/how-to questions use vector, complex multi-aspect queries use hybrid.
- **fts** — BM25 full-text search (fast, keyword-based). Best for API names, function lookups, and code patterns.
- **vector** — Semantic vector search. Best for conceptual questions. Falls back to FTS on timeout.
- **hybrid** — Combined BM25 + vector with LLM reranking (best quality, slower). Falls back to FTS on timeout.

Cross-library searches always use FTS regardless of mode.

## Progressive Retrieval

The server uses a progressive retrieval model — search returns small snippets with line anchors, then `get_doc` allows bounded expansion:

1. Discover candidate libraries:
   `search_libraries({ query: "react refs" })`
2. Install the exact docs package:
   `install_docs({ library: "react", version: "19.2.0" })`
3. Search the local index:
   `search_docs({ query: "how can i optimize refs", library: "react", version: "19.2.0" })`
4. Read a bounded excerpt from the best result:
   `get_doc({ library: "react", version: "19.2.0", doc_path: "reference/react/useRef.md", from_line: 40, max_lines: 30 })`

### search_docs results

Each result includes: `doc_path`, `page_uid`, `title`, `content_md`, `score`, `snippet`, `line_start`, `line_end`, `search_mode`, and `url`.

`search_docs` is local-only. If the library is not installed, it returns a `NOT_INSTALLED` error instead of silently fetching from the network.

### get_doc reading modes

- **Sequential**: `from_line` + `max_lines` (default: line 1, 60 lines)
- **Context window**: `around_line` + `before`/`after` (default: 30 before, 60 after)
- **Line numbers**: set `line_numbers: true` to get line-number-prefixed output

## Upgrade Note

Older installed libraries may still have legacy `page_uid.md` paths in the local QMD index. The server lazily rebuilds those indexes on first search. If the rebuild is interrupted, rerun `update_docs` or reinstall the affected library version.

## Configuration

Config file location: `~/.config/contextqmd/config.json`

```json
{
  "registry_url": "https://contextqmd.com",
  "local_cache_dir": "~/.cache/contextqmd",
  "default_install_mode": "slim",
  "preferred_search_mode": "auto"
}
```

Environment variables:
- `CONTEXTQMD_API_TOKEN` — API token for authenticated endpoints

## Architecture

```
src/
  index.ts              # CLI entry point, MCP server, 7 tool handlers
  lib/
    types.ts            # TypeScript interfaces for the API contract
    config.ts           # Config loader (~/.config/contextqmd/config.json)
    registry-client.ts  # HTTP client for the ContextQMD registry API
    local-cache.ts      # Local filesystem cache manager (atomic installs, page layout)
    doc-indexer.ts      # QMD-backed search indexer (FTS, vector, hybrid, query classifier)
```

Key design patterns:
- **Local-first**: All search is local-only. `search_docs` never touches the network.
- **Bundle-first installs**: Prefers `tar.gz` bundles; falls back to page-by-page API fetches.
- **Atomic installs**: Staged temp directories with backup/restore for safe upgrades.
- **Idempotent operations**: `install_docs` is a no-op when the same version/checksum is already installed.
- **Security**: Bundle extraction validates against path traversal, symlinks, and unsupported entry types.

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm run dev          # watch mode
npm run check        # type-check without emitting
npm test             # run tests (vitest)
npm run test:watch   # watch mode tests
```

Set `SKIP_INTEGRATION=1` to skip integration tests that require a running registry at localhost:3000.

## Requirements

- Node.js >= 22.0.0

## License

MIT
