/**
 * POST /api/brain/capture-url
 * Phase 1: mode='ref' only. Creates a reference/link artifact with og-tag
 * metadata. Full-mode (Readability → markdown + embedding) lands in Phase 3.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ingest } from "../ingest/pipeline.js";
import { fetchRef, normaliseUrl } from "../extractors/url-fetcher-ref.js";
import { captureUrlFull } from "../extractors/url-fetcher-full.js";
import { captureThought } from "../thoughts/capture.js";
import { ThoughtType } from "../thoughts/types.js";
import { assertOrgMatches } from "../../auth.js";

const body = z.object({
  url: z.string().url(),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  mode: z.enum(["ref", "full"]).default("full"),
  note: z.string().max(10_000).optional(),
  tags: z.array(z.string().max(64)).optional(),
  thought_type_hint: ThoughtType.optional(),
});

export function registerBrainCaptureUrlRoutes(
  fastify: FastifyInstance,
): void {
  fastify.post("/api/brain/capture-url", async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "MISSING_FIELD", message: parsed.error.message },
      });
    }
    const req = parsed.data;
    // Cross-org binding, same as /api/brain/ingest (was missing here).
    if (!assertOrgMatches(request, reply, req.org_id)) return;
    const ctx = { url: req.url, org_id: req.org_id, project_id: req.project_id, mode: req.mode };

    const refResult = await captureRef(req);
    let fetchHash: string | null = null;
    let fetchError: string | null = null;
    let articleLength = 0;
    let pages: Array<{ page: number; hash: string }> | undefined;

    if (req.mode === "full") {
      const fullResult = await captureUrlFull({
        url: req.url,
        org_id: req.org_id,
        project_id: req.project_id,
        link_hash: refResult.link_hash,
        tags: req.tags,
        distill: true,
        onWarn: (msg, err) => fastify.log.warn({ err, ...ctx }, msg),
      });
      fetchHash = fullResult.fetch_hash;
      fetchError = fullResult.error;
      articleLength = fullResult.article_length;
      pages = fullResult.pages;
      if (fetchError) {
        fastify.log.warn({ ...ctx, fetch_error: fetchError, fetch_hash: fetchHash }, "brain capture-url: full fetch incomplete");
      }
    }

    // If caller provided a note, capture it as a thought with bridge refs
    // to the link (and fetch if full mode landed).
    let thoughtId: string | null = null;
    if (req.note && req.note.trim()) {
      const sourceRefs: Array<{ hash: string; relation: string }> = [
        { hash: refResult.link_hash, relation: "references" },
      ];
      if (fetchHash) {
        sourceRefs.push({ hash: fetchHash, relation: "quoted" });
      }
      try {
        const thought = captureThought({
          content: req.note.trim(),
          org_id: req.org_id,
          project_id: req.project_id,
          source_kind: "url_capture",
          source_refs: sourceRefs,
          thought_type_hint: req.thought_type_hint,
        });
        thoughtId = thought.id;
      } catch (err) {
        // Non-fatal — the URL capture still stands — but never silent.
        fastify.log.warn({ err, ...ctx }, "brain capture-url: note thought capture failed");
      }
    }

    const response: Record<string, unknown> = {
      ...refResult,
      thought_id: thoughtId,
    };
    if (req.mode === "full") {
      response.fetch_hash = fetchHash;
      response.article_length = articleLength;
      response.fetch_enqueued = fetchHash !== null;
      response.fetch_error = fetchError;
      if (pages) response.pages = pages;
    }
    reply.status(202).send(response);
  });
}

async function captureRef(req: {
  url: string;
  org_id: string;
  project_id: string;
  note?: string;
  tags?: string[];
  thought_type_hint?: string;
}): Promise<{
  link_hash: string;
  normalized_url: string;
  status: number;
  title: string | null;
  og_image: string | null;
  error: string | null;
}> {
  const meta = await fetchRef(req.url);

  const kindSpecific = {
    url: meta.url,
    normalized_url: meta.normalized_url,
    status: meta.status,
    title: meta.title,
    description: meta.description,
    og_image: meta.og_image,
    og_site_name: meta.og_site_name,
    author: meta.author,
    domain: meta.domain,
    language: meta.language,
    fetched_at: meta.fetched_at,
    body_hash: meta.body_hash,
    truncated: meta.truncated,
    tags: req.tags ?? [],
    fetch_error: meta.error,
  };

  // Content for hash purposes = normalised URL string (so re-capturing same
  // URL dedupes via artifact hash).
  const result = ingest({
    kind: "reference/link",
    content: meta.normalized_url,
    content_type: "text/plain",
    org_id: req.org_id,
    project_id: req.project_id,
    origin: { tool: "brain-api", version: "0.1", actor: "capture_url" },
    kind_specific_meta: kindSpecific,
    schema_version: 1,
  });

  void normaliseUrl; // keep import referenced for re-exports

  return {
    link_hash: result.hash,
    normalized_url: meta.normalized_url,
    status: meta.status,
    title: meta.title,
    og_image: meta.og_image,
    error: meta.error,
  };
}
