import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchOrgs,
  fetchCoordinationLocks,
  fetchCoordinationMessages,
  fetchCoordinationPeers,
  releaseCoordinationLock,
  type OrgWithStats,
  type CoordinationLock,
  type CoordinationMessage,
  type CoordinationPeer,
} from "../lib/api";

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function duration(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "0s";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500/20 text-green-400",
  idle: "bg-yellow-500/20 text-yellow-400",
  waiting_input: "bg-blue-500/20 text-blue-400",
};

const MSG_TYPE_COLORS: Record<string, string> = {
  discovery: "bg-cyan-500/20 text-cyan-400",
  request: "bg-purple-500/20 text-purple-400",
  handoff: "bg-amber-500/20 text-amber-400",
  conflict: "bg-red-500/20 text-red-400",
  info: "bg-slate-500/20 text-slate-400",
};

export function Coordination(): React.ReactElement {
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });

  const { data: peers } = useQuery<CoordinationPeer[]>({
    queryKey: ["coordination-peers", selectedOrg],
    queryFn: () => fetchCoordinationPeers(selectedOrg),
    refetchInterval: 5000,
  });

  const { data: locks } = useQuery<CoordinationLock[]>({
    queryKey: ["coordination-locks", selectedOrg],
    queryFn: () => fetchCoordinationLocks(selectedOrg),
    refetchInterval: 5000,
  });

  const { data: messages } = useQuery<CoordinationMessage[]>({
    queryKey: ["coordination-messages", selectedOrg],
    queryFn: () => fetchCoordinationMessages(selectedOrg, 50),
    refetchInterval: 10000,
  });

  // Phase 12 (UI review #2 — M6) — destructive confirm before dropping a
  // file lock another running session may depend on.
  const handleReleaseLock = async (lockId: string) => {
    const ok = window.confirm(
      "Release this file lock? Any session holding it will lose exclusive write access.",
    );
    if (!ok) return;
    try {
      await releaseCoordinationLock(lockId);
    } catch (e) {
      window.alert(
        `Couldn't release lock: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["coordination-locks"] });
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
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-6 space-y-8">
        {/* Active Peers */}
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
            Active Peers ({peers?.length ?? 0})
          </h2>
          {!peers || peers.length === 0 ? (
            <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 p-8 text-center">
              <p className="text-slate-500 text-sm">No active peers</p>
              <p className="text-slate-600 text-xs mt-1">Sessions will appear here when running</p>
            </div>
          ) : (
            <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Session</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Project</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Goal</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {peers.map((peer) => (
                    <tr key={peer.id} className="border-b border-slate-700/30 hover:bg-slate-800/40">
                      <td className="px-4 py-3">
                        <span className="font-mono text-slate-300">{peer.id.slice(0, 8)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: peer.org_color }}
                          />
                          <span className="text-slate-300">{peer.project_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-400 max-w-sm truncate">
                        {peer.goal_text.slice(0, 60)}{peer.goal_text.length > 60 ? "..." : ""}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[peer.status] ?? "bg-slate-700 text-slate-300"}`}>
                          {peer.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* File Locks */}
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
            File Locks ({locks?.length ?? 0})
          </h2>
          {!locks || locks.length === 0 ? (
            <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 p-8 text-center">
              <p className="text-slate-500 text-sm">No active file locks</p>
            </div>
          ) : (
            <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">File Path</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Holder</th>
                    <th className="text-left px-4 py-3 text-slate-500 font-medium">Duration</th>
                    <th className="text-right px-4 py-3 text-slate-500 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {locks.map((lock) => (
                    <tr key={lock.id} className="border-b border-slate-700/30 hover:bg-slate-800/40">
                      <td className="px-4 py-3">
                        <span className="font-mono text-slate-300 text-xs">{lock.file_path}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-slate-400">{lock.session_id.slice(0, 8)}</span>
                        {lock.project_name && (
                          <span className="text-slate-600 ml-2 text-xs">({lock.project_name})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {duration(lock.locked_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleReleaseLock(lock.id)}
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          Release
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Message Log */}
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
            Message Log ({messages?.length ?? 0})
          </h2>
          {!messages || messages.length === 0 ? (
            <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 p-8 text-center">
              <p className="text-slate-500 text-sm">No messages</p>
            </div>
          ) : (
            <div className="space-y-2">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className="bg-slate-800/30 rounded-lg border border-slate-700/30 px-4 py-3 hover:bg-slate-800/40 transition-colors"
                >
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${MSG_TYPE_COLORS[msg.type] ?? "bg-slate-700 text-slate-300"}`}>
                      {msg.type}
                    </span>
                    <span className="text-xs text-slate-500">
                      <span className="font-mono text-slate-400">{msg.from_session_id?.slice(0, 8) ?? "system"}</span>
                      <span className="mx-1.5 text-slate-600">&rarr;</span>
                      <span className="font-mono text-slate-400">
                        {msg.to_session_id ? msg.to_session_id.slice(0, 8) : "broadcast"}
                      </span>
                    </span>
                    <span className="ml-auto text-xs text-slate-600">{relativeTime(msg.created_at)}</span>
                  </div>
                  <p className="text-sm text-slate-300">{msg.payload}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
