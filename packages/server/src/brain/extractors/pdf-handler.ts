/**
 * PDF handler via pdf-parse. Dynamic import — returns null when the
 * optional dep isn't installed.
 *
 *   npm install pdf-parse
 *
 * Given a PDF buffer, returns per-page text + document metadata (title,
 * author, creator, producer, page_count). Per-page text is a best-effort
 * split; pdf-parse returns full text with page markers we heuristic-split.
 */

import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import { ingest } from "../ingest/pipeline.js";

const require = createRequire(import.meta.url);

export interface PdfExtraction {
  pages: string[];
  info: Record<string, unknown>;
  num_pages: number;
}

type PdfParseFn = (b: Buffer) => Promise<{
  text: string;
  numpages: number;
  info?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}>;

export async function extractPdf(buffer: Buffer): Promise<PdfExtraction | null> {
  try {
    const mod = (await import("pdf-parse" as string)) as unknown;
    let fn: PdfParseFn | null = null;
    if (typeof mod === "function") {
      fn = mod as PdfParseFn;
    } else if (mod && typeof mod === "object" && "default" in mod) {
      const def = (mod as { default: unknown }).default;
      if (typeof def === "function") fn = def as PdfParseFn;
    }
    if (!fn) return null;
    const result = await fn(buffer);
    const pages = splitPages(result.text, result.numpages);
    return {
      pages,
      info: {
        ...(result.info ?? {}),
        ...(result.metadata ? { metadata: result.metadata } : {}),
      },
      num_pages: result.numpages,
    };
  } catch {
    return null;
  }
}

/**
 * pdf-parse returns full text with form-feed (\f) page delimiters in most
 * versions; we split on \f with a fallback to best-effort even chunking.
 */
function splitPages(text: string, expected: number): string[] {
  const byFormFeed = text.split(/\f/).map((s) => s.trim()).filter(Boolean);
  if (byFormFeed.length >= Math.max(1, expected - 1)) return byFormFeed;

  // Heuristic fallback: chunk evenly into expected pages
  if (expected <= 1) return [text.trim()];
  const size = Math.ceil(text.length / expected);
  const out: string[] = [];
  for (let i = 0; i < expected; i++) {
    out.push(text.slice(i * size, (i + 1) * size).trim());
  }
  return out.filter((s) => s.length > 0);
}

export interface PdfIngestArgs {
  buffer: Buffer;
  org_id: string;
  project_id: string;
  source_link_hash?: string;
  source_url?: string;
}

/**
 * Ingest a PDF: creates one document/pdf_excerpt artifact per page, each
 * linked to the source link (if provided). Returns the list of hashes.
 */
export async function ingestPdf(
  args: PdfIngestArgs,
): Promise<{ page_hashes: string[]; info: Record<string, unknown> } | null> {
  const extraction = await extractPdf(args.buffer);
  if (!extraction) return null;

  const pageHashes: string[] = [];
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
      origin: { tool: "brain-api", version: "0.1", actor: "pdf_handler" },
      edges,
      kind_specific_meta: {
        page_number: i + 1,
        total_pages: extraction.num_pages,
        pdf_title: extraction.info.Title,
        pdf_author: extraction.info.Author,
        pdf_creator: extraction.info.Creator,
        pdf_producer: extraction.info.Producer,
        source_url: args.source_url,
      },
      schema_version: 1,
    });
    pageHashes.push(result.hash);
  }

  // Best-effort audit note
  try {
    const db = activeDbFor(args.org_id);
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'pdf_handler', '0.1.0', NULL, NULL, ?, 0, 'success', ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      args.source_link_hash ?? pageHashes[0] ?? "",
      `${pageHashes.length} pages`,
      args.project_id,
      args.org_id,
    );
  } catch {
    /* audit best-effort */
  }

  return { page_hashes: pageHashes, info: extraction.info };
}

export async function isPdfParseAvailable(): Promise<boolean> {
  // Resolution-only probe: importing pdf-parse runs its module-level test
  // harness (reads a sample PDF) and is needless work at boot. The real
  // import stays lazy at first use.
  try {
    require.resolve("pdf-parse");
    return true;
  } catch {
    return false;
  }
}
