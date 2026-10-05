/**
 * Phase 10 — integration tests for suggestions, entity merge queue,
 * URL re-fetch, OpenCode webhook adapter, LTR export, and the backfill
 * kind mapping.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify, { type FastifyInstance } from "fastify";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-p10-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { captureThoughtAsync } from "../thoughts/capture.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { runThoughtRefProposer } from "../proposer/thought-ref-proposer.js";
import { registerBrainSuggestionRoutes } from "../routes/suggestions.js";
import { registerBrainMergeQueueRoutes } from "../routes/merge-queue.js";
import { registerBrainOpenCodeRoutes } from "../routes/opencode-webhook.js";
import { exportLtrFeatures } from "../jobs/ltr-export.js";

const ORG = "org_phase10";
const PROJ = "proj_phase10";

let fastify: FastifyInstance;

beforeAll(async () => {
  activeDbFor(ORG);
  fastify = Fastify({ logger: false });
  registerBrainSuggestionRoutes(fastify);
  registerBrainMergeQueueRoutes(fastify);
  registerBrainOpenCodeRoutes(fastify);
  await fastify.ready();
});

afterAll(async () => {
  await fastify.close();
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 10 — suggestions queue", () => {
  test("dry-run proposer reports candidates without LLM call", async () => {
    // Seed two thoughts so dedup-style nearest-neighbour MIGHT fire if vec
    // is loaded. Without vec, the proposer reports vec_unavailable and
    // returns 0 — both outcomes are acceptable here.
    await captureThoughtAsync({
      content: "shipping plan A — quarter goals locked in",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
      thought_type_hint: "decision",
    });
    await captureThoughtAsync({
      content: "shipping plan A finalised — quarter goals locked",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
      thought_type_hint: "decision",
    });

    const result = await runThoughtRefProposer({
      org_id: ORG,
      project_id: PROJ,
      dry_run: true,
      cosine_floor: 0.5,
    });
    // Either the proposer ran (pairs_examined ≥ 0 and skipped_reason is
    // dry_run when vec is loaded) or vec is missing.
    expect(["dry_run", "no_candidates", "vec_unavailable"]).toContain(
      result.skipped_reason,
    );
    expect(result.suggestions_created).toBe(0);
  });

  test("manually-inserted suggestion can be approved → thought_ref written", async () => {
    // Create two thoughts in the DB and a suggestion row directly.
    const a = await captureThoughtAsync({
      content: "alpha thought for approval test",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const b = await captureThoughtAsync({
      content: "beta thought for approval test",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });

    const db = activeDbFor(ORG);
    const sugId = "sug_test_1";
    db.prepare(
      `INSERT INTO thought_ref_suggestions
       (id, org_id, project_id, from_thought_id, to_thought_id, relation,
        confidence, cosine, justification, proposer_model, created_at, reviewed)
       VALUES (?, ?, ?, ?, ?, 'related_to', 0.9, 0.9, 'test', 'claude-haiku-4-5', ?, 0)`,
    ).run(sugId, ORG, PROJ, a.id, b.id, Math.floor(Date.now() / 1000));

    const decideRes = await fastify.inject({
      method: "POST",
      url: `/api/brain/admin/suggestions/${sugId}/decide`,
      payload: { org_id: ORG, decision: "approve" },
    });
    expect(decideRes.statusCode).toBe(200);
    const body = decideRes.json() as { applied: boolean };
    expect(body.applied).toBe(true);

    const trefRow = db
      .prepare(
        `SELECT origin FROM thought_refs
          WHERE from_thought_id = ? AND to_thought_id = ? AND relation = 'related_to'`,
      )
      .get(a.id, b.id) as { origin: string } | undefined;
    expect(trefRow?.origin).toBe("llm_suggested_approved");

    // Re-deciding the same suggestion is a 409.
    const second = await fastify.inject({
      method: "POST",
      url: `/api/brain/admin/suggestions/${sugId}/decide`,
      payload: { org_id: ORG, decision: "approve" },
    });
    expect(second.statusCode).toBe(409);
  });

  test("listing returns unreviewed by default", async () => {
    // Insert a fresh unreviewed suggestion.
    const c = await captureThoughtAsync({
      content: "gamma list test",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const d = await captureThoughtAsync({
      content: "delta list test",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const db = activeDbFor(ORG);
    db.prepare(
      `INSERT INTO thought_ref_suggestions
       (id, org_id, project_id, from_thought_id, to_thought_id, relation,
        confidence, cosine, justification, proposer_model, created_at, reviewed)
       VALUES (?, ?, ?, ?, ?, 'refines', 0.85, 0.85, '', 'claude-haiku-4-5', ?, 0)`,
    ).run("sug_test_2", ORG, PROJ, c.id, d.id, Math.floor(Date.now() / 1000));

    const listRes = await fastify.inject({
      method: "GET",
      url: `/api/brain/admin/suggestions/list?org_id=${ORG}&project_id=${PROJ}&reviewed=false`,
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json() as { items: { id: string }[] };
    expect(body.items.find((s) => s.id === "sug_test_2")).toBeDefined();
  });
});

describe("phase 10 — entity merge queue", () => {
  test("propose → approve sets merged_into; audit row written", async () => {
    const db = activeDbFor(ORG);
    // Seed two same-kind entities.
    db.prepare(
      `INSERT INTO entities
       (id, org_id, kind, canonical_name, aliases_json, created_at)
       VALUES (?, ?, 'topic', ?, '[]', ?)`,
    ).run("ent_a", ORG, "Alpha Topic", Math.floor(Date.now() / 1000));
    db.prepare(
      `INSERT INTO entities
       (id, org_id, kind, canonical_name, aliases_json, created_at)
       VALUES (?, ?, 'topic', ?, '[]', ?)`,
    ).run("ent_b", ORG, "Alpha", Math.floor(Date.now() / 1000));

    const create = await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/merge-proposals",
      payload: {
        org_id: ORG,
        from_entity_id: "ent_b",
        to_entity_id: "ent_a",
        rationale: "duplicate",
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };

    const decide = await fastify.inject({
      method: "POST",
      url: `/api/brain/admin/merge-proposals/${id}/decide`,
      payload: { org_id: ORG, decision: "approve" },
    });
    expect(decide.statusCode).toBe(200);
    const body = decide.json() as { applied: boolean };
    expect(body.applied).toBe(true);

    const ent = db
      .prepare(`SELECT merged_into FROM entities WHERE id = 'ent_b'`)
      .get() as { merged_into: string } | undefined;
    expect(ent?.merged_into).toBe("ent_a");

    const event = db
      .prepare(
        `SELECT event_type FROM brain_session_events
          WHERE event_type = 'entity_merge_decision'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { event_type: string } | undefined;
    expect(event?.event_type).toBe("entity_merge_decision");
  });

  test("kind mismatch is rejected at approve time", async () => {
    const db = activeDbFor(ORG);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO entities (id, org_id, kind, canonical_name, aliases_json, created_at)
       VALUES ('ent_topic', ?, 'topic', 'Topic', '[]', ?)`,
    ).run(ORG, now);
    db.prepare(
      `INSERT INTO entities (id, org_id, kind, canonical_name, aliases_json, created_at)
       VALUES ('ent_person', ?, 'person', 'Person', '[]', ?)`,
    ).run(ORG, now);

    const create = await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/merge-proposals",
      payload: {
        org_id: ORG,
        from_entity_id: "ent_topic",
        to_entity_id: "ent_person",
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };

    const decide = await fastify.inject({
      method: "POST",
      url: `/api/brain/admin/merge-proposals/${id}/decide`,
      payload: { org_id: ORG, decision: "approve" },
    });
    expect(decide.statusCode).toBe(400);
    const body = decide.json() as { error: { code: string } };
    expect(body.error.code).toBe("KIND_MISMATCH");
  });
});

describe("phase 10 — opencode webhook", () => {
  test("single event → ingested with origin tool=opencode", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/brain/webhook/opencode",
      payload: {
        type: "user_message",
        org_id: ORG,
        project_id: PROJ,
        text: "hello opencode",
        actor: "user",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ingested: number; hashes: string[] };
    expect(body.ingested).toBe(1);

    const db = activeDbFor(ORG);
    const a = db
      .prepare(`SELECT kind, origin_tool FROM artifacts WHERE hash = ?`)
      .get(body.hashes[0]) as { kind: string; origin_tool: string } | undefined;
    expect(a?.origin_tool).toBe("opencode");
    expect(a?.kind).toBe("conversation/turn/user");
  });

  test("batch envelope ingests multiple events", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/brain/webhook/opencode",
      payload: {
        events: [
          {
            type: "tool_invoke",
            org_id: ORG,
            project_id: PROJ,
            tool_name: "ls",
            tool_input: { path: "/tmp" },
          },
          {
            type: "tool_result",
            org_id: ORG,
            project_id: PROJ,
            tool_name: "ls",
            tool_output: "file1\nfile2",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ingested: number };
    expect(body.ingested).toBe(2);
  });
});

describe("phase 10 — LTR export", () => {
  test("emits CSV with one row per fused candidate", () => {
    const db = activeDbFor(ORG);
    // Seed a query_log with engagement.
    const queryId = "q_phase10_1";
    const ts = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO query_logs
       (query_id, ts, query_spec_json, intent, retrievers_json, fused_top_json,
        reranked_top_json, chosen_ids_json, used_ids_json, latency_ms,
        confidence_score, project_id, org_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      queryId,
      ts,
      JSON.stringify({ text: { query: "test" } }),
      "find_code",
      JSON.stringify([
        {
          retriever: "bm25",
          weight: 1.0,
          top20: [
            { hash: "h1", rank: 1, raw: 0.8 },
            { hash: "h2", rank: 2, raw: 0.7 },
          ],
        },
      ]),
      JSON.stringify([
        { hash: "h1", score: 0.5, rank: 1 },
        { hash: "h2", score: 0.4, rank: 2 },
      ]),
      JSON.stringify(["h1", "h2"]),
      JSON.stringify(["h1"]),
      42,
      PROJ,
      ORG,
    );

    const result = exportLtrFeatures({ org_id: ORG, from: ts - 10, to: ts + 10 });
    expect(result.queries).toBe(1);
    expect(result.rows).toBeGreaterThanOrEqual(2);
    expect(result.used_count).toBe(1);
    expect(fs.existsSync(result.path)).toBe(true);

    const csv = fs.readFileSync(result.path, "utf8");
    expect(csv.split("\n")[0]).toContain("query_id");
    expect(csv).toContain(",h1,");
    // h1 has label=1 (used); the line should end with ",1"
    const lines = csv.trim().split("\n");
    const h1Line = lines.find((l) => l.includes(",h1,"));
    expect(h1Line).toBeDefined();
    expect(h1Line!.split(",").pop()).toBe("1");
  });
});
