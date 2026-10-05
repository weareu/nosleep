import type Database from "better-sqlite3";

export type SessionEventType =
  | "tool_use"
  | "text_output"
  | "question_detected"
  | "question_response"
  | "escalation_created"
  | "escalation_resolved"
  | "human_response"
  | "auto_continued"
  | "auto_registered"
  | "autonomy_injected"
  | "goal_injected"
  | "drift_detected"
  | "compaction_detected"
  | "compaction_recovery"
  | "validation_started"
  | "validation_result"
  | "retry_launched"
  | "strategy_advanced"
  | "plan_ingested"
  | "file_lock_warning"
  | "coordination_message"
  | "scheduled_task_run"
  | "budget_warning"
  | "status_change"
  | "session_started"
  | "session_completed"
  | "error";

export interface SessionEvent {
  readonly id: number;
  readonly sessionId: string;
  readonly eventType: SessionEventType;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

/**
 * Queryable event log for sessions.
 * Enables post-mortem debugging, cross-session learning, and escalation tracking.
 */
export class SessionEventStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO session_events (session_id, event_type, payload)
      VALUES (?, ?, ?)
    `);
  }

  /**
   * Record an event for a session.
   */
  record(sessionId: string, eventType: SessionEventType, payload: Record<string, unknown> = {}): void {
    this.insertStmt.run(sessionId, eventType, JSON.stringify(payload));
  }

  /**
   * Get all events for a session, newest first.
   */
  getBySession(sessionId: string, limit = 200): readonly SessionEvent[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, event_type, payload, created_at
      FROM session_events
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: number;
      session_id: string;
      event_type: SessionEventType;
      payload: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      eventType: r.event_type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  /**
   * Get events of a specific type for a session.
   */
  getByType(sessionId: string, eventType: SessionEventType, limit = 50): readonly SessionEvent[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, event_type, payload, created_at
      FROM session_events
      WHERE session_id = ? AND event_type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, eventType, limit) as Array<{
      id: number;
      session_id: string;
      event_type: SessionEventType;
      payload: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      eventType: r.event_type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  /**
   * Get pending escalations (questions awaiting human input).
   * Optionally filtered by org to enforce isolation.
   */
  getPendingEscalations(orgId?: string): readonly SessionEvent[] {
    const orgFilter = orgId
      ? `AND e.session_id IN (SELECT s.id FROM sessions s JOIN projects p ON s.project_id = p.id WHERE p.org_id = ?)`
      : "";
    const params = orgId ? [orgId] : [];

    const rows = this.db.prepare(`
      SELECT e.id, e.session_id, e.event_type, e.payload, e.created_at
      FROM session_events e
      WHERE e.event_type = 'escalation_created'
        ${orgFilter}
        AND NOT EXISTS (
          SELECT 1 FROM session_events r
          WHERE r.session_id = e.session_id
            AND r.event_type IN ('escalation_resolved', 'human_response')
            AND r.created_at > e.created_at
            AND json_extract(r.payload, '$.escalationId') = json_extract(e.payload, '$.escalationId')
        )
      ORDER BY e.created_at DESC
      LIMIT 50
    `).all(...params) as Array<{
      id: number;
      session_id: string;
      event_type: SessionEventType;
      payload: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      eventType: r.event_type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  /**
   * Count events by type for a session (useful for metrics).
   */
  countByType(sessionId: string): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM session_events
      WHERE session_id = ?
      GROUP BY event_type
    `).all(sessionId) as Array<{ event_type: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.event_type] = r.count;
    }
    return counts;
  }

  /**
   * Prune old events to prevent unbounded growth.
   * Keeps the most recent N events per session.
   */
  prune(maxPerSession = 500): number {
    // Delete events beyond the limit for each session
    const result = this.db.prepare(`
      DELETE FROM session_events
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC) as rn
          FROM session_events
        ) WHERE rn <= ?
      )
    `).run(maxPerSession);

    return result.changes;
  }
}
