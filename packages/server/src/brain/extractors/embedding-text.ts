/**
 * Text embedding extractor. Embeds thoughts + allowlisted archive artifacts.
 * Results land in vec_text (sqlite-vec virtual table) with a matching row
 * in vec_text_map so queries can resolve back to hash / thought id.
 *
 * Non-fatal: any failure (no provider, model load error, vec extension
 * missing) is logged to extractor_runs and the row stays FTS-searchable.
 */

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import { isVecLoaded } from "../storage/vec-loader.js";
import {
  chunkForEmbedding,
  getEmbedProvider,
  EMBED_DIM,
} from "./embed-provider.js";

const EXTRACTOR_NAME = "embedding_text";

export interface EmbedTarget {
  referrer_kind: "thought" | "artifact";
  /** Thought id (`thg_*`) or artifact hash. */
  hash: string;
  text: string;
  project_id: string;
  org_id: string;
}

/**
 * Embed one target. Writes one vec_text row per chunk. Idempotent via a
 * pre-check on vec_text_map.
 */
export async function runTextEmbedding(target: EmbedTarget): Promise<boolean> {
  const db = activeDbFor(target.org_id);
  const started = performance.now();

  if (!isVecLoaded(db)) {
    recordRun(db, target, started, "skipped", "vec extension not loaded");
    return false;
  }

  // Already embedded?
  const existing = db
    .prepare(
      `SELECT 1 FROM vec_text_map WHERE hash = ? AND referrer_kind = ? LIMIT 1`,
    )
    .get(target.hash, target.referrer_kind);
  if (existing) {
    recordRun(db, target, started, "skipped", "already embedded");
    return true;
  }

  const provider = getEmbedProvider();
  const chunks = chunkForEmbedding(target.text);
  if (chunks.length === 0) {
    recordRun(db, target, started, "skipped", "empty text");
    return false;
  }

  const vectors: Float32Array[] = [];
  try {
    for (const chunk of chunks) {
      const v = await provider.embed(chunk);
      if (v.length !== EMBED_DIM) {
        recordRun(
          db,
          target,
          started,
          "failed",
          `dim mismatch: got ${v.length}, want ${EMBED_DIM}`,
        );
        return false;
      }
      vectors.push(v);
    }
  } catch (err) {
    recordRun(
      db,
      target,
      started,
      "failed",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }

  // Atomic write: insert vec0 row (auto rowid), then mirror into vec_text_map
  // with that rowid as the map's PK. Matches the pattern used by
  // packages/server/src/embeddings/vector-indexer.ts.
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      const vecInsert = db
        .prepare(`INSERT INTO vec_text (embedding) VALUES (?)`)
        .run(Buffer.from(vectors[i].buffer));
      const rowid = Number(vecInsert.lastInsertRowid);
      db.prepare(
        `INSERT INTO vec_text_map (rowid, hash, referrer_kind, chunk_ord, chunk_text, embedded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        rowid,
        target.hash,
        target.referrer_kind,
        i,
        chunks[i].slice(0, 2_000),
        now,
      );
    }
  });
  tx();

  recordRun(db, target, started, "success");
  return true;
}

function recordRun(
  db: Database.Database,
  target: EmbedTarget,
  started: number,
  result: "success" | "failed" | "skipped",
  error?: string,
): void {
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      EXTRACTOR_NAME,
      "0.1.0",
      getEmbedProvider().name,
      target.hash,
      performance.now() - started,
      result,
      error ?? null,
      target.project_id,
      target.org_id,
    );
  } catch {
    /* audit best-effort */
  }
}
