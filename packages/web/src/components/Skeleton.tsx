/**
 * Phase 12 (UI review #2 — M4) — minimal skeleton placeholders. Used in
 * place of the bare "loading…" text so layout is stable while data fetches.
 */

import type React from "react";

export function SkeletonRow({
  width,
  className = "",
}: {
  width?: string;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`h-4 rounded bg-slate-800/80 animate-pulse ${className}`}
      style={width ? { width } : undefined}
      aria-hidden="true"
    />
  );
}

export function SkeletonStack({
  rows = 5,
  className = "",
}: {
  rows?: number;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`space-y-2 ${className}`}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow
          key={i}
          width={`${50 + ((i * 7) % 50)}%`}
        />
      ))}
    </div>
  );
}
