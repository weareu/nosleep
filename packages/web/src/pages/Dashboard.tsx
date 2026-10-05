import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOrgs, ackAlert, type OrgWithStats } from "../lib/api";
import { useSessions } from "../hooks/useSessions";
import { useAlerts } from "../hooks/useAlerts";
import { SessionCard } from "../components/SessionCard";
import { AlertItem } from "../components/AlertItem";
import { SystemStats } from "../components/SystemStats";
import { EscalationQueue } from "../components/EscalationQueue";

// Phase 12 (UI review #2 — L2) — landing-page surface for power features
// that otherwise live only in the sidebar.
const QUICK_LINKS: Array<{ to: string; label: string; description: string }> = [
  { to: "/projects", label: "Projects", description: "Launch + configure" },
  { to: "/strategy", label: "Strategy", description: "Trees & tasks" },
  { to: "/brain", label: "Brain", description: "Search the archive" },
  { to: "/coordination", label: "Coordination", description: "Locks · peers" },
];

const ACTIVE_STATUSES = new Set(["starting", "running", "idle", "waiting_input", "paused"]);

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export function Dashboard(): React.ReactElement {
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });

  const { data: sessions } = useSessions(selectedOrg);
  const { data: alerts } = useAlerts(selectedOrg, true);

  const activeSessions = sessions?.filter((s) => ACTIVE_STATUSES.has(s.status)) ?? [];
  // Bumped 6 → 30 so manual `claude` sessions (which finish as `stopped`
  // and therefore land in "recent" rather than "active") don't get hidden
  // behind a small cap. Dashboard scrolls naturally past 30.
  const recentSessions = sessions?.filter((s) => !ACTIVE_STATUSES.has(s.status)).slice(0, 30) ?? [];

  const totalTokensToday = orgs?.reduce((sum, org) => sum + org.todayTokens, 0) ?? 0;

  const handleAck = async (id: number) => {
    await ackAlert(id);
    queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar - Org Tabs */}
      <div className="flex-shrink-0 border-b border-slate-800 px-6 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelectedOrg(undefined)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              !selectedOrg
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            All
          </button>
          {orgs?.map((org) => (
            <button
              key={org.id}
              onClick={() => setSelectedOrg(org.id === selectedOrg ? undefined : org.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-2 ${
                selectedOrg === org.id ? "text-white" : "text-slate-400 hover:text-white"
              }`}
              style={{
                backgroundColor: selectedOrg === org.id ? `${org.color}30` : undefined,
                borderColor: selectedOrg === org.id ? org.color : "transparent",
                borderWidth: "1px",
              }}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: org.color }}
              />
              {org.name}
              {org.activeSessions > 0 && (
                <span className="text-xs opacity-70">{org.activeSessions}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Quick links — surfaces power features that aren't immediately
          obvious from the sidebar alone. */}
      <div className="flex-shrink-0 border-b border-slate-800 px-6 py-2 flex flex-wrap gap-2">
        {QUICK_LINKS.map((q) => (
          <Link
            key={q.to}
            to={q.to}
            className="group flex items-baseline gap-2 px-3 py-1.5 rounded-md text-xs bg-slate-800/60 hover:bg-slate-800 border border-slate-800 hover:border-slate-700"
          >
            <span className="text-slate-200 font-medium">{q.label}</span>
            <span className="text-slate-500 group-hover:text-slate-400">
              {q.description}
            </span>
          </Link>
        ))}
      </div>

      {/* System Stats Bar */}
      <SystemStats />

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Active Sessions */}
          <div className="mb-8">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Active Sessions ({activeSessions.length})
            </h2>
            {activeSessions.length === 0 ? (
              <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 p-8 text-center">
                <p className="text-slate-300 text-sm font-medium">
                  Nothing running right now
                </p>
                <p className="text-slate-500 text-xs mt-1 mb-4">
                  Launch a Claude Code session and it'll show up here live.
                </p>
                <Link
                  to="/projects"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
                >
                  <span>Launch a session</span>
                  <span aria-hidden="true">→</span>
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {activeSessions.map((session) => (
                  <SessionCard key={session.id} session={session} />
                ))}
              </div>
            )}
          </div>

          {/* Recent Completed */}
          {recentSessions.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
                Recent Sessions
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {recentSessions.map((session) => (
                  <SessionCard key={session.id} session={session} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Sidebar - Escalation Queue + Alerts */}
        <aside className="w-80 flex-shrink-0 border-l border-slate-800 overflow-auto">
          <div className="p-4 border-b border-slate-800">
            <EscalationQueue />
          </div>
          <div className="p-4">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Recent Alerts
              {(alerts?.length ?? 0) > 0 && (
                <span className="ml-2 text-xs bg-red-500/20 text-red-400 rounded-full px-1.5 py-0.5">
                  {alerts?.length}
                </span>
              )}
            </h3>
            <div className="space-y-2">
              {alerts && alerts.length > 0 ? (
                alerts.slice(0, 20).map((alert) => (
                  <AlertItem key={alert.id} alert={alert} onAck={handleAck} />
                ))
              ) : (
                <p className="text-sm text-slate-600 text-center py-4">No unacknowledged alerts</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Bottom Bar - Aggregate Stats */}
      <div className="flex-shrink-0 border-t border-slate-800 px-6 py-2.5 flex items-center justify-between text-xs text-slate-500">
        <div className="flex items-center gap-6">
          {orgs?.map((org) => (
            <span key={org.id} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: org.color }} />
              <span className="text-slate-400">{org.name}:</span>
              <span className="text-slate-300 font-medium">{formatTokens(org.todayTokens)}</span>
            </span>
          ))}
        </div>
        <span className="text-slate-300">
          Total today: <strong className="text-white">{formatTokens(totalTokensToday)}</strong> tokens
        </span>
      </div>
    </div>
  );
}
