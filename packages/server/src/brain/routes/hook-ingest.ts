/**
 * Hook-ingest adapter routes. Accept the existing Claude Code hook callback
 * payloads and translate them to brain IngestRequest shape, then run through
 * the brain pipeline. Decoupled from the primary /api/brain/ingest endpoint
 * so hook payload evolution doesn't affect the public ingest contract.
 *
 * BUG FIX (Phase 22): hook payloads don't carry projectId. Previously the
 * transcript path defaulted to `_org_level` and the other handlers silently
 * dropped requests when projectId was missing — that's how 622 thoughts +
 * 2733 artifacts ended up mis-attributed to the `_org_level` sentinel in
 * the personal org. Now we resolve project_id from sessionId via the main
 * sessions table when the hook doesn't provide it.
 */

import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  fromPreTool,
  fromPostTool,
  fromPreCompact,
  fromStop,
  fromUserPrompt,
} from "../hooks/handlers.js";
import { ingestTranscriptOffThread, ingestArtifactsOffThread } from "../ingest/transcript-worker-client.js";
import type { IngestRequestT } from "../ingest/types.js";

const hookBase = {
  orgId: z.string().optional(),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  turnOrd: z.number().int().optional(),
  actor: z.string().optional(),
  toolVersion: z.string().optional(),
};

const userPromptSchema = z.object({ ...hookBase, prompt: z.string().optional() });
const preToolSchema = z.object({
  ...hookBase,
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
});
const postToolSchema = z.object({
  ...hookBase,
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
  toolResult: z.string().optional(),
});
const preCompactSchema = z.object({ ...hookBase, summary: z.string().optional() });
const stopSchema = z.object({ ...hookBase, stopReason: z.string().optional() });
const transcriptSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().optional(),
  sessionId: z.string().min(1),
  transcriptPath: z.string().min(1),
});

/**
 * Queue a batch of IngestRequests to the brain worker, fire-and-forget.
 * These used to run pipeline.ingest() inline on the MAIN thread — a giant
 * prompt/tool-result blocked the event loop up to 117s (2026-07-15 log).
 * Hooks never consume the hashes, so the route acks immediately with the
 * queued count; failures are logged, not returned.
 */
function queueBatch(items: IngestRequestT[], logErr: (msg: string) => void): { queued: number } {
  if (items.length > 0) {
    void ingestArtifactsOffThread(items)
      .then((r) => {
        if (r.errors.length > 0) logErr(`hook ingest: ${r.errors.length}/${items.length} failed: ${r.errors[0]}`);
      })
      .catch((err) => logErr(`hook ingest batch failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return { queued: items.length };
}

export function registerBrainHookIngestRoutes(
  fastify: FastifyInstance,
  mainDb?: Database.Database,
): void {
  /** Resolve project_id from sessionId. Returns null if no session or no main db. */
  const projectIdFor = (sessionId: string | undefined): string | null => {
    if (!sessionId || !mainDb) return null;
    try {
      const row = mainDb
        .prepare("SELECT project_id FROM sessions WHERE id = ?")
        .get(sessionId) as { project_id: string } | undefined;
      return row?.project_id ?? null;
    } catch {
      return null;
    }
  };

  /** Hydrate payload.projectId from session if missing. Mutates a copy. */
  const withProject = <T extends { projectId?: string; sessionId?: string }>(p: T): T => {
    if (p.projectId) return p;
    const resolved = projectIdFor(p.sessionId);
    if (resolved) return { ...p, projectId: resolved };
    return p;
  };

  fastify.post("/api/brain/hook-ingest/user-prompt", async (req) => {
    const p = userPromptSchema.safeParse(req.body);
    if (!p.success) return { ok: false, error: p.error.message };
    return { ok: true, ...queueBatch(fromUserPrompt(withProject(p.data)), (m) => fastify.log.warn(m)) };
  });

  fastify.post("/api/brain/hook-ingest/pre-tool", async (req) => {
    const p = preToolSchema.safeParse(req.body);
    if (!p.success) return { ok: false, error: p.error.message };
    return { ok: true, ...queueBatch(fromPreTool(withProject(p.data)), (m) => fastify.log.warn(m)) };
  });

  fastify.post("/api/brain/hook-ingest/post-tool", async (req) => {
    const p = postToolSchema.safeParse(req.body);
    if (!p.success) return { ok: false, error: p.error.message };
    return { ok: true, ...queueBatch(fromPostTool(withProject(p.data)), (m) => fastify.log.warn(m)) };
  });

  fastify.post("/api/brain/hook-ingest/pre-compact", async (req) => {
    const p = preCompactSchema.safeParse(req.body);
    if (!p.success) return { ok: false, error: p.error.message };
    return { ok: true, ...queueBatch(fromPreCompact(withProject(p.data)), (m) => fastify.log.warn(m)) };
  });

  fastify.post("/api/brain/hook-ingest/stop", async (req) => {
    const p = stopSchema.safeParse(req.body);
    if (!p.success) return { ok: false, error: p.error.message };
    return { ok: true, ...queueBatch(fromStop(withProject(p.data)), (m) => fastify.log.warn(m)) };
  });

  // Phase 12 — transcript ingester. Fires from the Stop hook to lift
  // every user/assistant turn out of the JSONL transcript file. Idempotent
  // via content-addressed dedup, so re-running is safe and cheap.
  fastify.post("/api/brain/hook-ingest/transcript", async (req) => {
    const p = transcriptSchema.safeParse(req.body);
    if (!p.success) return { ok: false, error: p.error.message };
    // Resolve project from session, falling back to the explicit
    // projectId (if the caller has one) and only as a last resort to
    // `_org_level`. This is what stopped the 622-thought mis-attribution.
    const resolvedProject =
      p.data.projectId ?? projectIdFor(p.data.sessionId) ?? "_org_level";
    // Off-thread: transcript parsing/ingest scales with transcript size and
    // blocked the main event loop up to 91s (watchdog kills). The worker
    // client falls back to inline ingest if the worker can't boot.
    const result = await ingestTranscriptOffThread({
      org_id: p.data.orgId,
      project_id: resolvedProject,
      session_id: p.data.sessionId,
      transcript_path: p.data.transcriptPath,
    });
    return { ok: true, ...result };
  });
}
