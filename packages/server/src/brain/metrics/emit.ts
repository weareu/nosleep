/**
 * Brain metrics emit. Append-only writes into the metrics table; no
 * blocking, no buffering — every call is one INSERT. Aggregation happens
 * in the rollup job, not here.
 *
 * Canonical key namespace lives in canonical-keys.ts. Callers passing
 * unknown keys still succeed (so emission can land before a key is added
 * to the registry), but the rollup dashboards filter to known keys.
 */

import { activeDbFor } from "../storage/active-db.js";

export interface EmitArgs {
  metric_key: string;
  value: number;
  org_id: string;
  project_id: string;
  tags?: Record<string, unknown>;
  ts?: number;
}

export function emit(args: EmitArgs): void {
  const db = activeDbFor(args.org_id);
  try {
    db.prepare(
      `INSERT INTO metrics (metric_key, ts, value, tags_json, project_id, org_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.metric_key,
      args.ts ?? Math.floor(Date.now() / 1000),
      args.value,
      args.tags ? JSON.stringify(args.tags) : null,
      args.project_id,
      args.org_id,
    );
  } catch {
    /* metric writes are best-effort; never throw into the caller */
  }
}

/** Convenience: emit a counter increment of 1. */
export function inc(
  metric_key: string,
  org_id: string,
  project_id: string,
  tags?: Record<string, unknown>,
): void {
  emit({ metric_key, value: 1, org_id, project_id, tags });
}

/** Convenience: emit a gauge or latency observation. */
export function observe(
  metric_key: string,
  value: number,
  org_id: string,
  project_id: string,
  tags?: Record<string, unknown>,
): void {
  emit({ metric_key, value, org_id, project_id, tags });
}
