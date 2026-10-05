import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { VectorIndexer } from "../embeddings/vector-indexer.js";

const searchSchema = z.object({
  q: z.string().min(1),
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

const reindexSchema = z.object({
  projectId: z.string(),
});

export function registerSearchRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  vectorIndexer: VectorIndexer,
): void {
  // Search within a specific project
  fastify.get("/api/search", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const parsed = searchSchema.safeParse(query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { q, projectId, limit } = parsed.data;

    try {
      if (projectId) {
        const results = await vectorIndexer.search(projectId, q, limit);
        return { success: true, data: results };
      }
      // No projectId = search all
      const results = await vectorIndexer.searchAll(q, limit);
      return { success: true, data: results };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Search across all projects
  fastify.get("/api/search/all", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const parsed = searchSchema.safeParse(query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { q, limit } = parsed.data;

    try {
      const results = await vectorIndexer.searchAll(q, limit);

      // Group by project
      const grouped: Record<string, typeof results> = {};
      for (const result of results) {
        if (!grouped[result.projectId]) {
          grouped[result.projectId] = [];
        }
        grouped[result.projectId].push(result);
      }

      return { success: true, data: grouped };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Trigger reindex for a project
  fastify.post("/api/search/reindex", async (request, reply) => {
    const parsed = reindexSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { projectId } = parsed.data;
    const project = db.prepare(`SELECT id, path FROM projects WHERE id = ?`).get(projectId) as { id: string; path: string } | undefined;
    if (!project) {
      return reply.status(404).send({ success: false, error: "Project not found" });
    }

    try {
      const count = await vectorIndexer.indexProject(project.id, project.path);
      return { success: true, data: { chunksIndexed: count } };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
