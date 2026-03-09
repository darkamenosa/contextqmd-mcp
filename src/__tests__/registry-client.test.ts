import { describe, it, expect } from "vitest";
import { RegistryClient } from "../lib/registry-client.js";

describe("RegistryClient", () => {
  it("constructs with registry URL", () => {
    const client = new RegistryClient("https://contextqmd.com");
    expect(client).toBeDefined();
  });

  it("strips trailing slash from URL", () => {
    const client = new RegistryClient("https://contextqmd.com/");
    expect(client).toBeDefined();
  });

  it("constructs with optional token", () => {
    const client = new RegistryClient("https://contextqmd.com", "test-token");
    expect(client).toBeDefined();
  });
});
