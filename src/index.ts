#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Command } from "commander";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { RegistryClient } from "./lib/registry-client.js";
import { LocalCache, normalizeDocPath } from "./lib/local-cache.js";
import { DocIndexer, type SearchMode } from "./lib/doc-indexer.js";
import type { Manifest, ManifestBundle, PageRecord } from "./lib/types.js";

const VERSION = "0.1.0";
const DOC_INDEX_SCHEMA_VERSION = 2;
const DEFAULT_EXCERPT_MAX_LINES = 60;
const DEFAULT_EXPAND_BEFORE = 30;
const DEFAULT_EXPAND_AFTER = 60;
const LOCAL_DOCS_VERSION = "local";

export interface ServerDeps {
  registryClient: RegistryClient;
  cache: LocalCache;
  indexer: DocIndexer;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function structuredTextResult(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function errorResult(text: string, code: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
    structuredContent: {
      error: {
        code,
        ...details,
      },
    },
  };
}

function isLocalDocsInstall(installed: { source_kind?: string; version: string }): boolean {
  return installed.source_kind === "local" || installed.version === LOCAL_DOCS_VERSION;
}

function isRegistryInstall(installed: { source_kind?: string; version: string }): boolean {
  return !isLocalDocsInstall(installed);
}

type SearchDocsInput = {
  query: string;
  library?: string;
  version?: string;
  max_results?: number;
  mode?: SearchMode;
};

type SearchLibrariesInput = {
  query: string;
  limit?: number;
};

type InstallDocsInput = {
  library: string;
  version?: string;
};

type GetDocInput = {
  library: string;
  version?: string;
  doc_path?: string;
  page_uid?: string;
  from_line?: number;
  max_lines?: number;
  around_line?: number;
  before?: number;
  after?: number;
  line_numbers?: boolean;
};

type ResolvedCachedPage = {
  library: string;
  version: string;
  pageUid: string;
  docPath: string;
  title: string;
  url?: string;
  content: string | null;
  hydrationState: "ready" | "missing_content";
};

type InstallMethod = "bundle" | "page_fallback";

type SearchLibraryCandidate = {
  library: string;
  display_name: string;
  aliases: string[];
  homepage_url: string;
  default_version: string;
  source_type?: string | null;
  license_status?: "verified" | "unclear" | "custom" | null;
  version_count: number | null;
  versions: string[];
  installed_versions: string[];
  installed: boolean;
};

type InstallOutcome = {
  installMethod: InstallMethod;
  profile: "full" | "slim";
  pageCount: number;
  indexedCount: number;
  manifestChecksum: string | null;
  bundleFormat?: string;
  totalPages?: number;
  bundleFallbackReason?: string;
};

const LIBRARY_SLUG_PATTERN = /^[a-z0-9-]+$/;

function normalizeLibrarySlug(library: string): string | null {
  const normalized = library.trim();
  return LIBRARY_SLUG_PATTERN.test(normalized) ? normalized : null;
}

function normalizeSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("sha256:") ? normalized.slice("sha256:".length) : normalized;
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function installedVersions(cache: LocalCache, slug: string): string[] {
  return cache
    .listInstalled()
    .filter(lib => lib.slug === slug)
    .map(lib => lib.version)
    .sort();
}

function isSupportedBundle(bundle: ManifestBundle): boolean {
  const format = bundle.format.trim().toLowerCase();
  return (
    format === "tar.gz" ||
    format === "tgz" ||
    format === "tar+gzip" ||
    format === "application/gzip" ||
    format === "application/x-gzip" ||
    bundle.url.endsWith(".tar.gz") ||
    bundle.url.endsWith(".tgz")
  );
}

function selectBundle(manifest: Manifest): { profile: "full" | "slim"; bundle: ManifestBundle } | null {
  for (const profile of ["full", "slim"] as const) {
    const bundle = manifest.profiles[profile]?.bundle;
    if (bundle && isSupportedBundle(bundle)) {
      return { profile, bundle };
    }
  }

  return null;
}

function bundleArchiveFilename(
  slug: string,
  version: string,
  profile: "full" | "slim",
  bundle: ManifestBundle,
): string {
  const suffix = bundle.url.endsWith(".tgz") ? ".tgz" : ".tar.gz";
  return `${slug}-${version}-${profile}${suffix}`;
}

type BundleArchiveEntry = {
  kind: string;
  path: string;
};

function listBundleEntries(archivePath: string): BundleArchiveEntry[] {
  const result = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to inspect bundle archive: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Failed to inspect bundle archive: ${result.stderr.trim() || "tar exited non-zero"}`);
  }

  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const kind = line[0] ?? "";
      const parts = line.split(/\s+/);
      const path = parts.slice(8).join(" ").replace(/^\.\//, "");
      return { kind, path };
    })
    .filter(entry => entry.path.length > 0);
}

function ensureSafeBundleEntries(entries: BundleArchiveEntry[]): void {
  for (const entry of entries) {
    const normalized = posix.normalize(entry.path);
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized.startsWith("/")
    ) {
      throw new Error(`Unsafe bundle entry: ${entry.path}`);
    }

    if (entry.kind !== "-" && entry.kind !== "d") {
      throw new Error(`Unsupported bundle entry type for ${entry.path}`);
    }
  }
}

function extractBundleArchive(archivePath: string, destinationDir: string): void {
  const entries = listBundleEntries(archivePath);
  ensureSafeBundleEntries(entries);

  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destinationDir], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to extract bundle archive: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Failed to extract bundle archive: ${result.stderr.trim() || "tar exited non-zero"}`);
  }
}

function resolveExtractedDocsDir(extractionRoot: string): string {
  if (existsSync(join(extractionRoot, "manifest.json"))) {
    return extractionRoot;
  }

  const dirs = readdirSync(extractionRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(extractionRoot, entry.name));

  if (dirs.length === 1 && existsSync(join(dirs[0], "manifest.json"))) {
    return dirs[0];
  }

  throw new Error("Bundle archive did not extract to the expected docs layout");
}

function bundlePageEntry(pageUid: string): string {
  const normalized = pageUid.trim();
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe bundle page_uid: ${pageUid}`);
  }

  return `${normalized}.md`;
}

function expectedBundlePageEntry(page: PageRecord): string {
  const bundlePath = page.bundle_path?.trim();
  if (bundlePath) {
    const normalized = posix.normalize(bundlePath);
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized.startsWith("/") ||
      !normalized.endsWith(".md")
    ) {
      throw new Error(`Unsafe bundle page path: ${bundlePath}`);
    }

    return normalized;
  }

  return bundlePageEntry(page.page_uid);
}

function materializeLocalPageLayout(stagedDocsDir: string, pageIndex: PageRecord[]): void {
  const pagesDir = join(stagedDocsDir, "pages");

  for (const page of pageIndex) {
    const sourcePath = join(pagesDir, expectedBundlePageEntry(page));
    const targetPath = join(pagesDir, bundlePageEntry(page.page_uid));

    if (sourcePath === targetPath) continue;

    mkdirSync(dirname(targetPath), { recursive: true });
    renameSync(sourcePath, targetPath);
  }
}

function assertSafeExtractedTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Bundle archive contains an unsupported symlink: ${path}`);
  }
  if (!(stat.isDirectory() || stat.isFile())) {
    throw new Error(`Bundle archive contains an unsupported entry type: ${path}`);
  }

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assertSafeExtractedTree(join(path, entry.name));
  }
}

function listMarkdownFiles(path: string, relativeDir = ""): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const nextRelative = relativeDir ? join(relativeDir, entry.name) : entry.name;
    const nextPath = join(path, entry.name);

    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(nextPath, nextRelative));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(nextRelative.replace(/\\/g, "/"));
    }
  }

  return files.sort();
}

function validateExtractedBundle(stagedDocsDir: string): { pageCount: number } {
  const manifestPath = join(stagedDocsDir, "manifest.json");
  const pageIndexPath = join(stagedDocsDir, "page-index.json");
  const pagesDir = join(stagedDocsDir, "pages");

  assertSafeExtractedTree(stagedDocsDir);

  if (!existsSync(manifestPath)) {
    throw new Error("Bundle archive is missing manifest.json");
  }
  if (!existsSync(pageIndexPath)) {
    throw new Error("Bundle archive is missing page-index.json");
  }
  if (!existsSync(pagesDir)) {
    throw new Error("Bundle archive is missing pages/");
  }

  const pageIndex = JSON.parse(readFileSync(pageIndexPath, "utf8")) as PageRecord[];

  if (!Array.isArray(pageIndex)) {
    throw new Error("Bundle page-index.json is not an array");
  }

  const expectedFiles = pageIndex.map(page => expectedBundlePageEntry(page)).sort();
  const actualFiles = listMarkdownFiles(pagesDir);
  const missingFiles = expectedFiles.filter(file => !actualFiles.includes(file));
  const extraFiles = actualFiles.filter(file => !expectedFiles.includes(file));

  if (missingFiles.length > 0 || extraFiles.length > 0) {
    throw new Error(
      `Bundle archive page set does not match page-index.json (missing: ${missingFiles.join(", ") || "none"}; extra: ${extraFiles.join(", ") || "none"})`,
    );
  }

  materializeLocalPageLayout(stagedDocsDir, pageIndex);

  return { pageCount: actualFiles.length };
}

async function ensureCurrentIndexSchema(
  { cache, indexer }: ServerDeps,
  library?: string,
  version?: string,
): Promise<void> {
  const installed = cache.listInstalled().filter(lib => {
    const matchesLibrary = !library || lib.slug === library;
    const matchesVersion = !version || lib.version === version;
    return matchesLibrary && matchesVersion;
  });

  for (const lib of installed) {
    if ((lib.index_schema_version ?? 0) >= DOC_INDEX_SCHEMA_VERSION) continue;
    await indexer.removeLibraryVersion(lib.slug, lib.version);
    await indexer.indexLibraryVersion(lib.slug, lib.version);
    await indexer.embed();
    cache.addInstalled({
      ...lib,
      page_count: cache.countPages(lib.slug, lib.version),
      index_schema_version: DOC_INDEX_SCHEMA_VERSION,
    });
  }
}

function resolveCachedPage(cache: LocalCache, input: GetDocInput & { version: string }): ResolvedCachedPage | null {
  const hasDocPath = typeof input.doc_path === "string";
  const hasPageUid = typeof input.page_uid === "string";

  if ((hasDocPath ? 1 : 0) + (hasPageUid ? 1 : 0) !== 1) {
    return null;
  }

  if (hasDocPath) {
    const page = cache.findPageByPath(input.library, input.version, input.doc_path!);
    if (!page) return null;
    const content = cache.readPage(input.library, input.version, page.page_uid);
    return {
      library: input.library,
      version: input.version,
      pageUid: page.page_uid,
      docPath: normalizeDocPath(page.path),
      title: page.title,
      url: page.url,
      content,
      hydrationState: content === null ? "missing_content" : "ready",
    };
  }

  const pageUid = input.page_uid!;
  const page = cache.findPageByUid(input.library, input.version, pageUid);
  const content = cache.readPage(input.library, input.version, pageUid);
  if (!page && content === null) return null;

  return {
    library: input.library,
    version: input.version,
    pageUid,
    docPath: normalizeDocPath(page?.path ?? `${pageUid}.md`),
    title: page?.title ?? extractTitle(content ?? "", pageUid),
    url: page?.url,
    content,
    hydrationState: content === null ? "missing_content" : "ready",
  };
}

function buildExcerpt(
  page: ResolvedCachedPage,
  {
    fromLine = 1,
    maxLines = DEFAULT_EXCERPT_MAX_LINES,
    lineNumbers = false,
  }: {
    fromLine?: number;
    maxLines?: number;
    lineNumbers?: boolean;
  },
): ToolResult {
  const lines = (page.content ?? "").split("\n");
  const totalLines = lines.length;
  const clampedStart = totalLines === 0
    ? 1
    : Math.min(Math.max(Math.trunc(fromLine), 1), totalLines);
  const safeMaxLines = Math.max(Math.trunc(maxLines), 1);
  const endExclusive = totalLines === 0
    ? 0
    : Math.min(clampedStart - 1 + safeMaxLines, totalLines);
  const excerptLines = totalLines === 0
    ? []
    : lines.slice(clampedStart - 1, endExclusive);
  const renderedLines = lineNumbers
    ? excerptLines.map((line, index) => `${clampedStart + index} | ${line}`)
    : excerptLines;
  const lineEnd = excerptLines.length === 0 ? clampedStart - 1 : clampedStart + excerptLines.length - 1;

  return structuredTextResult(renderedLines.join("\n"), {
    library: page.library,
    version: page.version,
    doc_path: page.docPath,
    page_uid: page.pageUid,
    title: page.title,
    line_start: clampedStart,
    line_end: lineEnd,
    truncated: endExclusive < totalLines,
    ...(page.url ? { url: page.url } : {}),
  });
}

function resolveExcerptWindow(input: GetDocInput): { fromLine?: number; maxLines?: number } | ToolResult {
  const hasAroundLine = typeof input.around_line === "number";
  const hasFromLine = typeof input.from_line === "number";
  const hasWindowBounds = typeof input.before === "number" || typeof input.after === "number";

  if (hasAroundLine && hasFromLine) {
    return errorResult(
      "Use either around_line or from_line/max_lines, not both.",
      "INVALID_RANGE",
    );
  }

  if (!hasAroundLine && hasWindowBounds) {
    return errorResult(
      "before/after can only be used with around_line.",
      "INVALID_RANGE",
    );
  }

  if (hasAroundLine) {
    const aroundLine = Math.max(Math.trunc(input.around_line ?? 1), 1);
    const before = Math.max(Math.trunc(input.before ?? DEFAULT_EXPAND_BEFORE), 0);
    const after = Math.max(Math.trunc(input.after ?? DEFAULT_EXPAND_AFTER), 0);

    return {
      fromLine: Math.max(1, aroundLine - before),
      maxLines: before + after + 1,
    };
  }

  return {
    fromLine: input.from_line,
    maxLines: input.max_lines,
  };
}

async function installFromPageApi(
  deps: ServerDeps,
  slug: string,
  version: string,
  manifest: Manifest,
): Promise<Omit<InstallOutcome, "indexedCount" | "manifestChecksum">> {
  const { cache, registryClient } = deps;

  cache.saveManifest(slug, version, manifest);

  const allPages = await registryClient.getAllPageIndex(slug, version);
  cache.savePageIndex(slug, version, allPages);

  let downloadedCount = 0;
  for (const page of allPages) {
    const pageContent = await registryClient.getPageContent(slug, version, page.page_uid);
    cache.savePage(slug, version, page.page_uid, pageContent.data.content_md);
    downloadedCount++;
  }

  return {
    installMethod: "page_fallback",
    profile: "full",
    pageCount: downloadedCount,
    totalPages: allPages.length,
  };
}

async function installFromBundle(
  deps: ServerDeps,
  slug: string,
  version: string,
  manifest: Manifest,
  selectedBundle: { profile: "full" | "slim"; bundle: ManifestBundle },
): Promise<Omit<InstallOutcome, "indexedCount" | "manifestChecksum" | "bundleFallbackReason">> {
  const { cache, registryClient } = deps;
  const archivePath = cache.createTempArchivePath(
    slug,
    version,
    bundleArchiveFilename(slug, version, selectedBundle.profile, selectedBundle.bundle),
  );
  const archiveDir = dirname(archivePath);
  const extractionRoot = join(archiveDir, "extracted");

  try {
    const expectedSha = normalizeSha256(selectedBundle.bundle.sha256);
    let bundleBytes = await registryClient.downloadBundle(selectedBundle.bundle.url);
    let actualSha = sha256Hex(bundleBytes);

    if (expectedSha && actualSha !== expectedSha) {
      bundleBytes = await registryClient.downloadBundle(selectedBundle.bundle.url);
      actualSha = sha256Hex(bundleBytes);
      if (actualSha !== expectedSha) {
        throw new Error(`Bundle checksum mismatch for ${slug}@${version}`);
      }
    }

    writeFileSync(archivePath, bundleBytes);
    mkdirSync(extractionRoot, { recursive: true });
    extractBundleArchive(archivePath, extractionRoot);

    const stagedDocsDir = resolveExtractedDocsDir(extractionRoot);
    const { pageCount } = validateExtractedBundle(stagedDocsDir);
    writeFileSync(join(stagedDocsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    cache.commitStagedVersion(slug, version, stagedDocsDir);

    return {
      installMethod: "bundle",
      profile: selectedBundle.profile,
      pageCount,
      totalPages: pageCount,
      bundleFormat: selectedBundle.bundle.format,
    };
  } finally {
    cache.cleanupTempPath(archiveDir);
  }
}

async function installResolvedVersion(
  deps: ServerDeps,
  slug: string,
  version: string,
  manifest?: Manifest,
): Promise<InstallOutcome> {
  const { cache, indexer } = deps;
  const resolvedManifest = manifest ?? (await deps.registryClient.getManifest(slug, version)).data;
  const manifestChecksum = resolvedManifest.provenance?.manifest_checksum ?? null;
  const existingInstall = cache.findInstalled(slug, version);
  const backupDir = existingInstall ? cache.backupVersion(slug, version) : null;

  try {
    let install: Omit<InstallOutcome, "indexedCount" | "manifestChecksum">;
    let bundleFallbackReason: string | undefined;
    const selectedBundle = selectBundle(resolvedManifest);

    if (selectedBundle) {
      try {
        install = await installFromBundle(deps, slug, version, resolvedManifest, selectedBundle);
      } catch (error) {
        bundleFallbackReason = (error as Error).message;
        install = await installFromPageApi(deps, slug, version, resolvedManifest);
      }
    } else {
      install = await installFromPageApi(deps, slug, version, resolvedManifest);
    }

    const indexedCount = await indexer.indexLibraryVersion(slug, version);
    await indexer.embed();
    if (backupDir) {
      cache.discardBackup(backupDir);
    }

    return {
      ...install,
      indexedCount,
      manifestChecksum,
      ...(bundleFallbackReason ? { bundleFallbackReason } : {}),
    };
  } catch (error) {
    await indexer.removeLibraryVersion(slug, version);
    if (backupDir) {
      cache.restoreVersionFromBackup(slug, version, backupDir);
    }

    if (existingInstall) {
      cache.addInstalled({
        ...existingInstall,
        page_count: cache.countPages(slug, version),
        index_schema_version: 0,
      });
    } else {
      cache.removeVersion(slug, version);
    }
    throw error;
  }
}

export async function handleSearchLibraries(
  deps: ServerDeps,
  input: SearchLibrariesInput,
): Promise<ToolResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 20);
  const response = await deps.registryClient.searchLibraries(input.query);
  const matches = response.data.slice(0, limit);

  if (matches.length === 0) {
    return structuredTextResult(`No libraries found for "${input.query}".`, {
      query: input.query,
      results: [],
    });
  }

  const versionResponses = await Promise.allSettled(
    matches.map(match => deps.registryClient.getVersions(match.slug)),
  );

  const results: SearchLibraryCandidate[] = matches.map((match, index) => {
    const versionResponse = versionResponses[index];
    const versions = versionResponse?.status === "fulfilled"
      ? versionResponse.value.data.map(version => version.version)
      : (match.default_version ? [match.default_version] : []);
    const localVersions = installedVersions(deps.cache, match.slug);

    return {
      library: match.slug,
      display_name: match.display_name,
      aliases: match.aliases,
      homepage_url: match.homepage_url,
      default_version: match.default_version,
      source_type: match.source_type,
      license_status: match.license_status,
      version_count: match.version_count ?? versions.length,
      versions,
      installed_versions: localVersions,
      installed: localVersions.length > 0,
    };
  });

  const lines = results.map(result => {
    const installHint = result.installed_versions.length > 0
      ? `installed: ${result.installed_versions.join(", ")}`
      : `install: install_docs({ library: "${result.library}", version: "${result.default_version}" })`;
    const source = result.source_type ? ` | source: ${result.source_type}` : "";
    const license = result.license_status ? ` | license: ${result.license_status}` : "";
    return `- ${result.library} (${result.display_name}) | default: ${result.default_version} | versions: ${result.versions.join(", ") || "unknown"}${source}${license} | ${installHint}`;
  });

  return structuredTextResult(lines.join("\n"), {
    query: input.query,
    results,
  });
}

export async function handleInstallDocs(deps: ServerDeps, input: InstallDocsInput): Promise<ToolResult> {
  const resolved = await deps.registryClient.resolve({
    query: input.library,
    version_hint: input.version,
  });
  const canonicalLibrary = resolved.data.library.slug;
  const targetVersion = resolved.data.version.version;
  const manifest = (await deps.registryClient.getManifest(canonicalLibrary, targetVersion)).data;
  const targetChecksum = manifest.provenance?.manifest_checksum ?? null;

  const existing = deps.cache.findInstalled(canonicalLibrary, targetVersion);
  if (existing) {
    if (existing.manifest_checksum === targetChecksum) {
      return structuredTextResult(
        `${canonicalLibrary}@${targetVersion} is already installed and current (${existing.page_count} pages, ${existing.profile} mode).`,
        {
          library: canonicalLibrary,
          version: targetVersion,
          changed: false,
          installed: true,
          manifest_checksum: targetChecksum,
        },
      );
    }
  }

  const outcome = await installResolvedVersion(deps, canonicalLibrary, targetVersion, manifest);
  deps.cache.addInstalled({
    slug: canonicalLibrary,
    version: targetVersion,
    profile: outcome.profile,
    installed_at: new Date().toISOString(),
    manifest_checksum: outcome.manifestChecksum,
    page_count: outcome.pageCount,
    index_schema_version: DOC_INDEX_SCHEMA_VERSION,
    source_kind: "registry",
    display_name: resolved.data.library.display_name,
  });

  const installLine =
    outcome.installMethod === "bundle"
      ? `  Installed from bundle (${outcome.profile}, ${outcome.bundleFormat ?? "tar.gz"})`
      : `  Installed from page API fallback (${outcome.pageCount}/${outcome.totalPages ?? outcome.pageCount} pages)`;
  const fallbackLine = outcome.bundleFallbackReason
    ? `\n  Bundle fallback: ${outcome.bundleFallbackReason}`
    : "";
  const actionLine = existing ? "Reinstalled" : "Installed";

  return structuredTextResult(
    `${actionLine} ${canonicalLibrary}@${targetVersion}\n` +
    `${installLine}\n` +
    `  Indexed: ${outcome.indexedCount} pages for search${fallbackLine}`,
    {
      library: canonicalLibrary,
      version: targetVersion,
      changed: true,
      reinstall: Boolean(existing),
      install_method: outcome.installMethod,
      profile: outcome.profile,
      page_count: outcome.pageCount,
      indexed_count: outcome.indexedCount,
      manifest_checksum: outcome.manifestChecksum,
      ...(outcome.bundleFormat ? { bundle_format: outcome.bundleFormat } : {}),
      ...(outcome.bundleFallbackReason ? { bundle_fallback_reason: outcome.bundleFallbackReason } : {}),
    },
  );
}

export async function handleSearchDocs(deps: ServerDeps, input: SearchDocsInput): Promise<ToolResult> {
  const { cache, indexer } = deps;
  const installed = cache.listInstalled();
  const library = input.library ? (normalizeLibrarySlug(input.library) ?? undefined) : undefined;

  if (input.library && !library) {
      return errorResult(
        "library must be a canonical slug (for example 'nextjs').",
        "INVALID_LIBRARY",
      );
  }

  if (library) {
    const matchingVersions = installedVersions(cache, library);
    const requestedInstalled = input.version
      ? matchingVersions.includes(input.version)
      : matchingVersions.length > 0;

    if (!requestedInstalled) {
      return errorResult(
        input.version ? `${library}@${input.version} is not installed.` : `${library} is not installed.`,
        "NOT_INSTALLED",
        {
          library,
          ...(input.version ? { version: input.version } : {}),
          installed_versions: matchingVersions,
        },
      );
    }
  } else if (installed.length === 0) {
    return structuredTextResult("No documentation packages installed. Use install_docs first.", { results: [] });
  }

  await ensureCurrentIndexSchema(deps, library, input.version);

  const results = await indexer.search(input.query, {
    library,
    version: input.version,
    maxResults: input.max_results ?? 5,
    mode: input.mode ?? "auto",
  });

  if (results.length === 0) {
    return structuredTextResult(
      `No results found for "${input.query}"${library ? ` in ${library}` : ""}.`,
      {
        query: input.query,
        results: [],
      },
    );
  }

  const usedMode = results[0]?.searchMode ?? "fts";
  const summary = `Search: ${usedMode} | ${results.length} page-level local results`;

  return structuredTextResult(summary, {
    results: results.map(result => ({
      library: result.library,
      version: result.version,
      doc_path: result.docPath,
      page_uid: result.pageUid,
      title: result.title,
      content_md: result.contentMd,
      score: result.score,
      snippet: result.snippet,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      search_mode: result.searchMode,
      ...(result.url ? { url: result.url } : {}),
    })),
  });
}

export async function handleGetDoc(deps: ServerDeps, input: GetDocInput): Promise<ToolResult> {
  const library = normalizeLibrarySlug(input.library);
  if (!library) {
    return errorResult("Error: library must be a canonical slug", "INVALID_LIBRARY");
  }

  const installed = deps.cache.findInstalled(library, input.version);
  if (!installed) {
    const label = input.version ? `${library}@${input.version}` : library;
    return errorResult(`${label} is not installed.`, "NOT_INSTALLED");
  }

  const version = input.version ?? installed.version;

  const lookupCount = (input.doc_path ? 1 : 0) + (input.page_uid ? 1 : 0);
  if (lookupCount !== 1) {
    return errorResult("Exactly one of doc_path or page_uid must be provided.", "INVALID_LOOKUP");
  }

  const resolvedInput = { ...input, library, version };
  const page = resolveCachedPage(deps.cache, resolvedInput);
  if (!page) {
    return errorResult("Document not found in local cache.", "NOT_FOUND", {
      library,
      version,
      ...(input.doc_path ? { doc_path: normalizeDocPath(input.doc_path) } : {}),
      ...(input.page_uid ? { page_uid: input.page_uid } : {}),
    });
  }

  if (page.hydrationState === "missing_content") {
    return errorResult(
      "Page metadata exists locally, but page content is not hydrated. Reinstall with install_docs or refresh with update_docs.",
      "PAGE_NOT_HYDRATED",
      {
        library,
        version,
        doc_path: page.docPath,
        page_uid: page.pageUid,
      },
    );
  }

  const excerptWindow = resolveExcerptWindow(input);
  if ("content" in excerptWindow) {
    return excerptWindow;
  }

  if ((page.content ?? "").length === 0) {
    return errorResult("Page content is empty.", "EMPTY_CONTENT", {
      library,
      version,
      doc_path: page.docPath,
      page_uid: page.pageUid,
    });
  }

  return buildExcerpt(page, {
    fromLine: excerptWindow.fromLine,
    maxLines: excerptWindow.maxLines,
    lineNumbers: input.line_numbers ?? false,
  });
}

export function handleListInstalledDocs(deps: ServerDeps): ToolResult {
  const installed = deps.cache.listInstalled();
  if (installed.length === 0) {
    return structuredTextResult("No documentation packages installed. Use install_docs to add some.", {
      results: [],
    });
  }

  const results = installed.map(lib => ({
    library: lib.slug,
    version: lib.version,
    profile: lib.profile,
    page_count: lib.page_count,
    installed_at: lib.installed_at,
    manifest_checksum: lib.manifest_checksum,
    source_kind: lib.source_kind ?? "registry",
    ...(lib.source_paths ? { source_paths: lib.source_paths } : {}),
    ...(lib.display_name ? { display_name: lib.display_name } : {}),
  }));

  const lines = results.map(result =>
    `- ${result.library}@${result.version} (${result.source_kind === "local" ? "local" : result.profile}, ${result.page_count} pages)`,
  );

  return structuredTextResult(`Installed documentation packages:\n\n${lines.join("\n")}`, {
    results,
  });
}

export async function handleUpdateDocs(
  deps: ServerDeps,
  input: { library?: string },
): Promise<ToolResult> {
  const { cache, indexer, registryClient } = deps;
  const installed = cache.listInstalled();
  const library = input.library ? normalizeLibrarySlug(input.library) : undefined;

  if (input.library && !library) {
    return errorResult(
      "library must be a canonical slug (for example 'nextjs').",
      "INVALID_LIBRARY",
    );
  }

  const filtered = library
    ? installed.filter(l => l.slug === library)
    : installed;
  const skippedLocal = filtered.filter(isLocalDocsInstall).map(lib => lib.slug);
  const targets = filtered.filter(isRegistryInstall);

  if (targets.length === 0) {
    return structuredTextResult(
      skippedLocal.length > 0
        ? "No registry documentation packages installed."
        : library
          ? `${library} is not installed. Use install_docs first.`
          : "No documentation packages installed.",
      {
        results: [],
        ...(skippedLocal.length > 0 ? { skipped_local: skippedLocal } : {}),
      },
    );
  }

  const messages: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  for (const lib of targets) {
    try {
      const resolved = await registryClient.resolve({ query: lib.slug });
      const targetVersion = resolved.data.version.version;
      const manifest = await registryClient.getManifest(lib.slug, targetVersion);
      const targetChecksum = manifest.data.provenance?.manifest_checksum ?? null;
      const versionChanged = targetVersion !== lib.version;
      const checksumChanged = targetChecksum !== lib.manifest_checksum;

      if (!versionChanged && !checksumChanged) {
        messages.push(`${lib.slug}@${lib.version}: already up to date`);
        results.push({
          library: lib.slug,
          version: lib.version,
          status: "unchanged",
          manifest_checksum: targetChecksum,
        });
        continue;
      }

      const installOutcome = await installResolvedVersion(
        deps,
        lib.slug,
        targetVersion,
        manifest.data,
      );

      if (versionChanged) {
        await indexer.removeLibraryVersion(lib.slug, lib.version);
        cache.removeVersion(lib.slug, lib.version);
        cache.removeInstalled(lib.slug, lib.version);
      }

      cache.addInstalled({
        ...lib,
        version: targetVersion,
        installed_at: new Date().toISOString(),
        manifest_checksum: installOutcome.manifestChecksum,
        page_count: installOutcome.pageCount,
        profile: installOutcome.profile,
        index_schema_version: DOC_INDEX_SCHEMA_VERSION,
      });

      let message = `${lib.slug}: ${lib.version} → ${targetVersion}`;
      if (!versionChanged) {
        message = `${lib.slug}@${lib.version}: refreshed in place`;
      }
      message += ` (${installOutcome.pageCount} pages, ${installOutcome.indexedCount} indexed via ${installOutcome.installMethod})`;
      if (installOutcome.bundleFallbackReason) {
        message += ` [bundle fallback: ${installOutcome.bundleFallbackReason}]`;
      }
      messages.push(message);
      results.push({
        library: lib.slug,
        previous_version: lib.version,
        version: targetVersion,
        status: versionChanged ? "updated" : "refreshed",
        install_method: installOutcome.installMethod,
        profile: installOutcome.profile,
        page_count: installOutcome.pageCount,
        indexed_count: installOutcome.indexedCount,
        manifest_checksum: installOutcome.manifestChecksum,
        ...(installOutcome.bundleFormat ? { bundle_format: installOutcome.bundleFormat } : {}),
        ...(installOutcome.bundleFallbackReason ? { bundle_fallback_reason: installOutcome.bundleFallbackReason } : {}),
      });
    } catch (err) {
      const message = `${lib.slug}: update failed — ${(err as Error).message}`;
      messages.push(message);
      results.push({
        library: lib.slug,
        version: lib.version,
        status: "failed",
        error: (err as Error).message,
      });
    }
  }

  return structuredTextResult(messages.join("\n"), { results });
}

export async function handleRemoveDocs(
  deps: ServerDeps,
  input: { library: string; version?: string },
): Promise<ToolResult> {
  const library = normalizeLibrarySlug(input.library);
  if (!library) {
    return errorResult("Error: library must be a canonical slug", "INVALID_LIBRARY");
  }

  const targets = deps.cache.listInstalled().filter(lib => {
    if (lib.slug !== library) {
      return false;
    }
    return !input.version || lib.version === input.version;
  });

  if (targets.length === 0) {
    return errorResult(
      input.version
        ? `${input.library}@${input.version} is not installed.`
        : `${input.library} is not installed.`,
      "NOT_INSTALLED",
    );
  }

  for (const target of targets) {
    await deps.indexer.removeLibraryVersion(target.slug, target.version);
    deps.cache.removeVersion(target.slug, target.version);
    deps.cache.removeInstalled(target.slug, target.version);
  }

  return structuredTextResult(
    `Removed ${targets.length} documentation package${targets.length === 1 ? "" : "s"} for ${input.library}.`,
    {
      library,
      removed_versions: targets.map(target => target.version),
    },
  );
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "ContextQMD", version: VERSION },
    {
      instructions:
        "Local-first docs package system. Preferred flow: search_libraries, install_docs, search_docs, then get_doc. search_docs is local-only and does not fetch from the network.",
    },
  );

  // ── Tool 1: search_libraries ──────────────────────────────────────
  server.registerTool(
    "search_libraries",
    {
      title: "Search Libraries",
      description:
        "Search the remote library catalog and return candidate libraries, available versions, and local install status. Use this first when you do not already know the exact canonical slug.",
      inputSchema: {
        query: z
          .string()
          .describe("Library search query or task phrase (for example 'inertia rails' or 'react forms')"),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Maximum libraries to return (default: 5)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => handleSearchLibraries(deps, input),
  );

  // ── Tool 2: install_docs ──────────────────────────────────────────
  server.registerTool(
    "install_docs",
    {
      title: "Install Docs",
      description:
        "Install or refresh documentation for a library. This is idempotent: if the requested library/version is already installed with the same manifest checksum, it is a no-op. Otherwise it prefers a registry bundle, falls back to page fetches, and indexes everything locally for search.",
      inputSchema: {
        library: z
          .string()
          .describe("Library query, alias, or canonical slug (e.g., 'next', 'kamal', or 'nextjs')"),
        version: z.string().optional().describe("Version to install: exact version, 'stable', 'latest', or omit for default"),
      },
    },
    async (input) => handleInstallDocs(deps, input),
  );

  // ── Tool 3: update_docs ───────────────────────────────────────────
  server.registerTool(
    "update_docs",
    {
      title: "Update Docs",
      description:
        "Update installed documentation to the latest resolved version. Also refreshes same-version installs when the manifest checksum changes.",
      inputSchema: {
        library: z
          .string()
          .optional()
          .describe("Library slug to update (updates all if omitted)"),
      },
    },
    async (input) => handleUpdateDocs(deps, input),
  );

  // ── Tool 4: search_docs ───────────────────────────────────────────
  server.registerTool(
    "search_docs",
    {
      title: "Search Docs",
      description:
        "Search installed documentation locally through QMD and return page-level markdown content from the local cache. This tool never fetches from the network. If a requested library/version is not installed, it returns NOT_INSTALLED.",
      inputSchema: {
        query: z.string().describe("Search query"),
        library: z
          .string()
          .optional()
          .describe("Filter to specific library slug"),
        version: z.string().optional().describe("Filter to specific version"),
        max_results: z
          .number()
          .optional()
          .describe("Max results to return (default: 5)"),
        mode: z
          .enum(["fts", "vector", "hybrid", "auto"])
          .optional()
          .describe("Search mode: fts (keyword), vector (semantic), hybrid (combined + reranking), auto (smart routing). Default: auto"),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => handleSearchDocs(deps, input),
  );

  // ── Tool 5: get_doc ───────────────────────────────────────────────
  server.registerTool(
    "get_doc",
    {
      title: "Get Doc",
      description:
        "Read a bounded slice from a locally installed markdown page. Use doc_path or page_uid, and either from_line/max_lines or around_line/before/after.",
      inputSchema: {
        library: z
          .string()
          .describe("Library slug"),
        version: z.string().optional().describe("Version (defaults to latest installed)"),
        doc_path: z.string().optional().describe("Canonical markdown doc path (for example reference/react/useRef.md)"),
        page_uid: z.string().optional().describe("Internal page UID fallback"),
        from_line: z.number().int().positive().optional().describe("1-based inclusive line number to start from"),
        max_lines: z.number().int().positive().optional().describe(`Maximum lines to return (default: ${DEFAULT_EXCERPT_MAX_LINES})`),
        around_line: z.number().int().positive().optional().describe("Anchor line for a bounded context window"),
        before: z.number().int().min(0).optional().describe(`Lines to include before around_line (default: ${DEFAULT_EXPAND_BEFORE})`),
        after: z.number().int().min(0).optional().describe(`Lines to include after around_line (default: ${DEFAULT_EXPAND_AFTER})`),
        line_numbers: z.boolean().optional().describe("Include line numbers in the returned excerpt text"),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => handleGetDoc(deps, input),
  );

  // ── Tool 6: list_installed_docs ───────────────────────────────────
  server.registerTool(
    "list_installed_docs",
    {
      title: "List Installed Docs",
      description:
        "List all locally installed documentation packages with their versions, install modes, and page counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => handleListInstalledDocs(deps),
  );

  // ── Tool 7: remove_docs ───────────────────────────────────────────
  server.registerTool(
    "remove_docs",
    {
      title: "Remove Docs",
      description:
        "Remove one installed documentation version or every installed version for a library from the local cache and local QMD index.",
      inputSchema: {
        library: z
          .string()
          .describe("Library slug"),
        version: z.string().optional().describe("Specific installed version to remove (removes all installed versions if omitted)"),
      },
    },
    async (input) => handleRemoveDocs(deps, input),
  );

  return server;
}

async function main() {
  const program = new Command();
  program
    .name("contextqmd-mcp")
    .version(VERSION)
    .option("--transport <type>", "Transport type (stdio or http)", "stdio")
    .option("--port <number>", "HTTP port", "3001")
    .option("--registry <url>", "Registry URL override")
    .option("--token <token>", "API token")
    .option("--cache-dir <path>", "Cache directory override")
    .parse();

  const opts = program.opts();
  const config = loadConfig();

  const registryUrl = (opts.registry as string | undefined) ?? config.registry_url;
  const token = (opts.token as string | undefined) ?? process.env.CONTEXTQMD_API_TOKEN;
  const cacheDir = (opts["cache-dir"] as string | undefined) ?? config.local_cache_dir;

  const registryClient = new RegistryClient(registryUrl, token);
  const cache = new LocalCache(cacheDir);
  const indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);

  const server = createServer({ registryClient, cache, indexer });

  if (opts.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`ContextQMD MCP Server v${VERSION} running on stdio`);
  } else {
    console.error("HTTP transport not yet implemented. Use --transport stdio");
    process.exit(1);
  }
}

// Export for testing
export { createServer };

function resolveEntrypointPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

export function isCliEntrypoint(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) {
    return false;
  }

  return resolveEntrypointPath(argvPath) === resolveEntrypointPath(fileURLToPath(moduleUrl));
}

if (isCliEntrypoint()) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
