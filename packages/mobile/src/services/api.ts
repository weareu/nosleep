import { getServerConfig } from "../config";
import { report as clientLog } from "./clientLog";
import type {
  Alert,
  LaunchSessionRequest,
  OrgWithStats,
  Project,
  Session,
  SessionWithProject,
  Goal,
} from "../types";

// ── Helpers ─────────────────────────────────────────────

/** Convert snake_case keys to camelCase recursively.
 *  The server returns raw SQLite rows with snake_case field names,
 *  but the mobile app types use camelCase. */
function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(camelizeKeys);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamelKey(key)] = camelizeKeys(value);
    }
    return result;
  }
  return obj;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, apiKey } = await getServerConfig();
  const url = `${apiUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        // Only claim a JSON body when one exists — fastify rejects
        // Content-Type: application/json with an empty body (400).
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        // Tags the request server-side so log filtering for "mobile" is easy.
        "x-client-app": "nosleep-mobile",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // Network-level failure (DNS, offline, refused). Report so we can see
    // exactly what the mobile is hitting from the server log.
    clientLog(
      "error",
      "api.fetch",
      err instanceof Error ? err.message : String(err),
      { method: init?.method ?? "GET", path, apiUrl, hasKey: Boolean(apiKey) },
      err instanceof Error ? err.stack : undefined,
    );
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    clientLog("warn", "api.http", `${response.status} ${response.statusText}`, {
      method: init?.method ?? "GET",
      path,
      status: response.status,
      body: body.slice(0, 500),
    });
    throw new Error(`API ${response.status}: ${body || response.statusText}`);
  }

  const json = await response.json();
  // Server wraps responses in {success, data} — unwrap automatically
  const payload = json && typeof json === "object" && "data" in json
    ? json.data
    : json;
  // Convert snake_case keys from SQLite rows to camelCase
  return camelizeKeys(payload) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ── Organizations ───────────────────────────────────────

export function listOrgs(): Promise<OrgWithStats[]> {
  return fetchJson<OrgWithStats[]>("/api/orgs");
}

// ── Sessions ────────────────────────────────────────────

export function listSessions(params: {
  orgId?: string;
  status?: string;
}): Promise<SessionWithProject[]> {
  const searchParams = new URLSearchParams();
  if (params.orgId) searchParams.set("orgId", params.orgId);
  if (params.status) searchParams.set("status", params.status);
  const qs = searchParams.toString();
  return fetchJson<SessionWithProject[]>(`/api/sessions${qs ? `?${qs}` : ""}`);
}

export function getSession(id: string): Promise<SessionWithProject> {
  return fetchJson<SessionWithProject>(`/api/sessions/${id}`);
}

export function getSessionGoal(sessionId: string): Promise<Goal> {
  return fetchJson<Goal>(`/api/sessions/${sessionId}/goal`);
}

export function launchSession(
  request: LaunchSessionRequest
): Promise<Session> {
  return postJson<Session>("/api/sessions", request);
}

export function interveneSession(
  sessionId: string,
  action: "stop" | "pause" | "resume" | "redirect",
  message?: string
): Promise<{ success: boolean }> {
  return postJson<{ success: boolean }>(`/api/sessions/${sessionId}/intervene`, {
    action,
    message,
  });
}

// ── Projects ────────────────────────────────────────────

export function listProjects(params?: {
  orgId?: string;
}): Promise<Project[]> {
  const searchParams = new URLSearchParams();
  if (params?.orgId) searchParams.set("orgId", params.orgId);
  const qs = searchParams.toString();
  return fetchJson<Project[]>(`/api/projects${qs ? `?${qs}` : ""}`);
}

export function updateProject(
  projectId: string,
  updates: { active?: boolean; defaultModel?: string; name?: string; tokenBudget?: number },
): Promise<{ success: boolean }> {
  return patchJson<{ success: boolean }>(`/api/projects/${projectId}`, updates);
}

// ── Alerts ──────────────────────────────────────────────

export function listAlerts(params?: {
  orgId?: string;
  unackedOnly?: boolean;
}): Promise<Alert[]> {
  const searchParams = new URLSearchParams();
  if (params?.orgId) searchParams.set("orgId", params.orgId);
  if (params?.unackedOnly) searchParams.set("unackedOnly", "true");
  const qs = searchParams.toString();
  return fetchJson<Alert[]>(`/api/alerts${qs ? `?${qs}` : ""}`);
}

export function acknowledgeAlert(
  alertId: number
): Promise<{ success: boolean }> {
  return postJson<{ success: boolean }>(`/api/alerts/${alertId}/ack`, {});
}

export function acknowledgeAllAlerts(
  orgId?: string
): Promise<{ success: boolean }> {
  const searchParams = new URLSearchParams();
  if (orgId) searchParams.set("orgId", orgId);
  const qs = searchParams.toString();
  return postJson<{ success: boolean }>(
    `/api/alerts/ack-all${qs ? `?${qs}` : ""}`,
    {}
  );
}

// ── Push Notifications ──────────────────────────────────

export function registerPushToken(
  pushToken: string,
  orgFilter?: string,
  platform?: string,
): Promise<{ success: boolean }> {
  return postJson<{ success: boolean }>("/api/push/register", {
    pushToken,
    orgFilter,
    platform,
  });
}

export function unregisterPushToken(
  pushToken: string,
): Promise<{ success: boolean }> {
  return fetchJson<{ success: boolean }>("/api/push/unregister", {
    method: "DELETE",
    body: JSON.stringify({ pushToken }),
  });
}

// ── Strategy Tree ──────────────────────────────────────

export function fetchStrategyTree(
  projectId: string,
): Promise<any> {
  return fetchJson<any>(`/api/strategy/tree/${projectId}`).catch(() => null);
}

export function fetchStrategyNodeDetail(
  nodeId: string,
): Promise<{
  node: any;
  children: any[];
  path: { id: string; title: string }[];
}> {
  return fetchJson<any>(`/api/strategy/node/${nodeId}`);
}

export function updateStrategyNodeStatus(
  nodeId: string,
  status: string,
): Promise<any> {
  return fetchJson<any>(`/api/strategy/node/${nodeId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function setStrategyNodeProgress(
  nodeId: string,
  progressPct: number,
): Promise<any> {
  return fetchJson<any>(`/api/strategy/node/${nodeId}/progress`, {
    method: "PATCH",
    body: JSON.stringify({ progressPct }),
  });
}

export function createStrategyNode(params: {
  projectId: string;
  orgId: string;
  parentId: string | null;
  type: string;
  title: string;
  description?: string;
}): Promise<any> {
  return postJson<any>("/api/strategy/node", params);
}

export function createStrategyTree(params: {
  projectId: string;
  orgId: string;
  tree: object;
}): Promise<any> {
  return postJson<any>("/api/strategy/tree", params);
}

export function deleteStrategyNode(nodeId: string): Promise<any> {
  return fetchJson<any>(`/api/strategy/node/${nodeId}`, {
    method: "DELETE",
  });
}

export function addStrategyDependency(
  nodeId: string,
  dep: { nodeId: string; type: string },
): Promise<any> {
  return postJson<any>(`/api/strategy/node/${nodeId}/dependency`, {
    dependency: dep,
  });
}

export function removeStrategyDependency(
  nodeId: string,
  targetId: string,
): Promise<any> {
  return fetchJson<any>(
    `/api/strategy/node/${nodeId}/dependency/${targetId}`,
    { method: "DELETE" },
  );
}

export function getNextActionable(
  projectId: string,
): Promise<any> {
  return fetchJson<any>(`/api/strategy/tree/${projectId}/next`);
}

// ── Metrics ───────────────────────────────────────────

export interface MetricsSnapshot {
  windowHours: number;
  orgId: string;
  generatedAt: string;
  sessions: {
    total: number;
    durationSeconds: { count: number; p50: number; p95: number; max: number; avg: number };
  };
  tokens: { total: number; velocityPerHour: number };
  drift: { alertCount: number; perSession: number };
  escalations: { alertCount: number; perSession: number };
  validation: Record<string, number>;
}

export function fetchMetrics(params?: {
  windowHours?: number;
  orgId?: string;
}): Promise<MetricsSnapshot> {
  const sp = new URLSearchParams();
  if (params?.windowHours) sp.set("windowHours", String(params.windowHours));
  if (params?.orgId) sp.set("orgId", params.orgId);
  const q = sp.toString();
  return fetchJson<MetricsSnapshot>(`/api/metrics${q ? `?${q}` : ""}`);
}

// ── Scheduled Tasks ───────────────────────────────────

export function listScheduledTasks(params?: {
  orgId?: string;
  projectId?: string;
}): Promise<any[]> {
  const searchParams = new URLSearchParams();
  if (params?.orgId) searchParams.set("orgId", params.orgId);
  if (params?.projectId) searchParams.set("projectId", params.projectId);
  const qs = searchParams.toString();
  return fetchJson<any[]>(`/api/scheduled-tasks${qs ? `?${qs}` : ""}`);
}

export function updateScheduledTask(
  taskId: string,
  updates: { enabled?: boolean; name?: string },
): Promise<{ success: boolean }> {
  return patchJson<{ success: boolean }>(`/api/scheduled-tasks/${taskId}`, updates);
}
