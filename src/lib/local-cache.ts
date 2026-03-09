/**
 * Local cache manager for ContextQMD.
 *
 * Manages the local filesystem cache at ~/.cache/contextqmd/
 * Layout:
 *   docs/{namespace}/{name}/{version}/pages/{page_uid}.md
 *   docs/{namespace}/{name}/{version}/manifest.json
 *   docs/{namespace}/{name}/{version}/page-index.json
 *   state/installed.json
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface InstalledLibrary {
  namespace: string;
  name: string;
  version: string;
  profile: "slim" | "full";
  installed_at: string;
  manifest_checksum: string | null;
  page_count: number;
  pinned: boolean;
}

export interface InstalledState {
  libraries: InstalledLibrary[];
}

export class LocalCache {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    mkdirSync(join(this.cacheDir, "docs"), { recursive: true });
    mkdirSync(join(this.cacheDir, "state"), { recursive: true });
  }

  /** Get the docs directory for a specific library version */
  docsDir(namespace: string, name: string, version: string): string {
    return join(this.cacheDir, "docs", namespace, name, version);
  }

  /** Get the pages directory for a specific library version */
  pagesDir(namespace: string, name: string, version: string): string {
    return join(this.docsDir(namespace, name, version), "pages");
  }

  /** Save manifest JSON for a library version */
  saveManifest(namespace: string, name: string, version: string, manifest: unknown): void {
    const dir = this.docsDir(namespace, name, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  /** Save page-index JSON for a library version */
  savePageIndex(namespace: string, name: string, version: string, pageIndex: unknown): void {
    const dir = this.docsDir(namespace, name, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page-index.json"), JSON.stringify(pageIndex, null, 2));
  }

  /** Save a page as markdown file */
  savePage(namespace: string, name: string, version: string, pageUid: string, content: string): void {
    const dir = this.pagesDir(namespace, name, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pageUid}.md`), content);
  }

  /** Read a page from local cache */
  readPage(namespace: string, name: string, version: string, pageUid: string): string | null {
    const path = join(this.pagesDir(namespace, name, version), `${pageUid}.md`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  }

  /** Check if a library version is installed (has manifest) */
  hasManifest(namespace: string, name: string, version: string): boolean {
    return existsSync(join(this.docsDir(namespace, name, version), "manifest.json"));
  }

  /** Count locally stored pages for a version */
  countPages(namespace: string, name: string, version: string): number {
    const dir = this.pagesDir(namespace, name, version);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(f => f.endsWith(".md")).length;
  }

  /** List all page UIDs stored locally */
  listPageUids(namespace: string, name: string, version: string): string[] {
    const dir = this.pagesDir(namespace, name, version);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(/\.md$/, ""));
  }

  /** Remove a library version from local cache */
  removeVersion(namespace: string, name: string, version: string): void {
    const dir = this.docsDir(namespace, name, version);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  }

  // ─── Installed state persistence ─────────────────────────────────

  private statePath(): string {
    return join(this.cacheDir, "state", "installed.json");
  }

  loadState(): InstalledState {
    const path = this.statePath();
    if (!existsSync(path)) return { libraries: [] };
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  saveState(state: InstalledState): void {
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2));
  }

  findInstalled(namespace: string, name: string, version?: string): InstalledLibrary | undefined {
    const state = this.loadState();
    return state.libraries.find(
      lib => lib.namespace === namespace && lib.name === name && (!version || lib.version === version),
    );
  }

  addInstalled(lib: InstalledLibrary): void {
    const state = this.loadState();
    // Remove existing entry for same lib+version
    state.libraries = state.libraries.filter(
      l => !(l.namespace === lib.namespace && l.name === lib.name && l.version === lib.version),
    );
    state.libraries.push(lib);
    this.saveState(state);
  }

  removeInstalled(namespace: string, name: string, version: string): void {
    const state = this.loadState();
    state.libraries = state.libraries.filter(
      l => !(l.namespace === namespace && l.name === name && l.version === version),
    );
    this.saveState(state);
  }

  listInstalled(): InstalledLibrary[] {
    return this.loadState().libraries;
  }
}
