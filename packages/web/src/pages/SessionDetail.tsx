import { useState, useRef, useEffect } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSession, interveneSession, fetchAlerts, ackAlert, launchSession, type SessionDetail as SessionDetailType, type AlertRow } from "../lib/api";
import { useWebSocket } from "../hooks/useWebSocket";
import { fetchSessionArtifacts } from "../lib/brainApi";
import { OrgBadge } from "../components/OrgBadge";
import { StatusDot } from "../components/StatusDot";
import { GoalChecklist } from "../components/GoalChecklist";
import { AlertItem } from "../components/AlertItem";

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const diffMs = end - start;
  const mins = Math.floor(diffMs / 60_000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

const ACTIVE_STATUSES = new Set(["starting", "running", "idle", "waiting_input", "paused"]);

export function SessionDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [redirectMsg, setRedirectMsg] = useState("");
  const [sending, setSending] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const { lastEvent } = useWebSocket(["session:output", "session:update"]);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  // Tracks whether we've already seeded the panel from the brain
  // archive so we don't keep re-prepending the transcript when the
  // session query re-fetches.
  const seededRef = useRef(false);

  const { data: session, isLoading } = useQuery<SessionDetailType>({
    queryKey: ["session", id],
    queryFn: () => fetchSession(id!),
    enabled: Boolean(id),
  });

  const { data: alerts } = useQuery<AlertRow[]>({
    queryKey: ["session-alerts", id],
    queryFn: () => fetchAlerts(undefined, false),
    enabled: Boolean(id),
    select: (data) => data.filter((a) => a.session_id === id),
  });

  // Backfill the output panel from the brain archive. Manual `claude`
  // sessions don't emit `session:output` events (we have no stdout
  // handle on the external process), so this is the only way to show
  // their transcript on the dashboard. Orchestrated sessions get the
  // same backfill of historical lines too — the WS stream then continues
  // from wherever the brain archive ended.
  useEffect(() => {
    if (!id || !session?.org_id || seededRef.current) return;
    let cancelled = false;
    seededRef.current = true;
    fetchSessionArtifacts({
      session_id: id,
      org_id: session.org_id,
      limit: 200,
      order: "asc",
    })
      .then((page) => {
        if (cancelled) return;
        const lines = page.items
          .filter((it) => it.kind.startsWith("conversation/turn/"))
          .map((it) => {
            const role = it.kind.endsWith("/user_message")
              ? "user"
              : it.kind.endsWith("/assistant_message")
                ? "claude"
                : (it.actor ?? "?");
            const body = it.snippet ?? "";
            return `[${role}] ${body}`;
          });
        if (lines.length > 0) {
          // Prepend so anything WS already streamed stays at the bottom.
          setOutputLines((prev) => [...lines, ...prev]);
        }
      })
      .catch(() => {
        // Non-fatal — leave the panel as-is; the WS path (if any) still
        // works. Manual stopped sessions will just show "No output
        // captured" + the existing "Open in Brain" link.
        seededRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [id, session?.org_id]);

  // Collect output from WS
  useEffect(() => {
    if (lastEvent?.type === "session:output" && lastEvent.data) {
      const data = lastEvent.data as { sessionId?: string; text?: string; line?: string };
      const outputText = data.text ?? data.line;
      if (data.sessionId === id && outputText) {
        setOutputLines((prev) => [...prev, outputText]);
      }
    }
    if (lastEvent?.type === "session:update") {
      queryClient.invalidateQueries({ queryKey: ["session", id] });
    }
  }, [lastEvent, id, queryClient]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputLines]);

  const handleStop = async () => {
    if (!id || !window.confirm("Stop this session?")) return;
    await interveneSession(id, "stop");
    queryClient.invalidateQueries({ queryKey: ["session", id] });
  };

  const handleRetry = async () => {
    if (!session) return;
    // Parse original acceptance criteria back to string array
    let criteriaStrings: string[] = [];
    if (session.goal?.acceptance_criteria) {
      try {
        const parsed = JSON.parse(session.goal.acceptance_criteria) as Array<string | { description: string }>;
        criteriaStrings = parsed.map((c) => typeof c === "string" ? c : c.description);
      } catch {
        criteriaStrings = [session.goal_text];
      }
    }

    const result = await launchSession({
      projectId: session.project_id,
      goal: session.goal_text,
      acceptanceCriteria: criteriaStrings,
    });

    // Navigate to the new session
    navigate(`/sessions/${result.sessionId}`);
  };

  const handleRedirect = async () => {
    if (!id || !redirectMsg.trim()) return;
    setSending(true);
    try {
      await interveneSession(id, "redirect", redirectMsg.trim());
      setRedirectMsg("");
    } finally {
      setSending(false);
    }
  };

  const handleAckAlert = async (alertId: number) => {
    await ackAlert(alertId);
    queryClient.invalidateQueries({ queryKey: ["session-alerts", id] });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-500">Loading session...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-500">Session not found</div>
      </div>
    );
  }

  const isActive = ACTIVE_STATUSES.has(session.status);

  // Parse acceptance criteria from goal
  let criteria: Array<{ criterion: string; status: "met" | "not_met" | "partial" }> = [];
  if (session.goal?.acceptance_criteria) {
    try {
      const parsed = JSON.parse(session.goal.acceptance_criteria) as Array<string | { description: string; met?: boolean }>;
      criteria = parsed.map((c) => {
        if (typeof c === "string") {
          return { criterion: c, status: "not_met" as const };
        }
        return {
          criterion: c.description,
          status: c.met ? "met" as const : "not_met" as const,
        };
      });
    } catch {
      // If it's not valid JSON
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-slate-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate("/")}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold text-white">{session.project_name}</h1>
                <OrgBadge
                  slug={session.org_slug}
                  name={session.org_name}
                  color={session.org_color ?? "#6366f1"}
                />
                <StatusDot status={session.status} size="md" />
              </div>
              <p className="text-xs text-slate-500 mt-0.5 font-mono">{session.id}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isActive && (
              <button
                onClick={handleRetry}
                className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-sm font-medium rounded-lg border border-blue-600/30 transition-colors"
              >
                Retry
              </button>
            )}
            {isActive && (
              <button
                onClick={handleStop}
                className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-sm font-medium rounded-lg border border-red-600/30 transition-colors"
              >
                Stop Session
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden p-6 gap-4">
          {/* Stats row */}
          <div className="flex-shrink-0 grid grid-cols-3 gap-4">
            <div className="bg-slate-800 rounded-xl px-4 py-3 border border-slate-700/50">
              <p className="text-xs text-slate-500 mb-1">Tokens Used</p>
              <p className="text-xl font-bold text-white">{formatTokens(session.tokens_used)}</p>
            </div>
            <div className="bg-slate-800 rounded-xl px-4 py-3 border border-slate-700/50">
              <p className="text-xs text-slate-500 mb-1">Duration</p>
              <p className="text-xl font-bold text-white">{formatDuration(session.started_at, session.ended_at)}</p>
            </div>
            <div className="bg-slate-800 rounded-xl px-4 py-3 border border-slate-700/50">
              <p className="text-xs text-slate-500 mb-1">Progress</p>
              <p className="text-xl font-bold text-white">{session.goal?.progress_pct ?? 0}%</p>
              <div className="mt-1.5 w-full bg-slate-700 rounded-full h-1.5">
                <div
                  className="bg-blue-500 rounded-full h-1.5 transition-all"
                  style={{ width: `${session.goal?.progress_pct ?? 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* Goal */}
          <div className="flex-shrink-0 bg-slate-800 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-sm font-semibold text-slate-400 mb-2">Goal</h3>
            <p className="text-sm text-slate-200 leading-relaxed">{session.goal_text}</p>

            {criteria.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-700">
                <h4 className="text-xs font-semibold text-slate-500 mb-2">Acceptance Criteria</h4>
                <GoalChecklist criteria={criteria} />
              </div>
            )}
          </div>

          {/* Output stream */}
          <div className="flex-1 min-h-0 bg-slate-950 rounded-xl border border-slate-700/50 flex flex-col">
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-400">Output</h3>
              <span className="text-[10px] text-slate-600">{outputLines.length} lines</span>
            </div>
            <div
              ref={outputRef}
              className="flex-1 overflow-auto p-4 terminal-output text-slate-300"
            >
              {outputLines.length === 0 ? (
                <div className="text-slate-600 italic space-y-2">
                  <p>
                    {isActive ? "Waiting for output..." : "No output captured for this session."}
                  </p>
                  {!isActive && id && (
                    <p className="not-italic text-slate-500 text-xs">
                      Try the full archive replay:{" "}
                      <Link
                        to={`/brain/session/${id}`}
                        className="text-blue-400 hover:underline"
                      >
                        Open in Brain →
                      </Link>
                    </p>
                  )}
                </div>
              ) : (
                outputLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap">{line}</div>
                ))
              )}
            </div>
          </div>

          {/* Redirect input */}
          {isActive && (
            <div className="flex-shrink-0 flex gap-2">
              <input
                value={redirectMsg}
                onChange={(e) => setRedirectMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRedirect()}
                placeholder="Send a redirect message..."
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleRedirect}
                disabled={sending || !redirectMsg.trim()}
                className="px-4 py-2 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 text-sm font-medium rounded-lg border border-yellow-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {sending ? "Sending..." : "Redirect"}
              </button>
            </div>
          )}
        </div>

        {/* Right sidebar - Session alerts */}
        <aside className="w-72 flex-shrink-0 border-l border-slate-800 overflow-auto p-4">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
            Session Alerts
          </h3>
          <div className="space-y-2">
            {alerts && alerts.length > 0 ? (
              alerts.map((alert) => (
                <AlertItem key={alert.id} alert={alert} onAck={handleAckAlert} />
              ))
            ) : (
              <p className="text-sm text-slate-600 text-center py-4">No alerts</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
