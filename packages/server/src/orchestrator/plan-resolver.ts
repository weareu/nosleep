/**
 * Plan resolution for strategy tree nodes.
 *
 * Three resolution paths, in priority order:
 *   1. Node has `source_ref` set — read that file directly
 *   2. Vector search finds a matching doc in the project — link it, read it
 *   3. Filename/content keyword match in docs/plans/ or docs/architecture/
 *
 * Returns the (possibly augmented) goal text and the plan content to inject
 * into the system prompt. If no plan is found, the goal is rewritten to
 * "PLAN THEN EXECUTE" instructions.
 */

import type Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { VectorIndexer } from "../embeddings/vector-indexer.js";

export interface PlanResolution {
  readonly goal: string;
  readonly planContext: string | null;
}

const PLAN_TRUNCATE_CHARS = 4000;
const SEARCH_SUBDIRS = ["docs/plans", "docs/architecture", "docs"] as const;

export class PlanResolver {
  private readonly db: Database.Database;
  private readonly vectorIndexer: VectorIndexer | null;

  constructor(db: Database.Database, vectorIndexer: VectorIndexer | null = null) {
    this.db = db;
    this.vectorIndexer = vectorIndexer;
  }

  setVectorIndexer(indexer: VectorIndexer): void {
    (this as unknown as { vectorIndexer: VectorIndexer | null }).vectorIndexer = indexer;
  }

  /**
   * Resolve a goal against any available plan. Side-effect: may update the
   * strategy node's source_ref column when it discovers a matching file.
   */
  async resolve(
    goal: string,
    strategyNodeId: string | undefined,
    projectPath: string,
  ): Promise<PlanResolution> {
    if (!strategyNodeId) return { goal, planContext: null };

    const node = this.db.prepare(`
      SELECT title, description, source_ref FROM strategy_nodes WHERE id = ?
    `).get(strategyNodeId) as { title: string; description: string; source_ref: string | null } | undefined;
    if (!node) return { goal, planContext: null };

    // Path 1: explicit source_ref
    if (node.source_ref) {
      const filePath = node.source_ref.split(":")[0]; // strip :L42 line ref
      return this.tryReadPlan(filePath, projectPath, goal);
    }

    // Path 2: vector search
    const viaVector = await this.tryVectorMatch(strategyNodeId, node, projectPath, goal);
    if (viaVector) return viaVector;

    // Path 3: filesystem keyword search
    const viaKeyword = this.tryKeywordMatch(strategyNodeId, node, projectPath, goal);
    if (viaKeyword) return viaKeyword;

    // Fallback: no plan exists — instruct agent to write one first
    const slug = node.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      goal: this.buildPlanFirstGoal(slug, goal),
      planContext: null,
    };
  }

  private async tryVectorMatch(
    strategyNodeId: string,
    node: { title: string; description: string },
    projectPath: string,
    goal: string,
  ): Promise<PlanResolution | null> {
    if (!this.vectorIndexer) return null;
    try {
      const projectRow = this.db.prepare(`SELECT id FROM projects WHERE path = ?`).get(projectPath) as { id: string } | undefined;
      if (!projectRow) return null;
      const match = await this.vectorIndexer.findPlanForNode(
        projectRow.id, node.title, node.description || undefined,
      );
      if (!match || match.chunkType !== "doc") return null;
      const fullPath = isAbsolute(match.filePath) ? match.filePath : join(projectPath, match.filePath);
      this.db.prepare(`UPDATE strategy_nodes SET source_ref = ? WHERE id = ?`).run(fullPath, strategyNodeId);
      return this.tryReadPlan(fullPath, projectPath, goal);
    } catch {
      return null;
    }
  }

  private tryKeywordMatch(
    strategyNodeId: string,
    node: { title: string },
    projectPath: string,
    goal: string,
  ): PlanResolution | null {
    const titleLower = node.title.toLowerCase();
    const titleWords = titleLower.split(/\s+/).filter((w) => w.length >= 3);

    for (const subdir of SEARCH_SUBDIRS) {
      const dir = join(projectPath, subdir);
      if (!existsSync(dir)) continue;

      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }

      for (const file of files) {
        const fullPath = join(dir, file);
        let content: string;
        try {
          content = readFileSync(fullPath, "utf-8");
        } catch {
          continue;
        }
        const contentLower = content.toLowerCase();
        const exactMatch = contentLower.includes(titleLower);
        const wordHits = titleWords.filter((w) => contentLower.includes(w)).length;
        const wordMatchPct = titleWords.length > 0 ? wordHits / titleWords.length : 0;

        if (exactMatch || wordMatchPct >= 0.7) {
          this.db.prepare(`UPDATE strategy_nodes SET source_ref = ? WHERE id = ?`).run(fullPath, strategyNodeId);
          return this.tryReadPlan(fullPath, projectPath, goal);
        }
      }
    }
    return null;
  }

  private tryReadPlan(filePath: string, projectPath: string, goal: string): PlanResolution {
    const resolved = isAbsolute(filePath) ? filePath : join(projectPath, filePath);
    try {
      if (existsSync(resolved)) {
        const content = readFileSync(resolved, "utf-8");
        const truncated = content.length > PLAN_TRUNCATE_CHARS
          ? content.slice(0, PLAN_TRUNCATE_CHARS) + "\n\n[...plan truncated, read full file for details]"
          : content;
        return {
          goal,
          planContext: `# IMPLEMENTATION PLAN (from ${filePath})\n\n${truncated}`,
        };
      }
    } catch {
      // file not readable
    }
    return { goal, planContext: null };
  }

  private buildPlanFirstGoal(slug: string, originalGoal: string): string {
    return `PLAN THEN EXECUTE.\n\nStep 1: Create an implementation plan for this task. Write it to docs/plans/${slug}.md with:\n- ## sections for each phase\n- Acceptance criteria as - [ ] checkboxes\n- File changes needed\n- Risk assessment\n\nStep 2: Execute the plan.\n\nOriginal task:\n${originalGoal}`;
  }
}
