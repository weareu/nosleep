import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { GoalInjector } from "../focus/goal-injector.js";
import { DriftDetector } from "../focus/drift-detector.js";
import { GoalManager } from "../focus/goal-manager.js";
import { CompletenessAnalyzer } from "../validator/completeness-analyzer.js";
import { RetryHandler } from "../validator/retry-handler.js";
import { OutputCollector } from "../validator/output-collector.js";
import { StrategyTreeManager } from "../strategy/tree-manager.js";
import { SessionMessageQueue } from "./message-queue.js";
import { classifyQuestion, type ClassificationResult } from "./escalation-classifier.js";
import { SessionEventStore } from "../events/session-event-store.js";
import { eventBus } from "../event-bus.js";
import type { BudgetPacer } from "../budget/budget-pacer.js";
import { getLogger } from "../logger.js";
import type { StrategyNode, ValidationResult, Goal } from "@nosleep/shared";

interface ToolCall {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

type LaunchFn = (params: {
  projectId: string;
  orgId: string;
  accountId: string;
  cwd: string;
  goal: string;
  acceptanceCriteria: readonly string[];
  strategyNodeId?: string;
}) => string;

// Per-session supervision state
interface SessionState {
  recentToolCalls: ToolCall[];
  recentOutput: string;
  lastDriftCheckMs: number;
  retryCount: number;
  goalHash: string;
  goalText: string;
  projectId: string;
  orgId: string;
  accountId: string;
  cwd: string;
  startedAt: string;
  strategyNodeId: string | null;
  autonomyLevel: "full" | "supervised" | "manual";
  toolCallCount: number;
  noRetry?: boolean;
}

const maintenanceLog = getLogger("brain-maintenance");
const DRIFT_CHECK_DEBOUNCE_MS = 2000;
const AUTO_CONTINUE_DELAY_MS = 500;
const MAX_RECENT_TOOL_CALLS = 20;
const MAX_RECENT_OUTPUT_CHARS = 4000;
const AUTO_ADVANCE_COOLDOWN_MS = 5000;
const MAX_ADVANCES_PER_HOUR = 10;
const MAX_CONCURRENT_SESSIONS = 5;
const RETRY_COOLDOWN_MS = 2000;
const QUESTION_TRUNCATION_LEN = 200;
const COMPACTION_PATTERNS = [
  /context was automatically compacted/i,
  /conversation was automatically compacted/i,
  /auto-compact/i,
];

export class SupervisionLoop {
  private readonly db: Database.Database;
  private readonly goalInjector: GoalInjector;
  private readonly driftDetector: DriftDetector;
  private readonly goalManager: GoalManager;
  private readonly completenessAnalyzer: CompletenessAnalyzer;
  private readonly retryHandler: RetryHandler;
  private readonly outputCollector: OutputCollector;
  private readonly treeManager: StrategyTreeManager;
  readonly messageQueue: SessionMessageQueue;
  readonly eventStore: SessionEventStore;

  // Track state per session
  private readonly sessions = new Map<string, SessionState>();
  // Track retries by goal hash (persists across session re-launches for same goal)
  // Bounded: entries are deleted on success or retry exhaustion
  private readonly retryCountByGoal = new Map<string, number>();
  // Track auto-advance timestamps per project for rate limiting
  // Bounded: pruned in canAutoAdvance() to only keep entries from last hour
  private readonly advanceTimestamps = new Map<string, number[]>();
  // Periodic cleanup interval
  private readonly cleanupInterval: ReturnType<typeof setInterval>;
  private lastEventPrune = 0;

  private readonly budgetPacer: BudgetPacer | null;

  constructor(
    db: Database.Database,
    goalInjector: GoalInjector,
    driftDetector: DriftDetector,
    goalManager: GoalManager,
    completenessAnalyzer: CompletenessAnalyzer,
    retryHandler: RetryHandler,
    outputCollector: OutputCollector,
    treeManager: StrategyTreeManager,
    budgetPacer?: BudgetPacer,
  ) {
    this.db = db;
    this.goalInjector = goalInjector;
    this.driftDetector = driftDetector;
    this.goalManager = goalManager;
    this.completenessAnalyzer = completenessAnalyzer;
    this.retryHandler = retryHandler;
    this.outputCollector = outputCollector;
    this.treeManager = treeManager;
    this.budgetPacer = budgetPacer ?? null;
    this.messageQueue = new SessionMessageQueue();
    this.eventStore = new SessionEventStore(db);

    // Prune stale map entries every 30 minutes
    this.cleanupInterval = setInterval(() => this.pruneStaleEntries(), 30 * 60_000);
  }

  /**
   * Clean up resources on shutdown.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  private pruneStaleEntries(): void {
    const now = Date.now();
    // Daily DB prune: session_events grows unboundedly otherwise (the
    // prune() method existed but had no caller — same pattern that let
    // 66k transcript files accumulate on disk).
    if (now - this.lastEventPrune > 24 * 3600_000) {
      this.lastEventPrune = now;
      this.eventStore.prune();
      // Brain telemetry retention (ingest_events/metrics, 30d): 69M+69M rows
      // filled the disk and crashed the server on 2026-07-15. Async + batched
      // with yields; never touches artifacts/thoughts.
      const orgs = (this.db.prepare(`SELECT id FROM organizations`).all() as Array<{ id: string }>).map((o) => o.id);
      import("../brain/storage/telemetry-retention.js")
        .then((m) => m.pruneBrainTelemetry(orgs))
        .catch(() => { /* best-effort; disk guard is the hard stop */ });
    }
    this.runBrainMaintenance();
    // Prune advanceTimestamps — remove projects with no recent entries
    for (const [projectId, timestamps] of this.advanceTimestamps) {
      const recent = timestamps.filter((t) => now - t < 3600_000);
      if (recent.length === 0) {
        this.advanceTimestamps.delete(projectId);
      } else {
        this.advanceTimestamps.set(projectId, recent);
      }
    }
    // Prune retryCountByGoal — remove entries for goals with no active session
    const activeGoalHashes = new Set([...this.sessions.values()].map((s) => s.goalHash));
    for (const goalHash of this.retryCountByGoal.keys()) {
      if (!activeGoalHashes.has(goalHash)) {
        this.retryCountByGoal.delete(goalHash);
      }
    }
  }

  /**
   * Daily brain maintenance (thought-dedup proposals + sleep-time
   * consolidator). Called every housekeeping tick; the job self-gates to once
   * per ~day per org (persisted across restarts), never throws, makes no LLM
   * calls. Disable with NOSLEEP_BRAIN_MAINTENANCE=0.
   */
  private runBrainMaintenance(): void {
    let orgs: string[];
    try {
      orgs = (this.db.prepare(`SELECT id FROM organizations`).all() as Array<{ id: string }>).map((o) => o.id);
    } catch (err) {
      maintenanceLog.error({ err: String(err) }, "brain maintenance: could not list orgs");
      return;
    }
    import("../brain/jobs/maintenance.js")
      .then((m) => m.runBrainMaintenanceIfDue({ orgIds: orgs, mainDb: this.db, log: maintenanceLog }))
      .catch((err) => maintenanceLog.error({ err: String(err) }, "brain maintenance failed"));
  }

  /**
   * Number of currently supervised sessions.
   */
  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Register a session for supervision.
   */
  registerSession(
    sessionId: string,
    params: {
      goalHash: string;
      goalText: string;
      projectId: string;
      orgId: string;
      accountId: string;
      cwd: string;
      strategyNodeId?: string | null;
      autonomyLevel?: "full" | "supervised" | "manual";
      noRetry?: boolean;
    },
  ): void {
    this.sessions.set(sessionId, {
      recentToolCalls: [],
      recentOutput: "",
      lastDriftCheckMs: 0,
      retryCount: this.retryCountByGoal.get(params.goalHash) ?? 0,
      goalHash: params.goalHash,
      goalText: params.goalText,
      projectId: params.projectId,
      orgId: params.orgId,
      accountId: params.accountId,
      cwd: params.cwd,
      startedAt: new Date().toISOString(),
      strategyNodeId: params.strategyNodeId ?? null,
      autonomyLevel: params.autonomyLevel ?? "supervised",
      toolCallCount: 0,
      noRetry: params.noRetry,
    });
    this.eventStore.record(sessionId, "status_change", { status: "registered" });
  }

  /**
   * Called on every tool_use event. Handles goal re-injection and drift detection.
   * Messages are queued and delivered via the PreToolUse hook HTTP response.
   */
  onToolUse(
    sessionId: string,
    toolCall: ToolCall,
    toolCallCount: number,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.toolCallCount = toolCallCount;

    // Accumulate recent tool calls (ring buffer)
    state.recentToolCalls.push(toolCall);
    if (state.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
      state.recentToolCalls.shift();
    }

    // Record tool use event (sample every 5th to avoid flooding)
    if (toolCallCount % 5 === 0) {
      this.eventStore.record(sessionId, "tool_use", {
        tool: toolCall.name,
        count: toolCallCount,
      });
    }

    // Goal re-injection every N tool calls
    if (this.goalInjector.shouldInject(toolCallCount)) {
      const reminder = this.goalInjector.buildGoalReminder(sessionId);
      if (reminder) {
        this.messageQueue.push(sessionId, reminder);
        this.eventStore.record(sessionId, "goal_injected", { toolCallCount });
        eventBus.emit("supervision:goal-injected", sessionId);
      }
    }

    // Drift detection (debounced)
    const now = Date.now();
    if (now - state.lastDriftCheckMs >= DRIFT_CHECK_DEBOUNCE_MS) {
      state.lastDriftCheckMs = now;
      const result = this.driftDetector.detectDrift(
        sessionId,
        state.recentToolCalls,
        state.recentOutput,
      );
      if (result.drifting) {
        this.eventStore.record(sessionId, "drift_detected", {
          confidence: result.confidence,
          reason: result.reason,
        });
        eventBus.emit("supervision:drift-detected", sessionId, result.confidence, result.reason);
        const reminder = this.goalInjector.buildGoalReminder(sessionId);
        if (reminder) {
          this.messageQueue.push(
            sessionId,
            `DRIFT DETECTED (confidence: ${result.confidence}): ${result.reason}\n\n` +
            `GET BACK ON TRACK:\n${reminder}`,
          );
        }
      }
    }
  }

  /**
   * Called on every text output from Claude. Detects context compaction.
   */
  onText(sessionId: string, text: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Accumulate recent output (ring buffer by chars)
    state.recentOutput += text;
    if (state.recentOutput.length > MAX_RECENT_OUTPUT_CHARS) {
      state.recentOutput = state.recentOutput.slice(-MAX_RECENT_OUTPUT_CHARS);
    }

    // Detect context compaction
    if (COMPACTION_PATTERNS.some((p) => p.test(text))) {
      this.handleCompaction(sessionId);
    }
  }

  /**
   * Called on raw output (non-JSON lines). Also checks for compaction.
   */
  onRawOutput(sessionId: string, text: string): void {
    if (COMPACTION_PATTERNS.some((p) => p.test(text))) {
      this.handleCompaction(sessionId);
    }
  }

  /**
   * Called when Claude asks a question. Classifies it and either auto-continues
   * or escalates to human via the escalation queue.
   */
  onQuestionDetected(
    sessionId: string,
    questionText: string,
    updateStatusFn: (status: string) => void,
  ): void {
    const state = this.sessions.get(sessionId);
    const classification = classifyQuestion(questionText, {
      autonomyLevel: state?.autonomyLevel,
      toolCallCount: state?.toolCallCount,
      goalText: state?.goalText,
    });

    this.eventStore.record(sessionId, "question_detected", {
      text: questionText.slice(0, 500),
      classification: classification.level,
      reason: classification.reason,
      confidence: classification.confidence,
    });

    if (classification.level === "escalate") {
      // Escalate: pause session, create escalation event, notify human
      const escalationId = `esc_${Date.now()}_${sessionId.slice(0, 8)}`;

      this.eventStore.record(sessionId, "escalation_created", {
        escalationId,
        question: questionText.slice(0, 1000),
        reason: classification.reason,
        confidence: classification.confidence,
      });

      updateStatusFn("waiting_input");

      eventBus.emit("supervision:escalation", sessionId, {
        escalationId,
        question: questionText.slice(0, QUESTION_TRUNCATION_LEN),
        reason: classification.reason,
        confidence: classification.confidence,
      });

      // Create a visible alert for the dashboard
      this.createAlert(
        state ?? { orgId: "", projectId: "" } as SessionState,
        sessionId,
        `Escalated: ${questionText.slice(0, 150)}... (${classification.reason})`,
        "warning",
      );
      return;
    }

    // Auto-continue: build goal-aware response
    const goal = this.goalManager.getGoal(sessionId);
    if (!goal) {
      this.messageQueue.push(sessionId,
        "Make your best judgment and continue working autonomously.");
      updateStatusFn("running");
      this.eventStore.record(sessionId, "auto_continued", { reason: "no goal context" });
      return;
    }

    const criteriaList = goal.acceptanceCriteria
      .filter((c) => !c.met)
      .map((c) => `- ${c.description}`)
      .join("\n");

    const message = [
      `Make your best judgment and continue autonomously.`,
      ``,
      `Your objective: ${goal.objective}`,
      ``,
      `Remaining acceptance criteria:`,
      criteriaList,
      ``,
      `Stay focused. Complete all criteria. No stubs or TODOs.`,
    ].join("\n");

    this.messageQueue.push(sessionId, message);
    updateStatusFn("running");
    this.eventStore.record(sessionId, "auto_continued", {
      reason: classification.reason,
      confidence: classification.confidence,
    });
    eventBus.emit("supervision:auto-continue", sessionId, questionText.slice(0, QUESTION_TRUNCATION_LEN));
  }

  /**
   * Handle a human response to an escalated question.
   * Delivers the response to the session and resumes it.
   */
  respondToEscalation(
    sessionId: string,
    response: string,
    escalationId?: string,
  ): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;

    this.messageQueue.push(sessionId, response);

    this.eventStore.record(sessionId, "human_response", {
      escalationId,
      responseLength: response.length,
    });

    if (escalationId) {
      this.eventStore.record(sessionId, "escalation_resolved", { escalationId });
    }

    eventBus.emit("supervision:human-response", sessionId, response.slice(0, 200));
    return true;
  }

  /**
   * Called when a session exits. Runs validation, retry, or strategy tree advancement.
   */
  async onSessionExit(
    sessionId: string,
    exitCode: number | null,
    launchFn: LaunchFn,
  ): Promise<void> {
    // Delete from map immediately to prevent re-entry (TOCTOU guard)
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    this.messageQueue.clear(sessionId);

    // Don't validate errored sessions
    if (exitCode !== 0) return;

    // Get the goal for this session
    const goal = this.goalManager.getGoal(sessionId);
    if (!goal) return;

    // Collect git changes
    let changes;
    try {
      changes = this.outputCollector.collectChanges(state.cwd, state.startedAt);
    } catch {
      changes = { modifiedFiles: [], additions: 0, deletions: 0, diffSummary: "Unable to collect" };
    }

    // Sanitize file paths — reject anything outside project dir
    const safeFiles = changes.modifiedFiles.filter(
      (f) => isPathWithinProject(f, state.cwd),
    );
    const safeChanges = { ...changes, modifiedFiles: safeFiles };

    // Run completeness validation (AI-powered via Haiku)
    const validation = await this.completenessAnalyzer.analyzeCompleteness(
      goal.id,
      safeChanges,
      state.cwd,
    );

    if (!validation) return;

    if (validation.verdict === "complete") {
      // Clean up retry tracking for this goal
      this.retryCountByGoal.delete(state.goalHash);

      // Mark goal complete
      this.goalManager.markComplete(goal.id);

      // Advance strategy tree if linked to a node
      if (state.strategyNodeId) {
        await this.advanceStrategyTree(sessionId, state, launchFn);
      }
    } else {
      // Validation failed — retry if allowed
      await this.handleValidationFailure(sessionId, state, validation, goal, launchFn);
    }
  }

  /**
   * Clean up when session is removed (stopped, errored without exit handler).
   */
  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.messageQueue.clear(sessionId);
  }

  // ── Internal ──────────────────────────────────────────

  private handleCompaction(sessionId: string): void {
    this.eventStore.record(sessionId, "compaction_detected", {});

    const reminder = this.goalInjector.buildGoalReminder(sessionId);
    if (reminder) {
      this.messageQueue.push(
        sessionId,
        `CONTEXT COMPACTED -- Re-read your mission:\n\n${reminder}\n\n` +
        `If you lost context, call the "goal_get" MCP tool to reload your full objective.`,
      );
      this.eventStore.record(sessionId, "compaction_recovery", { reminderSent: true });
      eventBus.emit("supervision:compaction-recovery", sessionId);
    }
  }

  private async advanceStrategyTree(
    sessionId: string,
    state: SessionState,
    launchFn: LaunchFn,
  ): Promise<void> {
    try {
      this.treeManager.updateStatus(state.strategyNodeId!, "completed");

      // Rate limit auto-advances
      if (!this.canAutoAdvance(state.projectId)) {
        this.createAlert(state, sessionId,
          `Auto-advance rate limit reached (${MAX_ADVANCES_PER_HOUR}/hour). Pausing.`,
          "warning");
        return;
      }

      // Concurrent session cap
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        this.createAlert(state, sessionId,
          `Concurrent session limit reached (${MAX_CONCURRENT_SESSIONS}). Waiting.`,
          "info");
        return;
      }

      const nextNode = this.treeManager.getNextActionable(state.projectId);
      if (!nextNode) return;

      // Budget-aware cooldown: higher burn rate = longer wait
      let cooldownMs = AUTO_ADVANCE_COOLDOWN_MS;
      if (this.budgetPacer) {
        const pacerCooldown = this.budgetPacer.getAutoAdvanceCooldownMs(state.accountId);
        if (pacerCooldown === -1) {
          // Budget exhausted — do not auto-advance
          this.createAlert(state, sessionId,
            `Auto-advance blocked: daily token budget exceeded (>200%). Next task "${nextNode.title}" deferred to tomorrow.`,
            "warning");
          this.eventStore.record(sessionId, "strategy_advanced", {
            action: "deferred_budget", nextNode: nextNode.id, nextTitle: nextNode.title,
          });
          return;
        }
        cooldownMs = Math.max(cooldownMs, pacerCooldown);
      }

      if (cooldownMs > 0) {
        const mins = Math.round(cooldownMs / 60000);
        if (mins > 0) {
          this.eventStore.record(sessionId, "strategy_advanced", {
            action: "cooldown", minutes: mins, nextNode: nextNode.id, nextTitle: nextNode.title,
          });
        }
        await new Promise((r) => setTimeout(r, cooldownMs));
      }

      // Re-check concurrent session limit after cooldown
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        this.createAlert(state, sessionId,
          `Concurrent session limit reached after cooldown. Deferring.`, "info");
        return;
      }

      // Re-check budget after cooldown (may have changed)
      if (this.budgetPacer) {
        const recheck = this.budgetPacer.getAutoAdvanceCooldownMs(state.accountId);
        if (recheck === -1) {
          this.createAlert(state, sessionId,
            `Budget exhausted during cooldown. Deferring "${nextNode.title}".`, "warning");
          return;
        }
      }

      this.autoLaunchNode(nextNode, state, launchFn);
    } catch (err) {
      this.createAlert(state, sessionId,
        `Strategy tree advance failed: ${errorMessage(err)}`, "warning");
    }
  }

  private async handleValidationFailure(
    sessionId: string,
    state: SessionState,
    validation: ValidationResult,
    goal: Goal,
    launchFn: LaunchFn,
  ): Promise<void> {
    // Skip retries for review/scheduled tasks — they find issues, not implement
    if (state.noRetry) {
      this.createAlert(state, sessionId,
        `Review completed with verdict: ${validation.verdict}. ${validation.details.overallNotes}`, "info");
      return;
    }

    const retryCount = this.retryCountByGoal.get(state.goalHash) ?? 0;

    if (this.retryHandler.canRetry(retryCount)) {
      const retryContext = this.retryHandler.buildRetryPrompt(validation, goal);
      if (retryContext.shouldRetry) {
        const newRetryCount = retryCount + 1;
        this.retryCountByGoal.set(state.goalHash, newRetryCount);
        eventBus.emit("supervision:auto-retry", sessionId, newRetryCount);

        // Cooldown before retry
        await new Promise((r) => setTimeout(r, RETRY_COOLDOWN_MS));

        try {
          const newSessionId = launchFn({
            projectId: state.projectId,
            orgId: state.orgId,
            accountId: state.accountId,
            cwd: state.cwd,
            goal: retryContext.prompt,
            acceptanceCriteria: goal.acceptanceCriteria
              .filter((c) => !c.met)
              .map((c) => c.description),
            strategyNodeId: state.strategyNodeId ?? undefined,
          });

          this.registerSession(newSessionId, {
            goalHash: state.goalHash,
            goalText: retryContext.prompt,
            projectId: state.projectId,
            orgId: state.orgId,
            accountId: state.accountId,
            cwd: state.cwd,
            strategyNodeId: state.strategyNodeId,
            autonomyLevel: state.autonomyLevel,
          });
        } catch (err) {
          this.createAlert(state, sessionId,
            `Auto-retry launch failed: ${errorMessage(err)}`, "critical");
        }
      }
    } else {
      // Retries exhausted — clean up and alert
      this.retryCountByGoal.delete(state.goalHash);
      this.createAlert(state, sessionId,
        `Validation failed after ${retryCount} retries. Verdict: ${validation.verdict}. ${validation.details.overallNotes}`,
        "critical");
    }
  }

  private canAutoAdvance(projectId: string): boolean {
    const now = Date.now();
    const timestamps = this.advanceTimestamps.get(projectId) ?? [];
    const recent = timestamps.filter((t) => now - t < 3600_000);
    if (recent.length >= MAX_ADVANCES_PER_HOUR) {
      this.advanceTimestamps.set(projectId, recent); // prune old entries
      return false;
    }
    recent.push(now);
    this.advanceTimestamps.set(projectId, recent);
    return true;
  }

  private autoLaunchNode(
    node: StrategyNode,
    state: SessionState,
    launchFn: LaunchFn,
  ): void {
    // Use explicit acceptance criteria if defined, else fall back to description parsing
    let acceptanceCriteria: string[];
    if (node.acceptanceCriteria.length > 0) {
      acceptanceCriteria = [...node.acceptanceCriteria];
    } else {
      // Legacy fallback: parse bullet points from description
      const parsed = node.description
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim());
      acceptanceCriteria = parsed.length > 0
        ? parsed
        : [`Complete: ${node.title}`];
    }

    try {
      const newSessionId = launchFn({
        projectId: state.projectId,
        orgId: state.orgId,
        accountId: state.accountId,
        cwd: state.cwd,
        goal: `${node.title}\n\n${node.description}`,
        acceptanceCriteria,
        strategyNodeId: node.id,
      });

      eventBus.emit("supervision:auto-advance", newSessionId, node.id);

      this.registerSession(newSessionId, {
        goalHash: newSessionId,
        goalText: `${node.title}\n\n${node.description}`,
        projectId: state.projectId,
        orgId: state.orgId,
        accountId: state.accountId,
        cwd: state.cwd,
        strategyNodeId: node.id,
        autonomyLevel: state.autonomyLevel,
      });
    } catch (err) {
      this.createAlert(state, "",
        `Auto-advance to "${node.title}" failed: ${errorMessage(err)}`, "warning");
    }
  }

  private createAlert(
    state: SessionState,
    sessionId: string,
    message: string,
    severity: "info" | "warning" | "critical",
  ): void {
    // Persist alert to DB (not just event bus) for consistency with session-manager
    const result = this.db.prepare(`
      INSERT INTO alerts (org_id, session_id, project_id, type, severity, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(state.orgId, sessionId, state.projectId, "session_error", severity, message);

    eventBus.emit("alert:new", {
      id: result.lastInsertRowid as number,
      orgId: state.orgId,
      sessionId,
      projectId: state.projectId,
      type: "session_error" as const,
      severity,
      message,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    });
  }
}

/** Extract error message from unknown error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validate that a file path stays within the project directory.
 * Resolves symlinks to prevent traversal via symlink chains.
 */
function isPathWithinProject(filePath: string, projectPath: string): boolean {
  try {
    const resolvedProject = realpathSync(projectPath);
    const candidatePath = filePath.startsWith("/") ? filePath : resolve(projectPath, filePath);
    const resolvedCandidate = realpathSync(candidatePath);
    return resolvedCandidate === resolvedProject || resolvedCandidate.startsWith(resolvedProject + "/");
  } catch {
    // Can't resolve (file deleted, broken symlink) — reject
    return false;
  }
}
