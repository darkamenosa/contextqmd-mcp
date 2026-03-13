# contextqmd-mcp

MCP server for local-first, version-aware library documentation. Install, search, and retrieve docs for any library directly from your AI coding assistant.

## What it does

ContextQMD is an alternative to context7 that keeps documentation local. It downloads doc packages from the [ContextQMD registry](https://github.com/darkamenosa/contextqmd-registry), indexes them with QMD (BM25 + vector + LLM reranking), and serves results through the Model Context Protocol.

Install flow is bundle-first:

1. search the library catalog and choose a library/version
2. fetch manifest
3. download a `tar.gz` docs bundle when available
4. verify checksum and unpack into the local cache
5. index with QMD
6. search locally

If a compatible bundle is missing, MCP falls back to `page-index` plus per-page fetches.

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
| `search_libraries` | Search the remote library catalog and return candidates, versions, source metadata, and local install status |
| `install_docs` | Install or refresh a documentation package idempotently |
| `update_docs` | Update installed docs to latest version or refresh same-version checksum changes |
| `search_docs` | Search installed documentation locally only and return page-level markdown content |
| `get_doc` | Read a bounded slice from a locally installed page by `doc_path` or `page_uid` |
| `list_installed_docs` | List all locally installed documentation packages |
| `remove_docs` | Remove an installed documentation version or all installed versions for a library |

## Search Modes

- **auto** (default) -- Smart routing: short keyword queries use FTS, longer natural-language queries use vector/hybrid
- **fts** -- BM25 full-text search (fast, keyword-based)
- **vector** -- Semantic vector search (requires embeddings)
- **hybrid** -- Combined BM25 + vector with LLM reranking (best quality, slower)

## Search Results

`search_docs` returns local page-level results. Each result includes:

- `doc_path`
- `page_uid`
- `title`
- `content_md`
- `score`
- `snippet`
- `line_start`
- `line_end`
- `search_mode`

Typical agent flow:

1. Discover candidate libraries:
   `search_libraries({ query: "react refs" })`
2. Install the exact docs package:
   `install_docs({ library: "facebook/react", version: "19.2.0" })`
3. Search the local index:
   `search_docs({ query: "how can i optimize refs", library: "facebook/react", version: "19.2.0" })`
4. Read a bounded excerpt from the best result when needed:
   `get_doc({ library: "facebook/react", version: "19.2.0", doc_path: "reference/react/useRef.md", from_line: 40, max_lines: 30 })`

`search_docs` is local-only. If you pass `library`/`version` and that package is not installed, it returns `NOT_INSTALLED` instead of silently fetching from the network.

`install_docs` is idempotent. If the same library/version is already installed with the same manifest checksum, it is a no-op. If the checksum changed for the same version, it reinstalls in place.

## Upgrade Note

Older installed libraries may still have legacy `page_uid.md` paths in the local QMD index. The server now lazily rebuilds those indexes on first search. If that lazy rebuild is interrupted, rerun `update_docs` or reinstall the affected library version.

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
