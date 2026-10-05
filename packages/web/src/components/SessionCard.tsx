import { useNavigate } from "react-router-dom";
import type { SessionRow } from "../lib/api";
import { interveneSession } from "../lib/api";
import { OrgBadge } from "./OrgBadge";
import { StatusDot } from "./StatusDot";

interface SessionCardProps {
  readonly session: SessionRow;
}

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

export function SessionCard({ session }: SessionCardProps): React.ReactElement {
  const navigate = useNavigate();
  const isActive = ACTIVE_STATUSES.has(session.status);

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("Stop this session?")) {
      await interveneSession(session.id, "stop");
    }
  };

  const handleRedirect = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/sessions/${session.id}`);
  };

  return (
    <div
      onClick={() => navigate(`/sessions/${session.id}`)}
      className="bg-slate-800 rounded-xl border border-slate-700/50 p-4 hover:border-slate-600 transition-all cursor-pointer group"
      style={{ borderLeftColor: session.org_color, borderLeftWidth: "3px" }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white truncate group-hover:text-blue-400 transition-colors">
            {session.project_name}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <OrgBadge
              slug={session.org_slug}
              name={session.org_name}
              color={session.org_color}
            />
            <StatusDot status={session.status} />
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-400 line-clamp-2 mb-2 leading-relaxed">
        {session.goal_text}
      </p>

      {/* Phase 22-B — surface assigned strategy node + worktree path */}
      {(session.strategy_node_title || session.worktree_path) && (
        <div className="flex items-center gap-2 mb-3 text-[10px]">
          {session.strategy_node_title && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-950/40 text-blue-300 border border-blue-900/60 truncate max-w-[55%]"
              title={`Strategy node: ${session.strategy_node_title}`}
            >
              <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              <span className="truncate">{session.strategy_node_title}</span>
            </span>
          )}
          {session.worktree_path && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 border border-amber-900/60 truncate"
              title={`Worktree: ${session.worktree_path}`}
            >
              <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="truncate font-mono">
                {session.worktree_path.split("/").slice(-2).join("/")}
              </span>
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-500">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {formatDuration(session.started_at, session.ended_at)}
          </span>
          <span className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {formatTokens(session.tokens_used)}
          </span>
        </div>

        {isActive && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleRedirect}
              className="px-2 py-0.5 rounded text-yellow-400 hover:bg-yellow-400/10 transition-colors"
              title="Redirect"
            >
              Redirect
            </button>
            <button
              onClick={handleStop}
              className="px-2 py-0.5 rounded text-red-400 hover:bg-red-400/10 transition-colors"
              title="Stop"
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
