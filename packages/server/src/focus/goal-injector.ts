import type Database from "better-sqlite3";
import { GOAL_REINJECT_EVERY_N_TOOLS } from "@nosleep/shared";
import type { AcceptanceCriterion } from "@nosleep/shared";

export class GoalInjector {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Returns true if a goal reminder should be injected based on tool call count.
   * Injects every GOAL_REINJECT_EVERY_N_TOOLS tool calls.
   */
  shouldInject(toolCallCount: number): boolean {
    if (toolCallCount === 0) return false;
    return toolCallCount % GOAL_REINJECT_EVERY_N_TOOLS === 0;
  }

  /**
   * Build a concise goal reminder string for injection into the session.
   */
  buildGoalReminder(sessionId: string): string | null {
    const row = this.db.prepare(`
      SELECT objective, acceptance_criteria, current_phase, progress_pct
      FROM goals
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId) as {
      objective: string;
      acceptance_criteria: string;
      current_phase: string;
      progress_pct: number;
    } | undefined;

    if (!row) return null;

    let criteria: readonly AcceptanceCriterion[];
    try {
      criteria = JSON.parse(row.acceptance_criteria) as AcceptanceCriterion[];
    } catch {
      criteria = [];
    }

    const metCount = criteria.filter((c) => c.met).length;
    const unmetCriteria = criteria
      .filter((c) => !c.met)
      .map((c) => `  - [ ] ${c.description}`);
    const metCriterialist = criteria
      .filter((c) => c.met)
      .map((c) => `  - [x] ${c.description}`);

    const lines = [
      `--- GOAL REMINDER (${row.progress_pct}% complete, phase: ${row.current_phase}) ---`,
      `Objective: ${row.objective}`,
      ``,
      `Criteria (${metCount}/${criteria.length} met):`,
      ...metCriterialist,
      ...unmetCriteria,
      ``,
      `Stay focused. Complete all unmet criteria. No stubs or TODOs.`,
      `---`,
    ];

    return lines.join("\n");
  }
}
