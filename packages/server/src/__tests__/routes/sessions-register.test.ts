import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerSessionRoutes } from "../../routes/sessions.js";
import { registerProjectRoutes } from "../../routes/projects.js";
import type { SessionManager } from "../../orchestrator/session-manager.js";
import type { SupervisionLoop } from "../../orchestrator/supervision-loop.js";
import type { BudgetPacer } from "../../budget/budget-pacer.js";

function deps() {
  const sm = { getActiveSessions: () => [] } as unknown as SessionManager;
  const sup = { eventStore: { getPendingEscalations: () => [] } } as unknown as SupervisionLoop;
  const pacer = { canLaunchSession: () => ({ allowed: true }) } as unknown as BudgetPacer;
  return { sm, sup, pacer };
}

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { sm, sup, pacer } = deps();
  registerSessionRoutes(app, db, sm, sup, pacer);
  await app.ready();
  return app;
}

async function register(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/sessions/register", payload: body });
}

describe("POST /api/sessions/register — global-hook session visibility", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    seedMultiOrg(db);
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("registers a session for a known project path", async () => {
    const res = await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "cc1" });
    expect([200, 201]).toContain(res.statusCode);
    const row = db.prepare(`SELECT project_id, org_id FROM sessions WHERE claude_session_id='cc1'`).get() as { project_id: string; org_id: string };
    expect(row.project_id).toBe("proj_personal_001");
    expect(row.org_id).toBe("org_personal");
  });

  it("attributes by PATH to the project's true org even if the payload org is wrong (global-hook default)", async () => {
    // A global hook bakes org_personal, but the folder is a Wyobi project.
    const res = await register(app, { orgId: "org_personal", projectPath: "/tmp/wyobi", claudeSessionId: "cc2" });
    expect([200, 201]).toContain(res.statusCode);
    const row = db.prepare(`SELECT project_id, org_id FROM sessions WHERE claude_session_id='cc2'`).get() as { project_id: string; org_id: string };
    expect(row.project_id).toBe("proj_wyobi_001");
    expect(row.org_id).toBe("org_wyobi"); // NOT org_personal — resolved by path
  });

  it("auto-provisions an Ad-hoc project for an unknown folder (no more silent 404)", async () => {
    const res = await register(app, { orgId: "org_personal", projectPath: "/tmp/some-unregistered-folder-xyz", claudeSessionId: "cc3" });
    expect([200, 201]).toContain(res.statusCode);

    const adhoc = db.prepare(`SELECT id, name FROM projects WHERE org_id='org_personal' AND path='__adhoc__/org_personal'`).get() as { id: string; name: string } | undefined;
    expect(adhoc).toBeDefined();
    expect(adhoc!.name).toBe("Ad-hoc sessions");

    const row = db.prepare(`SELECT project_id, org_id, worktree_path FROM sessions WHERE claude_session_id='cc3'`).get() as { project_id: string; org_id: string; worktree_path: string };
    expect(row.project_id).toBe(adhoc!.id);
    expect(row.org_id).toBe("org_personal");
    expect(row.worktree_path).toBe("/tmp/some-unregistered-folder-xyz"); // cwd preserved for visibility
  });

  it("labels OpenCode sessions (agent: opencode) and keeps Claude Code as the default", async () => {
    await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "ses_oc1", agent: "opencode" });
    await register(app, { orgId: "org_wyobi", projectPath: "/tmp/wyobi", claudeSessionId: "cc-default" });
    const oc = db.prepare(`SELECT goal_text FROM sessions WHERE claude_session_id='ses_oc1'`).get() as { goal_text: string };
    const cc = db.prepare(`SELECT goal_text FROM sessions WHERE claude_session_id='cc-default'`).get() as { goal_text: string };
    expect(oc.goal_text).toBe("Manual OpenCode session");
    expect(cc.goal_text).toBe("Manual CLI session");
    const res = await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", agent: "cursor" });
    expect(res.statusCode).toBe(400);
  });

  it("reuses the same row for a repeat register of the same claude session (dedup)", async () => {
    await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "cc-dup" });
    await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "cc-dup" });
    const n = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE claude_session_id='cc-dup'`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("resurrects a swept-stopped manual row when the same claude session registers again", async () => {
    await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "cc-alive" });
    // Simulate the 2h stale sweep parking the row while the CLI is still open.
    db.prepare(
      `UPDATE sessions SET status='stopped', ended_at=datetime('now') WHERE claude_session_id='cc-alive'`,
    ).run();

    const res = await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "cc-alive" });
    expect(res.statusCode).toBe(200);

    const row = db.prepare(
      `SELECT status, ended_at FROM sessions WHERE claude_session_id='cc-alive'`,
    ).get() as { status: string; ended_at: string | null };
    expect(row.status).toBe("running");
    expect(row.ended_at).toBeNull();
  });

  it("reactivates an archived project when a live session registers in it", async () => {
    db.prepare(`UPDATE projects SET active=0 WHERE id='proj_personal_001'`).run();

    await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "cc-react" });

    const proj = db.prepare(`SELECT active FROM projects WHERE id='proj_personal_001'`).get() as { active: number };
    expect(proj.active).toBe(1);
  });
});

describe("GET /api/sessions — live sessions must not fall out of the window", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    seedMultiOrg(db);
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns an old-but-running session ahead of 100+ newer terminal rows", async () => {
    const insert = db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, started_at, last_activity_at)
      VALUES (?, 'proj_personal_001', 'org_personal', 'acc_personal_max', ?, 'g', 'h', ?, ?)
    `);
    // A long-lived CLI session STARTED weeks ago but active now.
    insert.run("manual_old_alive", "running", "2026-01-01 00:00:00", "2026-08-06 08:00:00");
    // 110 newer terminal rows that would push it out of a started_at-ordered window.
    for (let i = 0; i < 110; i++) {
      insert.run(`manual_new_${i}`, "stopped", "2026-08-01 00:00:00", "2026-08-01 00:00:00");
    }

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const body = res.json() as { data: Array<{ id: string; status: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain("manual_old_alive");
    expect(ids[0]).toBe("manual_old_alive"); // live rows sort first
  });
});

describe("project status is derived from live sessions (web + mobile read /api/projects)", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    seedMultiOrg(db);
    app = Fastify({ logger: false });
    const { sm, sup, pacer } = deps();
    registerSessionRoutes(app, db, sm, sup, pacer);
    registerProjectRoutes(app, db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function statusOf(projectId: string): Promise<{ list: string; one: string }> {
    const list = (await app.inject({ method: "GET", url: "/api/projects" })).json() as {
      data: Array<{ id: string; status: string }>;
    };
    const one = (await app.inject({ method: "GET", url: `/api/projects/${projectId}` })).json() as {
      data: { status: string };
    };
    return { list: list.data.find((p) => p.id === projectId)!.status, one: one.data.status };
  }

  it("a hook-registered session makes its project Running; ending the last one returns it to Idle", async () => {
    expect(await statusOf("proj_personal_001")).toEqual({ list: "idle", one: "idle" });

    await register(app, { orgId: "org_personal", projectPath: "/tmp/personal", claudeSessionId: "live1" });
    // A second concurrent session (orchestrator-launched) in the same project.
    db.prepare(
      `INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, claude_session_id)
       VALUES ('sess_live2', 'proj_personal_001', 'org_personal', 'acc_personal_max', 'running', 'g', 'h', 'live2')`,
    ).run();
    expect(await statusOf("proj_personal_001")).toEqual({ list: "running", one: "running" });

    // One of two sessions ends — the project is still running.
    db.prepare(`UPDATE sessions SET status='completed' WHERE claude_session_id='live1'`).run();
    expect((await statusOf("proj_personal_001")).list).toBe("running");

    // A session waiting on the user is still live work (same set the org
    // "N running" badge counts).
    db.prepare(`UPDATE sessions SET status='waiting_input' WHERE claude_session_id='live2'`).run();
    expect((await statusOf("proj_personal_001")).list).toBe("running");

    db.prepare(`UPDATE sessions SET status='stopped' WHERE claude_session_id='live2'`).run();
    expect(await statusOf("proj_personal_001")).toEqual({ list: "idle", one: "idle" });
  });

  it("a stale stored 'running' with no live session reads as idle", async () => {
    db.prepare(`UPDATE projects SET status='running' WHERE id='proj_wyobi_001'`).run();
    expect((await statusOf("proj_wyobi_001")).list).toBe("idle");
  });
});
