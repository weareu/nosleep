import { useEffect, useState } from "react";
import { humanizeApiError } from "../../../lib/humanize-error";
import { useOrgProject } from "../../../components/OrgProjectPicker";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { brainAdminMetrics, type BrainMetricSeries } from "../../../lib/brainApi";

const DEFAULT_KEYS = [
  "artifacts.ingested.count",
  "artifacts.ingested.bytes",
  "artifacts.dedup_hit",
  "extractor.latency_ms",
  "hook.latency_ms",
  "query.latency_ms",
  "tokens.total",
  "cost.usd",
];

const RANGES: Array<{ label: string; secs: number; resolution?: "raw" | "1h" | "1d" }> = [
  { label: "1h", secs: 3600, resolution: "raw" },
  { label: "24h", secs: 86400, resolution: "raw" },
  { label: "7d", secs: 7 * 86400, resolution: "1h" },
  { label: "30d", secs: 30 * 86400, resolution: "1h" },
  { label: "90d", secs: 90 * 86400, resolution: "1d" },
];

export function BrainAdminMetrics(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const projectId = scope.projectId === "_org_level" ? "" : scope.projectId;
  const [rangeIdx, setRangeIdx] = useState(1);
  const [series, setSeries] = useState<Record<string, BrainMetricSeries>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    const range = RANGES[rangeIdx];
    const to = Math.floor(Date.now() / 1000);
    const from = to - range.secs;
    try {
      const fetched: Record<string, BrainMetricSeries> = {};
      await Promise.all(
        DEFAULT_KEYS.map(async (key) => {
          fetched[key] = await brainAdminMetrics({
            org_id: orgId,
            metric_key: key,
            project_id: projectId || undefined,
            from,
            to,
            resolution: range.resolution,
          });
        }),
      );
      setSeries(fetched);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, rangeIdx]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Metrics</h1>
          <p className="text-xs text-slate-400 mt-1">
            org: {orgId} {projectId && `· project: ${projectId}`}
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRangeIdx(i)}
              className={`px-3 py-1.5 rounded border ${
                rangeIdx === i
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-300"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {DEFAULT_KEYS.map((key) => {
          const data = series[key];
          const points =
            data?.points.map((p) => ({
              ts: p.ts,
              t: new Date(p.ts * 1000).toLocaleString(),
              v: p.value,
              avg: p.avg ?? p.value,
              p95: p.p95 ?? p.value,
            })) ?? [];

          return (
            <div
              key={key}
              className="bg-slate-800/40 border border-slate-800 rounded-lg p-3"
            >
              <div className="flex justify-between mb-1 items-baseline">
                <h3 className="font-mono text-xs text-slate-300">{key}</h3>
                <span className="text-xs text-slate-500">
                  {data?.resolution ?? "—"} · {points.length} pts
                </span>
              </div>
              {points.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-slate-600 text-xs">
                  no data
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={points}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="ts"
                      tick={false}
                      stroke="#475569"
                    />
                    <YAxis
                      stroke="#475569"
                      tick={{ fill: "#94a3b8", fontSize: 10 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0f172a",
                        border: "1px solid #334155",
                        fontSize: 11,
                      }}
                      labelFormatter={(ts) => new Date((ts as number) * 1000).toLocaleString()}
                    />
                    <Line
                      type="monotone"
                      dataKey="v"
                      stroke="#3b82f6"
                      strokeWidth={1.5}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          );
        })}
      </div>

      {loading && <div className="text-slate-500 text-sm">loading…</div>}
    </div>
  );
}
