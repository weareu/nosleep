/**
 * Model selection: explicit > strategy node > project default > opus.
 * Budget pacing can downgrade the choice (slow → opus becomes sonnet, critical → haiku).
 */

import type Database from "better-sqlite3";

export class ModelRouter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Resolve which model to use for a session launch. Pacing always wins:
   *   - `critical` mode forces haiku regardless of any other preference
   *   - `slow` mode downgrades opus to sonnet but respects explicit non-opus picks
   *   - other modes follow the preference chain
   */
  resolveModel(
    explicit: string | undefined,
    strategyNodeId: string | undefined,
    projectId: string,
    pacingMode: string,
  ): string {
    if (pacingMode === "critical") return "haiku";

    if (pacingMode === "slow") {
      const base = explicit ?? this.getNodeModel(strategyNodeId) ?? this.getProjectModel(projectId) ?? "opus";
      return base === "opus" ? "sonnet" : base;
    }

    return explicit ?? this.getNodeModel(strategyNodeId) ?? this.getProjectModel(projectId) ?? "opus";
  }

  getNodeModel(nodeId: string | undefined): string | null {
    if (!nodeId) return null;
    const row = this.db.prepare(`SELECT recommended_model FROM strategy_nodes WHERE id = ?`).get(nodeId) as { recommended_model: string | null } | undefined;
    return row?.recommended_model ?? null;
  }

  getProjectModel(projectId: string): string | null {
    const row = this.db.prepare(`SELECT default_model FROM projects WHERE id = ?`).get(projectId) as { default_model: string | null } | undefined;
    return row?.default_model ?? null;
  }
}
