/**
 * Unit tests for wired MCP tool handlers.
 *
 * Tests the tool logic directly using real LocalCache and DocIndexer
 * instances with temp directories. Registry calls are not tested here
 * (covered by integration tests).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { LocalCache } from "../lib/local-cache.js";
import { DocIndexer } from "../lib/doc-indexer.js";
import {
  handleGetDoc,
  handleInstallDocs,
  isCliEntrypoint,
  handleListInstalledDocs,
  handleRemoveDocs,
  handleSearchLibraries,
  handleSearchDocs,
  handleUpdateDocs,
  type ServerDeps,
} from "../index.js";
import type { Manifest, PageRecord } from "../lib/types.js";

function createBundleArchive({
  manifest,
  pageIndex,
  pages,
}: {
  manifest: Manifest;
  pageIndex: PageRecord[];
  pages: Record<string, string>;
}): Buffer {
  const rootDir = mkdtempSync(join(tmpdir(), "contextqmd-bundle-src-"));
  const archivePath = join(tmpdir(), `contextqmd-bundle-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);

  try {
    mkdirSync(join(rootDir, "pages"), { recursive: true });
    writeFileSync(join(rootDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(rootDir, "page-index.json"), JSON.stringify(pageIndex, null, 2));
    for (const [pageUid, content] of Object.entries(pages)) {
      writeFileSync(join(rootDir, "pages", `${pageUid}.md`), content);
    }

    const result = spawnSync("tar", ["-czf", archivePath, "-C", rootDir, "."], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message ?? result.stderr.trim() ?? "failed to create test bundle");
    }

    return readFileSync(archivePath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
  }
}

describe("Tool logic", () => {
  let cacheDir: string;
  let cache: LocalCache;
  let indexer: DocIndexer;
  let deps: ServerDeps;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-tools-test-"));
    cache = new LocalCache(cacheDir);
    indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);
    deps = {
      cache,
      indexer,
      registryClient: {} as ServerDeps["registryClient"],
    };
  });

  afterEach(async () => {
    await indexer.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("CLI entrypoint detection", () => {
    it("treats a symlinked bin path as the current module entrypoint", () => {
      const entrypointDir = mkdtempSync(join(tmpdir(), "contextqmd-entrypoint-test-"));
      const targetPath = join(entrypointDir, "dist-index.js");
      const symlinkPath = join(entrypointDir, "contextqmd-mcp");

      try {
        writeFileSync(targetPath, "export {};\n");
        symlinkSync(targetPath, symlinkPath);

        expect(isCliEntrypoint(symlinkPath, pathToFileURL(targetPath).href)).toBe(true);
      } finally {
        rmSync(entrypointDir, { recursive: true, force: true });
      }
    });
  });

  describe("list_installed_docs", () => {
    it("returns empty message when nothing installed", () => {
      const result = handleListInstalledDocs(deps);
      expect(result.content[0].text).toContain("No documentation packages installed");
      expect(result.structuredContent).toEqual({ results: [] });
    });

    it("returns installed libraries with details", () => {
      cache.addInstalled({
                slug: "nextjs",
        version: "15.1.0",
        profile: "slim",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: "abc",
        page_count: 42,
        pinned: false,
      });
      cache.addInstalled({
                slug: "rails",
        version: "8.0.0",
        profile: "full",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: "def",
        page_count: 100,
        pinned: true,
      });

      const result = handleListInstalledDocs(deps);
      const installed = result.structuredContent?.results as Array<Record<string, unknown>>;
      expect(installed.length).toBe(2);
      expect(installed[0].library).toBe("nextjs");
      expect(installed[1]).not.toHaveProperty("pinned");
      expect(result.content[0].text).not.toContain("[pinned]");
    });
  });

  describe("search_libraries", () => {
    it("returns catalog candidates with versions and local install status", async () => {
      cache.addInstalled({
                slug: "inertia-rails",
        version: "3.17.0",
        profile: "full",
        installed_at: "2026-03-12T00:00:00Z",
        manifest_checksum: "sha256:installed",
        page_count: 51,
        pinned: false,
      });

      deps.registryClient = {
        searchLibraries: async () => ({
          data: [
            {
                            slug: "inertia-rails",
              display_name: "Inertia Rails",
              aliases: ["inertia rails"],
              homepage_url: "https://inertiajs.com",
              default_version: "3.17.0",
              version_count: 2,
              source_type: "website",
              license_status: "verified",
            },
            {
                            slug: "rails",
              display_name: "Rails",
              aliases: ["rails"],
              homepage_url: "https://rubyonrails.org",
              default_version: "8.0.2",
              version_count: 3,
              source_type: "website",
              license_status: "verified",
            },
          ],
          meta: { cursor: null },
        }),
        getVersions: async (slug: string) => ({
          data: slug === "inertia-rails"
            ? [
              {
                version: "3.17.0",
                channel: "stable",
                generated_at: "2026-03-12T00:00:00Z",
                manifest_checksum: "sha256:a",
              },
              {
                version: "3.16.0",
                channel: "stable",
                generated_at: "2026-03-01T00:00:00Z",
                manifest_checksum: "sha256:b",
              },
            ]
            : [
              {
                version: "8.0.2",
                channel: "stable",
                generated_at: "2026-03-12T00:00:00Z",
                manifest_checksum: "sha256:c",
              },
            ],
          meta: { cursor: null },
        }),
      } as unknown as ServerDeps["registryClient"];

      const result = await handleSearchLibraries(deps, { query: "inertia rails", limit: 2 });
      const matches = result.structuredContent?.results as Array<Record<string, unknown>>;

      expect(matches).toHaveLength(2);
      expect(matches[0]).toMatchObject({
        library: "inertia-rails",
        default_version: "3.17.0",
        source_type: "website",
        license_status: "verified",
        installed: true,
        installed_versions: ["3.17.0"],
        versions: ["3.17.0", "3.16.0"],
      });
      expect(result.content[0].text).toContain("install_docs");
    });
  });

  describe("install_docs", () => {
    it("prefers bundle download and installs into the local cache layout", async () => {
      const pageIndex: PageRecord[] = [{
        page_uid: "guide",
        path: "guides/getting-started.md",
        title: "Getting Started",
        url: "https://example.com/guides/getting-started",
        checksum: "sha256:page",
        bytes: 42,
        headings: ["Getting Started"],
        updated_at: "2026-03-12T00:00:00Z",
      }];
      const manifest: Manifest = {
        schema_version: "1.0",
                slug: "widgets",
        display_name: "Acme Widgets",
        version: "1.2.3",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 1,
        source: null,
        page_index: {
          url: "/api/v1/libraries/acme/widgets/versions/1.2.3/page-index",
          sha256: null,
        },
        profiles: {
          full: {
            bundle: {
              format: "tar.gz",
              url: "/api/v1/libraries/acme/widgets/versions/1.2.3/bundles/full",
              sha256: "",
            },
          },
        },
        source_policy: {
          license_name: "MIT",
          license_status: "verified",
          mirror_allowed: true,
          origin_fetch_allowed: true,
          attribution_required: false,
        },
        provenance: {
          normalizer_version: "2026-03-12",
          splitter_version: "v1",
          manifest_checksum: "sha256:manifest",
        },
      };
      const bundleBytes = createBundleArchive({
        manifest,
        pageIndex,
        pages: {
          guide: "# Getting Started\n\nBundle installs into the local markdown cache.",
        },
      });
      manifest.profiles.full!.bundle!.sha256 = createHash("sha256").update(bundleBytes).digest("hex");

      let pageApiCalls = 0;
      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "widgets",
              display_name: "Acme Widgets",
              aliases: ["widgets"],
              homepage_url: "https://example.com",
              default_version: "1.2.3",
            },
            version: {
              version: "1.2.3",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:manifest",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
        downloadBundle: async () => bundleBytes,
        getAllPageIndex: async () => {
          pageApiCalls++;
          return pageIndex;
        },
        getPageContent: async () => {
          pageApiCalls++;
          throw new Error("page API should not be used when bundle install succeeds");
        },
      } as unknown as ServerDeps["registryClient"];

      const install = await handleInstallDocs(deps, {
        library: "widgets",
        version: "1.2.3",
      });

      expect(install.content[0].text).toContain("Installed from bundle");
      expect(pageApiCalls).toBe(0);
      expect(cache.hasManifest("widgets", "1.2.3")).toBe(true);
      expect(cache.loadPageIndex("widgets", "1.2.3")).toHaveLength(1);
      expect(cache.readPage("widgets", "1.2.3", "guide")).toContain("Bundle installs");

      const search = await handleSearchDocs(deps, {
        query: "local markdown cache",
        library: "widgets",
        version: "1.2.3",
        mode: "fts",
      });
      expect(search.structuredContent?.results[0]).toMatchObject({
        doc_path: "guides/getting-started.md",
        page_uid: "guide",
        content_md: "# Getting Started\n\nBundle installs into the local markdown cache.",
      });
    });

    it("is a no-op when the same library version is already installed with the same manifest checksum", async () => {
      cache.addInstalled({
                slug: "widgets",
        version: "1.2.3",
        profile: "full",
        installed_at: "2026-03-12T00:00:00Z",
        manifest_checksum: "sha256:manifest",
        page_count: 1,
        pinned: false,
      });

      let downloadCalls = 0;
      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "widgets",
              display_name: "Acme Widgets",
              aliases: ["widgets"],
              homepage_url: "https://example.com",
              default_version: "1.2.3",
            },
            version: {
              version: "1.2.3",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:manifest",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({
          data: {
            schema_version: "1.0",
                        slug: "widgets",
            display_name: "Acme Widgets",
            version: "1.2.3",
            channel: "stable",
            generated_at: "2026-03-12T00:00:00Z",
            doc_count: 1,
            source: null,
            page_index: {
              url: "/api/v1/libraries/acme/widgets/versions/1.2.3/page-index",
              sha256: null,
            },
            profiles: {},
            source_policy: {
              license_name: "MIT",
              license_status: "verified",
              mirror_allowed: true,
              origin_fetch_allowed: true,
              attribution_required: false,
            },
            provenance: {
              normalizer_version: "2026-03-12",
              splitter_version: "v1",
              manifest_checksum: "sha256:manifest",
            },
          },
          meta: { cursor: null },
        }),
        downloadBundle: async () => {
          downloadCalls++;
          return Buffer.from("");
        },
        getAllPageIndex: async () => {
          downloadCalls++;
          return [];
        },
      } as unknown as ServerDeps["registryClient"];

      const result = await handleInstallDocs(deps, {
        library: "widgets",
        version: "1.2.3",
      });

      expect(result.content[0].text).toContain("already installed and current");
      expect(result.structuredContent).toMatchObject({
        library: "widgets",
        version: "1.2.3",
        changed: false,
      });
      expect(downloadCalls).toBe(0);
    });

    it("falls back to page fetches when the manifest does not expose a supported bundle", async () => {
      const manifest: Manifest = {
        schema_version: "1.0",
                slug: "legacy",
        display_name: "Legacy Docs",
        version: "9.9.9",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 1,
        source: null,
        page_index: {
          url: "/api/v1/libraries/acme/legacy/versions/9.9.9/page-index",
          sha256: null,
        },
        profiles: {
          full: {
            bundle: {
              format: "tar.zst",
              url: "/api/v1/libraries/acme/legacy/versions/9.9.9/bundles/full",
              sha256: "sha256:unsupported",
            },
          },
        },
        source_policy: {
          license_name: "MIT",
          license_status: "verified",
          mirror_allowed: true,
          origin_fetch_allowed: true,
          attribution_required: false,
        },
        provenance: {
          normalizer_version: "2026-03-12",
          splitter_version: "v1",
          manifest_checksum: "sha256:legacy",
        },
      };
      const pageIndex: PageRecord[] = [{
        page_uid: "intro",
        path: "intro.md",
        title: "Intro",
        url: "https://example.com/intro",
        checksum: "sha256:intro",
        bytes: 20,
        headings: ["Intro"],
        updated_at: "2026-03-12T00:00:00Z",
      }];

      let pageApiCalls = 0;
      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "legacy",
              display_name: "Legacy Docs",
              aliases: ["legacy"],
              homepage_url: "https://example.com",
              default_version: "9.9.9",
            },
            version: {
              version: "9.9.9",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:legacy",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
        downloadBundle: async () => {
          throw new Error("unsupported bundle should not be downloaded");
        },
        getAllPageIndex: async () => {
          pageApiCalls++;
          return pageIndex;
        },
        getPageContent: async () => {
          pageApiCalls++;
          return {
            data: {
              page_uid: "intro",
              path: "intro.md",
              title: "Intro",
              url: "https://example.com/intro",
              content_md: "# Intro\n\nPage API fallback still works.",
            },
            meta: { cursor: null },
          };
        },
      } as unknown as ServerDeps["registryClient"];

      const install = await handleInstallDocs(deps, {
        library: "legacy",
        version: "9.9.9",
      });

      expect(install.content[0].text).toContain("page API fallback");
      expect(pageApiCalls).toBe(2);
      expect(cache.readPage("legacy", "9.9.9", "intro")).toContain("fallback");
    });

    it("reinstalls the same version when the manifest checksum changes", async () => {
      cache.savePageIndex("widgets", "1.2.3", [{
        page_uid: "guide",
        path: "guide.md",
        title: "Guide",
        url: "https://example.com/guide",
        checksum: "sha256:old",
        bytes: 10,
        headings: ["Guide"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage("widgets", "1.2.3", "guide", "# Guide\n\nOld content");
      await indexer.indexLibraryVersion("widgets", "1.2.3");
      cache.addInstalled({
                slug: "widgets",
        version: "1.2.3",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: "sha256:old-manifest",
        page_count: 1,
        pinned: false,
      });

      const pageIndex: PageRecord[] = [{
        page_uid: "guide",
        path: "guide.md",
        title: "Guide",
        url: "https://example.com/guide",
        checksum: "sha256:new",
        bytes: 20,
        headings: ["Guide"],
        updated_at: "2026-03-12T00:00:00Z",
      }];
      const manifest: Manifest = {
        schema_version: "1.0",
                slug: "widgets",
        display_name: "Acme Widgets",
        version: "1.2.3",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 1,
        source: null,
        page_index: {
          url: "/api/v1/libraries/acme/widgets/versions/1.2.3/page-index",
          sha256: null,
        },
        profiles: {},
        source_policy: {
          license_name: "MIT",
          license_status: "verified",
          mirror_allowed: true,
          origin_fetch_allowed: true,
          attribution_required: false,
        },
        provenance: {
          normalizer_version: "2026-03-12",
          splitter_version: "v1",
          manifest_checksum: "sha256:new-manifest",
        },
      };

      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "widgets",
              display_name: "Acme Widgets",
              aliases: ["widgets"],
              homepage_url: "https://example.com",
              default_version: "1.2.3",
            },
            version: {
              version: "1.2.3",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:new-manifest",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
        getAllPageIndex: async () => pageIndex,
        getPageContent: async () => ({
          data: {
            page_uid: "guide",
            path: "guide.md",
            title: "Guide",
            url: "https://example.com/guide",
            content_md: "# Guide\n\nNew content",
          },
          meta: { cursor: null },
        }),
      } as unknown as ServerDeps["registryClient"];

      const result = await handleInstallDocs(deps, {
        library: "widgets",
        version: "1.2.3",
      });

      expect(result.content[0].text).toContain("Reinstalled widgets@1.2.3");
      expect(cache.readPage("widgets", "1.2.3", "guide")).toContain("New content");
      expect(cache.findInstalled("widgets", "1.2.3")?.manifest_checksum).toBe("sha256:new-manifest");

      const search = await handleSearchDocs(deps, {
        query: "New content",
        library: "widgets",
        version: "1.2.3",
        mode: "fts",
      });
      expect(search.structuredContent?.results[0]).toMatchObject({
        content_md: "# Guide\n\nNew content",
      });
    });

    it("falls back to page fetches when a supported bundle is incomplete", async () => {
      const manifest: Manifest = {
        schema_version: "1.0",
                slug: "broken",
        display_name: "Broken Docs",
        version: "1.0.0",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 1,
        source: null,
        page_index: {
          url: "/api/v1/libraries/acme/broken/versions/1.0.0/page-index",
          sha256: null,
        },
        profiles: {
          full: {
            bundle: {
              format: "tar.gz",
              url: "/api/v1/libraries/acme/broken/versions/1.0.0/bundles/full",
              sha256: "",
            },
          },
        },
        source_policy: {
          license_name: "MIT",
          license_status: "verified",
          mirror_allowed: true,
          origin_fetch_allowed: true,
          attribution_required: false,
        },
        provenance: {
          normalizer_version: "2026-03-12",
          splitter_version: "v1",
          manifest_checksum: "sha256:broken",
        },
      };
      const pageIndex: PageRecord[] = [{
        page_uid: "missing-page",
        path: "missing-page.md",
        title: "Missing Page",
        url: "https://example.com/missing-page",
        checksum: "sha256:missing-page",
        bytes: 20,
        headings: ["Missing Page"],
        updated_at: "2026-03-12T00:00:00Z",
      }];
      const bundleBytes = createBundleArchive({
        manifest,
        pageIndex,
        pages: {},
      });
      manifest.profiles.full!.bundle!.sha256 = createHash("sha256").update(bundleBytes).digest("hex");

      let pageApiCalls = 0;
      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "broken",
              display_name: "Broken Docs",
              aliases: ["broken"],
              homepage_url: "https://example.com",
              default_version: "1.0.0",
            },
            version: {
              version: "1.0.0",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:broken",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
        downloadBundle: async () => bundleBytes,
        getAllPageIndex: async () => {
          pageApiCalls++;
          return pageIndex;
        },
        getPageContent: async () => {
          pageApiCalls++;
          return {
            data: {
              page_uid: "missing-page",
              path: "missing-page.md",
              title: "Missing Page",
              url: "https://example.com/missing-page",
              content_md: "# Missing Page\n\nPage API fallback recovered the install.",
            },
            meta: { cursor: null },
          };
        },
      } as unknown as ServerDeps["registryClient"];

      const install = await handleInstallDocs(deps, {
        library: "broken",
        version: "1.0.0",
      });

      expect(install.content[0].text).toContain("page API fallback");
      expect(install.content[0].text).toContain("Bundle fallback");
      expect(pageApiCalls).toBe(2);
      expect(cache.readPage("broken", "1.0.0", "missing-page")).toContain("fallback recovered");
    });
  });

  describe("search_docs (FTS)", () => {
    beforeEach(async () => {
      // Simulate installed library with cached pages
      cache.savePage("nextjs", "15.1.0", "app-router", "# App Router\n\nThe App Router is a new routing model in Next.js 13+ that uses React Server Components.");
      cache.savePage("nextjs", "15.1.0", "pages-router", "# Pages Router\n\nThe Pages Router is the original routing model in Next.js.");
      cache.savePage("nextjs", "15.1.0", "data-fetching", "# Data Fetching\n\nNext.js supports getServerSideProps, getStaticProps, and ISR.");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");
      cache.addInstalled({
                slug: "nextjs",
        version: "15.1.0",
        profile: "slim",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: null,
        page_count: 3,
        pinned: false,
      });
    });

    it("finds docs by keyword search", async () => {
      const results = await indexer.searchFTS("App Router");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe("App Router");
    });

    it("returns multiple results", async () => {
      const results = await indexer.searchFTS("router");
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("respects max results limit", async () => {
      const results = await indexer.searchFTS("Next.js", { maxResults: 1 });
      expect(results.length).toBe(1);
    });

    it("filters by library", async () => {
      const results = await indexer.searchFTS("router", { library: "nextjs" });
      expect(results.every(r => r.library === "nextjs")).toBe(true);
    });

    it("returns page-level local markdown results for MCP consumers", async () => {
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 2048,
        headings: ["useRef"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage("react", "19.2.0",
        "pg_use_ref",
        "# useRef\n\n## Optimize refs\n\nUse refs to keep mutable values without re-rendering.",
      );
      await indexer.indexLibraryVersion("react", "19.2.0");
      cache.addInstalled({
                slug: "react",
        version: "19.2.0",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: null,
        page_count: 1,
        pinned: false,
      });

      const result = await handleSearchDocs(deps, {
        query: "optimize refs",
        library: "react",
        version: "19.2.0",
        max_results: 5,
        mode: "fts",
      });

      expect(result.content[0].text).toContain("page-level local results");
      expect(result.structuredContent?.results).toHaveLength(1);
      expect(result.structuredContent?.results[0]).toMatchObject({
        library: "react",
        version: "19.2.0",
        doc_path: "reference/react/useRef.md",
        page_uid: "pg_use_ref",
        title: "useRef",
        content_md: "# useRef\n\n## Optimize refs\n\nUse refs to keep mutable values without re-rendering.",
        search_mode: "fts",
        url: "https://react.dev/reference/react/useRef",
      });
      expect(result.structuredContent?.results[0].score).toEqual(expect.any(Number));
      expect(result.structuredContent?.results[0].line_start).toEqual(expect.any(Number));
      expect(result.structuredContent?.results[0].line_end).toEqual(expect.any(Number));
      expect(result.structuredContent?.results[0].snippet).toContain("Optimize refs");
    });

    it("returns an empty structured result set on no match", async () => {
      const result = await handleSearchDocs(deps, {
        query: "term-that-does-not-exist",
        library: "nextjs",
        version: "15.1.0",
        max_results: 5,
        mode: "fts",
      });

      expect(result.content[0].text).toContain("No results found");
      expect(result.structuredContent).toEqual({
        query: "term-that-does-not-exist",
        results: [],
      });
    });

    it("returns NOT_INSTALLED when the requested library version is missing locally", async () => {
      const result = await handleSearchDocs(deps, {
        query: "router",
        library: "react",
        version: "19.2.0",
        mode: "fts",
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "NOT_INSTALLED",
          library: "react",
          version: "19.2.0",
          installed_versions: [],
        },
      });
    });

    it("lazily reindexes stale installs so search returns canonical doc_path", async () => {
      cache.savePage("react", "19.2.0",
        "pg_use_ref",
        "# useRef\n\nUse refs to keep mutable values without re-rendering.",
      );
      await indexer.indexPage("react", "19.2.0",
        "pg_use_ref",
        "# useRef\n\nUse refs to keep mutable values without re-rendering.",
      );
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 2048,
        headings: ["useRef"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.addInstalled({
                slug: "react",
        version: "19.2.0",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: null,
        page_count: 1,
        pinned: false,
      });

      const result = await handleSearchDocs(deps, {
        query: "mutable values",
        library: "react",
        version: "19.2.0",
        max_results: 5,
        mode: "fts",
      });

      expect(result.structuredContent?.results[0]).toMatchObject({
        doc_path: "reference/react/useRef.md",
        page_uid: "pg_use_ref",
      });
      expect(cache.findInstalled("react", "19.2.0")?.index_schema_version).toBeDefined();
    });
  });

  describe("search_docs (unified with modes)", () => {
    beforeEach(async () => {
      cache.savePage("nextjs", "15.1.0", "app-router", "# App Router\n\nThe App Router is a new routing model in Next.js 13+ that uses React Server Components.");
      cache.savePage("nextjs", "15.1.0", "data-fetching", "# Data Fetching\n\nNext.js supports getServerSideProps, getStaticProps, and ISR.");
      await indexer.indexLibraryVersion("nextjs", "15.1.0");
      cache.addInstalled({
                slug: "nextjs",
        version: "15.1.0",
        profile: "slim",
        installed_at: "2026-03-09T12:00:00Z",
        manifest_checksum: null,
        page_count: 2,
        pinned: false,
      });
    });

    it("search with explicit fts mode works", async () => {
      const results = await indexer.search("App Router", { mode: "fts" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].searchMode).toBe("fts");
    });

    it("search with auto mode selects fts for keyword queries", async () => {
      const results = await indexer.search("getServerSideProps", { mode: "auto" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].searchMode).toBe("fts");
    });

    it("vector mode falls back to fts when no embeddings", async () => {
      const results = await indexer.search("routing model", { mode: "vector" });
      expect(results.length).toBeGreaterThan(0);
      // Should have fallen back to fts
      expect(results[0].searchMode).toBe("fts");
    });

    it("search dispatches correctly for all mode values", async () => {
      // Verify that search() accepts all valid mode values without error
      // (hybrid is not tested here because expandQuery loads LLM models which is slow;
      // see doc-indexer.test.ts for the full hybrid test with longer timeout)
      for (const mode of ["fts", "auto"] as const) {
        const results = await indexer.search("routing model", { mode });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].searchMode).toBeDefined();
      }
    });
  });

  describe("update_docs", () => {
    it("refreshes an installed library when the version stays the same but the manifest checksum changes", async () => {
      cache.savePageIndex("widgets", "1.2.3", [{
        page_uid: "guide",
        path: "guide.md",
        title: "Guide",
        url: "https://example.com/guide",
        checksum: "sha256:old",
        bytes: 12,
        headings: ["Guide"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage("widgets", "1.2.3", "guide", "# Guide\n\nOld content");
      await indexer.indexLibraryVersion("widgets", "1.2.3");
      cache.addInstalled({
                slug: "widgets",
        version: "1.2.3",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: "sha256:old-manifest",
        page_count: 1,
        pinned: false,
      });

      const manifest: Manifest = {
        schema_version: "1.0",
                slug: "widgets",
        display_name: "Acme Widgets",
        version: "1.2.3",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 1,
        source: null,
        page_index: {
          url: "/api/v1/libraries/acme/widgets/versions/1.2.3/page-index",
          sha256: null,
        },
        profiles: {},
        source_policy: {
          license_name: "MIT",
          license_status: "verified",
          mirror_allowed: true,
          origin_fetch_allowed: true,
          attribution_required: false,
        },
        provenance: {
          normalizer_version: "2026-03-12",
          splitter_version: "v1",
          manifest_checksum: "sha256:new-manifest",
        },
      };
      const pageIndex: PageRecord[] = [{
        page_uid: "guide",
        path: "guide.md",
        title: "Guide",
        url: "https://example.com/guide",
        checksum: "sha256:new",
        bytes: 22,
        headings: ["Guide"],
        updated_at: "2026-03-12T00:00:00Z",
      }];

      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "widgets",
              display_name: "Acme Widgets",
              aliases: ["widgets"],
              homepage_url: "https://example.com",
              default_version: "1.2.3",
            },
            version: {
              version: "1.2.3",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:new-manifest",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
        getAllPageIndex: async () => pageIndex,
        getPageContent: async () => ({
          data: {
            page_uid: "guide",
            path: "guide.md",
            title: "Guide",
            url: "https://example.com/guide",
            content_md: "# Guide\n\nRefreshed content",
          },
          meta: { cursor: null },
        }),
      } as unknown as ServerDeps["registryClient"];

      const result = await handleUpdateDocs(deps, { library: "widgets" });

      expect(result.content[0].text).toContain("refreshed in place");
      expect(cache.findInstalled("widgets", "1.2.3")?.manifest_checksum).toBe("sha256:new-manifest");
      expect(cache.readPage("widgets", "1.2.3", "guide")).toContain("Refreshed content");
    });

    it("preserves an existing install when same-version refresh fails mid-download", async () => {
      const oldPageIndex: PageRecord[] = [{
        page_uid: "guide",
        path: "guide.md",
        title: "Guide",
        url: "https://example.com/guide",
        checksum: "sha256:old",
        bytes: 12,
        headings: ["Guide"],
        updated_at: "2026-03-11T00:00:00Z",
      }];

      cache.saveManifest("widgets", "1.2.3", {
        provenance: { manifest_checksum: "sha256:old-manifest" },
      });
      cache.savePageIndex("widgets", "1.2.3", oldPageIndex);
      cache.savePage("widgets", "1.2.3", "guide", "# Guide\n\nOld content");
      await indexer.indexLibraryVersion("widgets", "1.2.3");
      cache.addInstalled({
                slug: "widgets",
        version: "1.2.3",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: "sha256:old-manifest",
        page_count: 1,
        pinned: false,
      });

      const manifest: Manifest = {
        schema_version: "1.0",
                slug: "widgets",
        display_name: "Acme Widgets",
        version: "1.2.3",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 2,
        source: null,
        page_index: {
          url: "/api/v1/libraries/acme/widgets/versions/1.2.3/page-index",
          sha256: null,
        },
        profiles: {},
        source_policy: {
          license_name: "MIT",
          license_status: "verified",
          mirror_allowed: true,
          origin_fetch_allowed: true,
          attribution_required: false,
        },
        provenance: {
          normalizer_version: "2026-03-12",
          splitter_version: "v1",
          manifest_checksum: "sha256:new-manifest",
        },
      };
      const refreshedPageIndex: PageRecord[] = [
        {
          page_uid: "guide",
          path: "guide.md",
          title: "Guide",
          url: "https://example.com/guide",
          checksum: "sha256:new-guide",
          bytes: 22,
          headings: ["Guide"],
          updated_at: "2026-03-12T00:00:00Z",
        },
        {
          page_uid: "faq",
          path: "faq.md",
          title: "FAQ",
          url: "https://example.com/faq",
          checksum: "sha256:new-faq",
          bytes: 18,
          headings: ["FAQ"],
          updated_at: "2026-03-12T00:00:00Z",
        },
      ];

      deps.registryClient = {
        resolve: async () => ({
          data: {
            library: {
                            slug: "widgets",
              display_name: "Acme Widgets",
              aliases: ["widgets"],
              homepage_url: "https://example.com",
              default_version: "1.2.3",
            },
            version: {
              version: "1.2.3",
              channel: "stable",
              generated_at: "2026-03-12T00:00:00Z",
              manifest_checksum: "sha256:new-manifest",
            },
          },
          meta: { cursor: null },
        }),
        getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
        getAllPageIndex: async () => refreshedPageIndex,
        getPageContent: async (_slug: string, _version: string, pageUid: string) => {
          if (pageUid === "guide") {
            return {
              data: {
                page_uid: "guide",
                path: "guide.md",
                title: "Guide",
                url: "https://example.com/guide",
                content_md: "# Guide\n\nRefreshed content",
              },
              meta: { cursor: null },
            };
          }

          throw new Error("FAQ download failed");
        },
      } as unknown as ServerDeps["registryClient"];

      const result = await handleUpdateDocs(deps, { library: "widgets" });

      expect(result.content[0].text).toContain("FAQ download failed");
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            library: "widgets",
            version: "1.2.3",
            status: "failed",
            error: "FAQ download failed",
          },
        ],
      });

      expect(cache.findInstalled("widgets", "1.2.3")?.manifest_checksum).toBe("sha256:old-manifest");
      expect(cache.loadPageIndex("widgets", "1.2.3")).toEqual(oldPageIndex);
      expect(cache.readPage("widgets", "1.2.3", "guide")).toContain("Old content");
      expect(cache.readPage("widgets", "1.2.3", "faq")).toBeNull();
      expect(
        JSON.parse(readFileSync(join(cache.docsDir("widgets", "1.2.3"), "manifest.json"), "utf8")) as Manifest,
      ).toMatchObject({
        provenance: { manifest_checksum: "sha256:old-manifest" },
      });
    });
  });

  describe("remove_docs", () => {
    it("removes a local install from both cache state and QMD index", async () => {
      cache.savePage("widgets", "1.2.3", "guide", "# Guide\n\nLocal content");
      await indexer.indexLibraryVersion("widgets", "1.2.3");
      cache.addInstalled({
                slug: "widgets",
        version: "1.2.3",
        profile: "full",
        installed_at: "2026-03-12T00:00:00Z",
        manifest_checksum: "sha256:manifest",
        page_count: 1,
        pinned: false,
      });

      const result = await handleRemoveDocs(deps, { library: "widgets", version: "1.2.3" });
      expect(result.structuredContent).toMatchObject({
        library: "widgets",
        removed_versions: ["1.2.3"],
      });
      expect(cache.findInstalled("widgets", "1.2.3")).toBeUndefined();

      const search = await handleSearchDocs(deps, {
        query: "Local content",
        library: "widgets",
        version: "1.2.3",
      });
      expect(search.isError).toBe(true);
      expect(search.structuredContent).toMatchObject({
        error: { code: "NOT_INSTALLED" },
      });
    });
  });

  describe("single-page local indexing", () => {
    it("indexes a single page into QMD store", async () => {
      const content = "# API Reference\n\nDetailed API documentation for custom hooks.";
      cache.savePage("nextjs", "15.1.0", "api-ref", content);
      await indexer.indexPage("nextjs", "15.1.0", "api-ref", content);

      const results = await indexer.searchFTS("custom hooks");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageUid).toBe("api-ref");
    });
  });

  describe("get_doc", () => {
    beforeEach(() => {
      cache.savePageIndex("react", "19.2.0", [{
        page_uid: "pg_use_ref",
        path: "reference/react/useRef.md",
        title: "useRef",
        url: "https://react.dev/reference/react/useRef",
        checksum: "abc123",
        bytes: 2048,
        headings: ["useRef"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage("react", "19.2.0",
        "pg_use_ref",
        Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"),
      );
      cache.addInstalled({
                slug: "react",
        version: "19.2.0",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: null,
        page_count: 1,
        pinned: false,
      });
    });

    it("returns a bounded excerpt by doc_path", async () => {
      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.0",
        doc_path: "reference/react/useRef.md",
        from_line: 5,
        max_lines: 4,
      });

      expect(result.content[0].text).toBe("line 5\nline 6\nline 7\nline 8");
      expect(result.structuredContent).toMatchObject({
        library: "react",
        version: "19.2.0",
        doc_path: "reference/react/useRef.md",
        page_uid: "pg_use_ref",
        title: "useRef",
        line_start: 5,
        line_end: 8,
        truncated: true,
        url: "https://react.dev/reference/react/useRef",
      });
    });

    it("defaults to a bounded top-of-page slice", async () => {
      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.0",
        doc_path: "reference/react/useRef.md",
      });

      expect(result.structuredContent).toMatchObject({
        line_start: 1,
        line_end: 60,
        truncated: true,
      });
      expect(result.content[0].text.split("\n")).toHaveLength(60);
    });

    it("supports around_line windows in the same tool", async () => {
      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.0",
        page_uid: "pg_use_ref",
        around_line: 20,
        before: 2,
        after: 1,
      });

      expect(result.content[0].text).toBe("line 18\nline 19\nline 20\nline 21");
      expect(result.structuredContent).toMatchObject({
        doc_path: "reference/react/useRef.md",
        page_uid: "pg_use_ref",
        line_start: 18,
        line_end: 21,
      });
    });

    it("returns the same bounded excerpt by page_uid with line numbers", async () => {
      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.0",
        page_uid: "pg_use_ref",
        from_line: 5,
        max_lines: 2,
        line_numbers: true,
      });

      expect(result.content[0].text).toBe("5 | line 5\n6 | line 6");
      expect(result.structuredContent).toMatchObject({
        doc_path: "reference/react/useRef.md",
        page_uid: "pg_use_ref",
        line_start: 5,
        line_end: 6,
      });
    });

    it("rejects mixed range styles", async () => {
      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.0",
        doc_path: "reference/react/useRef.md",
        from_line: 5,
        around_line: 10,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "INVALID_RANGE" },
      });
    });

    it("returns PAGE_NOT_HYDRATED when metadata exists but content is missing", async () => {
      cache.savePageIndex("react", "19.2.1", [{
        page_uid: "pg_missing",
        path: "reference/react/missing.md",
        title: "Missing",
        url: "https://react.dev/reference/react/missing",
        checksum: "def456",
        bytes: 2048,
        headings: ["Missing"],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.addInstalled({
                slug: "react",
        version: "19.2.1",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: null,
        page_count: 0,
        pinned: false,
      });

      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.1",
        doc_path: "reference/react/missing.md",
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "PAGE_NOT_HYDRATED",
        },
      });
    });

    it("returns an explicit empty-content error for empty pages", async () => {
      cache.savePageIndex("react", "19.2.2", [{
        page_uid: "pg_empty",
        path: "reference/react/empty.md",
        title: "Empty",
        url: "https://react.dev/reference/react/empty",
        checksum: "ghi789",
        bytes: 0,
        headings: [],
        updated_at: "2026-03-11T00:00:00Z",
      }]);
      cache.savePage("react", "19.2.2", "pg_empty", "");
      cache.addInstalled({
                slug: "react",
        version: "19.2.2",
        profile: "full",
        installed_at: "2026-03-11T00:00:00Z",
        manifest_checksum: null,
        page_count: 1,
        pinned: false,
      });

      const result = await handleGetDoc(deps, {
        library: "react",
        version: "19.2.2",
        doc_path: "reference/react/empty.md",
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "EMPTY_CONTENT",
        },
      });
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
        cache.savePage("react", "19.0.0", p.uid, p.content);
      }

      const indexed = await indexer.indexLibraryVersion("react", "19.0.0");
      expect(indexed).toBe(3);

      cache.addInstalled({
                slug: "react",
        version: "19.0.0",
        profile: "slim",
        installed_at: new Date().toISOString(),
        manifest_checksum: null,
        page_count: 3,
        pinned: false,
      });

      // Search via unified dispatcher
      const results = await indexer.search("useState");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe("Hooks");
      expect(results[0].searchMode).toBeDefined();

      // Legacy FTS still works
      const ftsResults = await indexer.searchFTS("useState");
      expect(ftsResults.length).toBeGreaterThan(0);
      expect(ftsResults[0].title).toBe("Hooks");

      // List installed
      const installed = cache.listInstalled();
      expect(installed.length).toBe(1);
      expect(installed[0].slug).toBe("react");
    });
  });
});
