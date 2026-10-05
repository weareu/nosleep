/**
 * Thought visibility vocabulary + the one place read paths build their
 * visibility filter.
 *
 *   'active'            normal, retrievable
 *   'archived'          soft-archived by the sleep-time consolidator
 *                       (jobs/thought-consolidator.ts). Reversible via
 *                       POST /api/brain/thoughts/unarchive.
 *   'merged_into:<id>'  folded into another thought by an approved
 *                       thought-merge proposal (routes/merge-queue.ts).
 *
 * Rows are never deleted (trg_no_delete_thoughts).
 */

export const VISIBILITY_ACTIVE = "active";
export const VISIBILITY_ARCHIVED = "archived";

export interface VisibilityOptions {
  /** Everything, including merged-away thoughts. */
  includeHidden?: boolean;
  /** Active + archived (but not merged). */
  includeArchived?: boolean;
}

/**
 * SQL predicate (no leading AND) for a thoughts alias, or "" when no filter
 * applies. Values are constants, never caller input.
 */
export function thoughtVisibilityPredicate(alias: string, opts: VisibilityOptions): string {
  if (opts.includeHidden) return "";
  if (opts.includeArchived) {
    return `${alias}.visibility IN ('${VISIBILITY_ACTIVE}', '${VISIBILITY_ARCHIVED}')`;
  }
  return `${alias}.visibility = '${VISIBILITY_ACTIVE}'`;
}
