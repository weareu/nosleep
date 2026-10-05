/**
 * Entity-resolver extractor. Reads a thought's extracted metadata (topics +
 * people) and turns each string into a first-class entity with a mentions
 * entity_refs row. Runs after metadata_llm completes.
 *
 * Side-effect only — no return value other than a success/skip signal for
 * audit.
 */

import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import { resolveEntity, recordEntityRef } from "../entities/resolve.js";

export async function runEntityResolver(
  orgId: string,
  thoughtId: string,
): Promise<boolean> {
  const db = activeDbFor(orgId);
  const started = performance.now();

  const row = db
    .prepare(
      `SELECT id, project_id, metadata_json FROM thoughts WHERE id = ? AND org_id = ?`,
    )
    .get(thoughtId, orgId) as
    | { id: string; project_id: string; metadata_json: string }
    | undefined;

  if (!row) return false;

  let metadata: {
    topics?: string[];
    people?: string[];
  };
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    recordRun(orgId, row.project_id, thoughtId, started, "failed", "bad metadata_json");
    return false;
  }

  let created = 0;
  let reused = 0;

  for (const topic of metadata.topics ?? []) {
    const res = resolveEntity(orgId, "topic", topic);
    if (!res) continue;
    recordEntityRef(orgId, res.entity_id, "thought", thoughtId, row.project_id);
    res.created ? created++ : reused++;
  }
  for (const person of metadata.people ?? []) {
    const res = resolveEntity(orgId, "person", person);
    if (!res) continue;
    recordEntityRef(orgId, res.entity_id, "thought", thoughtId, row.project_id);
    res.created ? created++ : reused++;
  }

  recordRun(
    orgId,
    row.project_id,
    thoughtId,
    started,
    "success",
    `created=${created} reused=${reused}`,
  );
  return true;
}

function recordRun(
  orgId: string,
  projectId: string,
  thoughtId: string,
  started: number,
  result: "success" | "failed" | "skipped",
  note: string,
): void {
  const db = activeDbFor(orgId);
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'entity_resolver', '0.1.0', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      thoughtId,
      performance.now() - started,
      result,
      result === "success" ? note : note,
      projectId,
      orgId,
    );
  } catch {
    /* audit best-effort */
  }
}
