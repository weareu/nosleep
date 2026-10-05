/**
 * Phase 10 — OpenCode webhook adapter.
 *
 *   POST /api/brain/webhook/opencode
 *
 * OpenCode hasn't stabilised a public hook contract yet; we accept a
 * superset of plausible event shapes and map them to the same kind
 * taxonomy as Claude Code so downstream retrieval is uniform. Adapter
 * is forgiving: missing fields fall back to sensible defaults.
 *
 * Authentication uses the standard x-api-key as for /api/brain/ingest.
 * Source tool is recorded as 'opencode' so retrieval can filter by it.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ingest } from "../ingest/pipeline.js";
import type { IngestRequestT } from "../ingest/types.js";
import { assertOrgMatches, isLoopback } from "../../auth.js";
import { ingestReadDocument } from "../hooks/read-document.js";

const opencodeBase = {
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  turn_ord: z.number().int().optional(),
  ts: z.number().int().optional(),
  actor: z.string().optional(),
  tool_version: z.string().optional(),
};

/**
 * Single-event shape. OpenCode events we currently understand:
 *   - "user_message" / "prompt"           → conversation/turn/user
 *   - "assistant_message" / "response"    → conversation/turn/assistant
 *   - "tool_invoke" / "tool_call"         → tool_use/invocation
 *   - "tool_result" / "tool_response"     → tool_use/result
 *   - "compaction" / "summarise"          → system/compaction
 *   - "session_start" / "session_end"     → system/session_lifecycle
 * Anything else lands as conversation/turn/system.
 */
const opencodeEvent = z.object({
  ...opencodeBase,
  type: z.string().min(1),
  text: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.unknown()).optional(),
  tool_output: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const batchBody = z.object({
  events: z.array(opencodeEvent).min(1).max(500),
});

const KIND_MAP: Record<string, string> = {
  user_message: "conversation/turn/user",
  prompt: "conversation/turn/user",
  assistant_message: "conversation/turn/assistant",
  response: "conversation/turn/assistant",
  tool_invoke: "agent/mcp_call",
  tool_call: "agent/mcp_call",
  tool_result: "agent/mcp_result",
  tool_response: "agent/mcp_result",
  compaction: "workflow/supervision_event",
  summarise: "workflow/supervision_event",
  summarize: "workflow/supervision_event",
  session_start: "agent/agent_run",
  session_end: "agent/agent_run",
};

function mapKind(eventType: string): string {
  return KIND_MAP[eventType] ?? "conversation/turn/system";
}

function mapEvent(ev: z.infer<typeof opencodeEvent>): IngestRequestT {
  const kind = mapKind(ev.type);
  let content: string;
  if (kind === "agent/mcp_call") {
    content = JSON.stringify({
      tool: ev.tool_name ?? "unknown",
      input: ev.tool_input ?? {},
    });
  } else if (kind === "agent/mcp_result") {
    content = ev.tool_output ?? JSON.stringify(ev.metadata ?? {});
  } else {
    content = ev.text ?? JSON.stringify(ev.metadata ?? {});
  }
  return {
    kind,
    content,
    content_type: "text/plain",
    org_id: ev.org_id,
    project_id: ev.project_id,
    session_id: ev.session_id,
    turn_ord: ev.turn_ord,
    ts: ev.ts,
    origin: {
      tool: "opencode",
      version: ev.tool_version,
      actor: ev.actor,
    },
    kind_specific_meta: {
      opencode_event_type: ev.type,
      tool_name: ev.tool_name,
      tool_input: ev.tool_input,
      ...(ev.metadata ?? {}),
    },
    schema_version: 1,
  };
}

export function registerBrainOpenCodeRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/brain/webhook/opencode", async (request, reply) => {
    // Accept either a single event or a batch envelope. Coerce single → batch.
    const raw = request.body as unknown;
    const batchInput = (() => {
      if (raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events)) {
        return raw;
      }
      return { events: [raw] };
    })();

    const parsed = batchBody.safeParse(batchInput);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "MISSING_FIELD", message: parsed.error.message },
      });
    }

    // Phase 12 — every event's org_id must match the bound org of the
    // calling key when per-org-key auth is in use. Single rejected
    // event rejects the whole batch (a partial accept is worse than a
    // hard fail for security review).
    for (const ev of parsed.data.events) {
      if (!assertOrgMatches(request, reply, ev.org_id)) return;
    }

    // Phase 12 — cap batch size to keep the event loop responsive
    // (security review: 500 events × ingest = seconds of blocking).
    if (parsed.data.events.length > 50) {
      return reply.status(413).send({
        error: {
          code: "BATCH_TOO_LARGE",
          message: "max 50 events per batch — chunk your client",
        },
      });
    }

    const hashes: string[] = [];
    const errors: string[] = [];
    let dedup = 0;
    for (const ev of parsed.data.events) {
      try {
        const result = ingest(mapEvent(ev));
        hashes.push(result.hash);
        if (result.duplicate) dedup += 1;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    // Document Reads → document/* artifacts from disk (same path as the
    // Claude Code post-tool hook). Loopback only: a remote caller must not
    // be able to make the server read local files.
    if (isLoopback(request.ip)) {
      for (const ev of parsed.data.events) {
        if (ev.type !== "tool_result" && ev.type !== "tool_response") continue;
        if ((ev.tool_name ?? "").toLowerCase() !== "read") continue;
        const fp = ev.tool_input?.filePath ?? ev.tool_input?.file_path;
        if (typeof fp !== "string") continue;
        void ingestReadDocument(
          {
            toolName: "Read",
            toolInput: { file_path: fp },
            orgId: ev.org_id,
            projectId: ev.project_id,
            sessionId: ev.session_id,
            toolVersion: ev.tool_version,
            agent: "opencode",
          },
          (msg, ctx) => fastify.log.warn(ctx, msg),
        );
      }
    }

    reply.status(202).send({
      ok: true,
      ingested: hashes.length,
      duplicate: dedup,
      hashes,
      errors,
    });
  });
}

export { mapKind as opencodeMapKind, mapEvent as opencodeMapEvent };
