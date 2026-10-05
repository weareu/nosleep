/**
 * Route registration. Wires every route module against the service container
 * so server.ts doesn't need to know about each one individually.
 *
 * Adding a new route: import the registerXRoutes function and call it here.
 */

import type { FastifyInstance } from "fastify";
import type { Services } from "../services/init.js";
import { registerOrgRoutes } from "./orgs.js";
import { registerAccountRoutes } from "./accounts.js";
import { registerProjectRoutes } from "./projects.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerAlertRoutes } from "./alerts.js";
import { registerHookCallbackRoutes } from "./hooks-callback.js";
import { registerHookManageRoutes } from "./hooks-manage.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerStrategyRoutes } from "./strategy.js";
import { registerMetricsRoutes } from "./metrics.js";
import { registerResearchRoutes } from "./research.js";
import { registerSystemRoutes } from "./system.js";
import { registerCoordinationRoutes } from "./coordination.js";
import { registerScheduledTaskRoutes } from "./scheduled-tasks.js";
import { registerSearchRoutes } from "./search.js";
import { registerPushRoutes } from "./push.js";
import { registerClientLogRoute } from "./client-log.js";

export function registerAllRoutes(fastify: FastifyInstance, services: Services): void {
  const { db, sessionManager, supervisionLoop, budgetPacer, treeManager, coordinator, taskScheduler, vectorIndexer, pushService } = services;

  registerOrgRoutes(fastify, db);
  registerAccountRoutes(fastify, db);
  registerProjectRoutes(fastify, db);
  registerSessionRoutes(fastify, db, sessionManager, supervisionLoop, budgetPacer);
  registerAlertRoutes(fastify, db);
  registerHookCallbackRoutes(fastify, db, supervisionLoop.messageQueue, supervisionLoop.eventStore, coordinator);
  registerHookManageRoutes(fastify, db);
  registerAnalyticsRoutes(fastify, db, budgetPacer);
  registerStrategyRoutes(fastify, db, treeManager);
  registerMetricsRoutes(fastify, db);
  registerResearchRoutes(fastify, db);
  registerSystemRoutes(fastify);
  registerCoordinationRoutes(fastify, coordinator);
  registerScheduledTaskRoutes(fastify, db, taskScheduler);
  registerSearchRoutes(fastify, db, vectorIndexer);
  registerPushRoutes(fastify, db, pushService);
  registerClientLogRoute(fastify);
}
