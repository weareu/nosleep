import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { nanoid } from "nanoid";

const createAccountSchema = z.object({
  orgId: z.string(),
  name: z.string().min(1),
  type: z.enum(["pro", "max", "api"]),
  apiKeyRef: z.string().optional(),
  dailyTokenLimit: z.number().int().positive().default(10_000_000),
  monthlyTokenLimit: z.number().int().positive().default(200_000_000),
  billingCycleDay: z.number().int().min(1).max(31).default(1),
});

export function registerAccountRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // List accounts, optionally by org
  fastify.get("/api/accounts", async (request) => {
    const { orgId } = request.query as { orgId?: string };

    let sql = `
      SELECT a.*, o.name as org_name, o.slug as org_slug, o.color as org_color
      FROM accounts a
      JOIN organizations o ON a.org_id = o.id
    `;
    const params: unknown[] = [];

    if (orgId) {
      sql += ` WHERE a.org_id = ?`;
      params.push(orgId);
    }

    sql += ` ORDER BY o.slug, a.name`;

    return { success: true, data: db.prepare(sql).all(...params) };
  });

  // Create an account
  fastify.post("/api/accounts", async (request, reply) => {
    const parsed = createAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { orgId, name, type, apiKeyRef, dailyTokenLimit, monthlyTokenLimit, billingCycleDay } = parsed.data;

    // Verify org exists
    const org = db.prepare(`SELECT id FROM organizations WHERE id = ?`).get(orgId);
    if (!org) {
      return reply.status(400).send({ success: false, error: "Organization not found" });
    }

    const id = nanoid();
    db.prepare(`
      INSERT INTO accounts (id, org_id, name, type, api_key_ref, daily_token_limit, monthly_token_limit, billing_cycle_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, name, type, apiKeyRef ?? null, dailyTokenLimit, monthlyTokenLimit, billingCycleDay);

    return reply.status(201).send({ success: true, data: { id } });
  });
}
