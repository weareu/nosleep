/**
 * Aggregate statistics (tool shape inspired by Open Brain's thought_stats).
 * Counts by type, top topics, top people, date range.
 */

import { activeDbFor } from "../storage/active-db.js";

export interface ThoughtStats {
  total: number;
  date_range: { first: number | null; last: number | null };
  types: Array<{ type: string; count: number }>;
  top_topics: Array<{ topic: string; count: number }>;
  top_people: Array<{ person: string; count: number }>;
}

export function thoughtStats(
  orgId: string,
  projectId: string,
  scope: "project" | "org" = "project",
): ThoughtStats {
  const db = activeDbFor(orgId);
  const scopeCond =
    scope === "org" ? "org_id = ?" : "org_id = ? AND project_id = ?";
  const params =
    scope === "org" ? ([orgId] as string[]) : ([orgId, projectId] as string[]);

  const count = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(created_at) AS min_ts, MAX(created_at) AS max_ts
         FROM thoughts WHERE ${scopeCond} AND visibility = 'active'`,
    )
    .get(...params) as {
    c: number;
    min_ts: number | null;
    max_ts: number | null;
  };

  const types = db
    .prepare(
      `SELECT thought_type AS type, COUNT(*) AS count
         FROM thoughts
        WHERE ${scopeCond} AND visibility = 'active' AND thought_type IS NOT NULL
        GROUP BY thought_type
        ORDER BY count DESC
        LIMIT 20`,
    )
    .all(...params) as Array<{ type: string; count: number }>;

  // Extract topics and people from metadata_json — uses SQLite json_each
  // virtual table for efficient aggregation without pulling every row into JS.
  const topics = db
    .prepare(
      `SELECT je.value AS topic, COUNT(*) AS count
         FROM thoughts t, json_each(t.metadata_json, '$.topics') je
        WHERE ${scopeCond.replace(/(\w+_id)/g, "t.$1")} AND t.visibility = 'active'
        GROUP BY je.value
        ORDER BY count DESC
        LIMIT 20`,
    )
    .all(...params) as Array<{ topic: string; count: number }>;

  const people = db
    .prepare(
      `SELECT je.value AS person, COUNT(*) AS count
         FROM thoughts t, json_each(t.metadata_json, '$.people') je
        WHERE ${scopeCond.replace(/(\w+_id)/g, "t.$1")} AND t.visibility = 'active'
        GROUP BY je.value
        ORDER BY count DESC
        LIMIT 20`,
    )
    .all(...params) as Array<{ person: string; count: number }>;

  return {
    total: count.c,
    date_range: { first: count.min_ts, last: count.max_ts },
    types,
    top_topics: topics,
    top_people: people,
  };
}
