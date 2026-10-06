// Re-export shared types for convenience within the mobile app
// These mirror the shared package types

/** Org slug — orgs are user-defined on the server ([a-z0-9-]). */
export type OrgSlug = string;

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: OrgSlug;
  /** Always resolved by the server (stored colour or deterministic palette). */
  readonly color: string;
  readonly createdAt?: string;
}

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
  readonly continueSession: boolean;
  readonly status: ProjectStatus;
  readonly progressPct?: number;
  readonly active?: boolean;
  readonly defaultModel?: string;
  readonly createdAt: string;
}

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
  readonly projectName: string | null;
  readonly orgName: string | null;
  readonly type: AlertType;
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly acknowledged: boolean;
  readonly createdAt: string;
}

export type WsEventType =
  | "session:update"
  | "session:output"
  | "alert:new"
  | "alert:ack"
  | "budget:update"
  | "validation:result"
  | "goal:progress"
  | "supervision:action";

export interface WsEvent<T = unknown> {
  readonly type: WsEventType;
  readonly data: T;
  readonly timestamp: string;
}

export interface LaunchSessionRequest {
  readonly projectId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly strategyNodeId?: string;
}

export interface InterventionRequest {
  readonly sessionId: string;
  readonly action: "stop" | "pause" | "resume" | "redirect";
  readonly message?: string;
}

// Extended types for API responses with joined data
export interface OrgWithStats extends Organization {
  readonly activeSessions: number;
  readonly projectCount: number;
  readonly unackedAlerts: number;
  readonly todayTokens: number;
}

export interface SessionWithProject extends Session {
  readonly projectName?: string;
  readonly orgId?: string;
  readonly goal?: Goal;
}
