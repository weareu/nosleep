import { z } from "zod";

export const IngestEdge = z.object({
  to_hash: z.string().length(64),
  relation: z.string().min(1).max(64),
  scope: z.enum(["intra_project", "cross_project"]).optional(),
});

export const IngestOrigin = z.object({
  tool: z.string().min(1).max(64),
  version: z.string().max(64).optional(),
  actor: z.string().max(128).optional(),
});

export const IngestRequest = z.object({
  kind: z.string().min(1).max(128),
  content: z.string(),
  content_type: z.string().max(128).optional(),
  ts: z.number().int().optional(),
  org_id: z.string().min(1).max(64),
  project_id: z.string().min(1).max(64),
  session_id: z.string().max(128).optional(),
  turn_ord: z.number().int().optional(),
  origin: IngestOrigin,
  edges: z.array(IngestEdge).optional(),
  kind_specific_meta: z.record(z.unknown()).optional(),
  schema_version: z.number().int().default(1),
});

export type IngestRequestT = z.infer<typeof IngestRequest>;

export interface IngestResult {
  hash: string;
  duplicate: boolean;
  enqueued: string[];
  size: number;
  latency_ms: number;
}
