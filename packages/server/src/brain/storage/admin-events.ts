/**
 * Admin/maintenance audit trail in brain_session_events (append-only, shown
 * on the Brain admin Events page under table=brain_session_events).
 * Rows use session_id "_admin" and project_id "_org_level".
 */

import { nanoid } from "nanoid";
import { activeDbFor } from "./active-db.js";

const ADMIN_SESSION_ID = "_admin";

/** Best-effort: a failed audit write never fails the operation it records. */
export function recordBrainAdminEvent(
  orgId: string,
  type: string,
  payload: Record<string, unknown>,
  tsSec: number = Math.floor(Date.now() / 1000),
): void {
  try {
    activeDbFor(orgId)
      .prepare(
        `INSERT INTO brain_session_events
         (event_id, ts, session_id, event_type, payload_json, project_id, org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nanoid(), tsSec, ADMIN_SESSION_ID, type, JSON.stringify(payload), "_org_level", orgId);
  } catch {
    /* audit is best-effort */
  }
}

export interface BrainAdminEvent {
  ts: number;
  payload: Record<string, unknown>;
}

/** Most recent admin events of one type, newest first. */
export function listBrainAdminEvents(orgId: string, type: string, limit: number): BrainAdminEvent[] {
  const rows = activeDbFor(orgId)
    .prepare(
      `SELECT ts, payload_json FROM brain_session_events
        WHERE session_id = ? AND event_type = ? AND org_id = ?
        ORDER BY ts DESC, rowid DESC
        LIMIT ?`,
    )
    .all(ADMIN_SESSION_ID, type, orgId, Math.max(1, Math.min(limit, 500))) as Array<{
    ts: number;
    payload_json: string | null;
  }>;
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : {};
    } catch {
      /* malformed payload → empty */
    }
    return { ts: r.ts, payload };
  });
}
