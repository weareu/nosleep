import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerHookCallbackRoutes } from "../../routes/hooks-callback.js";
import { SessionMessageQueue } from "../../orchestrator/message-queue.js";

async function buildApp(db: Database.Database, queue: SessionMessageQueue): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHookCallbackRoutes(app, db, queue);
  await app.ready();
  return app;
}

describe("Hook callback routes", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let queue: SessionMessageQueue;

  beforeEach(async () => {
    db = createTestDb();
    queue = new SessionMessageQueue();
    app = await buildApp(db, queue);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe("POST /api/hooks/pre-tool", () => {
    it("returns empty object when no sessionId provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-tool",
        payload: { orgId: "org_personal" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    });

    it("returns empty object when session does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-tool",
        payload: { sessionId: "missing_sess", toolName: "Read" },
      });
      expect(res.statusCode).toBe(200);
      // No session = no messages to inject
      expect(res.json()).toEqual({});
    });

    it("rejects malformed body with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-tool",
        payload: { sessionId: 12345 }, // wrong type
      });
      expect(res.statusCode).toBe(400);
    });

    it("drains queued messages and returns them in response", async () => {
      const ids = seedMultiOrg(db);
      db.prepare(`
        INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
        VALUES (?, ?, ?, ?, 'running', 'g', 'h')
      `).run("s1", ids.personal.projectId, ids.personal.orgId, ids.personal.accountId);

      queue.push("s1", "Stay focused on the goal.");

      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-tool",
        payload: { sessionId: "s1", toolName: "Read" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { hookSpecificOutput?: { additionalContext?: string } };
      // Implementation may use hookSpecificOutput or another shape — accept either
      const text = JSON.stringify(body);
      expect(text).toContain("Stay focused");

      // Queue should be drained after
      expect(queue.hasPending("s1")).toBe(false);
    });

    it("emits a budget warning when token usage > 80% of budget", async () => {
      const ids = seedMultiOrg(db);
      // 80% of 500_000 = 400_000
      db.prepare(`
        INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, tokens_used)
        VALUES (?, ?, ?, ?, 'running', 'g', 'h', ?)
      `).run("s_warn", ids.personal.projectId, ids.personal.orgId, ids.personal.accountId, 420_000);

      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-tool",
        payload: { sessionId: "s_warn", toolName: "Bash" },
      });
      expect(res.statusCode).toBe(200);
      const text = JSON.stringify(res.json());
      // Either critical (>=95) or warning (>=80) wording
      expect(text.toLowerCase()).toContain("budget");
    });
  });

  describe("POST /api/hooks/post-tool", () => {
    it("returns 400 for malformed body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/post-tool",
        payload: { sessionId: 99 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts valid payload without session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/post-tool",
        payload: { toolName: "Read", toolResult: "ok" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /api/hooks/pre-compact", () => {
    it("accepts valid payload", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-compact",
        payload: { sessionId: "any", summary: "compacting now" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects malformed body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/pre-compact",
        payload: { sessionId: 1 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/hooks/stop", () => {
    it("accepts valid payload without session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/stop",
        payload: { sessionId: "abc", stopReason: "user_quit" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects malformed body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/hooks/stop",
        payload: { sessionId: { nested: true } },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
