import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface NotebookRow {
  id: string;
  org_id: string;
  project_id: string | null;
  notebook_lm_id: string;
  title: string;
  source_count: number;
  last_queried_at: string | null;
  created_at: string;
}

interface LogRow {
  id: number;
  org_id: string;
  notebook_id: string | null;
  query: string;
  response_summary: string | null;
  sources_cited: number;
  estimated_tokens_saved: number;
  created_at: string;
}

interface SavingsRow {
  total_queries: number;
  total_tokens_saved: number;
  total_sources_cited: number;
}

export function registerResearchRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // GET /api/research/notebooks?orgId= - list notebooks
  fastify.get("/api/research/notebooks", async (request, reply) => {
    const { orgId } = request.query as { orgId?: string };

    if (!orgId) {
      return reply.status(400).send({
        success: false,
        error: "orgId query parameter is required",
      });
    }

    const notebooks = db
      .prepare(
        "SELECT * FROM research_notebooks WHERE org_id = ? ORDER BY created_at DESC",
      )
      .all(orgId) as NotebookRow[];

    return {
      success: true,
      data: notebooks,
    };
  });

  // GET /api/research/log?orgId=&limit= - recent research queries
  fastify.get("/api/research/log", async (request, reply) => {
    const { orgId, limit } = request.query as {
      orgId?: string;
      limit?: string;
    };

    if (!orgId) {
      return reply.status(400).send({
        success: false,
        error: "orgId query parameter is required",
      });
    }

    const numLimit = Math.min(parseInt(limit ?? "50", 10), 500);
    if (isNaN(numLimit) || numLimit < 1) {
      return reply.status(400).send({
        success: false,
        error: "limit must be a positive integer (max 500)",
      });
    }

    const logs = db
      .prepare(
        `SELECT * FROM research_log
         WHERE org_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(orgId, numLimit) as LogRow[];

    return {
      success: true,
      data: logs,
    };
  });

  // GET /api/research/savings?orgId= - total estimated tokens saved
  fastify.get("/api/research/savings", async (request, reply) => {
    const { orgId } = request.query as { orgId?: string };

    if (!orgId) {
      return reply.status(400).send({
        success: false,
        error: "orgId query parameter is required",
      });
    }

    const row = db
      .prepare(
        `SELECT
           COUNT(*) as total_queries,
           COALESCE(SUM(estimated_tokens_saved), 0) as total_tokens_saved,
           COALESCE(SUM(sources_cited), 0) as total_sources_cited
         FROM research_log
         WHERE org_id = ?`,
      )
      .get(orgId) as SavingsRow | undefined;

    return {
      success: true,
      data: {
        totalQueries: row?.total_queries ?? 0,
        totalTokensSaved: row?.total_tokens_saved ?? 0,
        totalSourcesCited: row?.total_sources_cited ?? 0,
      },
    };
  });
}
