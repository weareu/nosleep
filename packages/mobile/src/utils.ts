// ── Time Formatting ─────────────────────────────────────

/** Parse a date string that may be in SQLite format "YYYY-MM-DD HH:MM:SS"
 *  (no T separator, no timezone — treat as UTC) or standard ISO format. */
export function parseDateString(dateString: string): number {
  // If it looks like SQLite format (has space instead of T, no timezone suffix),
  // append "Z" and insert "T" so Date parses it as UTC
  const normalized = dateString.includes("T")
    ? dateString
    : dateString.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

export function relativeTime(dateString: string): string {
  const now = Date.now();
  const then = parseDateString(dateString);
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function elapsedTime(startDateString: string): string {
  const now = Date.now();
  const start = parseDateString(startDateString);
  const diffMs = now - start;
  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ── Number Formatting ───────────────────────────────────

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

// ── Status Helpers ──────────────────────────────────────

export function isActiveStatus(status: string): boolean {
  return ["starting", "running", "idle", "waiting_input", "paused"].includes(
    status
  );
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    starting: "Starting",
    running: "Running",
    idle: "Idle",
    waiting_input: "Waiting",
    paused: "Paused",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
  };
  return labels[status] ?? status;
}
