/**
 * Integration tests: MCP RegistryClient ↔ Registry API
 *
 * These tests run against a live local registry server at localhost:3000.
 * They intentionally use the slug-first contract and the libraries currently
 * present in the local development registry.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { RegistryClient } from "../lib/registry-client.js";

const REGISTRY_URL = process.env.INTEGRATION_REGISTRY_URL ?? "http://localhost:3000";
const TOKEN = process.env.INTEGRATION_TEST_TOKEN;
const skipIntegration = process.env.SKIP_INTEGRATION === "1";

describe.skipIf(skipIntegration)("Integration: MCP ↔ Registry", () => {
  let client: RegistryClient;

  beforeAll(async () => {
    client = new RegistryClient(REGISTRY_URL, TOKEN);

    try {
      await client.health();
    } catch {
      console.warn("Registry not reachable at", REGISTRY_URL, "- skipping integration tests");
      return;
    }
  });

  describe("B00: Health + Capabilities", () => {
    it("GET /health returns ok status", async () => {
      const result = await client.health();
      expect(result.data.status).toBe("ok");
      expect(result.data.version).toBeDefined();
    });

    it("GET /capabilities returns features", async () => {
      const result = await client.capabilities();
      expect(result.data.name).toBe("ContextQMD Registry");
      expect(result.data.features.bundle_download).toBe(true);
      expect(result.data.features.cursor_pagination).toBe(true);
    });
  });

  describe("B01: Library Search + Resolve", () => {
    it("GET /libraries?query=laravel returns slug-first results", async () => {
      const result = await client.searchLibraries("laravel");
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0]).toMatchObject({
        slug: "laravel",
        display_name: "Laravel",
      });
    });

    it("GET /libraries/:slug returns library detail", async () => {
      const result = await client.getLibrary("laravel");
      expect(result.data).toMatchObject({
        slug: "laravel",
        display_name: "Laravel",
        default_version: "12.x",
      });
    });

    it("POST /resolve resolves Laravel by slug", async () => {
      const result = await client.resolve({ query: "laravel" });
      expect(result.data.library.slug).toBe("laravel");
      expect(result.data.version.version).toBe("12.x");
      expect(result.data.version.channel).toBe("stable");
    });

    it("POST /resolve resolves Kamal by slug", async () => {
      const result = await client.resolve({ query: "kamal" });
      expect(result.data.library.slug).toBe("kamal");
      expect(result.data.version.version).toBe("latest");
    });

    it("POST /resolve with unknown library returns 404", async () => {
      await expect(client.resolve({ query: "nonexistent-library-xyz" })).rejects.toThrow(/404/);
    });
  });

  describe("B02: Versions, Manifest, PageIndex, Bundles", () => {
    it("GET /versions lists versions for Laravel", async () => {
      const result = await client.getVersions("laravel");
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.find((v) => v.version === "12.x")).toBeDefined();
    });

    it("GET /manifest returns a slug-first manifest", async () => {
      const result = await client.getManifest("laravel", "12.x");
      expect(result.data.slug).toBe("laravel");
      expect(result.data.version).toBe("12.x");
      expect(result.data.doc_count).toBeGreaterThan(0);
      expect(result.data.page_index).toBeDefined();
      expect(result.data.profiles.full?.bundle).toBeDefined();
    });

    it("GET /bundles/:profile downloads the full bundle", async () => {
      const manifest = await client.getManifest("laravel", "12.x");
      const fullBundle = manifest.data.profiles.full?.bundle;
      expect(fullBundle).toBeDefined();

      const bundleBytes = await client.downloadBundle(fullBundle!.url);
      expect(bundleBytes.byteLength).toBeGreaterThan(0);
    });

    it("GET /page-index lists pages", async () => {
      const result = await client.getPageIndex("laravel", "12.x");
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0]?.path).toBeDefined();
      expect(result.data[0]?.title).toBeDefined();
    });

    it("GET /pages/:page_uid returns page content", async () => {
      const indexResult = await client.getPageIndex("laravel", "12.x");
      const firstPage = indexResult.data[0];
      expect(firstPage).toBeDefined();

      const result = await client.getPageContent("laravel", "12.x", firstPage.page_uid);
      expect(result.data.page_uid).toBe(firstPage.page_uid);
      expect(result.data.title).toBeDefined();
      expect(result.data.content_md.length).toBeGreaterThan(0);
    });
  });

  describe("Cross-library coverage", () => {
    it("can resolve Laravel", async () => {
      const result = await client.resolve({ query: "laravel" });
      expect(result.data.library.slug).toBe("laravel");
    });

    it("can resolve Kamal", async () => {
      const result = await client.resolve({ query: "kamal" });
      expect(result.data.library.slug).toBe("kamal");
    });
  });
});
