/**
 * Insert an alert row and broadcast it to subscribers.
 *
 * Centralizes the "INSERT then emit" pattern so call sites only need to think
 * about message content. Returns the inserted alert ID for callers that need
 * to acknowledge it later.
 */

import type Database from "better-sqlite3";
import type { Alert } from "@nosleep/shared";
import { eventBus } from "../event-bus.js";

export interface AlertInput {
  readonly orgId: string;
  readonly sessionId?: string | null;
  readonly projectId?: string | null;
  readonly type: string;
  readonly severity: "info" | "warning" | "critical" | string;
  readonly message: string;
}

export function emitAlert(db: Database.Database, input: AlertInput): number {
  const result = db.prepare(`
    INSERT INTO alerts (org_id, session_id, project_id, type, severity, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.orgId,
    input.sessionId ?? null,
    input.projectId ?? null,
    input.type,
    input.severity,
    input.message,
  );

  const alert: Alert = {
    id: result.lastInsertRowid as number,
    orgId: input.orgId,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    type: input.type as Alert["type"],
    severity: input.severity as Alert["severity"],
    message: input.message,
    acknowledged: false,
    createdAt: new Date().toISOString(),
  };

  eventBus.emit("alert:new", alert);
  return alert.id;
}
