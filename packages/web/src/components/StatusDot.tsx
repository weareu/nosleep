interface StatusDotProps {
  readonly status: string;
  readonly size?: "sm" | "md";
}

const STATUS_CONFIG: Record<string, { color: string; pulse: boolean; label: string }> = {
  starting: { color: "bg-blue-400", pulse: true, label: "Starting" },
  running: { color: "bg-green-500", pulse: true, label: "Running" },
  idle: { color: "bg-yellow-500", pulse: false, label: "Idle" },
  waiting_input: { color: "bg-blue-500", pulse: true, label: "Waiting" },
  paused: { color: "bg-yellow-600", pulse: false, label: "Paused" },
  completed: { color: "bg-gray-500", pulse: false, label: "Completed" },
  failed: { color: "bg-red-500", pulse: false, label: "Failed" },
  stopped: { color: "bg-red-400", pulse: false, label: "Stopped" },
  error: { color: "bg-red-500", pulse: false, label: "Error" },
};

export function StatusDot({ status, size = "sm" }: StatusDotProps): React.ReactElement {
  const config = STATUS_CONFIG[status] ?? { color: "bg-gray-400", pulse: false, label: status };
  const dotSize = size === "sm" ? "h-2 w-2" : "h-3 w-3";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex">
        {config.pulse && (
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${config.color}`}
          />
        )}
        <span className={`relative inline-flex rounded-full ${dotSize} ${config.color}`} />
      </span>
      <span className="text-xs text-slate-400 capitalize">{config.label}</span>
    </span>
  );
}

export function getStatusColor(status: string): string {
  return STATUS_CONFIG[status]?.color ?? "bg-gray-400";
}
