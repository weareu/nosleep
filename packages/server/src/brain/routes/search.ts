/**
 * POST /api/brain/search — structured QuerySpec retrieval.
 */

import type { FastifyInstance } from "fastify";
import { QuerySpec } from "../retrieval/query-spec.js";
import { search } from "../retrieval/search.js";

export function registerBrainSearchRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/brain/search", async (request, reply) => {
    const parsed = QuerySpec.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "MISSING_FIELD",
          message: parsed.error.message,
        },
      });
    }

    try {
      const response = await search(parsed.data);
      reply
        .header("X-Brain-Query-Id", response.query_id)
        .header(
          "X-Brain-Layer-Mix",
          `archive=${response.layers_returned.archive},thoughts=${response.layers_returned.thoughts}`,
        )
        .send(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("QuerySpec is empty")) {
        return reply.status(400).send({
          error: { code: "MISSING_FIELD", message },
        });
      }
      fastify.log.error({ err }, "brain search failed");
      return reply.status(500).send({
        error: { code: "INGEST_FAILED", message },
      });
    }
  });
}
