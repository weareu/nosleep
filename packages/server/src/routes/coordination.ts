import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Coordinator } from "../coordination/coordinator.js";

const sendMessageSchema = z.object({
  fromSessionId: z.string(),
  toSessionId: z.string().nullable().optional(),
  orgId: z.string(),
  type: z.enum(["discovery", "request", "handoff", "conflict", "info"]),
  payload: z.string(),
});

const lockFileSchema = z.object({
  sessionId: z.string(),
  orgId: z.string(),
  filePath: z.string(),
});

export function registerCoordinationRoutes(
  fastify: FastifyInstance,
  coordinator: Coordinator,
): void {
  // GET /api/coordination/locks?orgId=
  fastify.get("/api/coordination/locks", async (request) => {
    const { orgId } = request.query as { orgId?: string };
    const locks = coordinator.getActiveLocks(orgId || undefined);
    return { success: true, data: locks };
  });

  // GET /api/coordination/messages?orgId=&limit=
  fastify.get("/api/coordination/messages", async (request) => {
    const { orgId, limit } = request.query as { orgId?: string; limit?: string };
    if (!orgId) {
      return { success: false, error: "orgId is required" };
    }
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const messages = coordinator.getMessageLog(orgId, parsedLimit);
    return { success: true, data: messages };
  });

  // GET /api/coordination/peers?orgId=
  fastify.get("/api/coordination/peers", async (request) => {
    const { orgId } = request.query as { orgId?: string };
    const peers = coordinator.getActivePeers(orgId || undefined);
    return { success: true, data: peers };
  });

  // POST /api/coordination/messages
  fastify.post("/api/coordination/messages", async (request, reply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    const { fromSessionId, toSessionId, orgId, type, payload } = parsed.data;
    const id = coordinator.sendMessage(fromSessionId, toSessionId ?? null, orgId, type, payload);
    return { success: true, data: { id } };
  });

  // POST /api/coordination/locks
  fastify.post("/api/coordination/locks", async (request, reply) => {
    const parsed = lockFileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }
    const { sessionId, orgId, filePath } = parsed.data;
    const result = coordinator.lockFile(sessionId, orgId, filePath);
    if (!result.success) {
      return reply.status(409).send({ success: false, error: "File already locked", holder: result.holder });
    }
    return { success: true };
  });

  // DELETE /api/coordination/locks/:id — admin release
  fastify.delete("/api/coordination/locks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = fastify.listeningOrigin; // just need db access via coordinator
    // Direct SQL for admin release by lock ID
    const stmt = `UPDATE file_locks SET released_at = datetime('now') WHERE id = ? AND released_at IS NULL`;
    // We need db access — coordinator doesn't expose raw db, so use a targeted method
    // For admin release, we query the lock first then release by session+path
    // Actually, let's just add the update directly since coordinator has the db
    // We'll call through coordinator's unlock pattern
    try {
      // Use a simple approach: the coordinator exposes getActiveLocks, find the lock and release
      const allLocks = coordinator.getActiveLocks();
      const lock = allLocks.find((l) => l.id === id);
      if (!lock) {
        return reply.status(404).send({ success: false, error: "Lock not found or already released" });
      }
      coordinator.unlockFile(lock.sessionId, lock.filePath);
      return { success: true };
    } catch (err) {
      return reply.status(500).send({ success: false, error: "Failed to release lock" });
    }
  });
}
