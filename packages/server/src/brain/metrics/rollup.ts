/**
 * Metrics rollup job. Aggregates raw metrics points into 1h and 1d buckets.
 * Idempotent — UPSERT on (metric_key, project_id, ts_hour|ts_day).
 *
 * Default policy: 25h of 1h granularity, 8d of 1d granularity. Operators
 * call rollupAll() from a cron or via the admin recompute button.
 */

import { activeDbFor } from "../storage/active-db.js";

export interface RollupResult {
  hour_buckets: number;
  day_buckets: number;
  duration_ms: number;
}

export function rollupForOrg(orgId: string, opts: {
  hour_lookback_hours?: number;
  day_lookback_days?: number;
} = {}): RollupResult {
  const db = activeDbFor(orgId);
  const started = performance.now();

  const hourLookback = (opts.hour_lookback_hours ?? 25) * 3600;
  const dayLookback = (opts.day_lookback_days ?? 8) * 86400;
  const now = Math.floor(Date.now() / 1000);

  // 1h rollup
  // ts_hour is the unix start of the hour; bucket = floor(ts / 3600) * 3600
  const hourSince = now - hourLookback;
  const hourRows = db
    .prepare(
      `WITH bucketed AS (
         SELECT metric_key, project_id, org_id,
                (ts / 3600) * 3600 AS ts_hour, value
           FROM metrics
          WHERE ts >= ?
       )
       SELECT metric_key, project_id, org_id, ts_hour,
              SUM(value) AS sum, COUNT(*) AS count, AVG(value) AS avg,
              MIN(value) AS min, MAX(value) AS max
         FROM bucketed
        GROUP BY metric_key, project_id, org_id, ts_hour`,
    )
    .all(hourSince) as Array<{
    metric_key: string;
    project_id: string;
    org_id: string;
    ts_hour: number;
    sum: number;
    count: number;
    avg: number;
    min: number;
    max: number;
  }>;

  // Compute p50/p95/p99 per bucket via a separate scan (SQLite lacks
  // PERCENTILE_CONT). For each (key, project, ts_hour) pull values and sort.
  const upsert1h = db.prepare(
    `INSERT OR REPLACE INTO metrics_rollup_1h
     (metric_key, ts_hour, project_id, org_id, sum, count, avg, p50, p95, p99, min, max)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx1h = db.transaction(() => {
    for (const r of hourRows) {
      const valuesRow = db
        .prepare(
          `SELECT value FROM metrics
            WHERE metric_key = ? AND project_id = ? AND org_id = ?
              AND ts >= ? AND ts < ?
            ORDER BY value ASC`,
        )
        .all(r.metric_key, r.project_id, r.org_id, r.ts_hour, r.ts_hour + 3600) as Array<{ value: number }>;
      const values = valuesRow.map((x) => x.value);
      const p50 = percentile(values, 0.5);
      const p95 = percentile(values, 0.95);
      const p99 = percentile(values, 0.99);
      upsert1h.run(
        r.metric_key,
        r.ts_hour,
        r.project_id,
        r.org_id,
        r.sum,
        r.count,
        r.avg,
        p50,
        p95,
        p99,
        r.min,
        r.max,
      );
    }
  });
  tx1h();

  // 1d rollup
  const daySince = now - dayLookback;
  const dayRows = db
    .prepare(
      `WITH bucketed AS (
         SELECT metric_key, project_id, org_id,
                (ts / 86400) * 86400 AS ts_day, value
           FROM metrics
          WHERE ts >= ?
       )
       SELECT metric_key, project_id, org_id, ts_day,
              SUM(value) AS sum, COUNT(*) AS count, AVG(value) AS avg,
              MIN(value) AS min, MAX(value) AS max
         FROM bucketed
        GROUP BY metric_key, project_id, org_id, ts_day`,
    )
    .all(daySince) as Array<{
    metric_key: string;
    project_id: string;
    org_id: string;
    ts_day: number;
    sum: number;
    count: number;
    avg: number;
    min: number;
    max: number;
  }>;

  const upsert1d = db.prepare(
    `INSERT OR REPLACE INTO metrics_rollup_1d
     (metric_key, ts_day, project_id, org_id, sum, count, avg, p50, p95, p99, min, max)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx1d = db.transaction(() => {
    for (const r of dayRows) {
      const valuesRow = db
        .prepare(
          `SELECT value FROM metrics
            WHERE metric_key = ? AND project_id = ? AND org_id = ?
              AND ts >= ? AND ts < ?
            ORDER BY value ASC`,
        )
        .all(r.metric_key, r.project_id, r.org_id, r.ts_day, r.ts_day + 86400) as Array<{ value: number }>;
      const values = valuesRow.map((x) => x.value);
      const p50 = percentile(values, 0.5);
      const p95 = percentile(values, 0.95);
      const p99 = percentile(values, 0.99);
      upsert1d.run(
        r.metric_key,
        r.ts_day,
        r.project_id,
        r.org_id,
        r.sum,
        r.count,
        r.avg,
        p50,
        p95,
        p99,
        r.min,
        r.max,
      );
    }
  });
  tx1d();

  return {
    hour_buckets: hourRows.length,
    day_buckets: dayRows.length,
    duration_ms: performance.now() - started,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

/** Query helper for the admin endpoint. Resolution is auto-chosen. */
export interface MetricSeriesPoint {
  ts: number;
  value: number;
  count?: number;
  avg?: number;
  p95?: number;
}

export function fetchSeries(args: {
  org_id: string;
  metric_key: string;
  project_id?: string;
  from: number;
  to: number;
  resolution?: "raw" | "1h" | "1d";
}): { points: MetricSeriesPoint[]; resolution: "raw" | "1h" | "1d" } {
  const db = activeDbFor(args.org_id);
  const span = args.to - args.from;
  const resolution: "raw" | "1h" | "1d" =
    args.resolution ??
    (span < 24 * 3600 ? "raw" : span < 30 * 86400 ? "1h" : "1d");

  if (resolution === "raw") {
    const conds = ["metric_key = ?", "ts >= ?", "ts <= ?", "org_id = ?"];
    const params: (string | number)[] = [
      args.metric_key,
      args.from,
      args.to,
      args.org_id,
    ];
    if (args.project_id) {
      conds.push("project_id = ?");
      params.push(args.project_id);
    }
    const rows = db
      .prepare(
        `SELECT ts, value FROM metrics WHERE ${conds.join(" AND ")} ORDER BY ts ASC`,
      )
      .all(...params) as Array<{ ts: number; value: number }>;
    return { points: rows, resolution };
  }

  const table = resolution === "1h" ? "metrics_rollup_1h" : "metrics_rollup_1d";
  const tsCol = resolution === "1h" ? "ts_hour" : "ts_day";
  const conds = [
    "metric_key = ?",
    `${tsCol} >= ?`,
    `${tsCol} <= ?`,
    "org_id = ?",
  ];
  const params: (string | number)[] = [
    args.metric_key,
    args.from,
    args.to,
    args.org_id,
  ];
  if (args.project_id) {
    conds.push("project_id = ?");
    params.push(args.project_id);
  }
  const rows = db
    .prepare(
      `SELECT ${tsCol} AS ts, sum, count, avg, p95 FROM ${table}
        WHERE ${conds.join(" AND ")} ORDER BY ${tsCol} ASC`,
    )
    .all(...params) as Array<{
    ts: number;
    sum: number;
    count: number;
    avg: number;
    p95: number;
  }>;
  return {
    points: rows.map((r) => ({
      ts: r.ts,
      value: r.sum,
      count: r.count,
      avg: r.avg,
      p95: r.p95,
    })),
    resolution,
  };
}
