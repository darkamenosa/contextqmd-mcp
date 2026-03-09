#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Command } from "commander";
import { join } from "node:path";
import { loadConfig } from "./lib/config.js";
import { RegistryClient } from "./lib/registry-client.js";
import { LocalCache, type InstalledLibrary } from "./lib/local-cache.js";
import { DocIndexer, type SearchMode } from "./lib/doc-indexer.js";

const VERSION = "0.2.0";

interface ServerDeps {
  registryClient: RegistryClient;
  cache: LocalCache;
  indexer: DocIndexer;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function createServer(deps: ServerDeps): McpServer {
  const { registryClient, cache, indexer } = deps;

  const server = new McpServer(
    { name: "ContextQMD", version: VERSION },
    {
      instructions:
        "Local-first docs package system. Install, search, and retrieve version-aware documentation for any library.",
    },
  );

  // ── Tool 1: resolve_docs_library ──────────────────────────────────
  server.registerTool(
    "resolve_docs_library",
    {
      title: "Resolve Docs Library",
      description:
        "Resolve a library name or alias to a canonical library and version. Call this first to identify the correct library before installing or searching docs.",
      inputSchema: {
        name: z
          .string()
          .describe("Library name or alias (e.g., 'nextjs', 'rails')"),
        version_hint: z
          .string()
          .optional()
          .describe("Version hint (e.g., 'latest', 'stable', or exact version)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, version_hint }) => {
      const result = await registryClient.resolve({ query: name, version_hint });
      return jsonResult(result.data);
    },
  );

  // ── Tool 2: install_docs ──────────────────────────────────────────
  server.registerTool(
    "install_docs",
    {
      title: "Install Docs",
      description:
        "Install documentation package for a library. Downloads the manifest and pages from the registry, then indexes them locally for search.",
      inputSchema: {
        library: z
          .string()
          .describe("Library identifier in namespace/name format (e.g., 'vercel/nextjs')"),
        version: z.string().optional().describe("Version to install (default: library's default)"),
      },
    },
    async ({ library, version }) => {
      const [namespace, name] = library.split("/");
      if (!namespace || !name) {
        return textResult("Error: library must be in namespace/name format (e.g., 'vercel/nextjs')");
      }

      // Resolve version if not specified
      let targetVersion = version;
      if (!targetVersion) {
        const resolved = await registryClient.resolve({ query: library });
        targetVersion = resolved.data.version.version;
      }

      // Check if already installed with same version
      const existing = cache.findInstalled(namespace, name, targetVersion);
      if (existing) {
        return textResult(`${library}@${targetVersion} is already installed (${existing.page_count} pages, ${existing.profile} mode). Use update_docs to refresh.`);
      }

      // Fetch manifest
      const manifest = await registryClient.getManifest(namespace, name, targetVersion);
      cache.saveManifest(namespace, name, targetVersion, manifest.data);

      // Fetch ALL pages from page-index (follows cursor pagination)
      const allPages = await registryClient.getAllPageIndex(namespace, name, targetVersion);
      cache.savePageIndex(namespace, name, targetVersion, allPages);

      // Download each page's content
      let downloadedCount = 0;
      for (const page of allPages) {
        try {
          const pageContent = await registryClient.getPageContent(
            namespace, name, targetVersion, page.page_uid,
          );
          cache.savePage(namespace, name, targetVersion, page.page_uid, pageContent.data.content_md);
          downloadedCount++;
        } catch {
          // Skip pages that fail to download (slim mode may not have all pages)
        }
      }

      // Index into QMD for search
      const indexedCount = await indexer.indexLibraryVersion(namespace, name, targetVersion);

      // Record installation
      const installed: InstalledLibrary = {
        namespace,
        name,
        version: targetVersion,
        profile: "full",
        installed_at: new Date().toISOString(),
        manifest_checksum: manifest.data.provenance?.manifest_checksum ?? null,
        page_count: downloadedCount,
        pinned: false,
      };
      cache.addInstalled(installed);

      return textResult(
        `Installed ${library}@${targetVersion}\n` +
        `  Downloaded: ${downloadedCount}/${allPages.length} pages\n` +
        `  Indexed: ${indexedCount} pages for search`,
      );
    },
  );

  // ── Tool 3: update_docs ───────────────────────────────────────────
  server.registerTool(
    "update_docs",
    {
      title: "Update Docs",
      description:
        "Update installed documentation to the latest version. Compares manifest checksums to skip no-op updates. Skips pinned libraries.",
      inputSchema: {
        library: z
          .string()
          .optional()
          .describe("Library to update in namespace/name format (updates all if omitted)"),
      },
    },
    async ({ library }) => {
      const installed = cache.listInstalled();
      const targets = library
        ? installed.filter(l => `${l.namespace}/${l.name}` === library)
        : installed;

      if (targets.length === 0) {
        return textResult(library
          ? `${library} is not installed. Use install_docs first.`
          : "No documentation packages installed.");
      }

      const results: string[] = [];
      for (const lib of targets) {
        if (lib.pinned) {
          results.push(`${lib.namespace}/${lib.name}@${lib.version}: skipped (pinned)`);
          continue;
        }

        try {
          // Resolve latest version
          const resolved = await registryClient.resolve({ query: `${lib.namespace}/${lib.name}` });
          const latestVersion = resolved.data.version.version;

          if (latestVersion === lib.version) {
            results.push(`${lib.namespace}/${lib.name}@${lib.version}: already up to date`);
            continue;
          }

          // Fetch new manifest and check checksum
          const newManifest = await registryClient.getManifest(lib.namespace, lib.name, latestVersion);
          const newChecksum = newManifest.data.provenance?.manifest_checksum;

          if (newChecksum && newChecksum === lib.manifest_checksum) {
            results.push(`${lib.namespace}/${lib.name}@${lib.version}: checksum unchanged, skipping`);
            continue;
          }

          // ATOMIC UPDATE: download new version FIRST, then remove old.
          // If download fails, clean up partial new-version data and keep old.
          try {
            cache.saveManifest(lib.namespace, lib.name, latestVersion, newManifest.data);
            const allPages = await registryClient.getAllPageIndex(lib.namespace, lib.name, latestVersion);
            cache.savePageIndex(lib.namespace, lib.name, latestVersion, allPages);

            let downloadedCount = 0;
            const failedPages: string[] = [];
            for (const page of allPages) {
              try {
                const pageContent = await registryClient.getPageContent(
                  lib.namespace, lib.name, latestVersion, page.page_uid,
                );
                cache.savePage(lib.namespace, lib.name, latestVersion, page.page_uid, pageContent.data.content_md);
                downloadedCount++;
              } catch {
                failedPages.push(page.page_uid);
              }
            }

            const indexedCount = await indexer.indexLibraryVersion(lib.namespace, lib.name, latestVersion);

            // New version is ready — now remove old version
            indexer.removeLibraryVersion(lib.namespace, lib.name, lib.version);
            cache.removeVersion(lib.namespace, lib.name, lib.version);
            cache.removeInstalled(lib.namespace, lib.name, lib.version);

            cache.addInstalled({
              ...lib,
              version: latestVersion,
              installed_at: new Date().toISOString(),
              manifest_checksum: newChecksum ?? null,
              page_count: downloadedCount,
            });

            let msg = `${lib.namespace}/${lib.name}: ${lib.version} → ${latestVersion} (${downloadedCount} pages, ${indexedCount} indexed)`;
            if (failedPages.length > 0) {
              msg += ` [${failedPages.length} pages failed]`;
            }
            results.push(msg);
          } catch (updateErr) {
            // Clean up partially-written new version data
            cache.removeVersion(lib.namespace, lib.name, latestVersion);
            throw updateErr;
          }
        } catch (err) {
          results.push(`${lib.namespace}/${lib.name}: update failed — ${(err as Error).message}`);
        }
      }

      return textResult(results.join("\n"));
    },
  );

  // ── Tool 4: search_docs ───────────────────────────────────────────
  server.registerTool(
    "search_docs",
    {
      title: "Search Docs",
      description:
        "Search installed documentation. Supports multiple search modes: 'fts' (keyword/BM25), 'vector' (semantic), 'hybrid' (BM25 + vector + reranking), or 'auto' (smart routing based on query). Default: auto.",
      inputSchema: {
        query: z.string().describe("Search query"),
        library: z
          .string()
          .optional()
          .describe("Filter to specific library (namespace/name)"),
        version: z.string().optional().describe("Filter to specific version"),
        max_results: z
          .number()
          .optional()
          .describe("Max results to return (default: 5)"),
        mode: z
          .enum(["fts", "vector", "hybrid", "auto"])
          .optional()
          .describe("Search mode: fts (keyword), vector (semantic), hybrid (combined + reranking), auto (smart routing). Default: auto"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, library, version, max_results, mode }) => {
      const installed = cache.listInstalled();
      if (installed.length === 0) {
        return textResult("No documentation packages installed. Use install_docs first.");
      }

      const results = await indexer.search(query, {
        library,
        version,
        maxResults: max_results ?? 5,
        mode: mode ?? "auto",
      });

      if (results.length === 0) {
        return textResult(`No results found for "${query}"${library ? ` in ${library}` : ""}.`);
      }

      const usedMode = results[0]?.searchMode ?? "fts";
      const modeLabel = mode === "auto" || !mode ? ` [auto→${usedMode}]` : ` [${usedMode}]`;

      const output = results.map((r, i) => {
        const header = `## [${i + 1}] ${r.title} (${r.library})`;
        const meta = `page_uid: ${r.pageUid} | score: ${r.score.toFixed(2)}`;
        const snippet = r.snippet.length > 500
          ? r.snippet.slice(0, 500) + "..."
          : r.snippet;
        return `${header}\n${meta}\n\n${snippet}`;
      });

      return textResult(
        `Search: ${usedMode}${modeLabel} | ${results.length} results\n` +
        `Use hydrate_missing_page with page_uid to fetch full content.\n\n` +
        output.join("\n\n---\n\n"),
      );
    },
  );

  // ── Tool 5: list_installed_docs ───────────────────────────────────
  server.registerTool(
    "list_installed_docs",
    {
      title: "List Installed Docs",
      description:
        "List all locally installed documentation packages with their versions, install modes, and page counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const installed = cache.listInstalled();
      if (installed.length === 0) {
        return textResult("No documentation packages installed. Use install_docs to add some.");
      }

      const lines = installed.map(lib => {
        const pinLabel = lib.pinned ? " [pinned]" : "";
        return `- ${lib.namespace}/${lib.name}@${lib.version} (${lib.profile}, ${lib.page_count} pages)${pinLabel}`;
      });

      return textResult(`Installed documentation packages:\n\n${lines.join("\n")}`);
    },
  );

  // ── Tool 6: pin_docs_version ──────────────────────────────────────
  server.registerTool(
    "pin_docs_version",
    {
      title: "Pin Docs Version",
      description:
        "Pin a library to its current documentation version, preventing automatic updates.",
      inputSchema: {
        library: z
          .string()
          .describe("Library identifier (namespace/name)"),
        pin: z
          .boolean()
          .optional()
          .describe("true to pin, false to unpin (default: true)"),
      },
    },
    async ({ library, pin }) => {
      const shouldPin = pin ?? true;
      const [namespace, name] = library.split("/");
      if (!namespace || !name) {
        return textResult("Error: library must be in namespace/name format");
      }

      const existing = cache.findInstalled(namespace, name);
      if (!existing) {
        return textResult(`${library} is not installed.`);
      }

      cache.addInstalled({ ...existing, pinned: shouldPin });
      return textResult(
        shouldPin
          ? `Pinned ${library}@${existing.version}. It will not be updated automatically.`
          : `Unpinned ${library}@${existing.version}. It will be updated with update_docs.`,
      );
    },
  );

  // ── Tool 7: hydrate_missing_page ──────────────────────────────────
  server.registerTool(
    "hydrate_missing_page",
    {
      title: "Hydrate Missing Page",
      description:
        "Fetch a specific page from the registry and add it to the local index. Used when a slim install lacks a page needed by search.",
      inputSchema: {
        library: z
          .string()
          .describe("Library identifier (namespace/name)"),
        version: z.string().describe("Version"),
        page_uid: z.string().describe("Page UID to hydrate"),
      },
    },
    async ({ library, version, page_uid }) => {
      const [namespace, name] = library.split("/");
      if (!namespace || !name) {
        return textResult("Error: library must be in namespace/name format");
      }

      // Check if page already exists locally
      const existingContent = cache.readPage(namespace, name, version, page_uid);
      if (existingContent) {
        return textResult(`Page ${page_uid} already exists locally for ${library}@${version}.`);
      }

      // Fetch from registry
      const pageContent = await registryClient.getPageContent(namespace, name, version, page_uid);
      cache.savePage(namespace, name, version, page_uid, pageContent.data.content_md);

      // Index into QMD
      await indexer.indexPage(namespace, name, version, page_uid, pageContent.data.content_md);

      // Update page count in installed state
      const existing = cache.findInstalled(namespace, name, version);
      if (existing) {
        cache.addInstalled({
          ...existing,
          page_count: cache.countPages(namespace, name, version),
        });
      }

      return textResult(`Hydrated page ${page_uid} for ${library}@${version}. Now searchable locally.`);
    },
  );

  return server;
}

async function main() {
  const program = new Command();
  program
    .name("contextqmd-mcp")
    .version(VERSION)
    .option("--transport <type>", "Transport type (stdio or http)", "stdio")
    .option("--port <number>", "HTTP port", "3001")
    .option("--registry <url>", "Registry URL override")
    .option("--token <token>", "API token")
    .option("--cache-dir <path>", "Cache directory override")
    .parse();

  const opts = program.opts();
  const config = loadConfig();

  const registryUrl = (opts.registry as string | undefined) ?? config.registry_url;
  const token = (opts.token as string | undefined) ?? process.env.CONTEXTQMD_API_TOKEN;
  const cacheDir = (opts["cache-dir"] as string | undefined) ?? config.local_cache_dir;

  const registryClient = new RegistryClient(registryUrl, token);
  const cache = new LocalCache(cacheDir);
  const indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);

  const server = createServer({ registryClient, cache, indexer });

  if (opts.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`ContextQMD MCP Server v${VERSION} running on stdio`);
  } else {
    console.error("HTTP transport not yet implemented. Use --transport stdio");
    process.exit(1);
  }
}

// Export for testing
export { createServer, type ServerDeps };

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
