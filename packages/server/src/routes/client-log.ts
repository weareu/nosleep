/**
 * POST /api/client-log — clients (mobile, web) report runtime errors,
 * fetch failures, and any other diagnostic event. Server logs them as
 * structured pino entries so we can grep `~/.nosleep/server.log` for
 * mobile failures without remote debugging.
 *
 * Schema kept loose on purpose — clients may add fields freely. Only
 * level, source, message are required.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const bodySchema = z.object({
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  source: z.string().min(1).max(64),
  message: z.string().min(1).max(4000),
  stack: z.string().max(20000).optional(),
  context: z.record(z.unknown()).optional(),
  app: z.string().max(64).optional(),
  appVersion: z.string().max(32).optional(),
  platform: z.string().max(32).optional(),
});

export function registerClientLogRoute(fastify: FastifyInstance): void {
  // Bypass rate limiting — error reports are precisely the thing we DON'T
  // want to drop under load.
  fastify.post(
    "/api/client-log",
    { config: { rateLimit: false } },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.message,
        });
      }
      const { level, source, message, stack, context, app, appVersion, platform } =
        parsed.data;

      const logFn = fastify.log[level] ?? fastify.log.info;
      logFn.call(
        fastify.log,
        {
          client: app ?? "unknown",
          clientVersion: appVersion,
          clientPlatform: platform,
          clientSource: source,
          clientContext: context,
          stack,
        },
        `[client-log] ${message}`,
      );

      return reply.status(204).send();
    },
  );
}
