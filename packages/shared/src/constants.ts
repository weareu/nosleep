// Organizations are user-defined (see ./orgs.ts) — no org list lives in code.

// ── Budget Pacing Thresholds ─────────────────────────────
// Percentage of daily allowance used

export const PACING_CAUTIOUS_PCT = 80;   // >80% of daily allowance
export const PACING_SLOW_PCT = 120;      // >120% of daily allowance
export const PACING_CRITICAL_PCT = 150;  // >150% of daily allowance
export const SLOW_MODE_DELAY_MS = 2000;
export const LEAN_MODE_MAX_TOKENS = 4096;
export const DEFAULT_SESSION_COST_ESTIMATE = 500000; // 500k tokens

// ── Drift Detection ─────────────────────────────────────

export const DRIFT_CHECK_INTERVAL_TOOL_CALLS = 10;
export const DRIFT_CONFIDENCE_ALERT_THRESHOLD = 0.7;
export const DRIFT_CONFIDENCE_STOP_THRESHOLD = 0.9;

// ── Session Management ──────────────────────────────────

export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_RETRY_AFTER_VALIDATION_FAIL = 2;
export const GOAL_REINJECT_EVERY_N_TOOLS = 20;

// ── Server ──────────────────────────────────────────────

export const DEFAULT_PORT = 3777;
export const DEFAULT_DB_PATH = "./data/nosleep.db";
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

// ── Completeness Validation ─────────────────────────────

export const STUB_PATTERNS = [
  "// TODO",
  "// FIXME",
  "throw new Error(\"not implemented\")",
  "throw new Error('not implemented')",
  "pass  # TODO",
  "pass  # FIXME",
  "NotImplementedError",
  "unimplemented!()",
  "todo!()",
  "panic(\"not implemented\")",
] as const;

// ── Models ──────────────────────────────────────────────

export const VALIDATOR_MODEL = "claude-haiku-4-5-20251001";
export const RESEARCH_MODEL = "gemini-2.0-flash";
