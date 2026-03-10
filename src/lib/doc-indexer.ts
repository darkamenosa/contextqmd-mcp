/**
 * Doc indexer — bridges local cache and QMD store.
 *
 * Indexes downloaded markdown pages into a QMD SQLite database
 * so they can be searched via FTS and (optionally) vector/hybrid search.
 *
 * Search modes:
 *   fts    — BM25 full-text search (fast, keyword-based, always available)
 *   vector — Semantic vector search via QMD embeddings (requires indexed embeddings)
 *   hybrid — BM25 + vector + query expansion + RRF + reranking (most powerful, requires LLM)
 *   auto   — Smart routing: picks the best mode based on query characteristics
 */

import {
  createStore,
  type Store,
  hashContent,
  hybridQuery,
  vectorSearchQuery,
  type HybridQueryResult,
} from "@tobilu/qmd/dist/store.js";
import type { LocalCache } from "./local-cache.js";

export interface IndexedPage {
  pageUid: string;
  title: string;
  path: string;
}

/** Search mode for docs queries */
export type SearchMode = "fts" | "vector" | "hybrid" | "auto";

export interface SearchOptions {
  library?: string; // namespace/name
  version?: string;
  maxResults?: number;
  mode?: SearchMode;
}

export interface DocSearchResult {
  pageUid: string;
  title: string;
  path: string;
  score: number;
  snippet: string;
  library: string; // namespace/name
  version: string;
  searchMode: SearchMode; // which mode was actually used
}

/**
 * Classify a query to pick the best search mode.
 *
 * Heuristics:
 *   - Exact symbols, config keys, error messages, code patterns → FTS (precise lexical match)
 *   - Conceptual/how-to/fuzzy questions → vector (semantic similarity)
 *   - Broad multi-aspect queries → hybrid (combines both + reranking)
 *   - Default → FTS (cheapest, always available)
 */
export function classifyQuery(query: string): SearchMode {
  const q = query.trim();

  // Very short queries (1-2 tokens) are best served by FTS
  if (q.split(/\s+/).length <= 2 && !q.includes("?")) {
    return "fts";
  }

  // Code patterns: camelCase, snake_case, dot.notation, backticks, error codes
  const codePatterns = [
    /[a-z][A-Z]/,                           // camelCase
    /[a-z]_[a-z]/,                           // snake_case
    /\w+\.\w+\.\w+/,                         // dot.notation (config keys)
    /`[^`]+`/,                               // backticked code
    /^[A-Z_]{3,}$/,                          // ALL_CAPS constant
    /\berr(or)?[:\s]+/i,                     // error messages
    /\d+\.\d+\.\d+/,                         // version numbers
    /[{}()\[\]<>]/,                           // brackets/braces
    /^(get|set|use|create|delete|update)\w+/i, // API method names
    /\w+::\w+/,                              // namespace::method
    /\w+\/\w+/,                              // path-like
  ];

  if (codePatterns.some(p => p.test(q))) {
    return "fts";
  }

  // Conceptual/how-to patterns → vector search
  const conceptualPatterns = [
    /^(how|what|why|when|where|can|should|is it|does)\b/i,
    /\b(best practice|pattern|approach|strategy|concept|overview|guide)\b/i,
    /\b(difference between|compare|vs\.?|versus)\b/i,
    /\b(explain|understand|learn|tutorial)\b/i,
  ];

  if (conceptualPatterns.some(p => p.test(q))) {
    // Long conceptual queries benefit from hybrid
    if (q.split(/\s+/).length >= 6) {
      return "hybrid";
    }
    return "vector";
  }

  // Multi-aspect queries (long, multiple topics) → hybrid
  if (q.split(/\s+/).length >= 8) {
    return "hybrid";
  }

  // Default: FTS is cheapest and always works
  return "fts";
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
   * Unified search dispatcher. Routes to the appropriate search backend
   * based on the mode (or auto-selects).
   */
  async search(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    // Warn when version is specified without library — the QMD-level collection
    // filter requires both, so version filtering falls back to post-query filtering
    // which is less efficient (fetches more results then discards).
    if (options.version && !options.library) {
      console.warn(
        `[contextqmd] version filter "${options.version}" specified without library — ` +
        `version will be applied as a post-query filter`,
      );
    }

    const requestedMode = options.mode ?? "auto";
    const effectiveMode = requestedMode === "auto" ? classifyQuery(query) : requestedMode;

    // Vector and hybrid modes require embeddings to be present.
    // If they're not available, fall back to FTS gracefully.
    if (effectiveMode === "vector") {
      const results = await this.searchVector(query, options);
      if (results.length > 0) return results;
      // Fallback to FTS if vector returned nothing (no embeddings indexed)
      return this.searchFTS(query, options).map(r => ({ ...r, searchMode: "fts" as SearchMode }));
    }

    if (effectiveMode === "hybrid") {
      const results = await this.searchHybrid(query, options);
      if (results.length > 0) return results;
      // Fallback to FTS if hybrid returned nothing
      return this.searchFTS(query, options).map(r => ({ ...r, searchMode: "fts" as SearchMode }));
    }

    return this.searchFTS(query, options);
  }

  /**
   * Search across installed docs using FTS (BM25).
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
    return this.mapAnyResults(results, options, "fts").slice(0, limit);
  }

  /**
   * Search using QMD vector search (semantic similarity).
   * Returns empty array if no embeddings are indexed.
   */
  async searchVector(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const limit = options.maxResults ?? 10;

    let collectionFilter: string | undefined;
    if (options.library && options.version) {
      const [ns, nm] = options.library.split("/");
      collectionFilter = DocIndexer.collectionName(ns, nm, options.version);
    }

    try {
      const results = await withTimeout(
        vectorSearchQuery(this.store, query, {
          collection: collectionFilter,
          limit: limit * 2,
        }),
        10_000,
      );
      return this.mapAnyResults(results, options, "vector").slice(0, limit);
    } catch {
      // Vector search failed, timed out, or no embeddings — return empty
      return [];
    }
  }

  /**
   * Search using QMD hybrid query (BM25 + vector + expansion + reranking).
   * Falls back gracefully if LLM/embeddings are not available.
   * Includes a timeout to prevent hanging when LLM model loading is slow.
   */
  async searchHybrid(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const limit = options.maxResults ?? 10;

    let collectionFilter: string | undefined;
    if (options.library && options.version) {
      const [ns, nm] = options.library.split("/");
      collectionFilter = DocIndexer.collectionName(ns, nm, options.version);
    }

    try {
      // Timeout hybrid query at 10s — LLM model loading can hang
      const results = await withTimeout(
        hybridQuery(this.store, query, {
          collection: collectionFilter,
          limit,
        }),
        10_000,
      );
      return this.mapAnyResults<HybridQueryResult>(results, options, "hybrid",
        (r) => r.bestChunk?.slice(0, 500) ?? r.body?.slice(0, 500) ?? "",
      ).slice(0, limit);
    } catch {
      // Hybrid search failed or timed out — return empty (caller will fall back to FTS)
      return [];
    }
  }

  /**
   * Shared mapper: convert any QMD result type to DocSearchResult[].
   *
   * Extracts the collection name from `collectionName` (FTS results) or by
   * parsing the first segment of `displayPath` (vector/hybrid results).
   * Applies library and version post-filters, and extracts a snippet using
   * the `snippetFn` callback for mode-specific snippet logic.
   */
  private mapAnyResults<T extends { displayPath: string; title: string; score: number; body?: string }>(
    results: T[],
    options: SearchOptions,
    mode: SearchMode,
    snippetFn: (r: T) => string = (r) => r.body?.slice(0, 500) ?? "",
  ): DocSearchResult[] {
    return results
      .map(r => {
        // Prefer collectionName directly (available on FTS SearchResult);
        // fall back to parsing the first segment of displayPath (vector/hybrid).
        const collName = (r as { collectionName?: string }).collectionName
          ?? r.displayPath.split("/")[0];
        const parsed = DocIndexer.parseCollectionName(collName);
        const library = parsed ? `${parsed.namespace}/${parsed.name}` : collName;

        // Strip collection prefix from displayPath to get pageUid
        let pageUid = r.displayPath;
        if (pageUid.startsWith(collName + "/")) {
          pageUid = pageUid.slice(collName.length + 1);
        }
        pageUid = pageUid.replace(/\.md$/, "");

        return {
          pageUid,
          title: r.title,
          path: r.displayPath,
          score: r.score,
          snippet: snippetFn(r),
          library,
          searchMode: mode,
          _version: parsed?.version,
        };
      })
      .filter(r => {
        // Library filter
        if (options.library && r.library !== options.library) return false;
        // Version filter (works with or without library filter)
        if (options.version && r._version !== options.version) return false;
        return true;
      })
      .map(({ _version, ...rest }) => ({ ...rest, version: _version ?? "unknown" }));
  }
}

/** Race a promise against a timeout. Rejects with an error if timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Extract title from markdown content (first # heading or filename) */
function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}
