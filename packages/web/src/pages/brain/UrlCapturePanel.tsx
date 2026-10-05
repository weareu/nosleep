/**
 * URL capture for Brain Capture. Also the bookmarklet's landing target:
 * the bookmarklet opens /brain/capture?url=…&note=… as a top-level page
 * (a cross-origin fetch from an arbitrary site is blocked by CORS /
 * Private Network Access), and this panel captures it once on arrival.
 */

import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { brainCaptureUrl, type BrainCaptureUrlResult } from "../../lib/brainApi";

type State =
  | { status: "idle" }
  | { status: "capturing" }
  | { status: "done"; result: BrainCaptureUrlResult }
  | { status: "error"; message: string };

export function UrlCapturePanel(props: {
  orgId: string;
  projectId: string;
}): React.ReactElement {
  const { orgId, projectId } = props;
  const [params, setParams] = useSearchParams();
  const [url, setUrl] = useState(() => params.get("url") ?? "");
  const [note, setNote] = useState(() => params.get("note") ?? "");
  const [state, setState] = useState<State>({ status: "idle" });
  const autoRan = useRef(false);

  async function capture(
    target: string,
    noteText: string,
    opts: { org?: string | null; project?: string | null; mode?: string | null; bookmarklet?: boolean } = {},
  ): Promise<void> {
    setState({ status: "capturing" });
    try {
      const result = await brainCaptureUrl({
        url: target,
        org_id: opts.org || orgId,
        project_id: opts.project || projectId,
        mode: opts.mode === "ref" ? "ref" : "full",
        note: noteText.trim() || undefined,
        tags: opts.bookmarklet ? ["bookmarklet"] : ["web"],
      });
      setState({ status: "done", result });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  // Bookmarklet arrival: capture once, then drop the params so a reload
  // doesn't capture again.
  useEffect(() => {
    const fromBookmarklet = params.get("url");
    if (!fromBookmarklet || autoRan.current) return;
    autoRan.current = true;
    void capture(fromBookmarklet, params.get("note") ?? "", {
      org: params.get("org_id"),
      project: params.get("project_id"),
      mode: params.get("mode"),
      bookmarklet: true,
    }).finally(() => {
      setParams({}, { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canCapture = /^https?:\/\//i.test(url.trim()) && state.status !== "capturing";
  const fetchHash = state.status === "done" ? state.result.fetch_hash ?? null : null;
  const target = state.status === "done" ? fetchHash ?? state.result.link_hash : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 mt-4">
      <div className="text-sm font-semibold mb-2">Capture a URL</div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… (web page or PDF)"
          data-testid="brain-url-input"
          className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded p-2 text-sm placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
        />
        <button
          type="button"
          disabled={!canCapture}
          onClick={() => void capture(url.trim(), note)}
          className={
            "px-3 py-2 rounded text-sm font-medium " +
            (canCapture
              ? "bg-blue-500 hover:bg-blue-600 text-white"
              : "bg-slate-800 text-slate-500 cursor-not-allowed")
          }
        >
          {state.status === "capturing" ? "Capturing…" : "Capture URL"}
        </button>
      </div>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note (becomes a linked thought)"
        className="w-full mt-2 bg-slate-950 border border-slate-800 rounded p-2 text-sm placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
      />
      {state.status === "error" && (
        <div role="status" className="mt-3 text-sm rounded px-3 py-2 bg-red-500/10 text-red-300 border border-red-500/30">
          Capture failed: {state.message}
        </div>
      )}
      {state.status === "done" && (
        <div
          role="status"
          data-testid="brain-url-result"
          className={
            "mt-3 text-sm rounded px-3 py-2 border " +
            (state.result.fetch_error || state.result.error
              ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
              : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30")
          }
        >
          Captured {state.result.title ?? state.result.normalized_url}
          {state.result.pages ? ` · ${state.result.pages.length} PDF pages searchable` : ""}
          {state.result.fetch_error ? ` · ${state.result.fetch_error}` : ""}
          {!state.result.fetch_error && state.result.error ? ` · ${state.result.error}` : ""}
          {target && (
            <>
              {" · "}
              <Link className="underline" to={`/brain/artifact/${target}?org_id=${encodeURIComponent(orgId)}`}>
                open
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
