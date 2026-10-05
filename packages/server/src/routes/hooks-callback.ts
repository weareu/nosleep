import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { eventBus } from "../event-bus.js";
import type { SessionMessageQueue } from "../orchestrator/message-queue.js";
import type { SessionEventStore } from "../events/session-event-store.js";
import type { Coordinator } from "../coordination/coordinator.js";
import { ingest as brainIngest } from "../brain/ingest/pipeline.js";
import {
  fromPreTool,
  fromPostTool,
  fromPreCompact,
  fromStop,
} from "../brain/hooks/handlers.js";
import type { IngestRequestT } from "../brain/ingest/types.js";
import { ingestReadDocument } from "../brain/hooks/read-document.js";

const preToolSchema = z.object({
  orgId: z.string().optional(),
  sessionId: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
});

const postToolSchema = z.object({
  orgId: z.string().optional(),
  sessionId: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
  toolResult: z.string().optional(),
});

const preCompactSchema = z.object({
  orgId: z.string().optional(),
  sessionId: z.string().optional(),
  summary: z.string().optional(),
});

const stopSchema = z.object({
  orgId: z.string().optional(),
  sessionId: z.string().optional(),
  stopReason: z.string().optional(),
});

/**
 * HTTP endpoints that Claude Code hooks call back to.
 * Registered as a Fastify plugin so the preHandler hook is scoped
 * to only these callback routes (not the management routes).
 */
export function registerHookCallbackRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  messageQueue: SessionMessageQueue,
  eventStore?: SessionEventStore,
  coordinator?: Coordinator,
): void {
  // Helper: log event if event store exists
  function log(sessionId: string, type: Parameters<SessionEventStore["record"]>[1], payload: Record<string, unknown> = {}): void {
    eventStore?.record(sessionId, type, payload);
  }

  // Helper: forward translated artifacts to brain. Never throws — isolate from primary flow.
  function brainFanOut(items: IngestRequestT[]): void {
    for (const item of items) {
      try {
        brainIngest(item);
      } catch (err) {
        fastify.log.warn({ err, kind: item.kind }, "brain ingest failed (non-fatal)");
      }
    }
  }

  // Resolve project_id for a session — brain needs it but the hook payload doesn't carry it directly.
  function projectIdFor(sessionId: string): string | undefined {
    const row = db
      .prepare("SELECT project_id FROM sessions WHERE id = ?")
      .get(sessionId) as { project_id: string } | undefined;
    return row?.project_id;
  }

  fastify.register(async (scope) => {

    // ── PreToolUse callback ─────────────────────────────────
    scope.post("/api/hooks/pre-tool", async (request, reply) => {
      const parsed = preToolSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.message });
      }
      const body = parsed.data;

      if (!body.sessionId) return {};

      const session = db.prepare(`
        SELECT s.id, s.tokens_used, p.token_budget
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.id = ?
      `).get(body.sessionId) as { id: string; tokens_used: number; token_budget: number } | undefined;

      if (!session) return {};

      // Tool use logged in PostToolUse (not here — avoid double-logging)

      const messages: string[] = [];

      // First tool call for manual sessions: inject autonomy directive (once only)
      const alreadyInjected = db.prepare(
        `SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'autonomy_injected' LIMIT 1`
      ).get(body.sessionId);
      if (body.sessionId.startsWith("manual_") && !alreadyInjected) {
        // Resolve project info for context
        const projInfo = db.prepare(`
          SELECT p.id, p.name, p.org_id FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?
        `).get(body.sessionId) as { id: string; name: string; org_id: string } | undefined;
        const projCtx = projInfo ? `Project: ${projInfo.name} (ID: ${projInfo.id}, Org: ${projInfo.org_id})\n\n` : "";

        messages.push(
          `${projCtx}NoSleep active. Use "nosleep" MCP tool. If busy, continue. If idle, call nosleep(action="strategy_next"). If blocked, call nosleep(action="request_help").`
        );
        log(body.sessionId, "autonomy_injected", { manual: true });
      }

      // Agent is asking a question — use Haiku to classify and respond
      if (body.toolName === "AskUserQuestion" || body.toolName === "AskFollowupQuestion") {
        const question = (body.toolInput?.question as string) ?? "";
        log(body.sessionId, "question_detected", { question: question.slice(0, 500) });

        const sessionInfo = db.prepare(`
          SELECT s.project_id, s.goal_text, p.org_id FROM sessions s
          JOIN projects p ON s.project_id = p.id WHERE s.id = ?
        `).get(body.sessionId) as { project_id: string; goal_text: string; org_id: string } | undefined;

        if (sessionInfo) {
          const { respondToQuestion } = await import("../focus/question-responder.js");
          const result = await respondToQuestion(db, {
            question,
            sessionId: body.sessionId,
            projectId: sessionInfo.project_id,
            orgId: sessionInfo.org_id,
            goalText: sessionInfo.goal_text,
          });
          messages.push(`HUMAN RESPONSE: ${result.response}`);
          log(body.sessionId, "question_response", {
            action: result.action,
            response: result.response.slice(0, 500),
          });
        } else {
          messages.push("HUMAN RESPONSE: Continue autonomously. Make your own decisions.");
          log(body.sessionId, "question_response", { action: "continue", fallback: true });
        }
      }

      // Budget warnings
      if (session.token_budget > 0) {
        const budgetPct = (session.tokens_used / session.token_budget) * 100;
        if (budgetPct >= 95) {
          messages.push(`WARNING: Token budget at ${Math.round(budgetPct)}%. Wrap up your current task immediately.`);
          log(body.sessionId, "budget_warning", { pct: Math.round(budgetPct), level: "critical" });
        } else if (budgetPct >= 80) {
          messages.push(`Note: Token budget at ${Math.round(budgetPct)}%. Start wrapping up.`);
          log(body.sessionId, "budget_warning", { pct: Math.round(budgetPct), level: "warning" });
        }
      }

      // Drain queued supervision messages
      const queued = messageQueue.drain(body.sessionId);
      if (queued) {
        messages.push(queued);
        log(body.sessionId, "goal_injected", { source: "message_queue", length: queued.length });
      }

      // File lock check for Edit/Write tools
      if (coordinator && body.orgId && (body.toolName === "Edit" || body.toolName === "Write")) {
        const filePath = body.toolInput?.file_path as string | undefined;
        if (filePath) {
          const lock = coordinator.checkFileLock(body.orgId, filePath);
          if (lock && lock.sessionId !== body.sessionId) {
            messages.push(
              `WARNING: File "${filePath}" is locked by session ${lock.sessionId} (since ${lock.lockedAt}). Editing may cause conflicts.`,
            );
            log(body.sessionId, "file_lock_warning", { filePath, holder: lock.sessionId });
          }
        }
      }

      // Drain coordination inbox messages
      if (coordinator && body.orgId) {
        const inboxCount = coordinator.peekInbox(body.sessionId, body.orgId);
        if (inboxCount > 0) {
          const inboxMessages = coordinator.getInbox(body.sessionId, body.orgId);
          const limited = inboxMessages.slice(0, 5);
          for (const msg of limited) {
            messages.push(
              `[coordination:${msg.type}] from session ${msg.fromSessionId}: ${msg.payload}`,
            );
          }
          log(body.sessionId, "coordination_message", { count: limited.length, total: inboxCount });
        }
      }

      // Brain fan-out (non-fatal). Capture the tool_call artifact.
      if (body.orgId && body.toolName) {
        const projectId = projectIdFor(body.sessionId);
        if (projectId) {
          brainFanOut(
            fromPreTool({
              orgId: body.orgId,
              sessionId: body.sessionId,
              toolName: body.toolName,
              toolInput: body.toolInput,
              projectId,
            }),
          );
        }
      }

      if (messages.length > 0) {
        return { message: messages.join("\n\n") };
      }

      return {};
    });

    // ── PostToolUse callback ────────────────────────────────
    scope.post("/api/hooks/post-tool", async (request, reply) => {
      const parsed = postToolSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.message });
      }
      const body = parsed.data;

      if (!body.sessionId) return {};

      db.prepare(`UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?`)
        .run(body.sessionId);

      // A tool event is proof of life — resurrect a manual row the stale
      // sweep parked in 'stopped'/'idle' while the CLI session kept running
      // (long-lived interactive sessions go quiet >2h, get swept, then
      // resume; without this they stay invisible on the dashboard forever).
      db.prepare(`
        UPDATE sessions SET status = 'running', ended_at = NULL
        WHERE id = ? AND id LIKE 'manual_%' AND status IN ('stopped', 'idle')
      `).run(body.sessionId);

      // Log tool completion
      log(body.sessionId, "tool_use", { tool: body.toolName, phase: "post" });

      // Emit tool usage event so supervision can track even via hook path
      if (body.toolName) {
        eventBus.emit("session:output", body.sessionId, `[tool: ${body.toolName}]`);
      }

      // Brain fan-out (non-fatal). Tool-specific artifact from tool result.
      if (body.orgId && body.toolName) {
        const projectId = projectIdFor(body.sessionId);
        if (projectId) {
          const payload = {
            orgId: body.orgId,
            sessionId: body.sessionId,
            toolName: body.toolName,
            toolInput: body.toolInput,
            toolResult: body.toolResult,
            projectId,
          };
          brainFanOut(fromPostTool(payload));
          void ingestReadDocument(payload, (msg, ctx) => fastify.log.warn(ctx, msg));
        }
      }

      // Auto-detect plan files written by Write tool → emit for ingestion
      if (body.toolName === "Write" && body.toolInput?.file_path) {
        const filePath = body.toolInput.file_path as string;
        if (/\/(plans|architecture)\/.*\.md$/i.test(filePath)) {
          const session = db.prepare(`SELECT project_id, p.org_id FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?`).get(body.sessionId) as { project_id: string; org_id: string } | undefined;
          if (session) {
            const root = db.prepare(`SELECT id FROM strategy_nodes WHERE project_id = ? AND parent_id IS NULL`).get(session.project_id) as { id: string } | undefined;
            if (root) {
              eventBus.emit("plan:detected", {
                filePath,
                projectId: session.project_id,
                orgId: session.org_id,
                sessionId: body.sessionId,
              });
              log(body.sessionId, "plan_ingested", { filePath });
            }
          }
        }
      }

      return {};
    });

    // ── PreCompact callback ──────────────────────────────────
    scope.post("/api/hooks/pre-compact", async (request, reply) => {
      const parsed = preCompactSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.message });
      }
      const body = parsed.data;

      if (!body.sessionId) return {};

      log(body.sessionId, "compaction_detected", {
        summary: body.summary?.slice(0, 2000),
        source: "pre-compact-hook",
      });

      // Brain fan-out (non-fatal). Capture compaction snapshot.
      if (body.orgId && body.summary) {
        const projectId = projectIdFor(body.sessionId);
        if (projectId) {
          brainFanOut(
            fromPreCompact({
              orgId: body.orgId,
              sessionId: body.sessionId,
              summary: body.summary,
              projectId,
            }),
          );
        }
      }

      // Store the pre-compaction summary in the goal record for recovery
      if (body.summary) {
        const result = db.prepare(`
          UPDATE goals SET current_phase = 'post-compaction'
          WHERE session_id = ? AND id = (
            SELECT id FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
          )
        `).run(body.sessionId, body.sessionId);
        if (result.changes === 0) {
          fastify.log.warn(`Pre-compact: no goal found for session ${body.sessionId}`);
        }
      }

      return {};
    });

    // ── Stop callback ───────────────────────────────────────
    scope.post("/api/hooks/stop", async (request, reply) => {
      const parsed = stopSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: parsed.error.message });
      }
      const body = parsed.data;

      if (!body.sessionId || !body.orgId) return {};

      const current = db.prepare(`SELECT status, id FROM sessions WHERE id = ?`)
        .get(body.sessionId) as { status: string; id: string } | undefined;

      if (!current || current.status === "completed" || current.status === "failed") {
        return {};
      }

      // For manual sessions: don't mark completed on normal exit — just update activity.
      // The stale session cleanup (2hr idle) will handle it.
      // Only mark completed if there's an explicit stop reason indicating real completion.
      const isManual = body.sessionId.startsWith("manual_");
      const hasRealStopReason = body.stopReason && body.stopReason !== "end_turn" && body.stopReason !== "user_cancelled";

      if (isManual && !hasRealStopReason) {
        // Manual session normal exit — just log, don't try to decide or inject
        log(body.sessionId, "session_completed", { stopReason: body.stopReason ?? "normal_exit", source: "hook" });
        return {};
      }

      db.prepare(`UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?`)
        .run(body.sessionId);

      log(body.sessionId, "session_completed", { stopReason: body.stopReason, source: "hook" });

      // Build a useful alert message with project name and goal
      const sessionDetail = db.prepare(`
        SELECT s.goal_text, p.name as project_name, s.tokens_used
        FROM sessions s JOIN projects p ON s.project_id = p.id
        WHERE s.id = ?
      `).get(body.sessionId) as { goal_text: string; project_name: string; tokens_used: number } | undefined;

      const goalSummary = sessionDetail?.goal_text?.slice(0, 100) ?? "Unknown";
      const projectName = sessionDetail?.project_name ?? "Unknown";
      const tokens = sessionDetail?.tokens_used ?? 0;
      const reason = body.stopReason ? ` (${body.stopReason})` : "";
      const alertMsg = `${projectName}: "${goalSummary}"${goalSummary.length >= 100 ? "..." : ""}${reason} — ${tokens.toLocaleString()} tokens`;

      db.prepare(`
        INSERT INTO alerts (org_id, session_id, project_id, type, severity, message)
        SELECT ?, ?, s.project_id, 'session_complete', 'info', ?
        FROM sessions s WHERE s.id = ?
      `).run(body.orgId, body.sessionId, alertMsg, body.sessionId);

      // Brain fan-out (non-fatal). Capture session_end marker.
      const projectId = projectIdFor(body.sessionId);
      if (projectId) {
        brainFanOut(
          fromStop({
            orgId: body.orgId,
            sessionId: body.sessionId,
            stopReason: body.stopReason,
            projectId,
          }),
        );
      }

      return {};
    });
  });
}
