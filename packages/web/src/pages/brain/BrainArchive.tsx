import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import { brainSearch, defaultTemporal, type BrainSearchResult } from "../../lib/brainApi";
import { ORG_LEVEL, useOrgProject } from "../../components/OrgProjectPicker";
import { SmartSnippet } from "../../components/SmartSnippet";

export function BrainArchive(): React.ReactElement {
  const [params, setParams] = useSearchParams();
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [kindPrefix, setKindPrefix] = useState(params.get("kind") ?? "");

  const [items, setItems] = useState<BrainSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setErr(null);
    const facets = kindPrefix
      ? { kind_prefix: kindPrefix.split(",").map((s) => s.trim()).filter(Boolean) }
      : undefined;
    brainSearch({
      org_id: orgId,
      project_id: projectId,
      // Scope to the selected project; org-wide only at "— org-level —".
      // The shared default window guarantees a non-empty QuerySpec there.
      scope: projectId && projectId !== ORG_LEVEL ? "project" : "org",
      temporal: defaultTemporal(),
      facets,
      limit: 50,
    })
      .then((r) => setItems(r.results))
      .catch((e) => setErr(humanizeApiError(e)))
      .finally(() => setLoading(false));
  }, [orgId, projectId, kindPrefix]);

  function applyFilter(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(params);
    next.delete("kind");
    if (kindPrefix) next.set("kind", kindPrefix);
    setParams(next);
  }

  return (
    <div className="p-6 space-y-6 text-slate-200">
      <h1 className="text-2xl font-bold">Archive</h1>

      <form
        onSubmit={applyFilter}
        className="flex flex-wrap gap-3 items-end bg-slate-800/50 p-4 rounded-lg"
      >
        <div>
          <label className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
            Kind prefix
          </label>
          <input
            value={kindPrefix}
            onChange={(e) => setKindPrefix(e.target.value)}
            className={inputCls}
            placeholder="conversation/, code/"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium"
        >
          Apply
        </button>
      </form>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400">loading…</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-800">
            <tr>
              <th className="pb-2">kind</th>
              <th className="pb-2">hash</th>
              <th className="pb-2">ts</th>
              <th className="pb-2">session</th>
              <th className="pb-2">snippet</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.hash} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td className="py-2 pr-3 font-mono text-xs">{r.kind}</td>
                <td className="py-2 pr-3">
                  <Link
                    to={`/brain/artifact/${r.hash}?org_id=${orgId}`}
                    className="font-mono text-xs text-blue-400 hover:underline"
                  >
                    {r.hash.slice(0, 10)}…
                  </Link>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-xs text-slate-400">
                  {new Date(r.ts * 1000).toLocaleString()}
                </td>
                <td className="py-2 pr-3 text-xs">
                  {r.session_id ? (
                    <Link
                      to={`/brain/session/${r.session_id}?org_id=${orgId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {r.session_id}
                    </Link>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="py-2 text-xs text-slate-300 line-clamp-2 max-w-xl">
                  <SmartSnippet text={r.snippet} />
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-500 text-sm">
                  no artifacts — specify a project to begin
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

const inputCls =
  "bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500";
