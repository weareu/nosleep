import { useEffect, useState } from "react";
import { humanizeApiError } from "../../../lib/humanize-error";
import {
  brainAdminStorage,
  brainAdminExtractors,
  brainAdminRollup,
  type BrainStorageInfo,
  type BrainExtractorHealth,
} from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";

export function BrainAdminDashboard(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [storage, setStorage] = useState<BrainStorageInfo | null>(null);
  const [extractors, setExtractors] = useState<BrainExtractorHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [s, e] = await Promise.all([
        brainAdminStorage(orgId),
        brainAdminExtractors({ org_id: orgId, since_hours: 24 }),
      ]);
      setStorage(s);
      setExtractors(e.items);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function recomputeRollup() {
    setRolling(true);
    try {
      await brainAdminRollup(orgId);
      await load();
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setRolling(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return (
    <div className="p-6 space-y-6 text-slate-200">
      <div className="flex items-end gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-bold">Brain Admin</h1>
          <p className="text-sm text-slate-400 mt-1">Org-level health, storage, and extractor activity.</p>
        </div>
        <button
          type="button"
          onClick={recomputeRollup}
          disabled={rolling}
          className="px-3 py-2 text-sm rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50"
        >
          {rolling ? "Rolling up…" : "Recompute rollups"}
        </button>
      </div>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">{err}</div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {storage &&
          Object.entries(storage.counts).map(([k, v]) => (
            <div
              key={k}
              className="bg-slate-800/50 border border-slate-800 p-4 rounded"
            >
              <div className="text-xs uppercase text-slate-500 tracking-wide">{k.replace(/_/g, " ")}</div>
              <div className="text-2xl font-bold mt-1">{v.toLocaleString()}</div>
            </div>
          ))}
      </section>

      <section className="bg-slate-800/40 border border-slate-800 p-4 rounded-lg">
        <h2 className="text-sm font-semibold mb-3">Storage</h2>
        {storage ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-400">active.db</dt>
            <dd className="font-mono text-xs">
              {humanBytes(storage.active_db_size_bytes)}
            </dd>
            <dt className="text-slate-400">sealed files</dt>
            <dd>{storage.sealed_files_on_disk.length}</dd>
            {storage.sealed_files_on_disk.length > 0 && (
              <>
                <dt className="text-slate-400">sealed total</dt>
                <dd className="font-mono text-xs">
                  {humanBytes(
                    storage.sealed_files_on_disk.reduce((a, b) => a + b.size, 0),
                  )}
                </dd>
              </>
            )}
          </dl>
        ) : loading ? (
          <div className="text-slate-500">loading…</div>
        ) : (
          <div className="text-slate-500">no data</div>
        )}
      </section>

      <section className="bg-slate-800/40 border border-slate-800 p-4 rounded-lg">
        <h2 className="text-sm font-semibold mb-3">Extractors (last 24h)</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500 tracking-wide border-b border-slate-700">
            <tr>
              <th className="py-2">extractor</th>
              <th>total</th>
              <th>success</th>
              <th>failed</th>
              <th>skipped</th>
              <th>avg ms</th>
              <th>max ms</th>
              <th>last</th>
            </tr>
          </thead>
          <tbody>
            {extractors.map((e) => (
              <tr key={e.extractor} className="border-b border-slate-800/50">
                <td className="py-2 font-mono text-xs">{e.extractor}</td>
                <td>{e.total}</td>
                <td className="text-emerald-400">{e.success}</td>
                <td className={e.failed > 0 ? "text-red-400" : ""}>{e.failed}</td>
                <td className="text-slate-400">{e.skipped}</td>
                <td>{(e.avg_ms ?? 0).toFixed(0)}</td>
                <td>{(e.max_ms ?? 0).toFixed(0)}</td>
                <td className="text-slate-500 text-xs">
                  {e.last_run ? new Date(e.last_run * 1000).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
            {!extractors.length && (
              <tr>
                <td colSpan={8} className="py-3 text-slate-500 text-sm">
                  no extractor runs in window
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
