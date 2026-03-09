import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache } from "../lib/local-cache.js";
import { DocIndexer, classifyQuery, type SearchMode } from "../lib/doc-indexer.js";

describe("DocIndexer", () => {
  let cacheDir: string;
  let cache: LocalCache;
  let indexer: DocIndexer;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-idx-test-"));
    cache = new LocalCache(cacheDir);
    const dbPath = join(cacheDir, "index.sqlite");
    indexer = new DocIndexer(dbPath, cache);
  });

  afterEach(() => {
    indexer.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("indexLibraryVersion", () => {
    it("indexes all pages from cache into QMD store", async () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "getting-started", "# Getting Started\n\nLearn how to use Next.js for server-side rendering.");
      cache.savePage("vercel", "nextjs", "15.1.0", "routing", "# Routing\n\nNext.js uses file-based routing.");

      const count = await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");
      expect(count).toBe(2);
    });

    it("skips already indexed pages with same hash", async () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "intro", "# Intro\n\nContent");
      await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");

      // Re-index same content — should skip
      const count = await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");
      expect(count).toBe(0);
    });

    it("returns 0 for empty library", async () => {
      const count = await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");
      expect(count).toBe(0);
    });
  });

  describe("indexPage", () => {
    it("indexes a single page", async () => {
      await indexer.indexPage("vercel", "nextjs", "15.1.0", "api-ref", "# API Reference\n\nUse `getServerSideProps` for SSR.");
      const results = indexer.searchFTS("getServerSideProps");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageUid).toBe("api-ref");
    });
  });

  describe("searchFTS", () => {
    beforeEach(async () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "hooks", "# React Hooks\n\nUse useState and useEffect for state management in Next.js.");
      cache.savePage("vercel", "nextjs", "15.1.0", "routing", "# Routing\n\nFile-based routing with dynamic segments.");
      cache.savePage("rails", "rails", "8.0.0", "controllers", "# Controllers\n\nAction controllers handle HTTP requests in Rails.");
      await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");
      await indexer.indexLibraryVersion("rails", "rails", "8.0.0");
    });

    it("finds relevant docs by keyword", () => {
      const results = indexer.searchFTS("routing");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageUid).toBe("routing");
    });

    it("searches across all libraries", () => {
      const hooksResults = indexer.searchFTS("hooks");
      const controllerResults = indexer.searchFTS("controllers");
      expect(hooksResults.length).toBeGreaterThan(0);
      expect(controllerResults.length).toBeGreaterThan(0);
      // Different libraries
      expect(hooksResults[0].library).toBe("vercel/nextjs");
      expect(controllerResults[0].library).toBe("rails/rails");
    });

    it("filters by library when specified", () => {
      // "routing" exists only in nextjs
      const results = indexer.searchFTS("routing", { library: "vercel/nextjs" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.library === "vercel/nextjs")).toBe(true);
    });

    it("returns empty for no matches", () => {
      const results = indexer.searchFTS("nonexistent-term-xyz");
      expect(results.length).toBe(0);
    });

    it("includes searchMode field set to fts", () => {
      const results = indexer.searchFTS("routing");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].searchMode).toBe("fts");
    });
  });

  describe("search (unified dispatcher)", () => {
    beforeEach(async () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "hooks", "# React Hooks\n\nUse useState and useEffect for state management in Next.js.");
      cache.savePage("vercel", "nextjs", "15.1.0", "routing", "# Routing\n\nFile-based routing with dynamic segments.");
      await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");
    });

    it("uses fts mode for explicit fts request", async () => {
      const results = await indexer.search("routing", { mode: "fts" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].searchMode).toBe("fts");
    });

    it("auto mode routes keyword-like queries to fts", async () => {
      const results = await indexer.search("useState", { mode: "auto" });
      expect(results.length).toBeGreaterThan(0);
      // Short keyword query should route to fts
      expect(results[0].searchMode).toBe("fts");
    });

    it("defaults to auto mode when no mode specified", async () => {
      const results = await indexer.search("routing");
      expect(results.length).toBeGreaterThan(0);
      // Should have a searchMode set
      expect(results[0].searchMode).toBeDefined();
    });

    it("falls back to fts when vector mode returns empty (no embeddings)", async () => {
      // No embeddings indexed, so vector should fall back to fts
      const results = await indexer.search("routing", { mode: "vector" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].searchMode).toBe("fts");
    });

    it("hybrid mode falls back to fts when LLM is unavailable or slow", async () => {
      // hybridQuery may time out loading the LLM model in test environments.
      // The DocIndexer has a 10s timeout and falls back to FTS.
      const results = await indexer.search("routing", { mode: "hybrid" });
      expect(results.length).toBeGreaterThan(0);
      // Either hybrid succeeded (BM25 probe) or fell back to fts
      expect(["hybrid", "fts"]).toContain(results[0].searchMode);
    }, 20000);

    it("respects library and version filters", async () => {
      const results = await indexer.search("routing", {
        library: "vercel/nextjs",
        version: "15.1.0",
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.library === "vercel/nextjs")).toBe(true);
    });

    it("respects maxResults option", async () => {
      const results = await indexer.search("Next.js", { maxResults: 1 });
      expect(results.length).toBe(1);
    });
  });

  describe("removeLibraryVersion", () => {
    it("removes indexed docs for a version", async () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "intro", "# Intro\n\nTest content for removal.");
      await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");

      indexer.removeLibraryVersion("vercel", "nextjs", "15.1.0");
      const results = indexer.searchFTS("removal", { library: "vercel/nextjs", version: "15.1.0" });
      expect(results.length).toBe(0);
    });
  });
});

describe("classifyQuery", () => {
  it("routes short keyword queries to fts", () => {
    expect(classifyQuery("useState")).toBe("fts");
    expect(classifyQuery("routing")).toBe("fts");
    expect(classifyQuery("App Router")).toBe("fts");
  });

  it("routes camelCase/snake_case to fts", () => {
    expect(classifyQuery("getServerSideProps usage")).toBe("fts");
    expect(classifyQuery("active_record_base connection")).toBe("fts");
  });

  it("routes dot notation config keys to fts", () => {
    expect(classifyQuery("next.config.js settings")).toBe("fts");
    expect(classifyQuery("server.port.default configuration")).toBe("fts");
  });

  it("routes backticked code to fts", () => {
    expect(classifyQuery("`useEffect` cleanup function")).toBe("fts");
  });

  it("routes error messages to fts", () => {
    expect(classifyQuery("error: Cannot find module react")).toBe("fts");
  });

  it("routes how-to questions to vector", () => {
    expect(classifyQuery("how to optimize performance")).toBe("vector");
  });

  it("routes conceptual queries to vector", () => {
    expect(classifyQuery("what is server-side rendering")).toBe("vector");
    expect(classifyQuery("best practice for state management")).toBe("vector");
    expect(classifyQuery("difference between SSR and CSR")).toBe("vector");
  });

  it("routes long conceptual queries to hybrid", () => {
    expect(classifyQuery("how to implement authentication with JWT tokens in a Next.js application")).toBe("hybrid");
  });

  it("routes long multi-aspect queries to hybrid", () => {
    expect(classifyQuery("server components data fetching caching optimization patterns for large applications with authentication")).toBe("hybrid");
  });

  it("routes API method names to fts", () => {
    expect(classifyQuery("getStaticPaths dynamic routes")).toBe("fts");
    expect(classifyQuery("useCallback memoization reference")).toBe("fts");
  });

  it("defaults unknown patterns to fts", () => {
    expect(classifyQuery("deployment")).toBe("fts");
    expect(classifyQuery("middleware")).toBe("fts");
  });
});
