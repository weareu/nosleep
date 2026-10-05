/**
 * Phase 6 graph tests — cooccur computation + graph response shaping.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-graph-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { captureThought } from "../thoughts/capture.js";
import { addThoughtRef } from "../thoughts/refs.js";
import { computeCooccurForProject } from "../graph/cooccur.js";
import { buildGraph } from "../graph/api.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_graph_test";
const PROJ = "proj_graph";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

function setMetadata(id: string, topics: string[], people: string[]) {
  const db = activeDbFor(ORG);
  db.prepare(
    `UPDATE thoughts SET metadata_json = ? WHERE id = ?`,
  ).run(
    JSON.stringify({
      type: "observation",
      topics,
      people,
      action_items: [],
      dates_mentioned: [],
    }),
    id,
  );
}

describe("phase 6 — cooccur", () => {
  test("computes shared_topic edges via Jaccard", () => {
    const a = captureThought({
      content: "thought a topics share",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "thought b topics share",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    setMetadata(a.id, ["auth", "jwt"], []);
    setMetadata(b.id, ["auth", "jwt"], []);

    const result = computeCooccurForProject(ORG, PROJ);
    expect(result.thought_count).toBeGreaterThanOrEqual(2);
    expect(result.edges_written).toBeGreaterThan(0);

    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        `SELECT relation FROM thought_cooccur WHERE (a_id = ? OR b_id = ?) AND (a_id = ? OR b_id = ?)`,
      )
      .all(a.id, a.id, b.id, b.id) as Array<{ relation: string }>;
    const relations = new Set(rows.map((r) => r.relation));
    expect(relations.has("shared_topic")).toBe(true);
  });

  test("computes shared_people edges", () => {
    const a = captureThought({
      content: "people share a",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "people share b",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    setMetadata(a.id, [], ["jane", "bob"]);
    setMetadata(b.id, [], ["jane", "bob"]);
    computeCooccurForProject(ORG, PROJ);

    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        `SELECT relation FROM thought_cooccur WHERE (a_id = ? OR b_id = ?) AND (a_id = ? OR b_id = ?) AND relation = 'shared_people'`,
      )
      .all(a.id, a.id, b.id, b.id) as Array<{ relation: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  test("computes source_linked + same_session via shared archive_refs", () => {
    const sharedHash = "a".repeat(64);
    const a = captureThought({
      content: "archive ref a",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "promoted_from_archive",
      source_refs: [{ hash: sharedHash, relation: "distilled_from" }],
    });
    const b = captureThought({
      content: "archive ref b",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "promoted_from_archive",
      source_refs: [{ hash: sharedHash, relation: "distilled_from" }],
    });
    computeCooccurForProject(ORG, PROJ);

    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        `SELECT relation FROM thought_cooccur
          WHERE (a_id = ? OR b_id = ?) AND (a_id = ? OR b_id = ?)`,
      )
      .all(a.id, a.id, b.id, b.id) as Array<{ relation: string }>;
    const relations = new Set(rows.map((r) => r.relation));
    expect(relations.has("source_linked")).toBe(true);
    expect(relations.has("same_session")).toBe(true);
  });
});

describe("phase 6 — graph response", () => {
  test("returns thoughts as nodes and thought_refs as explicit edges", () => {
    const a = captureThought({
      content: "graph node a",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "graph node b",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    addThoughtRef({
      org_id: ORG,
      from_thought_id: a.id,
      to_thought_id: b.id,
      relation: "refines",
    });

    const result = buildGraph({
      org_id: ORG,
      project_id: PROJ,
      layers: ["thoughts"],
    });
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    expect(nodeIds.has(a.id)).toBe(true);
    expect(nodeIds.has(b.id)).toBe(true);

    const explicitEdges = result.edges.filter(
      (e) => e.source === "thought_refs",
    );
    expect(
      explicitEdges.some(
        (e) => e.from === a.id && e.to === b.id && e.relation === "refines",
      ),
    ).toBe(true);
  });

  test("density warning escalates with node count", () => {
    const result = buildGraph({
      org_id: ORG,
      project_id: PROJ,
      layers: ["thoughts"],
    });
    expect(result.density.warning).toBe("none");
    expect(result.density.soft_limit).toBe(500);
    expect(result.density.hard_limit).toBe(1200);
  });

  test("entity layer pulls in entity nodes referenced by thoughts", () => {
    const a = captureThought({
      content: "entity link test",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const db = activeDbFor(ORG);
    db.prepare(
      `INSERT OR IGNORE INTO entities (id, org_id, kind, canonical_name, created_at, visibility)
       VALUES ('ent_graphtest', ?, 'topic', 'graph-test-topic', ?, 'active')`,
    ).run(ORG, Math.floor(Date.now() / 1000));
    db.prepare(
      `INSERT OR IGNORE INTO entity_refs
       (entity_id, referrer_kind, referrer_id, project_id, relation, created_at)
       VALUES ('ent_graphtest', 'thought', ?, ?, 'mentions', ?)`,
    ).run(a.id, PROJ, Math.floor(Date.now() / 1000));

    const result = buildGraph({
      org_id: ORG,
      project_id: PROJ,
      layers: ["thoughts", "entities"],
    });
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    expect(nodeIds.has("ent_graphtest")).toBe(true);
    const entityEdges = result.edges.filter((e) => e.source === "entity_refs");
    expect(entityEdges.some((e) => e.to === "ent_graphtest")).toBe(true);
  });
});
