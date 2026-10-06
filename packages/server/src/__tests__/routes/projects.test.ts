import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerProjectRoutes } from "../../routes/projects.js";

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerProjectRoutes(app, db);
  await app.ready();
  return app;
}

describe("GET /api/projects", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns empty list when no projects exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("returns all projects across orgs by default", async () => {
    seedMultiOrg(db);
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(3);
  });

  it("filters by orgId query param", async () => {
    seedMultiOrg(db);
    const res = await app.inject({ method: "GET", url: "/api/projects?orgId=org_personal" });
    const body = res.json() as { data: Array<{ id: string; org_id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].org_id).toBe("org_personal");
  });

  it("includes org name and color via JOIN", async () => {
    seedMultiOrg(db);
    const res = await app.inject({ method: "GET", url: "/api/projects?orgId=org_work" });
    const body = res.json() as { data: Array<{ org_name: string; org_slug: string; org_color: string }> };
    expect(body.data[0].org_name).toBe("Work");
    expect(body.data[0].org_slug).toBe("work");
    expect(body.data[0].org_color).toBe("#f59e0b");
  });
});

describe("GET /api/projects/:id", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns 404 for unknown project id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nonexistent" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { success: boolean };
    expect(body.success).toBe(false);
  });

  it("returns project with recentSessions array", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({ method: "GET", url: `/api/projects/${ids.personal.projectId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { id: string; recentSessions: unknown[] };
    };
    expect(body.data.id).toBe(ids.personal.projectId);
    expect(Array.isArray(body.data.recentSessions)).toBe(true);
  });
});

describe("PATCH /api/projects/:id", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("rejects empty update with 400", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${ids.personal.projectId}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("toggles active flag", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${ids.personal.projectId}`,
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare(`SELECT active FROM projects WHERE id = ?`)
      .get(ids.personal.projectId) as { active: number };
    expect(row.active).toBe(0);
  });

  it("updates token budget", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${ids.personal.projectId}`,
      payload: { tokenBudget: 999_000 },
    });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare(`SELECT token_budget FROM projects WHERE id = ?`)
      .get(ids.personal.projectId) as { token_budget: number };
    expect(row.token_budget).toBe(999_000);
  });

  it("rejects negative token budget", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${ids.personal.projectId}`,
      payload: { tokenBudget: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown autonomy level", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${ids.personal.projectId}`,
      payload: { autonomyLevel: "godmode" },
    });
    expect(res.statusCode).toBe(400);
  });
});
