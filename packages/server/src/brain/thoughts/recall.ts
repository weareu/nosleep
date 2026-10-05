/**
 * Recall tracking. Every time a thought is surfaced to a reader (single get or
 * a search hit) we stamp last_recalled_at. The nightly sleep-time consolidator
 * reads this to soft-archive thoughts that have gone unrecalled for 90+ days.
 *
 * Only last_recalled_at is written — never content/metadata/updated_at — so the
 * content-immutability trigger stays satisfied and "when did this last matter"
 * stays distinct from "when was this last edited".
 */

import type Database from "better-sqlite3";

/** Stamp the given thoughts as recalled at `nowSec` (unix seconds). No-op on
 *  an empty list. Best-effort: a failed bump must never break a read path. */
export function markThoughtsRecalled(
  db: Database.Database,
  ids: readonly string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (ids.length === 0) return;
  try {
    const stmt = db.prepare(
      `UPDATE thoughts SET last_recalled_at = ? WHERE id = ?`,
    );
    const tx = db.transaction((rows: readonly string[]) => {
      for (const id of rows) stmt.run(nowSec, id);
    });
    tx(ids);
  } catch {
    /* recall bump is best-effort — never fail the read it decorates */
  }
}
