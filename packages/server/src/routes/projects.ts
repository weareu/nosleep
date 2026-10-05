import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { nanoid } from "nanoid";
import path from "node:path";
import os from "node:os";
import { realpathSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DEFAULT_ITERATION_STEPS, projectLiveStatusSql, type IterationStep } from "@nosleep/shared";

function ensureProjectPath(rawPath: string): { error?: string; created?: boolean } {
  const resolved = path.resolve(rawPath);

  // Allowlist: must be under the user's home directory
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + "/") && resolved !== homeDir) {
    return { error: "Path must be under your home directory" };
  }

  // Block hidden directories (dotfiles) directly under home
  const relativeToHome = resolved.slice(homeDir.length + 1);
  if (relativeToHome.startsWith(".")) {
    return { error: "Path must not be a hidden directory" };
  }

  // Create directory if it doesn't exist
  if (!existsSync(resolved)) {
    try {
      mkdirSync(resolved, { recursive: true });
    } catch (e) {
      return { error: `Failed to create directory: ${(e as Error).message}` };
    }

    // Initialize git repo in the new directory
    try {
      execFileSync("git", ["init"], { cwd: resolved, stdio: "pipe" });
    } catch (e) {
      return { error: `Directory created but git init failed: ${(e as Error).message}` };
    }

    return { created: true };
  }

  // Resolve symlinks to prevent bypass
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return { error: "Unable to resolve path (broken symlink?)" };
  }

  if (!realPath.startsWith(homeDir + "/") && realPath !== homeDir) {
    return { error: "Path resolves outside your home directory" };
  }

  // Init git repo if directory exists but isn't a git repo
  const gitDir = path.join(realPath, ".git");
  if (!existsSync(gitDir)) {
    try {
      execFileSync("git", ["init"], { cwd: realPath, stdio: "pipe" });
    } catch {
      // Non-fatal — directory exists, just not a git repo
    }
  }

  return {};
}

const createProjectSchema = z.object({
  orgId: z.string(),
  name: z.string().min(1),
  path: z.string().min(1),
  accountId: z.string(),
  tokenBudget: z.number().int().positive().default(500000),
  autonomyLevel: z.enum(["full", "supervised", "manual"]).default("supervised"),
  continueSession: z.boolean().default(false),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  accountId: z.string().optional(),
  tokenBudget: z.number().int().positive().optional(),
  autonomyLevel: z.enum(["full", "supervised", "manual"]).optional(),
  continueSession: z.boolean().optional(),
  defaultModel: z.enum(["opus", "sonnet", "haiku"]).optional(),
  active: z.boolean().optional(),
});

type LiveStatusRow = Record<string, unknown> & { live_status: string };

/** Replace the stored status with the session-derived one (see projectLiveStatusSql). */
function withLiveStatus(row: LiveStatusRow): Record<string, unknown> {
  const { live_status, ...rest } = row;
  return { ...rest, status: live_status };
}

export function registerProjectRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // List all projects, grouped by org
  fastify.get("/api/projects", async (request) => {
    const { orgId } = request.query as { orgId?: string };

    let sql = `
      SELECT p.*, ${projectLiveStatusSql("p")} as live_status,
        o.name as org_name, o.slug as org_slug, o.color as org_color,
        a.name as account_name, a.type as account_type,
        COALESCE((SELECT sn.progress_pct FROM strategy_nodes sn WHERE sn.project_id = p.id AND sn.parent_id IS NULL LIMIT 1), 0) as progress_pct
      FROM projects p
      JOIN organizations o ON p.org_id = o.id
      JOIN accounts a ON p.account_id = a.id
    `;
    const params: unknown[] = [];

    if (orgId) {
      sql += ` WHERE p.org_id = ?`;
      params.push(orgId);
    }

    sql += ` ORDER BY o.slug, p.name`;

    const rows = (db.prepare(sql).all(...params) as LiveStatusRow[]).map(withLiveStatus);
    return { success: true, data: rows };
  });

  // Get a single project
  fastify.get("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`
      SELECT p.*, ${projectLiveStatusSql("p")} as live_status,
        o.name as org_name, o.slug as org_slug, o.color as org_color
      FROM projects p
      JOIN organizations o ON p.org_id = o.id
      WHERE p.id = ?
    `).get(id) as LiveStatusRow | undefined;

    if (!row) {
      return reply.status(404).send({ success: false, error: "Project not found" });
    }

    // Include recent sessions
    const sessions = db.prepare(`
      SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 10
    `).all(id);

    return { success: true, data: { ...withLiveStatus(row), recentSessions: sessions } };
  });

  // Create a project
  fastify.post("/api/projects", async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { orgId, name, path: projectPath, accountId, tokenBudget, autonomyLevel, continueSession } = parsed.data;

    // Ensure the project path exists (create + git init if needed)
    const { error: pathError, created } = ensureProjectPath(projectPath);
    if (pathError) {
      return reply.status(400).send({ success: false, error: pathError });
    }

    // Verify org exists
    const org = db.prepare(`SELECT id FROM organizations WHERE id = ?`).get(orgId);
    if (!org) {
      return reply.status(400).send({ success: false, error: "Organization not found" });
    }

    // Verify account belongs to same org
    const account = db.prepare(`SELECT id FROM accounts WHERE id = ? AND org_id = ?`).get(accountId, orgId);
    if (!account) {
      return reply.status(400).send({ success: false, error: "Account not found in this organization" });
    }

    const id = nanoid();
    db.prepare(`
      INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level, continue_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, name, projectPath, accountId, tokenBudget, autonomyLevel, continueSession ? 1 : 0);

    return reply.status(201).send({ success: true, data: { id, pathCreated: !!created } });
  });

  // Update a project
  fastify.patch("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const updates = parsed.data;
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push("name = ?"); params.push(updates.name); }
    if (updates.accountId !== undefined) { setClauses.push("account_id = ?"); params.push(updates.accountId); }
    if (updates.tokenBudget !== undefined) { setClauses.push("token_budget = ?"); params.push(updates.tokenBudget); }
    if (updates.autonomyLevel !== undefined) { setClauses.push("autonomy_level = ?"); params.push(updates.autonomyLevel); }
    if (updates.continueSession !== undefined) { setClauses.push("continue_session = ?"); params.push(updates.continueSession ? 1 : 0); }
    if (updates.defaultModel !== undefined) { setClauses.push("default_model = ?"); params.push(updates.defaultModel); }
    if (updates.active !== undefined) { setClauses.push("active = ?"); params.push(updates.active ? 1 : 0); }

    if (setClauses.length === 0) {
      return reply.status(400).send({ success: false, error: "No fields to update" });
    }

    params.push(id);
    db.prepare(`UPDATE projects SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

    return { success: true, data: { id } };
  });

  // Get iteration definition for a project
  fastify.get("/api/projects/:id/iteration", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`SELECT iteration_steps FROM projects WHERE id = ?`).get(id) as { iteration_steps: string } | undefined;

    if (!row) {
      return reply.status(404).send({ success: false, error: "Project not found" });
    }

    const steps: IterationStep[] = JSON.parse(row.iteration_steps);
    return { success: true, data: { projectId: id, steps } };
  });

  // Update iteration definition for a project
  const iterationStepSchema = z.object({
    id: z.number().int().positive(),
    label: z.string().min(1),
    description: z.string(),
    gated: z.boolean(),
  });

  const updateIterationSchema = z.object({
    steps: z.array(iterationStepSchema).min(1),
  });

  fastify.put("/api/projects/:id/iteration", async (request, reply) => {
    const { id } = request.params as { id: string };

    // Verify project exists
    const exists = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id);
    if (!exists) {
      return reply.status(404).send({ success: false, error: "Project not found" });
    }

    const parsed = updateIterationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { steps } = parsed.data;

    // Validate sequential IDs
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].id !== i + 1) {
        return reply.status(400).send({
          success: false,
          error: `Step IDs must be sequential starting from 1. Expected ${i + 1}, got ${steps[i].id}`,
        });
      }
    }

    db.prepare(`UPDATE projects SET iteration_steps = ? WHERE id = ?`)
      .run(JSON.stringify(steps), id);

    return { success: true, data: { projectId: id, steps } };
  });

  // Reset iteration definition to defaults
  fastify.post("/api/projects/:id/iteration/reset", async (request, reply) => {
    const { id } = request.params as { id: string };

    const exists = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id);
    if (!exists) {
      return reply.status(404).send({ success: false, error: "Project not found" });
    }

    const steps = DEFAULT_ITERATION_STEPS;
    db.prepare(`UPDATE projects SET iteration_steps = ? WHERE id = ?`)
      .run(JSON.stringify(steps), id);

    return { success: true, data: { projectId: id, steps } };
  });
}
