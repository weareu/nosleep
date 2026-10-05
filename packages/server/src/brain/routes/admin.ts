/**
 * Admin REST endpoints. Read-only surfaces over metrics, events, query
 * logs, extractor health, plus a config GET/POST for tunables.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";
import { catalogDbFor } from "../storage/catalog-db.js";
import { brainPathsFor } from "../storage/paths.js";
import { fetchSeries, rollupForOrg } from "../metrics/rollup.js";
import { getConfig, setConfig } from "../config-store.js";
import { sealActiveDb } from "../seal/seal-job.js";
import { verifyAllSealedFiles } from "../seal/verify.js";
import { warmAllSealedFiles } from "../seal/warmth.js";
import { selectFiles } from "../storage/file-selection.js";
import { runUrlRefetch } from "../jobs/url-refetch.js";
import { exportLtrFeatures } from "../jobs/ltr-export.js";
import { runAutoThoughtBackfill } from "../jobs/auto-thought-backfill.js";

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

const orgQuery = z.object({ org_id: z.string().min(1) });

const metricsQuery = z.object({
  org_id: z.string().min(1),
  metric_key: z.string().min(1),
  project_id: z.string().optional(),
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
  resolution: z.enum(["raw", "1h", "1d"]).optional(),
});

const eventsQuery = z.object({
  org_id: z.string().min(1),
  table: z.enum(["ingest_events", "extractor_runs", "hook_fires", "brain_session_events"]),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const queryLogsQuery = z.object({
  org_id: z.string().min(1),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const extractorsQuery = z.object({
  org_id: z.string().min(1),
  since_hours: z.coerce.number().int().min(1).max(720).default(24),
});

const configBody = z.object({
  org_id: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
});

const rollupBody = z.object({ org_id: z.string().min(1) });

export function registerBrainAdminRoutes(fastify: FastifyInstance): void {
  // GET /api/admin/brain/storage — sealed file metadata + active.db size
  fastify.get<{ Querystring: z.input<typeof orgQuery> }>(
    "/api/admin/brain/storage",
    async (request, reply) => {
      const q = orgQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);

      const paths = brainPathsFor(q.data.org_id);
      const activeBytes = fs.existsSync(paths.activeDb)
        ? fs.statSync(paths.activeDb).size
        : 0;
      const sealedDir = paths.sealedDir;
      const sealedFiles = fs.existsSync(sealedDir)
        ? fs.readdirSync(sealedDir).filter((f) => f.endsWith(".db"))
        : [];
      const sealedDetails = sealedFiles.map((name) => {
        const full = path.join(sealedDir, name);
        const stat = fs.statSync(full);
        return { name, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
      });

      const catalog = catalogDbFor(q.data.org_id);
      const sealedRow = catalog
        .prepare(
          `SELECT file_name, quarter, ts_from, ts_to, size_bytes, artifact_count, verify_hash, verified_at, compression_ratio
             FROM sealed_files`,
        )
        .all() as Array<unknown>;

      const db = activeDbFor(q.data.org_id);
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM artifacts) AS artifact_count,
             (SELECT COUNT(*) FROM thoughts WHERE visibility='active') AS thought_count,
             (SELECT COUNT(*) FROM entities WHERE visibility='active' AND merged_into IS NULL) AS entity_count,
             (SELECT COUNT(*) FROM ingest_events) AS ingest_event_count,
             (SELECT COUNT(*) FROM extractor_runs) AS extractor_run_count,
             (SELECT COUNT(*) FROM query_logs) AS query_log_count`,
        )
        .get();

      reply.send({
        active_db_path: paths.activeDb,
        active_db_size_bytes: activeBytes,
        blobs_dir: paths.blobsDir,
        sealed_files_on_disk: sealedDetails,
        sealed_files_catalog: sealedRow,
        counts,
      });
    },
  );

  // GET /api/admin/brain/metrics?metric_key=...
  fastify.get<{ Querystring: z.input<typeof metricsQuery> }>(
    "/api/admin/brain/metrics",
    async (request, reply) => {
      const q = metricsQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const result = fetchSeries({
        org_id: q.data.org_id,
        metric_key: q.data.metric_key,
        project_id: q.data.project_id,
        from: q.data.from,
        to: q.data.to,
        resolution: q.data.resolution,
      });
      reply.send(result);
    },
  );

  // POST /api/admin/brain/rollup — recompute 1h + 1d rollups
  fastify.post("/api/admin/brain/rollup", async (request, reply) => {
    const parsed = rollupBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    const result = rollupForOrg(parsed.data.org_id);
    reply.send(result);
  });

  // GET /api/admin/brain/events
  fastify.get<{ Querystring: z.input<typeof eventsQuery> }>(
    "/api/admin/brain/events",
    async (request, reply) => {
      const q = eventsQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);

      const db = activeDbFor(q.data.org_id);
      const conds: string[] = [];
      const params: (string | number)[] = [];
      if (q.data.from !== undefined) {
        conds.push("ts >= ?");
        params.push(q.data.from);
      }
      if (q.data.to !== undefined) {
        conds.push("ts <= ?");
        params.push(q.data.to);
      }
      if (q.data.session_id) {
        conds.push("session_id = ?");
        params.push(q.data.session_id);
      }
      if (q.data.result) {
        conds.push("result = ?");
        params.push(q.data.result);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM ${q.data.table} ${where} ORDER BY ts DESC LIMIT ?`,
        )
        .all(...params, q.data.limit);
      reply.send({ items: rows, total: rows.length });
    },
  );

  // GET /api/admin/brain/query-logs
  fastify.get<{ Querystring: z.input<typeof queryLogsQuery> }>(
    "/api/admin/brain/query-logs",
    async (request, reply) => {
      const q = queryLogsQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const db = activeDbFor(q.data.org_id);
      const conds: string[] = [];
      const params: (string | number)[] = [];
      if (q.data.from !== undefined) {
        conds.push("ts >= ?");
        params.push(q.data.from);
      }
      if (q.data.to !== undefined) {
        conds.push("ts <= ?");
        params.push(q.data.to);
      }
      if (q.data.project_id) {
        conds.push("project_id = ?");
        params.push(q.data.project_id);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT query_id, ts, intent, latency_ms, confidence_score,
                  project_id, query_spec_json
             FROM query_logs ${where}
             ORDER BY ts DESC LIMIT ?`,
        )
        .all(...params, q.data.limit);
      reply.send({ items: rows, total: rows.length });
    },
  );

  fastify.get<{
    Params: { id: string };
    Querystring: z.input<typeof orgQuery>;
  }>("/api/admin/brain/query-logs/:id", async (request, reply) => {
    const q = orgQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);
    const db = activeDbFor(q.data.org_id);
    const row = db
      .prepare(`SELECT * FROM query_logs WHERE query_id = ?`)
      .get(request.params.id);
    if (!row) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `query ${request.params.id} not found` },
      });
    }
    reply.send(row);
  });

  // GET /api/admin/brain/extractors — health summary
  fastify.get<{ Querystring: z.input<typeof extractorsQuery> }>(
    "/api/admin/brain/extractors",
    async (request, reply) => {
      const q = extractorsQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const db = activeDbFor(q.data.org_id);
      const since = Math.floor(Date.now() / 1000) - q.data.since_hours * 3600;
      const rows = db
        .prepare(
          `SELECT extractor,
                  COUNT(*) AS total,
                  SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS success,
                  SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN result = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                  AVG(duration_ms) AS avg_ms,
                  MAX(duration_ms) AS max_ms,
                  MAX(ts) AS last_run
             FROM extractor_runs
            WHERE ts >= ?
         GROUP BY extractor
         ORDER BY total DESC`,
        )
        .all(since);
      reply.send({ items: rows, since_hours: q.data.since_hours });
    },
  );

  // GET /api/admin/brain/config?org_id=...&key=optional
  fastify.get<{ Querystring: { org_id: string; key?: string } }>(
    "/api/admin/brain/config",
    async (request, reply) => {
      const orgId = request.query.org_id;
      if (!orgId) return err400(reply, "org_id required");
      if (request.query.key) {
        const value = getConfig(orgId, request.query.key);
        return reply.send({ key: request.query.key, value });
      }
      const catalog = catalogDbFor(orgId);
      const rows = catalog
        .prepare(
          `SELECT key, value_json, updated_at FROM brain_config ORDER BY key ASC`,
        )
        .all() as Array<{ key: string; value_json: string; updated_at: number }>;
      reply.send({
        items: rows.map((r) => ({
          key: r.key,
          value: safeJson(r.value_json),
          updated_at: r.updated_at,
        })),
      });
    },
  );

  fastify.post("/api/admin/brain/config", async (request, reply) => {
    const parsed = configBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    setConfig(parsed.data.org_id, parsed.data.key, parsed.data.value);
    reply.send({ ok: true });
  });

  // Phase 8 — seal / verify / warmth / file-selection
  const sealBody = z.object({
    org_id: z.string().min(1),
    quarter: z.string().optional(),
    skip_hnsw: z.boolean().default(false),
  });

  fastify.post("/api/admin/brain/seal", async (request, reply) => {
    const parsed = sealBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    try {
      const result = await sealActiveDb({
        org_id: parsed.data.org_id,
        quarter: parsed.data.quarter,
        skip_hnsw: parsed.data.skip_hnsw,
      });
      reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ error: { code: "SEAL_FAILED", message: msg } });
    }
  });

  fastify.post("/api/admin/brain/verify", async (request, reply) => {
    const queryParse = orgQuery.safeParse(request.query);
    const bodyParse = orgQuery.safeParse(request.body);
    const orgId = queryParse.success
      ? queryParse.data.org_id
      : bodyParse.success
        ? bodyParse.data.org_id
        : null;
    if (!orgId) return err400(reply, "org_id required");
    const results = verifyAllSealedFiles(orgId);
    reply.send({ items: results });
  });

  fastify.post("/api/admin/brain/warmth", async (request, reply) => {
    const queryParse = orgQuery.safeParse(request.query);
    const bodyParse = orgQuery.safeParse(request.body);
    const orgId = queryParse.success
      ? queryParse.data.org_id
      : bodyParse.success
        ? bodyParse.data.org_id
        : null;
    if (!orgId) return err400(reply, "org_id required");
    const results = warmAllSealedFiles(orgId);
    reply.send({ items: results });
  });

  // Phase 12 — strict bounds. Without these, a caller can pass
  // `concurrency: 9999, limit: 1_000_000` → fork-bomb the `claude` CLI.
  const autoThoughtsBody = z.object({
    org_id: z.string().min(1),
    project_id: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    concurrency: z.number().int().min(1).max(8).optional(),
  });
  fastify.post("/api/admin/brain/auto-thoughts/run", async (request, reply) => {
    const parsed = autoThoughtsBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    const result = await runAutoThoughtBackfill(parsed.data);
    reply.send(result);
  });

  fastify.post<{
    Body: { org_id: string; from: number; to: number; out_dir?: string };
  }>("/api/admin/brain/ltr-export", async (request, reply) => {
    const { org_id, from, to } = request.body ?? {};
    if (!org_id || typeof from !== "number" || typeof to !== "number") {
      return err400(reply, "org_id, from, to required (from/to in unix seconds)");
    }
    const result = exportLtrFeatures({
      org_id,
      from,
      to,
      out_dir: request.body.out_dir,
    });
    reply.send(result);
  });

  fastify.post<{
    Body: {
      org_id: string;
      project_id?: string;
      interval_days?: number;
      limit?: number;
      max_age_days?: number;
    };
  }>("/api/admin/brain/url-refetch/run", async (request, reply) => {
    const orgId = request.body?.org_id;
    if (!orgId) return err400(reply, "org_id required");
    const result = await runUrlRefetch({
      org_id: orgId,
      project_id: request.body.project_id,
      interval_days: request.body.interval_days,
      limit: request.body.limit,
      max_age_days: request.body.max_age_days,
    });
    reply.send(result);
  });

  fastify.get<{
    Querystring: {
      org_id: string;
      include_sealed?: string;
      ts_from?: string;
      ts_to?: string;
    };
  }>("/api/admin/brain/file-selection", async (request, reply) => {
    const orgId = request.query.org_id;
    if (!orgId) return err400(reply, "org_id required");
    const result = selectFiles({
      org_id: orgId,
      ts_from: request.query.ts_from ? Number(request.query.ts_from) : undefined,
      ts_to: request.query.ts_to ? Number(request.query.ts_to) : undefined,
      include_sealed: request.query.include_sealed === "true",
    });
    reply.send({ items: result });
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
