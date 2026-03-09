import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache, type InstalledLibrary } from "../lib/local-cache.js";

describe("LocalCache", () => {
  let cacheDir: string;
  let cache: LocalCache;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-test-"));
    cache = new LocalCache(cacheDir);
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("directory setup", () => {
    it("creates docs and state directories", () => {
      const { existsSync } = require("node:fs");
      expect(existsSync(join(cacheDir, "docs"))).toBe(true);
      expect(existsSync(join(cacheDir, "state"))).toBe(true);
    });
  });

  describe("manifest operations", () => {
    it("saves and checks manifest", () => {
      cache.saveManifest("vercel", "nextjs", "15.1.0", { version: "15.1.0" });
      expect(cache.hasManifest("vercel", "nextjs", "15.1.0")).toBe(true);
      expect(cache.hasManifest("vercel", "nextjs", "14.0.0")).toBe(false);
    });
  });

  describe("page operations", () => {
    it("saves and reads a page", () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "getting-started", "# Getting Started\n\nContent here.");
      const content = cache.readPage("vercel", "nextjs", "15.1.0", "getting-started");
      expect(content).toBe("# Getting Started\n\nContent here.");
    });

    it("returns null for missing page", () => {
      expect(cache.readPage("vercel", "nextjs", "15.1.0", "nonexistent")).toBeNull();
    });

    it("counts pages", () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "page1", "# Page 1");
      cache.savePage("vercel", "nextjs", "15.1.0", "page2", "# Page 2");
      expect(cache.countPages("vercel", "nextjs", "15.1.0")).toBe(2);
    });

    it("lists page UIDs", () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "intro", "# Intro");
      cache.savePage("vercel", "nextjs", "15.1.0", "api-ref", "# API Ref");
      const uids = cache.listPageUids("vercel", "nextjs", "15.1.0");
      expect(uids.sort()).toEqual(["api-ref", "intro"]);
    });
  });

  describe("page-index operations", () => {
    it("saves page-index", () => {
      const pageIndex = [{ page_uid: "intro", title: "Intro" }];
      cache.savePageIndex("vercel", "nextjs", "15.1.0", pageIndex);
      // Just verify it doesn't throw — read is done via filesystem
    });
  });

  describe("remove version", () => {
    it("removes entire version directory", () => {
      cache.savePage("vercel", "nextjs", "15.1.0", "page1", "content");
      cache.saveManifest("vercel", "nextjs", "15.1.0", {});
      cache.removeVersion("vercel", "nextjs", "15.1.0");
      expect(cache.hasManifest("vercel", "nextjs", "15.1.0")).toBe(false);
      expect(cache.countPages("vercel", "nextjs", "15.1.0")).toBe(0);
    });
  });

  describe("installed state", () => {
    const lib: InstalledLibrary = {
      namespace: "vercel",
      name: "nextjs",
      version: "15.1.0",
      profile: "slim",
      installed_at: "2026-03-09T12:00:00Z",
      manifest_checksum: "abc123",
      page_count: 42,
      pinned: false,
    };

    it("starts with empty state", () => {
      expect(cache.listInstalled()).toEqual([]);
    });

    it("adds and finds installed library", () => {
      cache.addInstalled(lib);
      const found = cache.findInstalled("vercel", "nextjs", "15.1.0");
      expect(found).toBeDefined();
      expect(found!.version).toBe("15.1.0");
      expect(found!.profile).toBe("slim");
    });

    it("finds installed by namespace/name without version", () => {
      cache.addInstalled(lib);
      const found = cache.findInstalled("vercel", "nextjs");
      expect(found).toBeDefined();
    });

    it("replaces existing entry on re-add", () => {
      cache.addInstalled(lib);
      cache.addInstalled({ ...lib, page_count: 99 });
      const all = cache.listInstalled();
      expect(all.length).toBe(1);
      expect(all[0].page_count).toBe(99);
    });

    it("removes installed", () => {
      cache.addInstalled(lib);
      cache.removeInstalled("vercel", "nextjs", "15.1.0");
      expect(cache.findInstalled("vercel", "nextjs", "15.1.0")).toBeUndefined();
    });

    it("lists multiple installed libraries", () => {
      cache.addInstalled(lib);
      cache.addInstalled({ ...lib, namespace: "rails", name: "rails", version: "8.0.0" });
      expect(cache.listInstalled().length).toBe(2);
    });
  });
});
