import type Database from "better-sqlite3";
import { DRIFT_CONFIDENCE_ALERT_THRESHOLD } from "@nosleep/shared";

interface ToolCall {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

interface DriftResult {
  readonly drifting: boolean;
  readonly confidence: number;
  readonly reason: string;
}

// Patterns that suggest off-task behavior
const UNRELATED_TOOL_PATTERNS = [
  "browser_navigate",
  "browser_click",
  "WebSearch",
  "WebFetch",
] as const;

export class DriftDetector {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Analyze recent session activity to detect drift from the stated goal.
   * Uses heuristics (no AI call). Checks:
   *   1. Files being edited are within the project directory
   *   2. Tool calls don't contain unrelated patterns
   *   3. Output doesn't contain off-topic indicators
   */
  detectDrift(
    sessionId: string,
    recentToolCalls: readonly ToolCall[],
    recentOutput: string,
  ): DriftResult {
    const projectPath = this.getProjectPath(sessionId);
    if (!projectPath) {
      return { drifting: false, confidence: 0, reason: "No project path found" };
    }

    const signals: string[] = [];
    let driftScore = 0;

    // 1. Check if files being edited are outside the project directory
    const fileEdits = recentToolCalls.filter(
      (tc) => tc.name === "Write" || tc.name === "Edit" || tc.name === "Read",
    );
    for (const edit of fileEdits) {
      const filePath = edit.args?.["file_path"] as string | undefined;
      if (filePath && !filePath.startsWith(projectPath)) {
        driftScore += 0.3;
        signals.push(`File access outside project: ${filePath}`);
      }
    }

    // 2. Check for unrelated tool call patterns
    const unrelatedCalls = recentToolCalls.filter((tc) =>
      UNRELATED_TOOL_PATTERNS.some((p) => tc.name.includes(p)),
    );
    if (unrelatedCalls.length > 0) {
      driftScore += 0.2 * unrelatedCalls.length;
      signals.push(
        `Unrelated tool calls: ${unrelatedCalls.map((tc) => tc.name).join(", ")}`,
      );
    }

    // 3. Check for off-topic output indicators
    const offTopicPatterns = [
      /let me help you with something else/i,
      /unrelated to the current task/i,
      /switching to a different/i,
      /let's work on something/i,
    ];
    for (const pattern of offTopicPatterns) {
      if (pattern.test(recentOutput)) {
        driftScore += 0.25;
        signals.push(`Off-topic output detected: ${pattern.source}`);
      }
    }

    // 4. Check for goal text mismatch via recent output analysis
    const goal = this.getGoalObjective(sessionId);
    if (goal && recentOutput.length > 100) {
      const goalWords = goal.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const outputWords = recentOutput.toLowerCase();
      const matchCount = goalWords.filter((w) => outputWords.includes(w)).length;
      const matchRatio = goalWords.length > 0 ? matchCount / goalWords.length : 1;

      if (matchRatio < 0.1 && recentOutput.length > 500) {
        driftScore += 0.2;
        signals.push("Output has very low relevance to goal keywords");
      }
    }

    // Cap at 1.0
    const confidence = Math.min(driftScore, 1.0);
    const drifting = confidence >= DRIFT_CONFIDENCE_ALERT_THRESHOLD;

    return {
      drifting,
      confidence: Math.round(confidence * 100) / 100,
      reason: signals.length > 0 ? signals.join("; ") : "No drift signals detected",
    };
  }

  // ── Internal ──────────────────────────────────────────

  private getProjectPath(sessionId: string): string | null {
    const row = this.db.prepare(`
      SELECT p.path
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
    `).get(sessionId) as { path: string } | undefined;

    return row?.path ?? null;
  }

  private getGoalObjective(sessionId: string): string | null {
    const row = this.db.prepare(`
      SELECT objective FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as { objective: string } | undefined;

    return row?.objective ?? null;
  }
}
