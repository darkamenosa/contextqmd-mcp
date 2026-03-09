import type {
  ApiResponse,
  Library,
  Version,
  Manifest,
  PageRecord,
  RegistryCapabilities,
  ResolveRequest,
  ResolveResponse,
} from "./types.js";

export class RegistryClient {
  private baseUrl: string;
  private token?: string;

  constructor(registryUrl: string, token?: string) {
    this.baseUrl = registryUrl.replace(/\/$/, "") + "/api/v1";
    this.token = token;
  }

  async health(): Promise<ApiResponse<{ status: string; version: string }>> {
    return this.get("/health");
  }

  async capabilities(): Promise<ApiResponse<RegistryCapabilities>> {
    return this.get("/capabilities");
  }

  async searchLibraries(
    query: string,
    cursor?: string,
  ): Promise<ApiResponse<Library[]>> {
    const params = new URLSearchParams({ query });
    if (cursor) params.set("cursor", cursor);
    return this.get(`/libraries?${params}`);
  }

  async getLibrary(
    namespace: string,
    name: string,
  ): Promise<ApiResponse<Library>> {
    return this.get(`/libraries/${namespace}/${name}`);
  }

  async getVersions(
    namespace: string,
    name: string,
    cursor?: string,
  ): Promise<ApiResponse<Version[]>> {
    const params = cursor ? `?cursor=${cursor}` : "";
    return this.get(`/libraries/${namespace}/${name}/versions${params}`);
  }

  async getManifest(
    namespace: string,
    name: string,
    version: string,
  ): Promise<ApiResponse<Manifest>> {
    return this.get(
      `/libraries/${namespace}/${name}/versions/${version}/manifest`,
    );
  }

  async getPageIndex(
    namespace: string,
    name: string,
    version: string,
    cursor?: string,
  ): Promise<ApiResponse<PageRecord[]>> {
    const params = cursor ? `?cursor=${cursor}` : "";
    return this.get(
      `/libraries/${namespace}/${name}/versions/${version}/page-index${params}`,
    );
  }

  async getPageContent(
    namespace: string,
    name: string,
    version: string,
    pageUid: string,
  ): Promise<
    ApiResponse<{
      page_uid: string;
      path: string;
      title: string;
      url: string;
      content_md: string;
    }>
  > {
    return this.get(
      `/libraries/${namespace}/${name}/versions/${version}/pages/${pageUid}`,
    );
  }

  async resolve(
    request: ResolveRequest,
  ): Promise<ApiResponse<ResolveResponse>> {
    return this.post("/resolve", request);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Registry error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Registry error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.token) h["Authorization"] = `Token ${this.token}`;
    return h;
  }
}
