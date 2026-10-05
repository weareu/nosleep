import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { eventBus } from "../event-bus.js";
import { getLogger } from "../logger.js";

const log = getLogger("plan-ingester");

/**
 * Listens for plan:detected events and auto-ingests markdown plans into strategy trees.
 * Skips if the plan title already exists as a goal node (prevents duplicates).
 */
export function startPlanIngester(db: Database.Database): void {
  eventBus.on("plan:detected", (event: { filePath: string; projectId: string; orgId: string; sessionId: string }) => {
    try {
      ingestPlan(db, event.filePath, event.projectId, event.orgId);
    } catch (err) {
      log.error({ filePath: event.filePath, err }, "failed to ingest plan");
    }
  });
}

function ingestPlan(db: Database.Database, filePath: string, projectId: string, orgId: string): void {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Extract title from # heading
  const titleMatch = lines.find(l => /^# /.test(l));
  const planTitle = titleMatch?.replace(/^# /, "").trim() ?? basename(filePath, ".md");

  // Check for duplicate — skip if goal with this title already exists
  const existing = db.prepare(
    `SELECT id FROM strategy_nodes WHERE project_id = ? AND title = ? AND depth = 1`
  ).get(projectId, planTitle) as { id: string } | undefined;

  if (existing) {
    log.info({ planTitle, existingNodeId: existing.id }, "skipped — plan already ingested");
    return;
  }

  // Find root
  const root = db.prepare(`SELECT id FROM strategy_nodes WHERE project_id = ? AND parent_id IS NULL`).get(projectId) as { id: string } | undefined;
  if (!root) return;

  // Extract success criteria
  const criteria: string[] = [];
  for (const line of lines) {
    const m = line.match(/^- \[[ x]\] (.+)/);
    if (m) criteria.push(m[1].trim());
  }

  // Extract description
  let description = "";
  let inDesc = false;
  for (const line of lines) {
    if (/^# /.test(line)) { inDesc = true; continue; }
    if (/^## /.test(line)) break;
    if (inDesc && line.trim() && !line.startsWith(">")) description += line.trim() + " ";
  }

  const maxSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 as n FROM strategy_nodes WHERE parent_id = ?").get(root.id) as { n: number };
  let sortCounter = maxSort.n;

  // Create goal node with source reference
  const goalId = nanoid();
  db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, status, progress_pct, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens, source_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(goalId, projectId, orgId, root.id, "goal", planTitle, description.trim().slice(0, 500), "pending", 0, 1, sortCounter++, "[]", JSON.stringify(criteria), 2, 0, filePath);

  // Extract ## headings as tasks with line number tracking
  let taskCount = 0;
  let currentTitle = "";
  let currentDesc = "";
  let currentCriteria: string[] = [];
  let currentStartLine = 0;
  let taskSort = 0;

  // Skip non-actionable sections (docs, references, tables, architecture descriptions)
  const SKIP_HEADINGS = /^(problem|requirements?|architecture|existing|format|protocol|risks?|success criteria|implementation order|summary|overview|background|context|references?|appendix|glossary|table of contents)/i;

  function flushTask(): void {
    if (!currentTitle) return;
    // Skip doc/reference sections — only create tasks for actionable items
    if (SKIP_HEADINGS.test(currentTitle)) return;
    // Skip sections with no real content (just tables or code blocks)
    if (currentDesc.trim().length < 20 && currentCriteria.length === 0) return;
    const ref = `${filePath}:L${currentStartLine}`;
    db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, status, progress_pct, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens, source_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nanoid(), projectId, orgId, goalId, "task", currentTitle, currentDesc.trim().slice(0, 500), "pending", 0, 2, taskSort++, "[]", JSON.stringify(currentCriteria), 1, 0, ref);
    taskCount++;
    currentTitle = "";
    currentDesc = "";
    currentCriteria = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      flushTask();
      currentTitle = h2[1].trim();
      currentStartLine = i + 1; // 1-indexed
      continue;
    }
    if (currentTitle) {
      const success = line.match(/^\*\*Success[:\*]*\*?\*?\s*(.+)/i);
      if (success) { currentCriteria.push(success[1].trim()); continue; }
      const bullet = line.match(/^- \[[ x]\] (.+)/);
      if (bullet) { currentCriteria.push(bullet[1].trim()); continue; }
      if (line.trim() && !line.startsWith("|") && !line.startsWith("```") && !line.startsWith("#")) {
        currentDesc += line.trim() + " ";
      }
    }
  }
  flushTask();

  // Recalculate root progress
  const children = db.prepare("SELECT progress_pct, weight FROM strategy_nodes WHERE parent_id = ?").all(root.id) as Array<{ progress_pct: number; weight: number }>;
  const totalW = children.reduce((s, c) => s + (c.weight || 1), 0);
  const wp = children.reduce((s, c) => s + c.progress_pct * (c.weight || 1), 0);
  db.prepare("UPDATE strategy_nodes SET progress_pct = ? WHERE id = ?").run(Math.round(wp / totalW), root.id);

  log.info({ planTitle, taskCount }, "ingested plan");

  // Create an alert so the user knows
  db.prepare(`INSERT INTO alerts (org_id, type, severity, message) VALUES (?, 'info', 'info', ?)`)
    .run(orgId, `Plan auto-ingested into strategy tree: "${planTitle}" (${taskCount} tasks)`);
}
