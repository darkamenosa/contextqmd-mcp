/**
 * End-to-end integration test: install docs from registry → search locally.
 *
 * Requires the registry to be running at localhost:3000 with seed data.
 * Skip with SKIP_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegistryClient } from "../lib/registry-client.js";
import { LocalCache, type InstalledLibrary } from "../lib/local-cache.js";
import { DocIndexer } from "../lib/doc-indexer.js";

const REGISTRY_URL = "http://localhost:3000";
const skipIntegration = process.env.SKIP_INTEGRATION === "1";

describe.skipIf(skipIntegration)("E2E: Install → Search", () => {
  let client: RegistryClient;
  let cache: LocalCache;
  let indexer: DocIndexer;
  let cacheDir: string;

  beforeAll(async () => {
    client = new RegistryClient(REGISTRY_URL);
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-e2e-"));
    cache = new LocalCache(cacheDir);
    indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);

    // Verify registry is available
    try {
      await client.health();
    } catch {
      throw new Error("Registry not running at " + REGISTRY_URL);
    }
  });

  afterAll(() => {
    indexer?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  it("installs Next.js docs and searches them", async () => {
    // Step 1: Resolve library
    const resolved = await client.resolve({ query: "nextjs" });
    expect(resolved.data.library.namespace).toBe("vercel");
    expect(resolved.data.library.name).toBe("nextjs");
    const version = resolved.data.version.version;

    // Step 2: Fetch manifest
    const manifest = await client.getManifest("vercel", "nextjs", version);
    cache.saveManifest("vercel", "nextjs", version, manifest.data);
    expect(cache.hasManifest("vercel", "nextjs", version)).toBe(true);

    // Step 3: Fetch page index
    const pageIndex = await client.getPageIndex("vercel", "nextjs", version);
    expect(pageIndex.data.length).toBeGreaterThan(0);
    cache.savePageIndex("vercel", "nextjs", version, pageIndex.data);

    // Step 4: Download pages
    let downloadedCount = 0;
    for (const page of pageIndex.data) {
      const pageContent = await client.getPageContent("vercel", "nextjs", version, page.page_uid);
      expect(pageContent.data.content_md).toBeTruthy();
      cache.savePage("vercel", "nextjs", version, page.page_uid, pageContent.data.content_md);
      downloadedCount++;
    }
    expect(downloadedCount).toBe(pageIndex.data.length);

    // Step 5: Index into QMD
    const indexedCount = await indexer.indexLibraryVersion("vercel", "nextjs", version);
    expect(indexedCount).toBe(downloadedCount);

    // Step 6: Record installation
    const installed: InstalledLibrary = {
      namespace: "vercel",
      name: "nextjs",
      version,
      profile: "slim",
      installed_at: new Date().toISOString(),
      manifest_checksum: null,
      page_count: downloadedCount,
      pinned: false,
    };
    cache.addInstalled(installed);

    // Step 7: Search!
    const routingResults = indexer.searchFTS("routing");
    expect(routingResults.length).toBeGreaterThan(0);
    expect(routingResults[0].title).toBe("Routing");
    expect(routingResults[0].library).toBe("vercel/nextjs");

    const fetchResults = indexer.searchFTS("fetch data server");
    expect(fetchResults.length).toBeGreaterThan(0);

    const cachingResults = indexer.searchFTS("caching memoization");
    expect(cachingResults.length).toBeGreaterThan(0);

    // Verify list installed
    const allInstalled = cache.listInstalled();
    expect(allInstalled.length).toBe(1);
    expect(allInstalled[0].namespace).toBe("vercel");
    expect(allInstalled[0].page_count).toBe(downloadedCount);
  });

  it("installs Rails docs alongside Next.js", async () => {
    // Install Rails
    const resolved = await client.resolve({ query: "rails" });
    const version = resolved.data.version.version;

    const pageIndex = await client.getPageIndex("rails", "rails", version);
    let count = 0;
    for (const page of pageIndex.data) {
      const content = await client.getPageContent("rails", "rails", version, page.page_uid);
      cache.savePage("rails", "rails", version, page.page_uid, content.data.content_md);
      count++;
    }

    await indexer.indexLibraryVersion("rails", "rails", version);
    cache.addInstalled({
      namespace: "rails",
      name: "rails",
      version,
      profile: "slim",
      installed_at: new Date().toISOString(),
      manifest_checksum: null,
      page_count: count,
      pinned: false,
    });

    // Search across both libraries
    const routingResults = indexer.searchFTS("routing");
    expect(routingResults.some(r => r.library === "vercel/nextjs")).toBe(true);

    const railsResults = indexer.searchFTS("Active Record");
    expect(railsResults.length).toBeGreaterThan(0);
    expect(railsResults[0].library).toBe("rails/rails");

    // List shows both
    const allInstalled = cache.listInstalled();
    expect(allInstalled.length).toBe(2);
  });

  it("hydrates a single page on demand", async () => {
    const resolved = await client.resolve({ query: "react" });
    const version = resolved.data.version.version;

    // Fetch just one page
    const pageContent = await client.getPageContent("facebook", "react", version, "pg_react_hooks");
    cache.savePage("facebook", "react", version, "pg_react_hooks", pageContent.data.content_md);
    await indexer.indexPage("facebook", "react", version, "pg_react_hooks", pageContent.data.content_md);

    // Search finds it
    const results = indexer.searchFTS("useState");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("React Hooks");
  });
});
