import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCache, type InstalledLibrary } from "../lib/local-cache.js";
import type { PageRecord } from "../lib/types.js";

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

  function writeLegacyInstalled(entry: {
    namespace: string;
    name: string;
    version: string;
    profile?: "slim" | "full";
    installed_at?: string;
    manifest_checksum?: string | null;
    page_count?: number;
  }) {
    writeFileSync(join(cacheDir, "state", "installed.json"), JSON.stringify({
      libraries: [{
        profile: "full",
        installed_at: "2026-03-15T00:00:00Z",
        manifest_checksum: "sha256:legacy",
        page_count: 1,
        ...entry,
      }],
    }, null, 2));
  }

  function legacyDocsDir(namespace: string, name: string, version: string): string {
    return join(cacheDir, "docs", namespace, name, version);
  }

  describe("directory setup", () => {
    it("creates docs and state directories", () => {
      const { existsSync } = require("node:fs");
      expect(existsSync(join(cacheDir, "docs"))).toBe(true);
      expect(existsSync(join(cacheDir, "state"))).toBe(true);
    });
  });

  describe("manifest operations", () => {
    it("saves and checks manifest", () => {
      cache.saveManifest("nextjs", "15.1.0", { version: "15.1.0" });
      expect(cache.hasManifest("nextjs", "15.1.0")).toBe(true);
      expect(cache.hasManifest("nextjs", "14.0.0")).toBe(false);
    });
  });

  describe("page operations", () => {
    it("saves and reads a page", () => {
      cache.savePage("nextjs", "15.1.0", "getting-started", "# Getting Started\n\nContent here.");
      const content = cache.readPage("nextjs", "15.1.0", "getting-started");
      expect(content).toBe("# Getting Started\n\nContent here.");
    });

    it("saves and reads a nested page UID", () => {
      cache.savePage("nextjs", "15.1.0", "docs/guide/routing", "# Routing");
      const content = cache.readPage("nextjs", "15.1.0", "docs/guide/routing");
      expect(content).toBe("# Routing");
    });

    it("returns null for missing page", () => {
      expect(cache.readPage("nextjs", "15.1.0", "nonexistent")).toBeNull();
    });

    it("counts pages", () => {
      cache.savePage("nextjs", "15.1.0", "page1", "# Page 1");
      cache.savePage("nextjs", "15.1.0", "page2", "# Page 2");
      expect(cache.countPages("nextjs", "15.1.0")).toBe(2);
    });

    it("lists page UIDs", () => {
      cache.savePage("nextjs", "15.1.0", "intro", "# Intro");
      cache.savePage("nextjs", "15.1.0", "api-ref", "# API Ref");
      const uids = cache.listPageUids("nextjs", "15.1.0");
      expect(uids.sort()).toEqual(["api-ref", "intro"]);
    });

    it("counts nested page UIDs from page-index", () => {
      const pageIndex: PageRecord[] = [{
        page_uid: "docs/guide/routing",
        bundle_path: "f00ba4.md",
        path: "guide/routing.md",
        title: "Routing",
        url: "https://example.com/guide/routing",
        checksum: "sha256:routing",
        bytes: 64,
        headings: ["Routing"],
        updated_at: "2026-03-12T00:00:00Z",
      }];

      cache.savePageIndex("nextjs", "15.1.0", pageIndex);
      cache.savePage("nextjs", "15.1.0", "docs/guide/routing", "# Routing");

      expect(cache.countPages("nextjs", "15.1.0")).toBe(1);
      expect(cache.listPageUids("nextjs", "15.1.0")).toEqual(["docs/guide/routing"]);
    });
  });

  describe("page-index operations", () => {
    it("saves page-index", () => {
      const pageIndex = [{ page_uid: "intro", title: "Intro" }];
      cache.savePageIndex("nextjs", "15.1.0", pageIndex);
      // Just verify it doesn't throw — read is done via filesystem
    });

    it("loads page-index records and resolves page metadata by page UID", () => {
      const pageIndex: PageRecord[] = [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 1234,
        headings: ["useRef"],
        updated_at: "2026-03-11T00:00:00Z",
      }];

      cache.savePageIndex("react", "19.2.0", pageIndex);

      expect(cache.loadPageIndex("react", "19.2.0")).toEqual(pageIndex);
      expect(cache.findPageByUid("react", "19.2.0", "pg_use_ref")).toEqual(pageIndex[0]);
    });

    it("resolves page metadata by canonical doc path", () => {
      const pageIndex: PageRecord[] = [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 1234,
        headings: ["useRef"],
        updated_at: "2026-03-11T00:00:00Z",
      }];

      cache.savePageIndex("react", "19.2.0", pageIndex);

      expect(cache.findPageByPath("react", "19.2.0", "reference/react/useRef.md")).toEqual(pageIndex[0]);
      expect(cache.findPageByPath("react", "19.2.0", "/reference/react/useRef")).toEqual(pageIndex[0]);
    });
  });

  describe("remove version", () => {
    it("removes entire version directory", () => {
      cache.savePage("nextjs", "15.1.0", "page1", "content");
      cache.saveManifest("nextjs", "15.1.0", {});
      cache.removeVersion("nextjs", "15.1.0");
      expect(cache.hasManifest("nextjs", "15.1.0")).toBe(false);
      expect(cache.countPages("nextjs", "15.1.0")).toBe(0);
    });
  });

  describe("installed state", () => {
    const lib: InstalledLibrary = {
      slug: "nextjs",
      version: "15.1.0",
      profile: "slim",
      installed_at: "2026-03-09T12:00:00Z",
      manifest_checksum: "abc123",
      page_count: 42,
    };

    it("starts with empty state", () => {
      expect(cache.listInstalled()).toEqual([]);
    });

    it("adds and finds installed library", () => {
      cache.addInstalled(lib);
      const found = cache.findInstalled("nextjs", "15.1.0");
      expect(found).toBeDefined();
      expect(found!.version).toBe("15.1.0");
      expect(found!.profile).toBe("slim");
    });

    it("finds installed by slug without version", () => {
      cache.addInstalled(lib);
      const found = cache.findInstalled("nextjs");
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
      cache.removeInstalled("nextjs", "15.1.0");
      expect(cache.findInstalled("nextjs", "15.1.0")).toBeUndefined();
    });

    it("lists multiple installed libraries", () => {
      cache.addInstalled(lib);
      cache.addInstalled({ ...lib, slug: "rails", version: "8.0.0" });
      expect(cache.listInstalled().length).toBe(2);
    });

    it("normalizes legacy installed.json entries to slug-first libraries", () => {
      writeLegacyInstalled({
        namespace: "laravel",
        name: "docs",
        version: "12.x",
      });

      expect(cache.listInstalled()).toMatchObject([{
        slug: "laravel",
        version: "12.x",
        legacy_namespace: "laravel",
        legacy_name: "docs",
      }]);
      expect(cache.findInstalled("laravel", "12.x")).toMatchObject({
        slug: "laravel",
        version: "12.x",
      });
    });
  });

  describe("legacy 0.1.0 docs layout compatibility", () => {
    it("reads cached docs from docs/<namespace>/<name>/<version>", () => {
      writeLegacyInstalled({
        namespace: "laravel",
        name: "docs",
        version: "12.x",
      });

      const docsDir = legacyDocsDir("laravel", "docs", "12.x");
      mkdirSync(join(docsDir, "pages", "guide"), { recursive: true });

      const pageIndex: PageRecord[] = [{
        page_uid: "guide/routing",
        path: "guide/routing.md",
        title: "Routing",
        url: "https://laravel.com/docs/12.x/routing",
        checksum: "sha256:routing",
        bytes: 42,
        headings: ["Routing"],
        updated_at: "2026-03-15T00:00:00Z",
      }];

      writeFileSync(join(docsDir, "manifest.json"), JSON.stringify({ version: "12.x" }, null, 2));
      writeFileSync(join(docsDir, "page-index.json"), JSON.stringify(pageIndex, null, 2));
      writeFileSync(join(docsDir, "pages", "guide", "routing.md"), "# Routing");

      expect(cache.hasManifest("laravel", "12.x")).toBe(true);
      expect(cache.loadPageIndex("laravel", "12.x")).toEqual(pageIndex);
      expect(cache.readPage("laravel", "12.x", "guide/routing")).toBe("# Routing");
      expect(cache.countPages("laravel", "12.x")).toBe(1);
      expect(cache.listPageUids("laravel", "12.x")).toEqual(["guide/routing"]);
    });

    it("backs up and removes legacy docs directories by slug", () => {
      writeLegacyInstalled({
        namespace: "laravel",
        name: "docs",
        version: "12.x",
      });

      const docsDir = legacyDocsDir("laravel", "docs", "12.x");
      mkdirSync(join(docsDir, "pages"), { recursive: true });
      writeFileSync(join(docsDir, "manifest.json"), JSON.stringify({ version: "12.x" }, null, 2));
      writeFileSync(join(docsDir, "pages", "intro.md"), "# Intro");

      const backupDir = cache.backupVersion("laravel", "12.x");
      expect(backupDir).not.toBeNull();
      expect(cache.hasManifest("laravel", "12.x")).toBe(false);

      cache.restoreVersionFromBackup("laravel", "12.x", backupDir!);
      expect(cache.hasManifest("laravel", "12.x")).toBe(true);
      expect(cache.readPage("laravel", "12.x", "intro")).toBe("# Intro");

      cache.removeVersion("laravel", "12.x");
      expect(cache.hasManifest("laravel", "12.x")).toBe(false);
      expect(cache.readPage("laravel", "12.x", "intro")).toBeNull();
    });
  });
});
