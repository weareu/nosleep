/**
 * Daily brain maintenance (Phase 22-E/F): the scheduled runner that drives
 * the thought-dedup proposer and the sleep-time consolidator, plus the
 * retrieval/route surfaces that keep archived thoughts reachable.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-maint-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";

import { captureThought } from "../thoughts/capture.js";
import { addThoughtRef } from "../thoughts/refs.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { isVecLoaded } from "../storage/vec-loader.js";
import { setEmbedProvider, EMBED_DIM, type EmbedProvider } from "../extractors/embed-provider.js";
import { waitForExtractorQueue } from "../extractors/worker.js";
import { runThoughtDedup } from "../jobs/thought-dedup.js";
import { runThoughtConsolidation, listConsolidationRuns } from "../jobs/thought-consolidator.js";
import {
  runBrainMaintenanceIfDue,
  brainMaintenanceConfigFromEnv,
  resetBrainMaintenanceMemo,
} from "../jobs/maintenance.js";
import { runSemanticText } from "../retrieval/retrievers/semantic-text.js";
import { QuerySpec } from "../retrieval/query-spec.js";
import { registerBrainMergeQueueRoutes } from "../routes/merge-queue.js";
import { registerBrainThoughtsRoutes } from "../routes/thoughts.js";

const DAY = 86_400;
const PROJ = "proj_m";
let orgSeq = 0;
function freshOrg(): string {
  orgSeq += 1;
  const org = `org_maint_${orgSeq}`;
  activeDbFor(org);
  return org;
}
const nowSec = () => Math.floor(Date.now() / 1000);

/** Deterministic bag-of-tokens embedder (same text → same unit vector). */
class FakeEmbedProvider implements EmbedProvider {
  readonly name = "fake-maint";
  readonly dim = EMBED_DIM;
  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(EMBED_DIM);
    for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      const h = createHash("sha256").update(tok).digest();
      for (let i = 0; i < h.length; i++) out[(i * 13) % EMBED_DIM] += (h[i] - 128) / 128;
    }
    let norm = 0;
    for (let i = 0; i < EMBED_DIM; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) out[i] /= norm;
    return out;
  }
}

async function capture(org: string, content: string, extra: { strategy_node_ref?: string } = {}): Promise<string> {
  const id = captureThought({ content, org_id: org, project_id: PROJ, source_kind: "mcp_capture", ...extra }).id;
  await waitForExtractorQueue();
  return id;
}

function visibilityOf(org: string, id: string): string | undefined {
  return (activeDbFor(org).prepare(`SELECT visibility FROM thoughts WHERE id = ?`).get(id) as
    | { visibility: string }
    | undefined)?.visibility;
}

/** Minimal main-DB stand-in carrying only the strategy_nodes the resolver reads. */
function mainDbWithNodes(nodes: Record<string, string>): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE strategy_nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
  const ins = db.prepare(`INSERT INTO strategy_nodes (id, status) VALUES (?, ?)`);
  for (const [id, status] of Object.entries(nodes)) ins.run(id, status);
  return db;
}

const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

let fastify: FastifyInstance;

beforeAll(async () => {
  setEmbedProvider(new FakeEmbedProvider());
  fastify = Fastify({ logger: false });
  registerBrainMergeQueueRoutes(fastify);
  registerBrainThoughtsRoutes(fastify);
  await fastify.ready();
});

beforeEach(() => {
  resetBrainMaintenanceMemo();
});

afterAll(async () => {
  await fastify.close();
  setEmbedProvider(null);
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("maintenance config", () => {
  test("defaults: dedup proposals on, consolidator on, 90 days, 500 per run", () => {
    expect(brainMaintenanceConfigFromEnv({})).toEqual({
      enabled: true,
      dedup: true,
      consolidate: "on",
      stale_days: 90,
      max_per_run: 500,
    });
  });

  test("env overrides are honoured and junk falls back to safe defaults", () => {
    expect(
      brainMaintenanceConfigFromEnv({
        NOSLEEP_BRAIN_MAINTENANCE: "0",
        NOSLEEP_BRAIN_DEDUP_NIGHTLY: "0",
        NOSLEEP_BRAIN_CONSOLIDATE: "dry-run",
        NOSLEEP_BRAIN_CONSOLIDATE_DAYS: "30",
        NOSLEEP_BRAIN_CONSOLIDATE_MAX: "abc",
      }),
    ).toEqual({ enabled: false, dedup: false, consolidate: "dry-run", stale_days: 30, max_per_run: 500 });
    // A stale window below 7 days would archive working memory — clamp it.
    expect(brainMaintenanceConfigFromEnv({ NOSLEEP_BRAIN_CONSOLIDATE_DAYS: "1" }).stale_days).toBe(7);
    expect(brainMaintenanceConfigFromEnv({ NOSLEEP_BRAIN_CONSOLIDATE: "bogus" }).consolidate).toBe("dry-run");
  });
});

describe("runBrainMaintenanceIfDue", () => {
  test("runs consolidation per org using live strategy status from the main DB", async () => {
    const org = freshOrg();
    const live = await capture(org, "work for a pending node", { strategy_node_ref: "n_pending" });
    const finished = await capture(org, "work for a completed node", { strategy_node_ref: "n_done" });
    const mainDb = mainDbWithNodes({ n_pending: "pending", n_done: "completed" });

    const out = await runBrainMaintenanceIfDue({
      orgIds: [org],
      mainDb,
      log: quietLog,
      nowMs: (nowSec() + 120 * DAY) * 1000,
      config: { ...brainMaintenanceConfigFromEnv({}), dedup: false },
    });
    expect(out[org].status).toBe("ran");
    expect(visibilityOf(org, finished)).toBe("archived");
    expect(visibilityOf(org, live)).toBe("active");
  });

  test("does not run again inside the daily window, even after a restart", async () => {
    const org = freshOrg();
    const cfg = { ...brainMaintenanceConfigFromEnv({}), dedup: false };
    const t0 = Date.now();
    const first = await runBrainMaintenanceIfDue({ orgIds: [org], log: quietLog, nowMs: t0, config: cfg });
    expect(first[org].status).toBe("ran");

    const again = await runBrainMaintenanceIfDue({ orgIds: [org], log: quietLog, nowMs: t0 + 3600_000, config: cfg });
    expect(again[org].status).toBe("not_due");

    resetBrainMaintenanceMemo(); // simulate a server restart (in-memory state lost)
    const afterRestart = await runBrainMaintenanceIfDue({
      orgIds: [org],
      log: quietLog,
      nowMs: t0 + 2 * 3600_000,
      config: cfg,
    });
    expect(afterRestart[org].status).toBe("not_due");

    const nextDay = await runBrainMaintenanceIfDue({
      orgIds: [org],
      log: quietLog,
      nowMs: t0 + 25 * 3600_000,
      config: cfg,
    });
    expect(nextDay[org].status).toBe("ran");
  });

  test("dry-run mode records what it would archive without archiving", async () => {
    const org = freshOrg();
    const id = await capture(org, "would be archived");
    await runBrainMaintenanceIfDue({
      orgIds: [org],
      log: quietLog,
      nowMs: (nowSec() + 120 * DAY) * 1000,
      config: { ...brainMaintenanceConfigFromEnv({}), dedup: false, consolidate: "dry-run" },
    });
    expect(visibilityOf(org, id)).toBe("active");
    const runs = listConsolidationRuns(org, 5);
    expect(runs[0].dry_run).toBe(true);
    expect(runs[0].archived_stale).toEqual([id]);
  });

  test("a failing step is logged, never thrown, and other steps/orgs still run", async () => {
    const broken = freshOrg();
    const healthy = freshOrg();
    await capture(broken, "linked to a node", { strategy_node_ref: "n1" });
    const stale = await capture(healthy, "plain stale thought");
    // Main DB without a strategy_nodes table → the resolver throws for `broken`.
    const mainDb = new Database(":memory:");
    const errors: unknown[] = [];

    const out = await runBrainMaintenanceIfDue({
      orgIds: [broken, healthy],
      mainDb,
      log: { ...quietLog, error: (obj: unknown) => errors.push(obj) },
      nowMs: (nowSec() + 120 * DAY) * 1000,
      config: brainMaintenanceConfigFromEnv({}),
    });
    expect(out[broken].status).toBe("ran");
    expect(out[broken].consolidation_error).toMatch(/strategy_nodes/);
    expect(out[broken].dedup_error).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(visibilityOf(healthy, stale)).toBe("archived");
  });

  test("disabled maintenance does nothing", async () => {
    const org = freshOrg();
    const id = await capture(org, "untouched");
    const out = await runBrainMaintenanceIfDue({
      orgIds: [org],
      log: quietLog,
      nowMs: (nowSec() + 120 * DAY) * 1000,
      config: { ...brainMaintenanceConfigFromEnv({}), enabled: false },
    });
    expect(out[org].status).toBe("disabled");
    expect(visibilityOf(org, id)).toBe("active");
  });
});

describe("thought dedup proposer", () => {
  test("proposes near-identical active thoughts once, and skips archived neighbours", async () => {
    const org = freshOrg();
    if (!isVecLoaded(activeDbFor(org))) return; // sqlite-vec unavailable on this host
    const a = await capture(org, "the deploy pipeline needs a canary stage");
    const b = await capture(org, "the deploy pipeline needs a canary stage");
    const c = await capture(org, "rotate the signing keys every quarter");
    const d = await capture(org, "rotate the signing keys every quarter");
    runThoughtConsolidation({ org_id: org, now_sec: nowSec() }); // no-op, nothing stale
    activeDbFor(org).prepare(`UPDATE thoughts SET visibility = 'archived' WHERE id = ?`).run(d);

    const first = await runThoughtDedup({ org_id: org });
    expect(first.proposed).toBe(1);
    const pairs = activeDbFor(org)
      .prepare(`SELECT from_thought_id, to_thought_id FROM thought_merge_proposals`)
      .all() as Array<{ from_thought_id: string; to_thought_id: string }>;
    expect(pairs.map((p) => [p.from_thought_id, p.to_thought_id].sort())).toEqual([[a, b].sort()]);
    expect(pairs.flatMap((p) => [p.from_thought_id, p.to_thought_id])).not.toContain(c);

    const second = await runThoughtDedup({ org_id: org });
    expect(second.proposed).toBe(0);
  });
});

describe("semantic retrieval and archived thoughts", () => {
  test("archived thoughts drop out of semantic hits unless include_archived is set", async () => {
    const org = freshOrg();
    if (!isVecLoaded(activeDbFor(org))) return;
    const id = await capture(org, "platypus feeding schedule");
    const spec = (extra: Record<string, unknown> = {}) =>
      QuerySpec.parse({ org_id: org, project_id: PROJ, text: { query: "platypus feeding schedule" }, ...extra });

    const before = await runSemanticText(activeDbFor(org), spec(), 10);
    expect(before.map((r) => r.hash)).toContain(id);

    activeDbFor(org).prepare(`UPDATE thoughts SET visibility = 'archived' WHERE id = ?`).run(id);
    const hidden = await runSemanticText(activeDbFor(org), spec(), 10);
    expect(hidden.map((r) => r.hash)).not.toContain(id);

    const shown = await runSemanticText(activeDbFor(org), spec({ include_archived: true }), 10);
    expect(shown.map((r) => r.hash)).toContain(id);
  });
});

describe("routes", () => {
  test("consolidation run (dry + real), run history, search include_archived, unarchive", async () => {
    const org = freshOrg();
    const oldT = await capture(org, "echidna policy v1");
    const newT = await capture(org, "echidna policy v2");
    addThoughtRef({ org_id: org, from_thought_id: newT, to_thought_id: oldT, relation: "supersedes" });

    const dry = await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/thought-consolidation/run",
      payload: { org_id: org, dry_run: true },
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().archived_superseded).toEqual([oldT]);
    expect(visibilityOf(org, oldT)).toBe("active");

    const real = await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/thought-consolidation/run",
      payload: { org_id: org },
    });
    expect(real.json().archived_superseded).toEqual([oldT]);
    expect(visibilityOf(org, oldT)).toBe("archived");

    const runs = await fastify.inject({
      method: "GET",
      url: `/api/brain/admin/thought-consolidation/runs?org_id=${org}`,
    });
    expect(runs.json().items).toHaveLength(2);

    const search = async (include_archived?: boolean) =>
      (
        await fastify.inject({
          method: "POST",
          url: "/api/brain/thoughts/search",
          payload: { org_id: org, project_id: PROJ, query: "echidna", include_archived },
        })
      ).json().results.map((r: { thought: { id: string } }) => r.thought.id);
    expect(await search()).toEqual([newT]);
    expect((await search(true)).sort()).toEqual([newT, oldT].sort());

    const un = await fastify.inject({
      method: "POST",
      url: "/api/brain/thoughts/unarchive",
      payload: { org_id: org, ids: [oldT] },
    });
    expect(un.statusCode).toBe(200);
    expect(un.json().restored).toEqual([oldT]);
    expect(visibilityOf(org, oldT)).toBe("active");

    // The supersedes ref still exists, but a human said "keep this" — the
    // next run must not undo that.
    await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/thought-consolidation/run",
      payload: { org_id: org },
    });
    expect(visibilityOf(org, oldT)).toBe("active");
  });

  test("consolidation run rejects a missing org_id", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/thought-consolidation/run",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test("manual dedup run route still answers", async () => {
    const org = freshOrg();
    const res = await fastify.inject({
      method: "POST",
      url: "/api/brain/admin/thought-merge-proposals/run",
      payload: { org_id: org },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("scanned");
  });
});
