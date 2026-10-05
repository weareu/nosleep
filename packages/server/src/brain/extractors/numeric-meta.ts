/**
 * Numeric metadata extractor. Walks kind_specific_meta for known numeric
 * keys and writes them into artifact_num_meta so QuerySpec.numeric filters
 * actually match. Synchronous; runs in-line at ingest.
 */

import { activeDbFor } from "../storage/active-db.js";

/**
 * Known numeric keys per artifact kind. Adding a key here unlocks searching
 * against it via QuerySpec.numeric.
 */
const NUMERIC_KEYS_BY_KIND_PREFIX: Array<{
  prefix: string;
  keys: string[];
}> = [
  {
    prefix: "process/command_output",
    keys: ["exit_code", "duration_ms", "output_length"],
  },
  {
    prefix: "code/diff",
    keys: ["lines_added", "lines_removed", "files_changed"],
  },
  {
    prefix: "code/file_snapshot",
    keys: ["line_count", "size_bytes"],
  },
  {
    prefix: "code/blob",
    keys: ["line_count", "size_bytes"],
  },
  {
    prefix: "conversation/turn",
    keys: ["token_in", "token_out", "token_count", "word_count"],
  },
  {
    prefix: "document/web_fetch",
    keys: ["article_bytes", "status", "fetched_bytes"],
  },
  {
    prefix: "media/image",
    keys: ["width", "height"],
  },
  {
    prefix: "code/test_result",
    keys: ["passed", "failed", "duration_ms"],
  },
  {
    prefix: "code/build_output",
    keys: ["duration_ms"],
  },
  {
    prefix: "agent/subagent_spawn",
    keys: ["duration_sec", "tokens_total"],
  },
];

function numericKeysForKind(kind: string): string[] {
  const matched: string[] = [];
  for (const entry of NUMERIC_KEYS_BY_KIND_PREFIX) {
    if (kind === entry.prefix || kind.startsWith(entry.prefix + "/")) {
      matched.push(...entry.keys);
    }
  }
  return [...new Set(matched)];
}

export interface NumericMetaTarget {
  hash: string;
  kind: string;
  kind_specific_meta: Record<string, unknown> | null;
  org_id: string;
  project_id: string;
}

export function runNumericMetaExtraction(target: NumericMetaTarget): number {
  if (!target.kind_specific_meta) return 0;
  const keys = numericKeysForKind(target.kind);
  if (keys.length === 0) return 0;

  const db = activeDbFor(target.org_id);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO artifact_num_meta (hash, key, value) VALUES (?, ?, ?)`,
  );

  let written = 0;
  const tx = db.transaction(() => {
    for (const key of keys) {
      const value = coerceToNumber(target.kind_specific_meta![key]);
      if (value !== null) {
        stmt.run(target.hash, key, value);
        written += 1;
      }
    }
  });
  try {
    tx();
  } catch {
    return 0;
  }
  return written;
}

function coerceToNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
