import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  apiFetch,
  fetchOrgs,
  fetchSessions,
  type OrgWithStats,
  type SessionRow,
} from "../lib/api";

interface DailyTokenRow {
  day: string;
  org_id: string;
  tokens: number;
}

function fetchDailyTokens(days = 30): Promise<DailyTokenRow[]> {
  return apiFetch<DailyTokenRow[]>(`/metrics/tokens/daily?days=${days}`);
}

const SLUG_BY_ORG: Record<string, string> = {
  org_personal: "personal",
  org_wyobi: "wyobi",
  org_apply: "apply",
};

const ORG_COLORS: Record<string, string> = {
  personal: "#6366f1",
  wyobi: "#f59e0b",
  apply: "#10b981",
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/**
 * Pivot the per-day-per-org rows from `/api/metrics/tokens/daily` into the
 * date-keyed shape recharts expects. Always emits the full N-day window —
 * any missing day shows zero for every org instead of disappearing.
 */
function pivotDailyData(
  rows: DailyTokenRow[],
  orgs: OrgWithStats[],
  days = 30,
): Array<Record<string, unknown>> {
  const orgSlug = (orgId: string): string =>
    SLUG_BY_ORG[orgId] ??
    orgs.find((o) => o.id === orgId)?.slug ??
    orgId.replace(/^org_/, "");

  const byDay = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const e = byDay.get(r.day) ?? { date: r.day };
    e[orgSlug(r.org_id)] = r.tokens;
    byDay.set(r.day, e);
  }

  // Fill any missing days so the x-axis is contiguous.
  const out: Array<Record<string, unknown>> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const e = byDay.get(key) ?? { date: key };
    const row: Record<string, unknown> = { date: label };
    for (const org of orgs) row[org.slug] = e[org.slug] ?? 0;
    out.push(row);
  }
  return out;
}

function BudgetGauge({
  label,
  used,
  limit,
  color,
}: {
  label: string;
  used: number;
  limit: number;
  color: string;
}): React.ReactElement {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  let strokeColor = color;
  if (pct > 95) strokeColor = "#ef4444";
  else if (pct > 80) strokeColor = "#f59e0b";

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-24 h-24">
        <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#334155" strokeWidth="8" />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold text-white">{Math.round(pct)}%</span>
        </div>
      </div>
      <p className="text-xs text-slate-400 mt-2">{label}</p>
      <p className="text-[10px] text-slate-600">
        {formatTokens(used)} / {formatTokens(limit)}
      </p>
    </div>
  );
}

export function TokenUsage(): React.ReactElement {
  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });

  const { data: sessions } = useQuery<SessionRow[]>({
    queryKey: ["sessions-all"],
    queryFn: () => fetchSessions(),
  });

  const { data: dailyRows = [] } = useQuery<DailyTokenRow[]>({
    queryKey: ["tokens-daily", 30],
    queryFn: () => fetchDailyTokens(30),
  });

  const dailyData = orgs ? pivotDailyData(dailyRows, orgs, 30) : [];
  const hasDailyData = dailyData.some((row) =>
    Object.entries(row).some(
      ([k, v]) => k !== "date" && typeof v === "number" && v > 0,
    ),
  );

  // Top sessions by token usage
  const topSessions = [...(sessions ?? [])]
    .sort((a, b) => b.tokens_used - a.tokens_used)
    .slice(0, 10);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Token Usage</h1>
        <p className="text-sm text-slate-500 mt-0.5">Monitor token consumption across all accounts</p>
      </div>

      {/* Budget Gauges */}
      <div className="bg-slate-800 rounded-xl border border-slate-700/50 p-6">
        <h3 className="text-sm font-semibold text-slate-400 mb-4">Budget Status (Today)</h3>
        <div className="flex justify-around">
          {orgs?.map((org) => (
            <BudgetGauge
              key={org.id}
              label={org.name}
              used={org.todayTokens}
              limit={1_000_000}
              color={ORG_COLORS[org.slug] ?? "#6366f1"}
            />
          ))}
        </div>
      </div>

      {/* Daily line chart */}
      <div className="bg-slate-800 rounded-xl border border-slate-700/50 p-6">
        <h3 className="text-sm font-semibold text-slate-400 mb-4">Daily Token Usage (Last 30 Days)</h3>
        {!hasDailyData ? (
          <div className="h-40 flex flex-col items-center justify-center text-center">
            <p className="text-slate-400 text-sm">No token usage recorded yet.</p>
            <p className="text-slate-600 text-xs mt-1">
              Numbers populate as Claude Code sessions run and post token deltas via the post-tool hook.
            </p>
          </div>
        ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} />
              <YAxis
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickFormatter={(v: number) => formatTokens(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                formatter={(value: number) => [formatTokens(value), ""]}
              />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              {orgs?.map((org) => (
                <Line
                  key={org.slug}
                  type="monotone"
                  dataKey={org.slug}
                  name={org.name}
                  stroke={ORG_COLORS[org.slug] ?? "#6366f1"}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        )}
      </div>

      {/* Stacked bar chart */}
      <div className="bg-slate-800 rounded-xl border border-slate-700/50 p-6">
        <h3 className="text-sm font-semibold text-slate-400 mb-4">Tokens per Org per Day</h3>
        {!hasDailyData ? (
          <div className="h-40 flex items-center justify-center text-slate-600 text-xs">
            No data yet.
          </div>
        ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} />
              <YAxis
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickFormatter={(v: number) => formatTokens(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                formatter={(value: number) => [formatTokens(value), ""]}
              />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              {orgs?.map((org) => (
                <Bar
                  key={org.slug}
                  dataKey={org.slug}
                  name={org.name}
                  stackId="tokens"
                  fill={ORG_COLORS[org.slug] ?? "#6366f1"}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        )}
      </div>

      {/* Top sessions table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700/50 p-6">
        <h3 className="text-sm font-semibold text-slate-400 mb-4">Top Sessions by Token Consumption</h3>
        {topSessions.length === 0 ? (
          <p className="text-sm text-slate-600 text-center py-4">No sessions recorded</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider">
                <th className="text-left pb-3 font-medium">Project</th>
                <th className="text-left pb-3 font-medium">Org</th>
                <th className="text-left pb-3 font-medium">Status</th>
                <th className="text-right pb-3 font-medium">Tokens</th>
                <th className="text-right pb-3 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {topSessions.map((session) => (
                <tr key={session.id} className="border-t border-slate-700/20">
                  <td className="py-2.5 text-sm text-white">{session.project_name}</td>
                  <td className="py-2.5">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${session.org_color}20`,
                        color: session.org_color,
                      }}
                    >
                      {session.org_name}
                    </span>
                  </td>
                  <td className="py-2.5 text-xs text-slate-400 capitalize">{session.status}</td>
                  <td className="py-2.5 text-sm text-white text-right font-mono">
                    {formatTokens(session.tokens_used)}
                  </td>
                  <td className="py-2.5 text-xs text-slate-500 text-right">
                    {new Date(session.started_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
