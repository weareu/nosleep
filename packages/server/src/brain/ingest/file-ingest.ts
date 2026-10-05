/**
 * File upload → brain artifacts. The one path for "upload a document":
 * resolves the file type, validates bytes, then routes through the same
 * ingest() pipeline every other capture uses (disk guard, dedup, FTS,
 * embeddings, extractor scheduling).
 *
 *   PDF            → source artifact (document/pdf, binary) + one
 *                    document/pdf_excerpt artifact per page with text,
 *                    linked by `page_of_document` edges.
 *   Text / code    → one artifact (document/*, data/*, code/blob/*), FTS-indexed.
 *   Images         → media/image/photo (image extractors scheduled).
 */

import path from "node:path";
import { BRAIN_INGEST_MAX_BYTES } from "../config.js";
import { ingest, IngestSizeError } from "./pipeline.js";
import { normalizeContentType } from "./hash.js";
import { ingestPdf } from "../extractors/pdf-handler.js";
import { extractPdfOffThread } from "./transcript-worker-client.js";
import type { IngestRequestT } from "./types.js";
import { DISTILLABLE_DOCUMENT_KINDS } from "../extractors/auto-thought.js";
import { scheduleAutoThoughtExtraction } from "../extractors/worker.js";

export class UnsupportedFileTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileTypeError";
  }
}

/** Bytes don't match the declared type (bad base64, not UTF-8, not a PDF). */
export class UnreadableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableFileError";
  }
}

export class PdfSupportUnavailableError extends Error {
  constructor() {
    super("PDF support unavailable: the pdf-parse package is not installed on the server");
    this.name = "PdfSupportUnavailableError";
  }
}

type FileClass = "pdf" | "text" | "image";

interface FileType {
  cls: FileClass;
  kind: string;
  content_type: string;
}

const CODE_EXT_KIND: Record<string, string> = {
  ts: "code/blob/ts",
  tsx: "code/blob/tsx",
  js: "code/blob/js",
  mjs: "code/blob/js",
  cjs: "code/blob/js",
  jsx: "code/blob/jsx",
  py: "code/blob/py",
  go: "code/blob/go",
  rs: "code/blob/rs",
  sql: "code/blob/sql",
  sh: "code/blob/sh",
  bash: "code/blob/sh",
  zsh: "code/blob/sh",
};

const GENERIC_CODE_EXTS = [
  "java", "kt", "swift", "rb", "php", "c", "h", "cc", "cpp", "hpp", "cs",
  "css", "scss", "html", "xml", "toml", "ini",
];

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function byExtension(ext: string): FileType | null {
  if (ext === "pdf") return { cls: "pdf", kind: "document/pdf", content_type: "application/pdf" };
  if (ext === "md" || ext === "markdown")
    return { cls: "text", kind: "document/markdown", content_type: "text/markdown" };
  if (ext === "txt" || ext === "text" || ext === "log")
    return { cls: "text", kind: "document/text", content_type: "text/plain" };
  if (ext === "json") return { cls: "text", kind: "data/json", content_type: "application/json" };
  if (ext === "yaml" || ext === "yml")
    return { cls: "text", kind: "data/yaml", content_type: "application/yaml" };
  if (ext === "csv") return { cls: "text", kind: "data/csv", content_type: "text/csv" };
  if (CODE_EXT_KIND[ext]) return { cls: "text", kind: CODE_EXT_KIND[ext], content_type: "text/plain" };
  if (GENERIC_CODE_EXTS.includes(ext)) return { cls: "text", kind: "code/blob", content_type: "text/plain" };
  if (IMAGE_TYPES[ext]) return { cls: "image", kind: "media/image/photo", content_type: IMAGE_TYPES[ext] };
  return null;
}

function byMime(ct: string): FileType | null {
  if (ct === "application/pdf") return byExtension("pdf");
  if (ct === "text/markdown" || ct === "text/x-markdown") return byExtension("md");
  if (ct === "text/plain") return byExtension("txt");
  if (ct === "application/json") return byExtension("json");
  if (ct === "application/yaml" || ct === "application/x-yaml" || ct === "text/yaml")
    return byExtension("yaml");
  if (ct === "text/csv") return byExtension("csv");
  for (const [ext, mime] of Object.entries(IMAGE_TYPES)) {
    if (ct === mime) return byExtension(ext);
  }
  return null;
}

/** Human-readable list, surfaced in 415 responses and the UI. */
export const SUPPORTED_FILE_TYPES = {
  pdf: [".pdf (application/pdf)"],
  text: [".md .markdown (text/markdown)", ".txt .text .log (text/plain)", ".json", ".yaml .yml", ".csv"],
  code: [
    ...Object.keys(CODE_EXT_KIND).map((e) => `.${e}`),
    ...GENERIC_CODE_EXTS.map((e) => `.${e}`),
  ],
  image: Object.entries(IMAGE_TYPES).map(([e, m]) => `.${e} (${m})`),
} as const;

/**
 * Extension wins when recognised: browsers report e.g. `.ts` as
 * `video/mp2t` and many text formats as "" or application/octet-stream.
 */
export function resolveFileType(filename: string, declaredType: string | undefined): FileType {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const fromExt = ext ? byExtension(ext) : null;
  if (fromExt) return fromExt;
  const fromMime = byMime(normalizeContentType(declaredType));
  if (fromMime) return fromMime;
  throw new UnsupportedFileTypeError(
    `unsupported file type for "${filename}" (content_type "${declaredType ?? ""}")`,
  );
}

/** Max base64 length that can decode to <= BRAIN_INGEST_MAX_BYTES. */
export const MAX_FILE_BASE64_CHARS = Math.ceil(BRAIN_INGEST_MAX_BYTES / 3) * 4;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64Strict(b64: string): Buffer {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || !BASE64_RE.test(clean)) {
    throw new UnreadableFileError("content_base64 is not valid base64");
  }
  return Buffer.from(clean, "base64");
}

export interface FileIngestArgs {
  filename: string;
  content_type?: string;
  bytes: Buffer;
  org_id: string;
  project_id: string;
  origin: IngestRequestT["origin"];
  session_id?: string;
  /** Edges from the primary artifact (e.g. URL capture → reference/link). */
  edges?: IngestRequestT["edges"];
  /** Extra provenance merged into kind_specific_meta (e.g. source_url). */
  extra_meta?: Record<string, unknown>;
  /** Distil the document into a thought via the brain LLM route. Default true
   *  (user-initiated uploads); session hooks pass false (budget). */
  distill?: boolean;
  onWarn?: (msg: string, err: unknown) => void;
}

export interface FileIngestResult {
  filename: string;
  kind: string;
  content_type: string;
  hash: string;
  duplicate: boolean;
  size: number;
  pages?: Array<{ page: number; hash: string }>;
  page_count?: number;
  warnings: string[];
}

export async function ingestFile(args: FileIngestArgs): Promise<FileIngestResult> {
  const type = resolveFileType(args.filename, args.content_type);
  const meta = { filename: args.filename.slice(0, 512), source: "upload", ...(args.extra_meta ?? {}) };
  const base = {
    org_id: args.org_id,
    project_id: args.project_id,
    session_id: args.session_id,
    origin: args.origin,
    schema_version: 1,
    edges: args.edges,
  };
  const distill = (kind: string, hash: string, duplicate: boolean): void => {
    if (args.distill === false || duplicate || !DISTILLABLE_DOCUMENT_KINDS.has(kind)) return;
    scheduleAutoThoughtExtraction({ org_id: args.org_id, artifact_hash: hash }).catch((err) =>
      args.onWarn?.("auto-thought scheduling failed", err),
    );
  };

  if (type.cls === "text") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(args.bytes);
    } catch {
      throw new UnreadableFileError(`"${args.filename}" is not valid UTF-8 text`);
    }
    text = text.replace(/^﻿/, "");
    if (text.trim().length === 0) {
      throw new UnreadableFileError(`"${args.filename}" is empty`);
    }
    const r = ingest({
      ...base,
      kind: type.kind,
      content: text,
      content_type: type.content_type,
      kind_specific_meta: type.kind.startsWith("code/") ? { ...meta, file_path: meta.filename } : meta,
    });
    distill(type.kind, r.hash, r.duplicate);
    return { filename: args.filename, kind: type.kind, content_type: type.content_type, hash: r.hash, duplicate: r.duplicate, size: r.size, warnings: [] };
  }

  if (type.cls === "image") {
    const r = ingest({
      ...base,
      kind: type.kind,
      content: args.bytes.toString("base64"),
      content_type: type.content_type,
      kind_specific_meta: meta,
    });
    return { filename: args.filename, kind: type.kind, content_type: type.content_type, hash: r.hash, duplicate: r.duplicate, size: r.size, warnings: [] };
  }

  // PDF: verify magic, parse BEFORE writing anything, then store source + pages.
  if (args.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new UnreadableFileError(`"${args.filename}" is not a PDF (missing %PDF- header)`);
  }
  // Size cap up-front: parsing a huge PDF just to reject it is wasted work.
  if (args.bytes.length > BRAIN_INGEST_MAX_BYTES) {
    throw new IngestSizeError(
      `content size ${args.bytes.length} exceeds max ${BRAIN_INGEST_MAX_BYTES}`,
    );
  }
  // Off the main thread: pdf.js is CPU-bound. Throws PdfExtractionError on corrupt input.
  const extraction = await extractPdfOffThread(args.bytes);
  if (!extraction) throw new PdfSupportUnavailableError();

  const source = ingest({
    ...base,
    kind: type.kind,
    content: args.bytes.toString("base64"),
    content_type: type.content_type,
    kind_specific_meta: {
      ...meta,
      page_count: extraction.num_pages,
      pdf_title: typeof extraction.info.Title === "string" ? extraction.info.Title.slice(0, 512) : undefined,
      pdf_author: typeof extraction.info.Author === "string" ? extraction.info.Author.slice(0, 512) : undefined,
    },
  });
  const pdf = await ingestPdf({
    source_url: typeof args.extra_meta?.source_url === "string" ? args.extra_meta.source_url : undefined,
    buffer: args.bytes,
    extraction,
    org_id: args.org_id,
    project_id: args.project_id,
    session_id: args.session_id,
    source_link_hash: source.hash,
    filename: meta.filename,
    origin: args.origin,
    onWarn: args.onWarn,
  });
  if (!pdf) throw new PdfSupportUnavailableError();

  distill(type.kind, source.hash, source.duplicate);
  const warnings: string[] = [];
  if (pdf.page_hashes.length === 0) {
    warnings.push(
      "no extractable text layer (scanned/image-only PDF?) — stored the file, but nothing is searchable; OCR is not available",
    );
  } else if (pdf.page_hashes.length < pdf.num_pages) {
    warnings.push(`${pdf.num_pages - pdf.page_hashes.length} of ${pdf.num_pages} pages had no text layer`);
  }
  return {
    filename: args.filename,
    kind: type.kind,
    content_type: type.content_type,
    hash: source.hash,
    duplicate: source.duplicate,
    size: source.size,
    pages: pdf.page_hashes,
    page_count: pdf.num_pages,
    warnings,
  };
}
