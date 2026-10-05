import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { SessionMessage, SessionMessageType, FileLock } from "@nosleep/shared";

interface LockResult {
  readonly success: boolean;
  readonly holder?: {
    readonly sessionId: string;
    readonly lockedAt: string;
  };
}

interface PeerInfo {
  // Snake-case shape consumed by the web dashboard (Coordination page).
  readonly id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly goal_text: string;
  readonly status: string;
  readonly started_at: string;
  readonly org_id: string;
  readonly org_name: string;
  readonly org_color: string;
}

export class Coordinator {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── Messaging ────────────────────────────────────────────

  /**
   * Send a message between sessions (or broadcast to all in an org).
   */
  sendMessage(
    fromSessionId: string,
    toSessionId: string | null,
    orgId: string,
    type: SessionMessageType,
    payload: string,
  ): string {
    const id = nanoid();
    this.db.prepare(`
      INSERT INTO session_messages (id, from_session_id, to_session_id, org_id, type, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, fromSessionId, toSessionId, orgId, type, payload);
    return id;
  }

  /**
   * Get unread messages for a session (direct + broadcast), mark as read. Limit 20.
   */
  getInbox(sessionId: string, orgId: string): readonly SessionMessage[] {
    const rows = this.db.prepare(`
      SELECT id, from_session_id, to_session_id, org_id, type, payload, read, created_at
      FROM session_messages
      WHERE read = 0
        AND (to_session_id = ? OR (to_session_id IS NULL AND org_id = ? AND from_session_id != ?))
      ORDER BY created_at ASC
      LIMIT 20
    `).all(sessionId, orgId, sessionId) as Array<{
      id: string;
      from_session_id: string;
      to_session_id: string | null;
      org_id: string;
      type: SessionMessageType;
      payload: string;
      read: number;
      created_at: string;
    }>;

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.prepare(`UPDATE session_messages SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
    }

    return rows.map((r) => ({
      id: r.id,
      fromSessionId: r.from_session_id,
      toSessionId: r.to_session_id,
      orgId: r.org_id,
      type: r.type,
      payload: r.payload,
      read: true,
      createdAt: r.created_at,
    }));
  }

  /**
   * Count unread messages without marking read.
   */
  peekInbox(sessionId: string, orgId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM session_messages
      WHERE read = 0
        AND (to_session_id = ? OR (to_session_id IS NULL AND org_id = ? AND from_session_id != ?))
    `).get(sessionId, orgId, sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Recent messages for dashboard display.
   */
  getMessageLog(orgId: string, limit: number = 50): readonly SessionMessage[] {
    const rows = this.db.prepare(`
      SELECT id, from_session_id, to_session_id, org_id, type, payload, read, created_at
      FROM session_messages
      WHERE org_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(orgId, limit) as Array<{
      id: string;
      from_session_id: string;
      to_session_id: string | null;
      org_id: string;
      type: SessionMessageType;
      payload: string;
      read: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      fromSessionId: r.from_session_id,
      toSessionId: r.to_session_id,
      orgId: r.org_id,
      type: r.type,
      payload: r.payload,
      read: r.read === 1,
      createdAt: r.created_at,
    }));
  }

  // ── File Locks ───────────────────────────────────────────

  /**
   * Acquire a file lock. Returns success or the current holder.
   */
  lockFile(sessionId: string, orgId: string, filePath: string): LockResult {
    const id = nanoid();
    try {
      this.db.prepare(`
        INSERT INTO file_locks (id, session_id, org_id, file_path)
        VALUES (?, ?, ?, ?)
      `).run(id, sessionId, orgId, filePath);
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE constraint failed")) {
        const existing = this.checkFileLock(orgId, filePath);
        if (existing) {
          return {
            success: false,
            holder: {
              sessionId: existing.sessionId,
              lockedAt: existing.lockedAt,
            },
          };
        }
      }
      throw err;
    }
  }

  /**
   * Release a file lock for a specific session and file.
   */
  unlockFile(sessionId: string, filePath: string): void {
    this.db.prepare(`
      UPDATE file_locks SET released_at = datetime('now')
      WHERE session_id = ? AND file_path = ? AND released_at IS NULL
    `).run(sessionId, filePath);
  }

  /**
   * Check if a file is locked.
   */
  checkFileLock(orgId: string, filePath: string): FileLock | null {
    const row = this.db.prepare(`
      SELECT id, session_id, org_id, file_path, locked_at, released_at
      FROM file_locks
      WHERE org_id = ? AND file_path = ? AND released_at IS NULL
    `).get(orgId, filePath) as {
      id: string;
      session_id: string;
      org_id: string;
      file_path: string;
      locked_at: string;
      released_at: string | null;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      orgId: row.org_id,
      filePath: row.file_path,
      lockedAt: row.locked_at,
      releasedAt: row.released_at,
    };
  }

  /**
   * Get all active (unreleased) locks, optionally filtered by org.
   */
  getActiveLocks(orgId?: string): readonly FileLock[] {
    const query = orgId
      ? `SELECT id, session_id, org_id, file_path, locked_at, released_at
         FROM file_locks WHERE org_id = ? AND released_at IS NULL ORDER BY locked_at DESC`
      : `SELECT id, session_id, org_id, file_path, locked_at, released_at
         FROM file_locks WHERE released_at IS NULL ORDER BY locked_at DESC`;

    const rows = (orgId
      ? this.db.prepare(query).all(orgId)
      : this.db.prepare(query).all()
    ) as Array<{
      id: string;
      session_id: string;
      org_id: string;
      file_path: string;
      locked_at: string;
      released_at: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      orgId: r.org_id,
      filePath: r.file_path,
      lockedAt: r.locked_at,
      releasedAt: r.released_at,
    }));
  }

  /**
   * Release all locks held by a session. Returns count released.
   */
  releaseSessionLocks(sessionId: string): number {
    const result = this.db.prepare(`
      UPDATE file_locks SET released_at = datetime('now')
      WHERE session_id = ? AND released_at IS NULL
    `).run(sessionId);
    return result.changes;
  }

  /**
   * Release locks from sessions that are no longer active (completed/failed/stopped).
   */
  cleanupStaleLocks(): number {
    const result = this.db.prepare(`
      UPDATE file_locks SET released_at = datetime('now')
      WHERE released_at IS NULL
        AND session_id IN (
          SELECT id FROM sessions WHERE status IN ('completed', 'failed', 'stopped')
        )
    `).run();
    return result.changes;
  }

  // ── Peers ────────────────────────────────────────────────

  /**
   * Get currently running sessions with project name and goal.
   */
  getActivePeers(orgId?: string): readonly PeerInfo[] {
    const baseSql = `
      SELECT s.id           AS session_id,
             s.project_id   AS project_id,
             p.name         AS project_name,
             s.goal_text    AS goal_text,
             s.status       AS status,
             s.started_at   AS started_at,
             o.id           AS org_id,
             o.name         AS org_name,
             o.color        AS org_color
        FROM sessions s
        JOIN projects p      ON p.id = s.project_id
        JOIN organizations o ON o.id = p.org_id
       WHERE s.status IN ('starting', 'running', 'idle', 'waiting_input')`;

    const query = orgId
      ? baseSql + " AND p.org_id = ? ORDER BY s.started_at DESC"
      : baseSql + " ORDER BY s.started_at DESC";

    const rows = (
      orgId ? this.db.prepare(query).all(orgId) : this.db.prepare(query).all()
    ) as Array<{
      session_id: string;
      project_id: string;
      project_name: string;
      goal_text: string;
      status: string;
      started_at: string;
      org_id: string;
      org_name: string;
      org_color: string;
    }>;

    return rows.map((r) => ({
      id: r.session_id,
      project_id: r.project_id,
      project_name: r.project_name,
      goal_text: r.goal_text,
      status: r.status,
      started_at: r.started_at,
      org_id: r.org_id,
      org_name: r.org_name,
      org_color: r.org_color,
    }));
  }
}
