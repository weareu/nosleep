/**
 * One-line snippet for list rows (timeline, search, archive). JSON payloads
 * render as `Kind — meaningful name field` instead of the raw blob; prose
 * renders with markdown syntax stripped.
 */

import { smartLabel } from "../lib/smart-json";

export function SmartSnippet({
  text,
  fallback = "[no snippet]",
}: {
  text: string | null | undefined;
  fallback?: string;
}): React.ReactElement {
  if (!text || !text.trim()) return <span className="text-slate-600">{fallback}</span>;
  const { kind, label } = smartLabel(text);
  return (
    <>
      {kind && (
        <span className="text-[10px] font-mono uppercase tracking-wide text-slate-500 bg-slate-800 rounded px-1 py-px mr-1.5 align-middle">
          {kind}
        </span>
      )}
      <span>{label || text}</span>
    </>
  );
}
