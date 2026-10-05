import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import {
  STATUS_ICONS as statusIcons, parseDeps, parseCriteria, type StrategyRow,
  getStrategyNode, listProjectStrategy, listProjectStrategyByDepth,
  getStrategyChildren, getStrategyPath, getNextSortOrder,
  getSessionOrg, getSessionProject,
  listSessionDriftAlerts, getSessionBudget,
  listOrgAlerts, acknowledgeAlert, acknowledgeAllOrgAlerts,
  getLoopConfig, upsertLoopConfig, type LoopMode,
  projectLiveStatusSql, propagateStrategyProgress,
} from "@nosleep/shared";
import { readBrainFilePayload } from "@nosleep/shared/dist/brain-file.js";

// ── Types ──────────────────────────────────────────────

export interface Action {
  name: string;
  description: string;
  params: string; // human-readable param description
  handler: (params: Record<string, unknown>) => Promise<string>;
}

// ── Dependencies ───────────────────────────────────────

export interface GatewayDeps {
  db: Database.Database;
  envOrgId?: string;
  envSessionId?: string;
  serverUrl: string;
  apiKey: string;
}

// ── Helpers ────────────────────────────────────────────

function buildHelpers(deps: GatewayDeps) {
  const { db, envOrgId, envSessionId, serverUrl, apiKey } = deps;

  const allOrgs = db.prepare(`SELECT id, name, slug FROM organizations`).all() as Array<{ id: string; name: string; slug: string }>;
  const orgMap = new Map(allOrgs.map(o => [o.id, o]));
  const orgSlugs = new Map(allOrgs.map(o => [o.slug, o]));

  function resolveOrg(orgId?: string): { id: string; name: string; slug: string } | undefined {
    // SECURITY: when the request is bound to a trusted org (envOrgId, derived
    // by the HTTP MCP endpoint from the authenticated session/project header),
    // that org is AUTHORITATIVE — a caller-supplied orgId cannot override it.
    // This is what prevents a session scoped to one org from reading/writing
    // another org's memory or brain artifacts (which are stored in a per-org
    // DB selected by this org). Only when there is NO trusted binding do we
    // fall back to the caller-supplied orgId (e.g. dashboard/admin contexts).
    if (envOrgId) return orgMap.get(envOrgId);
    if (orgId) return orgMap.get(orgId) ?? orgSlugs.get(orgId);
    return undefined;
  }

  function resolveSessionOrg(sessionId?: string): string | undefined {
    const sid = sessionId ?? envSessionId;
    if (!sid) return undefined;
    return getSessionOrg(db, sid);
  }

  function resolveProjectId(sessionId?: string): string | null {
    const sid = sessionId ?? envSessionId;
    if (!sid) return null;
    return getSessionProject(db, sid) ?? null;
  }

  // A project belongs to exactly ONE org, so an explicit projectId fully
  // determines the org. Project-scoped reads (strategy_tree/next/search) must
  // use THIS, not the caller's session org — otherwise querying a project in
  // another org returns zero rows and lies ("No strategy tree") instead of
  // showing the tree. (Memory stays org-scoped by the session binding; it has
  // no projectId.)
  function resolveProjectOrg(projectId?: string | null): string | undefined {
    if (!projectId) return undefined;
    const row = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(projectId) as { org_id: string } | undefined;
    return row?.org_id;
  }

  async function apiCall(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: unknown; error?: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    try {
      const res = await fetch(`${serverUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json() as Record<string, unknown>;
      // Core routes reply with a { success, data, error } envelope; brain
      // routes (/api/brain/*) reply with the bare object and errors shaped
      // { error: { code, message } }. Unwrap both, or every brain_* action
      // reads `data` as undefined ("No results", "Captured thought ?").
      const enveloped = json !== null && typeof json === "object" && "success" in json;
      const rawErr = json?.error as unknown;
      const error = typeof rawErr === "string"
        ? rawErr
        : rawErr && typeof rawErr === "object" && "message" in rawErr
          ? String((rawErr as { message: unknown }).message)
          : res.ok ? undefined : `HTTP ${res.status}`;
      return { ok: res.ok, data: enveloped ? json.data : json, error };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function propagateUp(parentId: string | null): void {
    propagateStrategyProgress(db, parentId);
  }


  return { orgMap, orgSlugs, resolveOrg, resolveSessionOrg, resolveProjectId, resolveProjectOrg, apiCall, propagateUp };
}

// ── Action Builder ─────────────────────────────────────

export function buildActions(deps: GatewayDeps): Action[] {
  const actions: Action[] = [];
  const h = buildHelpers(deps);
  const { db } = deps;

  function register(name: string, description: string, params: string, handler: (p: Record<string, unknown>) => Promise<string>): void {
    actions.push({ name, description, params, handler });
  }

  // ── Strategy Tools ──────────────────────────────────────

  register("goal_get", "Get current goal and acceptance criteria for a session", "sessionId?", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session ID. Pass sessionId or set NOSLEEP_SESSION_ID.";
    const orgId = h.resolveSessionOrg(sid);
    if (!orgId) return "Session not found.";
    const org = h.orgMap.get(orgId)!;
    const goal = db.prepare(`SELECT objective, acceptance_criteria, current_phase, progress_pct FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`).get(sid) as { objective: string; acceptance_criteria: string; current_phase: string; progress_pct: number } | undefined;
    if (!goal) return "No goal found for this session.";
    let criteria: Array<{ description: string; met: boolean }>;
    try { criteria = JSON.parse(goal.acceptance_criteria); } catch { criteria = []; }
    return [`# GOAL [${org.name}]`, `Objective: ${goal.objective}`, `Phase: ${goal.current_phase} (${goal.progress_pct}%)`, `Criteria:`, ...criteria.map((c, i) => `  ${c.met ? "[x]" : "[ ]"} ${i + 1}. ${c.description}`)].join("\n");
  });

  register("goal_progress", "Report progress on current goal", "phase, progressPct, notes?, criteriaCompleted?[]", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session ID.";
    const orgId = h.resolveSessionOrg(sid);
    if (!orgId) return "Session not found.";
    // Org check goes against sessions.org_id directly — no JOIN through projects
    const goal = db.prepare(`SELECT g.id AS goal_id, g.acceptance_criteria FROM goals g JOIN sessions s ON g.session_id = s.id WHERE g.session_id = ? AND s.org_id = ? ORDER BY g.created_at DESC LIMIT 1`).get(sid, orgId) as { goal_id: string; acceptance_criteria: string } | undefined;
    if (!goal) return "No goal found.";
    let criteria: Array<{ description: string; met: boolean }>;
    try { criteria = JSON.parse(goal.acceptance_criteria); } catch { criteria = []; }
    const completed = p.criteriaCompleted as number[] | undefined;
    if (completed) criteria = criteria.map((c, i) => ({ ...c, met: completed.includes(i) ? true : c.met }));
    db.prepare(`UPDATE goals SET current_phase = ?, progress_pct = ?, acceptance_criteria = ?, updated_at = datetime('now') WHERE id = ?`).run(p.phase, p.progressPct, JSON.stringify(criteria), goal.goal_id);
    return `Progress: ${p.phase} (${p.progressPct}%)`;
  });

  register("focus_check", "Check if you're on task, shows drift warnings", "sessionId?", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session context.";
    const orgId = h.resolveSessionOrg(sid);
    if (!orgId) return "Session not found.";
    const org = h.orgMap.get(orgId)!;
    // Org check uses sessions.org_id directly — no JOIN through projects
    const goal = db.prepare(`SELECT g.objective, g.current_phase, g.progress_pct FROM goals g JOIN sessions s ON g.session_id = s.id WHERE g.session_id = ? AND s.org_id = ? ORDER BY g.created_at DESC LIMIT 1`).get(sid, orgId) as { objective: string; current_phase: string; progress_pct: number } | undefined;
    const alerts = listSessionDriftAlerts(db, sid, orgId, 3);
    let text = goal ? `[${org.name}] Goal: ${goal.objective}\nPhase: ${goal.current_phase} (${goal.progress_pct}%)` : "No goal set.";
    if (alerts.length > 0) text += "\n\nDRIFT WARNINGS:\n" + alerts.map(a => `- ${a.message}`).join("\n");
    else text += "\n\nNo drift warnings. On task.";
    return text;
  });

  register("budget_check", "Check remaining token budget for session", "sessionId?", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session context.";
    const orgId = h.resolveSessionOrg(sid);
    if (!orgId) return "Session not found.";
    const org = h.orgMap.get(orgId)!;
    // We still need projects join to read token_budget, but we filter by sessions.org_id
    const session = getSessionBudget(db, sid, orgId);
    if (!session) return "Session not found.";
    const pct = Math.round((session.tokens_used / session.token_budget) * 100);
    return `[${org.name}] Tokens: ${session.tokens_used.toLocaleString("en-US")} / ${session.token_budget.toLocaleString("en-US")} (${pct}%)`;
  });

  register("request_help", "Escalate a blocker to the user", "orgId, question, urgency?(low|medium|high)", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Org required. Pass orgId (org_personal, org_wyobi, org_apply).";
    const severity = p.urgency === "high" ? "critical" : p.urgency === "medium" ? "warning" : "info";
    db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message) VALUES (?, ?, 'question', ?, ?)`).run(org.id, deps.envSessionId ?? null, severity, p.question);
    return `Help request submitted to ${org.name} (${p.urgency ?? "medium"}).`;
  });

  // Phase 22 — Karpathy / no-tree-pull principle: never dump the whole
  // tree by default. A project with 700+ nodes blows the agent context
  // every call. Default = focus view (in-progress + 5 next actionable +
  // parent chain). Pass full=true if you really need the whole thing.
  register(
    "strategy_tree",
    "View the strategy tree (FOCUS mode by default: in-progress + next actionable + parent breadcrumb). Pass full=true for everything (heavy — only when explicitly needed).",
    "projectId?, orgId?, full?(boolean — default false)",
    async (p) => {
      const pid = (p.projectId as string) ?? h.resolveProjectId();
      if (!pid) return "Pass projectId.";
      // An explicit projectId determines the org — use the project's own org so
      // this works regardless of the caller's session org. If the project
      // doesn't exist, say so (don't fall back to the caller's org and lie).
      const orgId = h.resolveProjectOrg(pid);
      if (!orgId) return `Unknown project ${pid} (no such project).`;
      const rows = listProjectStrategy(db, pid, orgId);
      if (rows.length === 0) return `Project ${pid} has no strategy tree (0 nodes).`;
      const childMap = new Map<string | null, StrategyRow[]>();
      const byId = new Map<string, StrategyRow>();
      for (const row of rows) {
        const k = row.parent_id;
        if (!childMap.has(k)) childMap.set(k, []);
        childMap.get(k)!.push(row);
        byId.set(row.id, row);
      }

      const renderRow = (row: StrategyRow, indent: string): string[] => {
        const out: string[] = [];
        const icon = statusIcons[row.status] ?? "?";
        const pri = (row as unknown as Record<string, unknown>).priority as number | null;
        const priTag = pri === 1 ? " ★CRITICAL" : pri === 2 ? " ▲HIGH" : pri === 4 ? " ▽LOW" : "";
        const deps = parseDeps(row.dependencies);
        const depTag = deps.length > 0
          ? ` [→${deps.map(d => `${d.type}:${(d.nodeId ?? "?").slice(0, 8)}`).join(",")}]`
          : "";
        out.push(`${indent}${icon} [${row.type}] ${row.title} (${row.progress_pct}%)${priTag}${depTag} id:${row.id}`);
        if (row.description) out.push(`${indent}  ${row.description.slice(0, 200)}`);
        return out;
      };

      const isFull =
        p.full === true ||
        p.full === "true" ||
        p.full === 1 ||
        p.full === "1";

      if (isFull) {
        const lines: string[] = ["# STRATEGY TREE (full)", ""];
        function walk(parentId: string | null): void {
          for (const row of childMap.get(parentId) ?? []) {
            const indent = "  ".repeat(row.depth);
            lines.push(...renderRow(row, indent));
            walk(row.id);
          }
        }
        walk(null);
        return lines.join("\n");
      }

      // FOCUS mode: in-progress nodes + their parent breadcrumbs + the
      // next 5 actionable. Bounded output regardless of tree size.
      const inProgress = rows.filter((r) => r.status === "in_progress");
      // Same semantics as StrategyTreeManager.checkDependenciesForStatus:
      // FS needs predecessor finished, SS needs it started.
      const depsMet = (row: StrategyRow): boolean =>
        parseDeps(row.dependencies).every((d) => {
          const pred = byId.get(d.nodeId);
          if (!pred) return true;
          if (d.type === "FS") return pred.status === "completed" || pred.status === "skipped";
          if (d.type === "SS") return pred.status !== "pending" && pred.status !== "blocked";
          return true;
        });
      const nextActionable = rows
        .filter((r) => r.status === "pending" && (childMap.get(r.id)?.length ?? 0) === 0 && depsMet(r))
        .sort((a, b) => {
          const pa = ((a as unknown as Record<string, unknown>).priority as number) ?? 3;
          const pb = ((b as unknown as Record<string, unknown>).priority as number) ?? 3;
          if (pa !== pb) return pa - pb;
          return a.depth - b.depth;
        })
        .slice(0, 5);

      const breadcrumb = (row: StrategyRow): string => {
        const chain: string[] = [];
        let cur: StrategyRow | undefined = row;
        while (cur) {
          chain.unshift(`${cur.title}`);
          if (!cur.parent_id) break;
          cur = byId.get(cur.parent_id);
        }
        return chain.join(" → ");
      };

      const lines: string[] = [
        "# STRATEGY · FOCUS",
        `(${rows.length} total nodes in project; showing in-progress + next actionable. Pass full=true for everything.)`,
        "",
      ];

      if (inProgress.length > 0) {
        lines.push("## In progress");
        for (const row of inProgress) {
          lines.push(`  ${breadcrumb(row)}`);
          lines.push(...renderRow(row, "    "));
        }
        lines.push("");
      }

      if (nextActionable.length > 0) {
        lines.push(`## Next actionable (top ${nextActionable.length})`);
        for (const row of nextActionable) {
          lines.push(...renderRow(row, "  "));
        }
        lines.push("");
      }

      if (inProgress.length === 0 && nextActionable.length === 0) {
        lines.push("(nothing in progress and no pending leaves — tree may be complete or all blocked)");
      }

      return lines.join("\n").trimEnd();
    },
  );

  // Phase 22 — targeted search across strategy nodes, returns ≤ limit.
  // Use this instead of dumping the whole tree to look up a node by name.
  register(
    "strategy_search",
    "Search strategy nodes by title/description substring. Optional project, status, type filters. Returns top N matches with id, type, status, breadcrumb.",
    "query, projectId?, status?(pending|in_progress|completed|blocked|skipped), type?(strategy|goal|task|subtask), limit?(default 15, max 50)",
    async (p) => {
      const query = String(p.query ?? "").trim();
      if (!query) return "Pass query.";
      const limit = Math.min(50, Math.max(1, parseInt(String(p.limit ?? "15"), 10) || 15));
      const conds: string[] = ["(title LIKE ? OR description LIKE ?)"];
      const like = `%${query}%`;
      const params: unknown[] = [like, like];
      if (p.projectId) {
        conds.push("project_id = ?");
        params.push(p.projectId);
      }
      if (p.status) {
        conds.push("status = ?");
        params.push(p.status);
      }
      if (p.type) {
        conds.push("type = ?");
        params.push(p.type);
      }
      const rows = db
        .prepare(
          `SELECT id, parent_id, title, description, type, status, progress_pct, project_id, depth
             FROM strategy_nodes
            WHERE ${conds.join(" AND ")}
            ORDER BY
              CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
              depth, sort_order
            LIMIT ?`,
        )
        .all(...params, limit) as Array<{
          id: string;
          parent_id: string | null;
          title: string;
          description: string;
          type: string;
          status: string;
          progress_pct: number;
          project_id: string;
          depth: number;
        }>;
      if (rows.length === 0) return `No nodes match "${query}".`;
      const projectNames = db
        .prepare("SELECT id, name FROM projects WHERE id IN (" + rows.map(() => "?").join(",") + ")")
        .all(...rows.map((r) => r.project_id)) as Array<{ id: string; name: string }>;
      const projName = new Map(projectNames.map((p) => [p.id, p.name]));
      return [
        `# Strategy search "${query}" — ${rows.length} match${rows.length === 1 ? "" : "es"}`,
        "",
        ...rows.map((r) => {
          const icon = statusIcons[r.status] ?? "?";
          const pn = projName.get(r.project_id) ?? r.project_id;
          return `${icon} [${r.type}] ${r.title} (${r.progress_pct}%) — ${pn}\n   id=${r.id}${r.description ? `\n   ${r.description.slice(0, 160)}` : ""}`;
        }),
      ].join("\n");
    },
  );

  // Phase 22-C — cross-tree ref-links. Distinct from `dependencies`
  // (blocking-order). Use these for "this task is related to / informs /
  // supersedes / references another node" — including across projects.

  register(
    "strategy_ref_add",
    "Add a semantic ref-link between two strategy nodes (cross-project allowed). 'related' = soft semantic link; 'informs' = output of A shapes B; 'supersedes' = A replaces B; 'references' = explicit citation.",
    "fromId, toId, kind(related|informs|supersedes|references), weight?(0.0-1.0, default 1.0), note?",
    async (p) => {
      if (!p.fromId || !p.toId || !p.kind) return "Pass fromId, toId, kind.";
      if (p.fromId === p.toId) return "self-link not allowed";
      const result = await h.apiCall("POST", "/api/strategy/refs", {
        fromId: p.fromId,
        toId: p.toId,
        kind: p.kind,
        weight: p.weight,
        note: p.note,
      });
      if (!result.ok) return `Failed: ${result.error}`;
      return `Linked ${String(p.fromId).slice(0, 8)}… —[${p.kind}]→ ${String(p.toId).slice(0, 8)}…`;
    },
  );

  // Phase 22 — fetch the full plan markdown linked to a
  // strategy node. Use this when you need the design/spec context for
  // a task instead of just the node title + description. FTS-resolves
  // source_ref on first hit and caches it.
  register(
    "strategy_plan_get",
    "Get the plan markdown linked to a strategy node (source_ref or FTS-resolved). Use when the node's title isn't enough context.",
    "nodeId",
    async (p) => {
      const nodeId = String(p.nodeId ?? "").trim();
      if (!nodeId) return "Pass nodeId.";
      const result = await h.apiCall("GET", `/api/strategy/node/${nodeId}/plan`, undefined);
      if (!result.ok) return `Failed: ${result.error}`;
      const data = result.data as {
        nodeTitle: string;
        projectName: string;
        filePath: string | null;
        lineNumber: number | null;
        content: string | null;
        missing: boolean;
        message?: string;
      };
      if (data.missing) {
        return `# ${data.nodeTitle} — no plan linked\n${data.message ?? ""}`;
      }
      const where = data.lineNumber ? `${data.filePath}:L${data.lineNumber}` : data.filePath;
      const max = 8000;
      const body = (data.content ?? "").length > max
        ? (data.content ?? "").slice(0, max) + `\n\n[…truncated; read ${data.filePath} for the rest]`
        : data.content ?? "";
      return `# Plan for ${data.nodeTitle}\n# source: ${where} (${data.projectName})\n\n${body}`;
    },
  );

  register(
    "strategy_ref_list",
    "List ref-links touching a node (both directions). Returns the small set of cross-tree links — use this instead of pulling the tree.",
    "nodeId",
    async (p) => {
      const nodeId = String(p.nodeId ?? "").trim();
      if (!nodeId) return "Pass nodeId.";
      const result = await h.apiCall("GET", `/api/strategy/node/${nodeId}/refs`, undefined);
      if (!result.ok) return `Failed: ${result.error}`;
      const data = result.data as {
        outgoing: Array<{ id: string; to_id: string; kind: string; weight: number; to_title: string; to_project_name: string; to_status: string }>;
        incoming: Array<{ id: string; from_id: string; kind: string; weight: number; from_title: string; from_project_name: string; from_status: string }>;
      };
      const lines: string[] = [`# Refs for ${nodeId.slice(0, 12)}…`];
      if (data.outgoing.length === 0 && data.incoming.length === 0) {
        lines.push("(no ref-links)");
        return lines.join("\n");
      }
      if (data.outgoing.length > 0) {
        lines.push("", `## Outgoing (${data.outgoing.length})`);
        for (const r of data.outgoing) {
          lines.push(
            `  —[${r.kind} w=${r.weight.toFixed(2)}]→ [${r.to_status}] ${r.to_title} · ${r.to_project_name}\n     to=${r.to_id} ref=${r.id}`,
          );
        }
      }
      if (data.incoming.length > 0) {
        lines.push("", `## Incoming (${data.incoming.length})`);
        for (const r of data.incoming) {
          lines.push(
            `  [${r.from_status}] ${r.from_title} · ${r.from_project_name} —[${r.kind} w=${r.weight.toFixed(2)}]→\n     from=${r.from_id} ref=${r.id}`,
          );
        }
      }
      return lines.join("\n");
    },
  );

  // Phase 22 — given one node, return its immediate neighbourhood only.
  // Never the whole subtree (use strategy_subtree if you actually want
  // that, with a depth limit).
  register(
    "strategy_related",
    "For one node, return its immediate parent, siblings, children, and dependency edges (no recursion). Use this for 'what's near here' queries instead of pulling the tree.",
    "nodeId",
    async (p) => {
      const nodeId = String(p.nodeId ?? "").trim();
      if (!nodeId) return "Pass nodeId.";
      const node = getStrategyNode(db, nodeId);
      if (!node) return `Node ${nodeId} not found.`;
      const parent = node.parent_id ? getStrategyNode(db, node.parent_id) : null;
      const siblings = node.parent_id
        ? (db
            .prepare(
              `SELECT id, title, status, progress_pct, type FROM strategy_nodes WHERE parent_id = ? AND id != ? ORDER BY sort_order`,
            )
            .all(node.parent_id, node.id) as Array<{
              id: string;
              title: string;
              status: string;
              progress_pct: number;
              type: string;
            }>)
        : [];
      const children = db
        .prepare(
          `SELECT id, title, status, progress_pct, type FROM strategy_nodes WHERE parent_id = ? ORDER BY sort_order`,
        )
        .all(node.id) as Array<{
          id: string;
          title: string;
          status: string;
          progress_pct: number;
          type: string;
        }>;
      const deps = parseDeps(node.dependencies);
      const depDetails =
        deps.length > 0
          ? (db
              .prepare(
                "SELECT id, title, status FROM strategy_nodes WHERE id IN (" + deps.map(() => "?").join(",") + ")",
              )
              .all(...deps.map((d) => d.nodeId)) as Array<{ id: string; title: string; status: string }>)
          : [];
      const blockedBy = depDetails.filter((d) => deps.find((dep) => dep.nodeId === d.id));
      const lines: string[] = [
        `# Related to: ${node.title} (id=${node.id})`,
        `Status: ${node.status} (${node.progress_pct}%) · Type: ${node.type}`,
        "",
      ];
      if (parent) lines.push(`Parent: ${statusIcons[parent.status] ?? "?"} ${parent.title} (id=${parent.id})`);
      if (siblings.length > 0) {
        lines.push("", `Siblings (${siblings.length}):`);
        for (const s of siblings.slice(0, 10)) {
          lines.push(`  ${statusIcons[s.status] ?? "?"} ${s.title} (id=${s.id})`);
        }
        if (siblings.length > 10) lines.push(`  ... and ${siblings.length - 10} more`);
      }
      if (children.length > 0) {
        lines.push("", `Children (${children.length}):`);
        for (const c of children.slice(0, 10)) {
          lines.push(`  ${statusIcons[c.status] ?? "?"} ${c.title} (id=${c.id})`);
        }
        if (children.length > 10) lines.push(`  ... and ${children.length - 10} more`);
      }
      if (blockedBy.length > 0) {
        lines.push("", `Depends on (${blockedBy.length}):`);
        for (const b of blockedBy) {
          lines.push(`  ${statusIcons[b.status] ?? "?"} ${b.title} (id=${b.id})`);
        }
      }
      return lines.join("\n");
    },
  );

  register("strategy_node", "Get details of a specific strategy node", "nodeId", async (p) => {
    const node = getStrategyNode(db, p.nodeId as string);
    if (!node) return "Node not found.";
    const children = getStrategyChildren(db, p.nodeId as string);
    const path = getStrategyPath(db, p.nodeId as string);
    const sourceRef = node.source_ref;
    const lines = [`# ${node.title}`, `Path: ${path.join(" > ")}`, `Type: ${node.type} | Status: ${node.status} | Progress: ${node.progress_pct}%`, `ID: ${node.id}`];
    if (sourceRef) lines.push(`Source: ${sourceRef}`);
    if (node.description) lines.push(`\n${node.description}`);
    const criteria = parseCriteria(node.acceptance_criteria);
    if (criteria.length > 0) lines.push(`\nAcceptance Criteria:\n${criteria.map(c => `  - ${c}`).join("\n")}`);
    if (children.length > 0) lines.push(`\nChildren (${children.length}):\n${children.map(c => `  ${statusIcons[c.status] ?? "?"} [${c.type}] ${c.title} (${c.progress_pct}%) id:${c.id}`).join("\n")}`);
    return lines.join("\n");
  });

  register("strategy_update", "Update status of a strategy node", "nodeId, status(pending|in_progress|completed|blocked|skipped)", async (p) => {
    const node = getStrategyNode(db, p.nodeId as string);
    if (!node) return "Node not found.";
    const status = p.status as string;
    const progressPct = status === "completed" || status === "skipped" ? 100 : node.progress_pct;
    db.prepare(`UPDATE strategy_nodes SET status = ?, progress_pct = ?, updated_at = datetime('now') WHERE id = ?`).run(status, progressPct, p.nodeId);
    h.propagateUp(node.parent_id);
    return `"${node.title}" \u2192 ${status} (${progressPct}%)`;
  });

  register("strategy_progress", "Set progress % on a node (auto-propagates)", "nodeId, progressPct(0-100)", async (p) => {
    const node = getStrategyNode(db, p.nodeId as string);
    if (!node) return "Node not found.";
    const pct = p.progressPct as number;
    const status = pct >= 100 ? "completed" : pct > 0 ? "in_progress" : node.status;
    db.prepare(`UPDATE strategy_nodes SET progress_pct = ?, status = ?, updated_at = datetime('now') WHERE id = ?`).run(pct, status, p.nodeId);
    h.propagateUp(node.parent_id);
    return `"${node.title}": ${pct}% (${status})`;
  });

  register("strategy_add", "Add a node to the strategy tree", "parentId, type(strategy|goal|task|subtask), title, description?, acceptanceCriteria?[], weight?, priority?(1=critical,2=high,3=normal,4=low), sourceRef?, dependsOn?[{nodeId,type:FS|SS}]", async (p) => {
    const parent = getStrategyNode(db, p.parentId as string);
    if (!parent) return "Parent not found.";
    const id = nanoid();
    const depth = parent.depth + 1;
    const nextSortOrder = getNextSortOrder(db, p.parentId as string);
    const criteria = p.acceptanceCriteria ?? [];
    const deps = p.dependsOn ?? [];
    const pri = p.priority ?? 3;
    db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens, source_ref, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, parent.project_id, parent.org_id, p.parentId, p.type, p.title, p.description ?? "", depth, nextSortOrder, JSON.stringify(deps), JSON.stringify(criteria), p.weight ?? 1, p.estimatedTokens ?? 0, p.sourceRef ?? null, pri);
    const priLabel = pri === 1 ? " ★CRITICAL" : pri === 2 ? " ▲HIGH" : pri === 4 ? " ▽LOW" : "";
    return `Added [${p.type}] "${p.title}"${priLabel} under "${parent.title}" (id: ${id})`;
  });

  register("strategy_batch_update", "Update multiple nodes at once. Saves tokens vs calling strategy_update in a loop.", "nodeIds[], status(pending|in_progress|completed|blocked|skipped)", async (p) => {
    const ids = p.nodeIds as string[];
    const status = p.status as string;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return "Pass nodeIds[] array.";
    const progressPct = status === "completed" || status === "skipped" ? 100 : undefined;
    let updated = 0;
    const parentIds = new Set<string | null>();
    for (const nodeId of ids) {
      const node = db.prepare(`SELECT parent_id FROM strategy_nodes WHERE id = ?`).get(nodeId) as { parent_id: string | null } | undefined;
      if (!node) continue;
      if (progressPct !== undefined) {
        db.prepare(`UPDATE strategy_nodes SET status = ?, progress_pct = ?, updated_at = datetime('now') WHERE id = ?`).run(status, progressPct, nodeId);
      } else {
        db.prepare(`UPDATE strategy_nodes SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, nodeId);
      }
      parentIds.add(node.parent_id);
      updated++;
    }
    for (const pid of parentIds) { if (pid) h.propagateUp(pid); }
    return `Updated ${updated} nodes to ${status}.`;
  });

  register("strategy_skip_children", "Skip all pending children of a node (useful for pruning ingested doc nodes).", "parentId", async (p) => {
    const parent = db.prepare(`SELECT id, title FROM strategy_nodes WHERE id = ?`).get(p.parentId) as { id: string; title: string } | undefined;
    if (!parent) return "Parent not found.";
    const result = db.prepare(`
      UPDATE strategy_nodes SET status = 'skipped', progress_pct = 100, updated_at = datetime('now')
      WHERE parent_id = ? AND status = 'pending'
    `).run(parent.id);
    h.propagateUp(parent.id);
    return `Skipped ${result.changes} pending children of "${parent.title}".`;
  });

  register("strategy_delete_children", "Delete all children of a node (remove auto-ingested junk).", "parentId", async (p) => {
    const parent = db.prepare(`SELECT id, title FROM strategy_nodes WHERE id = ?`).get(p.parentId) as { id: string; title: string } | undefined;
    if (!parent) return "Parent not found.";
    // Delete grandchildren first, then children
    db.prepare(`DELETE FROM strategy_nodes WHERE parent_id IN (SELECT id FROM strategy_nodes WHERE parent_id = ?)`).run(parent.id);
    const result = db.prepare(`DELETE FROM strategy_nodes WHERE parent_id = ?`).run(parent.id);
    h.propagateUp(parent.id);
    return `Deleted ${result.changes} children of "${parent.title}".`;
  });

  register("strategy_next", "Find next actionable task (pending leaf with deps met)", "projectId?, orgId?", async (p) => {
    const pid = (p.projectId as string) ?? h.resolveProjectId();
    if (!pid) return "Pass projectId.";
    // Explicit projectId determines the org — see resolveProjectOrg.
    const orgId = h.resolveProjectOrg(pid);
    if (!orgId) return `Unknown project ${pid} (no such project).`;
    const allNodes = listProjectStrategyByDepth(db, pid, orgId);
    if (allNodes.length === 0) return `Project ${pid} has no strategy tree (0 nodes).`;
    const nodeMap = new Map(allNodes.map(r => [r.id, r]));
    const hasChildren = new Set(allNodes.filter(n => n.parent_id).map(n => n.parent_id!));
    const skipAncestors = new Set(allNodes.filter(n => n.status === "skipped" || n.status === "completed").map(n => n.id));
    for (const node of allNodes) {
      if (node.status !== "pending" || hasChildren.has(node.id)) continue;
      let skip = false; let anc = node.parent_id;
      while (anc) { if (skipAncestors.has(anc)) { skip = true; break; } anc = nodeMap.get(anc)?.parent_id ?? null; }
      if (skip) continue;
      const deps = parseDeps(node.dependencies);
      const canStart = deps.every(dep => { const pred = nodeMap.get(dep.nodeId); if (!pred) return true; if (dep.type === "FS") return pred.status === "completed" || pred.status === "skipped"; if (dep.type === "SS") return pred.status !== "pending"; return true; });
      if (canStart) {
        const path: string[] = []; let cur: StrategyRow | undefined = node;
        while (cur) { path.unshift(cur.title); cur = cur.parent_id ? nodeMap.get(cur.parent_id) : undefined; }
        const criteria = parseCriteria(node.acceptance_criteria);
        return [`# NEXT TASK`, `Path: ${path.join(" > ")}`, `Title: ${node.title}`, `Type: ${node.type} | ID: ${node.id}`, node.description || "", criteria.length > 0 ? `Criteria:\n${criteria.map(c => `  - ${c}`).join("\n")}` : ""].filter(Boolean).join("\n");
      }
    }
    return "No actionable tasks. All tasks are in progress, completed, or blocked.";
  });

  register("project_list", "List all projects in an org", "orgId", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId (org_personal, org_wyobi, org_apply).";
    const rows = db.prepare(`SELECT p.id, p.name, p.path, ${projectLiveStatusSql("p")} as status, p.autonomy_level, p.token_budget, (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.status = 'running') as active FROM projects p WHERE p.org_id = ? ORDER BY p.name`).all(org.id) as Array<Record<string, unknown>>;
    if (rows.length === 0) return `No projects in ${org.name}.`;
    return [`# Projects [${org.name}]`, "", ...rows.map(r => `- **${r.name}** (${r.status}) id:${(r.id as string)}\n  ${r.path} | Budget: ${(r.token_budget as number).toLocaleString("en-US")} | Active: ${r.active}`)].join("\n");
  });

  register("project_create", "Create a new project", "orgId, name, path, tokenBudget?, autonomyLevel?(full|supervised|manual)", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    const account = db.prepare(`SELECT id, name FROM accounts WHERE org_id = ? LIMIT 1`).get(org.id) as { id: string; name: string } | undefined;
    if (!account) return "No account for this org.";
    const nodePath = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const resolved = nodePath.default.resolve(p.path as string);
    const homeDir = os.default.homedir();
    if (!resolved.startsWith(homeDir + "/")) return "Path must be under home directory.";
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
      const { execFileSync } = await import("node:child_process");
      try { execFileSync("git", ["init"], { cwd: resolved, stdio: "pipe" }); } catch { /* non-fatal */ }
    }
    const id = nanoid();
    db.prepare(`INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, org.id, p.name, resolved, account.id, p.tokenBudget ?? 500000, p.autonomyLevel ?? "supervised");
    return `Created "${p.name}" in ${org.name} (id: ${id})\nPath: ${resolved}`;
  });

  register("project_update", "Update a project's settings", "projectId, name?, tokenBudget?, autonomyLevel?", async (p) => {
    const project = db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(p.projectId) as { id: string; name: string } | undefined;
    if (!project) return "Project not found.";
    const sets: string[] = []; const params: unknown[] = [];
    if (p.name !== undefined) { sets.push("name = ?"); params.push(p.name); }
    if (p.tokenBudget !== undefined) { sets.push("token_budget = ?"); params.push(p.tokenBudget); }
    if (p.autonomyLevel !== undefined) { sets.push("autonomy_level = ?"); params.push(p.autonomyLevel); }
    if (sets.length === 0) return "No fields to update.";
    params.push(p.projectId);
    db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return `Updated "${project.name}".`;
  });

  register("session_launch", "Launch a new Claude Code session", "projectId, goal, acceptanceCriteria[], strategyNodeId?", async (p) => {
    const result = await h.apiCall("POST", "/api/sessions", { projectId: p.projectId, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, strategyNodeId: p.strategyNodeId });
    if (!result.ok) return `Failed: ${result.error}`;
    return `Session launched: ${(result.data as { sessionId: string }).sessionId}`;
  });

  register("session_list", "List recent sessions", "orgId, status?(running|completed|failed|stopped|all)", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    let sql = `SELECT s.id, s.status, s.goal_text, s.tokens_used, s.started_at, p.name as pname FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.org_id = ?`;
    const params: unknown[] = [org.id];
    if (p.status && p.status !== "all") { sql += ` AND s.status = ?`; params.push(p.status); }
    sql += ` ORDER BY s.started_at DESC LIMIT 20`;
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) return "No sessions.";
    return [`# Sessions [${org.name}]`, "", ...rows.map(r => `- [${r.status}] ${r.pname}: ${(r.goal_text as string).slice(0, 80)}...\n  ID: ${(r.id as string).slice(0, 12)} | Tokens: ${(r.tokens_used as number).toLocaleString("en-US")}`)].join("\n");
  });

  register(
    "session_search",
    "Search historical sessions by goal text, project, status, or time range. Returns matches with id, status, goal, project, started_at, tokens.",
    "orgId, query?(text), projectId?, status?(running|completed|failed|stopped), sinceHours?(number), limit?(default 25, max 100)",
    async (p) => {
      const org = h.resolveOrg(p.orgId as string);
      if (!org) return "Pass orgId.";
      const limit = Math.min(
        100,
        Math.max(1, parseInt(String(p.limit ?? "25"), 10) || 25),
      );
      const conds: string[] = ["s.org_id = ?"];
      const params: unknown[] = [org.id];
      if (p.query && String(p.query).trim()) {
        conds.push("(s.goal_text LIKE ? OR s.id LIKE ?)");
        const like = `%${String(p.query).trim()}%`;
        params.push(like, like);
      }
      if (p.projectId) {
        conds.push("s.project_id = ?");
        params.push(p.projectId);
      }
      if (p.status && p.status !== "all") {
        conds.push("s.status = ?");
        params.push(p.status);
      }
      if (p.sinceHours) {
        const hours = parseInt(String(p.sinceHours), 10);
        if (Number.isFinite(hours) && hours > 0) {
          conds.push("s.started_at > datetime('now', ?)");
          params.push(`-${hours} hours`);
        }
      }
      const sql = `SELECT s.id, s.status, s.goal_text, s.tokens_used, s.started_at, s.ended_at, s.claude_session_id, p.name as pname
                   FROM sessions s JOIN projects p ON s.project_id = p.id
                   WHERE ${conds.join(" AND ")}
                   ORDER BY s.started_at DESC LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      if (rows.length === 0) return "No sessions match.";
      return [
        `# Session search [${org.name}] (${rows.length} match${rows.length === 1 ? "" : "es"})`,
        "",
        ...rows.map((r) => {
          const goal = (r.goal_text as string).slice(0, 100);
          const id = (r.id as string).slice(0, 12);
          const cc = r.claude_session_id ? ` cc=${(r.claude_session_id as string).slice(0, 8)}` : "";
          return `- [${r.status}] ${r.pname}: ${goal}\n  id=${id}${cc} | tokens=${(r.tokens_used as number ?? 0).toLocaleString("en-US")} | ${r.started_at}`;
        }),
      ].join("\n");
    },
  );

  register(
    "session_get",
    "Get full details of one session including goal, status, project, latest events.",
    "sessionId",
    async (p) => {
      const sid = String(p.sessionId ?? "").trim();
      if (!sid) return "Pass sessionId.";
      const row = db
        .prepare(
          `SELECT s.id, s.status, s.goal_text, s.tokens_used, s.cost_usd, s.model,
                  s.started_at, s.ended_at, s.last_activity_at, s.claude_session_id,
                  s.failure_mode, s.failure_summary, p.name as pname, o.name as oname
             FROM sessions s
             JOIN projects p ON s.project_id = p.id
             JOIN organizations o ON s.org_id = o.id
            WHERE s.id = ?`,
        )
        .get(sid) as Record<string, unknown> | undefined;
      if (!row) return `No session ${sid}.`;
      const events = db
        .prepare(
          `SELECT event_type, substr(payload, 1, 120) AS payload, created_at
             FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 8`,
        )
        .all(sid) as Array<Record<string, unknown>>;
      const eventLines = events.length
        ? events.map((e) => `  - [${e.created_at}] ${e.event_type}: ${e.payload}`).join("\n")
        : "  (no events)";
      return [
        `# Session ${(row.id as string).slice(0, 12)}`,
        `Status: ${row.status}`,
        `Org/Project: ${row.oname} / ${row.pname}`,
        `Goal: ${row.goal_text}`,
        `Tokens: ${(row.tokens_used as number ?? 0).toLocaleString("en-US")} | Cost: $${(row.cost_usd as number ?? 0).toFixed(4)} | Model: ${row.model ?? "?"}`,
        `Started: ${row.started_at}${row.ended_at ? ` | Ended: ${row.ended_at}` : ""}`,
        `Last activity: ${row.last_activity_at}`,
        row.claude_session_id ? `Claude session id: ${row.claude_session_id}` : "",
        row.failure_mode ? `Failure: ${row.failure_mode} — ${row.failure_summary}` : "",
        "",
        "Recent events:",
        eventLines,
      ]
        .filter((l) => l !== "")
        .join("\n");
    },
  );

  register("session_stop", "Stop a running session", "sessionId", async (p) => {
    const result = await h.apiCall("POST", `/api/sessions/${p.sessionId}/intervene`, { action: "stop" });
    return result.ok ? `Stopped ${(p.sessionId as string).slice(0, 12)}.` : `Failed: ${result.error}`;
  });

  register("session_redirect", "Redirect a running session", "sessionId, message", async (p) => {
    const result = await h.apiCall("POST", `/api/sessions/${p.sessionId}/intervene`, { action: "redirect", message: p.message });
    return result.ok ? `Redirected ${(p.sessionId as string).slice(0, 12)}.` : `Failed: ${result.error}`;
  });

  register("alert_list", "List alerts", "orgId, includeAcked?(bool), limit?(number)", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    const rows = listOrgAlerts(db, org.id, {
      includeAcked: p.includeAcked as boolean | undefined,
      limit: (p.limit as number) ?? 20,
    });
    if (rows.length === 0) return "No alerts.";
    return [`# Alerts [${org.name}]`, "", ...rows.map(r => `${r.acknowledged ? "\u2713" : "!"} [${r.severity}] ${r.type}: ${r.message}\n  ID: ${r.id} | ${r.created_at}`)].join("\n");
  });

  register("alert_ack", "Acknowledge alert(s)", "orgId, alertId?(number, omit to ack all)", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    if (p.alertId !== undefined) {
      acknowledgeAlert(db, p.alertId as number, org.id);
      return `Alert ${p.alertId} acknowledged.`;
    }
    const count = acknowledgeAllOrgAlerts(db, org.id);
    return `${count} alerts acknowledged.`;
  });

  register("memory_store", "Store a memory (fact, decision, pattern, skill)", "orgId, category(skill|decision|pattern|fact), key, value, project?", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    const id = nanoid();
    const now = new Date().toISOString();
    const projectId = (p.project as string) ?? null;
    // Two-step upsert: ON CONFLICT doesn't work when project_id is NULL (SQLite treats NULLs as distinct)
    const existingWhere = projectId === null
      ? `org_id = ? AND project_id IS NULL AND category = ? AND key = ?`
      : `org_id = ? AND project_id = ? AND category = ? AND key = ?`;
    const existingParams = projectId === null
      ? [org.id, p.category, p.key]
      : [org.id, projectId, p.category, p.key];
    const updated = db.prepare(`UPDATE memory SET value = ?, updated_at = ? WHERE ${existingWhere}`).run(p.value, now, ...existingParams);
    if (updated.changes === 0) {
      db.prepare(`INSERT INTO memory (id, org_id, project_id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, org.id, projectId, p.category, p.key, p.value, now, now);
    }
    return `Stored [${org.slug}] [${p.category}] ${p.key}`;
  });

  register("memory_search", "Search org memory by keyword", "orgId, query, category?, project?, limit?", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    let sql = `SELECT id, project_id, category, key, value, updated_at FROM memory WHERE org_id = ?`;
    const params: unknown[] = [org.id];
    if (p.category) { sql += ` AND category = ?`; params.push(p.category); }
    if (p.project) { sql += ` AND (project_id IS NULL OR project_id = ?)`; params.push(p.project); }
    const escaped = String(p.query).replace(/%/g, "\\%").replace(/_/g, "\\_");
    sql += ` AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')`; const pat = `%${escaped}%`; params.push(pat, pat);
    sql += ` ORDER BY updated_at DESC LIMIT ?`; params.push((p.limit as number) ?? 10);
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) return `No memories matching "${p.query}" in ${org.name}.`;
    return rows.map(r => `[${r.category}] ${r.key}:\n${r.value}`).join("\n\n---\n\n");
  });

  register("memory_list", "List all memories in an org", "orgId, category?, project?", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    let sql = `SELECT category, key, project_id, access_count FROM memory WHERE org_id = ?`;
    const params: unknown[] = [org.id];
    if (p.category) { sql += ` AND category = ?`; params.push(p.category); }
    if (p.project) { sql += ` AND (project_id IS NULL OR project_id = ?)`; params.push(p.project); }
    sql += ` ORDER BY category, key LIMIT 500`;
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) return `No memories in ${org.name}.`;
    return rows.map(r => `- [${r.category}] ${r.key} (${r.project_id ?? "org-wide"}, ${r.access_count}x)`).join("\n");
  });

  register("memory_delete", "Delete a memory", "orgId, id", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId.";
    const result = db.prepare(`DELETE FROM memory WHERE id = ? AND org_id = ?`).run(p.id, org.id);
    return result.changes > 0 ? `Deleted.` : `Not found in ${org.name}.`;
  });

  // ── Autonomous-loop control (the AI drives its own loop) ────────────────

  register(
    "loop_status",
    "ONE-CALL loop diagnostic: verdict (RUNNING/WAITING/DEFERRED/SLEEPING/OFF) + why — config, armed wake, blocking sessions, budget burn, next task",
    "projectId?",
    async (p) => {
      const pid = (p.projectId as string) ?? h.resolveProjectId();
      if (!pid) return "No project. Pass projectId or run inside a project session.";
      const c = getLoopConfig(db, pid);
      const proj = db.prepare(`SELECT name, org_id, account_id FROM projects WHERE id = ?`).get(pid) as { name: string; org_id: string; account_id: string } | undefined;
      if (!proj) return `Unknown project ${pid}.`;

      // Gather every fact that answers "is it running and if not why not".
      const liveLoop = db.prepare(
        `SELECT id, status FROM sessions WHERE project_id = ? AND status IN ('starting','running') AND id NOT LIKE 'manual_%' LIMIT 1`,
      ).get(pid) as { id: string; status: string } | undefined;
      const blockers = db.prepare(
        `SELECT id FROM sessions WHERE project_id = ? AND status = 'running' AND id LIKE 'manual_%'`,
      ).all(pid) as Array<{ id: string }>;
      const wake = db.prepare(
        `SELECT next_run_at FROM scheduled_tasks WHERE project_id = ? AND oneshot = 1 AND strategy_mode = 'next_actionable' AND enabled = 1 ORDER BY next_run_at LIMIT 1`,
      ).get(pid) as { next_run_at: string } | undefined;
      const acct = db.prepare(`SELECT daily_token_limit FROM accounts WHERE id = ?`).get(proj.account_id) as { daily_token_limit: number } | undefined;
      const today = db.prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM token_usage WHERE account_id = ? AND recorded_at >= date('now')`,
      ).get(proj.account_id) as { t: number };
      const burnPct = acct && acct.daily_token_limit > 0 ? Math.round((today.t / acct.daily_token_limit) * 100) : null;
      const nextPending = db.prepare(
        `SELECT title FROM strategy_nodes WHERE project_id = ? AND status = 'pending' AND id NOT IN (SELECT parent_id FROM strategy_nodes WHERE parent_id IS NOT NULL) ORDER BY COALESCE(priority,3), depth, sort_order LIMIT 1`,
      ).get(pid) as { title: string } | undefined;

      // Verdict, in priority order.
      let verdict: string;
      if (!c.enabled) verdict = "OFF — loop disabled (enable: loop_set enabled=true)";
      else if (liveLoop) verdict = `RUNNING — session ${liveLoop.id} is ${liveLoop.status}`;
      else if (burnPct !== null && burnPct >= 200) verdict = `SLEEPING — budget ${burnPct}% of daily; resumes at midnight or raise daily_token_limit`;
      else if (blockers.length > 0 && wake) verdict = `DEFERRED — ${blockers.length} interactive session(s) in this repo (anti-collision); wake retries ${wake.next_run_at}`;
      else if (wake) verdict = `WAITING — next wake ${wake.next_run_at}`;
      else verdict = "STALLED — enabled but NO wake armed (run loop_set enabled=true to seed one)";

      return [
        `# Loop: ${proj.name}`,
        `VERDICT: ${verdict}`,
        `config: mode=${c.mode}, interval=${c.interval_minutes}m${c.mode === "branch" ? `, branch=${c.linked_node_id}` : ""}${c.mode === "content" ? `, content=${(c.content ?? "").slice(0, 80)}` : ""}`,
        `budget: today ${Math.round(today.t / 1e6 * 10) / 10}M / ${acct ? Math.round(acct.daily_token_limit / 1e6) : "?"}M (${burnPct ?? "?"}%)`,
        `next task: ${nextPending?.title ?? "(none pending — tree may be done or blocked)"}`,
        blockers.length > 0 ? `blocking sessions: ${blockers.map((b) => b.id).join(", ")}` : "",
      ].filter(Boolean).join("\n");
    },
  );

  register(
    "loop_set",
    "Configure THIS loop. mode 'continue' drives the strategy tree; 'content' injects your text each iteration; 'branch' drives a node's subtree and auto-stops when complete. You can change content/mode/interval anytime, or enabled=false to stop.",
    "projectId?, enabled?(bool), mode?(continue|content|branch), content?(string), nodeId?(string for branch mode), intervalMinutes?(default 10)",
    async (p) => {
      const pid = (p.projectId as string) ?? h.resolveProjectId();
      if (!pid) return "No project. Pass projectId or run inside a project session.";

      const mode = p.mode as LoopMode | undefined;
      if (mode && !["continue", "content", "branch"].includes(mode)) {
        return "mode must be one of: continue, content, branch.";
      }
      if (mode === "content" && (p.content === undefined) && !getLoopConfig(db, pid).content) {
        return "mode 'content' needs content — pass content with the text to inject each iteration.";
      }
      if (mode === "branch" && (p.nodeId === undefined) && !getLoopConfig(db, pid).linked_node_id) {
        return "mode 'branch' needs nodeId — pass the strategy node id whose subtree to drive.";
      }
      if (p.nodeId !== undefined) {
        const exists = db.prepare(`SELECT 1 FROM strategy_nodes WHERE id = ? AND project_id = ?`).get(p.nodeId, pid);
        if (!exists) return `No strategy node ${String(p.nodeId)} in this project.`;
      }

      const c = upsertLoopConfig(db, pid, {
        enabled: p.enabled as boolean | undefined,
        mode,
        content: p.content === undefined ? undefined : (p.content as string),
        linkedNodeId: p.nodeId === undefined ? undefined : (p.nodeId as string),
        intervalMinutes: p.intervalMinutes as number | undefined,
        // any reconfiguration resets the no-progress guard
        noProgressCount: 0,
        lastTargetId: null,
      });

      // SEED the first wake: the loop chain used to start only from a session
      // Stop hook — enabling a loop with no session running did NOTHING
      // (silently). Enabling now schedules a one-shot wake interval_minutes
      // out; each iteration's stop hook then schedules the next.
      let seeded = "";
      if (c.enabled) {
        const proj = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(pid) as { org_id: string } | undefined;
        const pendingWake = db.prepare(
          `SELECT 1 FROM scheduled_tasks WHERE project_id = ? AND oneshot = 1 AND strategy_mode = 'next_actionable' AND enabled = 1 LIMIT 1`,
        ).get(pid);
        if (proj && !pendingWake) {
          const nextRun = new Date(Date.now() + c.interval_minutes * 60_000).toISOString();
          db.prepare(
            `INSERT INTO scheduled_tasks
               (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week,
                goal_template, task_type, enabled, next_run_at, mode, interval_minutes, oneshot, strategy_mode)
             VALUES (?, ?, ?, ?, 0, 0, '0,1,2,3,4,5,6', '', 'loop', 1, ?, 'interval', ?, 1, 'next_actionable')`,
          ).run(nanoid(), pid, proj.org_id, `Loop wake (seeded +${c.interval_minutes}m)`, nextRun, c.interval_minutes);
          seeded = ` First wake seeded for ${c.interval_minutes}m from now.`;
        }
      }
      return `Loop updated: ${c.enabled ? "ENABLED" : "disabled"}, mode=${c.mode}, interval=${c.interval_minutes}m${c.mode === "branch" ? `, branch=${c.linked_node_id}` : ""}.${seeded}`;
    },
  );

  register("loop_stop", "Stop/disable THIS project's autonomous loop (use when there's genuinely nothing left to do)", "projectId?", async (p) => {
    const pid = (p.projectId as string) ?? h.resolveProjectId();
    if (!pid) return "No project. Pass projectId or run inside a project session.";
    upsertLoopConfig(db, pid, { enabled: false });
    return "Loop disabled. It will not re-inject after the current iteration.";
  });

  // ── Cross-Coordination Tools ────────────────────────────

  register("file_lock", "Lock a file to prevent concurrent edits", "sessionId?, orgId?, path", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session ID. Pass sessionId or set NOSLEEP_SESSION_ID.";
    const orgId = (p.orgId as string) ?? h.resolveSessionOrg(sid);
    if (!orgId) return "Could not resolve org. Pass orgId.";
    const path = p.path as string;
    if (!path) return "Pass path.";
    const id = nanoid();
    try {
      db.prepare(`INSERT INTO file_locks (id, org_id, session_id, file_path, locked_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(id, orgId, sid, path);
      return `Locked: ${path}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        const holder = db.prepare(`SELECT fl.session_id, s.goal_text FROM file_locks fl LEFT JOIN sessions s ON fl.session_id = s.id WHERE fl.file_path = ? AND fl.org_id = ? AND fl.released_at IS NULL`).get(path, orgId) as { session_id: string; goal_text: string } | undefined;
        if (holder) return `File locked by session ${holder.session_id} (goal: ${holder.goal_text ?? "unknown"})`;
        return `File already locked.`;
      }
      throw err;
    }
  });

  register("file_unlock", "Release a file lock", "sessionId?, path", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session ID.";
    const path = p.path as string;
    if (!path) return "Pass path.";
    const result = db.prepare(`UPDATE file_locks SET released_at = datetime('now') WHERE session_id = ? AND file_path = ? AND released_at IS NULL`).run(sid, path);
    return result.changes > 0 ? `Unlocked: ${path}` : `No lock found.`;
  });

  register("file_check", "Check if a file is locked", "path, orgId?", async (p) => {
    const path = p.path as string;
    if (!path) return "Pass path.";
    const orgId = (p.orgId as string) ?? h.resolveSessionOrg();
    if (!orgId) return "Could not resolve org. Pass orgId.";
    const lock = db.prepare(`SELECT fl.id, fl.session_id, fl.locked_at, s.goal_text FROM file_locks fl LEFT JOIN sessions s ON fl.session_id = s.id WHERE fl.file_path = ? AND fl.org_id = ? AND fl.released_at IS NULL`).get(path, orgId) as { id: string; session_id: string; locked_at: string; goal_text: string } | undefined;
    if (!lock) return `Not locked: ${path}`;
    return `Locked by session ${lock.session_id} (goal: ${lock.goal_text ?? "unknown"}) since ${lock.locked_at}`;
  });

  register("session_msg", "Send a message to other sessions", "orgId, type(discovery|request|handoff|conflict|info), message, to?", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    if (!org) return "Pass orgId (org_personal, org_wyobi, org_apply).";
    const fromSession = deps.envSessionId ?? null;
    const toSession = (p.to as string) ?? null;
    const msgType = p.type as string;
    if (!msgType) return "Pass type (discovery|request|handoff|conflict|info).";
    const message = p.message as string;
    if (!message) return "Pass message.";
    const id = nanoid();
    db.prepare(`INSERT INTO session_messages (id, org_id, from_session_id, to_session_id, type, payload, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`).run(id, org.id, fromSession, toSession, msgType, message);
    return `Message sent (id: ${id}, type: ${msgType}, to: ${toSession ?? "broadcast"})`;
  });

  register("session_inbox", "Check inbox for messages from other sessions", "sessionId?", async (p) => {
    const sid = (p.sessionId as string) ?? deps.envSessionId;
    if (!sid) return "No session ID.";
    const orgId = h.resolveSessionOrg(sid);
    if (!orgId) return "Session not found.";
    const messages = db.prepare(`SELECT sm.id, sm.from_session_id, sm.to_session_id, sm.type, sm.payload, sm.created_at FROM session_messages sm WHERE (sm.to_session_id = ? OR (sm.to_session_id IS NULL AND sm.org_id = ?)) AND sm.read = 0 AND sm.from_session_id != ? ORDER BY sm.created_at ASC`).all(sid, orgId, sid) as Array<{ id: string; from_session_id: string | null; to_session_id: string | null; type: string; payload: string; created_at: string }>;
    if (messages.length === 0) return "No new messages.";
    const placeholders = messages.map(() => "?").join(",");
    db.prepare(`UPDATE session_messages SET read = 1 WHERE id IN (${placeholders})`).run(...messages.map(m => m.id));
    return messages.map(m => `[${m.type}] from:${m.from_session_id ?? "system"} ${m.to_session_id ? "" : "(broadcast)"} @ ${m.created_at}\n  ${m.payload}`).join("\n\n");
  });

  register("session_peers", "List other active sessions in the org", "orgId?", async (p) => {
    const orgId = (p.orgId as string) ? h.resolveOrg(p.orgId as string)?.id : h.resolveSessionOrg();
    if (!orgId) return "Could not resolve org. Pass orgId.";
    const currentSession = deps.envSessionId ?? "__none__";
    const peers = db.prepare(`SELECT s.id, s.status, s.goal_text, s.started_at, p.name as project_name FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.org_id = ? AND s.status IN ('running', 'idle', 'waiting_input') AND s.id != ? ORDER BY s.started_at DESC`).all(orgId, currentSession) as Array<{ id: string; status: string; goal_text: string; started_at: string; project_name: string }>;
    if (peers.length === 0) return "No active peers.";
    return [`# Active Peers (${peers.length})`, "", ...peers.map(s => `- [${s.status}] ${s.project_name}: ${s.goal_text.slice(0, 80)}\n  ID: ${s.id.slice(0, 12)} | Started: ${s.started_at}`)].join("\n");
  });

  // ── Vector Search Tools ──────────────────────────────────

  register("project_search", "Semantic search within a project's indexed code, docs, and plans", "projectId, query, limit?(default 5)", async (p) => {
    const pid = p.projectId as string;
    if (!pid) return "Pass projectId.";
    const query = p.query as string;
    if (!query) return "Pass query.";
    const limit = (p.limit as number) ?? 5;
    const params = new URLSearchParams({ q: query, projectId: pid, limit: String(limit) });
    const result = await h.apiCall("GET", `/api/search?${params.toString()}`);
    if (!result.ok) return `Search failed: ${result.error}`;
    const data = result.data as Array<{ filePath: string; heading: string | null; content: string; chunkType: string; distance: number; lineStart: number | null; lineEnd: number | null }>;
    if (!data || data.length === 0) return `No results for "${query}" in project ${pid}.`;
    return data.map((r, i) => {
      const loc = r.lineStart ? `:${r.lineStart}-${r.lineEnd}` : "";
      const heading = r.heading ? ` (${r.heading})` : "";
      return `${i + 1}. [${r.chunkType}] ${r.filePath}${loc}${heading} (dist: ${r.distance.toFixed(3)})\n   ${r.content.slice(0, 200)}`;
    }).join("\n\n");
  });

  register("search_all", "Semantic search across ALL active projects", "query, limit?(default 10)", async (p) => {
    const query = p.query as string;
    if (!query) return "Pass query.";
    const limit = (p.limit as number) ?? 10;
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const result = await h.apiCall("GET", `/api/search/all?${params.toString()}`);
    if (!result.ok) return `Search failed: ${result.error}`;
    const grouped = result.data as Record<string, Array<{ filePath: string; heading: string | null; content: string; chunkType: string; distance: number; lineStart: number | null; lineEnd: number | null }>>;
    if (!grouped || Object.keys(grouped).length === 0) return `No results for "${query}".`;
    const sections: string[] = [];
    for (const [projectId, results] of Object.entries(grouped)) {
      sections.push(`## Project: ${projectId}\n${results.map((r, i) => {
        const loc = r.lineStart ? `:${r.lineStart}-${r.lineEnd}` : "";
        const heading = r.heading ? ` (${r.heading})` : "";
        return `${i + 1}. [${r.chunkType}] ${r.filePath}${loc}${heading} (dist: ${r.distance.toFixed(3)})\n   ${r.content.slice(0, 200)}`;
      }).join("\n\n")}`);
    }
    return sections.join("\n\n");
  });

  // ── Brain: archive / thoughts / graph / artifacts / entities ──────
  // These proxy to the org-scoped brain HTTP routes. The gateway already
  // authenticates with the baked NOSLEEP_API_KEY, so no extra provisioning
  // is needed — every project gets the full brain surface, not just the
  // memory + code-search slice. org is resolved from the projectId.
  function orgForProject(projectId: string): string | null {
    if (!projectId) return null;
    const row = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(projectId) as { org_id: string } | undefined;
    if (!row) return null;
    // Honour the session's org binding: a session bound to one org must not
    // reach another org's brain by passing that org's projectId (project ids
    // are enumerable). Mirrors resolveOrg's envOrgId precedence.
    if (deps.envOrgId && row.org_id !== deps.envOrgId) return null;
    return row.org_id;
  }

  register("brain_search", "Search the brain ARCHIVE — captured conversation turns, tool calls, code, docs (hybrid lexical+semantic). The deep history layer.", "projectId, query, kindPrefix?(csv e.g. 'code/,decision/'), sessionId?, fromTs?, toTs?, limit?(20)", async (p) => {
    const pid = p.projectId as string;
    const orgId = orgForProject(pid);
    if (!orgId) return "Pass a valid projectId.";
    const q: Record<string, unknown> = { org_id: orgId, project_id: pid, scope: "project", layers: ["archive"], limit: (p.limit as number) ?? 20 };
    // Lexical mode by default: semantic/hybrid embeds the query with ONNX on
    // the main event loop, which stalls the server (2026-06-08 wedge). Pass
    // semantic=true to opt into hybrid once embedding moves to a worker thread.
    if (p.query) q.text = { query: String(p.query), mode: p.semantic ? "hybrid" : "lexical", weight: 1.0 };
    const facets: Record<string, unknown> = {};
    if (p.kindPrefix) facets.kind_prefix = String(p.kindPrefix).split(",").map((s) => s.trim()).filter(Boolean);
    if (p.sessionId) facets.session_id = p.sessionId;
    if (Object.keys(facets).length) q.facets = facets;
    if (p.fromTs !== undefined || p.toTs !== undefined) {
      const t: Record<string, unknown> = {};
      if (p.fromTs !== undefined) t.from = Number(p.fromTs);
      if (p.toTs !== undefined) t.to = Number(p.toTs);
      q.temporal = t;
    }
    const result = await h.apiCall("POST", "/api/brain/search", q);
    if (!result.ok) return `Brain search failed: ${result.error}`;
    const data = result.data as { results?: Array<{ hash: string; kind: string; ts: number; session_id: string | null; snippet: string; score: number }> };
    const rows = data?.results ?? [];
    if (rows.length === 0) return `No archive results for "${p.query}" in project ${pid}.`;
    return rows.map((r, i) => `${i + 1}. [${r.kind}] ${new Date(r.ts * 1000).toISOString()} (score ${r.score?.toFixed?.(3) ?? "?"})\n   hash: ${r.hash}\n   ${(r.snippet ?? "").slice(0, 220)}`).join("\n\n");
  });

  register("brain_thoughts_search", "Search distilled THOUGHTS (the synthesized wiki layer). Use scope='org' to search across all of an org's projects.", "projectId, query, scope?(project|org), limit?(10)", async (p) => {
    const pid = p.projectId as string;
    const orgId = orgForProject(pid);
    if (!orgId) return "Pass a valid projectId.";
    if (!p.query) return "Pass query.";
    const result = await h.apiCall("POST", "/api/brain/thoughts/search", { org_id: orgId, project_id: pid, query: String(p.query), limit: (p.limit as number) ?? 10, scope: (p.scope as string) ?? "project" });
    if (!result.ok) return `Thought search failed: ${result.error}`;
    const data = result.data as { results?: Array<{ id: string; thought_type: string | null; content: string; created_at: number }> };
    const rows = data?.results ?? [];
    if (rows.length === 0) return `No thoughts matching "${p.query}".`;
    return rows.map((r, i) => `${i + 1}. [${r.thought_type ?? "?"}] ${r.id}\n   ${r.content}`).join("\n\n");
  });

  register("brain_thought_get", "Fetch one thought by id, with metadata.", "projectId, thoughtId, include?(refs,archive)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    const tid = p.thoughtId as string;
    if (!tid) return "Pass thoughtId.";
    const qs = new URLSearchParams({ org_id: orgId });
    if (p.include) qs.set("include", String(p.include));
    const result = await h.apiCall("GET", `/api/brain/thoughts/${encodeURIComponent(tid)}?${qs.toString()}`);
    if (!result.ok) return `Get thought failed: ${result.error}`;
    return JSON.stringify(result.data, null, 2);
  });

  register("brain_thought_related", "Walk the thought GRAPH — neighbours of one thought via thought_refs (refines/supersedes/related/etc).", "projectId, thoughtId, limit?(10)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    const tid = p.thoughtId as string;
    if (!tid) return "Pass thoughtId.";
    const qs = new URLSearchParams({ org_id: orgId, limit: String((p.limit as number) ?? 10) });
    const result = await h.apiCall("GET", `/api/brain/thoughts/${encodeURIComponent(tid)}/related?${qs.toString()}`);
    if (!result.ok) return `Related thoughts failed: ${result.error}`;
    return JSON.stringify(result.data, null, 2);
  });

  register("brain_thought_stats", "Aggregated thought stats — counts by type, top topics, top people.", "projectId, scope?(project|org)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    const qs = new URLSearchParams({ org_id: orgId, project_id: p.projectId as string, scope: (p.scope as string) ?? "project" });
    const result = await h.apiCall("GET", `/api/brain/thoughts/stats?${qs.toString()}`);
    if (!result.ok) return `Thought stats failed: ${result.error}`;
    return JSON.stringify(result.data ?? {}, null, 2);
  });

  register("brain_capture_thought", "Capture a distilled thought into the brain.", "projectId, content, typeHint?, sourceRefs?(json)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    if (!p.content) return "Pass content.";
    const body: Record<string, unknown> = { org_id: orgId, project_id: p.projectId, content: String(p.content), source_kind: "gateway_capture" };
    if (p.typeHint) body.thought_type_hint = p.typeHint;
    if (p.sourceRefs) { try { body.source_refs = JSON.parse(String(p.sourceRefs)); } catch { /* ignore */ } }
    const result = await h.apiCall("POST", "/api/brain/thoughts", body);
    if (!result.ok) return `Capture failed: ${result.error}`;
    const d = result.data as { id?: string; similar_existing?: unknown[] };
    return `Captured thought ${d?.id ?? "?"}${Array.isArray(d?.similar_existing) && d.similar_existing.length ? ` (${d.similar_existing.length} similar exist)` : ""}.`;
  });

  register("brain_ingest_file", "Upload a document into the brain archive (PDF, Markdown/text, code, JSON/YAML/CSV, images) via the same pipeline as web upload — dedup, full-text + semantic index, PDF pages, auto-distilled thought. Pass `path` (inside the project's directory; dotfiles refused) OR `contentBase64` + `filename`. Max 10 MB.", "projectId, path? | contentBase64? + filename, contentType?", async (p) => {
    const pid = p.projectId as string;
    const orgId = orgForProject(pid);
    if (!orgId) return "Pass a valid projectId.";
    const project = db.prepare(`SELECT path FROM projects WHERE id = ?`).get(pid) as { path: string } | undefined;
    let payload: ReturnType<typeof readBrainFilePayload>;
    try {
      payload = readBrainFilePayload({
        path: p.path === undefined ? undefined : String(p.path),
        contentBase64: p.contentBase64 === undefined ? undefined : String(p.contentBase64),
        filename: p.filename === undefined ? undefined : String(p.filename),
        contentType: p.contentType === undefined ? undefined : String(p.contentType),
        projectRoot: project?.path && !project.path.startsWith("__adhoc__") ? project.path : null,
      });
    } catch (err) {
      return `Ingest refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    const result = await h.apiCall("POST", "/api/brain/ingest/file", {
      org_id: orgId,
      project_id: pid,
      filename: payload.filename,
      content_base64: payload.content_base64,
      content_type: payload.content_type,
      origin: { tool: "mcp-gateway", actor: "agent" },
    });
    if (!result.ok) return `Ingest failed: ${result.error}`;
    const d = result.data as { filename: string; kind: string; size: number; hash: string; duplicate: boolean; page_count?: number };
    return `${d.duplicate ? "Already in the brain (dedup hit — now linked to this project)" : "Ingested"}: ${d.filename} → ${d.kind} (${d.size} bytes)${d.page_count ? ` · ${d.page_count} page(s)` : ""}\nhash: ${d.hash}`;
  });

  register("brain_artifact_get", "Fetch one archive ARTIFACT by hash (with edges + ingest event).", "projectId, hash, include?(csv: edges,ingest_event)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    const hash = p.hash as string;
    if (!hash) return "Pass hash.";
    const qs = new URLSearchParams({ org_id: orgId });
    if (p.include) qs.set("include", String(p.include));
    const result = await h.apiCall("GET", `/api/brain/artifacts/${encodeURIComponent(hash)}?${qs.toString()}`);
    if (!result.ok) return `Get artifact failed: ${result.error}`;
    return JSON.stringify(result.data, null, 2);
  });

  register("brain_session_artifacts", "Replay a session's captured turns/tool-calls (HISTORY for one session).", "projectId, sessionId, limit?(100), order?(asc|desc)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    const sid = p.sessionId as string;
    if (!sid) return "Pass sessionId.";
    const qs = new URLSearchParams({ org_id: orgId, limit: String((p.limit as number) ?? 100), order: (p.order as string) ?? "asc" });
    const result = await h.apiCall("GET", `/api/brain/sessions/${encodeURIComponent(sid)}/artifacts?${qs.toString()}`);
    if (!result.ok) return `Session artifacts failed: ${result.error}`;
    const data = result.data as { items?: Array<{ kind: string; ts: number; snippet: string | null }> };
    const rows = data?.items ?? [];
    if (rows.length === 0) return `No artifacts for session ${sid}.`;
    return rows.map((r, i) => `${i + 1}. [${r.kind}] ${new Date(r.ts * 1000).toISOString()}\n   ${(r.snippet ?? "").slice(0, 200)}`).join("\n");
  });

  register("brain_entities", "List ENTITIES (people / concepts) extracted across the corpus.", "projectId, kind?, order?(ref_count|name|recent), limit?(50)", async (p) => {
    const orgId = orgForProject(p.projectId as string);
    if (!orgId) return "Pass a valid projectId.";
    const qs = new URLSearchParams({ org_id: orgId, limit: String((p.limit as number) ?? 50) });
    if (p.projectId) qs.set("project_id", p.projectId as string);
    if (p.kind) qs.set("kind", String(p.kind));
    if (p.order) qs.set("order", String(p.order));
    const result = await h.apiCall("GET", `/api/brain/entities?${qs.toString()}`);
    if (!result.ok) return `List entities failed: ${result.error}`;
    const data = result.data as { items?: Array<{ id: string; kind: string; canonical_name: string; ref_count: number }> };
    const rows = data?.items ?? [];
    if (rows.length === 0) return `No entities found.`;
    return rows.map((r) => `- [${r.kind}] ${r.canonical_name} (${r.ref_count}x) — ${r.id}`).join("\n");
  });

  // ── Plan Ingestion ─────────────────────────────────────

  register("plan_ingest", "Parse a markdown plan file and add it to the strategy tree. Extracts phases/tasks from ## headings.", "projectId, orgId?, filePath", async (p) => {
    const org = h.resolveOrg(p.orgId as string);
    const pid = p.projectId as string;
    if (!pid) return "Pass projectId.";
    const orgId = org?.id ?? h.resolveSessionOrg();
    if (!orgId) return "Pass orgId.";
    const filePath = p.filePath as string;
    if (!filePath) return "Pass filePath (path to the markdown plan).";

    // Read the file
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    let content: string;
    try {
      const resolved = nodePath.default.isAbsolute(filePath) ? filePath : nodePath.default.resolve(filePath);
      content = fs.readFileSync(resolved, "utf-8");
    } catch (e) {
      return `Cannot read file: ${(e as Error).message}`;
    }

    // Parse: title from # heading, phases from ## headings, criteria from - [ ] lines
    const lines = content.split("\n");
    const titleMatch = lines.find(l => /^# /.test(l));
    const planTitle = titleMatch?.replace(/^# /, "").trim() ?? nodePath.default.basename(filePath, ".md");

    // Extract success criteria (- [ ] lines)
    const criteria: string[] = [];
    for (const line of lines) {
      const m = line.match(/^- \[[ x]\] (.+)/);
      if (m) criteria.push(m[1].trim());
    }

    // Extract description (lines between first # and first ##)
    let description = "";
    let inDesc = false;
    for (const line of lines) {
      if (/^# /.test(line)) { inDesc = true; continue; }
      if (/^## /.test(line)) break;
      if (inDesc && line.trim() && !line.startsWith(">")) description += line.trim() + " ";
    }

    // Find root of this project's tree
    const root = db.prepare("SELECT id FROM strategy_nodes WHERE project_id = ? AND parent_id IS NULL").get(pid) as { id: string } | undefined;
    if (!root) return "Project has no strategy tree root. Create one first.";

    const maxSortRoot = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 as n FROM strategy_nodes WHERE parent_id = ?").get(root.id) as { n: number };
    let sortCounter = maxSortRoot.n;

    // Create the goal node
    const goalId = nanoid();
    db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, status, progress_pct, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(goalId, pid, orgId, root.id, "goal", planTitle, description.trim().slice(0, 500), "pending", 0, 1, sortCounter++, "[]", JSON.stringify(criteria), 2, 0);

    // Extract ## Phase/section headings as tasks
    let taskCount = 0;
    let currentPhaseTitle = "";
    let currentPhaseDesc = "";
    let currentPhaseCriteria: string[] = [];
    let taskSort = 0;

    function flushTask() {
      if (!currentPhaseTitle) return;
      const taskId = nanoid();
      db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, status, progress_pct, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(taskId, pid, orgId, goalId, "task", currentPhaseTitle, currentPhaseDesc.trim().slice(0, 500), "pending", 0, 2, taskSort++, "[]", JSON.stringify(currentPhaseCriteria), 1, 0);
      taskCount++;
      currentPhaseTitle = "";
      currentPhaseDesc = "";
      currentPhaseCriteria = [];
    }

    for (const line of lines) {
      const h2 = line.match(/^## (.+)/);
      if (h2) {
        flushTask();
        currentPhaseTitle = h2[1].trim();
        continue;
      }
      if (currentPhaseTitle) {
        const successMatch = line.match(/^\*\*Success[:\*]*\*?\*?\s*(.+)/i);
        if (successMatch) {
          currentPhaseCriteria.push(successMatch[1].trim());
          continue;
        }
        const bulletCriteria = line.match(/^- \[[ x]\] (.+)/);
        if (bulletCriteria) {
          currentPhaseCriteria.push(bulletCriteria[1].trim());
          continue;
        }
        if (line.trim() && !line.startsWith("|") && !line.startsWith("```") && !line.startsWith("#")) {
          currentPhaseDesc += line.trim() + " ";
        }
      }
    }
    flushTask();

    // Recalculate root progress
    const children = db.prepare("SELECT progress_pct, weight FROM strategy_nodes WHERE parent_id = ?").all(root.id) as Array<{ progress_pct: number; weight: number }>;
    const totalW = children.reduce((s, c) => s + (c.weight || 1), 0);
    const wp = children.reduce((s, c) => s + c.progress_pct * (c.weight || 1), 0);
    db.prepare("UPDATE strategy_nodes SET progress_pct = ? WHERE id = ?").run(Math.round(wp / totalW), root.id);

    return `Ingested plan "${planTitle}": 1 goal + ${taskCount} tasks added to strategy tree.${criteria.length > 0 ? ` ${criteria.length} success criteria.` : ""}`;
  });

  // ── Schedule Tools ───────────────────────────────────────

  register("schedule_list", "List scheduled tasks for a project or org", "projectId?, orgId?", async (p) => {
    const params = new URLSearchParams();
    if (p.projectId) params.set("projectId", p.projectId as string);
    if (p.orgId) params.set("orgId", p.orgId as string);
    const result = await h.apiCall("GET", `/api/scheduled-tasks?${params.toString()}`);
    if (!result.ok) return `Failed: ${result.error}`;
    const tasks = result.data as Array<Record<string, unknown>>;
    if (!tasks || tasks.length === 0) return "No scheduled tasks.";
    return ["# Scheduled Tasks", "", ...tasks.map(t =>
      `- [${t.enabled ? "ON" : "OFF"}] ${t.name} (${String(t.cron_hour).padStart(2, "0")}:${String(t.cron_minute).padStart(2, "0")} ${t.days_of_week})\n  ID: ${t.id} | Type: ${t.task_type} | Next: ${t.next_run_at ?? "N/A"}`
    )].join("\n");
  });

  register("schedule_create", "Create a scheduled task", "projectId, name, cronHour, cronMinute?, daysOfWeek?, goalTemplate", async (p) => {
    const body: Record<string, unknown> = {
      projectId: p.projectId,
      name: p.name,
      cronHour: Number(p.cronHour),
      goalTemplate: p.goalTemplate,
    };
    if (p.cronMinute !== undefined) body.cronMinute = Number(p.cronMinute);
    if (p.daysOfWeek) body.daysOfWeek = p.daysOfWeek;
    const result = await h.apiCall("POST", "/api/scheduled-tasks", body);
    if (!result.ok) return `Failed: ${result.error}`;
    const data = result.data as { id: string; nextRun: string };
    return `Created schedule "${p.name}": ${data.id} (next run: ${data.nextRun})`;
  });

  register("schedule_update", "Update a scheduled task", "id, name?, cronHour?, goalTemplate?, enabled?", async (p) => {
    const body: Record<string, unknown> = {};
    if (p.name !== undefined) body.name = p.name;
    if (p.cronHour !== undefined) body.cronHour = Number(p.cronHour);
    if (p.goalTemplate !== undefined) body.goalTemplate = p.goalTemplate;
    if (p.enabled !== undefined) body.enabled = p.enabled === true || p.enabled === "true";
    const result = await h.apiCall("PATCH", `/api/scheduled-tasks/${p.id}`, body);
    if (!result.ok) return `Failed: ${result.error}`;
    return `Updated schedule ${(p.id as string).slice(0, 12)}.`;
  });

  register("schedule_delete", "Delete a scheduled task", "id", async (p) => {
    const result = await h.apiCall("DELETE", `/api/scheduled-tasks/${p.id}`);
    return result.ok ? `Deleted ${(p.id as string).slice(0, 12)}.` : `Failed: ${result.error}`;
  });

  register("schedule_run", "Trigger a scheduled task to run immediately", "id", async (p) => {
    const result = await h.apiCall("POST", `/api/scheduled-tasks/${p.id}/run`);
    return result.ok ? `Triggered ${(p.id as string).slice(0, 12)}.` : `Failed: ${result.error}`;
  });

  return actions;
}

// ── Dispatch ───────────────────────────────────────────

export interface DispatchResult {
  text: string;
}

export function dispatch(actions: Action[], action: string, query?: string, params?: Record<string, unknown>): Promise<DispatchResult> {
  const a = action.trim().toLowerCase();

  // Help / list all actions
  if (!a || a === "help" || a === "list") {
    const lines = [
      "# NoSleep Actions",
      "",
      "Orgs: org_personal, org_wyobi, org_apply",
      "",
      ...actions.map(act => `**${act.name}** \u2014 ${act.description}\n  params: ${act.params}`),
    ];
    return Promise.resolve({ text: lines.join("\n") });
  }

  // Search
  if (a === "search" || a === "find") {
    const q = (query ?? "").toLowerCase();
    if (!q) return Promise.resolve({ text: "Pass query to search." });
    const matches = actions.filter(act => act.name.includes(q) || act.description.toLowerCase().includes(q));
    if (matches.length === 0) return Promise.resolve({ text: `No actions matching "${q}".` });
    const text = matches.map(act => `**${act.name}** \u2014 ${act.description}\n  params: ${act.params}`).join("\n\n");
    return Promise.resolve({ text });
  }

  // Execute
  const handler = actions.find(act => act.name === a);
  if (!handler) {
    // Fuzzy match
    const fuzzy = actions.filter(act => act.name.includes(a) || a.includes(act.name));
    if (fuzzy.length > 0) {
      return Promise.resolve({ text: `Action "${a}" not found. Did you mean:\n${fuzzy.map(f => `  - ${f.name}: ${f.description}`).join("\n")}` });
    }
    return Promise.resolve({ text: `Unknown action "${a}". Call with action="help" to list all.` });
  }

  return handler.handler(params ?? {})
    // Guarantee a string: JSON.stringify(undefined) is undefined (not a
    // string), and a non-string text makes the MCP content block invalid —
    // the caller sees a protocol error instead of the action's result.
    .then(text => ({ text: typeof text === "string" ? text : text === undefined ? "(no data)" : JSON.stringify(text) }))
    .catch(err => ({ text: `Error: ${err instanceof Error ? err.message : String(err)}` }));
}
