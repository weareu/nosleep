import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import {
  STATUS_ICONS as statusIcons, parseDeps, parseCriteria, type StrategyRow,
  getStrategyNode, listProjectStrategy, listProjectStrategyByDepth,
  getStrategyChildren, getStrategyPath, getNextSortOrder,
  sessionInOrg, listSessionDriftAlerts, listOrgAlerts,
} from "@nosleep/shared";

const DB_PATH = process.env.DB_PATH ?? "./data/nosleep.db";
const ORG_ID = process.env.NOSLEEP_ORG_ID;

if (!ORG_ID) {
  console.error("FATAL: NOSLEEP_ORG_ID is required. Control MCP must be scoped to an organization.");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: false });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const org = db.prepare(`SELECT id, name, slug FROM organizations WHERE id = ?`).get(ORG_ID) as
  { id: string; name: string; slug: string } | undefined;
if (!org) {
  console.error(`FATAL: Organization '${ORG_ID}' not found.`);
  process.exit(1);
}

const server = new McpServer({
  name: `nosleep-control-${org.slug}`,
  version: "0.1.0",
});

// ── goal_get ────────────────────────────────────────────

server.tool(
  "goal_get",
  "Retrieve your current goal and acceptance criteria. Call this after context compaction to re-read your mission.",
  {
    sessionId: z.string().optional().describe("Session ID, auto-detected if omitted"),
  },
  async ({ sessionId }) => {
    const sid = sessionId ?? process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { content: [{ type: "text" as const, text: "No session ID available. Set NOSLEEP_SESSION_ID or pass sessionId." }] };
    }

    if (!sessionInOrg(db, sid, ORG_ID)) {
      return { content: [{ type: "text" as const, text: "Session not found in this organization." }] };
    }

    const goal = db.prepare(`
      SELECT g.objective, g.acceptance_criteria, g.current_phase, g.progress_pct
      FROM goals g
      WHERE g.session_id = ?
      ORDER BY g.created_at DESC
      LIMIT 1
    `).get(sid) as { objective: string; acceptance_criteria: string; current_phase: string; progress_pct: number } | undefined;

    if (!goal) {
      return { content: [{ type: "text" as const, text: "No goal found for this session." }] };
    }

    const criteria = JSON.parse(goal.acceptance_criteria) as Array<{ description: string; met: boolean }>;
    const criteriaText = criteria
      .map((c, i) => `  ${c.met ? "[x]" : "[ ]"} ${i + 1}. ${c.description}`)
      .join("\n");

    const text = [
      `# YOUR CURRENT GOAL [${org.name}]`,
      "",
      `**Objective:** ${goal.objective}`,
      "",
      `**Phase:** ${goal.current_phase} (${goal.progress_pct}% complete)`,
      "",
      "**Acceptance Criteria:**",
      criteriaText,
      "",
      `IMPORTANT: You are working within the ${org.name} organization. Do not access or modify resources outside this org.`,
      "Do not work on anything outside this scope. If you need to deviate, call request_help first.",
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ── goal_progress ───────────────────────────────────────

server.tool(
  "goal_progress",
  "Report progress on your current goal",
  {
    phase: z.string().describe("Current phase name"),
    progressPct: z.number().min(0).max(100).describe("Overall progress percentage"),
    notes: z.string().optional().describe("Brief status notes"),
    criteriaCompleted: z.array(z.number()).optional().describe("Indices of completed criteria (0-based)"),
  },
  async ({ phase, progressPct, notes, criteriaCompleted }) => {
    const sid = process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { content: [{ type: "text" as const, text: "No session ID. Cannot report progress." }] };
    }

    const goal = db.prepare(`
      SELECT g.id, g.acceptance_criteria FROM goals g
      JOIN sessions s ON g.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE g.session_id = ? AND p.org_id = ?
      ORDER BY g.created_at DESC LIMIT 1
    `).get(sid, ORG_ID) as { id: string; acceptance_criteria: string } | undefined;

    if (!goal) {
      return { content: [{ type: "text" as const, text: "No goal found in this org." }] };
    }

    let criteria = JSON.parse(goal.acceptance_criteria) as Array<{ description: string; met: boolean }>;
    if (criteriaCompleted) {
      criteria = criteria.map((c, i) => ({
        ...c,
        met: criteriaCompleted.includes(i) ? true : c.met,
      }));
    }

    db.prepare(`
      UPDATE goals SET current_phase = ?, progress_pct = ?, acceptance_criteria = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(phase, progressPct, JSON.stringify(criteria), goal.id);

    return { content: [{ type: "text" as const, text: `Progress updated: ${phase} (${progressPct}%)${notes ? ` - ${notes}` : ""}` }] };
  }
);

// ── focus_check ─────────────────────────────────────────

server.tool(
  "focus_check",
  "Check if you are still on task. Returns your goal and any drift warnings.",
  {},
  async () => {
    const sid = process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { content: [{ type: "text" as const, text: "No session context." }] };
    }

    const goal = db.prepare(`
      SELECT g.objective, g.current_phase, g.progress_pct FROM goals g
      JOIN sessions s ON g.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE g.session_id = ? AND p.org_id = ?
      ORDER BY g.created_at DESC LIMIT 1
    `).get(sid, ORG_ID) as { objective: string; current_phase: string; progress_pct: number } | undefined;

    const recentAlerts = listSessionDriftAlerts(db, sid, ORG_ID, 3);

    let text = goal
      ? `[${org.name}] Goal: ${goal.objective}\nPhase: ${goal.current_phase} (${goal.progress_pct}%)`
      : "No goal set.";

    if (recentAlerts.length > 0) {
      text += "\n\nDRIFT WARNINGS:\n" + recentAlerts.map(a => `- ${a.message}`).join("\n");
      text += "\n\nPlease refocus on your stated objective.";
    } else {
      text += "\n\nNo drift warnings. You appear to be on task.";
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

// ── budget_check ────────────────────────────────────────

server.tool(
  "budget_check",
  "Check your remaining token budget for this session",
  {},
  async () => {
    const sid = process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { content: [{ type: "text" as const, text: "No session context." }] };
    }

    const session = db.prepare(`
      SELECT s.tokens_used, p.token_budget, a.daily_token_limit
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      JOIN accounts a ON s.account_id = a.id
      WHERE s.id = ? AND p.org_id = ?
    `).get(sid, ORG_ID) as { tokens_used: number; token_budget: number; daily_token_limit: number } | undefined;

    if (!session) {
      return { content: [{ type: "text" as const, text: "Session not found in this org." }] };
    }

    const remaining = session.token_budget - session.tokens_used;
    const pct = Math.round((session.tokens_used / session.token_budget) * 100);

    return {
      content: [{
        type: "text" as const,
        text: `[${org.name}] Token budget: ${session.tokens_used.toLocaleString()} / ${session.token_budget.toLocaleString()} used (${pct}%)\nRemaining: ${remaining.toLocaleString()} tokens`,
      }],
    };
  }
);

// ── request_help ────────────────────────────────────────

server.tool(
  "request_help",
  "Escalate a question or blocker to the user. Use this instead of guessing when you are unsure.",
  {
    question: z.string().describe("Your question or description of the blocker"),
    urgency: z.enum(["low", "medium", "high"]).default("medium"),
  },
  async ({ question, urgency }) => {
    const sid = process.env.NOSLEEP_SESSION_ID;

    const severity = urgency === "high" ? "critical" : urgency === "medium" ? "warning" : "info";

    db.prepare(`
      INSERT INTO alerts (org_id, session_id, type, severity, message)
      VALUES (?, ?, 'question', ?, ?)
    `).run(ORG_ID, sid ?? null, severity, question);

    return {
      content: [{
        type: "text" as const,
        text: `Help request submitted to ${org.name} alerts (${urgency} urgency). The user will be notified.`,
      }],
    };
  }
);

// ── Strategy Tree Tools ─────────────────────────────────

server.tool(
  "strategy_tree_view",
  "View the strategy tree for your project. Shows all nodes with depth, status, progress, and dependency info. Use this to understand what needs to be done.",
  {
    projectId: z.string().optional().describe("Project ID. Auto-detected from session if omitted."),
  },
  async ({ projectId }) => {
    const pid = projectId ?? resolveProjectId();
    if (!pid) {
      return { content: [{ type: "text" as const, text: "Cannot determine project. Pass projectId." }] };
    }

    const rows = listProjectStrategy(db, pid, ORG_ID);

    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No strategy tree for this project." }] };
    }

    // Build parent→children map for recursive walk
    const childMap = new Map<string | null, StrategyRow[]>();
    for (const row of rows) {
      const key = row.parent_id;
      if (!childMap.has(key)) childMap.set(key, []);
      childMap.get(key)!.push(row);
    }

    const lines: string[] = ["# STRATEGY TREE", ""];

    function walk(parentId: string | null): void {
      const children = childMap.get(parentId);
      if (!children) return;
      for (const row of children) {
        const indent = "  ".repeat(row.depth);
        const statusIcon = statusIcons[row.status] ?? "?";
        const deps = parseDeps(row.dependencies);
        const depText = deps.length > 0
          ? ` [deps: ${deps.map(d => `${d.type}→${(d.nodeId ?? "?").slice(0, 6)}`).join(", ")}]`
          : "";
        const sessionText = row.assigned_session_id ? ` (session: ${row.assigned_session_id.slice(0, 6)})` : "";
        const weightText = (row.weight ?? 1) > 1 ? ` w:${row.weight}` : "";
        lines.push(`${indent}${statusIcon} [${row.type}] ${row.title} (${row.progress_pct}%)${weightText}${depText}${sessionText} id:${row.id}`);
        if (row.description) {
          lines.push(`${indent}  ${row.description.slice(0, 200)}`);
        }
        walk(row.id);
      }
    }

    walk(null);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "strategy_node_get",
  "Get details of a specific node including its children and breadcrumb path.",
  {
    nodeId: z.string(),
  },
  async ({ nodeId }) => {
    const node = getStrategyNode(db, nodeId);
    if (!node) {
      return { content: [{ type: "text" as const, text: "Node not found in this org." }] };
    }

    const children = getStrategyChildren(db, nodeId);
    const path = getStrategyPath(db, nodeId);

    const lines = [
      `# ${node.title}`,
      `Path: ${path.join(" > ")}`,
      `Type: ${node.type} | Status: ${node.status} | Progress: ${node.progress_pct}%`,
      `Depth: ${node.depth} | Weight: ${node.weight ?? 1} | Est. tokens: ${(node.estimated_tokens ?? 0).toLocaleString()} | ID: ${node.id}`,
    ];

    if (node.description) lines.push(`\nDescription: ${node.description}`);

    const criteria = parseCriteria(node.acceptance_criteria);
    if (criteria.length > 0) {
      lines.push(`\nAcceptance Criteria:`);
      for (const c of criteria) {
        lines.push(`  - ${c}`);
      }
    }

    const deps = parseDeps(node.dependencies);
    if (deps.length > 0) {
      lines.push(`\nDependencies:`);
      for (const dep of deps) {
        const depNode = db.prepare(`SELECT title, status FROM strategy_nodes WHERE id = ?`).get(dep.nodeId) as { title: string; status: string } | undefined;
        lines.push(`  ${dep.type}: ${depNode?.title ?? dep.nodeId} (${depNode?.status ?? "?"})`);
      }
    }

    if (children.length > 0) {
      lines.push(`\nChildren (${children.length}):`);
      for (const child of children) {
        const icon = statusIcons[child.status] ?? "?";
        lines.push(`  ${icon} [${child.type}] ${child.title} (${child.progress_pct}%) id:${child.id}`);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "strategy_update_status",
  "Update the status of a strategy node. Progress propagates up automatically.",
  {
    nodeId: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "blocked", "skipped"]),
  },
  async ({ nodeId, status }) => {
    const node = getStrategyNode(db, nodeId);
    if (!node) {
      return { content: [{ type: "text" as const, text: "Node not found." }] };
    }

    // Validate dependency constraints
    const deps = parseDeps(node.dependencies);
    if (status === "in_progress" || status === "completed") {
      for (const dep of deps) {
        const predecessor = db.prepare(`SELECT title, status FROM strategy_nodes WHERE id = ?`).get(dep.nodeId) as { title: string; status: string } | undefined;
        if (!predecessor) continue;

        const predFinished = predecessor.status === "completed" || predecessor.status === "skipped";
        const predStarted = predFinished || predecessor.status === "in_progress";

        if (dep.type === "FS" && status === "in_progress" && !predFinished) {
          return { content: [{ type: "text" as const, text: `FS constraint: "${predecessor.title}" must finish first.` }] };
        }
        if (dep.type === "SS" && status === "in_progress" && !predStarted) {
          return { content: [{ type: "text" as const, text: `SS constraint: "${predecessor.title}" must start first.` }] };
        }
        if (dep.type === "FF" && status === "completed" && !predFinished) {
          return { content: [{ type: "text" as const, text: `FF constraint: "${predecessor.title}" must finish first.` }] };
        }
        if (dep.type === "SF" && status === "completed" && !predStarted) {
          return { content: [{ type: "text" as const, text: `SF constraint: "${predecessor.title}" must start first.` }] };
        }
      }
    }

    const progressPct = status === "completed" || status === "skipped" ? 100 : node.progress_pct;
    db.prepare(`UPDATE strategy_nodes SET status = ?, progress_pct = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, progressPct, nodeId);
    propagateUp(db, node.parent_id);

    return { content: [{ type: "text" as const, text: `Updated "${node.title}" to ${status} (${progressPct}%)` }] };
  }
);

server.tool(
  "strategy_set_progress",
  "Set progress percentage on a node (0-100). Auto-updates status and propagates up.",
  {
    nodeId: z.string(),
    progressPct: z.number().min(0).max(100),
  },
  async ({ nodeId, progressPct }) => {
    const node = getStrategyNode(db, nodeId);
    if (!node) {
      return { content: [{ type: "text" as const, text: "Node not found." }] };
    }

    const status = progressPct >= 100 ? "completed" : progressPct > 0 ? "in_progress" : node.status;
    db.prepare(`UPDATE strategy_nodes SET progress_pct = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(progressPct, status, nodeId);
    propagateUp(db, node.parent_id);

    return { content: [{ type: "text" as const, text: `"${node.title}": ${progressPct}% (${status})` }] };
  }
);

server.tool(
  "strategy_add_node",
  "Add a new node to the strategy tree. Use this to plan work for future sessions.",
  {
    parentId: z.string().describe("ID of the parent node"),
    type: z.enum(["strategy", "goal", "task", "subtask"]),
    title: z.string(),
    description: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional().describe("List of criteria that define 'done' for this node"),
    weight: z.number().int().min(1).optional().default(1).describe("Relative weight for progress calculation"),
    estimatedTokens: z.number().int().min(0).optional().default(0).describe("Estimated token cost"),
    dependsOnNodeId: z.string().optional().describe("Node ID this depends on"),
    dependencyType: z.enum(["FS", "SS", "FF", "SF"]).optional().default("FS").describe("Dependency constraint type"),
  },
  async ({ parentId, type, title, description, acceptanceCriteria, weight, estimatedTokens, dependsOnNodeId, dependencyType }) => {
    // Try org-scoped first, fall back to any org (for cross-org gateway compatibility)
    // Try org-scoped first, fall back to any org (for cross-org gateway compatibility)
    let parent = db.prepare(`SELECT * FROM strategy_nodes WHERE id = ? AND org_id = ?`).get(parentId, ORG_ID) as StrategyRow | undefined;
    if (!parent) {
      parent = getStrategyNode(db, parentId);
    }
    if (!parent) {
      return { content: [{ type: "text" as const, text: `Parent node not found. ID: ${parentId}. Try nosleep(action="strategy_tree") to find valid parent IDs.` }] };
    }

    const id = nanoid();
    const depth = parent.depth + 1;
    const nextSortOrder = getNextSortOrder(db, parentId);

    const deps: Array<{ nodeId: string; type: string }> = [];
    if (dependsOnNodeId) {
      deps.push({ nodeId: dependsOnNodeId, type: dependencyType ?? "FS" });
    }

    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, parent.project_id, ORG_ID, parentId, type, title, description ?? "", depth, nextSortOrder, JSON.stringify(deps), JSON.stringify(acceptanceCriteria ?? []), weight ?? 1, estimatedTokens ?? 0);

    return { content: [{ type: "text" as const, text: `Added [${type}] "${title}" under "${parent.title}" (id: ${id}, depth: ${depth})` }] };
  }
);

server.tool(
  "strategy_next_actionable",
  "Find the next task you should work on: a pending leaf node with all dependencies satisfied.",
  {
    projectId: z.string().optional(),
  },
  async ({ projectId }) => {
    const pid = projectId ?? resolveProjectId();
    if (!pid) {
      return { content: [{ type: "text" as const, text: "Cannot determine project." }] };
    }

    const allNodes = listProjectStrategyByDepth(db, pid, ORG_ID);

    const nodeMap = new Map(allNodes.map(r => [r.id, r]));
    const hasChildren = new Set(allNodes.filter(n => n.parent_id).map(n => n.parent_id!));

    // Build set of skipped/completed ancestor IDs — skip their children
    const skipAncestors = new Set<string>();
    for (const node of allNodes) {
      if (node.status === "skipped" || node.status === "completed") {
        skipAncestors.add(node.id);
      }
    }

    for (const node of allNodes) {
      if (node.status !== "pending") continue;
      if (hasChildren.has(node.id)) continue; // not a leaf

      // Skip if any ancestor is skipped/completed
      let ancestorSkipped = false;
      let cur = node.parent_id;
      while (cur) {
        if (skipAncestors.has(cur)) { ancestorSkipped = true; break; }
        cur = nodeMap.get(cur)?.parent_id ?? null;
      }
      if (ancestorSkipped) continue;

      const deps = parseDeps(node.dependencies);
      const canStart = deps.every(dep => {
        const pred = nodeMap.get(dep.nodeId);
        if (!pred) return true;
        if (dep.type === "FS") return pred.status === "completed" || pred.status === "skipped";
        if (dep.type === "SS") return pred.status === "in_progress" || pred.status === "completed" || pred.status === "skipped";
        return true;
      });

      if (canStart) {
        // Build path
        const path: string[] = [];
        let cur: StrategyRow | undefined = node;
        while (cur) {
          path.unshift(cur.title);
          cur = cur.parent_id ? nodeMap.get(cur.parent_id) : undefined;
        }

        const nodeCriteria = parseCriteria(node.acceptance_criteria);
        const criteriaText = nodeCriteria.length > 0
          ? `\nAcceptance Criteria:\n${nodeCriteria.map(c => `  - ${c}`).join("\n")}`
          : "";

        return {
          content: [{
            type: "text" as const,
            text: [
              `# NEXT ACTIONABLE TASK`,
              `Path: ${path.join(" > ")}`,
              `Title: ${node.title}`,
              `Type: ${node.type} | Weight: ${node.weight ?? 1} | Est. tokens: ${(node.estimated_tokens ?? 0).toLocaleString()} | ID: ${node.id}`,
              node.description ? `Description: ${node.description}` : "",
              criteriaText,
              `\nTo start working on this, call strategy_update_status with nodeId="${node.id}" status="in_progress"`,
            ].filter(Boolean).join("\n"),
          }],
        };
      }
    }

    return { content: [{ type: "text" as const, text: "No actionable tasks found. All tasks are either in progress, completed, or blocked by dependencies." }] };
  }
);

// ── Project Management ──────────────────────────────────

server.tool(
  "project_list",
  "List all projects in this organization with their status and recent session info.",
  {},
  async () => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.path, p.status, p.autonomy_level, p.token_budget, p.continue_session,
        a.name as account_name, a.type as account_type,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.status = 'running') as active_sessions,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) as total_sessions
      FROM projects p
      JOIN accounts a ON p.account_id = a.id
      WHERE p.org_id = ?
      ORDER BY p.name
    `).all(ORG_ID) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: `No projects in ${org.name}.` }] };
    }

    const lines = [`# Projects [${org.name}]`, ""];
    for (const r of rows) {
      const continueFlag = r.continue_session ? " [continue-session]" : "";
      lines.push(`- **${r.name}** (${r.status}) id:${(r.id as string)}`);
      lines.push(`  Path: ${r.path} | Account: ${r.account_name} (${r.account_type})`);
      lines.push(`  Sessions: ${r.active_sessions} active / ${r.total_sessions} total | Budget: ${(r.token_budget as number).toLocaleString()} tokens${continueFlag}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "project_create",
  "Create a new project in this organization. Validates path exists and is under home directory.",
  {
    name: z.string().min(1).describe("Project name"),
    path: z.string().min(1).describe("Absolute path to project directory"),
    tokenBudget: z.number().int().positive().optional().default(500000).describe("Token budget per session"),
    autonomyLevel: z.enum(["full", "supervised", "manual"]).optional().default("supervised"),
    continueSession: z.boolean().optional().default(false).describe("Always continue last session instead of starting fresh"),
  },
  async ({ name, path: projectPath, tokenBudget, autonomyLevel, continueSession }) => {
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const os = await import("node:os");

    const resolved = nodePath.default.resolve(projectPath);
    if (!fs.existsSync(resolved)) {
      return { content: [{ type: "text" as const, text: `Path does not exist: ${resolved}` }] };
    }

    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      return { content: [{ type: "text" as const, text: "Unable to resolve path (broken symlink?)" }] };
    }

    const homeDir = os.default.homedir();
    if (!realPath.startsWith(homeDir + "/") && realPath !== homeDir) {
      return { content: [{ type: "text" as const, text: "Path must be under your home directory" }] };
    }

    // Check for duplicate path in this org
    const existing = db.prepare(`SELECT id, name FROM projects WHERE org_id = ? AND path = ?`).get(ORG_ID, realPath) as { id: string; name: string } | undefined;
    if (existing) {
      return { content: [{ type: "text" as const, text: `Project already exists at this path: "${existing.name}" (${existing.id})` }] };
    }

    // Get the org's account (use first available)
    const account = db.prepare(`SELECT id, name FROM accounts WHERE org_id = ? LIMIT 1`).get(ORG_ID) as { id: string; name: string } | undefined;
    if (!account) {
      return { content: [{ type: "text" as const, text: "No account found for this organization. Create an account first." }] };
    }

    const id = nanoid();
    db.prepare(`
      INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level, continue_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ORG_ID, name, realPath, account.id, tokenBudget, autonomyLevel, continueSession ? 1 : 0);

    return { content: [{ type: "text" as const, text: `Project "${name}" created.\nID: ${id}\nPath: ${realPath}\nAccount: ${account.name}\nBudget: ${tokenBudget.toLocaleString()} tokens\nAutonomy: ${autonomyLevel}\nContinue session: ${continueSession}` }] };
  }
);

server.tool(
  "project_update",
  "Update an existing project's settings.",
  {
    projectId: z.string().describe("Project ID to update"),
    name: z.string().min(1).optional().describe("New project name"),
    tokenBudget: z.number().int().positive().optional().describe("New token budget"),
    autonomyLevel: z.enum(["full", "supervised", "manual"]).optional(),
    continueSession: z.boolean().optional(),
  },
  async ({ projectId, name, tokenBudget, autonomyLevel, continueSession }) => {
    const project = db.prepare(`SELECT id, name FROM projects WHERE id = ? AND org_id = ?`).get(projectId, ORG_ID) as { id: string; name: string } | undefined;
    if (!project) {
      return { content: [{ type: "text" as const, text: "Project not found in this org." }] };
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) { sets.push("name = ?"); params.push(name); }
    if (tokenBudget !== undefined) { sets.push("token_budget = ?"); params.push(tokenBudget); }
    if (autonomyLevel !== undefined) { sets.push("autonomy_level = ?"); params.push(autonomyLevel); }
    if (continueSession !== undefined) { sets.push("continue_session = ?"); params.push(continueSession ? 1 : 0); }

    if (sets.length === 0) {
      return { content: [{ type: "text" as const, text: "No fields to update." }] };
    }

    params.push(projectId);
    db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    return { content: [{ type: "text" as const, text: `Project "${project.name}" updated.` }] };
  }
);

// ── Session Management (via HTTP API) ───────────────────

const SERVER_URL = process.env.NOSLEEP_SERVER_URL ?? "http://localhost:3777";
const API_KEY = process.env.NOSLEEP_API_KEY ?? "";

async function apiCall(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;

  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as Record<string, unknown>;
    return { ok: res.ok, data: json.data, error: json.error as string | undefined };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

server.tool(
  "session_launch",
  "Launch a new Claude Code session for a project with a specific goal and acceptance criteria.",
  {
    projectId: z.string().describe("Project ID to launch session for"),
    goal: z.string().min(10).describe("What the session should accomplish"),
    acceptanceCriteria: z.array(z.string()).min(1).describe("List of criteria that define 'done'"),
    strategyNodeId: z.string().optional().describe("Strategy tree node this session works on"),
  },
  async ({ projectId, goal, acceptanceCriteria, strategyNodeId }) => {
    // Verify project belongs to this org
    const project = db.prepare(`SELECT id, name FROM projects WHERE id = ? AND org_id = ?`).get(projectId, ORG_ID) as { id: string; name: string } | undefined;
    if (!project) {
      return { content: [{ type: "text" as const, text: "Project not found in this org." }] };
    }

    const result = await apiCall("POST", "/api/sessions", {
      projectId,
      goal,
      acceptanceCriteria,
      strategyNodeId,
    });

    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Failed to launch: ${result.error}` }] };
    }

    const sessionId = (result.data as { sessionId: string }).sessionId;
    return { content: [{ type: "text" as const, text: `Session launched for "${project.name}": ${sessionId}` }] };
  }
);

server.tool(
  "session_list",
  "List recent sessions in this organization with their status.",
  {
    status: z.enum(["running", "completed", "failed", "stopped", "all"]).optional().default("all"),
  },
  async ({ status }) => {
    let sql = `
      SELECT s.id, s.status, s.goal_text, s.tokens_used, s.started_at, s.ended_at, p.name as project_name
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE p.org_id = ?
    `;
    const params: unknown[] = [ORG_ID];

    if (status !== "all") {
      sql += ` AND s.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY s.started_at DESC LIMIT 20`;

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: `No sessions found.` }] };
    }

    const lines = [`# Sessions [${org.name}]`, ""];
    for (const r of rows) {
      const goal = (r.goal_text as string).slice(0, 80);
      lines.push(`- [${r.status}] ${r.project_name}: ${goal}...`);
      lines.push(`  ID: ${(r.id as string).slice(0, 12)} | Tokens: ${(r.tokens_used as number).toLocaleString()} | Started: ${r.started_at}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "session_stop",
  "Stop a running session.",
  {
    sessionId: z.string().describe("Session ID to stop"),
  },
  async ({ sessionId }) => {
    const result = await apiCall("POST", `/api/sessions/${sessionId}/intervene`, { action: "stop" });
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Failed to stop: ${result.error}` }] };
    }
    return { content: [{ type: "text" as const, text: `Session ${sessionId.slice(0, 12)} stopped.` }] };
  }
);

server.tool(
  "session_redirect",
  "Send a redirect message to a running session to change its focus.",
  {
    sessionId: z.string(),
    message: z.string().describe("Instruction to redirect the session"),
  },
  async ({ sessionId, message }) => {
    const result = await apiCall("POST", `/api/sessions/${sessionId}/intervene`, { action: "redirect", message });
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Failed to redirect: ${result.error}` }] };
    }
    return { content: [{ type: "text" as const, text: `Redirect sent to ${sessionId.slice(0, 12)}.` }] };
  }
);

// ── Alert Management ────────────────────────────────────

server.tool(
  "alert_list",
  "List recent alerts in this organization. Shows unacknowledged by default.",
  {
    includeAcked: z.boolean().optional().default(false),
    limit: z.number().optional().default(20),
  },
  async ({ includeAcked, limit }) => {
    const rows = listOrgAlerts(db, ORG_ID, { includeAcked, limit });
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No alerts." }] };
    }

    const lines = [`# Alerts [${org.name}] (${rows.length})`, ""];
    for (const r of rows) {
      const acked = r.acknowledged ? "✓" : "!";
      lines.push(`${acked} [${r.severity}] ${r.type}: ${r.message}`);
      lines.push(`  ID: ${r.id} | Session: ${r.session_id ?? "—"} | ${r.created_at}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "alert_ack",
  "Acknowledge an alert or all alerts.",
  {
    alertId: z.number().optional().describe("Alert ID to ack, or omit to ack all"),
  },
  async ({ alertId }) => {
    if (alertId !== undefined) {
      db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ? AND org_id = ?`).run(alertId, ORG_ID);
      return { content: [{ type: "text" as const, text: `Alert ${alertId} acknowledged.` }] };
    }
    const result = db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE org_id = ? AND acknowledged = 0`).run(ORG_ID);
    return { content: [{ type: "text" as const, text: `${result.changes} alerts acknowledged.` }] };
  }
);

// ── Strategy helper types and functions ──────────────────
// statusIcons, parseDeps, parseCriteria, StrategyRow imported from @nosleep/shared

function nanoid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 21);
}

function resolveProjectId(): string | null {
  const sid = process.env.NOSLEEP_SESSION_ID;
  if (!sid) return null;
  const row = db.prepare(`SELECT project_id FROM sessions WHERE id = ?`).get(sid) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

function propagateUp(database: Database.Database, parentId: string | null): void {
  if (!parentId) return;

  const children = database.prepare(`SELECT status, progress_pct, weight FROM strategy_nodes WHERE parent_id = ?`).all(parentId) as Array<{ status: string; progress_pct: number; weight: number }>;
  if (children.length === 0) return;

  // Weight-based progress propagation
  const totalWeight = children.reduce((s, c) => s + (c.weight || 1), 0);
  const weightedProgress = children.reduce((s, c) => s + c.progress_pct * (c.weight || 1), 0);
  const avg = totalWeight > 0 ? Math.round(weightedProgress / totalWeight) : 0;

  const allDone = children.every(c => c.status === "completed" || c.status === "skipped");
  const anyActive = children.some(c => c.status === "in_progress");
  const status = allDone ? "completed" : (anyActive || avg > 0) ? "in_progress" : "pending";

  database.prepare(`UPDATE strategy_nodes SET progress_pct = ?, status = ?, updated_at = datetime('now') WHERE id = ?`).run(avg, status, parentId);

  const parent = database.prepare(`SELECT parent_id FROM strategy_nodes WHERE id = ?`).get(parentId) as { parent_id: string | null } | undefined;
  if (parent?.parent_id) propagateUp(database, parent.parent_id);
}

// ── MCP Resources (read-only context, cheaper than tool calls) ──

server.resource(
  "goal",
  `nosleep://${org.slug}/goal`,
  {
    description: "Current session goal, acceptance criteria, and progress. Read this instead of calling goal_get to save a tool call.",
    mimeType: "text/plain",
  },
  async () => {
    const sid = process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { contents: [{ uri: `nosleep://${org.slug}/goal`, text: "No active session.", mimeType: "text/plain" }] };
    }

    const goal = db.prepare(`
      SELECT g.objective, g.acceptance_criteria, g.current_phase, g.progress_pct
      FROM goals g
      JOIN sessions s ON g.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE g.session_id = ? AND p.org_id = ?
      ORDER BY g.created_at DESC LIMIT 1
    `).get(sid, ORG_ID) as { objective: string; acceptance_criteria: string; current_phase: string; progress_pct: number } | undefined;

    if (!goal) {
      return { contents: [{ uri: `nosleep://${org.slug}/goal`, text: "No goal set.", mimeType: "text/plain" }] };
    }

    const criteria = JSON.parse(goal.acceptance_criteria) as Array<{ description: string; met: boolean }>;
    const criteriaText = criteria
      .map((c, i) => `  ${c.met ? "[x]" : "[ ]"} ${i + 1}. ${c.description}`)
      .join("\n");

    const text = [
      `# Goal [${org.name}]`,
      `Objective: ${goal.objective}`,
      `Phase: ${goal.current_phase} (${goal.progress_pct}%)`,
      `Criteria:\n${criteriaText}`,
    ].join("\n");

    return { contents: [{ uri: `nosleep://${org.slug}/goal`, text, mimeType: "text/plain" }] };
  }
);

server.resource(
  "budget",
  `nosleep://${org.slug}/budget`,
  {
    description: "Current session token budget status. Read this to check budget without a tool call.",
    mimeType: "text/plain",
  },
  async () => {
    const sid = process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { contents: [{ uri: `nosleep://${org.slug}/budget`, text: "No active session.", mimeType: "text/plain" }] };
    }

    const session = db.prepare(`
      SELECT s.tokens_used, p.token_budget, a.monthly_budget_usd, s.cost_usd
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      JOIN accounts a ON s.account_id = a.id
      WHERE s.id = ? AND p.org_id = ?
    `).get(sid, ORG_ID) as { tokens_used: number; token_budget: number; monthly_budget_usd: number; cost_usd: number } | undefined;

    if (!session) {
      return { contents: [{ uri: `nosleep://${org.slug}/budget`, text: "Session not found.", mimeType: "text/plain" }] };
    }

    const pct = session.token_budget > 0 ? Math.round((session.tokens_used / session.token_budget) * 100) : 0;
    const text = [
      `Budget [${org.name}]`,
      `Tokens: ${session.tokens_used.toLocaleString()} / ${session.token_budget.toLocaleString()} (${pct}%)`,
      `Cost: $${session.cost_usd.toFixed(4)}`,
      `Monthly limit: $${session.monthly_budget_usd.toFixed(2)}`,
      pct >= 80 ? `WARNING: Budget at ${pct}%` : `Status: OK`,
    ].join("\n");

    return { contents: [{ uri: `nosleep://${org.slug}/budget`, text, mimeType: "text/plain" }] };
  }
);

server.resource(
  "focus",
  `nosleep://${org.slug}/focus`,
  {
    description: "Focus status with any drift warnings. Read this to check if you're on task without a tool call.",
    mimeType: "text/plain",
  },
  async () => {
    const sid = process.env.NOSLEEP_SESSION_ID;
    if (!sid) {
      return { contents: [{ uri: `nosleep://${org.slug}/focus`, text: "No active session.", mimeType: "text/plain" }] };
    }

    const goal = db.prepare(`
      SELECT g.objective, g.current_phase, g.progress_pct FROM goals g
      JOIN sessions s ON g.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE g.session_id = ? AND p.org_id = ?
      ORDER BY g.created_at DESC LIMIT 1
    `).get(sid, ORG_ID) as { objective: string; current_phase: string; progress_pct: number } | undefined;

    const recentAlerts = listSessionDriftAlerts(db, sid, ORG_ID, 3);

    let text = goal
      ? `Focus [${org.name}]\nGoal: ${goal.objective}\nPhase: ${goal.current_phase} (${goal.progress_pct}%)`
      : "No goal set.";

    if (recentAlerts.length > 0) {
      text += "\nDRIFT WARNINGS:\n" + recentAlerts.map(a => `- ${a.message}`).join("\n");
    } else {
      text += "\nOn task. No drift warnings.";
    }

    return { contents: [{ uri: `nosleep://${org.slug}/focus`, text, mimeType: "text/plain" }] };
  }
);

// ── Start server ────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
