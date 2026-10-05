import type Database from "better-sqlite3";
import type { TokenUsage } from "@nosleep/shared";
import { eventBus } from "../event-bus.js";

interface RecordUsageParams {
  readonly sessionId: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}

interface DailyUsage {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export class TokenTracker {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Record a token usage event and emit it on the event bus.
   */
  recordUsage(params: RecordUsageParams): TokenUsage {
    const result = this.db.prepare(`
      INSERT INTO token_usage (session_id, account_id, project_id, input_tokens, output_tokens, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.sessionId,
      params.accountId,
      params.projectId,
      params.inputTokens,
      params.outputTokens,
      params.model,
    );

    const usage: TokenUsage = {
      id: result.lastInsertRowid as number,
      sessionId: params.sessionId,
      accountId: params.accountId,
      projectId: params.projectId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      model: params.model,
      recordedAt: new Date().toISOString(),
    };

    eventBus.emit("budget:update", usage);
    return usage;
  }

  /**
   * Get total token usage for an account on a given day (defaults to today).
   */
  getDailyUsage(accountId: string, date?: string): UsageSummary {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM token_usage
      WHERE account_id = ?
        AND date(recorded_at) = ?
    `).get(accountId, targetDate) as {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    };
  }

  /**
   * Get total token usage for a project across all time.
   */
  getProjectUsage(projectId: string): UsageSummary {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM token_usage
      WHERE project_id = ?
    `).get(projectId) as {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    };
  }

  /**
   * Get total token usage for a specific session.
   */
  getSessionUsage(sessionId: string): UsageSummary {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM token_usage
      WHERE session_id = ?
    `).get(sessionId) as {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    };
  }

  /**
   * Get monthly usage for an account (defaults to current month).
   */
  getMonthlyUsage(accountId: string, yearMonth?: string): UsageSummary {
    const target = yearMonth ?? new Date().toISOString().slice(0, 7);

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM token_usage
      WHERE account_id = ?
        AND strftime('%Y-%m', recorded_at) = ?
    `).get(accountId, target) as {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    };
  }

  /**
   * Get total token usage for an account since a given date (for billing cycle queries).
   */
  getCycleUsage(accountId: string, sinceDate: string): UsageSummary {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM token_usage
      WHERE account_id = ?
        AND recorded_at >= ?
    `).get(accountId, sinceDate) as {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
    };
  }

  /**
   * Get today's usage for an account (alias for getDailyUsage with today's date).
   */
  getTodayUsage(accountId: string): UsageSummary {
    return this.getDailyUsage(accountId);
  }

  /**
   * Get daily breakdown for an account over the last N days.
   */
  getDailyBreakdown(accountId: string, days: number): readonly DailyUsage[] {
    const rows = this.db.prepare(`
      SELECT
        date(recorded_at) AS date,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(input_tokens + output_tokens) AS total_tokens
      FROM token_usage
      WHERE account_id = ?
        AND recorded_at >= datetime('now', ?)
      GROUP BY date(recorded_at)
      ORDER BY date(recorded_at) ASC
    `).all(accountId, `-${days} days`) as readonly {
      date: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }[];

    return rows.map((r) => ({
      date: r.date,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
    }));
  }
}
