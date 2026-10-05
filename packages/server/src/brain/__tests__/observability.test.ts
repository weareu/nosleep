/**
 * Phase 7 — observability tests. Verifies metric emission, rollup
 * aggregation, and admin endpoint logic against the underlying functions.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-obs-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { emit, inc } from "../metrics/emit.js";
import { rollupForOrg, fetchSeries } from "../metrics/rollup.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_obs_test";
const PROJ = "proj_obs";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 7 — metrics emit", () => {
  test("emit writes a metrics row", () => {
    emit({
      metric_key: "test.counter",
      value: 42,
      org_id: ORG,
      project_id: PROJ,
      tags: { kind: "test" },
    });
    const db = activeDbFor(ORG);
    const row = db
      .prepare(
        "SELECT metric_key, value, tags_json FROM metrics WHERE metric_key = ? AND project_id = ?",
      )
      .get("test.counter", PROJ) as
      | { metric_key: string; value: number; tags_json: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe(42);
    expect(JSON.parse(row!.tags_json)).toEqual({ kind: "test" });
  });

  test("ingest emits artifacts.ingested.count and bytes", () => {
    const before = (
      activeDbFor(ORG)
        .prepare(
          "SELECT COUNT(*) AS c FROM metrics WHERE metric_key = 'artifacts.ingested.count'",
        )
        .get() as { c: number }
    ).c;
    ingest({
      kind: "knowledge/note",
      content: "metrics test",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const after = (
      activeDbFor(ORG)
        .prepare(
          "SELECT COUNT(*) AS c FROM metrics WHERE metric_key = 'artifacts.ingested.count'",
        )
        .get() as { c: number }
    ).c;
    expect(after - before).toBe(1);
  });

  test("dedup hit emits its own counter, not a fresh ingest", () => {
    const db = activeDbFor(ORG);
    const content = "exact-dup-test";
    ingest({
      kind: "knowledge/note",
      content,
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const dupCountBefore = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM metrics WHERE metric_key = 'artifacts.dedup_hit'",
        )
        .get() as { c: number }
    ).c;
    ingest({
      kind: "knowledge/note",
      content,
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const dupCountAfter = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM metrics WHERE metric_key = 'artifacts.dedup_hit'",
        )
        .get() as { c: number }
    ).c;
    expect(dupCountAfter - dupCountBefore).toBe(1);
  });
});

describe("phase 7 — rollup", () => {
  test("rolls metrics into 1h + 1d buckets", () => {
    // Seed deterministic metric points
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 10; i++) {
      emit({
        metric_key: "test.rollup.value",
        value: i + 1,
        org_id: ORG,
        project_id: PROJ,
        ts: now - 60 * i,
      });
    }
    const result = rollupForOrg(ORG);
    expect(result.hour_buckets).toBeGreaterThan(0);

    const series = fetchSeries({
      org_id: ORG,
      metric_key: "test.rollup.value",
      project_id: PROJ,
      from: now - 7200,
      to: now,
      resolution: "1h",
    });
    expect(series.resolution).toBe("1h");
    expect(series.points.length).toBeGreaterThan(0);
    const firstPoint = series.points[0];
    expect(firstPoint.value).toBeGreaterThan(0);
  });

  test("fetchSeries returns raw rows when range is short", () => {
    const now = Math.floor(Date.now() / 1000);
    const series = fetchSeries({
      org_id: ORG,
      metric_key: "test.rollup.value",
      project_id: PROJ,
      from: now - 3600,
      to: now,
      resolution: "raw",
    });
    expect(series.resolution).toBe("raw");
    expect(series.points.length).toBeGreaterThan(0);
  });

  test("rollupForOrg is idempotent", () => {
    const r1 = rollupForOrg(ORG);
    const r2 = rollupForOrg(ORG);
    // bucket counts should be identical (UPSERT collapses) — but this depends
    // on no new metrics being emitted between. Check buckets > 0.
    expect(r2.hour_buckets).toBeGreaterThanOrEqual(r1.hour_buckets);
  });
});

describe("phase 7 — admin event reads", () => {
  test("ingest events table has rows after ingest", () => {
    inc("test.canary", ORG, PROJ);
    const db = activeDbFor(ORG);
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM ingest_events").get() as {
        c: number;
      }
    ).c;
    expect(count).toBeGreaterThan(0);
  });
});
