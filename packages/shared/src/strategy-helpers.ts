/**
 * Shared helpers for strategy tree display and parsing.
 * Used by mcp-control, mcp-gateway, and any other consumer that renders strategy trees.
 */

/** Raw strategy node row as stored in SQLite. */
export interface StrategyRow {
  readonly id: string;
  readonly project_id: string;
  readonly org_id: string;
  readonly parent_id: string | null;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly progress_pct: number;
  readonly depth: number;
  readonly sort_order: number;
  readonly assigned_session_id: string | null;
  readonly dependencies: string;
  readonly acceptance_criteria: string;
  readonly weight: number;
  readonly estimated_tokens: number;
  readonly source_ref: string | null;
  readonly recommended_model: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Status → icon mapping for tree rendering. */
export const STATUS_ICONS: Readonly<Record<string, string>> = {
  pending: "○",
  in_progress: "◉",
  completed: "●",
  blocked: "✕",
  skipped: "⊘",
};

/** Parse JSON dependencies string from DB, returning empty array on failure. */
export function parseDeps(raw: string): readonly { nodeId: string; type: string }[] {
  try {
    return JSON.parse(raw) as Array<{ nodeId: string; type: string }>;
  } catch {
    return [];
  }
}

/** Parse JSON acceptance criteria string from DB, returning empty array on failure. */
export function parseCriteria(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
