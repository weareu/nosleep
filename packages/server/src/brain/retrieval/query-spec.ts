/**
 * QuerySpec — structured search input. See docs/plans/brain/03-query-spec.md
 * for the full contract. Phase 1 implements a subset (text/facet/temporal/numeric
 * only; semantic/image/graph/entities land in Phase 3/4/5).
 *
 * Fields not yet supported by the retrieval pipeline are still accepted and
 * silently ignored so clients can send forward-compatible payloads.
 */

import { z } from "zod";

export const TextQuery = z.object({
  query: z.string().min(1).max(2048),
  mode: z.enum(["lexical", "semantic", "hybrid"]).default("hybrid"),
  weight: z.number().min(0).max(10).default(1.0),
});

export const ImageQuery = z.object({
  /** 64-bit perceptual hash (as a number or bigint-compatible string). */
  phash: z.union([z.number(), z.string()]).optional(),
  /** Hash of an existing image artifact to anchor the search to. */
  vector_ref: z.string().length(64).optional(),
  weight: z.number().min(0).max(10).default(1.0),
});

export const TemporalQuery = z.object({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  near_artifact: z.string().length(64).optional(),
  window_sec: z.number().int().positive().optional(),
  weight: z.number().min(0).max(10).default(0.5),
});

export const NumericPredicate = z.object({
  gt: z.number().optional(),
  lt: z.number().optional(),
  eq: z.number().optional(),
  ne: z.number().optional(),
  between: z.tuple([z.number(), z.number()]).optional(),
});

export const Facets = z.object({
  kind_prefix: z.array(z.string().min(1).max(128)).optional(),
  origin: z.string().max(64).optional(),
  session_id: z.string().max(128).optional(),
  actor: z.string().max(128).optional(),
});

export const QuerySpec = z.object({
  org_id: z.string().min(1).max(64),
  project_id: z.string().min(1).max(64),
  scope: z.enum(["project", "org"]).default("project"),
  /**
   * Storage breadth.
   *   - `recent` (default): query active.db only — the hot working set.
   *   - `all_time`: fan out across active.db plus all sealed quarter files
   *     that overlap any temporal range. Slower; for archive sweeps.
   */
  time_range: z.enum(["recent", "all_time"]).default("recent"),
  layers: z
    .array(z.enum(["archive", "thoughts"]))
    .default(["archive", "thoughts"]),
  include_hidden: z.boolean().default(false),
  /** Also surface thoughts soft-archived by the sleep-time consolidator. */
  include_archived: z.boolean().default(false),

  text: TextQuery.optional(),
  image: ImageQuery.optional(),
  temporal: TemporalQuery.optional(),
  facets: Facets.optional(),
  entities: z.array(z.string().max(64)).optional(),
  numeric: z.record(NumericPredicate).optional(),

  intent: z.string().max(32).optional(),
  limit: z.number().int().min(1).max(200).default(20),
  return_score_breakdown: z.boolean().default(false),
});

export type QuerySpecT = z.infer<typeof QuerySpec>;
export type TextQueryT = z.infer<typeof TextQuery>;
export type TemporalQueryT = z.infer<typeof TemporalQuery>;
export type FacetsT = z.infer<typeof Facets>;
export type NumericPredicateT = z.infer<typeof NumericPredicate>;

/** Validate that the QuerySpec names at least one retriever or filter. */
export function assertNonEmpty(q: QuerySpecT): void {
  const hasRetriever =
    !!q.text ||
    !!q.image?.phash ||
    !!q.image?.vector_ref ||
    !!q.temporal?.near_artifact ||
    (!!q.entities && q.entities.length > 0);
  // scope='project' with a real (non-org-level) project_id is itself a
  // bounded filter — the WHERE clause restricts to one project.
  const hasProjectFilter =
    q.scope === "project" && q.project_id !== "_org_level";
  const hasFilter =
    hasProjectFilter ||
    !!q.facets?.kind_prefix?.length ||
    !!q.facets?.origin ||
    !!q.facets?.session_id ||
    !!q.facets?.actor ||
    !!q.temporal?.from ||
    !!q.temporal?.to ||
    (!!q.numeric && Object.keys(q.numeric).length > 0);
  if (!hasRetriever && !hasFilter) {
    throw new Error(
      "QuerySpec is empty — specify at least one retriever or filter",
    );
  }
}
