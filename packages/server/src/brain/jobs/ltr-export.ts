/**
 * Phase 10 — LTR (learning-to-rank) feature export.
 *
 * Reads query_logs with populated used_ids_json (engagement signal),
 * derives query + candidate features, and emits CSV rows. The CSV is the
 * pipeline's input; offline LightGBM training is intentionally outside
 * this module — we ship the export so a downstream tool can train.
 *
 * Usage (admin endpoint):
 *   POST /api/admin/brain/ltr-export {org_id, from, to}
 * Returns the absolute file path written.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { activeDbFor } from "../storage/active-db.js";
import { brainPathsFor } from "../storage/paths.js";

export interface LtrExportOptions {
  org_id: string;
  from: number; // unix seconds
  to: number;
  /** Override output dir; defaults to data/brain/<org>/exports/. */
  out_dir?: string;
}

export interface LtrExportResult {
  path: string;
  rows: number;
  queries: number;
  used_count: number;
  duration_ms: number;
}

interface QueryLogRow {
  query_id: string;
  ts: number;
  intent: string | null;
  retrievers_json: string | null;
  fused_top_json: string | null;
  used_ids_json: string | null;
  latency_ms: number | null;
  project_id: string;
  query_spec_json: string;
}

interface FusedEntry {
  hash: string;
  score?: number;
  rank?: number;
}

interface RetrieverSnapshot {
  retriever: string;
  weight: number;
  top20: Array<{ hash: string; rank: number; raw: number }>;
}

const FEATURE_HEADERS = [
  "query_id",
  "ts",
  "intent",
  "candidate_hash",
  "candidate_rank",
  "fused_score",
  "bm25_rank",
  "bm25_raw",
  "semantic_text_rank",
  "semantic_text_raw",
  "code_structural_rank",
  "code_structural_raw",
  "temporal_rank",
  "temporal_raw",
  "cross_encoder_rank",
  "cross_encoder_raw",
  "latency_ms",
  "label",
];

function safeArr<T = unknown>(json: string | null): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function exportLtrFeatures(
  opts: LtrExportOptions,
): LtrExportResult {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);

  const rows = db
    .prepare(
      `SELECT query_id, ts, intent, retrievers_json, fused_top_json,
              used_ids_json, latency_ms, project_id, query_spec_json
         FROM query_logs
        WHERE org_id = ? AND ts >= ? AND ts <= ?
          AND used_ids_json IS NOT NULL
          AND used_ids_json != '[]'
        ORDER BY ts ASC`,
    )
    .all(opts.org_id, opts.from, opts.to) as QueryLogRow[];

  // Path-traversal containment: out_dir (if provided) must canonicalise to
  // a path INSIDE the org's exports root. The org_id is also constrained
  // by brainPathsFor (regex-validated).
  const exportsRoot = path.resolve(
    brainPathsFor(opts.org_id).orgDir,
    "exports",
  );
  const requested = opts.out_dir
    ? path.resolve(exportsRoot, opts.out_dir)
    : exportsRoot;
  if (
    requested !== exportsRoot &&
    !requested.startsWith(exportsRoot + path.sep)
  ) {
    throw new Error(
      `out_dir escapes the brain export root (${exportsRoot})`,
    );
  }
  const outDir = requested;
  fs.mkdirSync(outDir, { recursive: true });
  // Sanitise the filename so a malicious org_id never lands in a path
  // separator (defence-in-depth — brainPathsFor already validates).
  const safeOrg = opts.org_id.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const fileName = `ltr-${safeOrg}-${opts.from}-${opts.to}.csv`;
  const filePath = path.join(outDir, fileName);

  const fd = fs.openSync(filePath, "w");
  fs.writeSync(fd, FEATURE_HEADERS.join(",") + os.EOL);

  let totalRows = 0;
  let totalUsed = 0;

  for (const q of rows) {
    const fused = safeArr<FusedEntry>(q.fused_top_json);
    const usedIds = new Set(safeArr<string>(q.used_ids_json));
    const retrievers = safeArr<RetrieverSnapshot>(q.retrievers_json);

    // Build a per-retriever lookup by candidate hash.
    const lookup = new Map<string, Record<string, { rank: number; raw: number }>>();
    for (const r of retrievers) {
      for (const t of r.top20) {
        const ent = lookup.get(t.hash) ?? {};
        ent[r.retriever] = { rank: t.rank, raw: t.raw };
        lookup.set(t.hash, ent);
      }
    }

    for (let i = 0; i < fused.length; i++) {
      const cand = fused[i];
      const perRetriever = lookup.get(cand.hash) ?? {};
      const label = usedIds.has(cand.hash) ? 1 : 0;
      if (label === 1) totalUsed += 1;

      const row = [
        q.query_id,
        q.ts,
        q.intent ?? "",
        cand.hash,
        i + 1,
        cand.score ?? "",
        perRetriever.bm25?.rank ?? "",
        perRetriever.bm25?.raw ?? "",
        perRetriever.semantic_text?.rank ?? "",
        perRetriever.semantic_text?.raw ?? "",
        perRetriever.code_structural?.rank ?? "",
        perRetriever.code_structural?.raw ?? "",
        perRetriever.temporal?.rank ?? "",
        perRetriever.temporal?.raw ?? "",
        perRetriever.cross_encoder?.rank ?? "",
        perRetriever.cross_encoder?.raw ?? "",
        q.latency_ms ?? "",
        label,
      ].map(csvField);

      fs.writeSync(fd, row.join(",") + os.EOL);
      totalRows += 1;
    }
  }

  fs.closeSync(fd);

  return {
    path: filePath,
    rows: totalRows,
    queries: rows.length,
    used_count: totalUsed,
    duration_ms: performance.now() - started,
  };
}
