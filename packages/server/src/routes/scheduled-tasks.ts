import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { TaskScheduler } from "../scheduler/task-scheduler.js";
import { calculateNextRun } from "../scheduler/task-scheduler.js";

const createTaskSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  cronHour: z.number().int().min(0).max(23),
  cronMinute: z.number().int().min(0).max(59).default(0),
  daysOfWeek: z.string().default("1,2,3,4,5"),
  goalTemplate: z.string().min(1),
  taskType: z.string().default("review"),
  enabled: z.boolean().default(true),
});

const updateTaskSchema = z.object({
  name: z.string().min(1).optional(),
  cronHour: z.number().int().min(0).max(23).optional(),
  cronMinute: z.number().int().min(0).max(59).optional(),
  daysOfWeek: z.string().optional(),
  goalTemplate: z.string().min(1).optional(),
  taskType: z.string().optional(),
  enabled: z.boolean().optional(),
});

export function registerScheduledTaskRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  scheduler: TaskScheduler,
): void {
  // List scheduled tasks
  fastify.get("/api/scheduled-tasks", async (request) => {
    const { projectId, orgId } = request.query as {
      projectId?: string;
      orgId?: string;
    };

    let sql = `SELECT st.*, p.name as project_name FROM scheduled_tasks st JOIN projects p ON st.project_id = p.id WHERE 1=1`;
    const params: unknown[] = [];

    if (projectId) {
      sql += ` AND st.project_id = ?`;
      params.push(projectId);
    }
    if (orgId) {
      sql += ` AND st.org_id = ?`;
      params.push(orgId);
    }

    sql += ` ORDER BY st.cron_hour, st.cron_minute`;

    const rows = db.prepare(sql).all(...params);
    return { success: true, data: rows };
  });

  // Create a scheduled task
  fastify.post("/api/scheduled-tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: parsed.error.message });
    }

    const data = parsed.data;

    // Verify project exists and get org_id
    const project = db
      .prepare(`SELECT id, org_id FROM projects WHERE id = ?`)
      .get(data.projectId) as { id: string; org_id: string } | undefined;
    if (!project) {
      return reply
        .status(404)
        .send({ success: false, error: "Project not found" });
    }

    const id = nanoid();
    const nextRun = calculateNextRun(
      data.cronHour,
      data.cronMinute,
      data.daysOfWeek,
    );

    db.prepare(
      `INSERT INTO scheduled_tasks (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week, goal_template, task_type, enabled, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.projectId,
      project.org_id,
      data.name,
      data.cronHour,
      data.cronMinute,
      data.daysOfWeek,
      data.goalTemplate,
      data.taskType,
      data.enabled ? 1 : 0,
      nextRun,
    );

    return reply.status(201).send({ success: true, data: { id, nextRun } });
  });

  // Update a scheduled task
  fastify.patch("/api/scheduled-tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: parsed.error.message });
    }

    const existing = db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      return reply
        .status(404)
        .send({ success: false, error: "Scheduled task not found" });
    }

    const updates = parsed.data;
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      params.push(updates.name);
    }
    if (updates.cronHour !== undefined) {
      setClauses.push("cron_hour = ?");
      params.push(updates.cronHour);
    }
    if (updates.cronMinute !== undefined) {
      setClauses.push("cron_minute = ?");
      params.push(updates.cronMinute);
    }
    if (updates.daysOfWeek !== undefined) {
      setClauses.push("days_of_week = ?");
      params.push(updates.daysOfWeek);
    }
    if (updates.goalTemplate !== undefined) {
      setClauses.push("goal_template = ?");
      params.push(updates.goalTemplate);
    }
    if (updates.taskType !== undefined) {
      setClauses.push("task_type = ?");
      params.push(updates.taskType);
    }
    if (updates.enabled !== undefined) {
      setClauses.push("enabled = ?");
      params.push(updates.enabled ? 1 : 0);
    }

    if (setClauses.length === 0) {
      return reply
        .status(400)
        .send({ success: false, error: "No fields to update" });
    }

    // Recalculate next_run_at from cron fields — but ONLY for cron-mode
    // rows. Interval-mode loop wakes carry placeholder cron values
    // (hour 0, all days), so recomputing here reset a "+10 minutes" wake
    // to midnight on ANY patch, even {enabled:false}.
    let nextRun: string | null = null;
    if ((existing.mode as string | undefined) !== "interval") {
      const newHour =
        updates.cronHour ?? (existing.cron_hour as number);
      const newMinute =
        updates.cronMinute ?? (existing.cron_minute as number);
      const newDays =
        updates.daysOfWeek ?? (existing.days_of_week as string);
      nextRun = calculateNextRun(newHour, newMinute, newDays);
      setClauses.push("next_run_at = ?");
      params.push(nextRun);
    }

    params.push(id);
    db.prepare(
      `UPDATE scheduled_tasks SET ${setClauses.join(", ")} WHERE id = ?`,
    ).run(...params);

    return { success: true, data: { id, nextRun } };
  });

  // Delete a scheduled task
  fastify.delete("/api/scheduled-tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = db
      .prepare(`DELETE FROM scheduled_tasks WHERE id = ?`)
      .run(id);
    if (result.changes === 0) {
      return reply
        .status(404)
        .send({ success: false, error: "Scheduled task not found" });
    }
    return { success: true, data: { id } };
  });

  // Manual trigger: run a task now
  fastify.post("/api/scheduled-tasks/:id/run", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = scheduler.runTaskById(id);
      if (!result.launched) {
        // Not an error — the task was gated (busy) or skipped (misconfig).
        // 409 Conflict communicates "understood, but not started now".
        return reply.status(409).send({
          success: false,
          error: result.reason ?? "task did not launch",
          data: { id, launched: false },
        });
      }
      return { success: true, data: { id, launched: true, message: "Task triggered" } };
    } catch (err) {
      return reply.status(404).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Seed defaults for all projects
  fastify.post("/api/scheduled-tasks/seed-defaults", async () => {
    scheduler.seedDefaults();
    return { success: true, data: { message: "Defaults seeded" } };
  });
}
