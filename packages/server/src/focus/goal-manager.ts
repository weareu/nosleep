import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { Goal, AcceptanceCriterion } from "@nosleep/shared";
import { eventBus } from "../event-bus.js";

interface CreateGoalParams {
  readonly sessionId: string;
  readonly projectId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
}

interface UpdateProgressParams {
  readonly phase: string;
  readonly progressPct: number;
  readonly criteriaCompleted: readonly number[];
}

export class GoalManager {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a new goal for a session.
   */
  createGoal(params: CreateGoalParams): Goal {
    const id = nanoid();
    const criteria: readonly AcceptanceCriterion[] = params.acceptanceCriteria.map(
      (desc) => ({ description: desc, met: false }),
    );

    this.db.prepare(`
      INSERT INTO goals (id, session_id, project_id, objective, acceptance_criteria)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, params.sessionId, params.projectId, params.objective, JSON.stringify(criteria));

    return this.getGoal(params.sessionId)!;
  }

  /**
   * Get the goal for a given session.
   */
  getGoal(sessionId: string): Goal | null {
    const row = this.db.prepare(`
      SELECT * FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToGoal(row);
  }

  /**
   * Get a goal by its own ID.
   */
  getGoalById(goalId: string): Goal | null {
    const row = this.db.prepare(`
      SELECT * FROM goals WHERE id = ?
    `).get(goalId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToGoal(row);
  }

  /**
   * Update goal progress: phase, percentage, and which criteria are now met.
   */
  updateProgress(goalId: string, params: UpdateProgressParams): Goal | null {
    const existing = this.getGoalById(goalId);
    if (!existing) return null;

    // Update criteria met status based on indices
    const updatedCriteria: readonly AcceptanceCriterion[] = existing.acceptanceCriteria.map(
      (c, i) => ({
        description: c.description,
        met: params.criteriaCompleted.includes(i) || c.met,
      }),
    );

    this.db.prepare(`
      UPDATE goals
      SET current_phase = ?,
          progress_pct = ?,
          acceptance_criteria = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      params.phase,
      params.progressPct,
      JSON.stringify(updatedCriteria),
      goalId,
    );

    const updated = this.getGoalById(goalId);
    if (updated) {
      eventBus.emit("goal:progress", updated);
    }
    return updated;
  }

  /**
   * Mark all criteria as met and set progress to 100%.
   */
  markComplete(goalId: string): Goal | null {
    const existing = this.getGoalById(goalId);
    if (!existing) return null;

    const allIndices = existing.acceptanceCriteria.map((_, i) => i);
    return this.updateProgress(goalId, {
      phase: "complete",
      progressPct: 100,
      criteriaCompleted: allIndices,
    });
  }

  // ── Internal ──────────────────────────────────────────

  private rowToGoal(row: Record<string, unknown>): Goal {
    const rawCriteria = row.acceptance_criteria as string;
    let criteria: readonly AcceptanceCriterion[];
    try {
      criteria = JSON.parse(rawCriteria) as AcceptanceCriterion[];
    } catch {
      criteria = [];
    }

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      projectId: row.project_id as string,
      objective: row.objective as string,
      acceptanceCriteria: criteria,
      currentPhase: row.current_phase as string,
      progressPct: row.progress_pct as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
