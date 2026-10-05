import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { buildGoalPrompt } from "./prompt-builder.js";
import { buildRecallBlock } from "./memory-recall.js";
import { ModelRouter } from "./model-router.js";
import { emitAlert } from "./alert-emitter.js";
import {
  spawnClaudeSession,
  resumeClaudeSession,
  hashGoal,
  type ClaudeProcess,
  type ClaudeCliOptions,
  type StreamMessage,
} from "./claude-cli.js";
import {
  detectsQuestion,
  detectsStubInOutput,
  extractToolName,
} from "./output-parser.js";
import { SupervisionLoop } from "./supervision-loop.js";
import { installHooks } from "./hooks-installer.js";
import { TokenTracker } from "../budget/token-tracker.js";
import { BudgetPacer } from "../budget/budget-pacer.js";
import { eventBus } from "../event-bus.js";
import type {
  Session,
  SessionStatus,
  LaunchSessionRequest,
} from "@nosleep/shared";
import {
  SESSION_IDLE_TIMEOUT_MS,
} from "@nosleep/shared";
import type { Coordinator } from "../coordination/coordinator.js";
import type { VectorIndexer } from "../embeddings/vector-indexer.js";
import { getLogger } from "../logger.js";

const log = getLogger("session-manager");

const RESUME_PROMPT_DELAY_MS = 1000;
const SHUTDOWN_FORCE_TIMEOUT_MS = 10_000;

interface ActiveSession {
  readonly id: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly accountId: string;
  readonly cwd: string;
  readonly goalHash: string;
  readonly strategyNodeId: string | null;
  process: ClaudeProcess | null;
  claudeSessionId: string | null;
  status: SessionStatus;
  toolCallCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  resumeTimer: ReturnType<typeof setTimeout> | null;
  lastOutputText: string;
}

export class SessionManager {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly db: Database.Database;
  private readonly tokenTracker: TokenTracker;
  private readonly pacer: BudgetPacer;
  private readonly supervision: SupervisionLoop;
  private readonly coordinator: Coordinator | null;
  private readonly modelRouter: ModelRouter;
  private vectorIndexer: VectorIndexer | null = null;

  constructor(db: Database.Database, pacer: BudgetPacer, supervision: SupervisionLoop, coordinator?: Coordinator) {
    this.db = db;
    this.tokenTracker = new TokenTracker(db);
    this.pacer = pacer;
    this.supervision = supervision;
    this.coordinator = coordinator ?? null;
    this.modelRouter = new ModelRouter(db);
  }

  /**
   * Set the vector indexer for plan resolution. Called after server init.
   */
  setVectorIndexer(indexer: VectorIndexer): void {
    this.vectorIndexer = indexer;
  }

  /**
   * Launch a new Claude Code session for a project.
   */
  launch(request: LaunchSessionRequest & {
    readonly orgId: string;
    readonly accountId: string;
    readonly cwd: string;
    readonly model?: string;
    readonly maxBudgetUsd?: number;
    readonly permissionMode?: ClaudeCliOptions["permissionMode"];
    readonly mcpConfig?: readonly string[];
    readonly isPriority?: boolean;
    readonly strategyNodeId?: string;
    readonly continueSession?: boolean;
    readonly autonomyLevel?: "full" | "supervised" | "manual";
    readonly noRetry?: boolean;
  }): string {
    // Check pacing before spawning
    const estimatedCost = this.pacer.estimateSessionCost(request.accountId);
    const pacingCheck = this.pacer.canLaunchSession(
      request.accountId,
      estimatedCost,
      request.isPriority,
    );

    if (!pacingCheck.allowed) {
      // Store a rejection event rather than spawning
      eventBus.emit("session:rejected", {
        projectId: request.projectId,
        accountId: request.accountId,
        reason: pacingCheck.reason,
        suggestion: pacingCheck.suggestion,
        pacingMode: pacingCheck.pacingMode,
      });
      throw new Error(
        `Session blocked by budget pacer: ${pacingCheck.reason}${pacingCheck.suggestion ? ` (${pacingCheck.suggestion})` : ""}`,
      );
    }

    const sessionId = nanoid();
    const goalHash = hashGoal(request.goal);

    // Insert session record
    this.db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, pid, status, goal_text, goal_hash)
      VALUES (?, ?, ?, ?, NULL, 'starting', ?, ?)
    `).run(sessionId, request.projectId, request.orgId, request.accountId, request.goal, goalHash);

    // Insert goal with acceptance criteria
    const goalId = nanoid();
    const criteria = request.acceptanceCriteria.map((desc) => ({
      description: desc,
      met: false,
    }));
    this.db.prepare(`
      INSERT INTO goals (id, session_id, project_id, objective, acceptance_criteria)
      VALUES (?, ?, ?, ?, ?)
    `).run(goalId, sessionId, request.projectId, request.goal, JSON.stringify(criteria));

    // Build the goal-aware prompt, with auto-recall (Memory v2 slice 1):
    // relevant org memory + brain thoughts are appended so the session starts
    // with what the system already learned. Fail-open — null on any error.
    let prompt = buildGoalPrompt(request.goal, request.acceptanceCriteria);
    const recall = buildRecallBlock({
      mainDb: this.db,
      orgId: request.orgId,
      projectId: request.projectId,
      goalText: request.goal,
    });
    if (recall) {
      prompt = `${prompt}\n\n${recall}`;
      log.info({ sessionId, projectId: request.projectId }, "recall block injected into goal prompt");
    }

    // Get lean mode prompt injection based on pacing mode
    const leanModePrompt = this.pacer.getLeanModePrompt(pacingCheck.pacingMode);

    // Build system prompt appendix for goal awareness
    const systemParts = [
      `You are an autonomous coding agent managed by NoSleep orchestrator.`,
      `Organization: ${request.orgId}. Session: ${sessionId}.`,
      ``,
      `# AUTONOMY`,
      `You are managed by NoSleep. Use the "nosleep" MCP tool for strategy/progress/help.`,
      `- When you finish a task, decide: continue with related work, or call nosleep(action="strategy_next") for the next task.`,
      `- If blocked, call nosleep(action="request_help").`,
      `- After context compaction, call nosleep(action="goal_get") to reload your mission.`,
      `- Report progress via nosleep(action="goal_progress") after major steps.`,
      ``,
      `# TOKEN EFFICIENCY RULES (CRITICAL — VIOLATION = SESSION KILL)`,
      `- NEVER use the Agent tool. NEVER spawn sub-agents, background tasks, or parallel workers. Do ALL work yourself, sequentially, one step at a time.`,
      `- NEVER use the Skill tool unless explicitly required by the task.`,
      `- Be concise — minimal output, no verbose explanations, no summaries unless asked.`,
      `- Read files before editing. Prefer targeted edits over full rewrites.`,
      `- Avoid unnecessary tool calls. Think before acting. One tool call per step.`,
      `- Do NOT explore broadly. Work on exactly what was asked, nothing more.`,
      `- If the task is ambiguous, pick the smallest reasonable interpretation and do that.`,
      `- You have a strict per-session budget. Every token counts. Do not waste them on exploration, planning agents, or parallel work.`,
    ];

    // Load iteration definition for this project
    const projectRow = this.db.prepare(`SELECT iteration_steps FROM projects WHERE id = ?`).get(request.projectId) as { iteration_steps: string } | undefined;
    if (projectRow?.iteration_steps) {
      const steps = JSON.parse(projectRow.iteration_steps) as Array<{ id: number; label: string; description: string; gated: boolean }>;
      if (steps.length > 0) {
        systemParts.push("");
        systemParts.push("# ITERATION WORKFLOW");
        systemParts.push("Follow these phases IN ORDER for every task:");
        for (const step of steps) {
          systemParts.push(`${step.id}. ${step.label}${step.description ? ` — ${step.description}` : ""}${step.gated ? " [GATED — report completion before proceeding]" : ""}`);
        }
        systemParts.push("");
        systemParts.push("Report your current phase when calling goal_progress.");
      }
    }

    if (leanModePrompt) {
      systemParts.push("", leanModePrompt);
    }

    const systemAppend = systemParts.join("\n");

    // Calculate per-session budget from account's monthly budget, billing cycle position,
    // and historical session frequency — instead of an arbitrary hard cap.
    const calculatedBudget = this.pacer.getSessionBudgetUsd(request.accountId);

    // Model routing: explicit > strategy node > project default > 'sonnet'
    const resolvedModel = this.modelRouter.resolveModel(request.model, request.strategyNodeId, request.projectId, pacingCheck.pacingMode);

    // Record model on session
    this.db.prepare(`UPDATE sessions SET model = ? WHERE id = ?`).run(resolvedModel, sessionId);

    const cliOptions: ClaudeCliOptions = {
      cwd: request.cwd,
      orgId: request.orgId,
      sessionId,
      model: resolvedModel,
      maxBudgetUsd: request.maxBudgetUsd ?? calculatedBudget,
      permissionMode: request.permissionMode ?? "auto",
      appendSystemPrompt: systemAppend,
      mcpConfig: request.mcpConfig,
    };

    const active: ActiveSession = {
      id: sessionId,
      projectId: request.projectId,
      orgId: request.orgId,
      accountId: request.accountId,
      cwd: request.cwd,
      goalHash,
      strategyNodeId: request.strategyNodeId ?? null,
      process: null,
      claudeSessionId: null,
      status: "starting",
      toolCallCount: 0,
      idleTimer: null,
      resumeTimer: null,
      lastOutputText: "",
    };

    this.activeSessions.set(sessionId, active);

    // Install monitoring hooks into the project's .claude directory
    try {
      installHooks(request.cwd, { serverPort: 3777, orgId: request.orgId });
    } catch (err) {
      // Non-fatal: session can still run without hooks
      log.warn({ cwd: request.cwd, err }, "failed to install hooks");
    }

    // Check if we should resume last session instead of starting fresh
    let proc: ClaudeProcess;
    const lastClaudeSessionId = request.continueSession
      ? this.getLastClaudeSessionId(request.projectId)
      : null;

    if (lastClaudeSessionId) {
      // Resume the previous Claude session — it retains full context
      proc = resumeClaudeSession(lastClaudeSessionId, cliOptions);
      // Send the new goal after the process is ready to accept input.
      // Timer is tracked so it can be cleared if session is stopped early.
      active.resumeTimer = setTimeout(() => {
        active.resumeTimer = null;
        if (active.status !== "running" || !active.process) return;
        const sent = active.process.sendInput(prompt);
        if (!sent) {
          emitAlert(this.db, {
            orgId: active.orgId, sessionId, projectId: active.projectId,
            type: "session_error", severity: "warning",
            message: "Failed to send goal prompt to resumed session — stdin not writable",
          });
        }
      }, RESUME_PROMPT_DELAY_MS);
    } else {
      proc = spawnClaudeSession(prompt, cliOptions);
    }
    active.process = proc;

    // Update PID in DB
    this.db.prepare(`UPDATE sessions SET pid = ?, status = 'running' WHERE id = ?`)
      .run(proc.pid, sessionId);
    active.status = "running";

    // Register with supervision loop
    this.supervision.registerSession(sessionId, {
      goalHash,
      goalText: request.goal,
      projectId: request.projectId,
      orgId: request.orgId,
      accountId: request.accountId,
      cwd: request.cwd,
      strategyNodeId: request.strategyNodeId,
      autonomyLevel: request.autonomyLevel,
      noRetry: request.noRetry,
    });

    this.emitSessionUpdate(sessionId);
    this.wireProcessEvents(sessionId, active);

    return sessionId;
  }

  /**
   * Stop a running session.
   */
  stop(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;

    active.process?.kill();
    this.updateStatus(sessionId, "stopped");
    this.clearIdleTimer(active);
    this.clearResumeTimer(active);
  }

  /**
   * Send a redirect/intervention message to a running session.
   */
  redirect(sessionId: string, message: string): boolean {
    const active = this.activeSessions.get(sessionId);
    if (!active?.process) return false;

    active.process.sendInput(message);
    this.resetIdleTimer(active);
    return true;
  }

  /**
   * Externally update a session's status (used by routes for escalation responses).
   */
  updateStatusExternal(sessionId: string, status: SessionStatus): void {
    this.updateStatus(sessionId, status);
  }

  /**
   * Get status of a session.
   */
  getStatus(sessionId: string): SessionStatus | null {
    const active = this.activeSessions.get(sessionId);
    if (active) return active.status;

    const row = this.db.prepare(`SELECT status FROM sessions WHERE id = ?`)
      .get(sessionId) as { status: SessionStatus } | undefined;
    return row?.status ?? null;
  }

  /**
   * Get all active session IDs, optionally filtered by org.
   */
  getActiveSessions(orgId?: string): readonly string[] {
    const sessions = [...this.activeSessions.values()];
    const filtered = orgId ? sessions.filter((s) => s.orgId === orgId) : sessions;
    return filtered.map((s) => s.id);
  }

  /**
   * Gracefully shut down all sessions.
   */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, active] of this.activeSessions) {
      active.process?.kill();
      this.clearIdleTimer(active);
      this.clearResumeTimer(active);
      promises.push(
        new Promise<void>((resolve) => {
          if (active.process) {
            const timer = setTimeout(() => resolve(), SHUTDOWN_FORCE_TIMEOUT_MS);
            active.process.events.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          } else {
            resolve();
          }
        })
      );
    }
    await Promise.all(promises);
  }

  // ── Internal ──────────────────────────────────────────

  private wireProcessEvents(sessionId: string, active: ActiveSession): void {
    const events = active.process!.events;

    events.on("message", (msg: StreamMessage) => {
      this.resetIdleTimer(active);

      // Track tool calls for goal re-injection interval
      const toolName = extractToolName(msg);
      if (toolName) {
        active.toolCallCount++;
        // Supervision: goal re-injection + drift detection (messages queued for hook delivery)
        this.supervision.onToolUse(
          sessionId,
          { name: toolName, args: msg.tool_input as Record<string, unknown> | undefined },
          active.toolCallCount,
        );
      }
    });

    events.on("text", (text: string) => {
      active.lastOutputText = text;
      eventBus.emit("session:output", sessionId, text);

      // Supervision: compaction detection (messages queued for hook delivery)
      this.supervision.onText(sessionId, text);

      // Check if Claude is asking a question — queue auto-response
      if (detectsQuestion(text)) {
        emitAlert(this.db, {
          orgId: active.orgId, sessionId, projectId: active.projectId,
          type: "question", severity: "info",
          message: `Session asked (auto-continued): ${text.slice(0, 200)}`,
        });
        this.supervision.onQuestionDetected(
          sessionId,
          text,
          (status) => this.updateStatus(sessionId, status as SessionStatus),
        );
      }
    });

    // Listen for raw output (non-JSON) for compaction detection
    events.on("raw", (text: string) => {
      this.supervision.onRawOutput(sessionId, text);
    });

    events.on("tool_result", (data: { name: string; result: string }) => {
      // Early stub detection
      if (data.name === "Write" || data.name === "Edit") {
        if (detectsStubInOutput(data.result)) {
          emitAlert(this.db, {
            orgId: active.orgId, sessionId, projectId: active.projectId,
            type: "drift", severity: "warning",
            message: `Possible stub detected in ${data.name} output`,
          });
        }
      }
    });

    events.on("result", (data: {
      cost: number;
      duration: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      model: string;
      sessionId: string | null;
      numTurns: number;
    }) => {
      // Save Claude's session ID for potential resume
      if (data.sessionId) {
        active.claudeSessionId = data.sessionId;
      }

      // Record token usage via TokenTracker (emits budget:update event)
      this.tokenTracker.recordUsage({
        sessionId,
        accountId: active.accountId,
        projectId: active.projectId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        model: data.model,
      });

      // Update session totals (tokens + USD cost)
      this.db.prepare(`
        UPDATE sessions SET tokens_used = tokens_used + ?, cost_usd = cost_usd + ? WHERE id = ?
      `).run(data.totalTokens, data.cost, sessionId);
    });

    events.on("exit", (data: { code: number | null; signal: string | null }) => {
      this.clearIdleTimer(active);
      this.clearResumeTimer(active);

      // Guard: don't override status if already finalized (e.g., by stop hook)
      const currentStatus = active.status;
      const alreadyFinalized = currentStatus === "completed" || currentStatus === "failed";
      const newStatus: SessionStatus = alreadyFinalized
        ? currentStatus
        : (data.code === 0 ? "completed" : "failed");

      if (!alreadyFinalized) {
        this.updateStatus(sessionId, newStatus);
      }

      this.db.prepare(`UPDATE sessions SET ended_at = datetime('now'), claude_session_id = ? WHERE id = ?`)
        .run(active.claudeSessionId, sessionId);

      // Release all file locks held by this session
      if (this.coordinator) {
        const released = this.coordinator.releaseSessionLocks(sessionId);
        if (released > 0) {
          log.info({ sessionId, released }, "released file locks for session");
        }
      }

      if (newStatus === "completed") {
        // Taxonomy: alerts are for HUMAN-ACTIONABLE items. A routine
        // completion is timeline data — session_events, not alerts (261
        // unacked session_complete alerts were drowning real warnings).
        this.db.prepare(
          `INSERT INTO session_events (session_id, event_type, payload) VALUES (?, 'session_complete', ?)`,
        ).run(sessionId, JSON.stringify({ message: "Session completed. Running validation..." }));
      } else {
        emitAlert(this.db, {
          orgId: active.orgId, sessionId, projectId: active.projectId,
          type: "session_error", severity: "critical",
          message: `Session exited with code ${data.code}, signal ${data.signal}`,
        });
      }

      // Clean up event listeners to prevent memory leaks
      events.removeAllListeners();

      // Supervision: auto-validate, retry, or advance strategy tree
      // Delete from activeSessions after supervision completes to prevent
      // race conditions if supervision triggers a retry launch
      const launchFn = (params: {
        projectId: string;
        orgId: string;
        accountId: string;
        cwd: string;
        goal: string;
        acceptanceCriteria: readonly string[];
        strategyNodeId?: string;
      }) => this.launch({
        ...params,
        permissionMode: "auto",
      });

      this.supervision.onSessionExit(sessionId, data.code, launchFn)
        .catch((err) => {
          emitAlert(this.db, {
            orgId: active.orgId, sessionId, projectId: active.projectId,
            type: "session_error", severity: "warning",
            message: `Supervision exit handler error: ${err instanceof Error ? err.message : String(err)}`,
          });
        })
        .finally(() => {
          this.activeSessions.delete(sessionId);
          active.process = null; // Break reference chain for GC
        });
    });

    events.on("error", (err: Error) => {
      emitAlert(this.db, {
        orgId: active.orgId, sessionId, projectId: active.projectId,
        type: "session_error", severity: "critical",
        message: `Process error: ${err.message}`,
      });
    });

    // Start idle timer
    this.resetIdleTimer(active);
  }


  private updateStatus(sessionId: string, status: SessionStatus): void {
    const active = this.activeSessions.get(sessionId);
    if (active) active.status = status;

    this.db.prepare(`UPDATE sessions SET status = ?, last_activity_at = datetime('now') WHERE id = ?`)
      .run(status, sessionId);

    // Project status is derived from sessions on read (projectLiveStatusSql
    // in @nosleep/shared) — no per-session write-through here, which used to
    // flip a project "idle" while a second session was still running.

    this.emitSessionUpdate(sessionId);
  }

  private emitSessionUpdate(sessionId: string): void {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;

    if (row) {
      const session: Session = {
        id: row.id as string,
        projectId: row.project_id as string,
        accountId: row.account_id as string,
        pid: row.pid as number | null,
        status: row.status as SessionStatus,
        goalText: row.goal_text as string,
        goalHash: row.goal_hash as string,
        startedAt: row.started_at as string,
        endedAt: row.ended_at as string | null,
        tokensUsed: row.tokens_used as number,
        lastActivityAt: row.last_activity_at as string,
      };
      eventBus.emit("session:update", session);
    }
  }

  private resetIdleTimer(active: ActiveSession): void {
    this.clearIdleTimer(active);

    active.idleTimer = setTimeout(() => {
      if (active.status === "running") {
        this.updateStatus(active.id, "idle");
        emitAlert(this.db, {
          orgId: active.orgId, sessionId: active.id, projectId: active.projectId,
          type: "idle", severity: "warning",
          message: `Session idle for ${SESSION_IDLE_TIMEOUT_MS / 1000}s`,
        });
      }
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(active: ActiveSession): void {
    if (active.idleTimer) {
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
    }
  }

  /**
   * Find the most recent Claude session ID for a project that completed successfully.
   * Used for --resume when continueSession is enabled.
   */
  private getLastClaudeSessionId(projectId: string): string | null {
    // Recency bound: only resume a session that ended within 48h. Loop
    // iterations run 10-25min apart, so this covers pauses/weekends while
    // avoiding stale context (or a transcript Claude's own cleanup already
    // removed — `--resume <gone-id>` exits non-zero and burns the iteration).
    const row = this.db.prepare(`
      SELECT claude_session_id FROM sessions
      WHERE project_id = ? AND claude_session_id IS NOT NULL AND status = 'completed'
      AND ended_at > datetime('now', '-2 days')
      ORDER BY ended_at DESC LIMIT 1
    `).get(projectId) as { claude_session_id: string } | undefined;

    return row?.claude_session_id ?? null;
  }

  private clearResumeTimer(active: ActiveSession): void {
    if (active.resumeTimer) {
      clearTimeout(active.resumeTimer);
      active.resumeTimer = null;
    }
  }
}
