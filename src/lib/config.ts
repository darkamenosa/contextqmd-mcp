import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ContextQMDConfig {
  registry_url: string;
  fallback_registries: string[];
  allow_origin_fetch: boolean;
  allow_remote_bundles: boolean;
  allow_public_fallback: boolean;
  verify_registry_signatures: boolean;
  default_install_mode: "slim" | "full";
  preferred_search_mode: "auto" | "search" | "vsearch" | "query";
  local_cache_dir: string;
}

const DEFAULT_CONFIG: ContextQMDConfig = {
  registry_url: "https://contextqmd.com",
  fallback_registries: [],
  allow_origin_fetch: true,
  allow_remote_bundles: true,
  allow_public_fallback: false,
  verify_registry_signatures: true,
  default_install_mode: "slim",
  preferred_search_mode: "auto",
  local_cache_dir: join(homedir(), ".cache", "contextqmd"),
};

export function loadConfig(configPath?: string): ContextQMDConfig {
  const path =
    configPath ?? join(homedir(), ".config", "contextqmd", "config.json");

  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return { ...DEFAULT_CONFIG, ...raw };
}
