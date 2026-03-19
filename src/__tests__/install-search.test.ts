/**
 * End-to-end integration test: install docs from registry → search locally.
 *
 * Requires the registry to be running at localhost:3000 with seed data.
 * Skip with SKIP_INTEGRATION=1.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegistryClient } from "../lib/registry-client.js";
import { LocalCache } from "../lib/local-cache.js";
import { DocIndexer } from "../lib/doc-indexer.js";
import { handleInstallDocs, handleSearchDocs, type ServerDeps } from "../index.js";
import type { Manifest, PageRecord } from "../lib/types.js";

const REGISTRY_URL = "http://localhost:3000";
const skipIntegration = process.env.SKIP_INTEGRATION === "1";

function createBundleArchive({
  manifest,
  pageIndex,
  pages,
}: {
  manifest: Manifest;
  pageIndex: PageRecord[];
  pages: Record<string, string>;
}): Buffer {
  const rootDir = mkdtempSync(join(tmpdir(), "contextqmd-install-bundle-src-"));
  const archivePath = join(tmpdir(), `contextqmd-install-bundle-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);

  try {
    mkdirSync(join(rootDir, "pages"), { recursive: true });
    writeFileSync(join(rootDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(rootDir, "page-index.json"), JSON.stringify(pageIndex, null, 2));
    for (const [pageUid, content] of Object.entries(pages)) {
      const filename = pageUid.endsWith(".md") ? pageUid : `${pageUid}.md`;
      writeFileSync(join(rootDir, "pages", filename), content);
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

describe("Install → Search (bundle-first local flow)", () => {
  let cacheDir: string;
  let deps: ServerDeps;
  let cache: LocalCache;
  let indexer: DocIndexer;

  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-bundle-e2e-"));
    cache = new LocalCache(cacheDir);
    indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);
    deps = {
      cache,
      indexer,
      registryClient: {} as ServerDeps["registryClient"],
    };
  });

  afterAll(async () => {
    await indexer.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("installs from a bundle and searches page-level local content", async () => {
    const pageIndex: PageRecord[] = [{
      page_uid: "routing",
      bundle_path: "4d4df4c7f6f0fd0f4b98011995dd60d6fceaf7aa11ef3197bf9d8f53d11d0f04.md",
      path: "guide/routing.md",
      title: "Routing",
      url: "https://example.com/guide/routing",
      checksum: "sha256:routing",
      bytes: 64,
      headings: ["Routing"],
      updated_at: "2026-03-12T00:00:00Z",
    }];
    const manifest: Manifest = {
      schema_version: "1.0",
      slug: "demo-kit",
      display_name: "Demo Kit",
      version: "3.0.0",
      channel: "stable",
      generated_at: "2026-03-12T00:00:00Z",
      doc_count: 1,
      source: null,
      page_index: {
        url: "/api/v1/libraries/demo-kit/versions/3.0.0/page-index",
        sha256: null,
      },
      profiles: {
        full: {
          bundle: {
            format: "tar.gz",
            url: "/api/v1/libraries/demo-kit/versions/3.0.0/bundles/full",
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
        manifest_checksum: "sha256:demo",
      },
    };
    const bundleBytes = createBundleArchive({
      manifest,
      pageIndex,
      pages: {
        "4d4df4c7f6f0fd0f4b98011995dd60d6fceaf7aa11ef3197bf9d8f53d11d0f04.md":
          "# Routing\n\nBundle-first installs keep search local.",
      },
    });
    manifest.profiles.full!.bundle!.sha256 = createHash("sha256").update(bundleBytes).digest("hex");

    deps.registryClient = {
      resolve: async () => ({
        data: {
          library: {
            slug: "demo-kit",
            display_name: "Demo Kit",
            aliases: ["kit"],
            homepage_url: "https://example.com",
            default_version: "3.0.0",
          },
          version: {
            version: "3.0.0",
            channel: "stable",
            generated_at: "2026-03-12T00:00:00Z",
            manifest_checksum: "sha256:demo",
          },
        },
        meta: { cursor: null },
      }),
      getManifest: async () => ({ data: manifest, meta: { cursor: null } }),
      downloadBundle: async () => bundleBytes,
    } as unknown as ServerDeps["registryClient"];

    const install = await handleInstallDocs(deps, { library: "kit", version: "3.0.0" });
    expect(install.content[0].text).toContain("Installed from bundle");
    expect(install.structuredContent).toMatchObject({
      library: "demo-kit",
      version: "3.0.0",
    });

    const search = await handleSearchDocs(deps, {
      query: "keep search local",
      library: "demo-kit",
      version: "3.0.0",
      mode: "fts",
    });
    expect(search.structuredContent?.results[0]).toMatchObject({
      library: "demo-kit",
      version: "3.0.0",
      doc_path: "guide/routing.md",
      page_uid: "routing",
    });
  });
});

describe.skipIf(skipIntegration)("E2E: Install → Search", () => {
  let client: RegistryClient;
  let cache: LocalCache;
  let indexer: DocIndexer;
  let cacheDir: string;
  let deps: ServerDeps;

  beforeAll(async () => {
    client = new RegistryClient(REGISTRY_URL);
    // Verify registry is available
    try {
      await client.health();
    } catch {
      throw new Error("Registry not running at " + REGISTRY_URL);
    }
  });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-e2e-"));
    cache = new LocalCache(cacheDir);
    indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);
    deps = {
      cache,
      indexer,
      registryClient: client,
    };
  });

  afterEach(async () => {
    await indexer.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  it("installs Laravel docs and searches them", async () => {
    const install = await handleInstallDocs(deps, { library: "laravel" });
    expect(install.isError).not.toBe(true);
    expect(install.structuredContent).toMatchObject({
      library: "laravel",
      changed: true,
    });

    const version = install.structuredContent?.version as string;
    expect(cache.hasManifest("laravel", version)).toBe(true);
    expect(cache.loadPageIndex("laravel", version).length).toBeGreaterThan(0);
    expect(cache.countPages("laravel", version)).toBeGreaterThan(0);

    const search = await handleSearchDocs(deps, {
      query: "authentication",
      library: "laravel",
      version,
      mode: "fts",
    });
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          library: "laravel",
          version,
        }),
      ]),
    );

    const allInstalled = cache.listInstalled();
    expect(allInstalled).toHaveLength(1);
    expect(allInstalled[0].slug).toBe("laravel");
    expect(allInstalled[0].page_count).toBeGreaterThan(0);
  });

  it("installs Kamal docs alongside Laravel", async () => {
    const laravelInstall = await handleInstallDocs(deps, { library: "laravel" });
    expect(laravelInstall.isError).not.toBe(true);

    const kamalInstall = await handleInstallDocs(deps, { library: "kamal" });
    expect(kamalInstall.isError).not.toBe(true);

    const kamalVersion = kamalInstall.structuredContent?.version as string;
    const kamalResults = await handleSearchDocs(deps, {
      query: "proxy",
      library: "kamal",
      version: kamalVersion,
      mode: "fts",
    });
    expect(kamalResults.isError).not.toBe(true);
    expect(kamalResults.structuredContent?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          library: "kamal",
          version: kamalVersion,
        }),
      ]),
    );

    const allInstalled = cache.listInstalled();
    expect(allInstalled.length).toBe(2);
  });

  it("returns NOT_INSTALLED before install and succeeds after install", async () => {
    const missing = await handleSearchDocs(deps, {
      query: "proxy",
      library: "kamal",
      mode: "fts",
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      error: {
        code: "NOT_INSTALLED",
        library: "kamal",
      },
    });

    const install = await handleInstallDocs(deps, { library: "kamal" });
    expect(install.isError).not.toBe(true);

    const version = install.structuredContent?.version as string;
    const results = await handleSearchDocs(deps, {
      query: "proxy",
      library: "kamal",
      version,
      mode: "fts",
    });
    expect(results.isError).not.toBe(true);
    expect(results.structuredContent?.results.length).toBeGreaterThan(0);
  });
});
