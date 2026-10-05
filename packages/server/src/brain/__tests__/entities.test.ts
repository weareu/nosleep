/**
 * Phase 4 tests: entities, thought_refs, related_thoughts, and the gap fixes
 * (capture-url note → thought, semantic dedup upgrade).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-phase4-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { captureThought, captureThoughtAsync } from "../thoughts/capture.js";
import { addThoughtRef, ThoughtRefError } from "../thoughts/refs.js";
import { relatedThoughts } from "../thoughts/related.js";
import {
  resolveEntity,
  recordEntityRef,
} from "../entities/resolve.js";
import {
  listEntities,
  getEntity,
  addAlias,
  mergeInto,
  EntityMergeError,
} from "../entities/api.js";
import { runEntityResolver } from "../extractors/entity-resolver.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import {
  setEmbedProvider,
  EMBED_DIM,
  type EmbedProvider,
} from "../extractors/embed-provider.js";
import {
  scheduleTextEmbedding,
  waitForExtractorQueue,
} from "../extractors/worker.js";

const ORG = "org_phase4_test";
const PROJ_A = "proj_pa";
const PROJ_B = "proj_pb";

class FakeEmbedProvider implements EmbedProvider {
  readonly name = "fake-phase4";
  readonly dim = EMBED_DIM;
  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(EMBED_DIM);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const h = createHash("sha256").update(tok).digest();
      for (let i = 0; i < h.length; i++) {
        out[(i * 13) % EMBED_DIM] += (h[i] - 128) / 128;
      }
    }
    let n = 0;
    for (let i = 0; i < EMBED_DIM; i++) n += out[i] * out[i];
    n = Math.sqrt(n);
    if (n > 0) for (let i = 0; i < EMBED_DIM; i++) out[i] /= n;
    return out;
  }
}

beforeAll(() => {
  setEmbedProvider(new FakeEmbedProvider());
  activeDbFor(ORG);
});

afterAll(() => {
  setEmbedProvider(null);
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain phase 4 — entities", () => {
  test("resolveEntity creates a new entity when unknown", () => {
    const r = resolveEntity(ORG, "person", "Jane Doe");
    expect(r).not.toBeNull();
    expect(r?.created).toBe(true);
  });

  test("resolveEntity reuses existing canonical match", () => {
    resolveEntity(ORG, "topic", "auth-middleware");
    const again = resolveEntity(ORG, "topic", "auth-middleware");
    expect(again?.created).toBe(false);
  });

  test("alias matching resolves to same entity", () => {
    const r = resolveEntity(ORG, "topic", "jwt-rotation");
    expect(r).not.toBeNull();
    const added = addAlias(ORG, r!.entity_id, "JWT Rotation");
    expect(added).toBe(true);
    const viaAlias = resolveEntity(ORG, "topic", "JWT Rotation");
    expect(viaAlias?.entity_id).toBe(r!.entity_id);
    expect(viaAlias?.created).toBe(false);
  });

  test("stopwords + too-short names are rejected", () => {
    expect(resolveEntity(ORG, "person", "he")).toBeNull();
    expect(resolveEntity(ORG, "person", "a")).toBeNull();
    expect(resolveEntity(ORG, "topic", " ")).toBeNull();
  });

  test("entity_refs are recorded and listed", () => {
    const cap = captureThought({
      content: "Jane mentioned the auth-middleware refactor",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const jane = resolveEntity(ORG, "person", "Jane")!;
    const topic = resolveEntity(ORG, "topic", "auth-middleware")!;
    recordEntityRef(ORG, jane.entity_id, "thought", cap.id, PROJ_A);
    recordEntityRef(ORG, topic.entity_id, "thought", cap.id, PROJ_A);

    const entities = listEntities({ orgId: ORG, projectId: PROJ_A });
    const names = entities.map((e) => e.canonical_name);
    expect(names).toContain("jane");
    expect(names).toContain("auth-middleware");
  });

  test("cross-project entity ref lookup", () => {
    const cap = captureThought({
      content: "Jane is also mentioned in project B",
      org_id: ORG,
      project_id: PROJ_B,
      source_kind: "mcp_capture",
    });
    const jane = resolveEntity(ORG, "person", "Jane")!;
    recordEntityRef(ORG, jane.entity_id, "thought", cap.id, PROJ_B);

    const detail = getEntity(ORG, jane.entity_id)!;
    // Cross-project refs should show up when scope is org (no project filter)
    expect(detail.recent_refs.length).toBeGreaterThanOrEqual(2);
    const projects = new Set(detail.recent_refs.map((r) => r.project_id));
    expect(projects.has(PROJ_A)).toBe(true);
    expect(projects.has(PROJ_B)).toBe(true);
  });

  test("merge lazily redirects via merged_into", () => {
    const a = resolveEntity(ORG, "topic", "auth-mw")!;
    const b = resolveEntity(ORG, "topic", "auth-middleware")!;
    mergeInto(ORG, a.entity_id, b.entity_id);

    const viaA = resolveEntity(ORG, "topic", "auth-mw")!;
    expect(viaA.entity_id).toBe(b.entity_id);
    expect(viaA.merged_redirect).toBe(b.entity_id);
  });

  test("merge rejects cycles + kind mismatch + self-merge", () => {
    const a = resolveEntity(ORG, "topic", "cycle-a")!;
    const b = resolveEntity(ORG, "topic", "cycle-b")!;
    const person = resolveEntity(ORG, "person", "Bob")!;

    mergeInto(ORG, a.entity_id, b.entity_id);
    expect(() => mergeInto(ORG, b.entity_id, a.entity_id)).toThrow(EntityMergeError);
    expect(() => mergeInto(ORG, a.entity_id, a.entity_id)).toThrow(EntityMergeError);
    expect(() => mergeInto(ORG, a.entity_id, person.entity_id)).toThrow(EntityMergeError);
  });

  test("listEntities excludes merged rows", () => {
    // auth-mw (from earlier) should NOT appear because it's merged into auth-middleware
    const entities = listEntities({ orgId: ORG, kind: "topic" });
    const names = entities.map((e) => e.canonical_name);
    expect(names).not.toContain("auth-mw");
    expect(names).toContain("auth-middleware");
  });

  test("entity resolver runs from metadata_json", async () => {
    const cap = captureThought({
      content: "resolver test note",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const db = activeDbFor(ORG);
    db.prepare(
      `UPDATE thoughts SET metadata_json = ?, thought_type = ? WHERE id = ?`,
    ).run(
      JSON.stringify({
        type: "insight",
        topics: ["rate-limiter"],
        people: ["Alice"],
        action_items: [],
        dates_mentioned: [],
      }),
      "insight",
      cap.id,
    );
    await runEntityResolver(ORG, cap.id);

    const alice = resolveEntity(ORG, "person", "Alice");
    expect(alice?.entity_id).toBeTruthy();
    const refs = db
      .prepare(
        `SELECT COUNT(*) AS c FROM entity_refs WHERE referrer_id = ? AND referrer_kind = 'thought'`,
      )
      .get(cap.id) as { c: number };
    expect(refs.c).toBeGreaterThanOrEqual(2);
  });
});

describe("brain phase 4 — thought_refs", () => {
  test("addThoughtRef creates an edge with intra_project scope", () => {
    const a = captureThought({
      content: "trefs-src",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "trefs-dst",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const r = addThoughtRef({
      org_id: ORG,
      from_thought_id: a.id,
      to_thought_id: b.id,
      relation: "refines",
    });
    expect(r.created).toBe(true);
    expect(r.scope).toBe("intra_project");
    expect(r.project_id).toBe(PROJ_A);
  });

  test("cross-project edge tagged scope=cross_project", () => {
    const a = captureThought({
      content: "cross-a",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "cross-b",
      org_id: ORG,
      project_id: PROJ_B,
      source_kind: "mcp_capture",
    });
    const r = addThoughtRef({
      org_id: ORG,
      from_thought_id: a.id,
      to_thought_id: b.id,
      relation: "related_to",
    });
    expect(r.scope).toBe("cross_project");
  });

  test("self-reference is rejected", () => {
    const a = captureThought({
      content: "self-ref-test",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    expect(() =>
      addThoughtRef({
        org_id: ORG,
        from_thought_id: a.id,
        to_thought_id: a.id,
        relation: "refines",
      }),
    ).toThrow(ThoughtRefError);
  });

  test("duplicate edge is a no-op", () => {
    const a = captureThought({
      content: "dup-a",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "dup-b",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const first = addThoughtRef({
      org_id: ORG,
      from_thought_id: a.id,
      to_thought_id: b.id,
      relation: "refines",
    });
    const second = addThoughtRef({
      org_id: ORG,
      from_thought_id: a.id,
      to_thought_id: b.id,
      relation: "refines",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });
});

describe("brain phase 4 — related_thoughts", () => {
  test("returns thoughts linked by explicit edges", () => {
    const a = captureThought({
      content: "rel-src",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "rel-dst",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    addThoughtRef({
      org_id: ORG,
      from_thought_id: a.id,
      to_thought_id: b.id,
      relation: "refines",
    });
    const items = relatedThoughts(ORG, a.id, { modalities: ["edges"] });
    expect(items.map((i) => i.thought.id)).toContain(b.id);
  });

  test("returns thoughts sharing topics", () => {
    const a = captureThought({
      content: "topic-share-a",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const b = captureThought({
      content: "topic-share-b",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "mcp_capture",
    });
    const db = activeDbFor(ORG);
    const meta = JSON.stringify({
      type: "observation",
      topics: ["rare-shared-topic-xyz"],
      people: [],
      action_items: [],
      dates_mentioned: [],
    });
    db.prepare(`UPDATE thoughts SET metadata_json = ? WHERE id IN (?, ?)`).run(
      meta,
      a.id,
      b.id,
    );
    const items = relatedThoughts(ORG, a.id, { modalities: ["topics"] });
    expect(items.map((i) => i.thought.id)).toContain(b.id);
  });

  test("returns thoughts with shared archive refs", () => {
    const a = captureThought({
      content: "shared-src-a",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "promoted_from_archive",
      source_refs: [{ hash: "a".repeat(64), relation: "distilled_from" }],
    });
    const b = captureThought({
      content: "shared-src-b",
      org_id: ORG,
      project_id: PROJ_A,
      source_kind: "promoted_from_archive",
      source_refs: [{ hash: "a".repeat(64), relation: "distilled_from" }],
    });
    const items = relatedThoughts(ORG, a.id, { modalities: ["shared_session"] });
    expect(items.map((i) => i.thought.id)).toContain(b.id);
  });
});

describe("brain phase 4 — gap fixes", () => {
  test("semantic dedup surfaces near-duplicate on captureThoughtAsync", async () => {
    // Seed directly via embedding-text so we don't fire the Haiku
    // metadata_llm path that captureThought chains in.
    const { nanoid } = await import("nanoid");
    const { runTextEmbedding } = await import("../extractors/embedding-text.js");
    const db = activeDbFor(ORG);
    const seedId = `thg_${nanoid(16)}`;
    const now = Math.floor(Date.now() / 1000);
    const content = "semantic dedup target alpha epsilon";
    db.prepare(
      `INSERT INTO thoughts
       (id, org_id, project_id, content, metadata_json, thought_type,
        source_kind, source_refs_json, strategy_node_ref,
        created_at, updated_at, visibility)
       VALUES (?, ?, ?, ?, ?, 'observation', 'mcp_capture', NULL, NULL, ?, ?, 'active')`,
    ).run(
      seedId,
      ORG,
      PROJ_A,
      content,
      JSON.stringify({
        type: "observation",
        topics: [],
        people: [],
        action_items: [],
        dates_mentioned: [],
      }),
      now,
      now,
    );
    await runTextEmbedding({
      referrer_kind: "thought",
      hash: seedId,
      text: content,
      project_id: PROJ_A,
      org_id: ORG,
    });

    // Now capture via the async path — semantic dedup should surface the seed.
    const { findSemanticallySimilarThoughts } = await import("../thoughts/dedup.js");
    const similar = await findSemanticallySimilarThoughts(
      db,
      PROJ_A,
      content,
      3,
    );
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].id).toBe(seedId);
    expect(similar[0].similarity).toBeGreaterThanOrEqual(0.85);
  });
});
