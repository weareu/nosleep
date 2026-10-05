import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { StrategyTreeManager } from "../strategy/tree-manager.js";

const dependencySchema = z.object({
  nodeId: z.string(),
  type: z.enum(["FS", "SS", "FF", "SF"]),
});

const createNodeSchema = z.object({
  projectId: z.string(),
  orgId: z.string(),
  parentId: z.string().nullable(),
  type: z.enum(["strategy", "goal", "task", "subtask"]),
  title: z.string().min(1),
  description: z.string().optional(),
  dependencies: z.array(dependencySchema).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  estimatedTokens: z.number().int().min(0).optional(),
  priority: z.boolean().optional(),
});

const createTreeSchema = z.object({
  projectId: z.string(),
  orgId: z.string(),
  tree: z.lazy((): z.ZodType => z.object({
    type: z.enum(["strategy", "goal", "task", "subtask"]),
    title: z.string().min(1),
    description: z.string().optional(),
    dependencies: z.array(dependencySchema).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    weight: z.number().int().min(1).optional(),
    estimatedTokens: z.number().int().min(0).optional(),
    priority: z.boolean().optional(),
    children: z.array(z.lazy((): z.ZodType => createTreeSchema.shape.tree)).optional(),
  })),
});

const updateNodeSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.boolean().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  estimatedTokens: z.number().int().min(0).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["pending", "in_progress", "completed", "blocked", "skipped"]),
});

const setProgressSchema = z.object({
  progressPct: z.number().min(0).max(100),
});

const moveNodeSchema = z.object({
  parentId: z.string().nullable(),
  sortOrder: z.number().optional(),
});

const reorderSchema = z.object({
  parentId: z.string().nullable(),
  orderedIds: z.array(z.string()),
});

const addDepSchema = z.object({
  dependency: dependencySchema,
});

export function registerStrategyRoutes(
  fastify: FastifyInstance,
  _db: Database.Database,
  treeMgr: StrategyTreeManager,
): void {

  // ── Get full tree for a project ─────────────────────────
  fastify.get("/api/strategy/tree/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const tree = treeMgr.getTree(projectId);
    if (!tree) {
      return reply.status(404).send({ success: false, error: "No strategy tree for this project" });
    }
    return { success: true, data: tree };
  });

  // ── Get all trees for an org ────────────────────────────
  fastify.get("/api/strategy/org/:orgId", async (request) => {
    const { orgId } = request.params as { orgId: string };
    const trees = treeMgr.getOrgTrees(orgId);
    return { success: true, data: trees };
  });

  // ── Get a single node ──────────────────────────────────
  fastify.get("/api/strategy/node/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = treeMgr.getNodeWithMetrics(id);
    if (!node) {
      return reply.status(404).send({ success: false, error: "Node not found" });
    }
    const children = treeMgr.getChildrenWithMetrics(id);
    const path = treeMgr.getPath(id);
    return { success: true, data: { node, children, path } };
  });

  // ── Get children of a node ─────────────────────────────
  fastify.get("/api/strategy/node/:id/children", async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: treeMgr.getChildren(id) };
  });

  // ── Get breadcrumb path ────────────────────────────────
  fastify.get("/api/strategy/node/:id/path", async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: treeMgr.getPath(id) };
  });

  // ── Get dependency edges for visualization ─────────────
  fastify.get("/api/strategy/tree/:projectId/edges", async (request) => {
    const { projectId } = request.params as { projectId: string };
    return { success: true, data: treeMgr.getDependencyEdges(projectId) };
  });

  // ── Get next actionable node ───────────────────────────
  fastify.get("/api/strategy/tree/:projectId/next", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const node = treeMgr.getNextActionable(projectId);
    if (!node) {
      return reply.status(404).send({ success: false, error: "No actionable nodes found" });
    }
    return { success: true, data: node };
  });

  // ── Create a single node ───────────────────────────────
  fastify.post("/api/strategy/node", async (request, reply) => {
    const parsed = createNodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    try {
      const node = treeMgr.createNode(parsed.data);
      return reply.status(201).send({ success: true, data: node });
    } catch (err) {
      return reply.status(400).send({ success: false, error: (err as Error).message });
    }
  });

  // ── Create a full tree ─────────────────────────────────
  fastify.post("/api/strategy/tree", async (request, reply) => {
    const parsed = createTreeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    try {
      const rootId = treeMgr.createTree(parsed.data.projectId, parsed.data.orgId, parsed.data.tree);
      const tree = treeMgr.getTree(parsed.data.projectId);
      return reply.status(201).send({ success: true, data: { rootId, tree } });
    } catch (err) {
      return reply.status(400).send({ success: false, error: (err as Error).message });
    }
  });

  // ── Update node content ────────────────────────────────
  fastify.patch("/api/strategy/node/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateNodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    treeMgr.updateNode(id, parsed.data);
    return { success: true, data: treeMgr.getNodeById(id) };
  });

  // ── Update node status ─────────────────────────────────
  fastify.patch("/api/strategy/node/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    try {
      treeMgr.updateStatus(id, parsed.data.status);
      return { success: true, data: treeMgr.getNodeById(id) };
    } catch (err) {
      return reply.status(400).send({ success: false, error: (err as Error).message });
    }
  });

  // ── Set progress ───────────────────────────────────────
  fastify.patch("/api/strategy/node/:id/progress", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = setProgressSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    treeMgr.setProgress(id, parsed.data.progressPct);
    return { success: true, data: treeMgr.getNodeById(id) };
  });

  // ── Move node ──────────────────────────────────────────
  fastify.patch("/api/strategy/node/:id/move", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = moveNodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    try {
      treeMgr.moveNode(id, parsed.data);
      return { success: true, data: treeMgr.getNodeById(id) };
    } catch (err) {
      return reply.status(400).send({ success: false, error: (err as Error).message });
    }
  });

  // ── Reorder siblings ───────────────────────────────────
  fastify.patch("/api/strategy/reorder", async (request, reply) => {
    const parsed = reorderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    treeMgr.reorderSiblings(parsed.data.parentId, parsed.data.orderedIds);
    return { success: true };
  });

  // ── Add dependency ─────────────────────────────────────
  fastify.post("/api/strategy/node/:id/dependency", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = addDepSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    try {
      treeMgr.addDependency(id, parsed.data.dependency);
      return { success: true, data: treeMgr.getNodeById(id) };
    } catch (err) {
      return reply.status(400).send({ success: false, error: (err as Error).message });
    }
  });

  // ── Remove dependency ──────────────────────────────────
  fastify.delete("/api/strategy/node/:id/dependency/:targetId", async (request) => {
    const { id, targetId } = request.params as { id: string; targetId: string };
    treeMgr.removeDependency(id, targetId);
    return { success: true, data: treeMgr.getNodeById(id) };
  });

  // ── Assign session ─────────────────────────────────────
  fastify.patch("/api/strategy/node/:id/assign", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { sessionId } = request.body as { sessionId: string };
    if (!sessionId) {
      return reply.status(400).send({ success: false, error: "sessionId required" });
    }
    treeMgr.assignSession(id, sessionId);
    return { success: true, data: treeMgr.getNodeById(id) };
  });

  // ── Delete node ────────────────────────────────────────
  fastify.delete("/api/strategy/node/:id", async (request) => {
    const { id } = request.params as { id: string };
    treeMgr.deleteNode(id);
    return { success: true };
  });

  // ── Bulk operations ───────────────────────────────────

  // Batch update status
  fastify.post("/api/strategy/batch-update", async (request, reply) => {
    const { nodeIds, status } = request.body as { nodeIds?: string[]; status?: string };
    if (!nodeIds || !Array.isArray(nodeIds) || !status) {
      return reply.status(400).send({ success: false, error: "nodeIds[] and status required" });
    }
    const validStatuses = ["pending", "in_progress", "completed", "blocked", "skipped"];
    if (!validStatuses.includes(status)) {
      return reply.status(400).send({ success: false, error: `Invalid status. Use: ${validStatuses.join(", ")}` });
    }
    let updated = 0;
    for (const id of nodeIds) {
      try { treeMgr.updateStatus(id, status as any); updated++; } catch {}
    }
    return { success: true, data: { updated } };
  });

  // Skip all pending children of a parent
  fastify.post("/api/strategy/node/:id/skip-children", async (request) => {
    const { id } = request.params as { id: string };
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    const result = db.prepare(`
      UPDATE strategy_nodes SET status = 'skipped', progress_pct = 100, updated_at = datetime('now')
      WHERE parent_id = ? AND status = 'pending'
    `).run(id);
    return { success: true, data: { skipped: result.changes } };
  });

  // Delete all children of a parent
  fastify.delete("/api/strategy/node/:id/children", async (request) => {
    const { id } = request.params as { id: string };
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    db.prepare(`DELETE FROM strategy_nodes WHERE parent_id IN (SELECT id FROM strategy_nodes WHERE parent_id = ?)`).run(id);
    const result = db.prepare(`DELETE FROM strategy_nodes WHERE parent_id = ?`).run(id);
    return { success: true, data: { deleted: result.changes } };
  });

  // Phase 22 — full plan-doc fetch for a strategy node. The
  // PlanResolver chain already handles source_ref / vector / keyword
  // resolution for orchestrator goals; this endpoint exposes the same
  // resolution to the dashboard + MCP so clicks on a strategy node can
  // open the full markdown for AI and human view.
  fastify.get("/api/strategy/node/:id/plan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    const row = db.prepare(
      `SELECT sn.id, sn.title, sn.source_ref, sn.project_id, p.path AS project_path, p.name AS project_name
         FROM strategy_nodes sn
         JOIN projects p ON p.id = sn.project_id
        WHERE sn.id = ?`,
    ).get(id) as
      | { id: string; title: string; source_ref: string | null; project_id: string; project_path: string; project_name: string }
      | undefined;
    if (!row) {
      return reply.status(404).send({ success: false, error: "node not found" });
    }

    const { existsSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");

    // 1. Explicit source_ref wins.
    let filePath: string | null = null;
    let lineRef: number | null = null;
    if (row.source_ref) {
      const parts = row.source_ref.split(":");
      filePath = parts[0];
      if (parts[1]?.startsWith("L")) {
        const n = parseInt(parts[1].slice(1), 10);
        if (Number.isFinite(n)) lineRef = n;
      }
    } else {
      // 2. FTS plan-index search (lightweight — beat the full PlanResolver
      // path for the read-only viewer; the orchestrator uses the heavier
      // vector+keyword fallback when launching a session).
      try {
        const hit = db.prepare(
          `SELECT file_path, line_number FROM plan_index
            WHERE project_id = ? AND plan_index MATCH ?
            ORDER BY rank
            LIMIT 1`,
        ).get(row.project_id, row.title) as { file_path: string; line_number: number } | undefined;
        if (hit) {
          filePath = hit.file_path;
          lineRef = hit.line_number;
          // Side-effect: cache the discovered ref on the node so next
          // time we don't have to FTS-search again.
          db.prepare(`UPDATE strategy_nodes SET source_ref = ? WHERE id = ?`)
            .run(`${hit.file_path}:L${hit.line_number}`, row.id);
        }
      } catch {
        // FTS may fail on unusual titles — non-fatal
      }
    }

    if (!filePath) {
      return reply.send({
        success: true,
        data: {
          nodeId: row.id,
          nodeTitle: row.title,
          projectName: row.project_name,
          filePath: null,
          lineNumber: null,
          content: null,
          missing: true,
          message: "No plan document linked to this node yet — set source_ref or run plan indexer.",
        },
      });
    }

    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(row.project_path, filePath);

    if (!existsSync(resolved)) {
      return reply.send({
        success: true,
        data: {
          nodeId: row.id,
          nodeTitle: row.title,
          projectName: row.project_name,
          filePath,
          lineNumber: lineRef,
          content: null,
          missing: true,
          message: `Source ref points to ${filePath} but the file is missing on disk.`,
        },
      });
    }

    const content = readFileSync(resolved, "utf-8");
    return reply.send({
      success: true,
      data: {
        nodeId: row.id,
        nodeTitle: row.title,
        projectName: row.project_name,
        filePath,
        lineNumber: lineRef,
        content,
        missing: false,
      },
    });
  });

  // Phase 22-C — cross-tree strategy ref-links.

  // List refs touching a node (both directions).
  fastify.get("/api/strategy/node/:id/refs", async (request) => {
    const { id } = request.params as { id: string };
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    const outgoing = db.prepare(`
      SELECT r.id, r.from_id, r.to_id, r.kind, r.weight, r.note, r.created_at,
             n.title AS to_title, n.status AS to_status, n.type AS to_type,
             p.name AS to_project_name
        FROM strategy_node_refs r
        JOIN strategy_nodes n ON n.id = r.to_id
        JOIN projects p ON p.id = n.project_id
       WHERE r.from_id = ?
       ORDER BY r.created_at DESC
    `).all(id);
    const incoming = db.prepare(`
      SELECT r.id, r.from_id, r.to_id, r.kind, r.weight, r.note, r.created_at,
             n.title AS from_title, n.status AS from_status, n.type AS from_type,
             p.name AS from_project_name
        FROM strategy_node_refs r
        JOIN strategy_nodes n ON n.id = r.from_id
        JOIN projects p ON p.id = n.project_id
       WHERE r.to_id = ?
       ORDER BY r.created_at DESC
    `).all(id);
    return { success: true, data: { outgoing, incoming } };
  });

  // Create a ref. Idempotent — UNIQUE(from_id, to_id, kind) prevents dupes.
  fastify.post("/api/strategy/refs", async (request, reply) => {
    const body = request.body as {
      fromId?: string;
      toId?: string;
      kind?: "related" | "informs" | "supersedes" | "references";
      weight?: number;
      note?: string;
    };
    if (!body.fromId || !body.toId || !body.kind) {
      return reply.status(400).send({ success: false, error: "fromId, toId, kind required" });
    }
    if (body.fromId === body.toId) {
      return reply.status(400).send({ success: false, error: "self-link not allowed" });
    }
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    // Both nodes must exist.
    const found = db.prepare(
      `SELECT id FROM strategy_nodes WHERE id IN (?, ?)`,
    ).all(body.fromId, body.toId) as Array<{ id: string }>;
    if (found.length !== 2) {
      return reply.status(404).send({ success: false, error: "from/to node not found" });
    }
    const id = `snref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      db.prepare(`
        INSERT INTO strategy_node_refs (id, from_id, to_id, kind, weight, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, body.fromId, body.toId, body.kind, body.weight ?? 1.0, body.note ?? null);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return reply.status(409).send({ success: false, error: "ref already exists" });
      }
      throw err;
    }
    return reply.status(201).send({ success: true, data: { id, fromId: body.fromId, toId: body.toId, kind: body.kind } });
  });

  // Delete a ref.
  fastify.delete("/api/strategy/refs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    const result = db.prepare(`DELETE FROM strategy_node_refs WHERE id = ?`).run(id);
    if (result.changes === 0) {
      return reply.status(404).send({ success: false, error: "ref not found" });
    }
    return { success: true };
  });

  // Strategy graph view payload. Like brain graph but for strategy nodes
  // — includes parent/child + dependency + ref edges, scoped by project
  // or org. Bounded by limit so the response stays manageable.
  fastify.get("/api/strategy/graph", async (request) => {
    const { projectId, orgId, limit } = request.query as {
      projectId?: string;
      orgId?: string;
      limit?: string;
    };
    const db = treeMgr["db"] as import("better-sqlite3").Database;
    const cap = Math.min(2000, Math.max(50, parseInt(limit ?? "500", 10) || 500));
    const conds: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      conds.push("sn.project_id = ?");
      params.push(projectId);
    } else if (orgId) {
      conds.push("sn.org_id = ?");
      params.push(orgId);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const nodes = db.prepare(`
      SELECT sn.id, sn.parent_id, sn.title, sn.type, sn.status, sn.progress_pct,
             sn.depth, sn.project_id, sn.org_id, sn.dependencies, sn.priority,
             p.name AS project_name
        FROM strategy_nodes sn
        JOIN projects p ON p.id = sn.project_id
        ${where}
        ORDER BY sn.depth, sn.sort_order
        LIMIT ?
    `).all(...params, cap) as Array<{
      id: string;
      parent_id: string | null;
      title: string;
      type: string;
      status: string;
      progress_pct: number;
      depth: number;
      project_id: string;
      org_id: string;
      dependencies: string;
      priority: number | null;
      project_name: string;
    }>;
    const nodeIds = new Set(nodes.map((n) => n.id));

    // Edges: parent-child, dependency, ref.
    const edges: Array<{
      from: string;
      to: string;
      kind: "parent" | "dependency" | "ref";
      relation?: string;
      weight: number;
    }> = [];

    for (const n of nodes) {
      if (n.parent_id && nodeIds.has(n.parent_id)) {
        edges.push({ from: n.parent_id, to: n.id, kind: "parent", weight: 1.0 });
      }
      try {
        const deps = JSON.parse(n.dependencies) as Array<{ nodeId: string; type: string }>;
        for (const d of deps) {
          if (nodeIds.has(d.nodeId)) {
            edges.push({
              from: d.nodeId,
              to: n.id,
              kind: "dependency",
              relation: d.type,
              weight: 0.9,
            });
          }
        }
      } catch {
        // dependencies field may be empty / malformed
      }
    }

    // Refs (cross-tree). Only edges where BOTH endpoints are in the
    // returned node set — but include all matching refs.
    if (nodeIds.size > 0) {
      const placeholders = [...nodeIds].map(() => "?").join(",");
      const refs = db.prepare(`
        SELECT from_id, to_id, kind, weight FROM strategy_node_refs
         WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
      `).all(...nodeIds, ...nodeIds) as Array<{
        from_id: string;
        to_id: string;
        kind: string;
        weight: number;
      }>;
      for (const r of refs) {
        edges.push({
          from: r.from_id,
          to: r.to_id,
          kind: "ref",
          relation: r.kind,
          weight: r.weight,
        });
      }
    }

    return {
      success: true,
      data: {
        nodes: nodes.map((n) => ({
          id: n.id,
          parent_id: n.parent_id,
          title: n.title,
          type: n.type,
          status: n.status,
          progress_pct: n.progress_pct,
          project_id: n.project_id,
          project_name: n.project_name,
          org_id: n.org_id,
          depth: n.depth,
          priority: n.priority,
        })),
        edges,
        truncated: nodes.length >= cap,
      },
    };
  });
}
