import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  StrategyNode,
  StrategyNodeWithMetrics,
  StrategyNodeType,
  StrategyNodeStatus,
  StrategyTree,
  NodeDependency,
  DependencyType,
} from "@nosleep/shared";
import { eventBus } from "../event-bus.js";

interface CreateNodeParams {
  readonly projectId: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly type: StrategyNodeType;
  readonly title: string;
  readonly description?: string;
  readonly dependencies?: readonly NodeDependency[];
  readonly acceptanceCriteria?: readonly string[];
  readonly weight?: number;
  readonly estimatedTokens?: number;
  readonly priority?: boolean;
}

interface MoveNodeParams {
  readonly parentId: string | null;
  readonly sortOrder?: number;
}

interface StrategyNodeRow {
  id: string;
  project_id: string;
  org_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  description: string;
  status: string;
  progress_pct: number;
  depth: number;
  sort_order: number;
  assigned_session_id: string | null;
  dependencies: string;
  acceptance_criteria: string;
  weight: number;
  estimated_tokens: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

export class StrategyTreeManager {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── CRUD ──────────────────────────────────────────────

  /**
   * Create a node at any depth. Unlimited nesting.
   */
  createNode(params: CreateNodeParams): StrategyNode {
    const id = nanoid();
    let depth = 0;

    if (params.parentId) {
      const parent = this.getNodeById(params.parentId);
      if (!parent) throw new Error(`Parent node ${params.parentId} not found`);
      if (parent.orgId !== params.orgId) throw new Error("Cannot create node across org boundary");
      depth = parent.depth + 1;
    }

    const maxSort = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort
      FROM strategy_nodes
      WHERE parent_id IS ? AND project_id = ?
    `).get(params.parentId ?? null, params.projectId) as { next_sort: number };

    this.db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, description, depth, sort_order, dependencies, acceptance_criteria, weight, estimated_tokens, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.projectId, params.orgId, params.parentId ?? null,
      params.type, params.title, params.description ?? "",
      depth, maxSort.next_sort,
      JSON.stringify(params.dependencies ?? []),
      JSON.stringify(params.acceptanceCriteria ?? []),
      params.weight ?? 1,
      params.estimatedTokens ?? 0,
      params.priority ? 1 : 3,
    );

    return this.getNodeById(id)!;
  }

  /**
   * Create a full subtree from a nested structure. Unlimited depth.
   */
  createTree(
    projectId: string,
    orgId: string,
    tree: StrategyTreeInput,
    parentId: string | null = null,
  ): string {
    const node = this.createNode({
      projectId,
      orgId,
      parentId,
      type: tree.type,
      title: tree.title,
      description: tree.description,
      dependencies: tree.dependencies,
      acceptanceCriteria: tree.acceptanceCriteria,
      weight: tree.weight,
      estimatedTokens: tree.estimatedTokens,
      priority: tree.priority,
    });

    if (tree.children) {
      for (const child of tree.children) {
        this.createTree(projectId, orgId, child, node.id);
      }
    }

    return node.id;
  }

  /**
   * Add a dependency between two nodes.
   */
  addDependency(nodeId: string, dependency: NodeDependency): void {
    const node = this.getNodeById(nodeId);
    if (!node) throw new Error("Node not found");

    const target = this.getNodeById(dependency.nodeId);
    if (!target) throw new Error("Dependency target not found");
    if (target.orgId !== node.orgId) throw new Error("Cannot create cross-org dependency");

    // Check for circular dependencies
    if (this.wouldCreateCycle(nodeId, dependency.nodeId)) {
      throw new Error("Circular dependency detected");
    }

    const deps = [...node.dependencies, dependency];
    this.db.prepare(`
      UPDATE strategy_nodes SET dependencies = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(deps), nodeId);
  }

  /**
   * Remove a dependency from a node.
   */
  removeDependency(nodeId: string, targetNodeId: string): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;

    const deps = node.dependencies.filter((d) => d.nodeId !== targetNodeId);
    this.db.prepare(`
      UPDATE strategy_nodes SET dependencies = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(deps), nodeId);
  }

  /**
   * Update a node's status. Validates dependency constraints first.
   * Propagates progress up the tree.
   */
  updateStatus(nodeId: string, status: StrategyNodeStatus): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;

    // Validate dependency constraints
    this.validateConstraints(node, status);

    const progressPct = status === "completed" ? 100
      : status === "skipped" ? 100
      : node.progressPct;

    this.db.prepare(`
      UPDATE strategy_nodes
      SET status = ?, progress_pct = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, progressPct, nodeId);

    this.propagateProgress(node.parentId);
  }

  /**
   * Directly set progress on a node (0-100).
   */
  setProgress(nodeId: string, progressPct: number): void {
    this.db.prepare(`
      UPDATE strategy_nodes
      SET progress_pct = ?,
          status = CASE
            WHEN ? >= 100 THEN 'completed'
            WHEN ? > 0 THEN 'in_progress'
            ELSE status
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(progressPct, progressPct, progressPct, nodeId);

    const node = this.getNodeById(nodeId);
    if (node) this.propagateProgress(node.parentId);
  }

  /**
   * Assign a session to work on a node.
   */
  assignSession(nodeId: string, sessionId: string): void {
    this.db.prepare(`
      UPDATE strategy_nodes
      SET assigned_session_id = ?, status = 'in_progress', updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId, nodeId);

    const node = this.getNodeById(nodeId);
    if (node) this.propagateProgress(node.parentId);
  }

  /**
   * Update node title/description.
   */
  updateNode(nodeId: string, updates: {
    title?: string;
    description?: string;
    priority?: boolean;
    acceptanceCriteria?: readonly string[];
    weight?: number;
    estimatedTokens?: number;
  }): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) { sets.push("title = ?"); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }
    if (updates.priority !== undefined) { sets.push("priority = ?"); params.push(updates.priority ? 1 : 0); }
    if (updates.acceptanceCriteria !== undefined) { sets.push("acceptance_criteria = ?"); params.push(JSON.stringify(updates.acceptanceCriteria)); }
    if (updates.weight !== undefined) { sets.push("weight = ?"); params.push(updates.weight); }
    if (updates.estimatedTokens !== undefined) { sets.push("estimated_tokens = ?"); params.push(updates.estimatedTokens); }

    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(nodeId);

    this.db.prepare(`UPDATE strategy_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /**
   * Move a node to a new parent. Updates depths recursively.
   */
  moveNode(nodeId: string, params: MoveNodeParams): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;

    let newDepth = 0;
    if (params.parentId) {
      const newParent = this.getNodeById(params.parentId);
      if (!newParent) throw new Error("Target parent not found");
      if (newParent.orgId !== node.orgId) throw new Error("Cannot move across org boundary");
      newDepth = newParent.depth + 1;
    }

    this.db.prepare(`
      UPDATE strategy_nodes
      SET parent_id = ?, depth = ?, sort_order = COALESCE(?, sort_order), updated_at = datetime('now')
      WHERE id = ?
    `).run(params.parentId ?? null, newDepth, params.sortOrder ?? null, nodeId);

    this.updateDescendantDepths(nodeId, newDepth);
    this.propagateProgress(node.parentId);
    this.propagateProgress(params.parentId ?? null);
  }

  /**
   * Reorder siblings.
   */
  reorderSiblings(parentId: string | null, orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE strategy_nodes SET sort_order = ? WHERE id = ? AND parent_id IS ?`);
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i, orderedIds[i], parentId ?? null);
    }
  }

  /**
   * Delete a node and all descendants.
   */
  deleteNode(nodeId: string): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;

    const descendants = this.getDescendantIds(nodeId);
    const allIds = [...descendants, nodeId];

    // Remove any dependencies pointing to deleted nodes
    const allNodes = this.db.prepare(`
      SELECT id, dependencies FROM strategy_nodes WHERE project_id = ?
    `).all(node.projectId) as Array<{ id: string; dependencies: string }>;

    for (const n of allNodes) {
      if (allIds.includes(n.id)) continue;
      const deps = JSON.parse(n.dependencies) as NodeDependency[];
      const filtered = deps.filter((d) => !allIds.includes(d.nodeId));
      if (filtered.length !== deps.length) {
        this.db.prepare(`UPDATE strategy_nodes SET dependencies = ? WHERE id = ?`)
          .run(JSON.stringify(filtered), n.id);
      }
    }

    for (const id of [...descendants.reverse(), nodeId]) {
      this.db.prepare(`DELETE FROM strategy_nodes WHERE id = ?`).run(id);
    }

    this.propagateProgress(node.parentId);
  }

  // ── Queries ───────────────────────────────────────────

  getNodeById(id: string): StrategyNode | null {
    const row = this.db.prepare(`SELECT * FROM strategy_nodes WHERE id = ?`)
      .get(id) as StrategyNodeRow | undefined;
    return row ? this.rowToNode(row) : null;
  }

  /**
   * Get the full tree for a project with metrics at every level.
   */
  getTree(projectId: string): StrategyTree | null {
    const allRows = this.db.prepare(`
      SELECT * FROM strategy_nodes WHERE project_id = ? ORDER BY COALESCE(priority, 3), depth, sort_order
    `).all(projectId) as StrategyNodeRow[];

    if (allRows.length === 0) return null;

    const nodes = allRows.map((r) => this.rowToNode(r));
    const enriched = this.computeMetrics(nodes);

    const root = enriched.find((n) => n.parentId === null);
    if (!root) return null;

    const totalLeaves = enriched.filter((n) => this.isLeaf(n.id, enriched)).length;
    const completedLeaves = enriched.filter(
      (n) => this.isLeaf(n.id, enriched) && (n.status === "completed" || n.status === "skipped"),
    ).length;

    return {
      root,
      nodes: enriched,
      totalNodes: enriched.length,
      totalLeaves,
      completedLeaves,
      overallProgressPct: totalLeaves > 0 ? Math.round((completedLeaves / totalLeaves) * 100) : 0,
    };
  }

  getChildren(nodeId: string): readonly StrategyNode[] {
    const rows = this.db.prepare(`
      SELECT * FROM strategy_nodes WHERE parent_id = ? ORDER BY sort_order
    `).all(nodeId) as StrategyNodeRow[];
    return rows.map((r) => this.rowToNode(r));
  }

  /**
   * Get a node with computed metrics (uses full project tree for calculation).
   */
  getNodeWithMetrics(id: string): StrategyNodeWithMetrics | null {
    const node = this.getNodeById(id);
    if (!node) return null;
    const tree = this.getTree(node.projectId);
    if (!tree) return null;
    return tree.nodes.find((n) => n.id === id) ?? null;
  }

  /**
   * Get children with computed metrics.
   */
  getChildrenWithMetrics(nodeId: string): readonly StrategyNodeWithMetrics[] {
    const node = this.getNodeById(nodeId);
    if (!node) return [];
    const tree = this.getTree(node.projectId);
    if (!tree) return [];
    return tree.nodes.filter((n) => n.parentId === nodeId);
  }

  /**
   * Breadcrumb path from root to node.
   */
  getPath(nodeId: string): readonly StrategyNode[] {
    const path: StrategyNode[] = [];
    let current = this.getNodeById(nodeId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.getNodeById(current.parentId) : null;
    }
    return path;
  }

  getOrgTrees(orgId: string): readonly StrategyTree[] {
    const projectIds = this.db.prepare(`
      SELECT DISTINCT project_id FROM strategy_nodes WHERE org_id = ? AND parent_id IS NULL
    `).all(orgId) as Array<{ project_id: string }>;

    return projectIds
      .map((r) => this.getTree(r.project_id))
      .filter((t): t is StrategyTree => t !== null);
  }

  /**
   * Find the next actionable leaf: pending, all dependency constraints satisfied.
   */
  getNextActionable(projectId: string, scopeIds?: ReadonlySet<string>): StrategyNode | null {
    const allNodes = this.db.prepare(`
      SELECT * FROM strategy_nodes WHERE project_id = ? ORDER BY COALESCE(priority, 3), depth, sort_order
    `).all(projectId) as StrategyNodeRow[];

    const nodes = allNodes.map((r) => this.rowToNode(r));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Skip children of skipped/completed ancestors
    const skipIds = new Set(nodes.filter(n => n.status === "skipped" || n.status === "completed").map(n => n.id));

    for (const node of nodes) {
      // Optional scope (e.g. a loop linked to one branch's subtree).
      if (scopeIds && !scopeIds.has(node.id)) continue;
      if (node.status !== "pending") continue;
      if (!this.isLeaf(node.id, nodes)) continue;

      // Check if any ancestor is skipped/completed
      let ancestorSkipped = false;
      let cur = node.parentId;
      while (cur) {
        if (skipIds.has(cur)) { ancestorSkipped = true; break; }
        cur = nodeMap.get(cur)?.parentId ?? null;
      }
      if (ancestorSkipped) continue;

      const canStart = this.checkDependenciesForStatus(node, "in_progress", nodeMap);
      if (canStart) return node;
    }

    return null;
  }

  /**
   * Get all dependency edges for visualization (Gantt/graph view).
   */
  getDependencyEdges(projectId: string): readonly DependencyEdge[] {
    const allRows = this.db.prepare(`
      SELECT id, title, dependencies FROM strategy_nodes WHERE project_id = ?
    `).all(projectId) as Array<{ id: string; title: string; dependencies: string }>;

    const edges: DependencyEdge[] = [];
    for (const row of allRows) {
      const deps = JSON.parse(row.dependencies) as NodeDependency[];
      for (const dep of deps) {
        const source = allRows.find((r) => r.id === dep.nodeId);
        edges.push({
          fromId: dep.nodeId,
          fromTitle: source?.title ?? "?",
          toId: row.id,
          toTitle: row.title,
          type: dep.type,
        });
      }
    }
    return edges;
  }

  // ── Dependency Constraint Validation ──────────────────

  /**
   * Validate all dependency constraints before allowing a status change.
   *
   * FS (Finish-Start): predecessor must be completed/skipped before this can start
   * SS (Start-Start): predecessor must be in_progress/completed before this can start
   * FF (Finish-Finish): predecessor must be completed/skipped before this can complete
   * SF (Start-Finish): predecessor must be in_progress/completed before this can complete
   */
  private validateConstraints(
    node: StrategyNode,
    targetStatus: StrategyNodeStatus,
  ): void {
    if (targetStatus === "pending" || targetStatus === "skipped" || targetStatus === "blocked") return;

    const isStarting = targetStatus === "in_progress";
    const isFinishing = targetStatus === "completed";

    for (const dep of node.dependencies) {
      const predecessor = this.getNodeById(dep.nodeId);
      if (!predecessor) continue;

      switch (dep.type) {
        case "FS": // Finish-Start: predecessor must finish before this starts
          if (isStarting && !this.isFinished(predecessor.status)) {
            throw new Error(
              `FS constraint: "${predecessor.title}" must finish before "${node.title}" can start`
            );
          }
          break;

        case "SS": // Start-Start: predecessor must start before this starts
          if (isStarting && !this.isStarted(predecessor.status)) {
            throw new Error(
              `SS constraint: "${predecessor.title}" must start before "${node.title}" can start`
            );
          }
          break;

        case "FF": // Finish-Finish: predecessor must finish before this finishes
          if (isFinishing && !this.isFinished(predecessor.status)) {
            throw new Error(
              `FF constraint: "${predecessor.title}" must finish before "${node.title}" can finish`
            );
          }
          break;

        case "SF": // Start-Finish: predecessor must start before this finishes
          if (isFinishing && !this.isStarted(predecessor.status)) {
            throw new Error(
              `SF constraint: "${predecessor.title}" must start before "${node.title}" can finish`
            );
          }
          break;
      }
    }
  }

  /**
   * Check if a node's dependencies allow a given target status.
   * Used by getNextActionable to find nodes that CAN start.
   */
  private checkDependenciesForStatus(
    node: StrategyNode,
    targetStatus: StrategyNodeStatus,
    nodeMap: Map<string, StrategyNode>,
  ): boolean {
    for (const dep of node.dependencies) {
      const predecessor = nodeMap.get(dep.nodeId);
      if (!predecessor) continue;

      if (targetStatus === "in_progress") {
        if (dep.type === "FS" && !this.isFinished(predecessor.status)) return false;
        if (dep.type === "SS" && !this.isStarted(predecessor.status)) return false;
      }
    }
    return true;
  }

  private isFinished(status: StrategyNodeStatus): boolean {
    return status === "completed" || status === "skipped";
  }

  private isStarted(status: StrategyNodeStatus): boolean {
    return status === "in_progress" || status === "completed" || status === "skipped";
  }

  private wouldCreateCycle(nodeId: string, targetId: string): boolean {
    // Check if targetId is an ancestor of nodeId (which would create a cycle)
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = this.getNodeById(current);
      if (!node) continue;

      for (const dep of node.dependencies) {
        queue.push(dep.nodeId);
      }
    }

    return false;
  }

  // ── Progress propagation ──────────────────────────────

  private propagateProgress(parentId: string | null): void {
    if (!parentId) return;

    const children = this.db.prepare(`
      SELECT status, progress_pct, weight FROM strategy_nodes WHERE parent_id = ?
    `).all(parentId) as Array<{ status: string; progress_pct: number; weight: number }>;

    if (children.length === 0) return;

    // Weight-based progress: each child's contribution is proportional to its weight
    const totalWeight = children.reduce((sum, c) => sum + (c.weight || 1), 0);
    const weightedProgress = children.reduce(
      (sum, c) => sum + c.progress_pct * (c.weight || 1),
      0,
    );
    const avgProgress = totalWeight > 0 ? Math.round(weightedProgress / totalWeight) : 0;

    const allDone = children.every((c) => c.status === "completed" || c.status === "skipped");
    const anyActive = children.some((c) => c.status === "in_progress");

    let status: StrategyNodeStatus;
    if (allDone) status = "completed";
    else if (anyActive || avgProgress > 0) status = "in_progress";
    else status = "pending";

    this.db.prepare(`
      UPDATE strategy_nodes
      SET progress_pct = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(avgProgress, status, parentId);

    const parent = this.getNodeById(parentId);
    if (parent?.parentId) {
      this.propagateProgress(parent.parentId);
    }
  }

  // ── Metrics computation ───────────────────────────────

  private computeMetrics(nodes: readonly StrategyNode[]): StrategyNodeWithMetrics[] {
    const childrenMap = new Map<string | null, StrategyNode[]>();
    for (const node of nodes) {
      const siblings = childrenMap.get(node.parentId) ?? [];
      siblings.push(node);
      childrenMap.set(node.parentId, siblings);
    }

    // Memoize so each node is computed exactly once (bottom-up via recursion + cache)
    const cache = new Map<string, StrategyNodeWithMetrics>();

    const computeForNode = (node: StrategyNode): StrategyNodeWithMetrics => {
      const cached = cache.get(node.id);
      if (cached) return cached;

      const children = childrenMap.get(node.id) ?? [];

      if (children.length === 0) {
        const result: StrategyNodeWithMetrics = {
          ...node,
          totalLeaves: 1,
          completedLeaves: this.isFinished(node.status as StrategyNodeStatus) ? 1 : 0,
          activeLeaves: node.status === "in_progress" ? 1 : 0,
          blockedLeaves: node.status === "blocked" ? 1 : 0,
          maxDepthBelow: 0,
          computedProgressPct: node.progressPct,
        };
        cache.set(node.id, result);
        return result;
      }

      const childMetrics = children.map((c) => computeForNode(c));
      const totalLeaves = childMetrics.reduce((s, m) => s + m.totalLeaves, 0);
      const completedLeaves = childMetrics.reduce((s, m) => s + m.completedLeaves, 0);
      const activeLeaves = childMetrics.reduce((s, m) => s + m.activeLeaves, 0);
      const blockedLeaves = childMetrics.reduce((s, m) => s + m.blockedLeaves, 0);
      const maxDepthBelow = Math.max(...childMetrics.map((m) => m.maxDepthBelow)) + 1;

      // Weight-based progress: use child weights for proportional calculation
      const totalWeight = children.reduce((s, c) => s + (c.weight || 1), 0);
      const weightedCompleted = childMetrics.reduce(
        (s, m, i) => s + (m.computedProgressPct * (children[i].weight || 1)),
        0,
      );
      const computedProgressPct = totalWeight > 0
        ? Math.round(weightedCompleted / totalWeight)
        : 0;

      const result: StrategyNodeWithMetrics = {
        ...node,
        totalLeaves,
        completedLeaves,
        activeLeaves,
        blockedLeaves,
        maxDepthBelow,
        computedProgressPct,
      };
      cache.set(node.id, result);
      return result;
    };

    return nodes.map((n) => computeForNode(n));
  }

  private isLeaf(nodeId: string, nodes: readonly StrategyNode[]): boolean {
    return !nodes.some((n) => n.parentId === nodeId);
  }

  private getDescendantIds(nodeId: string): string[] {
    const children = this.db.prepare(`
      SELECT id FROM strategy_nodes WHERE parent_id = ?
    `).all(nodeId) as Array<{ id: string }>;

    const ids: string[] = [];
    for (const child of children) {
      ids.push(child.id);
      ids.push(...this.getDescendantIds(child.id));
    }
    return ids;
  }

  private updateDescendantDepths(parentId: string, parentDepth: number): void {
    const children = this.db.prepare(`
      SELECT id FROM strategy_nodes WHERE parent_id = ?
    `).all(parentId) as Array<{ id: string }>;

    for (const child of children) {
      const childDepth = parentDepth + 1;
      this.db.prepare(`UPDATE strategy_nodes SET depth = ? WHERE id = ?`)
        .run(childDepth, child.id);
      this.updateDescendantDepths(child.id, childDepth);
    }
  }

  private rowToNode(row: StrategyNodeRow): StrategyNode {
    let dependencies: readonly NodeDependency[];
    try {
      dependencies = JSON.parse(row.dependencies) as NodeDependency[];
    } catch {
      dependencies = [];
    }

    let acceptanceCriteria: readonly string[];
    try {
      acceptanceCriteria = JSON.parse(row.acceptance_criteria ?? "[]") as string[];
    } catch {
      acceptanceCriteria = [];
    }

    return {
      id: row.id,
      projectId: row.project_id,
      orgId: row.org_id,
      parentId: row.parent_id,
      type: row.type as StrategyNodeType,
      title: row.title,
      description: row.description,
      status: row.status as StrategyNodeStatus,
      progressPct: row.progress_pct,
      depth: row.depth,
      sortOrder: row.sort_order,
      assignedSessionId: row.assigned_session_id,
      dependencies,
      acceptanceCriteria,
      weight: row.weight ?? 1,
      estimatedTokens: row.estimated_tokens ?? 0,
      priority: row.priority === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/** Input format for creating a tree in one call */
export interface StrategyTreeInput {
  readonly type: StrategyNodeType;
  readonly title: string;
  readonly description?: string;
  readonly dependencies?: readonly NodeDependency[];
  readonly acceptanceCriteria?: readonly string[];
  readonly weight?: number;
  readonly estimatedTokens?: number;
  readonly priority?: boolean;
  readonly children?: readonly StrategyTreeInput[];
}

/** Dependency edge for visualization */
export interface DependencyEdge {
  readonly fromId: string;
  readonly fromTitle: string;
  readonly toId: string;
  readonly toTitle: string;
  readonly type: DependencyType;
}
