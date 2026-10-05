import { useEffect, useState, useCallback } from "react";
import { fetchMetrics, fetchMetricsByOrg, fetchOrgs, type MetricsSnapshot, type MetricsByOrg, type OrgWithStats } from "../lib/api";

const WINDOWS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
] as const;

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function Metrics(): React.ReactElement {
  const [windowHours, setWindowHours] = useState<number>(24);
  const [orgFilter, setOrgFilter] = useState<string>("");
  const [orgs, setOrgs] = useState<OrgWithStats[]>([]);
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [byOrg, setByOrg] = useState<MetricsByOrg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [snap, perOrg, allOrgs] = await Promise.all([
        fetchMetrics({ windowHours, orgId: orgFilter || undefined }),
        fetchMetricsByOrg(windowHours),
        fetchOrgs(),
      ]);
      setSnapshot(snap);
      setByOrg(perOrg);
      setOrgs(allOrgs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }, [windowHours, orgFilter]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-white">Metrics</h1>
        <div className="flex items-center gap-3">
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200"
          >
            <option value="">All Orgs</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                onClick={() => setWindowHours(w.hours)}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                  windowHours === w.hours
                    ? "bg-blue-500 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 disabled:opacity-50"
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {snapshot && (
        <>
          {/* Top-line stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card title="Sessions">
              <div className="text-3xl font-bold text-white">{formatNumber(snapshot.sessions.total)}</div>
              <div className="text-xs text-slate-500 mt-1">in last {snapshot.windowHours}h</div>
            </Card>
            <Card title="Tokens Used">
              <div className="text-3xl font-bold text-white">{formatNumber(snapshot.tokens.total)}</div>
              <div className="text-xs text-slate-500 mt-1">{formatNumber(snapshot.tokens.velocityPerHour)} / hour</div>
            </Card>
            <Card title="Drift Alerts">
              <div className="text-3xl font-bold text-white">{snapshot.drift.alertCount}</div>
              <div className="text-xs text-slate-500 mt-1">{snapshot.drift.perSession.toFixed(2)} / session</div>
            </Card>
            <Card title="Escalations">
              <div className="text-3xl font-bold text-white">{snapshot.escalations.alertCount}</div>
              <div className="text-xs text-slate-500 mt-1">{snapshot.escalations.perSession.toFixed(2)} / session</div>
            </Card>
          </div>

          {/* Duration percentiles */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Session Duration ({snapshot.sessions.durationSeconds.count} completed)
            </h2>
            <div className="grid grid-cols-4 gap-4">
              <Stat label="p50" value={formatDuration(snapshot.sessions.durationSeconds.p50)} />
              <Stat label="p95" value={formatDuration(snapshot.sessions.durationSeconds.p95)} />
              <Stat label="max" value={formatDuration(snapshot.sessions.durationSeconds.max)} />
              <Stat label="avg" value={formatDuration(snapshot.sessions.durationSeconds.avg)} />
            </div>
          </div>

          {/* Validation outcomes */}
          {Object.keys(snapshot.validation).length > 0 && (
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Validation Outcomes</h2>
              <div className="flex gap-6">
                {Object.entries(snapshot.validation).map(([verdict, count]) => {
                  const color = verdict === "complete"
                    ? "text-green-400"
                    : verdict === "stub"
                      ? "text-red-400"
                      : "text-amber-400";
                  return (
                    <div key={verdict}>
                      <div className={`text-2xl font-bold ${color}`}>{count}</div>
                      <div className="text-xs text-slate-500 uppercase tracking-wider">{verdict}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Per-org breakdown */}
          {byOrg.length > 0 && (
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-700">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">By Organization</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-900/50">
                  <tr className="text-left text-slate-400">
                    <th className="px-5 py-2 font-medium">Org</th>
                    <th className="px-5 py-2 font-medium text-right">Sessions</th>
                    <th className="px-5 py-2 font-medium text-right">Tokens</th>
                    <th className="px-5 py-2 font-medium text-right">Avg Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {byOrg.map((row) => {
                    const org = orgs.find((o) => o.id === row.org_id);
                    return (
                      <tr key={row.org_id} className="border-t border-slate-700/50">
                        <td className="px-5 py-3 text-white">
                          <span style={{ color: org?.color }}>●</span>{" "}
                          {org?.name ?? row.org_id}
                        </td>
                        <td className="px-5 py-3 text-right text-slate-300">{formatNumber(row.session_count)}</td>
                        <td className="px-5 py-3 text-right text-slate-300">{formatNumber(row.token_total)}</td>
                        <td className="px-5 py-3 text-right text-slate-300">{formatDuration(Math.round(row.avg_duration_sec))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-xs text-slate-500">
            Generated {new Date(snapshot.generatedAt).toLocaleString()} · auto-refresh every 30s
          </div>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-slate-500 uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}
