/**
 * POST /api/brain/ingest — primary ingest endpoint.
 *
 * Auth: existing NoSleep x-api-key (checked by upstream preHandler in server.ts).
 * Body: see docs/plans/brain/04-mcp-and-api.md.
 * Response: 202 + {hash, duplicate, enqueued, size, latency_ms}.
 *
 * POST /api/brain/ingest/file — document upload (PDF, text, code, images).
 * Same JSON + base64 encoding the mobile photo/voice uploads use on
 * /api/brain/ingest; the server resolves kind from filename/content_type.
 * Response: 202 + {filename, kind, hash, duplicate, size, pages?, warnings}.
 */

import type { FastifyInstance } from "fastify";
import { ingest, IngestSizeError } from "../ingest/pipeline.js";
import { InvalidKindError } from "../ingest/kind-validator.js";
import { IngestRequest, IngestOrigin } from "../ingest/types.js";
import { assertOrgMatches } from "../../auth.js";
import { z } from "zod";
import {
  decodeBase64Strict,
  ingestFile,
  MAX_FILE_BASE64_CHARS,
  PdfSupportUnavailableError,
  SUPPORTED_FILE_TYPES,
  UnreadableFileError,
  UnsupportedFileTypeError,
} from "../ingest/file-ingest.js";
import { PdfExtractionError } from "../extractors/pdf-handler.js";
import { BRAIN_INGEST_MAX_BYTES } from "../config.js";

const FileIngestBody = z.object({
  filename: z.string().min(1).max(512),
  content_type: z.string().max(128).optional(),
  content_base64: z.string(),
  org_id: z.string().min(1).max(64),
  project_id: z.string().min(1).max(64),
  origin: IngestOrigin.optional(),
});

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

  fastify.post("/api/brain/ingest/file", async (request, reply) => {
    const parsed = FileIngestBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "MISSING_FIELD", message: parsed.error.message },
      });
    }
    const body = parsed.data;
    if (!assertOrgMatches(request, reply, body.org_id)) return;

    const ctx = {
      org_id: body.org_id,
      project_id: body.project_id,
      filename: body.filename,
      content_type: body.content_type,
      base64_chars: body.content_base64.length,
    };

    if (body.content_base64.length > MAX_FILE_BASE64_CHARS + 4) {
      return reply.status(413).send({
        error: {
          code: "SIZE_LIMIT",
          message: `file exceeds max ${BRAIN_INGEST_MAX_BYTES} bytes`,
          details: { max_bytes: BRAIN_INGEST_MAX_BYTES },
        },
      });
    }

    try {
      const bytes = decodeBase64Strict(body.content_base64);
      const result = await ingestFile({
        filename: body.filename,
        content_type: body.content_type,
        bytes,
        org_id: body.org_id,
        project_id: body.project_id,
        origin: body.origin ?? { tool: "brain-upload", actor: "user" },
        onWarn: (msg, err) => fastify.log.warn({ err, ...ctx }, msg),
      });
      return reply
        .header("X-Brain-Hash", result.hash)
        .header("X-Brain-Duplicate", String(result.duplicate))
        .status(202)
        .send(result);
    } catch (err: unknown) {
      if (err instanceof UnsupportedFileTypeError) {
        fastify.log.info(ctx, "brain file upload rejected: unsupported type");
        return reply.status(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: err.message,
            details: { supported: SUPPORTED_FILE_TYPES },
          },
        });
      }
      if (err instanceof IngestSizeError) {
        fastify.log.warn({ ...ctx, reason: err.message }, "brain file upload rejected: size/disk");
        return reply.status(413).send({
          error: {
            code: "SIZE_LIMIT",
            message: err.message,
            details: { max_bytes: BRAIN_INGEST_MAX_BYTES },
          },
        });
      }
      if (err instanceof UnreadableFileError || err instanceof PdfExtractionError) {
        fastify.log.warn({ ...ctx, reason: err.message }, "brain file upload rejected: unreadable");
        return reply.status(422).send({
          error: { code: "UNREADABLE_FILE", message: err.message },
        });
      }
      if (err instanceof PdfSupportUnavailableError) {
        fastify.log.error(ctx, err.message);
        return reply.status(503).send({
          error: { code: "PDF_UNAVAILABLE", message: err.message },
        });
      }
      if (err instanceof InvalidKindError) {
        return reply.status(400).send({
          error: { code: "INVALID_KIND", message: err.message },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err, ...ctx }, "brain file upload failed");
      return reply.status(500).send({
        error: { code: "INGEST_FAILED", message },
      });
    }
  });
}
