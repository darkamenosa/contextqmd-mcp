/**
 * Doc indexer — bridges local cache and QMD store.
 *
 * Indexes downloaded markdown pages into a QMD SQLite database
 * so they can be searched via FTS and (optionally) vector search.
 */

import { createStore, type Store, type SearchResult, hashContent } from "@tobilu/qmd/dist/store.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalCache } from "./local-cache.js";

export interface IndexedPage {
  pageUid: string;
  title: string;
  path: string;
}

export interface SearchOptions {
  library?: string; // namespace/name
  version?: string;
  maxResults?: number;
  mode?: "fts" | "hybrid";
}

export interface DocSearchResult {
  pageUid: string;
  title: string;
  path: string;
  score: number;
  snippet: string;
  library: string; // namespace/name
}

export class DocIndexer {
  private store: Store;
  private cache: LocalCache;

  constructor(dbPath: string, cache: LocalCache) {
    this.store = createStore(dbPath);
    this.cache = cache;
  }

  /** Close the underlying QMD store */
  close(): void {
    this.store.close();
  }

  /** Get the QMD store (for advanced operations) */
  getStore(): Store {
    return this.store;
  }

  /**
   * Build a QMD collection name from library coordinates.
   * Uses double-underscore separator because QMD splits on "/" internally.
   */
  static collectionName(namespace: string, name: string, version: string): string {
    return `${namespace}__${name}__${version}`;
  }

  /**
   * Parse a QMD collection name back to library coordinates.
   */
  static parseCollectionName(collectionName: string): { namespace: string; name: string; version: string } | null {
    const parts = collectionName.split("__");
    if (parts.length !== 3) return null;
    return { namespace: parts[0], name: parts[1], version: parts[2] };
  }

  /**
   * Index all pages for a library version from the local cache.
   */
  async indexLibraryVersion(
    namespace: string,
    name: string,
    version: string,
  ): Promise<number> {
    const collectionName = DocIndexer.collectionName(namespace, name, version);
    const pageUids = this.cache.listPageUids(namespace, name, version);

    let indexed = 0;
    for (const pageUid of pageUids) {
      const content = this.cache.readPage(namespace, name, version, pageUid);
      if (!content) continue;

      const hash = await hashContent(content);
      const now = new Date().toISOString();

      // Check if already indexed with same hash
      const existing = this.store.findActiveDocument(collectionName, `${pageUid}.md`);
      if (existing && existing.hash === hash) continue;

      // Insert or update
      this.store.insertContent(hash, content, now);
      if (existing) {
        this.store.updateDocument(existing.id, extractTitle(content, pageUid), hash, now);
      } else {
        this.store.insertDocument(
          collectionName,
          `${pageUid}.md`,
          extractTitle(content, pageUid),
          hash,
          now,
          now,
        );
      }
      indexed++;
    }

    return indexed;
  }

  /**
   * Index a single page for a library version.
   */
  async indexPage(
    namespace: string,
    name: string,
    version: string,
    pageUid: string,
    content: string,
  ): Promise<void> {
    const collName = DocIndexer.collectionName(namespace, name, version);
    const hash = await hashContent(content);
    const now = new Date().toISOString();

    const existing = this.store.findActiveDocument(collName, `${pageUid}.md`);
    if (existing && existing.hash === hash) return;

    this.store.insertContent(hash, content, now);
    if (existing) {
      this.store.updateDocument(existing.id, extractTitle(content, pageUid), hash, now);
    } else {
      this.store.insertDocument(
        collName,
        `${pageUid}.md`,
        extractTitle(content, pageUid),
        hash,
        now,
        now,
      );
    }
  }

  /**
   * Remove all indexed documents for a library version.
   */
  removeLibraryVersion(namespace: string, name: string, version: string): void {
    const collectionName = DocIndexer.collectionName(namespace, name, version);
    const paths = this.store.getActiveDocumentPaths(collectionName);
    for (const p of paths) {
      this.store.deactivateDocument(collectionName, p);
    }
  }

  /**
   * Search across installed docs using FTS.
   */
  searchFTS(query: string, options: SearchOptions = {}): DocSearchResult[] {
    const limit = options.maxResults ?? 10;

    // If both library and version specified, filter at QMD level
    let collectionFilter: string | undefined;
    if (options.library && options.version) {
      const [ns, nm] = options.library.split("/");
      collectionFilter = DocIndexer.collectionName(ns, nm, options.version);
    }
    // Otherwise filter post-search in mapResults

    const results = this.store.searchFTS(query, limit * 2, collectionFilter);
    return this.mapResults(results, options).slice(0, limit);
  }

  /**
   * Map QMD search results to our DocSearchResult format.
   */
  private mapResults(results: SearchResult[], options: SearchOptions): DocSearchResult[] {
    return results
      .filter(r => {
        if (!options.library) return true;
        // Collection name is "namespace__name__version" — parse and match
        const parsed = DocIndexer.parseCollectionName(r.collectionName);
        if (!parsed) return false;
        return `${parsed.namespace}/${parsed.name}` === options.library;
      })
      .map(r => {
        const parsed = DocIndexer.parseCollectionName(r.collectionName);
        const library = parsed ? `${parsed.namespace}/${parsed.name}` : r.collectionName;

        // displayPath is "collectionName/filename.md" — strip collection prefix
        let pageUid = r.displayPath;
        if (pageUid.startsWith(r.collectionName + "/")) {
          pageUid = pageUid.slice(r.collectionName.length + 1);
        }
        pageUid = pageUid.replace(/\.md$/, "");

        return {
          pageUid,
          title: r.title,
          path: r.displayPath,
          score: r.score,
          snippet: r.body?.slice(0, 500) ?? "",
          library,
        };
      });
  }
}

/** Extract title from markdown content (first # heading or filename) */
function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}
