/**
 * Service container initialization. Wires every component the server needs
 * — database, supervision, sessions, scheduling, push, search, coordination —
 * into a single object that routes can import without tangled constructor
 * dependencies.
 *
 * Adding a new service: declare it on `Services` and instantiate it here.
 * Routes get it via the registerRoutes() function in routes/index.ts.
 */

import type { FastifyBaseLogger } from "fastify";
import type Database from "better-sqlite3";
import { getDb } from "../db/connection.js";
import { initializeVectorIndex } from "../db/schema.js";
import { createVectorIndexer, type VectorIndexer } from "../embeddings/vector-indexer.js";
import { SessionManager } from "../orchestrator/session-manager.js";
import { SupervisionLoop } from "../orchestrator/supervision-loop.js";
import { BudgetPacer } from "../budget/budget-pacer.js";
import { GoalInjector } from "../focus/goal-injector.js";
import { DriftDetector } from "../focus/drift-detector.js";
import { GoalManager } from "../focus/goal-manager.js";
import { CompletenessAnalyzer } from "../validator/completeness-analyzer.js";
import { RetryHandler } from "../validator/retry-handler.js";
import { OutputCollector } from "../validator/output-collector.js";
import { StrategyTreeManager } from "../strategy/tree-manager.js";
import { TaskScheduler } from "../scheduler/task-scheduler.js";
import { Coordinator } from "../coordination/coordinator.js";
import { PushService } from "../notifications/push-service.js";
import { startPlanIngester } from "../strategy/plan-ingester.js";

export interface Services {
  readonly db: Database.Database;
  readonly vectorIndexer: VectorIndexer;
  readonly budgetPacer: BudgetPacer;
  readonly treeManager: StrategyTreeManager;
  readonly supervisionLoop: SupervisionLoop;
  readonly sessionManager: SessionManager;
  readonly coordinator: Coordinator;
  readonly taskScheduler: TaskScheduler;
  readonly pushService: PushService;
}

export interface InitOptions {
  readonly dbPath: string;
  readonly logger: FastifyBaseLogger;
}

export function initServices(opts: InitOptions): Services {
  const db = getDb(opts.dbPath);

  // Vector index is best-effort — search becomes unavailable if the model can't load,
  // but the rest of the server keeps functioning.
  try {
    initializeVectorIndex(db);
  } catch (err) {
    opts.logger.warn({ err }, "failed to initialize vector index — search will be unavailable");
  }
  const vectorIndexer = createVectorIndexer(db);

  const budgetPacer = new BudgetPacer(db);
  const goalInjector = new GoalInjector(db);
  const driftDetector = new DriftDetector(db);
  const goalManager = new GoalManager(db);
  const completenessAnalyzer = new CompletenessAnalyzer(db, goalManager);
  const retryHandler = new RetryHandler();
  const outputCollector = new OutputCollector();
  const treeManager = new StrategyTreeManager(db);

  const supervisionLoop = new SupervisionLoop(
    db, goalInjector, driftDetector, goalManager,
    completenessAnalyzer, retryHandler, outputCollector, treeManager,
    budgetPacer,
  );
  const coordinator = new Coordinator(db);
  const sessionManager = new SessionManager(db, budgetPacer, supervisionLoop, coordinator);
  sessionManager.setVectorIndexer(vectorIndexer);

  const taskScheduler = new TaskScheduler(db, sessionManager);
  const pushService = new PushService(db);

  // Subscribe plan ingester to plan:detected events
  startPlanIngester(db);

  return {
    db,
    vectorIndexer,
    budgetPacer,
    treeManager,
    supervisionLoop,
    sessionManager,
    coordinator,
    taskScheduler,
    pushService,
  };
}

/**
 * One-time startup tasks that should run after services are wired and routes
 * are registered, but before the server starts listening.
 */
export function bootServices(services: Services): void {
  services.coordinator.cleanupStaleLocks();
  services.taskScheduler.seedDefaults();
  services.taskScheduler.start();
}
