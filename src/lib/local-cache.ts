/**
 * Local cache manager for ContextQMD.
 *
 * Manages the local filesystem cache at ~/.cache/contextqmd/
 * Layout:
 *   docs/{slug}/{version}/pages/{page_uid}.md
 *   docs/{slug}/{version}/manifest.json
 *   docs/{slug}/{version}/page-index.json
 *   state/installed.json
 */

import {
  Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PageRecord } from "./types.js";

export interface InstalledLibrary {
  slug: string;
  version: string;
  profile: "slim" | "full";
  installed_at: string;
  manifest_checksum: string | null;
  page_count: number;
  pinned?: boolean;
  index_schema_version?: number;
}

export interface InstalledState {
  libraries: InstalledLibrary[];
}

export function normalizeDocPath(docPath: string): string {
  const trimmed = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function normalizePageUid(pageUid: string): string {
  const trimmed = pageUid.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.split("/").includes("..")) {
    throw new Error(`Unsafe page_uid: ${pageUid}`);
  }
  return trimmed;
}

export class LocalCache {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    mkdirSync(join(this.cacheDir, "docs"), { recursive: true });
    mkdirSync(join(this.cacheDir, "state"), { recursive: true });
    mkdirSync(join(this.cacheDir, "tmp"), { recursive: true });
  }

  /** Get the docs directory for a specific library version */
  docsDir(slug: string, version: string): string {
    return join(this.cacheDir, "docs", slug, version);
  }

  /** Get the pages directory for a specific library version */
  pagesDir(slug: string, version: string): string {
    return join(this.docsDir(slug, version), "pages");
  }

  /** Save manifest JSON for a library version */
  saveManifest(slug: string, version: string, manifest: unknown): void {
    const dir = this.docsDir(slug, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  /** Save page-index JSON for a library version */
  savePageIndex(slug: string, version: string, pageIndex: unknown): void {
    const dir = this.docsDir(slug, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page-index.json"), JSON.stringify(pageIndex, null, 2));
  }

  /** Load page-index JSON for a library version */
  loadPageIndex(slug: string, version: string): PageRecord[] {
    const path = join(this.docsDir(slug, version), "page-index.json");
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf-8")) as PageRecord[];
  }

  /** Resolve a page metadata record by page UID */
  findPageByUid(slug: string, version: string, pageUid: string): PageRecord | null {
    return this.loadPageIndex(slug, version)
      .find(page => page.page_uid === pageUid) ?? null;
  }

  /** Resolve a page metadata record by canonical doc path */
  findPageByPath(slug: string, version: string, docPath: string): PageRecord | null {
    const normalized = normalizeDocPath(docPath);
    return this.loadPageIndex(slug, version)
      .find(page => normalizeDocPath(page.path) === normalized) ?? null;
  }

  /** Save a page as markdown file */
  savePage(slug: string, version: string, pageUid: string, content: string): void {
    const path = this.pagePath(slug, version, pageUid);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  /** Read a page from local cache */
  readPage(slug: string, version: string, pageUid: string): string | null {
    const path = this.pagePath(slug, version, pageUid);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  }

  /** Check if a library version is installed (has manifest) */
  hasManifest(slug: string, version: string): boolean {
    return existsSync(join(this.docsDir(slug, version), "manifest.json"));
  }

  /** Count locally stored pages for a version */
  countPages(slug: string, version: string): number {
    const pageIndex = this.loadPageIndex(slug, version);
    if (pageIndex.length > 0) return pageIndex.length;

    const dir = this.pagesDir(slug, version);
    if (!existsSync(dir)) return 0;
    return this.collectMarkdownFiles(dir).length;
  }

  /** List all page UIDs stored locally */
  listPageUids(slug: string, version: string): string[] {
    const pageIndex = this.loadPageIndex(slug, version);
    if (pageIndex.length > 0) return pageIndex.map(page => page.page_uid);

    const dir = this.pagesDir(slug, version);
    if (!existsSync(dir)) return [];
    return this.collectMarkdownFiles(dir).map(file => file.replace(/\.md$/, ""));
  }

  /** Remove a library version from local cache */
  removeVersion(slug: string, version: string): void {
    const dir = this.docsDir(slug, version);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  createTempInstallDir(slug: string, version: string): string {
    const prefix = `${slug}-${version}-`.replace(/[^a-zA-Z0-9._-]/g, "-");
    return mkdtempSync(join(this.cacheDir, "tmp", prefix));
  }

  createTempArchivePath(slug: string, version: string, filename = "bundle.tar.gz"): string {
    const dir = this.createTempInstallDir(slug, version);
    return join(dir, filename);
  }

  commitStagedVersion(slug: string, version: string, stagedDocsDir: string): void {
    const finalDir = this.docsDir(slug, version);
    const parentDir = join(this.cacheDir, "docs", slug);
    mkdirSync(parentDir, { recursive: true });

    if (existsSync(finalDir)) {
      rmSync(finalDir, { recursive: true, force: true });
    }

    renameSync(stagedDocsDir, finalDir);
  }

  backupVersion(slug: string, version: string): string | null {
    const finalDir = this.docsDir(slug, version);
    if (!existsSync(finalDir)) return null;

    const backupRoot = this.createTempInstallDir(slug, version);
    const backupDir = join(backupRoot, "docs");
    renameSync(finalDir, backupDir);
    return backupDir;
  }

  restoreVersionFromBackup(slug: string, version: string, backupDir: string): void {
    const finalDir = this.docsDir(slug, version);
    const parentDir = join(this.cacheDir, "docs", slug);

    if (existsSync(finalDir)) {
      rmSync(finalDir, { recursive: true, force: true });
    }

    if (existsSync(backupDir)) {
      mkdirSync(parentDir, { recursive: true });
      renameSync(backupDir, finalDir);
    }

    this.cleanupTempPath(dirname(backupDir));
  }

  discardBackup(backupDir: string): void {
    this.cleanupTempPath(dirname(backupDir));
  }

  cleanupTempPath(path: string): void {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
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

  findInstalled(slug: string, version?: string): InstalledLibrary | undefined {
    const state = this.loadState();
    return state.libraries.find(
      lib => lib.slug === slug && (!version || lib.version === version),
    );
  }

  addInstalled(lib: InstalledLibrary): void {
    const state = this.loadState();
    // Remove existing entry for same lib+version
    state.libraries = state.libraries.filter(
      l => !(l.slug === lib.slug && l.version === lib.version),
    );
    state.libraries.push(lib);
    this.saveState(state);
  }

  removeInstalled(slug: string, version: string): void {
    const state = this.loadState();
    state.libraries = state.libraries.filter(
      l => !(l.slug === slug && l.version === version),
    );
    this.saveState(state);
  }

  listInstalled(): InstalledLibrary[] {
    return this.loadState().libraries;
  }

  private pagePath(slug: string, version: string, pageUid: string): string {
    return join(this.pagesDir(slug, version), `${normalizePageUid(pageUid)}.md`);
  }

  private collectMarkdownFiles(path: string, relativeDir = ""): string[] {
    const files: string[] = [];

    for (const entry of readdirSync(path, { withFileTypes: true }) as Dirent[]) {
      const nextRelative = relativeDir ? join(relativeDir, entry.name) : entry.name;
      const nextPath = join(path, entry.name);

      if (entry.isDirectory()) {
        files.push(...this.collectMarkdownFiles(nextPath, nextRelative));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(nextRelative.replace(/\\/g, "/"));
      }
    }

    return files;
  }
}
