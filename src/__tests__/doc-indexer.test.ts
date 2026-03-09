import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache } from "../lib/local-cache.js";
import { DocIndexer } from "../lib/doc-indexer.js";

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
