import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installHooks, uninstallHooks } from "../orchestrator/hooks-installer.js";
import { isOpenCodeInstalled } from "../orchestrator/hooks-installer-opencode.js";

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly org_id: string;
  readonly path: string;
}

const scopeSchema = z.object({
  scope: z.enum(["global", "org", "project"]),
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  // Which CLIs to install for. Omitted → Claude Code, plus OpenCode for
  // projects that already have OpenCode config (see resolveHookTargets).
  targets: z.array(z.enum(["claude", "opencode"])).min(1).optional(),
});

function getProjectsByScope(
  db: Database.Database,
  scope: string,
  orgId?: string,
  projectId?: string,
): ProjectRow[] {
  switch (scope) {
    case "global":
      return db.prepare("SELECT id, name, org_id, path FROM projects").all() as ProjectRow[];
    case "org": {
      if (!orgId) return [];
      return db
        .prepare("SELECT id, name, org_id, path FROM projects WHERE org_id = ?")
        .all(orgId) as ProjectRow[];
    }
    case "project": {
      if (!projectId) return [];
      const row = db
        .prepare("SELECT id, name, org_id, path FROM projects WHERE id = ?")
        .get(projectId) as ProjectRow | undefined;
      return row ? [row] : [];
    }
    default:
      return [];
  }
}

export function registerHookManageRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // Check hook installation status for projects
  fastify.get("/api/hooks/status", async (request) => {
    const { orgId } = request.query as { orgId?: string };

    const projects = orgId
      ? (db
          .prepare("SELECT id, name, org_id, path FROM projects WHERE org_id = ?")
          .all(orgId) as ProjectRow[])
      : (db.prepare("SELECT id, name, org_id, path FROM projects").all() as ProjectRow[]);

    const data = projects.map((p) => ({
      projectId: p.id,
      projectName: p.name,
      orgId: p.org_id,
      installed: existsSync(join(p.path, ".claude", "nosleep-hooks", "pre-tool.mjs")),
      opencodeInstalled: isOpenCodeInstalled(p.path),
      path: p.path,
    }));

    return { success: true, data };
  });

  // Install hooks on projects
  fastify.post("/api/hooks/install", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { scope, orgId, projectId, targets } = parsed.data;

    if (scope === "org" && !orgId) {
      return reply.status(400).send({ success: false, error: "orgId is required for org scope" });
    }
    if (scope === "project" && !projectId) {
      return reply
        .status(400)
        .send({ success: false, error: "projectId is required for project scope" });
    }

    const projects = getProjectsByScope(db, scope, orgId, projectId);
    let installed = 0;
    const errors: Array<{ projectId: string; error: string }> = [];

    for (const p of projects) {
      try {
        installHooks(p.path, { serverPort: 3777, orgId: p.org_id, targets });
        installed++;
      } catch (err) {
        errors.push({
          projectId: p.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { success: true, data: { installed, errors } };
  });

  // Uninstall hooks from projects
  fastify.post("/api/hooks/uninstall", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { scope, orgId, projectId } = parsed.data;

    if (scope === "org" && !orgId) {
      return reply.status(400).send({ success: false, error: "orgId is required for org scope" });
    }
    if (scope === "project" && !projectId) {
      return reply
        .status(400)
        .send({ success: false, error: "projectId is required for project scope" });
    }

    const projects = getProjectsByScope(db, scope, orgId, projectId);
    let uninstalled = 0;
    const errors: Array<{ projectId: string; error: string }> = [];

    for (const p of projects) {
      try {
        uninstallHooks(p.path);
        uninstalled++;
      } catch (err) {
        errors.push({
          projectId: p.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { success: true, data: { uninstalled, errors } };
  });
}
