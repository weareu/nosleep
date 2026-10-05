/**
 * Graceful shutdown + crash safety handlers.
 *
 * Signal handling: SIGINT/SIGTERM trigger orderly shutdown of the scheduler,
 * discovery beacon, websocket heartbeat, all active sessions, and the DB.
 *
 * Crash safety: process.on('unhandledRejection') and 'uncaughtException'
 * convert what would otherwise kill the server into structured log entries.
 * The supervision loop and vector indexer can throw at unexpected times;
 * without these handlers, one stray async failure takes the whole server down.
 */

import type { FastifyInstance } from "fastify";
import { closeDb } from "./db/connection.js";
import { shutdownHeartbeat } from "./websocket/broadcast.js";
import type { Services } from "./services/init.js";

export interface ShutdownDeps {
  readonly fastify: FastifyInstance;
  readonly services: Services;
  readonly getDiscoveryBeacon: () => { stop: () => void } | null;
}

export function registerShutdown(deps: ShutdownDeps): void {
  const shutdown = async (): Promise<void> => {
    deps.fastify.log.info("shutting down");
    deps.services.taskScheduler.stop();
    deps.getDiscoveryBeacon()?.stop();
    shutdownHeartbeat();
    await deps.services.sessionManager.shutdownAll();
    closeDb();
    await deps.fastify.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("unhandledRejection", (reason, promise) => {
    deps.fastify.log.error({ err: reason, promise }, "[crash-safety] unhandled rejection");
  });
  process.on("uncaughtException", (err) => {
    deps.fastify.log.error({ err }, "[crash-safety] uncaught exception");
  });
}
