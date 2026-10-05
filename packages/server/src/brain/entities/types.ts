/**
 * Entity types — people, topics, concepts, etc. Schema mirrors
 * docs/plans/brain/01-schema.sql.
 */

import { z } from "zod";

export const EntityKind = z.enum([
  "person",
  "topic",
  "concept",
  "external_project",
  "tool",
  "agent",
  "place",
]);
export type EntityKindT = z.infer<typeof EntityKind>;

export interface EntityRow {
  id: string;
  org_id: string;
  kind: EntityKindT;
  canonical_name: string;
  aliases: string[];
  metadata_json: unknown;
  merged_into: string | null;
  created_at: number;
  visibility: string;
}

export interface EntityRefRow {
  entity_id: string;
  referrer_kind: "thought" | "artifact";
  referrer_id: string;
  project_id: string;
  relation: string;
  created_at: number;
}

/** Noise words we never resolve to entities. */
export const ENTITY_STOPWORDS: ReadonlySet<string> = new Set([
  "he",
  "she",
  "they",
  "it",
  "this",
  "that",
  "the user",
  "user",
  "me",
  "we",
  "us",
  "you",
  "i",
  "everyone",
  "someone",
  "anyone",
  "the team",
  "the project",
]);

export function canonicaliseName(raw: string): string {
  return raw.trim().toLowerCase();
}
