// Types matching refs/api-contract-v1.md

export interface Library {
  namespace: string;
  name: string;
  display_name: string;
  aliases: string[];
  homepage_url: string;
  default_version: string;
}

export interface Version {
  version: string;
  channel: "stable" | "latest" | "canary" | "snapshot";
  generated_at: string;
  manifest_checksum: string;
}

export interface PageRecord {
  page_uid: string;
  path: string;
  title: string;
  url: string;
  checksum: string;
  bytes: number;
  headings: string[];
  updated_at: string;
}

export interface Manifest {
  schema_version: string;
  namespace: string;
  name: string;
  display_name: string;
  version: string;
  channel: string;
  generated_at: string;
  doc_count: number;
  source: {
    type: string;
    url: string;
    etag: string | null;
  } | null;
  page_index: { url: string; sha256: string | null };
  profiles: Record<
    string,
    {
      selector_version?: string;
      bundle: { format: string; url: string; sha256: string };
    }
  >;
  source_policy: {
    license_name: string;
    license_status: "verified" | "unclear" | "custom";
    mirror_allowed: boolean;
    origin_fetch_allowed: boolean;
    attribution_required: boolean;
  };
  provenance: {
    normalizer_version: string;
    splitter_version: string;
    manifest_checksum: string;
  };
}

export interface RegistryCapabilities {
  name: string;
  version: string;
  features: {
    bundle_download: boolean;
    signed_manifests: boolean;
    signed_fetch_recipes: boolean;
    origin_fetch_recipes: boolean;
    hosted_content: boolean;
    cursor_pagination: boolean;
    private_sources: boolean;
    delta_sync: boolean;
  };
}

export interface ApiResponse<T> {
  data: T;
  meta: { cursor: string | null };
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface ResolveRequest {
  query: string;
  version_hint?: string;
}

export interface ResolveResponse {
  library: Library;
  version: Version;
}
