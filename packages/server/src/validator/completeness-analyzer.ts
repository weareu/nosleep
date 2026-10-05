import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { STUB_PATTERNS } from "@nosleep/shared";
import type {
  ValidationResult,
  ValidationDetails,
  CriterionResult,
  AcceptanceCriterion,
  ValidationVerdict,
} from "@nosleep/shared";
import { GoalManager } from "../focus/goal-manager.js";
import { validateWithAi } from "./ai-validator.js";
import { eventBus } from "../event-bus.js";

interface AnalysisInput {
  readonly modifiedFiles: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly diffSummary: string;
}

export class CompletenessAnalyzer {
  private readonly db: Database.Database;
  private readonly goalManager: GoalManager;

  constructor(db: Database.Database, goalManager: GoalManager) {
    this.db = db;
    this.goalManager = goalManager;
  }

  /**
   * Analyze work output against acceptance criteria.
   * Uses AI (Haiku via Claude CLI) for intelligent evaluation,
   * falls back to heuristics if AI is unavailable.
   */
  async analyzeCompleteness(
    goalId: string,
    changes: AnalysisInput,
    projectPath: string,
  ): Promise<ValidationResult | null> {
    const goal = this.goalManager.getGoalById(goalId);
    if (!goal) return null;

    // 1. Scan for stub patterns in modified files (always run, cheap)
    const stubPatterns = this.detectStubs(changes.modifiedFiles, projectPath);

    // 2. AI-powered evaluation of acceptance criteria
    let criteriaResults: readonly CriterionResult[];
    let validatorModel: string;

    try {
      const aiResult = await validateWithAi({
        objective: goal.objective,
        acceptanceCriteria: goal.acceptanceCriteria,
        modifiedFiles: changes.modifiedFiles,
        diffSummary: changes.diffSummary,
        stubPatterns,
        projectPath,
      });

      criteriaResults = aiResult.criteriaResults;
      validatorModel = "haiku-ai";

      // AI might catch stubs we missed, or override verdict
      // But we still trust our own stub scanner as ground truth
    } catch {
      // AI unavailable — fall back to heuristics
      criteriaResults = this.evaluateCriteriaHeuristic(
        goal.acceptanceCriteria,
        changes,
      );
      validatorModel = "heuristic";
    }

    // 3. Determine verdict
    const hasStubs = stubPatterns.length > 0;
    const allCriteriaMet = criteriaResults.every((c) => c.status === "met");

    let verdict: ValidationVerdict;
    if (hasStubs) {
      verdict = "stub";
    } else if (allCriteriaMet) {
      verdict = "complete";
    } else {
      verdict = "incomplete";
    }

    const overallNotes = this.buildOverallNotes(verdict, stubPatterns, criteriaResults);

    const details: ValidationDetails = {
      criteriaResults,
      stubPatterns,
      coverageCheck: null,
      overallNotes,
    };

    // Persist validation result
    const sessionId = this.getSessionIdForGoal(goalId);
    if (!sessionId) return null;

    const result = this.db.prepare(`
      INSERT INTO validations (session_id, goal_id, verdict, details, validator_model)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, goalId, verdict, JSON.stringify(details), validatorModel);

    const validationResult: ValidationResult = {
      id: result.lastInsertRowid as number,
      sessionId,
      goalId,
      verdict,
      details,
      validatorModel,
      createdAt: new Date().toISOString(),
    };

    eventBus.emit("validation:result", validationResult);
    return validationResult;
  }

  // ── Internal ──────────────────────────────────────────

  private detectStubs(
    files: readonly string[],
    projectPath: string,
  ): readonly string[] {
    const found: string[] = [];

    for (const file of files) {
      try {
        const fullPath = file.startsWith("/") ? file : join(projectPath, file);
        const content = readFileSync(fullPath, "utf-8");

        for (const pattern of STUB_PATTERNS) {
          if (content.includes(pattern)) {
            found.push(`${file}: ${pattern}`);
          }
        }
      } catch {
        // File may have been deleted or moved
      }
    }

    return found;
  }

  private evaluateCriteriaHeuristic(
    criteria: readonly AcceptanceCriterion[],
    changes: AnalysisInput,
  ): readonly CriterionResult[] {
    return criteria.map((criterion) => {
      if (criterion.met) {
        return {
          criterion: criterion.description,
          status: "met" as const,
          notes: "Marked as met during session",
        };
      }

      const relevance = this.estimateCriterionRelevance(
        criterion.description,
        changes.modifiedFiles,
      );

      if (relevance > 0.5 && changes.additions > 0) {
        return {
          criterion: criterion.description,
          status: "partial" as const,
          notes: `Related files modified (${relevance.toFixed(1)} relevance), but not confirmed`,
        };
      }

      return {
        criterion: criterion.description,
        status: "not_met" as const,
        notes: "No evidence of completion in modified files",
      };
    });
  }

  private estimateCriterionRelevance(
    description: string,
    modifiedFiles: readonly string[],
  ): number {
    const keywords = description
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    if (keywords.length === 0 || modifiedFiles.length === 0) return 0;

    const fileText = modifiedFiles.join(" ").toLowerCase();
    const matches = keywords.filter((kw) => fileText.includes(kw));

    return matches.length / keywords.length;
  }

  private buildOverallNotes(
    verdict: ValidationVerdict,
    stubs: readonly string[],
    criteria: readonly CriterionResult[],
  ): string {
    const parts: string[] = [];

    if (verdict === "complete") {
      parts.push("All acceptance criteria verified as met.");
    } else if (verdict === "stub") {
      parts.push(`Found ${stubs.length} stub pattern(s) in modified files.`);
    } else {
      const notMet = criteria.filter((c) => c.status === "not_met");
      const partial = criteria.filter((c) => c.status === "partial");
      parts.push(
        `${notMet.length} criteria not met, ${partial.length} partially met.`,
      );
    }

    return parts.join(" ");
  }

  private getSessionIdForGoal(goalId: string): string | null {
    const row = this.db.prepare(`
      SELECT session_id FROM goals WHERE id = ?
    `).get(goalId) as { session_id: string } | undefined;

    return row?.session_id ?? null;
  }
}
