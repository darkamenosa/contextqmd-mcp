#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Command } from "commander";
import { loadConfig } from "./lib/config.js";
import { RegistryClient } from "./lib/registry-client.js";

const VERSION = "0.1.0";

function createServer(registryClient: RegistryClient): McpServer {
  const server = new McpServer(
    { name: "ContextQMD", version: VERSION },
    {
      instructions:
        "Local-first docs package system. Install, search, and retrieve version-aware documentation for any library.",
    },
  );

  // Tool 1: resolve_docs_library — calls registry
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
          .describe(
            "Version hint (e.g., 'latest', 'stable', or exact version '16.1.6')",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, version_hint }) => {
      const result = await registryClient.resolve({
        query: name,
        version_hint,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  );

  // Tool 2: install_docs (stub)
  server.registerTool(
    "install_docs",
    {
      title: "Install Docs",
      description:
        "Install documentation package for a library. Downloads the manifest and doc bundle from the registry.",
      inputSchema: {
        library: z
          .string()
          .describe(
            "Library identifier in namespace/name format (e.g., 'vercel/nextjs')",
          ),
        version: z.string().optional().describe("Version to install"),
        mode: z
          .enum(["slim", "full"])
          .optional()
          .describe("Install mode (default: slim)"),
      },
    },
    async ({ library, version, mode }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `[stub] Would install ${library}@${version ?? "latest"} in ${mode ?? "slim"} mode`,
          },
        ],
      };
    },
  );

  // Tool 3: update_docs (stub)
  server.registerTool(
    "update_docs",
    {
      title: "Update Docs",
      description:
        "Update installed documentation to the latest version. Compares manifest checksums to skip no-op updates.",
      inputSchema: {
        library: z
          .string()
          .optional()
          .describe(
            "Library to update in namespace/name format (updates all if omitted)",
          ),
      },
    },
    async ({ library }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `[stub] Would update ${library ?? "all libraries"}`,
          },
        ],
      };
    },
  );

  // Tool 4: search_docs (stub — will wire to QMD in a later task)
  server.registerTool(
    "search_docs",
    {
      title: "Search Docs",
      description:
        "Search installed documentation. Returns a token-bounded context pack from the local QMD index.",
      inputSchema: {
        query: z.string().describe("Search query"),
        library: z
          .string()
          .optional()
          .describe("Filter to specific library (namespace/name)"),
        version: z.string().optional().describe("Filter to specific version"),
        mode: z
          .enum(["auto", "search", "vsearch", "query"])
          .optional()
          .describe("Search mode (default: auto)"),
        max_tokens: z
          .number()
          .optional()
          .describe("Max tokens in response (default: 3000)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, library }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `[stub] Would search "${query}" in ${library ?? "all libraries"}`,
          },
        ],
      };
    },
  );

  // Tool 5: list_installed_docs (stub)
  server.registerTool(
    "list_installed_docs",
    {
      title: "List Installed Docs",
      description:
        "List all locally installed documentation packages with their versions and install modes.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      return {
        content: [
          { type: "text" as const, text: "[stub] No docs installed yet" },
        ],
      };
    },
  );

  // Tool 6: pin_docs_version (stub)
  server.registerTool(
    "pin_docs_version",
    {
      title: "Pin Docs Version",
      description:
        "Pin a library to a specific documentation version, preventing automatic updates.",
      inputSchema: {
        library: z
          .string()
          .describe("Library identifier (namespace/name)"),
        version: z.string().describe("Version to pin to"),
      },
    },
    async ({ library, version }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `[stub] Would pin ${library} to ${version}`,
          },
        ],
      };
    },
  );

  // Tool 7: hydrate_missing_page (stub)
  server.registerTool(
    "hydrate_missing_page",
    {
      title: "Hydrate Missing Page",
      description:
        "Fetch a specific missing page from the registry and add it to the local index. Used when slim install lacks a page needed by search.",
      inputSchema: {
        library: z
          .string()
          .describe("Library identifier (namespace/name)"),
        version: z.string().describe("Version"),
        page_uid: z.string().describe("Page UID to hydrate"),
      },
    },
    async ({ library, version, page_uid }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `[stub] Would hydrate page ${page_uid} from ${library}@${version}`,
          },
        ],
      };
    },
  );

  return server;
}

async function main() {
  const program = new Command();
  program
    .name("contextqmd-mcp")
    .version(VERSION)
    .option(
      "--transport <type>",
      "Transport type (stdio or http)",
      "stdio",
    )
    .option("--port <number>", "HTTP port", "3001")
    .option("--registry <url>", "Registry URL override")
    .option("--token <token>", "API token")
    .parse();

  const opts = program.opts();
  const config = loadConfig();

  const registryUrl = (opts.registry as string | undefined) ?? config.registry_url;
  const token =
    (opts.token as string | undefined) ?? process.env.CONTEXTQMD_API_TOKEN;
  const registryClient = new RegistryClient(registryUrl, token);
  const server = createServer(registryClient);

  if (opts.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`ContextQMD MCP Server v${VERSION} running on stdio`);
  } else {
    // HTTP transport — implement in a later phase
    console.error(
      "HTTP transport not yet implemented. Use --transport stdio",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
