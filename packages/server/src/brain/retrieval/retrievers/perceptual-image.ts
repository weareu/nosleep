/**
 * Perceptual image retriever — Hamming-distance search over image_features.phash.
 * Accepts either:
 *   - A pHash directly via QuerySpec.image.phash (bigint)
 *   - An artifact hash of an existing image via image.vector_ref (we
 *     look up its phash then match by Hamming)
 *
 * Returns [] when image_features is empty / query has no image anchor.
 */

import type Database from "better-sqlite3";
import type { QuerySpecT } from "../query-spec.js";
import type { RetrieverResult } from "./bm25.js";
import { buildArtifactsWhere } from "../filters.js";

const DEFAULT_HAMMING_CEILING = 12;

function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function runPerceptualImage(
  db: Database.Database,
  q: QuerySpecT,
  limit: number = 100,
): RetrieverResult[] {
  // Accept phash via number (fits <= 53-bit) or the standard 64-bit hash
  // embedded as vector_ref. QuerySpec typing for phash is "number" so we
  // reconstruct the bigint.
  let targetHash: bigint | null = null;

  if (q.image && "phash" in q.image && q.image.phash !== undefined) {
    const raw = q.image.phash as unknown as number | bigint | string;
    try {
      targetHash = typeof raw === "bigint" ? raw : BigInt(raw as number | string);
    } catch {
      targetHash = null;
    }
  } else if (q.image?.vector_ref) {
    const row = db
      .prepare(`SELECT phash FROM image_features WHERE hash = ?`)
      .safeIntegers(true)
      .get(q.image.vector_ref) as { phash: bigint } | undefined;
    if (row && row.phash !== undefined && row.phash !== null) {
      targetHash = row.phash;
    }
  }

  if (targetHash === null) return [];

  // Over-fetch candidates; filter by project scope via artifacts join, then
  // sort by Hamming distance in JS (SQLite lacks a Hamming UDF by default).
  // safeIntegers to preserve 64-bit phash precision (INTEGER → BigInt).
  const where = buildArtifactsWhere(q);
  const anchorExclude = q.image?.vector_ref ?? null;
  const rows = db
    .prepare(
      `SELECT a.hash AS hash, img.phash AS phash
         FROM image_features img
         JOIN artifacts a ON a.hash = img.hash
        WHERE ${where.sql}
          AND a.kind GLOB 'media/image/*'
          AND (? IS NULL OR a.hash != ?)
        LIMIT ?`,
    )
    .safeIntegers(true)
    .all(
      ...where.params,
      anchorExclude,
      anchorExclude,
      limit * 5,
    ) as Array<{
    hash: string;
    phash: bigint;
  }>;

  if (rows.length === 0) return [];

  const scored = rows
    .map((r) => ({
      hash: r.hash,
      distance: hamming64(r.phash, targetHash),
    }))
    .filter((r) => r.distance <= DEFAULT_HAMMING_CEILING)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

  return scored.map((r, idx) => ({
    hash: r.hash,
    rank: idx + 1,
    raw_score: 1 - r.distance / 64, // normalise to [0,1]
    retriever: "perceptual_image",
  }));
}
