/**
 * Shared modal that pretty-prints any JS value as JSON. Used by Brain
 * detail pages' toolbar in place of the previous "Raw JSON" link, which
 * pointed at an x-api-key-protected endpoint and silently 401'd in any
 * deployment with auth on. The data this modal renders is already in
 * page state, so we never make a second request.
 *
 * Large blobs (binary content, multi-MB base64) are summarised before
 * stringify — running JSON.stringify on a 5MB string blocks the main
 * thread for hundreds of ms. The summary preserves the keys but
 * replaces the payload with `{ omitted: "<N> chars" }` so the user
 * still sees the structure. There's a "show full" toggle for the rare
 * case the user actually wants the full payload.
 *
 * Click backdrop or Esc to close. "Copy" copies whatever is currently
 * displayed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface JsonViewerModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly data: unknown;
}

/** Threshold above which a string field is replaced with a stub on the
 *  default render path. 32k is roughly where stringify+render starts
 *  to feel sluggish in DevTools profiling on a mid-tier laptop. */
const SUMMARISE_STRING_THRESHOLD = 32_768;

function summariseLargeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > SUMMARISE_STRING_THRESHOLD) {
      return {
        __omitted: true,
        chars: value.length,
        preview: `${value.slice(0, 200)}…`,
      };
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(summariseLargeStrings);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = summariseLargeStrings(v);
    }
    return out;
  }
  return value;
}

export function JsonViewerModal({
  open,
  onClose,
  title = "Raw JSON",
  data,
}: JsonViewerModalProps): React.ReactElement | null {
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Reset toggle each time the modal is reopened — we don't want users
  // landing on the heavy view because the previous artifact happened to
  // need it.
  useEffect(() => {
    if (open) setShowFull(false);
  }, [open]);

  // Compute prepared payload only when the modal is open. JSON.stringify
  // on the artifact response is the expensive part — keep it inside
  // useMemo so it doesn't re-run on every keystroke, etc.
  const { pretty, omittedCount } = useMemo(() => {
    if (!open) return { pretty: "", omittedCount: 0 };
    const safe = showFull ? data : summariseLargeStrings(data);
    let omitted = 0;
    if (!showFull) {
      const walk = (v: unknown): void => {
        if (
          v &&
          typeof v === "object" &&
          (v as { __omitted?: boolean }).__omitted === true
        ) {
          omitted += 1;
          return;
        }
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const x of Object.values(v as Record<string, unknown>)) walk(x);
        }
      };
      walk(safe);
    }
    try {
      return { pretty: JSON.stringify(safe, null, 2), omittedCount: omitted };
    } catch {
      return { pretty: String(safe), omittedCount: omitted };
    }
  }, [open, showFull, data]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pretty);
    } catch {
      // ignore — visual nudge below still confirms the action
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [pretty]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-700 rounded-xl max-w-4xl max-h-[85vh] w-full overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800 gap-3">
          <div className="text-sm font-semibold text-slate-200 truncate">{title}</div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {omittedCount > 0 && !showFull && (
              <button
                type="button"
                onClick={() => setShowFull(true)}
                className="text-xs px-2 py-1 rounded bg-amber-950/40 border border-amber-900 text-amber-300 hover:bg-amber-900/40"
                title="Render the full payload — may be slow for multi-MB content"
              >
                Show full ({omittedCount} omitted)
              </button>
            )}
            {showFull && (
              <button
                type="button"
                onClick={() => setShowFull(false)}
                className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300"
              >
                Summarise
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300"
            >
              {copied ? "copied ✓" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-slate-500 hover:text-white px-1"
            >
              ✕
            </button>
          </div>
        </div>
        <pre className="flex-1 overflow-auto bg-slate-950 text-xs text-slate-200 font-mono p-4 leading-5 whitespace-pre">
          {pretty}
        </pre>
      </div>
    </div>
  );
}
