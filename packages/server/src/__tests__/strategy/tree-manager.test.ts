import { describe, it, expect, beforeEach } from "vitest";
import { StrategyTreeManager } from "../../strategy/tree-manager.js";
import { createTestDb, seedTestData, seedMultiOrg } from "../helpers/db.js";
import type Database from "better-sqlite3";

describe("StrategyTreeManager", () => {
  let db: Database.Database;
  let manager: StrategyTreeManager;
  let orgId: string;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    const seed = seedTestData(db);
    orgId = seed.orgId;
    projectId = seed.projectId;
    manager = new StrategyTreeManager(db);
  });

  describe("createNode", () => {
    it("creates a root node with depth 0 when no parent", () => {
      const node = manager.createNode({
        projectId,
        orgId,
        parentId: null,
        type: "strategy",
        title: "Root Strategy",
      });

      expect(node).toBeDefined();
      expect(node.depth).toBe(0);
      expect(node.parentId).toBeNull();
      expect(node.type).toBe("strategy");
      expect(node.title).toBe("Root Strategy");
      expect(node.status).toBe("pending");
      expect(node.progressPct).toBe(0);
    });

    it("creates a child node with parent depth + 1", () => {
      const root = manager.createNode({
        projectId,
        orgId,
        parentId: null,
        type: "strategy",
        title: "Root",
      });

      const child = manager.createNode({
        projectId,
        orgId,
        parentId: root.id,
        type: "goal",
        title: "Child Goal",
      });

      expect(child.depth).toBe(1);
      expect(child.parentId).toBe(root.id);

      const grandchild = manager.createNode({
        projectId,
        orgId,
        parentId: child.id,
        type: "task",
        title: "Grandchild Task",
      });

      expect(grandchild.depth).toBe(2);
    });

    it("throws when parent node does not exist", () => {
      expect(() => {
        manager.createNode({
          projectId,
          orgId,
          parentId: "nonexistent",
          type: "goal",
          title: "Orphan",
        });
      }).toThrow(/Parent node nonexistent not found/);
    });

    it("auto-increments sort_order among siblings", () => {
      const root = manager.createNode({
        projectId,
        orgId,
        parentId: null,
        type: "strategy",
        title: "Root",
      });

      const c1 = manager.createNode({ projectId, orgId, parentId: root.id, type: "goal", title: "First" });
      const c2 = manager.createNode({ projectId, orgId, parentId: root.id, type: "goal", title: "Second" });
      const c3 = manager.createNode({ projectId, orgId, parentId: root.id, type: "goal", title: "Third" });

      expect(c1.sortOrder).toBe(0);
      expect(c2.sortOrder).toBe(1);
      expect(c3.sortOrder).toBe(2);
    });
  });

  describe("updateStatus", () => {
    it("sets progress to 100 when status is completed", () => {
      const root = manager.createNode({
        projectId,
        orgId,
        parentId: null,
        type: "strategy",
        title: "Root",
      });

      const child = manager.createNode({
        projectId,
        orgId,
        parentId: root.id,
        type: "task",
        title: "Task",
      });

      manager.updateStatus(child.id, "completed");

      const updated = manager.getNodeById(child.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.progressPct).toBe(100);
    });

    it("propagates progress to parent when child completes", () => {
      const root = manager.createNode({ projectId, orgId, parentId: null, type: "strategy", title: "Root" });
      const c1 = manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "Task 1" });
      const c2 = manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "Task 2" });

      manager.updateStatus(c1.id, "completed");

      const rootAfter = manager.getNodeById(root.id);
      expect(rootAfter!.progressPct).toBe(50);
      expect(rootAfter!.status).toBe("in_progress");

      manager.updateStatus(c2.id, "completed");

      const rootDone = manager.getNodeById(root.id);
      expect(rootDone!.progressPct).toBe(100);
      expect(rootDone!.status).toBe("completed");
    });

    it("sets progress to 100 when status is skipped", () => {
      const node = manager.createNode({ projectId, orgId, parentId: null, type: "task", title: "Skip me" });
      manager.updateStatus(node.id, "skipped");

      const updated = manager.getNodeById(node.id);
      expect(updated!.status).toBe("skipped");
      expect(updated!.progressPct).toBe(100);
    });
  });

  describe("setProgress", () => {
    it("auto-transitions to in_progress when progress > 0", () => {
      const node = manager.createNode({ projectId, orgId, parentId: null, type: "task", title: "WIP" });
      expect(node.status).toBe("pending");

      manager.setProgress(node.id, 50);

      const updated = manager.getNodeById(node.id);
      expect(updated!.progressPct).toBe(50);
      expect(updated!.status).toBe("in_progress");
    });

    it("auto-transitions to completed when progress reaches 100", () => {
      const node = manager.createNode({ projectId, orgId, parentId: null, type: "task", title: "Done" });

      manager.setProgress(node.id, 100);

      const updated = manager.getNodeById(node.id);
      expect(updated!.progressPct).toBe(100);
      expect(updated!.status).toBe("completed");
    });

    it("propagates progress upward through the tree", () => {
      const root = manager.createNode({ projectId, orgId, parentId: null, type: "strategy", title: "Root" });
      const child = manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "Task" });

      manager.setProgress(child.id, 60);

      const rootAfter = manager.getNodeById(root.id);
      expect(rootAfter!.progressPct).toBe(60);
    });
  });

  describe("getNextActionable", () => {
    it("returns a pending leaf node with no deps", () => {
      const root = manager.createNode({ projectId, orgId, parentId: null, type: "strategy", title: "Root" });
      const t1 = manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "Task 1" });
      manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "Task 2" });

      const next = manager.getNextActionable(projectId);
      expect(next).toBeDefined();
      expect(next!.id).toBe(t1.id);
    });

    it("returns null when all leaves are completed", () => {
      const root = manager.createNode({ projectId, orgId, parentId: null, type: "strategy", title: "Root" });
      const t1 = manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "Task" });

      manager.updateStatus(t1.id, "completed");

      const next = manager.getNextActionable(projectId);
      expect(next).toBeNull();
    });

    it("skips nodes with unsatisfied FS dependencies", () => {
      const root = manager.createNode({ projectId, orgId, parentId: null, type: "strategy", title: "Root" });
      const t1 = manager.createNode({ projectId, orgId, parentId: root.id, type: "task", title: "First" });
      const t2 = manager.createNode({
        projectId,
        orgId,
        parentId: root.id,
        type: "task",
        title: "Second",
        dependencies: [{ nodeId: t1.id, type: "FS" }],
      });

      // t2 depends on t1 finishing first; t1 is pending, so next should be t1
      const next = manager.getNextActionable(projectId);
      expect(next!.id).toBe(t1.id);

      // Complete t1, now t2 should be actionable
      manager.updateStatus(t1.id, "completed");
      const next2 = manager.getNextActionable(projectId);
      expect(next2!.id).toBe(t2.id);
    });

    it("returns null for empty project", () => {
      const next = manager.getNextActionable(projectId);
      expect(next).toBeNull();
    });
  });

  describe("org isolation", () => {
    it("prevents creating nodes across org boundaries", () => {
      const multiDb = createTestDb();
      const seeds = seedMultiOrg(multiDb);
      const mgr = new StrategyTreeManager(multiDb);

      const personalRoot = mgr.createNode({
        projectId: seeds.personal.projectId,
        orgId: seeds.personal.orgId,
        parentId: null,
        type: "strategy",
        title: "Personal Root",
      });

      // Attempt to create a child under personal root but with wyobi orgId
      expect(() => {
        mgr.createNode({
          projectId: seeds.wyobi.projectId,
          orgId: seeds.wyobi.orgId,
          parentId: personalRoot.id,
          type: "goal",
          title: "Cross-org child",
        });
      }).toThrow(/Cannot create node across org boundary/);

      multiDb.close();
    });

    it("getOrgTrees only returns trees for the queried org", () => {
      const multiDb = createTestDb();
      const seeds = seedMultiOrg(multiDb);
      const mgr = new StrategyTreeManager(multiDb);

      // Create a tree in personal org
      const personalRoot = mgr.createNode({
        projectId: seeds.personal.projectId,
        orgId: seeds.personal.orgId,
        parentId: null,
        type: "strategy",
        title: "Personal Root",
      });
      mgr.createNode({
        projectId: seeds.personal.projectId,
        orgId: seeds.personal.orgId,
        parentId: personalRoot.id,
        type: "task",
        title: "Personal Task",
      });

      // Create a tree in wyobi org
      mgr.createNode({
        projectId: seeds.wyobi.projectId,
        orgId: seeds.wyobi.orgId,
        parentId: null,
        type: "strategy",
        title: "Wyobi Root",
      });

      const personalTrees = mgr.getOrgTrees(seeds.personal.orgId);
      const wyobiTrees = mgr.getOrgTrees(seeds.wyobi.orgId);
      const applyTrees = mgr.getOrgTrees(seeds.apply.orgId);

      expect(personalTrees).toHaveLength(1);
      expect(personalTrees[0].root.title).toBe("Personal Root");
      expect(wyobiTrees).toHaveLength(1);
      expect(wyobiTrees[0].root.title).toBe("Wyobi Root");
      expect(applyTrees).toHaveLength(0);

      multiDb.close();
    });
  });

  describe("deleteNode", () => {
    it("removes a node and all its descendants", () => {
      const root = manager.createNode({ projectId, orgId, parentId: null, type: "strategy", title: "Root" });
      const child = manager.createNode({ projectId, orgId, parentId: root.id, type: "goal", title: "Child" });
      manager.createNode({ projectId, orgId, parentId: child.id, type: "task", title: "Grandchild" });

      manager.deleteNode(child.id);

      expect(manager.getNodeById(child.id)).toBeNull();
      expect(manager.getChildren(root.id)).toHaveLength(0);
    });
  });
});
