import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

export interface MemoryRow {
  id: string;
  org_id: string;
  project_id: string | null;
  category: string;
  key: string;
  value: string;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export interface StoreParams {
  category: string;
  key: string;
  value: string;
  project?: string;
}

export interface RetrieveParams {
  query: string;
  category?: string;
  project?: string;
  limit: number;
}

export interface ListParams {
  category?: string;
  project?: string;
}

export interface DeleteParams {
  id: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export function storeMemory(
  db: Database.Database,
  orgId: string,
  params: StoreParams
): ToolResult {
  const id = nanoid();
  const projectId = params.project ?? null;
  const now = new Date().toISOString();

  // Two-step upsert: ON CONFLICT doesn't work when project_id is NULL
  // because SQLite treats NULLs as distinct in UNIQUE constraints.
  const existingWhere = projectId === null
    ? `org_id = ? AND project_id IS NULL AND category = ? AND key = ?`
    : `org_id = ? AND project_id = ? AND category = ? AND key = ?`;
  const existingParams = projectId === null
    ? [orgId, params.category, params.key]
    : [orgId, projectId, params.category, params.key];

  const updated = db.prepare(
    `UPDATE memory SET value = ?, updated_at = ? WHERE ${existingWhere}`
  ).run(params.value, now, ...existingParams);

  if (updated.changes === 0) {
    db.prepare(`
      INSERT INTO memory (id, org_id, project_id, category, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, projectId, params.category, params.key, params.value, now, now);
  }

  return {
    content: [{ type: "text" as const, text: `Stored memory: [${params.category}] ${params.key}` }],
  };
}

export function retrieveMemory(
  db: Database.Database,
  orgId: string,
  params: RetrieveParams
): ToolResult {
  let sql = `SELECT id, project_id, category, key, value, access_count, updated_at FROM memory WHERE org_id = ?`;
  const sqlParams: unknown[] = [orgId];

  if (params.category) {
    sql += ` AND category = ?`;
    sqlParams.push(params.category);
  }

  if (params.project) {
    sql += ` AND (project_id IS NULL OR project_id = ?)`;
    sqlParams.push(params.project);
  }

  const escaped = params.query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  sql += ` AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')`;
  const pattern = `%${escaped}%`;
  sqlParams.push(pattern, pattern);

  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  sqlParams.push(params.limit);

  const rows = db.prepare(sql).all(...sqlParams) as Array<{
    id: string;
    project_id: string | null;
    category: string;
    key: string;
    value: string;
    access_count: number;
    updated_at: string;
  }>;

  const updateStmt = db.prepare(`UPDATE memory SET access_count = access_count + 1 WHERE id = ?`);
  for (const row of rows) {
    updateStmt.run(row.id);
  }

  const text =
    rows.length === 0
      ? `No memories found matching query.`
      : rows
          .map(
            (r) =>
              `[${r.category}] ${r.key} (${r.project_id ?? "org-wide"}):\n${r.value}`
          )
          .join("\n\n---\n\n");

  return { content: [{ type: "text" as const, text }] };
}

export function listMemory(
  db: Database.Database,
  orgId: string,
  params: ListParams
): ToolResult {
  let sql = `SELECT id, project_id, category, key, access_count, updated_at FROM memory WHERE org_id = ?`;
  const sqlParams: unknown[] = [orgId];

  if (params.category) {
    sql += ` AND category = ?`;
    sqlParams.push(params.category);
  }
  if (params.project) {
    sql += ` AND (project_id IS NULL OR project_id = ?)`;
    sqlParams.push(params.project);
  }

  sql += ` ORDER BY category, key LIMIT 500`;
  const rows = db.prepare(sql).all(...sqlParams) as Array<{
    id: string;
    project_id: string | null;
    category: string;
    key: string;
    access_count: number;
    updated_at: string;
  }>;

  const text =
    rows.length === 0
      ? `No memories found.`
      : rows
          .map(
            (r) =>
              `- [${r.category}] ${r.key} (${r.project_id ?? "org-wide"}, accessed ${r.access_count}x)`
          )
          .join("\n");

  return { content: [{ type: "text" as const, text }] };
}

export function deleteMemory(
  db: Database.Database,
  orgId: string,
  params: DeleteParams
): ToolResult {
  const result = db
    .prepare(`DELETE FROM memory WHERE id = ? AND org_id = ?`)
    .run(params.id, orgId);

  const text =
    result.changes > 0
      ? `Deleted memory ${params.id}`
      : `Memory ${params.id} not found (or belongs to another org)`;

  return { content: [{ type: "text" as const, text }] };
}
