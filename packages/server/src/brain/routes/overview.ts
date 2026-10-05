/**
 * GET /api/brain/overview — lightweight per-org/per-project summary
 * intended for the user-facing Brain hub landing page.
 *
 * Returns counts (artifacts, thoughts, images, code blobs, sessions),
 * the last activity timestamp, plus a small pool of recent thoughts
 * and recent image hashes the hub renders inline. Cheaper than calling
 * the admin storage endpoint and stays inside the per-org/per-project
 * scope the user picked.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";

const querySchema = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  recent_limit: z.coerce.number().int().min(1).max(20).default(5),
});

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

interface CountRow {
  artifact_count: number;
  thought_count: number;
  image_count: number;
  code_count: number;
  session_count: number;
  last_artifact_ts: number | null;
}

interface RecentThoughtRow {
  id: string;
  content: string;
  thought_type: string | null;
  created_at: number;
}

interface RecentImageRow {
  hash: string;
  ts: number;
  scene_class: string | null;
  caption: string | null;
}

export function registerBrainOverviewRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Querystring: z.input<typeof querySchema> }>(
    "/api/brain/overview",
    async (request, reply) => {
      const q = querySchema.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);

      const { org_id, project_id, recent_limit } = q.data;
      const db = activeDbFor(org_id);

      const projectFilter = project_id ? "AND project_id = ?" : "";
      const projectParams = project_id ? [project_id] : [];

      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM artifacts WHERE org_id = ? ${projectFilter}) AS artifact_count,
             (SELECT COUNT(*) FROM thoughts  WHERE org_id = ? AND visibility='active' ${projectFilter}) AS thought_count,
             (SELECT COUNT(*) FROM artifacts WHERE org_id = ? AND kind GLOB 'media/image/*' ${projectFilter}) AS image_count,
             (SELECT COUNT(*) FROM artifacts WHERE org_id = ? AND kind GLOB 'code/*' ${projectFilter}) AS code_count,
             (SELECT COUNT(DISTINCT session_id) FROM artifacts WHERE org_id = ? AND session_id IS NOT NULL ${projectFilter}) AS session_count,
             (SELECT MAX(ts) FROM artifacts WHERE org_id = ? ${projectFilter}) AS last_artifact_ts`,
        )
        .get(
          org_id,
          ...projectParams,
          org_id,
          ...projectParams,
          org_id,
          ...projectParams,
          org_id,
          ...projectParams,
          org_id,
          ...projectParams,
          org_id,
          ...projectParams,
        ) as CountRow;

      const thoughtParams: (string | number)[] = [org_id];
      if (project_id) thoughtParams.push(project_id);
      thoughtParams.push(recent_limit);
      const recentThoughts = db
        .prepare(
          `SELECT id, content, thought_type, created_at
             FROM thoughts
            WHERE org_id = ? AND visibility = 'active' ${projectFilter}
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(...thoughtParams) as RecentThoughtRow[];

      const imageParams: (string | number)[] = [org_id];
      if (project_id) imageParams.push(project_id);
      imageParams.push(recent_limit);
      const recentImages = db
        .prepare(
          `SELECT a.hash AS hash, a.ts AS ts,
                  img.scene_class AS scene_class, img.caption AS caption
             FROM artifacts a
        LEFT JOIN image_features img ON img.hash = a.hash
            WHERE a.org_id = ? AND a.kind GLOB 'media/image/*' ${projectFilter ? "AND a.project_id = ?" : ""}
            ORDER BY a.ts DESC
            LIMIT ?`,
        )
        .all(...imageParams) as RecentImageRow[];

      reply.send({
        counts: {
          artifacts: counts.artifact_count,
          thoughts: counts.thought_count,
          images: counts.image_count,
          code: counts.code_count,
          sessions: counts.session_count,
        },
        last_artifact_ts: counts.last_artifact_ts,
        recent_thoughts: recentThoughts.map((t) => ({
          id: t.id,
          content: t.content,
          thought_type: t.thought_type,
          created_at: t.created_at,
        })),
        recent_images: recentImages.map((r) => ({
          hash: r.hash,
          ts: r.ts,
          scene_class: r.scene_class,
          caption: r.caption,
        })),
      });
    },
  );
}
