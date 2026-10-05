import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import { brainSearch, defaultTemporal, type BrainSearchResponse } from "../../lib/brainApi";
import { ORG_LEVEL, useOrgProject } from "../../components/OrgProjectPicker";
import { SmartSnippet } from "../../components/SmartSnippet";

export function BrainSearch(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [params] = useSearchParams();
  // Phase 12 (UI review H5) — accept an inbound `?q=…` from the Brain hub
  // so its search box hands off to this page instead of dropping the term.
  const initialQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [kindPrefix, setKindPrefix] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [results, setResults] = useState<BrainSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function execute(currentQuery: string) {
    setLoading(true);
    setErr(null);
    try {
      const facets: Record<string, unknown> = {};
      if (kindPrefix.trim()) {
        facets.kind_prefix = kindPrefix.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (sessionId.trim()) facets.session_id = sessionId.trim();
      const hasFilter =
        !!currentQuery.trim() ||
        Object.keys(facets).length > 0;
      const res = await brainSearch({
        org_id: orgId,
        project_id: projectId,
        scope: projectId && projectId !== ORG_LEVEL ? "project" : "org",
        text: currentQuery.trim() ? { query: currentQuery, mode: "hybrid" } : undefined,
        facets: Object.keys(facets).length > 0 ? facets : undefined,
        temporal: hasFilter ? undefined : defaultTemporal(),
        limit: 20,
        return_score_breakdown: true,
      });
      setResults(res);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    await execute(query);
  }

  // Auto-fire once on mount when an inbound `?q=` is present so users
  // arriving from the hub land on results rather than an empty form.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (ranInitial.current) return;
    if (initialQuery.trim()) {
      ranInitial.current = true;
      void execute(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="p-6 space-y-6 text-slate-200">
      <h1 className="text-2xl font-bold">Brain Search</h1>

      <form
        onSubmit={run}
        className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-800/50 p-4 rounded-lg"
      >
        <Field label="Text query" full>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={inputCls}
            placeholder="jwt migration"
          />
        </Field>
        <Field label="Kind prefix (comma-separated)">
          <input
            value={kindPrefix}
            onChange={(e) => setKindPrefix(e.target.value)}
            className={inputCls}
            placeholder="decision/, code/diff"
          />
        </Field>
        <Field label="Session filter">
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className={inputCls}
            placeholder="sess_..."
          />
        </Field>
        <div className="col-span-full">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {results && (
        <section className="space-y-3">
          <div className="text-sm text-slate-400">
            {results.results.length} of {results.total_candidates} candidates
            {" · "}
            {results.layers_returned.thoughts} thoughts, {results.layers_returned.archive} artifacts
            {" · "}
            {results.latency_ms.toFixed(1)} ms · query {results.query_id}
          </div>
          <ul className="space-y-3">
            {results.results.map((r) => {
              const isThought = r.layer === "thoughts";
              const href = isThought
                ? `/brain/thought/${encodeURIComponent(r.hash)}?org_id=${orgId}`
                : `/brain/artifact/${r.hash}?org_id=${orgId}`;
              return (
                <li
                  key={`${r.layer}:${r.hash}`}
                  className={`bg-slate-800/50 border p-4 rounded-lg ${
                    isThought ? "border-violet-700/60" : "border-slate-700"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2 gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-400 mb-1 flex-wrap">
                        {isThought ? (
                          <span className="bg-violet-900/50 text-violet-200 px-1.5 py-0.5 rounded">
                            thought · {r.thought?.thought_type ?? "observation"}
                          </span>
                        ) : (
                          <span className="font-mono bg-slate-900 px-1.5 py-0.5 rounded">{r.kind}</span>
                        )}
                        <span>{new Date(r.ts * 1000).toLocaleString()}</span>
                        {r.session_id && <span>· session: {r.session_id}</span>}
                        {isThought && r.thought?.visibility && r.thought.visibility !== "active" && (
                          <span>· {r.thought.visibility}</span>
                        )}
                      </div>
                      <Link
                        to={href}
                        className="text-sm text-slate-200 hover:text-blue-400 font-mono break-all"
                      >
                        {isThought ? "Open thought →" : `${r.hash.slice(0, 16)}…`}
                      </Link>
                    </div>
                    <div className="text-right text-xs text-slate-400 shrink-0">
                      <div>score: {r.score.toFixed(4)}</div>
                      <div>rank: {r.fused_rank}</div>
                    </div>
                  </div>
                  <p className="text-sm text-slate-300 line-clamp-3">
                    <SmartSnippet text={r.snippet} />
                  </p>
                  {r.score_breakdown && (
                    <details className="mt-2 text-xs text-slate-400">
                      <summary className="cursor-pointer hover:text-slate-200">
                        score breakdown
                      </summary>
                      <pre className="mt-2 overflow-x-auto">
                        {JSON.stringify(r.score_breakdown, null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

const inputCls =
  "w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500";

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}): React.ReactElement {
  return (
    <label className={`block ${full ? "col-span-full" : ""}`}>
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
