import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";
import type { Manifest, PageRecord } from "./types.js";

const DIRECTORY_IGNORE = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
  "vendor",
]);

const DOC_EXTENSIONS = new Set([
  ".adoc",
  ".asciidoc",
  ".markdown",
  ".md",
  ".mdown",
  ".mdx",
  ".mkd",
  ".rst",
  ".text",
  ".txt",
]);

const DOC_BASENAMES = new Set([
  "authors",
  "changelog",
  "contributing",
  "copying",
  "faq",
  "license",
  "readme",
  "todo",
]);

export const LOCAL_DOCS_VERSION = "local";

type LocalInput =
  | { kind: "file"; sourcePath: string; rootLabel: string; docPath: string; content: string }
  | { kind: "directory"; sourcePath: string; rootLabel: string; docPath: string; content: string };

export interface StagedLocalDocs {
  displayName: string;
  manifestChecksum: string;
  pageCount: number;
  sourcePaths: string[];
}

export function inferLocalDocsSlug(paths: string[], preferredName?: string): { slug: string; displayName: string } {
  const displayName = (preferredName?.trim() || basename(paths[0] || "local-docs")).trim();
  const slug = slugify(displayName);

  if (!slug) {
    throw new Error("Unable to derive a valid local docs name. Use --name with letters, numbers, or hyphens.");
  }

  return { slug, displayName };
}

export function stageLocalDocsPackage(
  stagedDocsDir: string,
  slug: string,
  displayName: string,
  inputPaths: string[],
): StagedLocalDocs {
  const sourcePaths = inputPaths.map(path => resolveExistingPath(path));
  const inputs = collectInputs(sourcePaths);

  if (inputs.length === 0) {
    throw new Error("No local docs found. Add a text file or a directory with markdown/text docs.");
  }

  const pagesDir = join(stagedDocsDir, "pages");
  mkdirSync(pagesDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const pageIndex: PageRecord[] = [];

  inputs.forEach((input, index) => {
    const pageUid = pageUidFor(input.docPath);
    const title = extractTitle(input.content, basename(input.docPath).replace(/\.md$/, ""));
    const checksum = `sha256:${sha256Hex(input.content)}`;
    const pagePath = join(pagesDir, `${pageUid}.md`);
    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, input.content);

    pageIndex.push({
      page_uid: pageUid,
      path: input.docPath,
      title,
      url: `file://${input.sourcePath}`,
      checksum,
      bytes: Buffer.byteLength(input.content),
      headings: title ? [title] : [],
      updated_at: generatedAt,
      bundle_path: `${pageUid}.md`,
    });

    if (index === 0 && pageIndex[0].path.length === 0) {
      throw new Error("Generated empty local doc path.");
    }
  });

  writeFileSync(join(stagedDocsDir, "page-index.json"), JSON.stringify(pageIndex, null, 2));

  const baseManifest: Manifest = {
    schema_version: "1.0",
    slug,
    display_name: displayName,
    version: LOCAL_DOCS_VERSION,
    channel: "snapshot",
    generated_at: generatedAt,
    doc_count: pageIndex.length,
    source: {
      type: "local",
      url: `file://${sourcePaths[0]}`,
      etag: null,
    },
    page_index: {
      url: "local://page-index",
      sha256: null,
    },
    profiles: {},
    source_policy: {
      license_name: "Local",
      license_status: "custom",
      mirror_allowed: false,
      origin_fetch_allowed: false,
      attribution_required: false,
    },
    provenance: {
      normalizer_version: "local-docs-v1",
      splitter_version: "page-per-file",
      manifest_checksum: "",
    },
  };

  const manifestChecksum = sha256Hex(JSON.stringify(baseManifest));
  const manifest: Manifest = {
    ...baseManifest,
    provenance: {
      ...baseManifest.provenance,
      manifest_checksum: `sha256:${manifestChecksum}`,
    },
  };
  writeFileSync(join(stagedDocsDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return {
    displayName,
    manifestChecksum: `sha256:${manifestChecksum}`,
    pageCount: pageIndex.length,
    sourcePaths,
  };
}

function collectInputs(sourcePaths: string[]): LocalInput[] {
  const entries = sourcePaths.map((sourcePath, index) => ({ sourcePath, rootLabel: uniqueRootLabel(sourcePaths, sourcePath, index) }));
  const multipleSources = entries.length > 1;
  const inputs: LocalInput[] = [];

  for (const entry of entries) {
    const absolute = entry.sourcePath;
    const stat = statSync(absolute);

    if (stat.isFile()) {
      const content = readAsText(absolute);
      if (content === null) {
        throw new Error(`Local docs file is not valid UTF-8 text: ${absolute}`);
      }

      const extension = extname(absolute).toLowerCase();
      inputs.push({
        kind: "file",
        sourcePath: absolute,
        rootLabel: entry.rootLabel,
        docPath: multipleSources ? normalizeDocPath(`${entry.rootLabel}.md`) : normalizeDocPath(basename(absolute, extension) + ".md"),
        content,
      });
      continue;
    }

    if (!stat.isDirectory()) continue;

    for (const next of collectDirectoryDocs(absolute, absolute, multipleSources ? entry.rootLabel : "")) {
      inputs.push({
        kind: "directory",
        sourcePath: next.sourcePath,
        rootLabel: entry.rootLabel,
        docPath: next.docPath,
        content: next.content,
      });
    }
  }

  return dedupeDocPaths(inputs);
}

function collectDirectoryDocs(
  rootDir: string,
  currentDir: string,
  prefix: string,
): Array<{ sourcePath: string; docPath: string; content: string }> {
  const results: Array<{ sourcePath: string; docPath: string; content: string }> = [];

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;

    const absolute = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (DIRECTORY_IGNORE.has(entry.name)) continue;
      results.push(...collectDirectoryDocs(rootDir, absolute, prefix));
      continue;
    }

    if (!entry.isFile() || !isDocCandidate(entry.name)) continue;
    const content = readAsText(absolute);
    if (content === null) continue;

    const relativePath = relative(rootDir, absolute).replace(/\\/g, "/");
    const docPath = prefix
      ? normalizeDocPath(join(prefix, relativePath).replace(/\\/g, "/"))
      : normalizeDocPath(relativePath);

    results.push({ sourcePath: absolute, docPath, content });
  }

  return results;
}

function dedupeDocPaths(inputs: LocalInput[]): LocalInput[] {
  const seen = new Map<string, number>();

  return inputs.map((input) => {
    const current = seen.get(input.docPath) ?? 0;
    seen.set(input.docPath, current + 1);
    if (current === 0) return input;

    const suffixed = input.docPath.replace(/\.md$/, `-${current + 1}.md`);
    return { ...input, docPath: suffixed };
  });
}

function isDocCandidate(filename: string): boolean {
  const extension = extname(filename).toLowerCase();
  if (DOC_EXTENSIONS.has(extension)) return true;
  if (extension.length > 0) return false;
  return DOC_BASENAMES.has(filename.toLowerCase());
}

function readAsText(path: string): string | null {
  const buffer = readFileSync(path);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function normalizeDocPath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function pageUidFor(docPath: string): string {
  return docPath.replace(/\.md$/, "").replace(/^\/+/, "");
}

function uniqueRootLabel(sourcePaths: string[], sourcePath: string, index: number): string {
  const base = slugify(basename(sourcePath, extname(sourcePath))) || `source-${index + 1}`;
  if (sourcePaths.filter(candidate => slugify(basename(candidate, extname(candidate))) === base).length <= 1) {
    return base;
  }
  return `${base}-${index + 1}`;
}

function resolveExistingPath(path: string): string {
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) {
    throw new Error(`Local docs path not found: ${path}`);
  }
  return realpathSync(resolved);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractTitle(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
