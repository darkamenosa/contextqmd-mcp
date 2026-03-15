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

import { createHash } from "node:crypto";
import {
  createStore,
  extractSnippet,
  type HybridQueryResult,
  type InternalStore,
  type QMDStore,
  type SearchResult,
} from "@tobilu/qmd";
import { normalizeDocPath, type LocalCache } from "./local-cache.js";

export interface IndexedPage {
  pageUid: string;
  title: string;
  path: string;
}

/** Search mode for docs queries */
export type SearchMode = "fts" | "vector" | "hybrid" | "auto";

export interface SearchOptions {
  library?: string; // canonical slug
  version?: string;
  maxResults?: number;
  mode?: SearchMode;
}

export interface DocSearchResult {
  pageUid: string;
  title: string;
  path: string;
  docPath: string;
  contentMd: string;
  score: number;
  snippet: string;
  library: string; // canonical slug
  version: string;
  searchMode: SearchMode; // which mode was actually used
  lineStart: number | null;
  lineEnd: number | null;
  url?: string;
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
  private storePromise: Promise<QMDStore>;
  private cache: LocalCache;

  constructor(dbPath: string, cache: LocalCache) {
    this.storePromise = createStore({
      dbPath,
      config: { collections: {} },
    });
    this.cache = cache;
  }

  /** Close the underlying QMD store */
  async close(): Promise<void> {
    const store = await this.storePromise;
    await store.close();
  }

  /** Get the QMD store (for advanced operations) */
  async getStore(): Promise<InternalStore> {
    return (await this.storePromise).internal;
  }

  /**
   * Build a QMD collection name from canonical library coordinates.
   * Uses double-underscore separator because QMD splits on "/" internally.
   */
  static collectionName(slug: string, version: string): string {
    return `${slug}__${version}`;
  }

  /**
   * Parse a QMD collection name back to library coordinates.
   */
  static parseCollectionName(collectionName: string): { slug: string; version: string } | null {
    const parts = collectionName.split("__");
    if (parts.length !== 2) return null;
    return { slug: parts[0], version: parts[1] };
  }

  /**
   * Index all pages for a library version from the local cache.
   */
  async indexLibraryVersion(
    slug: string,
    version: string,
  ): Promise<number> {
    const store = await this.getStore();
    const collectionName = DocIndexer.collectionName(slug, version);
    const pageUids = this.cache.listPageUids(slug, version);
    const desiredPaths = new Set<string>();

    let indexed = 0;
    for (const pageUid of pageUids) {
      const content = this.cache.readPage(slug, version, pageUid);
      if (!content) continue;

      const page = this.cache.findPageByUid(slug, version, pageUid);
      const docPath = page ? normalizeDocPath(page.path) : `${pageUid}.md`;
      desiredPaths.add(docPath);
      const title = page?.title ?? extractTitle(content, pageUid);
      const hash = await hashContent(content);
      const now = new Date().toISOString();
      const legacyPath = `${pageUid}.md`;

      // Check if already indexed with same hash
      const existing = store.findActiveDocument(collectionName, docPath);
      const legacyExisting = docPath === legacyPath
        ? existing
        : store.findActiveDocument(collectionName, legacyPath);

      if (existing && existing.hash === hash) continue;
      if (!existing && legacyExisting && legacyExisting.hash === hash) {
        store.insertDocument(collectionName, docPath, title, legacyExisting.hash, now, now);
        if (legacyPath !== docPath) {
          store.deactivateDocument(collectionName, legacyPath);
        }
        indexed++;
        continue;
      }

      // Insert or update
      store.insertContent(hash, content, now);
      if (existing) {
        store.updateDocument(existing.id, title, hash, now);
      } else {
        store.insertDocument(
          collectionName,
          docPath,
          title,
          hash,
          now,
          now,
        );
        if (legacyExisting && legacyPath !== docPath) {
          store.deactivateDocument(collectionName, legacyPath);
        }
      }
      indexed++;
    }

    for (const activePath of store.getActiveDocumentPaths(collectionName)) {
      if (!desiredPaths.has(activePath)) {
        store.deactivateDocument(collectionName, activePath);
      }
    }

    return indexed;
  }

  /**
   * Index a single page for a library version.
   */
  async indexPage(
    slug: string,
    version: string,
    pageUid: string,
    content: string,
  ): Promise<void> {
    const store = await this.getStore();
    const collName = DocIndexer.collectionName(slug, version);
    const page = this.cache.findPageByUid(slug, version, pageUid);
    const docPath = page ? normalizeDocPath(page.path) : `${pageUid}.md`;
    const title = page?.title ?? extractTitle(content, pageUid);
    const hash = await hashContent(content);
    const now = new Date().toISOString();
    const legacyPath = `${pageUid}.md`;

    const existing = store.findActiveDocument(collName, docPath);
    const legacyExisting = docPath === legacyPath
      ? existing
      : store.findActiveDocument(collName, legacyPath);
    if (existing && existing.hash === hash) return;
    if (!existing && legacyExisting && legacyExisting.hash === hash) {
      store.insertDocument(collName, docPath, title, legacyExisting.hash, now, now);
      if (legacyPath !== docPath) {
        store.deactivateDocument(collName, legacyPath);
      }
      return;
    }

    store.insertContent(hash, content, now);
    if (existing) {
      store.updateDocument(existing.id, title, hash, now);
    } else {
      store.insertDocument(
        collName,
        docPath,
        title,
        hash,
        now,
        now,
      );
      if (legacyExisting && legacyPath !== docPath) {
        store.deactivateDocument(collName, legacyPath);
      }
    }
  }

  /**
   * Remove all indexed documents for a library version.
   */
  async removeLibraryVersion(slug: string, version: string): Promise<void> {
    const store = await this.getStore();
    const collectionName = DocIndexer.collectionName(slug, version);
    const paths = store.getActiveDocumentPaths(collectionName);
    for (const p of paths) {
      store.deactivateDocument(collectionName, p);
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
    const searchMode = !options.library && effectiveMode !== "fts" ? "fts" : effectiveMode;

    // Vector and hybrid modes require embeddings to be present.
    // If they're not available, fall back to FTS gracefully.
    if (searchMode === "vector") {
      const results = await this.searchVector(query, options);
      if (results.length > 0) return results;
      // Fallback to FTS if vector returned nothing (no embeddings indexed)
      return (await this.searchFTS(query, options)).map(r => ({ ...r, searchMode: "fts" as SearchMode }));
    }

    if (searchMode === "hybrid") {
      const results = await this.searchHybrid(query, options);
      if (results.length > 0) return results;
      // Fallback to FTS if hybrid returned nothing
      return (await this.searchFTS(query, options)).map(r => ({ ...r, searchMode: "fts" as SearchMode }));
    }

    return this.searchFTS(query, options);
  }

  /**
   * Search across installed docs using FTS (BM25).
   */
  async searchFTS(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const store = await this.getStore();
    const limit = options.maxResults ?? 10;

    // If both library and version specified, filter at QMD level
    let collectionFilter: string | undefined;
    if (options.library && options.version) {
      collectionFilter = DocIndexer.collectionName(options.library, options.version);
    }
    // Otherwise filter post-search in mapResults

    const results = store.searchFTS(query, limit * 2, collectionFilter);
    return this.mapAnyResults(results, query, options, "fts").slice(0, limit);
  }

  /**
   * Search using QMD vector search (semantic similarity).
   * Returns empty array if no embeddings are indexed.
   */
  async searchVector(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const store = await this.storePromise;
    const limit = options.maxResults ?? 10;

    let collectionFilter: string | undefined;
    if (options.library && options.version) {
      collectionFilter = DocIndexer.collectionName(options.library, options.version);
    }

    try {
      const results = await withTimeout(
        store.searchVector(query, {
          collection: collectionFilter,
          limit: limit * 2,
        }),
        10_000,
      );
      return this.mapAnyResults(results, query, options, "vector").slice(0, limit);
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
    const store = await this.storePromise;
    const limit = options.maxResults ?? 10;

    let collectionFilter: string | undefined;
    if (options.library && options.version) {
      collectionFilter = DocIndexer.collectionName(options.library, options.version);
    }

    try {
      // Timeout hybrid query at 10s — LLM model loading can hang
      const results = await withTimeout(
        store.search({
          query,
          collection: collectionFilter,
          limit,
        }),
        10_000,
      );
      return this.mapAnyResults<HybridQueryResult>(results, query, options, "hybrid",
        (r) => this.extractSnippetInfo(r.body ?? "", query, r.bestChunkPos),
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
    query: string,
    options: SearchOptions,
    mode: SearchMode,
    snippetFn: (r: T) => SearchSnippet = (r) => this.extractSnippetInfo(r.body ?? "", query, (r as { chunkPos?: number }).chunkPos),
  ): DocSearchResult[] {
    return results
      .map(r => {
        // Prefer collectionName directly (available on FTS SearchResult);
        // fall back to parsing the first segment of displayPath (vector/hybrid).
        const collName = (r as { collectionName?: string }).collectionName
          ?? r.displayPath.split("/")[0];
        const parsed = DocIndexer.parseCollectionName(collName);
        const library = parsed ? parsed.slug : collName;

        let docPath = r.displayPath;
        if (docPath.startsWith(collName + "/")) {
          docPath = docPath.slice(collName.length + 1);
        }
        docPath = normalizeDocPath(docPath);
        const page = parsed ? this.cache.findPageByPath(parsed.slug, parsed.version, docPath) : null;
        const pageUid = page?.page_uid ?? docPath.replace(/\.md$/, "");
        const contentMd = parsed ? (this.cache.readPage(parsed.slug, parsed.version, pageUid) ?? r.body ?? "") : (r.body ?? "");
        const snippet = snippetFn(r);

        return {
          pageUid,
          title: page?.title ?? r.title,
          path: r.displayPath,
          docPath,
          contentMd,
          score: r.score,
          snippet: snippet.snippet,
          library,
          searchMode: mode,
          _version: parsed?.version,
          lineStart: snippet.lineStart,
          lineEnd: snippet.lineEnd,
          url: page?.url,
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

  private extractSnippetInfo(body: string, query: string, chunkPos?: number): SearchSnippet {
    if (!body.trim()) {
      return { snippet: "", lineStart: null, lineEnd: null };
    }

    const { snippet, line, snippetLines } = extractSnippet(body, query, 500, chunkPos);
    if (!line || line < 1) {
      return { snippet, lineStart: null, lineEnd: null };
    }

    return {
      snippet,
      lineStart: line,
      lineEnd: line + Math.max(snippetLines - 1, 0),
    };
  }
}

type SearchSnippet = {
  snippet: string;
  lineStart: number | null;
  lineEnd: number | null;
};

async function hashContent(content: string): Promise<string> {
  return createHash("sha256").update(content).digest("hex");
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
