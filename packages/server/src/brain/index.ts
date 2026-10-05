/**
 * Brain wiring entry point. Called from server.ts during boot.
 * Registers all brain routes onto the Fastify instance.
 */

import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { registerBrainIngestRoutes } from "./routes/ingest.js";
import { registerBrainHealthRoutes } from "./routes/health.js";
import { registerBrainHookIngestRoutes } from "./routes/hook-ingest.js";
import { registerBrainSearchRoutes } from "./routes/search.js";
import { registerBrainArtifactRoutes } from "./routes/artifacts.js";
import { registerBrainSessionRoutes } from "./routes/sessions.js";
import { registerBrainCaptureUrlRoutes } from "./routes/capture-url.js";
import { registerBrainThoughtsRoutes } from "./routes/thoughts.js";
import { registerBrainEntityRoutes } from "./routes/entities.js";
import { registerBrainImageListRoutes } from "./routes/images.js";
import { registerBrainCodeRoutes } from "./routes/code.js";
import { registerBrainGraphRoutes } from "./routes/graph.js";
import { registerBrainAdminRoutes } from "./routes/admin.js";
import { registerBrainExportRoutes } from "./routes/export.js";
import { registerBrainSuggestionRoutes } from "./routes/suggestions.js";
import { registerBrainMergeQueueRoutes } from "./routes/merge-queue.js";
import { registerBrainOpenCodeRoutes } from "./routes/opencode-webhook.js";
import { registerBrainOverviewRoutes } from "./routes/overview.js";
import { getBrainRoot } from "./config.js";
import { bootstrapBrainProviders } from "./bootstrap-providers.js";

export function registerBrain(fastify: FastifyInstance, mainDb?: Database.Database): void {
  fastify.log.info({ brainRoot: getBrainRoot() }, "brain: initialising");
  registerBrainIngestRoutes(fastify);
  registerBrainHookIngestRoutes(fastify, mainDb);
  registerBrainHealthRoutes(fastify);
  registerBrainSearchRoutes(fastify);
  registerBrainArtifactRoutes(fastify);
  registerBrainSessionRoutes(fastify);
  registerBrainCaptureUrlRoutes(fastify);
  registerBrainThoughtsRoutes(fastify);
  registerBrainEntityRoutes(fastify);
  registerBrainImageListRoutes(fastify);
  registerBrainCodeRoutes(fastify);
  registerBrainGraphRoutes(fastify, mainDb);
  registerBrainAdminRoutes(fastify);
  registerBrainExportRoutes(fastify);
  registerBrainSuggestionRoutes(fastify);
  registerBrainMergeQueueRoutes(fastify);
  registerBrainOpenCodeRoutes(fastify);
  registerBrainOverviewRoutes(fastify);
  fastify.log.info("brain: routes registered");

  // Fire-and-forget provider bootstrap. Server boot doesn't wait — if a
  // provider takes a while to probe (e.g. claude CLI version check), the
  // ingest path is already up and queues catch up once providers are active.
  void bootstrapBrainProviders(fastify.log);
}
