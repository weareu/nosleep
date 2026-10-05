import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { PushService } from "../notifications/push-service.js";

const registerSchema = z.object({
  pushToken: z.string().min(1),
  orgFilter: z.string().optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
});

const unregisterSchema = z.object({
  pushToken: z.string().min(1),
});

export function registerPushRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  pushService: PushService,
): void {
  // POST /api/push/register
  fastify.post("/api/push/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: parsed.error.message });
    }

    const { pushToken, orgFilter, platform } = parsed.data;
    const result = pushService.registerDevice(
      pushToken,
      orgFilter ?? null,
      platform ?? "ios",
    );

    return { success: true, data: result };
  });

  // DELETE /api/push/unregister
  fastify.delete("/api/push/unregister", async (request, reply) => {
    const parsed = unregisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: parsed.error.message });
    }

    pushService.unregisterDevice(parsed.data.pushToken);
    return { success: true };
  });
}
