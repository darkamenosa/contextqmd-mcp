import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache } from "../lib/local-cache.js";
import { DocIndexer, classifyQuery, type SearchMode } from "../lib/doc-indexer.js";

function createSdkStubIndexer(
  cache: LocalCache,
  storeOverrides: Partial<{
    searchFTS: (query: string, limit: number, collection?: string) => Array<Record<string, unknown>>;
    searchVector: (query: string, options: { collection?: string; limit: number }) => Promise<Array<Record<string, unknown>>>;
    search: (options: { query: string; collection?: string; limit: number }) => Promise<Array<Record<string, unknown>>>;
  }>,
): DocIndexer {
  const store = {
    close: vi.fn(async () => undefined),
    internal: {} as never,
    searchFTS: vi.fn(() => []),
    searchVector: vi.fn(async () => []),
    search: vi.fn(async () => []),
    ...storeOverrides,
  };

  const stubIndexer = Object.create(DocIndexer.prototype) as DocIndexer;
  const state = stubIndexer as unknown as {
    cache: LocalCache;
    storePromise: Promise<typeof store>;
  };
  state.cache = cache;
  state.storePromise = Promise.resolve(store);
  return stubIndexer;
}

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

  afterEach(async () => {
    await indexer.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("indexLibraryVersion", () => {
    it("indexes all pages from cache into QMD store", async () => {
      cache.savePage("nextjs", "15.1.0", "getting-started", "# Getting Started\n\nLearn how to use Next.js for server-side rendering.");
      cache.savePage("nextjs", "15.1.0", "routing", "# Routing\n\nNext.js uses file-based routing.");

      const count = await indexer.indexLibraryVersion("nextjs", "15.1.0");
      expect(count).toBe(2);
    });

    it("skips already indexed pages with same hash", async () => {
      cache.savePage("nextjs", "15.1.0", "intro", "# Intro\n\nContent");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");

      // Re-index same content — should skip
      const count = await indexer.indexLibraryVersion("nextjs", "15.1.0");
      expect(count).toBe(0);
    });

    it("returns 0 for empty library", async () => {
      const count = await indexer.indexLibraryVersion("nextjs", "15.1.0");
      expect(count).toBe(0);
    });

    it("deactivates documents removed from the local cache on reindex", async () => {
      cache.savePage("nextjs", "15.1.0", "getting-started", "# Getting Started\n\nLearn the basics.");
      cache.savePage("nextjs", "15.1.0", "routing", "# Routing\n\nFile-based routing.");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");

      rmSync(join(cache.pagesDir("nextjs", "15.1.0"), "routing.md"));
      const reindexed = await indexer.indexLibraryVersion("nextjs", "15.1.0");

      expect(reindexed).toBe(0);
      const results = await indexer.searchFTS("routing", {
        library: "nextjs",
        version: "15.1.0",
      });
      expect(results).toEqual([]);
    });
  });

  describe("indexPage", () => {
    it("indexes a single page", async () => {
      await indexer.indexPage("nextjs", "15.1.0", "api-ref", "# API Reference\n\nUse `getServerSideProps` for SSR.");
      const results = await indexer.searchFTS("getServerSideProps");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageUid).toBe("api-ref");
    });
  });

  describe("canonical doc_path indexing", () => {
    it("indexes using page-index doc paths while preserving page_uid", async () => {
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 1234,
        headings: ["useRef"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage(
        "react",
        "19.2.0",
        "pg_use_ref",
        "# useRef\n\nuseRef lets you reference a value that's not needed for rendering.",
      );

      await indexer.indexLibraryVersion("react", "19.2.0");

      const results = await indexer.searchFTS("reference a value", {
        library: "react",
        version: "19.2.0",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toBe("react__19.2.0/reference/react/useRef.md");
      expect(results[0].pageUid).toBe("pg_use_ref");
      expect(results[0].title).toBe("useRef");
    });
  });

  describe("searchFTS", () => {
    beforeEach(async () => {
      cache.savePage("nextjs", "15.1.0", "hooks", "# React Hooks\n\nUse useState and useEffect for state management in Next.js.");
      cache.savePage("nextjs", "15.1.0", "routing", "# Routing\n\nFile-based routing with dynamic segments.");
      cache.savePage("rails", "8.0.0", "controllers", "# Controllers\n\nAction controllers handle HTTP requests in Rails.");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");
      await indexer.indexLibraryVersion("rails", "8.0.0");
    });

    it("finds relevant docs by keyword", async () => {
      const results = await indexer.searchFTS("routing");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageUid).toBe("routing");
    });

    it("searches across all libraries", async () => {
      const hooksResults = await indexer.searchFTS("hooks");
      const controllerResults = await indexer.searchFTS("controllers");
      expect(hooksResults.length).toBeGreaterThan(0);
      expect(controllerResults.length).toBeGreaterThan(0);
      // Different libraries
      expect(hooksResults[0].library).toBe("nextjs");
      expect(controllerResults[0].library).toBe("rails");
    });

    it("filters by library when specified", async () => {
      // "routing" exists only in nextjs
      const results = await indexer.searchFTS("routing", { library: "nextjs" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.library === "nextjs")).toBe(true);
    });

    it("returns empty for no matches", async () => {
      const results = await indexer.searchFTS("nonexistent-term-xyz");
      expect(results.length).toBe(0);
    });

    it("includes searchMode field set to fts", async () => {
      const results = await indexer.searchFTS("routing");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].searchMode).toBe("fts");
    });
  });

  describe("query-centered snippets", () => {
    it("returns a snippet around the matched section with line anchors and doc metadata", async () => {
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 2048,
        headings: ["useRef", "Optimize refs"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage(
        "react",
        "19.2.0",
        "pg_use_ref",
        [
          "# useRef",
          "",
          "Introductory material.",
          "",
          "Still introductory.",
          "",
          "## Optimize refs",
          "",
          "You can optimize refs by keeping mutable values in refs instead of state.",
          "That avoids unnecessary re-renders.",
        ].join("\n"),
      );
      await indexer.indexLibraryVersion("react", "19.2.0");

      const results = await indexer.searchFTS("optimize refs", {
        library: "react",
        version: "19.2.0",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("Optimize refs");
      expect(results[0].snippet).not.toContain("Still introductory.");
      expect(results[0].docPath).toBe("reference/react/useRef.md");
      expect(results[0].pageUid).toBe("pg_use_ref");
      expect(results[0].url).toBe("https://react.dev/reference/react/useRef");
      expect(results[0].lineStart).toBeGreaterThan(1);
      expect(results[0].lineEnd).toBeGreaterThanOrEqual(results[0].lineStart);
    });
  });

  describe("search (unified dispatcher)", () => {
    beforeEach(async () => {
      cache.savePage("nextjs", "15.1.0", "hooks", "# React Hooks\n\nUse useState and useEffect for state management in Next.js.");
      cache.savePage("nextjs", "15.1.0", "routing", "# Routing\n\nFile-based routing patterns with dynamic segments.");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");
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

    it("uses fts for cross-library searches even when auto would classify as vector or hybrid", async () => {
      const searchFTSSpy = vi.spyOn(indexer, "searchFTS").mockResolvedValueOnce([
        {
          pageUid: "routing",
          title: "Routing",
          path: "nextjs__15.1.0/routing.md",
          docPath: "routing.md",
          contentMd: "# Routing\n\nFile-based routing patterns with dynamic segments.",
          score: 1,
          snippet: "routing patterns",
          library: "nextjs",
          version: "15.1.0",
          searchMode: "fts",
          lineStart: 1,
          lineEnd: 2,
        },
      ]);

      const results = await indexer.search("how should i use routing patterns with dynamic segments");

      expect(searchFTSSpy).toHaveBeenCalledTimes(1);
      expect(results[0].searchMode).toBe("fts");
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

    it("maps successful QMD vector results through the SDK boundary", async () => {
      const body = [
        "# useRef",
        "",
        "Keep mutable values in refs when they should not trigger rendering.",
        "",
        "## Optimize refs",
        "",
        "Store imperatively updated values in refs to avoid unnecessary re-renders.",
      ].join("\n");
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: body.length,
        headings: ["useRef", "Optimize refs"],
        updated_at: "2026-03-12T00:00:00Z",
      }]);

      const searchVector = vi.fn(async () => [{
        displayPath: "react__19.2.0/reference/react/useRef.md",
        title: "useRef",
        score: 0.91,
        body,
        chunkPos: body.indexOf("Optimize refs"),
      }]);
      const sdkIndexer = createSdkStubIndexer(cache, { searchVector });

      const results = await sdkIndexer.search("optimize refs", {
        library: "react",
        version: "19.2.0",
        mode: "vector",
        maxResults: 3,
      });

      expect(searchVector).toHaveBeenCalledWith("optimize refs", {
        collection: "react__19.2.0",
        limit: 6,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        searchMode: "vector",
        library: "react",
        version: "19.2.0",
        docPath: "reference/react/useRef.md",
        pageUid: "pg_use_ref",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
      });
      expect(results[0].snippet).toContain("Optimize refs");
      expect(results[0].lineStart).toBeGreaterThan(0);
      expect(results[0].lineEnd).toBeGreaterThanOrEqual(results[0].lineStart ?? 0);
    });

    it("maps successful QMD hybrid results through the SDK boundary", async () => {
      const body = [
        "# useRef",
        "",
        "Refs can hold mutable values between renders.",
        "",
        "## Optimize refs",
        "",
        "Use refs for imperative caches and measurements when state would re-render too often.",
      ].join("\n");
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "def456",
        bytes: body.length,
        headings: ["useRef", "Optimize refs"],
        updated_at: "2026-03-12T00:00:00Z",
      }]);

      const search = vi.fn(async () => [{
        displayPath: "react__19.2.0/reference/react/useRef.md",
        title: "useRef",
        score: 0.97,
        body,
        bestChunkPos: body.indexOf("Optimize refs"),
      }]);
      const sdkIndexer = createSdkStubIndexer(cache, { search });

      const query = "how can i optimize the refs on react 19";
      const results = await sdkIndexer.search(query, {
        library: "react",
        version: "19.2.0",
        mode: "hybrid",
        maxResults: 4,
      });

      expect(search).toHaveBeenCalledWith({
        query,
        collection: "react__19.2.0",
        limit: 4,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        searchMode: "hybrid",
        library: "react",
        version: "19.2.0",
        docPath: "reference/react/useRef.md",
        pageUid: "pg_use_ref",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
      });
      expect(results[0].snippet).toContain("Optimize refs");
      expect(results[0].lineStart).toBeGreaterThan(0);
      expect(results[0].lineEnd).toBeGreaterThanOrEqual(results[0].lineStart ?? 0);
    });

    it("respects library and version filters", async () => {
      const results = await indexer.search("routing", {
        library: "nextjs",
        version: "15.1.0",
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.library === "nextjs")).toBe(true);
    });

    it("respects maxResults option", async () => {
      const results = await indexer.search("Next.js", { maxResults: 1 });
      expect(results.length).toBe(1);
    });
  });

  describe("removeLibraryVersion", () => {
    it("removes indexed docs for a version", async () => {
      cache.savePage("nextjs", "15.1.0", "intro", "# Intro\n\nTest content for removal.");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");

      await indexer.removeLibraryVersion("nextjs", "15.1.0");
      const results = await indexer.searchFTS("removal", { library: "nextjs", version: "15.1.0" });
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
