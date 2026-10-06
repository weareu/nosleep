// ── Organization ─────────────────────────────────────────

/** Org slug — user-defined, lower-case [a-z0-9-] (see ORG_SLUG_RE). */
export type OrgSlug = string;

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: OrgSlug;
  readonly color: string;
  readonly createdAt: string;
}

// ── Account ──────────────────────────────────────────────

export type AccountType = "pro" | "max" | "team" | "api";

export interface Account {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly apiKeyRef: string | null;
  readonly dailyTokenLimit: number;
  readonly monthlyTokenLimit: number;
  readonly billingCycleDay?: number;
  readonly createdAt: string;
}

// ── Project ──────────────────────────────────────────────

export type ProjectStatus = "idle" | "running" | "paused" | "error";
export type AutonomyLevel = "full" | "supervised" | "manual";

export interface Project {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly path: string;
  readonly accountId: string;
  readonly tokenBudget: number;
  readonly autonomyLevel: AutonomyLevel;
  /** When true, new sessions resume the last Claude session instead of starting fresh */
  readonly continueSession: boolean;
  readonly status: ProjectStatus;
  readonly createdAt: string;
}

// ── Session ──────────────────────────────────────────────

export type SessionStatus =
  | "starting"
  | "running"
  | "idle"
  | "waiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export interface Session {
  readonly id: string;
  readonly projectId: string;
  readonly accountId: string;
  readonly pid: number | null;
  readonly status: SessionStatus;
  readonly goalText: string;
  readonly goalHash: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly tokensUsed: number;
  readonly lastActivityAt: string;
}

// ── Strategy Tree ────────────────────────────────────────

export type StrategyNodeType = "strategy" | "goal" | "task" | "subtask";

export type StrategyNodeStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "skipped";

/**
 * Dependency constraint types (like project management tools):
 * - FS (Finish-Start): predecessor must finish before successor can start (most common)
 * - SS (Start-Start): predecessor must start before successor can start
 * - FF (Finish-Finish): predecessor must finish before successor can finish
 * - SF (Start-Finish): predecessor must start before successor can finish (rare)
 */
export type DependencyType = "FS" | "SS" | "FF" | "SF";

export interface NodeDependency {
  /** The node this dependency points to */
  readonly nodeId: string;
  /** Constraint type */
  readonly type: DependencyType;
}

export interface StrategyNode {
  readonly id: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly type: StrategyNodeType;
  readonly title: string;
  readonly description: string;
  readonly status: StrategyNodeStatus;
  /** 0-100, computed from children or set directly on leaves */
  readonly progressPct: number;
  /** Depth in tree (0 = root) */
  readonly depth: number;
  /** Sort order among siblings */
  readonly sortOrder: number;
  /** Session currently working on this node (leaf-level assignment) */
  readonly assignedSessionId: string | null;
  /** Dependencies on other nodes with constraint types */
  readonly dependencies: readonly NodeDependency[];
  /** Acceptance criteria for this node (used when launching sessions) */
  readonly acceptanceCriteria: readonly string[];
  /** Relative weight for progress calculation (default 1) */
  readonly weight: number;
  /** Estimated token cost for budgeting */
  readonly estimatedTokens: number;
  /** Whether this node is high-priority (bypasses some pacing limits) */
  readonly priority?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A node with its computed tree metrics */
export interface StrategyNodeWithMetrics extends StrategyNode {
  /** Total leaf nodes under this subtree */
  readonly totalLeaves: number;
  /** Completed leaf nodes under this subtree */
  readonly completedLeaves: number;
  /** In-progress leaf nodes under this subtree */
  readonly activeLeaves: number;
  /** Blocked leaf nodes */
  readonly blockedLeaves: number;
  /** Deepest level in this subtree (0 = this is a leaf) */
  readonly maxDepthBelow: number;
  /** Weighted roll-up of children's progress (finished leaves = 100%). */
  readonly computedProgressPct: number;
}

/** Full tree structure for rendering */
export interface StrategyTree {
  readonly root: StrategyNodeWithMetrics;
  readonly nodes: readonly StrategyNodeWithMetrics[];
  readonly totalNodes: number;
  readonly totalLeaves: number;
  readonly completedLeaves: number;
  /** Same weighted roll-up as the root's computedProgressPct — the single
   *  source of truth every view must display. */
  readonly overallProgressPct: number;
}

// ── Legacy Goal (kept for backward compat with existing sessions) ────

export interface AcceptanceCriterion {
  readonly description: string;
  readonly met: boolean;
}

export interface Goal {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly currentPhase: string;
  readonly progressPct: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Token Usage ──────────────────────────────────────────

export interface TokenUsage {
  readonly id: number;
  readonly sessionId: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly recordedAt: string;
}

export interface TokenBudgetStatus {
  readonly orgId: string;
  readonly accountId: string;
  readonly dailyUsed: number;
  readonly dailyLimit: number;
  readonly monthlyUsed: number;
  readonly monthlyLimit: number;
  readonly pctDailyUsed: number;
  readonly pctMonthlyUsed: number;
}

// ── Budget Pacing ───────────────────────────────────────

export type PacingMode = "normal" | "cautious" | "slow" | "critical";

export interface BudgetPacingStatus {
  readonly accountId: string;
  readonly pacingMode: PacingMode;
  readonly dailyAllowance: number;
  readonly dailyUsed: number;
  readonly burnRatePct: number; // dailyUsed / dailyAllowance * 100
  readonly remainingMonthlyBudget: number;
  readonly remainingDaysInCycle: number;
  readonly billingCycleDay: number;
  readonly cycleStartDate: string;
  readonly cycleEndDate: string;
  readonly suggestion?: string; // "defer to tomorrow", "run in lean mode", etc.
}

// ── Alert ────────────────────────────────────────────────

export type AlertType =
  | "drift"
  | "idle"
  | "question"
  | "budget_warning"
  | "budget_critical"
  | "validation_failed"
  | "session_error"
  | "session_complete";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  readonly id: number;
  readonly orgId: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly type: AlertType;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly acknowledged: boolean;
  readonly createdAt: string;
}

// ── Validation ───────────────────────────────────────────

export type ValidationVerdict = "complete" | "incomplete" | "stub";

export interface ValidationResult {
  readonly id: number;
  readonly sessionId: string;
  readonly goalId: string;
  readonly verdict: ValidationVerdict;
  readonly details: ValidationDetails;
  readonly validatorModel: string;
  readonly createdAt: string;
}

export interface ValidationDetails {
  readonly criteriaResults: readonly CriterionResult[];
  readonly stubPatterns: readonly string[];
  readonly coverageCheck: boolean | null;
  readonly overallNotes: string;
}

export interface CriterionResult {
  readonly criterion: string;
  readonly status: "met" | "not_met" | "partial";
  readonly notes: string;
}

// ── Memory ───────────────────────────────────────────────

export type MemoryCategory = "skill" | "decision" | "pattern" | "fact";

export interface MemoryEntry {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly category: MemoryCategory;
  readonly key: string;
  readonly value: string;
  readonly accessCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── WebSocket Events ─────────────────────────────────────

export type WsEventType =
  | "session:update"
  | "session:output"
  | "alert:new"
  | "alert:ack"
  | "alert:unack"
  | "budget:update"
  | "validation:result"
  | "goal:progress"
  | "supervision:action"
  | "supervision:escalation";

export interface WsEvent<T = unknown> {
  readonly type: WsEventType;
  readonly data: T;
  readonly timestamp: string;
}

// ── API Payloads ─────────────────────────────────────────

export interface LaunchSessionRequest {
  readonly projectId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface InterventionRequest {
  readonly sessionId: string;
  readonly action: "stop" | "pause" | "resume" | "redirect";
  readonly message?: string;
}

// ── Iteration Definition ────────────────────────────────

export interface IterationStep {
  readonly id: number;
  readonly label: string;
  readonly description: string;
  /** If true, session must report completion of this step before moving on */
  readonly gated: boolean;
}

export interface IterationDefinition {
  readonly projectId: string;
  readonly steps: readonly IterationStep[];
  readonly updatedAt: string;
}

export const DEFAULT_ITERATION_STEPS: readonly IterationStep[] = [
  { id: 1, label: "Document goal/spec", description: "Write clear specification of what needs to be done", gated: false },
  { id: 2, label: "Implement", description: "Write the core implementation code", gated: false },
  { id: 3, label: "Write tests", description: "Write tests that actually find bugs, not just pass — useful tests", gated: false },
  { id: 4, label: "Implement wiring", description: "Wire up integrations, connect components, add routes/handlers", gated: false },
  { id: 5, label: "Wiring and E2E tests", description: "End-to-end tests verifying the full integration works", gated: false },
  { id: 6, label: "Review", description: "Code review for quality, security, and correctness", gated: true },
  { id: 7, label: "Update documentation", description: "Update docs, project artifacts, review for consistency", gated: false },
  { id: 8, label: "Pre-check test runs", description: "Run all tests via hooks or manually before commit", gated: true },
  { id: 9, label: "Check in / push / build", description: "Commit, push, and verify build passes (if applicable)", gated: true },
] as const;

// ── Session Cross-Coordination ─────────────────────────

export type SessionMessageType = "discovery" | "request" | "handoff" | "conflict" | "info";

export interface SessionMessage {
  readonly id: string;
  readonly fromSessionId: string;
  readonly toSessionId: string | null;
  readonly orgId: string;
  readonly type: SessionMessageType;
  readonly payload: string;
  readonly read: boolean;
  readonly createdAt: string;
}

export interface FileLock {
  readonly id: string;
  readonly sessionId: string;
  readonly orgId: string;
  readonly filePath: string;
  readonly lockedAt: string;
  readonly releasedAt: string | null;
}
