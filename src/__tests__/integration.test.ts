/**
 * Integration tests: MCP RegistryClient ↔ Registry API
 *
 * These tests run against a live local registry server at localhost:3000.
 * Requires:
 *   1. Registry running: cd contextqmd-registry && bin/dev
 *   2. Seed data loaded: bin/rails db:seed
 *
 * API is free (no token required for read-only endpoints).
 * Set SKIP_INTEGRATION=1 to skip these tests.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { RegistryClient } from "../lib/registry-client.js";

const REGISTRY_URL = process.env.INTEGRATION_REGISTRY_URL ?? "http://localhost:3000";
const TOKEN = process.env.INTEGRATION_TEST_TOKEN; // optional, for future write tests

const skipIntegration = process.env.SKIP_INTEGRATION === "1";

describe.skipIf(skipIntegration)("Integration: MCP ↔ Registry", () => {
  let client: RegistryClient;

  beforeAll(async () => {
    client = new RegistryClient(REGISTRY_URL, TOKEN);
    // Quick check that server is reachable
    try {
      await client.health();
    } catch {
      console.warn("Registry not reachable at", REGISTRY_URL, "- skipping integration tests");
      return;
    }
  });

  // ─── B00: Health + Capabilities ───────────────────────────────────

  describe("B00: Health + Capabilities", () => {
    it("GET /health returns ok status", async () => {
      const result = await client.health();
      expect(result.data).toBeDefined();
      expect(result.data.status).toBe("ok");
      expect(result.data.version).toBeDefined();
    });

    it("GET /capabilities returns features", async () => {
      const result = await client.capabilities();
      expect(result.data).toBeDefined();
      expect(result.data.name).toBe("ContextQMD Registry");
      expect(result.data.version).toBeDefined();
      expect(result.data.features).toBeDefined();
      expect(result.data.features.bundle_download).toBe(true);
      expect(result.data.features.cursor_pagination).toBe(true);
    });
  });

  // ─── B01: Library Search + Resolve ────────────────────────────────

  describe("B01: Library Search + Resolve", () => {
    it("GET /libraries?query=nextjs returns results", async () => {
      const result = await client.searchLibraries("nextjs");
      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThan(0);
      const lib = result.data[0];
      expect(lib.namespace).toBe("vercel");
      expect(lib.name).toBe("nextjs");
      expect(lib.display_name).toBe("Next.js");
      expect(lib.aliases).toContain("nextjs");
    });

    it("GET /libraries/:namespace/:name returns library detail", async () => {
      const result = await client.getLibrary("vercel", "nextjs");
      expect(result.data).toBeDefined();
      expect(result.data.namespace).toBe("vercel");
      expect(result.data.name).toBe("nextjs");
      expect(result.data.default_version).toBe("16.1.6");
    });

    it("POST /resolve resolves by name", async () => {
      const result = await client.resolve({ query: "nextjs" });
      expect(result.data).toBeDefined();
      expect(result.data.library.namespace).toBe("vercel");
      expect(result.data.library.name).toBe("nextjs");
      expect(result.data.version).toBeDefined();
      expect(result.data.version.version).toBe("16.1.6");
      expect(result.data.version.channel).toBe("stable");
    });

    it("POST /resolve resolves by alias", async () => {
      const result = await client.resolve({ query: "next" });
      expect(result.data.library.name).toBe("nextjs");
    });

    it("POST /resolve resolves by namespace/name", async () => {
      const result = await client.resolve({ query: "vercel/nextjs" });
      expect(result.data.library.namespace).toBe("vercel");
      expect(result.data.library.name).toBe("nextjs");
    });

    it("POST /resolve with version_hint=stable returns stable version", async () => {
      const result = await client.resolve({
        query: "nextjs",
        version_hint: "stable",
      });
      expect(result.data.version.channel).toBe("stable");
    });

    it("POST /resolve with unknown library returns 404", async () => {
      await expect(
        client.resolve({ query: "nonexistent-library-xyz" }),
      ).rejects.toThrow(/404/);
    });

    it("searches by alias 'rails'", async () => {
      const result = await client.searchLibraries("rails");
      expect(result.data.length).toBeGreaterThan(0);
      const rails = result.data.find((l) => l.name === "rails");
      expect(rails).toBeDefined();
      expect(rails!.namespace).toBe("rails");
    });
  });

  // ─── B02: Versions + Manifest + PageIndex + Bundles ───────────────

  describe("B02: Versions, Manifest, PageIndex, Bundles", () => {
    it("GET /versions lists versions for a library", async () => {
      const result = await client.getVersions("vercel", "nextjs");
      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThan(0);
      const stable = result.data.find((v) => v.channel === "stable");
      expect(stable).toBeDefined();
      expect(stable!.version).toBe("16.1.6");
    });

    it("GET /manifest returns contract-conforming manifest", async () => {
      const result = await client.getManifest("vercel", "nextjs", "16.1.6");
      expect(result.data).toBeDefined();
      // Contract: flat top-level fields, not nested library/version objects
      const data = result.data as unknown as Record<string, unknown>;
      expect(data.schema_version).toBe("1.0");
      expect(data.namespace).toBe("vercel");
      expect(data.name).toBe("nextjs");
      expect(data.version).toBe("16.1.6");
      expect(data.doc_count).toBeDefined();
      expect(data.page_index).toBeDefined();
      expect(data.provenance).toBeDefined();
    });

    it("GET /page-index lists pages", async () => {
      const result = await client.getPageIndex("vercel", "nextjs", "16.1.6");
      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThan(0);
      const page = result.data[0];
      expect(page.page_uid).toBeDefined();
      expect(page.title).toBeDefined();
      expect(page.path).toBeDefined();
    });

    it("GET /pages/:page_uid returns page content", async () => {
      // First get the page index to find a valid page_uid
      const indexResult = await client.getPageIndex(
        "vercel",
        "nextjs",
        "16.1.6",
      );
      const firstPage = indexResult.data[0];
      expect(firstPage).toBeDefined();

      const result = await client.getPageContent(
        "vercel",
        "nextjs",
        "16.1.6",
        firstPage.page_uid,
      );
      expect(result.data).toBeDefined();
      expect(result.data.page_uid).toBe(firstPage.page_uid);
      expect(result.data.title).toBeDefined();
    });
  });

  // ─── Cross-library: multiple libraries in seed ────────────────────

  describe("Cross-library coverage", () => {
    it("can resolve Rails library", async () => {
      const result = await client.resolve({ query: "rails" });
      expect(result.data.library.namespace).toBe("rails");
      expect(result.data.library.name).toBe("rails");
    });

    it("can resolve React library", async () => {
      const result = await client.resolve({ query: "react" });
      expect(result.data.library.namespace).toBe("facebook");
      expect(result.data.library.name).toBe("react");
    });

    it("can resolve Tailwind by alias 'tailwindcss'", async () => {
      const result = await client.resolve({ query: "tailwindcss" });
      expect(result.data.library.name).toBe("tailwindcss");
    });

    it("can resolve Inertia.js", async () => {
      const result = await client.resolve({ query: "inertia" });
      expect(result.data.library.name).toBe("inertia");
    });
  });
});
