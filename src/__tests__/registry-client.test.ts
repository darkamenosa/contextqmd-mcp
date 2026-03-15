import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistryClient } from "../lib/registry-client.js";

describe("RegistryClient", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("constructs with registry URL", () => {
    const client = new RegistryClient("https://contextqmd.com");
    expect(client).toBeDefined();
  });

  it("strips trailing slash from URL", () => {
    const client = new RegistryClient("https://contextqmd.com/");
    expect(client).toBeDefined();
  });

  it("routes API requests through /api/v1 for library search", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [],
      meta: { cursor: null },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const client = new RegistryClient("https://contextqmd.com");
    await client.searchLibraries("rails");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://contextqmd.com/api/v1/libraries?query=rails",
      { headers: { Accept: "application/json" } },
    );
  });

  it("routes API requests through /api/v1 for resolve", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: {
        library: {
          slug: "rails",
          display_name: "Rails",
          aliases: ["rails"],
          homepage_url: "https://rubyonrails.org",
          default_version: "8.0.2",
        },
        version: {
          version: "8.0.2",
          channel: "stable",
          generated_at: "2026-03-12T00:00:00Z",
          manifest_checksum: "sha256:abc123",
        },
      },
      meta: { cursor: null },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const client = new RegistryClient("https://contextqmd.com");
    await client.resolve({ query: "rails" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://contextqmd.com/api/v1/resolve",
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ query: "rails" }),
      },
    );
  });

  it("loads manifest bundle metadata from the registry API", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: {
        schema_version: "1.0",
        slug: "nextjs",
        display_name: "Next.js",
        version: "16.1.6",
        channel: "stable",
        generated_at: "2026-03-12T00:00:00Z",
        doc_count: 2,
        source: null,
        page_index: {
          url: "/api/v1/libraries/nextjs/versions/16.1.6/page-index",
          sha256: null,
        },
        profiles: {
          full: {
            bundle: {
              format: "tar.gz",
              url: "/api/v1/libraries/nextjs/versions/16.1.6/bundles/full",
              sha256: "sha256:abc123",
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
          manifest_checksum: "sha256:def456",
        },
      },
      meta: { cursor: null },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const client = new RegistryClient("https://contextqmd.com");
    const manifest = await client.getManifest("nextjs", "16.1.6");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://contextqmd.com/api/v1/libraries/nextjs/versions/16.1.6/manifest",
      { headers: { Accept: "application/json" } },
    );
    expect(manifest.data.profiles.full?.bundle).toMatchObject({
      format: "tar.gz",
      url: "/api/v1/libraries/nextjs/versions/16.1.6/bundles/full",
      sha256: "sha256:abc123",
    });
  });

  it("downloads bundle bytes from a relative registry URL with auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }));

    const client = new RegistryClient("https://contextqmd.com/", "test-token");
    const bytes = await client.downloadBundle("/api/v1/libraries/nextjs/versions/16.1.6/bundles/full");

    expect(bytes).toBeInstanceOf(Buffer);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://contextqmd.com/api/v1/libraries/nextjs/versions/16.1.6/bundles/full",
      { headers: { Authorization: "Token test-token" } },
    );
  });
});
