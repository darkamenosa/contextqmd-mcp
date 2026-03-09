/**
 * Unit tests for wired MCP tool handlers.
 *
 * Tests the tool logic directly using real LocalCache and DocIndexer
 * instances with temp directories. Registry calls are not tested here
 * (covered by integration tests).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache, type InstalledLibrary } from "../lib/local-cache.js";
import { DocIndexer } from "../lib/doc-indexer.js";

describe("Tool logic", () => {
  let cacheDir: string;
  let cache: LocalCache;
  let indexer: DocIndexer;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-tools-test-"));
    cache = new LocalCache(cacheDir);
    indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);
  });

  afterEach(() => {
    indexer.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("list_installed_docs", () => {
    it("returns empty message when nothing installed", () => {
      const installed = cache.listInstalled();
      expect(installed.length).toBe(0);
    });

    it("returns installed libraries with details", () => {
      cache.addInstalled({
        namespace: "vercel",
        name: "nextjs",
        version: "15.1.0",
        profile: "slim",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: "abc",
        page_count: 42,
        pinned: false,
      });
      cache.addInstalled({
        namespace: "rails",
        name: "rails",
        version: "8.0.0",
        profile: "full",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: "def",
        page_count: 100,
        pinned: true,
      });

      const installed = cache.listInstalled();
      expect(installed.length).toBe(2);
      expect(installed[0].namespace).toBe("vercel");
      expect(installed[1].pinned).toBe(true);
    });
  });

  describe("search_docs (FTS)", () => {
    beforeEach(async () => {
      // Simulate installed library with cached pages
      cache.savePage("vercel", "nextjs", "15.1.0", "app-router", "# App Router\n\nThe App Router is a new routing model in Next.js 13+ that uses React Server Components.");
      cache.savePage("vercel", "nextjs", "15.1.0", "pages-router", "# Pages Router\n\nThe Pages Router is the original routing model in Next.js.");
      cache.savePage("vercel", "nextjs", "15.1.0", "data-fetching", "# Data Fetching\n\nNext.js supports getServerSideProps, getStaticProps, and ISR.");
      await indexer.indexLibraryVersion("vercel", "nextjs", "15.1.0");
      cache.addInstalled({
        namespace: "vercel",
        name: "nextjs",
        version: "15.1.0",
        profile: "slim",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: null,
        page_count: 3,
        pinned: false,
      });
    });

    it("finds docs by keyword search", () => {
      const results = indexer.searchFTS("App Router");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe("App Router");
    });

    it("returns multiple results", () => {
      const results = indexer.searchFTS("router");
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("respects max results limit", () => {
      const results = indexer.searchFTS("Next.js", { maxResults: 1 });
      expect(results.length).toBe(1);
    });

    it("filters by library", () => {
      const results = indexer.searchFTS("router", { library: "vercel/nextjs" });
      expect(results.every(r => r.library === "vercel/nextjs")).toBe(true);
    });
  });

  describe("pin_docs_version", () => {
    it("pins and unpins a library", () => {
      const lib: InstalledLibrary = {
        namespace: "vercel",
        name: "nextjs",
        version: "15.1.0",
        profile: "slim",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: null,
        page_count: 42,
        pinned: false,
      };
      cache.addInstalled(lib);

      // Pin
      const existing = cache.findInstalled("vercel", "nextjs")!;
      cache.addInstalled({ ...existing, pinned: true });
      expect(cache.findInstalled("vercel", "nextjs")!.pinned).toBe(true);

      // Unpin
      const pinned = cache.findInstalled("vercel", "nextjs")!;
      cache.addInstalled({ ...pinned, pinned: false });
      expect(cache.findInstalled("vercel", "nextjs")!.pinned).toBe(false);
    });
  });

  describe("hydrate_missing_page (local part)", () => {
    it("indexes a single page into QMD store", async () => {
      const content = "# API Reference\n\nDetailed API documentation for custom hooks.";
      cache.savePage("vercel", "nextjs", "15.1.0", "api-ref", content);
      await indexer.indexPage("vercel", "nextjs", "15.1.0", "api-ref", content);

      const results = indexer.searchFTS("custom hooks");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageUid).toBe("api-ref");
    });
  });

  describe("install + search end-to-end (local only)", () => {
    it("simulates full install and search flow", async () => {
      // Simulate what install_docs does after downloading pages
      const pages = [
        { uid: "intro", content: "# Introduction\n\nWelcome to the React documentation." },
        { uid: "hooks", content: "# Hooks\n\nuseState lets you add state to function components." },
        { uid: "context", content: "# Context\n\nContext provides a way to pass data through the component tree." },
      ];

      for (const p of pages) {
        cache.savePage("facebook", "react", "19.0.0", p.uid, p.content);
      }

      const indexed = await indexer.indexLibraryVersion("facebook", "react", "19.0.0");
      expect(indexed).toBe(3);

      cache.addInstalled({
        namespace: "facebook",
        name: "react",
        version: "19.0.0",
        profile: "slim",
        installed_at: new Date().toISOString(),
        manifest_checksum: null,
        page_count: 3,
        pinned: false,
      });

      // Search
      const results = indexer.searchFTS("useState");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe("Hooks");

      // List installed
      const installed = cache.listInstalled();
      expect(installed.length).toBe(1);
      expect(installed[0].namespace).toBe("facebook");
    });
  });
});
