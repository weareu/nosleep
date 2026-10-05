/**
 * Canonical metric key namespace. Mirrors docs/plans/brain/00-overview.md
 * §timeseries-events. Free-form keys are allowed at write time but only
 * canonical ones surface in admin charts by default.
 */

export const METRIC_KEYS = {
  // Tokens
  tokens_input: "tokens.input",
  tokens_output: "tokens.output",
  tokens_cache_read: "tokens.cache_read",
  tokens_cache_create: "tokens.cache_create",
  tokens_total: "tokens.total",

  // Cost
  cost_usd: "cost.usd",

  // Artifacts
  artifacts_ingested_count: "artifacts.ingested.count",
  artifacts_ingested_bytes: "artifacts.ingested.bytes",
  artifacts_dedup_hits: "artifacts.dedup_hit",

  // Extractors
  extractor_latency_ms: "extractor.latency_ms",
  extractor_failure: "extractor.failure",
  extractor_success: "extractor.success",

  // Hooks
  hook_fires_count: "hook.fires.count",
  hook_latency_ms: "hook.latency_ms",
  hook_failure: "hook.failure",

  // Sessions
  sessions_started: "sessions.started.count",
  sessions_completed: "sessions.completed.count",

  // Validation
  validation_success_rate: "validation.success_rate",
  validation_retry: "validation.retry",
  validation_auto_advance: "validation.auto_advance",

  // Supervision
  supervision_drift_detected: "supervision.drift.detections",
  supervision_compaction: "supervision.compaction.events",
  supervision_goal_reinjection: "supervision.goal_reinjections",
  supervision_continue_prompt: "supervision.continue_prompts",

  // Query
  query_latency_ms: "query.latency_ms",
  query_layer_archive_pct: "query.layer_archive_pct",
  query_layer_thoughts_pct: "query.layer_thoughts_pct",
  query_confidence_miss: "query.confidence_miss",

  // Budget
  budget_pacing_state: "budget.pacing_state",

  // Storage
  storage_sealed_files: "storage.sealed_files.count",
  storage_sealed_bytes: "storage.sealed_bytes",
  storage_active_db_bytes: "storage.active_db_bytes",
  storage_compression_ratio: "storage.compression_ratio",
} as const;

export type MetricKey = (typeof METRIC_KEYS)[keyof typeof METRIC_KEYS];

const ALL_KEYS = new Set<string>(Object.values(METRIC_KEYS));

export function isCanonicalMetricKey(key: string): boolean {
  return ALL_KEYS.has(key);
}

/** Allowed namespaces — useful when a sub-key (e.g. "extractor.latency_ms" with a "metadata_llm" tag) hasn't been canonicalised yet. */
export const METRIC_NAMESPACES = [
  "tokens.",
  "cost.",
  "artifacts.",
  "extractor.",
  "hook.",
  "sessions.",
  "validation.",
  "supervision.",
  "query.",
  "budget.",
  "system.",
  "storage.",
] as const;

export function isKnownMetricNamespace(key: string): boolean {
  return METRIC_NAMESPACES.some((ns) => key.startsWith(ns));
}
