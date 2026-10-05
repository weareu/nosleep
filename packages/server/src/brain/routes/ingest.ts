/**
 * POST /api/brain/ingest — primary ingest endpoint.
 *
 * Auth: existing NoSleep x-api-key (checked by upstream preHandler in server.ts).
 * Body: see docs/plans/brain/04-mcp-and-api.md.
 * Response: 202 + {hash, duplicate, enqueued, size, latency_ms}.
 */

import type { FastifyInstance } from "fastify";
import { ingest, IngestSizeError } from "../ingest/pipeline.js";
import { InvalidKindError } from "../ingest/kind-validator.js";
import { IngestRequest } from "../ingest/types.js";
import { assertOrgMatches } from "../../auth.js";

export function registerBrainIngestRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/brain/ingest", async (request, reply) => {
    const parsed = IngestRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "MISSING_FIELD",
          message: parsed.error.message,
        },
      });
    }

    // Phase 12 — cross-org binding. In per-org-key mode the caller's
    // resolved orgId must match the body org_id; rejects 403 otherwise.
    if (!assertOrgMatches(request, reply, parsed.data.org_id)) return;

    try {
      const result = ingest(parsed.data);
      reply
        .header("X-Brain-Hash", result.hash)
        .header("X-Brain-Duplicate", String(result.duplicate))
        .header("X-Brain-Latency-Ms", result.latency_ms.toFixed(2))
        .status(202)
        .send(result);
    } catch (err: unknown) {
      if (err instanceof InvalidKindError) {
        return reply.status(400).send({
          error: {
            code: "INVALID_KIND",
            message: err.message,
            details: { kind: err.kind, reason: err.reason },
          },
        });
      }
      if (err instanceof IngestSizeError) {
        return reply.status(413).send({
          error: { code: "SIZE_LIMIT", message: err.message },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, "brain ingest failed");
      return reply.status(500).send({
        error: { code: "INGEST_FAILED", message },
      });
    }
  });
}
