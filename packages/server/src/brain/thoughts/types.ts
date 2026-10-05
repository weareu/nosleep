/**
 * Thought layer types. Schema mirrors docs/plans/brain/01-schema.sql.
 */

import { z } from "zod";

export const ThoughtType = z.enum([
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
  "decision",
  "insight",
  "question",
]);
export type ThoughtTypeT = z.infer<typeof ThoughtType>;

export const SourceKind = z.enum([
  "mcp_capture",
  "auto_capture_skill",
  "mobile_note",
  "promoted_from_archive",
  "web_ui",
  "url_capture",
  // Phase 11 — auto-extracted from a conversation turn artifact.
  "auto_from_artifact",
]);
export type SourceKindT = z.infer<typeof SourceKind>;

export const ThoughtSourceRef = z.object({
  hash: z.string().length(64),
  relation: z.string().min(1).max(64),
});
export type ThoughtSourceRefT = z.infer<typeof ThoughtSourceRef>;

export const CaptureThoughtRequest = z.object({
  content: z.string().min(1).max(20_000),
  org_id: z.string().min(1).max(64),
  project_id: z.string().min(1).max(64),
  source_kind: SourceKind.default("mcp_capture"),
  source_refs: z.array(ThoughtSourceRef).optional(),
  thought_type_hint: ThoughtType.optional(),
  strategy_node_ref: z.string().max(64).optional(),
});
export type CaptureThoughtRequestT = z.infer<typeof CaptureThoughtRequest>;

export interface ThoughtMetadata {
  type: ThoughtTypeT;
  topics: string[];
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
}

export interface ThoughtRow {
  id: string;
  org_id: string;
  project_id: string;
  content: string;
  metadata: ThoughtMetadata;
  thought_type: ThoughtTypeT | null;
  source_kind: SourceKindT;
  source_refs: ThoughtSourceRefT[] | null;
  strategy_node_ref: string | null;
  created_at: number;
  updated_at: number;
  visibility: string;
}

/** Default metadata for new captures before the extractor runs. */
export function initialMetadata(hint?: ThoughtTypeT): ThoughtMetadata {
  return {
    type: hint ?? "observation",
    topics: [],
    people: [],
    action_items: [],
    dates_mentioned: [],
  };
}
