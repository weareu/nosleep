import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerStrategyRoutes } from "../../routes/strategy.js";
import { StrategyTreeManager } from "../../strategy/tree-manager.js";

async function buildApp(db: Database.Database): Promise<{
  app: FastifyInstance;
  treeMgr: StrategyTreeManager;
}> {
  const treeMgr = new StrategyTreeManager(db);
  const app = Fastify({ logger: false });
  registerStrategyRoutes(app, db, treeMgr);
  await app.ready();
  return { app, treeMgr };
}

describe("Strategy tree routes", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let treeMgr: StrategyTreeManager;
  let projectId: string;
  let orgId: string;

  beforeEach(async () => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
    ({ app, treeMgr } = await buildApp(db));
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe("GET /api/strategy/tree/:projectId", () => {
    it("returns 404 when no tree exists", async () => {
      const res = await app.inject({ method: "GET", url: `/api/strategy/tree/${projectId}` });
      expect(res.statusCode).toBe(404);
    });

    it("returns the root and nested children", async () => {
      treeMgr.createTree(projectId, orgId, {
        type: "strategy",
        title: "Root",
        children: [
          { type: "goal", title: "Goal 1" },
          { type: "goal", title: "Goal 2" },
        ],
      });

      const res = await app.inject({ method: "GET", url: `/api/strategy/tree/${projectId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: {
          root: { title: string };
          nodes: Array<{ title: string }>;
          totalNodes: number;
        };
      };
      expect(body.data.root.title).toBe("Root");
      expect(body.data.totalNodes).toBe(3); // root + 2 children
    });
  });

  describe("POST /api/strategy/tree", () => {
    it("creates a tree from a nested spec", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategy/tree",
        payload: {
          projectId,
          orgId,
          tree: {
            type: "strategy",
            title: "New Tree",
            children: [{ type: "task", title: "First Task" }],
          },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        data: { rootId: string; tree: { root: { title: string } } };
      };
      expect(body.data.rootId).toBeDefined();
      expect(body.data.tree.root.title).toBe("New Tree");
    });

    it("rejects invalid type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategy/tree",
        payload: {
          projectId,
          orgId,
          tree: { type: "invalid", title: "x" },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects empty title", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategy/tree",
        payload: {
          projectId,
          orgId,
          tree: { type: "strategy", title: "" },
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/strategy/node", () => {
    it("creates a child node under a parent", async () => {
      const rootId = treeMgr.createTree(projectId, orgId, {
        type: "strategy",
        title: "Root",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/strategy/node",
        payload: {
          projectId,
          orgId,
          parentId: rootId,
          type: "task",
          title: "New Task",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { data: { id: string; title: string; parentId: string } };
      expect(body.data.title).toBe("New Task");
      expect(body.data.parentId).toBe(rootId);
    });

    it("rejects an unknown parentId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/strategy/node",
        payload: {
          projectId,
          orgId,
          parentId: "nope",
          type: "task",
          title: "x",
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/strategy/node/:id/status", () => {
    it("updates status to in_progress", async () => {
      const rootId = treeMgr.createTree(projectId, orgId, {
        type: "task",
        title: "T",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/strategy/node/${rootId}/status`,
        payload: { status: "in_progress" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { status: string } };
      expect(body.data.status).toBe("in_progress");
    });

    it("rejects invalid status", async () => {
      const rootId = treeMgr.createTree(projectId, orgId, {
        type: "task",
        title: "T",
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/strategy/node/${rootId}/status`,
        payload: { status: "rocket" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/strategy/node/:id/progress", () => {
    it("clamps progress to 0..100", async () => {
      const rootId = treeMgr.createTree(projectId, orgId, {
        type: "task",
        title: "T",
      });
      const tooBig = await app.inject({
        method: "PATCH",
        url: `/api/strategy/node/${rootId}/progress`,
        payload: { progressPct: 150 },
      });
      expect(tooBig.statusCode).toBe(400);

      const tooSmall = await app.inject({
        method: "PATCH",
        url: `/api/strategy/node/${rootId}/progress`,
        payload: { progressPct: -1 },
      });
      expect(tooSmall.statusCode).toBe(400);
    });

    it("sets progress within range", async () => {
      const rootId = treeMgr.createTree(projectId, orgId, {
        type: "task",
        title: "T",
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/strategy/node/${rootId}/progress`,
        payload: { progressPct: 60 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { progressPct: number } };
      expect(body.data.progressPct).toBe(60);
    });
  });

  describe("GET /api/strategy/tree/:projectId/next", () => {
    it("returns 404 when nothing actionable", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/strategy/tree/${projectId}/next`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns the next actionable leaf", async () => {
      treeMgr.createTree(projectId, orgId, {
        type: "strategy",
        title: "Root",
        children: [
          { type: "task", title: "First" },
          { type: "task", title: "Second" },
        ],
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/strategy/tree/${projectId}/next`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { title: string; type: string } };
      expect(body.data.type).toBe("task");
      expect(["First", "Second"]).toContain(body.data.title);
    });
  });

  describe("GET /api/strategy/node/:id", () => {
    it("returns 404 for unknown node", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/strategy/node/nope",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns node with children and breadcrumb path", async () => {
      const rootId = treeMgr.createTree(projectId, orgId, {
        type: "strategy",
        title: "Root",
        children: [{ type: "task", title: "Child" }],
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/strategy/node/${rootId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: { node: { id: string }; children: unknown[]; path: unknown[] };
      };
      expect(body.data.node.id).toBe(rootId);
      expect(body.data.children).toHaveLength(1);
      expect(body.data.path).toHaveLength(1);
    });
  });
});
