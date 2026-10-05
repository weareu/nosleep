/**
 * Core ingest pipeline. Single entry point: ingest().
 *
 *   1. Validate taxonomy branch (throws InvalidKindError if unknown top-level).
 *   2. Hash content (SHA-256).
 *   3. Check dedup via PK.
 *   4. Write artifact row (if new), FTS source row, artifact_projects, edges, ingest_event.
 *   5. Enqueue extractors (Phase 0 stub — names only).
 *
 * Transactional: either the whole write happens or none of it.
 */

import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import { catalogDbFor } from "../storage/catalog-db.js";
import { BRAIN_INGEST_MAX_BYTES, BRAIN_KIND_META_MAX_BYTES, getBrainRoot } from "../config.js";
import { diskHasHeadroom, MIN_FREE_GB } from "./disk-guard.js";
import { sha256hex, toBuffer } from "./hash.js";
import { extractorsForKind, shouldEmbedText } from "./extractor-queue.js";
import {
  scheduleTextEmbedding,
  scheduleCodeSymbolExtraction,
  scheduleImageExtraction,
  scheduleAutoThoughtExtraction,
} from "../extractors/worker.js";
import { runNumericMetaExtraction } from "../extractors/numeric-meta.js";
import { runFsAttrExtraction } from "../extractors/fs-attributes.js";
import { runGitAuthorshipExtraction } from "../extractors/git-authorship.js";
import { inc, observe } from "../metrics/emit.js";
import { METRIC_KEYS } from "../metrics/canonical-keys.js";
import { tryExtractText } from "./extract-text.js";
import {
  writeCasBlob,
  CAS_COMPRESSION_MARKER,
} from "../storage/cas-blobs.js";
import { BRAIN_LARGE_BLOB_THRESHOLD } from "../config.js";
import {
  InvalidKindError,
  recordKindForReview,
  validateKindBranch,
} from "./kind-validator.js";
import type { IngestRequestT, IngestResult } from "./types.js";

export class IngestSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestSizeError";
  }
}

/**
 * Ingest an artifact into the brain. Idempotent: replaying the same content
 * returns duplicate: true without writing a new artifacts row (but still
 * records the ingest_event and any new edges/project bindings).
 */
export function ingest(req: IngestRequestT): IngestResult {
  const started = performance.now();

  // Disk-full guard: refuse writes when headroom is gone. A full disk turned
  // SQLite writes into "disk is full"/"disk I/O error" crashes that took the
  // whole server down (2026-07-15) — capture is best-effort, uptime is the
  // contract.
  const headroom = diskHasHeadroom(getBrainRoot());
  if (!headroom.ok) {
    throw new IngestSizeError(
      `brain ingest paused: low disk (${headroom.freeGB.toFixed(1)}GB free < ${MIN_FREE_GB}GB floor)`,
    );
  }

  validateKindBranch(req.kind); // throws InvalidKindError

  const contentBuf = toBuffer(req.content, req.content_type);
  if (contentBuf.length > BRAIN_INGEST_MAX_BYTES) {
    throw new IngestSizeError(
      `content size ${contentBuf.length} exceeds max ${BRAIN_INGEST_MAX_BYTES}`,
    );
  }

  const metaJson = JSON.stringify(req.kind_specific_meta ?? {});
  if (metaJson.length > BRAIN_KIND_META_MAX_BYTES) {
    throw new IngestSizeError(
      `kind_specific_meta size ${metaJson.length} exceeds max ${BRAIN_KIND_META_MAX_BYTES}`,
    );
  }

  const hash = sha256hex(contentBuf);
  const tsNow = Math.floor(Date.now() / 1000);
  const ts = req.ts ?? tsNow;

  const db: Database.Database = activeDbFor(req.org_id);
  const catalog: Database.Database = catalogDbFor(req.org_id);

  const existing = db
    .prepare("SELECT hash FROM artifacts WHERE hash = ?")
    .get(hash) as { hash: string } | undefined;
  const duplicate = !!existing;

  const enqueued = duplicate ? [] : extractorsForKind(req.kind);

  // Route large blobs to CAS outside the transaction (fs writes aren't
  // transactional anyway). If the later SQL commit fails, the CAS file is
  // an unreferenced orphan that a later verify-job can garbage-collect.
  const goesToCas = !duplicate && contentBuf.length >= BRAIN_LARGE_BLOB_THRESHOLD;
  if (goesToCas) {
    writeCasBlob(req.org_id, hash, contentBuf);
  }

  const tx = db.transaction(() => {
    if (!duplicate) {
      // Phase 5: oversize blobs store in CAS; artifacts.content is NULL
      // and compression='cas' tells the read path to resolve from disk.
      db.prepare(
        `INSERT INTO artifacts
         (hash, kind, ts, org_id, project_id, session_id, turn_ord,
          origin_tool, origin_version, actor, content, content_type,
          size, compression, schema_version, kind_specific_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash,
        req.kind,
        ts,
        req.org_id,
        req.project_id,
        req.session_id ?? null,
        req.turn_ord ?? null,
        req.origin.tool,
        req.origin.version ?? null,
        req.origin.actor ?? null,
        goesToCas ? null : contentBuf,
        req.content_type ?? null,
        contentBuf.length,
        goesToCas ? CAS_COMPRESSION_MARKER : "none",
        req.schema_version,
        metaJson,
      );

      // FTS source row (trigger populates artifacts_fts)
      const text = tryExtractText(req.kind, contentBuf, req.content_type);
      if (text !== null && text.length > 0) {
        db.prepare(
          `INSERT INTO artifacts_fts_src (hash, project_id, kind, text, ts)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(hash, req.project_id, req.kind, text, ts);
      }
    }

    // Project binding (always — same hash can surface in multiple projects)
    db.prepare(
      `INSERT OR IGNORE INTO artifact_projects (hash, project_id, first_seen_ts)
       VALUES (?, ?, ?)`,
    ).run(hash, req.project_id, tsNow);

    // Edges (idempotent via PK; cross-org rejected by trigger)
    for (const e of req.edges ?? []) {
      db.prepare(
        `INSERT OR IGNORE INTO artifact_edges
         (from_hash, to_hash, relation, scope, origin, project_id, created_at)
         VALUES (?, ?, ?, ?, 'ingest_auto', ?, ?)`,
      ).run(
        hash,
        e.to_hash,
        e.relation,
        e.scope ?? "intra_project",
        req.project_id,
        tsNow,
      );
    }

    // Ingest event (audit)
    const durationMs = performance.now() - started;
    db.prepare(
      `INSERT INTO ingest_events
       (event_id, ts, artifact_hash, source_tool, source_version, schema_version,
        duplicate, enqueued_json, session_id, project_id, org_id, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      tsNow,
      hash,
      req.origin.tool,
      req.origin.version ?? null,
      req.schema_version,
      duplicate ? 1 : 0,
      JSON.stringify(enqueued),
      req.session_id ?? null,
      req.project_id,
      req.org_id,
      durationMs,
    );
  });

  tx();

  // Queue kind for review if it's not a known top-level-plus-common leaf.
  // Phase 0: simple heuristic — record any kind we see for the first time.
  if (!duplicate) {
    try {
      recordKindForReview(catalog, req.kind, hash);
    } catch {
      // non-fatal — review queue is advisory
    }

    // Phase 3: enqueue text embedding for allowlisted kinds.
    if (shouldEmbedText(req.kind, { orgId: req.org_id, projectId: req.project_id })) {
      const text = contentBuf.toString("utf8");
      if (text.length > 0) {
        scheduleTextEmbedding({
          referrer_kind: "artifact",
          hash,
          text,
          project_id: req.project_id,
          org_id: req.org_id,
        }).catch(() => {
          /* non-fatal — embeddings best-effort */
        });
      }
    }

    // Phase 11: auto-lift conversation turns into the thought layer.
    // Async + best-effort — falls back silently when claude CLI unavailable.
    if (req.kind.startsWith("conversation/turn/")) {
      void scheduleAutoThoughtExtraction({
        org_id: req.org_id,
        artifact_hash: hash,
      });
    }

    // Phase 5: enqueue code symbol extraction for code/* artifacts.
    if (req.kind.startsWith("code/")) {
      const text = contentBuf.toString("utf8");
      if (text.length > 0) {
        const filePath = (req.kind_specific_meta?.file_path as string | undefined) ?? undefined;
        scheduleCodeSymbolExtraction({
          hash,
          text,
          file_path: filePath,
          project_id: req.project_id,
          org_id: req.org_id,
        }).catch(() => {
          /* non-fatal */
        });
      }
    }

    // Phase 5: enqueue image extraction for media/image/* artifacts.
    if (req.kind.startsWith("media/image/")) {
      const mime = req.content_type ?? undefined;
      const width = req.kind_specific_meta?.width as number | undefined;
      const height = req.kind_specific_meta?.height as number | undefined;
      scheduleImageExtraction({
        hash,
        buffer: contentBuf,
        mime,
        width,
        height,
        project_id: req.project_id,
        org_id: req.org_id,
      }).catch(() => {
        /* non-fatal — no-op when no providers are configured */
      });
    }

    // Phase 5-cont2: cheap sync extractors — numeric meta (always) + fs
    // attributes + git-blame (best-effort when file_path is real). These
    // are sub-millisecond so we run them inline instead of queueing.
    try {
      runNumericMetaExtraction({
        hash,
        kind: req.kind,
        kind_specific_meta: req.kind_specific_meta ?? null,
        org_id: req.org_id,
        project_id: req.project_id,
      });
    } catch {
      /* non-fatal */
    }

    const filePath = req.kind_specific_meta?.file_path;
    if (
      typeof filePath === "string" &&
      (req.kind === "code/file_snapshot" || req.kind === "code/diff")
    ) {
      try {
        runFsAttrExtraction({
          hash,
          file_path: filePath,
          project_id: req.project_id,
          org_id: req.org_id,
        });
      } catch {
        /* non-fatal */
      }
      // Git-blame is async — fire-and-forget
      runGitAuthorshipExtraction({
        hash,
        file_path: filePath,
        project_id: req.project_id,
        org_id: req.org_id,
      }).catch(() => {
        /* non-fatal */
      });
    }
  }

  // Phase 7: emit metric points. Counters use kind as a tag so the rollup
  // can break out by-kind. Dedup hits get their own counter so the rollup
  // can compute hit rate.
  if (duplicate) {
    inc(METRIC_KEYS.artifacts_dedup_hits, req.org_id, req.project_id, {
      kind: req.kind,
    });
  } else {
    inc(METRIC_KEYS.artifacts_ingested_count, req.org_id, req.project_id, {
      kind: req.kind,
    });
    observe(
      METRIC_KEYS.artifacts_ingested_bytes,
      contentBuf.length,
      req.org_id,
      req.project_id,
      { kind: req.kind },
    );
  }

  return {
    hash,
    duplicate,
    enqueued,
    size: contentBuf.length,
    latency_ms: performance.now() - started,
  };
}

export { InvalidKindError };
