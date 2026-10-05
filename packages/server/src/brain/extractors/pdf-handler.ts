/**
 * PDF handler via pdf-parse v2 (`PDFParse` class). Dynamic import — returns
 * null when the optional dep isn't installed.
 *
 * Given a PDF buffer, returns per-page text (pdf-parse reports pages
 * natively) + document metadata (Title, Author, Creator, Producer).
 *
 * Text-layer only: scanned/image-only PDFs yield empty pages. There is no
 * OCR fallback (tesseract.js is not a dependency).
 */

import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import { ingest } from "../ingest/pipeline.js";
import type { IngestRequestT } from "../ingest/types.js";

const require = createRequire(import.meta.url);

export interface PdfExtraction {
  pages: string[];
  info: Record<string, unknown>;
  num_pages: number;
}

/** pdf-parse is installed but could not read this file (corrupt, encrypted, not a PDF). */
export class PdfExtractionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

interface PdfParseInstance {
  getText(): Promise<{ pages: Array<{ num: number; text: string }>; total: number }>;
  getInfo(): Promise<{ total: number; info?: Record<string, unknown> }>;
  destroy(): Promise<void>;
}
type PdfParseCtor = new (opts: { data: Uint8Array }) => PdfParseInstance;

async function loadPdfParse(): Promise<PdfParseCtor | null> {
  let mod: unknown;
  try {
    mod = await import("pdf-parse" as string);
  } catch {
    return null; // optional dep not installed
  }
  const ctor = (mod as { PDFParse?: unknown }).PDFParse;
  return typeof ctor === "function" ? (ctor as PdfParseCtor) : null;
}

/**
 * Returns null only when pdf-parse is unavailable. Throws PdfExtractionError
 * when the library is present but cannot parse the buffer.
 */
export async function extractPdf(buffer: Buffer): Promise<PdfExtraction | null> {
  const PDFParse = await loadPdfParse();
  if (!PDFParse) return null;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const text = await parser.getText();
    const info = await parser.getInfo();
    const pages = [...text.pages]
      .sort((a, b) => a.num - b.num)
      .map((p) => p.text.trim());
    return { pages, info: info.info ?? {}, num_pages: text.total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PdfExtractionError(`could not parse PDF: ${msg}`, err);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export interface PdfIngestArgs {
  buffer: Buffer;
  /** Pre-parsed result, to avoid parsing the same buffer twice. */
  extraction?: PdfExtraction;
  org_id: string;
  project_id: string;
  session_id?: string;
  source_link_hash?: string;
  source_url?: string;
  filename?: string;
  origin?: IngestRequestT["origin"];
  /** Receives non-fatal failures (audit insert). */
  onWarn?: (msg: string, err: unknown) => void;
}

export interface PdfIngestResult {
  page_hashes: Array<{ page: number; hash: string }>;
  info: Record<string, unknown>;
  num_pages: number;
}

function metaString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 512) : undefined;
}

/**
 * Ingest a PDF: creates one document/pdf_excerpt artifact per page with
 * text, each linked to the source document (if provided) via a
 * `page_of_document` edge. Returns null when pdf-parse is unavailable.
 */
export async function ingestPdf(args: PdfIngestArgs): Promise<PdfIngestResult | null> {
  const extraction = args.extraction ?? (await extractPdf(args.buffer));
  if (!extraction) return null;

  const origin = args.origin ?? { tool: "brain-api", version: "0.1", actor: "pdf_handler" };
  const pageHashes: Array<{ page: number; hash: string }> = [];
  for (let i = 0; i < extraction.pages.length; i++) {
    const content = extraction.pages[i];
    if (!content) continue;
    const edges = args.source_link_hash
      ? [{ to_hash: args.source_link_hash, relation: "page_of_document" }]
      : [];
    const result = ingest({
      kind: "document/pdf_excerpt",
      content,
      content_type: "text/plain",
      org_id: args.org_id,
      project_id: args.project_id,
      session_id: args.session_id,
      origin,
      edges,
      kind_specific_meta: {
        page_number: i + 1,
        total_pages: extraction.num_pages,
        filename: args.filename,
        pdf_title: metaString(extraction.info.Title),
        pdf_author: metaString(extraction.info.Author),
        pdf_creator: metaString(extraction.info.Creator),
        pdf_producer: metaString(extraction.info.Producer),
        source_url: args.source_url,
      },
      schema_version: 1,
    });
    pageHashes.push({ page: i + 1, hash: result.hash });
  }

  try {
    const db = activeDbFor(args.org_id);
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'pdf_handler', '0.2.0', NULL, NULL, ?, 0, 'success', ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      args.source_link_hash ?? pageHashes[0]?.hash ?? "",
      `${pageHashes.length}/${extraction.num_pages} pages with text`,
      args.project_id,
      args.org_id,
    );
  } catch (err) {
    args.onWarn?.("pdf_handler audit insert failed", err);
  }

  return { page_hashes: pageHashes, info: extraction.info, num_pages: extraction.num_pages };
}

export async function isPdfParseAvailable(): Promise<boolean> {
  // Resolution-only probe: the real import stays lazy at first use.
  try {
    require.resolve("pdf-parse");
    return true;
  } catch {
    return false;
  }
}
