/**
 * Phase 12 (UI review H3+H4) — shared hero + sticky toolbar for the
 * three Brain detail pages (Artifact, Thought, Session). The previous
 * design led with a hash, which is the least-useful piece of info on
 * the page. These components flip that — content snippet/title leads,
 * the hash collapses into a copy-pill, and the toolbar is one place
 * for "Copy", "Open graph", "Open session", "Raw JSON".
 */

import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

interface BrainDetailHeroProps {
  /** Dominant text — snippet, title, content preview. */
  readonly title: string;
  /** Small uppercase pill above the title — "Artifact", "Thought", etc. */
  readonly eyebrow: string;
  /** Single short line under the title — kind, timestamp, etc. */
  readonly subtitle?: React.ReactNode;
  /** Identifier string — full hash or thought id. Rendered as a copy-pill. */
  readonly identifier?: string;
  /** Optional breadcrumb back-link (e.g. /brain) — these detail pages
   *  are routed outside BrainLayout, so they have no other way back. */
  readonly backTo?: string;
  /** Label for the back-link. Defaults to the destination's friendly name. */
  readonly backLabel?: string;
}

export function BrainDetailHero({
  title,
  eyebrow,
  subtitle,
  identifier,
  backTo,
  backLabel = "Brain",
}: BrainDetailHeroProps): React.ReactElement {
  return (
    <div className="space-y-2 mb-3">
      {backTo && (
        <Link
          to={backTo}
          className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          <ArrowLeftIcon />
          <span>{backLabel}</span>
        </Link>
      )}
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          {eyebrow}
        </span>
        {identifier && <CopyPill value={identifier} />}
      </div>
      <h1 className="text-xl font-semibold text-slate-100 leading-snug break-words whitespace-pre-wrap">
        {title}
      </h1>
      {subtitle && (
        <div className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
          {subtitle}
        </div>
      )}
    </div>
  );
}

function ArrowLeftIcon(): React.ReactElement {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

/** Inline pill that shows a truncated id and copies the full value on click. */
export function CopyPill({ value }: { value: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can fail in non-https contexts; fall back to
      // a transient visual nudge so the user knows the click landed.
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }, [value]);

  const display = value.length > 18 ? `${value.slice(0, 12)}…` : value;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Click to copy: ${value}`}
      className="font-mono text-[10px] text-slate-400 bg-slate-900 border border-slate-800 hover:border-slate-700 hover:text-slate-200 rounded px-1.5 py-0.5 transition-colors"
    >
      {copied ? "copied ✓" : display}
    </button>
  );
}

interface ToolbarAction {
  readonly label: string;
  readonly icon?: React.ReactNode;
  /** Either an in-app route, an external href, or an onClick handler. */
  readonly to?: string;
  readonly href?: string;
  readonly onClick?: () => void | Promise<void>;
  /** Visual treatment — destructive renders in red. */
  readonly tone?: "default" | "destructive";
  /** Disable when the underlying entity is missing (e.g. no session_id). */
  readonly disabled?: boolean;
}

export function BrainDetailToolbar({
  actions,
}: {
  actions: readonly ToolbarAction[];
}): React.ReactElement {
  return (
    <div className="sticky top-0 z-10 -mx-6 px-6 py-2 bg-slate-900/95 backdrop-blur border-b border-slate-800 flex items-center gap-2 flex-wrap">
      {actions.map((a) => (
        <ToolbarButton key={a.label} action={a} />
      ))}
    </div>
  );
}

function ToolbarButton({ action }: { action: ToolbarAction }): React.ReactElement {
  const baseClass =
    "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors";
  const toneClass =
    action.tone === "destructive"
      ? "bg-red-950/40 border-red-900 text-red-300 hover:bg-red-900/40"
      : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white";
  const disabledClass = action.disabled
    ? "opacity-40 pointer-events-none"
    : "";

  const inner = (
    <>
      {action.icon}
      <span>{action.label}</span>
    </>
  );

  if (action.disabled) {
    return (
      <span className={`${baseClass} ${toneClass} ${disabledClass}`}>{inner}</span>
    );
  }
  if (action.to) {
    return (
      <Link to={action.to} className={`${baseClass} ${toneClass}`}>
        {inner}
      </Link>
    );
  }
  if (action.href) {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClass} ${toneClass}`}
      >
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      className={`${baseClass} ${toneClass}`}
    >
      {inner}
    </button>
  );
}

// ── Tiny inline icons so the toolbar is visually scannable ───────────

export function GraphIcon(): React.ReactElement {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <circle cx="6" cy="6" r="2" strokeWidth={1.6} />
      <circle cx="18" cy="6" r="2" strokeWidth={1.6} />
      <circle cx="12" cy="18" r="2" strokeWidth={1.6} />
      <path strokeLinecap="round" strokeWidth={1.6} d="M7.5 7.3l3.5 9M16.5 7.3l-3.5 9" />
    </svg>
  );
}

export function CodeIcon(): React.ReactElement {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M8 6l-4 6 4 6M16 6l4 6-4 6"
      />
    </svg>
  );
}

export function CopyIcon(): React.ReactElement {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M9 5h8a2 2 0 012 2v10M5 9h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z"
      />
    </svg>
  );
}

export function SessionIcon(): React.ReactElement {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M3 6h18M3 12h18M3 18h18"
      />
    </svg>
  );
}
