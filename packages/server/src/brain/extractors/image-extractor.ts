/**
 * Image extractor dispatcher. Called for media/image/* artifacts. Runs
 * whichever of pHash / CLIP / OCR / scene / caption / EXIF providers are
 * installed, writes results into image_features (upsert-style, one row per
 * image), and populates vec_clip if CLIP is available.
 *
 * Idempotent: re-running for the same hash merges in new fields without
 * overwriting populated ones.
 */

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import { isVecLoaded } from "../storage/vec-loader.js";
import { getImageProviders } from "./image-providers.js";
import { resolveLlmRoute } from "../../lib/headless-claude.js";

/** Why caption/OCR did or didn't run — stamped on extractor_runs so a
 *  caption-less image is explainable from the admin dashboard. */
function visionNote(hasVisionProvider: boolean): string {
  if (hasVisionProvider) return "vision=on";
  try {
    const r = resolveLlmRoute("vision");
    if (r.provider === "off") return `vision=off (${r.reason})`;
    return r.provider === "claude"
      ? "vision=off (claude CLI not available at boot)"
      : "vision=off (provider not registered)";
  } catch (err) {
    return `vision=off (invalid config: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export interface ImageExtractTarget {
  hash: string;
  buffer: Buffer;
  project_id: string;
  org_id: string;
  mime?: string;
  width?: number;
  height?: number;
}

export async function runImageExtraction(
  target: ImageExtractTarget,
): Promise<boolean> {
  const db = activeDbFor(target.org_id);
  const started = performance.now();
  const providers = getImageProviders();

  // If zero providers are configured, there's nothing to do — log skip
  // without mutating state so the pipeline stays forward-compatible.
  const anyProvider =
    providers.phash ||
    providers.clip ||
    providers.ocr ||
    providers.scene ||
    providers.caption ||
    providers.exif;
  if (!anyProvider) {
    recordRun(db, target, started, "skipped", `no image providers configured; ${visionNote(false)}`);
    return false;
  }

  // Ensure a base row exists so subsequent UPDATEs land.
  const existing = db
    .prepare(`SELECT 1 FROM image_features WHERE hash = ?`)
    .get(target.hash);
  if (!existing) {
    db.prepare(
      `INSERT INTO image_features (hash, phash, width, height, mime, extracted_at)
       VALUES (?, 0, ?, ?, ?, ?)`,
    ).run(
      target.hash,
      target.width ?? null,
      target.height ?? null,
      target.mime ?? null,
      Math.floor(Date.now() / 1000),
    );
  }

  // Run providers in parallel; any individual failure is swallowed.
  const results = await Promise.allSettled([
    runPhash(db, target),
    runScene(db, target),
    runOcr(db, target),
    runCaption(db, target),
    runExif(db, target),
    runClip(db, target),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;

  const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  recordRun(
    db,
    target,
    started,
    "success",
    `${ok}/${results.length} subtasks ok; ${visionNote(Boolean(providers.caption || providers.ocr))}` +
      (failed.length ? `; errors: ${failed.join(" | ").slice(0, 500)}` : ""),
  );
  return true;
}

async function runPhash(db: Database.Database, target: ImageExtractTarget) {
  const p = getImageProviders().phash;
  if (!p) return;
  const phash = await p.compute(target.buffer);
  if (phash === null) return;
  // SQLite INTEGER is 64-bit signed; BigInt values fit directly
  db.prepare(`UPDATE image_features SET phash = ? WHERE hash = ?`).run(
    phash,
    target.hash,
  );
}

async function runScene(db: Database.Database, target: ImageExtractTarget) {
  const p = getImageProviders().scene;
  if (!p) return;
  const cls = await p.classify(target.buffer);
  if (!cls) return;
  db.prepare(`UPDATE image_features SET scene_class = ? WHERE hash = ?`).run(
    cls,
    target.hash,
  );
}

async function runOcr(db: Database.Database, target: ImageExtractTarget) {
  const p = getImageProviders().ocr;
  if (!p) return;
  const txt = await p.recognise(target.buffer);
  if (!txt) return;
  db.prepare(`UPDATE image_features SET ocr_text = ? WHERE hash = ?`).run(
    txt.slice(0, 100_000),
    target.hash,
  );
}

async function runCaption(db: Database.Database, target: ImageExtractTarget) {
  const p = getImageProviders().caption;
  if (!p) return;
  const cap = await p.caption(target.buffer);
  if (!cap) return;
  db.prepare(`UPDATE image_features SET caption = ? WHERE hash = ?`).run(
    cap.slice(0, 2_000),
    target.hash,
  );
}

async function runExif(db: Database.Database, target: ImageExtractTarget) {
  const p = getImageProviders().exif;
  if (!p) return;
  const exif = await p.extract(target.buffer);
  if (!exif) return;
  db.prepare(`UPDATE image_features SET exif_json = ? WHERE hash = ?`).run(
    JSON.stringify(exif),
    target.hash,
  );
}

async function runClip(db: Database.Database, target: ImageExtractTarget) {
  const p = getImageProviders().clip;
  if (!p || !isVecLoaded(db)) return;
  const vec = await p.embed(target.buffer);
  if (!vec) return;

  // Skip if already embedded
  const existing = db
    .prepare(`SELECT 1 FROM vec_clip_map WHERE hash = ? LIMIT 1`)
    .get(target.hash);
  if (existing) return;

  const vecInsert = db
    .prepare(`INSERT INTO vec_clip (embedding) VALUES (?)`)
    .run(Buffer.from(vec.buffer));
  const rowid = Number(vecInsert.lastInsertRowid);
  db.prepare(
    `INSERT INTO vec_clip_map (rowid, hash, embedded_at) VALUES (?, ?, ?)`,
  ).run(rowid, target.hash, Math.floor(Date.now() / 1000));
}

function recordRun(
  db: Database.Database,
  target: ImageExtractTarget,
  started: number,
  result: "success" | "failed" | "skipped",
  note: string,
): void {
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'image_extractors', '0.1.0', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      target.hash,
      performance.now() - started,
      result,
      note,
      target.project_id,
      target.org_id,
    );
  } catch {
    /* audit best-effort */
  }
}
