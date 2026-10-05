/**
 * Retention for brain OPERATIONAL TELEMETRY — ingest_events + metrics.
 *
 * These are bookkeeping rows (one+ per ingest/operation), NOT user content:
 * in one real install, a single org held ~69M ingest_events + ~69M metrics rows = ~37GB
 * of a 38GB file (artifacts + FTS were <1GB) and the disk hit full, which
 * crashed the server (heap OOM + SQLite 'disk is full'). Artifacts, thoughts,
 * edges, FTS — the actual archive — are NEVER touched here.
 *
 * Readers are window-bounded (health: recent counts; rollups: recent windows;
 * artifact-detail: latest event per hash), so a 30-day window is safe.
 *
 * NOTE: ts columns are in SECONDS (unix epoch), not milliseconds.
 */

import { activeDbFor } from "./active-db.js";

// 3 days, not 30: telemetry velocity is ~3M rows/day/table (metrics history
// lives in metrics_rollup_1h/1d; ingest_events' operational value is ~24h
// health counts + latest-event-per-artifact). 30d would have kept 52M rows.
export const TELEMETRY_RETENTION_DAYS = Number(process.env.NOSLEEP_BRAIN_TELEMETRY_DAYS ?? "3");
const BATCH = 20_000;

export interface PruneResult {
  events: number;
  metrics: number;
}

/**
 * Delete telemetry older than the retention window, in bounded batches with
 * event-loop yields (steady-state daily deltas are small; the one-time
 * backlog was cleared offline). Space is reused by SQLite (freelist) —
 * physical shrink only happens on VACUUM, which is an offline operation.
 */
export async function pruneBrainTelemetry(orgIds: readonly string[]): Promise<PruneResult> {
  const cutoffSec = Math.floor(Date.now() / 1000) - TELEMETRY_RETENTION_DAYS * 86_400;
  const result: PruneResult = { events: 0, metrics: 0 };

  for (const orgId of orgIds) {
    const db = activeDbFor(orgId);
    for (const table of ["ingest_events", "metrics"] as const) {
      for (;;) {
        const r = db
          .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ts < ? LIMIT ${BATCH})`)
          .run(cutoffSec);
        if (table === "ingest_events") result.events += r.changes;
        else result.metrics += r.changes;
        if (r.changes < BATCH) break;
        // Yield so a large backlog can't wedge the event loop.
        await new Promise((res) => setImmediate(res));
      }
    }
  }
  return result;
}
