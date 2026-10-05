import { useQuery } from "@tanstack/react-query";
import { fetchSystemStats, type SystemStats as SystemStatsType } from "../lib/api";

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function UsageBar({ percent, color }: { readonly percent: number; readonly color: string }): React.ReactElement {
  return (
    <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

function getBarColor(percent: number): string {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-yellow-500";
  return "bg-green-500";
}

export function SystemStats(): React.ReactElement {
  const { data: stats, isError } = useQuery<SystemStatsType>({
    queryKey: ["system-stats"],
    queryFn: fetchSystemStats,
    refetchInterval: 5000,
  });

  if (isError || !stats) {
    return (
      <div className="flex items-center gap-4 px-6 py-2 border-b border-slate-800 text-xs text-slate-600">
        <span>System stats unavailable</span>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 flex items-center gap-5 px-6 py-2 border-b border-slate-800 text-xs">
      {/* CPU */}
      <div className="flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
        <span className="text-slate-400">CPU</span>
        <span className="text-slate-300 font-medium">{stats.cpu.usagePercent.toFixed(0)}%</span>
        <UsageBar percent={stats.cpu.usagePercent} color={getBarColor(stats.cpu.usagePercent)} />
      </div>

      {/* Memory */}
      <div className="flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span className="text-slate-400">Mem</span>
        <span className="text-slate-300 font-medium">
          {stats.memory.usagePercent.toFixed(0)}%
        </span>
        <UsageBar percent={stats.memory.usagePercent} color={getBarColor(stats.memory.usagePercent)} />
        <span className="text-slate-600">
          {formatBytes(stats.memory.usedBytes)}/{formatBytes(stats.memory.totalBytes)}
        </span>
      </div>

      {/* GPU */}
      {stats.gpu && (
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
          <span className="text-slate-400">GPU</span>
          <span className="text-slate-300 font-medium">{stats.gpu.name}</span>
          <span className="text-slate-600">{stats.gpu.vram}</span>
        </div>
      )}

      {/* Divider */}
      <div className="w-px h-3 bg-slate-700" />

      {/* Uptime */}
      <div className="flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-slate-400">System</span>
        <span className="text-slate-300 font-medium">{formatUptime(stats.uptime.system)}</span>
        <span className="text-slate-600 mx-1">|</span>
        <span className="text-slate-400">Server</span>
        <span className="text-slate-300 font-medium">{formatUptime(stats.uptime.server)}</span>
      </div>
    </div>
  );
}
