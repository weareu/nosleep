import type {
  LaunchSessionRequest,
  TokenBudgetStatus,
} from "@nosleep/shared";

const BASE_URL = "/api";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";

interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    // Only claim a JSON body when one is actually sent — fastify 400s
    // ("Bad Request") on Content-Type: application/json with an empty body,
    // which broke every body-less POST (ack, ack-all, intervene).
    ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    ...((options?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const json = (await res.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new Error(json.error ?? `API error: ${res.status}`);
  }

  // Action endpoints legitimately return { success: true } with no data
  // (ack, ack-all, unack). Callers typed Promise<void> get undefined.
  return json.data as T;
}

// --- Organizations ---

export interface OrgWithStats {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly color: string;
  readonly projectCount: number;
  readonly activeSessions: number;
  readonly unackedAlerts: number;
  readonly todayTokens: number;
  /** Env var that holds this org's optional per-org API key. */
  readonly apiKeyEnv?: string;
}

export function fetchOrgs(): Promise<OrgWithStats[]> {
  return apiFetch<OrgWithStats[]>("/orgs");
}

export interface OrgInput {
  readonly name: string;
  readonly slug?: string;
  readonly color?: string;
}

export function createOrg(payload: OrgInput): Promise<OrgWithStats> {
  return apiFetch<OrgWithStats>("/orgs", { method: "POST", body: JSON.stringify(payload) });
}

export function updateOrg(id: string, payload: { name?: string; color?: string }): Promise<OrgWithStats> {
  return apiFetch<OrgWithStats>(`/orgs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export function deleteOrg(id: string): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/orgs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// --- Projects ---

export interface ProjectRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly path: string;
  readonly account_id: string;
  readonly token_budget: number;
  readonly autonomy_level: string;
  readonly status: string;
  readonly created_at: string;
  readonly org_name: string;
  readonly org_slug: string;
  readonly org_color: string;
  readonly account_name: string;
  readonly account_type: string;
}

export function fetchProjects(orgId?: string): Promise<ProjectRow[]> {
  const params = orgId ? `?orgId=${orgId}` : "";
  return apiFetch<ProjectRow[]>(`/projects${params}`);
}

export interface ProjectDetail extends ProjectRow {
  readonly recentSessions: SessionRow[];
}

export function fetchProject(id: string): Promise<ProjectDetail> {
  return apiFetch<ProjectDetail>(`/projects/${id}`);
}

export interface CreateProjectPayload {
  readonly orgId: string;
  readonly name: string;
  readonly path: string;
  readonly accountId: string;
  readonly tokenBudget?: number;
  readonly autonomyLevel?: string;
}

export function createProject(
  payload: CreateProjectPayload,
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --- Iteration Definition ---

export interface IterationStep {
  readonly id: number;
  readonly label: string;
  readonly description: string;
  readonly gated: boolean;
}

export function fetchIterationSteps(
  projectId: string,
): Promise<{ projectId: string; steps: IterationStep[] }> {
  return apiFetch<{ projectId: string; steps: IterationStep[] }>(
    `/projects/${projectId}/iteration`,
  );
}

export function updateIterationSteps(
  projectId: string,
  steps: IterationStep[],
): Promise<{ projectId: string; steps: IterationStep[] }> {
  return apiFetch<{ projectId: string; steps: IterationStep[] }>(
    `/projects/${projectId}/iteration`,
    {
      method: "PUT",
      body: JSON.stringify({ steps }),
    },
  );
}

export function resetIterationSteps(
  projectId: string,
): Promise<{ projectId: string; steps: IterationStep[] }> {
  return apiFetch<{ projectId: string; steps: IterationStep[] }>(
    `/projects/${projectId}/iteration/reset`,
    { method: "POST" },
  );
}

// --- Sessions ---

export interface SessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly account_id: string;
  readonly pid: number | null;
  readonly status: string;
  readonly goal_text: string;
  readonly goal_hash: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly tokens_used: number;
  readonly last_activity_at: string;
  readonly project_name: string;
  readonly org_id: string;
  readonly org_name: string;
  readonly org_slug: string;
  readonly org_color: string;
  // Phase 22-B — worktree path (if session runs in a git worktree) and
  // currently-assigned strategy node (auto-set by decide-next).
  readonly worktree_path?: string | null;
  readonly strategy_node_id?: string | null;
  readonly strategy_node_title?: string | null;
}

export interface SessionDetail extends SessionRow {
  readonly goal?: {
    readonly id: string;
    readonly session_id: string;
    readonly project_id: string;
    readonly objective: string;
    readonly acceptance_criteria: string;
    readonly current_phase: string;
    readonly progress_pct: number;
    readonly created_at: string;
    readonly updated_at: string;
  };
}

export function fetchSessions(
  orgId?: string,
  status?: string,
): Promise<SessionRow[]> {
  const params = new URLSearchParams();
  if (orgId) params.set("orgId", orgId);
  if (status) params.set("status", status);
  const qs = params.toString();
  return apiFetch<SessionRow[]>(`/sessions${qs ? `?${qs}` : ""}`);
}

export function fetchSession(id: string): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/sessions/${id}`);
}

export function launchSession(
  req: LaunchSessionRequest,
): Promise<{ sessionId: string }> {
  return apiFetch<{ sessionId: string }>("/sessions", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function interveneSession(
  id: string,
  action: "stop" | "redirect",
  message?: string,
): Promise<{ action: string }> {
  return apiFetch<{ action: string }>(`/sessions/${id}/intervene`, {
    method: "POST",
    body: JSON.stringify({ action, message }),
  });
}

// --- Alerts ---

export interface AlertRow {
  readonly id: number;
  readonly org_id: string;
  readonly session_id: string | null;
  readonly project_id: string | null;
  readonly type: string;
  readonly severity: string;
  readonly message: string;
  readonly acknowledged: boolean;
  readonly created_at: string;
  readonly org_name: string;
  readonly org_slug: string;
  readonly org_color: string;
  readonly project_name: string | null;
}

export interface AlertFilters {
  readonly orgId?: string;
  readonly unackedOnly?: boolean;
  readonly type?: string;
  readonly severity?: string;
  readonly offset?: number;
  readonly limit?: number;
}

function alertFiltersToQs(f: AlertFilters): string {
  const params = new URLSearchParams();
  if (f.orgId) params.set("orgId", f.orgId);
  if (f.unackedOnly) params.set("unackedOnly", "true");
  if (f.type) params.set("type", f.type);
  if (f.severity) params.set("severity", f.severity);
  if (f.offset !== undefined) params.set("offset", String(f.offset));
  if (f.limit !== undefined) params.set("limit", String(f.limit));
  return params.toString();
}

export function fetchAlerts(
  orgIdOrFilters?: string | AlertFilters,
  unackedOnly?: boolean,
): Promise<AlertRow[]> {
  // Backward-compat: legacy callers pass (orgId, unackedOnly). New callers
  // pass a single AlertFilters object.
  const filters: AlertFilters =
    typeof orgIdOrFilters === "object"
      ? orgIdOrFilters
      : { orgId: orgIdOrFilters, unackedOnly };
  const qs = alertFiltersToQs(filters);
  return apiFetch<AlertRow[]>(`/alerts${qs ? `?${qs}` : ""}`);
}

export function fetchAlertsCount(filters: AlertFilters = {}): Promise<number> {
  const qs = alertFiltersToQs(filters);
  return apiFetch<{ count: number }>(`/alerts/count${qs ? `?${qs}` : ""}`).then(
    (r) => r.count,
  );
}

export function ackAlert(id: number): Promise<void> {
  return apiFetch<void>(`/alerts/${id}/ack`, { method: "POST" });
}

export function unackAlert(id: number): Promise<void> {
  return apiFetch<void>(`/alerts/${id}/unack`, { method: "POST" });
}

export function ackAllAlerts(orgId?: string): Promise<void> {
  const params = orgId ? `?orgId=${orgId}` : "";
  return apiFetch<void>(`/alerts/ack-all${params}`, { method: "POST" });
}

// --- Analytics ---

export function fetchAnalytics(
  accountId: string,
  days: number = 30,
): Promise<TokenBudgetStatus[]> {
  return apiFetch<TokenBudgetStatus[]>(
    `/analytics/tokens?accountId=${accountId}&days=${days}`,
  );
}

// --- Strategy Tree ---

import type {
  StrategyTree,
  StrategyNodeWithMetrics,
} from "@nosleep/shared";

export function fetchStrategyTree(
  projectId: string,
): Promise<StrategyTree> {
  return apiFetch<StrategyTree>(`/strategy/tree/${projectId}`);
}

export function fetchStrategyNode(
  nodeId: string,
): Promise<{
  node: StrategyNodeWithMetrics;
  children: StrategyNodeWithMetrics[];
  path: { id: string; title: string }[];
}> {
  return apiFetch(`/strategy/node/${nodeId}`);
}

export function updateNodeStatus(
  nodeId: string,
  status: string,
): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>(`/strategy/node/${nodeId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function setNodeProgress(
  nodeId: string,
  progressPct: number,
): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>(`/strategy/node/${nodeId}/progress`, {
    method: "PATCH",
    body: JSON.stringify({ progressPct }),
  });
}

export function createNode(params: {
  projectId: string;
  orgId: string;
  parentId: string | null;
  type: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  weight?: number;
  estimatedTokens?: number;
}): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>("/strategy/node", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function createTree(params: {
  projectId: string;
  orgId: string;
  tree: object;
}): Promise<{ rootId: string; tree: StrategyTree }> {
  return apiFetch<{ rootId: string; tree: StrategyTree }>("/strategy/tree", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function updateNode(
  nodeId: string,
  updates: {
    title?: string;
    description?: string;
    priority?: boolean;
    acceptanceCriteria?: string[];
    weight?: number;
    estimatedTokens?: number;
  },
): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>(`/strategy/node/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function deleteNode(nodeId: string): Promise<void> {
  return apiFetch<void>(`/strategy/node/${nodeId}`, {
    method: "DELETE",
  });
}

export function addDependency(
  nodeId: string,
  dep: { nodeId: string; type: string },
): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>(
    `/strategy/node/${nodeId}/dependency`,
    {
      method: "POST",
      body: JSON.stringify({ dependency: dep }),
    },
  );
}

export function removeDependency(
  nodeId: string,
  targetId: string,
): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>(
    `/strategy/node/${nodeId}/dependency/${targetId}`,
    { method: "DELETE" },
  );
}

export function getNextActionable(
  projectId: string,
): Promise<StrategyNodeWithMetrics> {
  return apiFetch<StrategyNodeWithMetrics>(
    `/strategy/tree/${projectId}/next`,
  );
}

// --- Phase 22-C — strategy ref-links + strategy graph view ---

export type StrategyRefKind = "related" | "informs" | "supersedes" | "references";

export interface StrategyRefOutgoing {
  readonly id: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly kind: StrategyRefKind;
  readonly weight: number;
  readonly note: string | null;
  readonly created_at: string;
  readonly to_title: string;
  readonly to_status: string;
  readonly to_type: string;
  readonly to_project_name: string;
}

export interface StrategyRefIncoming {
  readonly id: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly kind: StrategyRefKind;
  readonly weight: number;
  readonly note: string | null;
  readonly created_at: string;
  readonly from_title: string;
  readonly from_status: string;
  readonly from_type: string;
  readonly from_project_name: string;
}

export function fetchStrategyNodeRefs(
  nodeId: string,
): Promise<{ outgoing: StrategyRefOutgoing[]; incoming: StrategyRefIncoming[] }> {
  return apiFetch(`/strategy/node/${nodeId}/refs`);
}

export function createStrategyRef(input: {
  fromId: string;
  toId: string;
  kind: StrategyRefKind;
  weight?: number;
  note?: string;
}): Promise<{ id: string; fromId: string; toId: string; kind: StrategyRefKind }> {
  return apiFetch("/strategy/refs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteStrategyRef(id: string): Promise<void> {
  return apiFetch<void>(`/strategy/refs/${id}`, { method: "DELETE" });
}

export interface StrategyNodePlan {
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly projectName: string;
  readonly filePath: string | null;
  readonly lineNumber: number | null;
  readonly content: string | null;
  readonly missing: boolean;
  readonly message?: string;
}

export function fetchStrategyNodePlan(nodeId: string): Promise<StrategyNodePlan> {
  return apiFetch<StrategyNodePlan>(`/strategy/node/${nodeId}/plan`);
}

export interface StrategyGraphNode {
  readonly id: string;
  readonly parent_id: string | null;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly progress_pct: number;
  readonly project_id: string;
  readonly project_name: string;
  readonly org_id: string;
  readonly depth: number;
  readonly priority: number | null;
}

export interface StrategyGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "parent" | "dependency" | "ref";
  readonly relation?: string;
  readonly weight: number;
}

export function fetchStrategyGraph(params: {
  projectId?: string;
  orgId?: string;
  limit?: number;
}): Promise<{ nodes: StrategyGraphNode[]; edges: StrategyGraphEdge[]; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (params.projectId) qs.set("projectId", params.projectId);
  if (params.orgId) qs.set("orgId", params.orgId);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  return apiFetch(`/strategy/graph${qs.toString() ? `?${qs.toString()}` : ""}`);
}

// --- Escalation Queue ---

export interface EscalationEvent {
  readonly id: number;
  readonly sessionId: string;
  readonly eventType: string;
  readonly payload: {
    readonly escalationId: string;
    readonly question: string;
    readonly reason: string;
    readonly confidence: number;
  };
  readonly createdAt: string;
}

export function fetchEscalations(): Promise<EscalationEvent[]> {
  return apiFetch<EscalationEvent[]>("/sessions/escalations");
}

export function respondToEscalation(
  sessionId: string,
  message: string,
  escalationId?: string,
): Promise<{ action: string }> {
  return apiFetch<{ action: string }>(`/sessions/${sessionId}/respond`, {
    method: "POST",
    body: JSON.stringify({ message, escalationId }),
  });
}

// --- Session Events ---

export interface SessionEvent {
  readonly id: number;
  readonly sessionId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export function fetchSessionEvents(
  sessionId: string,
  type?: string,
  limit?: number,
): Promise<SessionEvent[]> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return apiFetch<SessionEvent[]>(`/sessions/${sessionId}/events${qs ? `?${qs}` : ""}`);
}

// --- System Stats ---

export interface SystemStats {
  readonly cpu: {
    readonly usagePercent: number;
    readonly cores: number;
    readonly model: string;
    readonly loadAvg: [number, number, number];
  };
  readonly memory: {
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly freeBytes: number;
    readonly usagePercent: number;
  };
  readonly gpu: { readonly name: string; readonly vram: string } | null;
  readonly uptime: {
    readonly system: number;
    readonly server: number;
  };
}

export function fetchSystemStats(): Promise<SystemStats> {
  return apiFetch<SystemStats>("/system/stats");
}

// --- Hook Management ---

export interface HookStatus {
  readonly projectId: string;
  readonly projectName: string;
  readonly orgId: string;
  readonly installed: boolean;
  readonly path: string;
}

export interface HookActionResult {
  readonly installed?: number;
  readonly uninstalled?: number;
  readonly errors: ReadonlyArray<{ readonly projectId: string; readonly error: string }>;
}

export function fetchHooksStatus(orgId?: string): Promise<HookStatus[]> {
  const params = orgId ? `?orgId=${orgId}` : "";
  return apiFetch<HookStatus[]>(`/hooks/status${params}`);
}

export function installHooks(
  scope: "global" | "org" | "project",
  orgId?: string,
  projectId?: string,
): Promise<HookActionResult> {
  return apiFetch<HookActionResult>("/hooks/install", {
    method: "POST",
    body: JSON.stringify({ scope, orgId, projectId }),
  });
}

export function uninstallHooks(
  scope: "global" | "org" | "project",
  orgId?: string,
  projectId?: string,
): Promise<HookActionResult> {
  return apiFetch<HookActionResult>("/hooks/uninstall", {
    method: "POST",
    body: JSON.stringify({ scope, orgId, projectId }),
  });
}

// --- Coordination ---

export interface CoordinationLock {
  readonly id: string;
  readonly org_id: string;
  readonly session_id: string;
  readonly file_path: string;
  readonly locked_at: string;
  readonly released_at: string | null;
  readonly goal_text: string | null;
  readonly project_name: string | null;
}

export interface CoordinationMessage {
  readonly id: string;
  readonly org_id: string;
  readonly from_session_id: string | null;
  readonly to_session_id: string | null;
  readonly type: string;
  readonly payload: string;
  readonly read: number;
  readonly created_at: string;
  readonly from_goal: string | null;
  readonly to_goal: string | null;
}

export interface CoordinationPeer {
  readonly id: string;
  readonly status: string;
  readonly goal_text: string;
  readonly started_at: string;
  readonly project_name: string;
  readonly org_id: string;
  readonly org_name: string;
  readonly org_color: string;
}

export function fetchCoordinationLocks(orgId?: string): Promise<CoordinationLock[]> {
  return apiFetch<CoordinationLock[]>(`/coordination/locks${orgId ? `?orgId=${orgId}` : ""}`);
}

export function fetchCoordinationMessages(orgId?: string, limit = 50): Promise<CoordinationMessage[]> {
  return apiFetch<CoordinationMessage[]>(`/coordination/messages?limit=${limit}${orgId ? `&orgId=${orgId}` : ""}`);
}

export function fetchCoordinationPeers(orgId?: string): Promise<CoordinationPeer[]> {
  return apiFetch<CoordinationPeer[]>(`/coordination/peers${orgId ? `?orgId=${orgId}` : ""}`);
}

export function releaseCoordinationLock(lockId: string): Promise<void> {
  return apiFetch<void>(`/coordination/locks/${lockId}/release`, { method: "POST" });
}

// --- Metrics ---

export interface MetricsSnapshot {
  readonly windowHours: number;
  readonly orgId: string;
  readonly generatedAt: string;
  readonly sessions: {
    readonly total: number;
    readonly durationSeconds: { count: number; p50: number; p95: number; max: number; avg: number };
  };
  readonly tokens: {
    readonly total: number;
    readonly velocityPerHour: number;
  };
  readonly drift: {
    readonly alertCount: number;
    readonly perSession: number;
  };
  readonly escalations: {
    readonly alertCount: number;
    readonly perSession: number;
  };
  readonly validation: Record<string, number>;
}

export interface MetricsByOrg {
  readonly org_id: string;
  readonly session_count: number;
  readonly token_total: number;
  readonly avg_duration_sec: number;
}

export function fetchMetrics(params?: { windowHours?: number; orgId?: string }): Promise<MetricsSnapshot> {
  const qs = new URLSearchParams();
  if (params?.windowHours) qs.set("windowHours", String(params.windowHours));
  if (params?.orgId) qs.set("orgId", params.orgId);
  const q = qs.toString();
  return apiFetch<MetricsSnapshot>(`/metrics${q ? `?${q}` : ""}`);
}

export function fetchMetricsByOrg(windowHours?: number): Promise<MetricsByOrg[]> {
  return apiFetch<MetricsByOrg[]>(`/metrics/by-org${windowHours ? `?windowHours=${windowHours}` : ""}`);
}
