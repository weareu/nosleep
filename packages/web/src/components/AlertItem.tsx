import { useNavigate } from "react-router-dom";
import type { AlertRow } from "../lib/api";
import { OrgBadge } from "./OrgBadge";

interface AlertItemProps {
  readonly alert: AlertRow;
  readonly onAck?: (id: number) => void;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "border-l-red-500",
  warning: "border-l-yellow-500",
  info: "border-l-blue-500",
};

// Phase 12 (UI review M2) — coloured SVG icons per alert type, replacing
// the text pills (Drift / Idle / ?, etc) that all read as the same shape
// at a glance and made the list a wall of grey.
const TYPE_ICON_TONE: Record<string, string> = {
  drift: "bg-amber-500/15 text-amber-400",
  idle: "bg-slate-500/15 text-slate-400",
  question: "bg-blue-500/15 text-blue-400",
  budget_warning: "bg-yellow-500/15 text-yellow-400",
  budget_critical: "bg-red-500/15 text-red-400",
  validation_failed: "bg-red-500/15 text-red-400",
  session_error: "bg-red-500/15 text-red-400",
  session_complete: "bg-emerald-500/15 text-emerald-400",
};

function TypeIcon({ type }: { type: string }): React.ReactElement {
  const tone = TYPE_ICON_TONE[type] ?? "bg-slate-500/15 text-slate-400";
  return (
    <span
      className={`mt-0.5 flex-shrink-0 w-7 h-7 rounded-md ${tone} flex items-center justify-center`}
      aria-label={type}
      title={type}
    >
      <TypeGlyph type={type} />
    </span>
  );
}

function TypeGlyph({ type }: { type: string }): React.ReactElement {
  switch (type) {
    case "drift":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M3 17l4-4 4 4 7-7 3 3"
          />
        </svg>
      );
    case "idle":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <circle cx="12" cy="12" r="9" strokeWidth={1.6} />
          <path strokeLinecap="round" strokeWidth={1.8} d="M12 7v5l3 2" />
        </svg>
      );
    case "question":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M9 9a3 3 0 116 0c0 1.5-1 2-2 2.5s-1 1.5-1 2.5"
          />
          <circle cx="12" cy="17" r="0.8" fill="currentColor" />
        </svg>
      );
    case "budget_warning":
    case "budget_critical":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <circle cx="12" cy="12" r="9" strokeWidth={1.6} />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M14.5 9.5c-.667-.667-1.667-1-3-1-1.5 0-2.5 1-2.5 2 0 1.5 1.5 2 3 2.5s3 1 3 2.5c0 1-1 2-2.5 2-1.333 0-2.333-.333-3-1M12 6v2M12 16v2"
          />
        </svg>
      );
    case "validation_failed":
    case "session_error":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M12 9v4m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
          />
        </svg>
      );
    case "session_complete":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M5 13l4 4L19 7"
          />
        </svg>
      );
    default:
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <circle cx="12" cy="12" r="3" strokeWidth={1.8} />
        </svg>
      );
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

export function AlertItem({ alert, onAck }: AlertItemProps): React.ReactElement {
  const navigate = useNavigate();
  const severityClass = SEVERITY_STYLES[alert.severity] ?? "border-l-slate-500";
  const hasSession = Boolean(alert.session_id);

  // Phase 12 (UI review M1) — body click jumps to the originating session
  // detail page when the alert carries a session_id. Falls back silently
  // when the alert is global (no session attached).
  const handleBodyClick = () => {
    if (alert.session_id) navigate(`/sessions/${alert.session_id}`);
  };

  // Render body as a button only when it's actually clickable; otherwise
  // a plain div so the user-agent's disabled-button greying doesn't dim
  // every system-level alert that has no session attached.
  const bodyContent = (
    <>
      <div className="flex items-center gap-2 mb-0.5">
        <OrgBadge slug={alert.org_slug} name={alert.org_name} color={alert.org_color} />
        {alert.project_name && (
          <span className="text-xs text-slate-500 truncate">{alert.project_name}</span>
        )}
        <span className="text-xs text-slate-600 ml-auto flex-shrink-0">
          {formatTimestamp(alert.created_at)}
        </span>
      </div>
      <p className="text-sm text-slate-300 leading-snug">{alert.message}</p>
    </>
  );

  return (
    <div
      className={`border-l-2 ${severityClass} bg-slate-800/50 rounded-r-lg px-3 py-2 flex items-start gap-3 ${
        alert.acknowledged ? "opacity-50" : ""
      }`}
    >
      <TypeIcon type={alert.type} />

      {hasSession ? (
        <button
          type="button"
          onClick={handleBodyClick}
          className="flex-1 min-w-0 text-left cursor-pointer hover:bg-slate-700/20 -mx-1 px-1 rounded"
          aria-label="Open originating session"
        >
          {bodyContent}
        </button>
      ) : (
        <div className="flex-1 min-w-0">{bodyContent}</div>
      )}

      {!alert.acknowledged && onAck && (
        <button
          onClick={() => onAck(alert.id)}
          className="mt-0.5 flex-shrink-0 text-xs text-slate-400 hover:text-white bg-slate-700 hover:bg-slate-600 rounded px-2 py-1 transition-colors"
        >
          Ack
        </button>
      )}
    </div>
  );
}
