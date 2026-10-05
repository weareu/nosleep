import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerOrgRoutes } from "../../routes/orgs.js";
import { registerProjectRoutes } from "../../routes/projects.js";
import { registerAlertRoutes } from "../../routes/alerts.js";
import { registerStrategyRoutes } from "../../routes/strategy.js";
import { StrategyTreeManager } from "../../strategy/tree-manager.js";

async function buildApp(db: Database.Database): Promise<{
  app: FastifyInstance;
  treeMgr: StrategyTreeManager;
}> {
  const app = Fastify({ logger: false });
  const treeMgr = new StrategyTreeManager(db);
  registerOrgRoutes(app, db);
  registerProjectRoutes(app, db);
  registerAlertRoutes(app, db);
  registerStrategyRoutes(app, db, treeMgr);
  await app.ready();
  return { app, treeMgr };
}

describe("API under concurrent load", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let treeMgr: StrategyTreeManager;

  beforeEach(async () => {
    db = createTestDb();
    ({ app, treeMgr } = await buildApp(db));
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("handles 100 parallel GET /api/orgs requests", async () => {
    seedMultiOrg(db);
    const promises = Array.from({ length: 100 }, () =>
      app.inject({ method: "GET", url: "/api/orgs" }),
    );
    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(3);
    }
  });

  it("handles 50 parallel GET /api/projects requests", async () => {
    seedMultiOrg(db);
    const start = Date.now();
    const promises = Array.from({ length: 50 }, () =>
      app.inject({ method: "GET", url: "/api/projects" }),
    );
    const results = await Promise.all(promises);
    const elapsed = Date.now() - start;
    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }
    // 50 reads should complete in well under a second on any hardware
    expect(elapsed).toBeLessThan(2000);
  });

  it("100 parallel PATCH on the same project converge to one final value", async () => {
    const ids = seedMultiOrg(db);
    const promises = Array.from({ length: 100 }, (_, i) =>
      app.inject({
        method: "PATCH",
        url: `/api/projects/${ids.personal.projectId}`,
        payload: { tokenBudget: 100_000 + i },
      }),
    );
    const results = await Promise.all(promises);
    for (const res of results) expect(res.statusCode).toBe(200);

    const row = db
      .prepare(`SELECT token_budget FROM projects WHERE id = ?`)
      .get(ids.personal.projectId) as { token_budget: number };
    // Final value must be one of the 100 attempted updates
    expect(row.token_budget).toBeGreaterThanOrEqual(100_000);
    expect(row.token_budget).toBeLessThan(100_100);
  });

  it("100 parallel alert inserts via SQL all succeed (db-level write contention)", async () => {
    const ids = seedMultiOrg(db);
    const promises = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(
        db
          .prepare(`INSERT INTO alerts (org_id, type, severity, message) VALUES (?, 'load', 'info', ?)`)
          .run(ids.personal.orgId, `concurrent-${i}`),
      ),
    );
    await Promise.all(promises);
    const count = db
      .prepare(`SELECT COUNT(*) as n FROM alerts WHERE type = 'load'`)
      .get() as { n: number };
    expect(count.n).toBe(100);
  });

  it("ack-all under concurrent reads returns consistent state", async () => {
    const ids = seedMultiOrg(db);
    for (let i = 0; i < 50; i++) {
      db.prepare(`INSERT INTO alerts (org_id, type, severity, message) VALUES (?, 't', 'info', ?)`).run(
        ids.personal.orgId,
        `m${i}`,
      );
    }

    // Race: 20 parallel listings + 1 ack-all
    const reads = Array.from({ length: 20 }, () =>
      app.inject({ method: "GET", url: "/api/alerts?orgId=org_personal" }),
    );
    const ack = app.inject({
      method: "POST",
      url: "/api/alerts/ack-all?orgId=org_personal",
    });

    const [ackRes, ...readResults] = await Promise.all([ack, ...reads]);
    expect(ackRes.statusCode).toBe(200);
    for (const r of readResults) expect(r.statusCode).toBe(200);

    const remaining = db
      .prepare(`SELECT COUNT(*) as n FROM alerts WHERE acknowledged = 0 AND org_id = ?`)
      .get(ids.personal.orgId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("concurrent strategy node creates produce non-colliding ids", async () => {
    const ids = seedMultiOrg(db);
    const rootId = treeMgr.createTree(ids.personal.projectId, ids.personal.orgId, {
      type: "strategy",
      title: "Root",
    });

    const promises = Array.from({ length: 30 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/api/strategy/node",
        payload: {
          projectId: ids.personal.projectId,
          orgId: ids.personal.orgId,
          parentId: rootId,
          type: "task",
          title: `T${i}`,
        },
      }),
    );
    const results = await Promise.all(promises);
    const ids_created = new Set<string>();
    for (const res of results) {
      expect(res.statusCode).toBe(201);
      const body = res.json() as { data: { id: string } };
      ids_created.add(body.data.id);
    }
    expect(ids_created.size).toBe(30); // No collisions
  });
});

describe("Memory stability under sustained operation", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    ({ app } = await buildApp(db));
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("1000 sequential requests do not balloon memory", async () => {
    seedMultiOrg(db);

    // Force a GC if exposed
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i++) {
      const res = await app.inject({ method: "GET", url: "/api/orgs" });
      expect(res.statusCode).toBe(200);
    }

    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const growthMB = (after - before) / 1024 / 1024;

    // Heap should not grow more than 50MB after 1000 hits — generous bound
    // This catches obvious leaks but not subtle ones
    expect(growthMB).toBeLessThan(50);
  });
});
