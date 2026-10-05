/**
 * Phase 11 — auto-thought extractor tests. Stubs the Haiku call via the
 * __setAutoThoughtHook so tests run offline.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-autothought-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import {
  runAutoThoughtExtraction,
  __setAutoThoughtHook,
} from "../extractors/auto-thought.js";
import { runAutoThoughtBackfill } from "../jobs/auto-thought-backfill.js";

const ORG = "org_autothought";
const PROJ = "proj_autothought";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  // Always unregister the hook even if a test threw before its own
  // cleanup — a leaked hook would taint other test files in the same
  // vitest worker.
  try {
    __setAutoThoughtHook(null);
  } finally {
    closeAllBrainDbs();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  // Belt + braces: also reset after each test so a synchronous throw
  // mid-test still leaves the override unset.
  __setAutoThoughtHook(null);
});

beforeEach(() => {
  __setAutoThoughtHook(null);
});

describe("phase 11 — auto-thought extractor", () => {
  test("extracts a thought from an insight-bearing assistant turn", async () => {
    __setAutoThoughtHook(async () => ({
      keep: true,
      type: "insight",
      content: "Token spend doubled because every retrieval re-embeds queries.",
    }));

    const a = ingest({
      kind: "conversation/turn/assistant",
      content:
        "After tracing the latency, every retrieval call re-embeds the query — that's why token spend doubled when we added semantic search. Cache the embedding per query_id and the cost regression goes away.",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_a",
      origin: { tool: "test", actor: "assistant" },
      schema_version: 1,
    });

    const result = await runAutoThoughtExtraction({
      org_id: ORG,
      artifact_hash: a.hash,
    });
    expect(result.thought_id).toBeTruthy();

    const db = activeDbFor(ORG);
    const thought = db
      .prepare(
        `SELECT id, content, source_kind, thought_type FROM thoughts WHERE id = ?`,
      )
      .get(result.thought_id) as
      | { id: string; content: string; source_kind: string; thought_type: string }
      | undefined;
    expect(thought).toBeDefined();
    expect(thought!.source_kind).toBe("auto_from_artifact");
    expect(thought!.thought_type).toBe("insight");
    expect(thought!.content).toContain("re-embeds");

    // archive_ref written so the graph can link back
    const ref = db
      .prepare(
        `SELECT archive_hash FROM thought_archive_refs
          WHERE thought_id = ? AND archive_hash = ?`,
      )
      .get(result.thought_id, a.hash) as { archive_hash: string } | undefined;
    expect(ref?.archive_hash).toBe(a.hash);

    // Phase 12 — extractor_runs row written so the auto-thought extractor
    // shows up on the admin extractor-health dashboard.
    const run = db
      .prepare(
        `SELECT extractor, result FROM extractor_runs
          WHERE artifact_hash = ? AND extractor = 'auto_thought'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(a.hash) as { extractor: string; result: string } | undefined;
    expect(run?.extractor).toBe("auto_thought");
    expect(run?.result).toBe("success");
  });

  test("skips routine ack turns", async () => {
    __setAutoThoughtHook(async () => ({ keep: false }));

    const a = ingest({
      kind: "conversation/turn/assistant",
      content:
        "I edited packages/server/src/foo.ts and added the missing import. The build passes now and tests are green for the affected suite.",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_b",
      origin: { tool: "test", actor: "assistant" },
      schema_version: 1,
    });

    const result = await runAutoThoughtExtraction({
      org_id: ORG,
      artifact_hash: a.hash,
    });
    expect(result.thought_id).toBeNull();
    expect(result.skipped_reason).toBe("not_thought_worthy");
  });

  test("idempotent — re-running on the same artifact does not duplicate", async () => {
    __setAutoThoughtHook(async () => ({
      keep: true,
      type: "decision",
      content: "Adopt fan-out search across sealed quarters.",
    }));

    const a = ingest({
      kind: "conversation/turn/assistant",
      content:
        "Decision: we'll fan out search across sealed quarter files when the user opts in via time_range='all_time'. Default stays on active.db only to keep latency tight.",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_c",
      origin: { tool: "test", actor: "assistant" },
      schema_version: 1,
    });

    const first = await runAutoThoughtExtraction({
      org_id: ORG,
      artifact_hash: a.hash,
    });
    expect(first.thought_id).toBeTruthy();

    const second = await runAutoThoughtExtraction({
      org_id: ORG,
      artifact_hash: a.hash,
    });
    expect(second.thought_id).toBe(first.thought_id);
    expect(second.skipped_reason).toBe("already_extracted");

    const db = activeDbFor(ORG);
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM thoughts t
             JOIN thought_archive_refs r ON r.thought_id = t.id
            WHERE r.archive_hash = ? AND t.source_kind = 'auto_from_artifact'`,
        )
        .get(a.hash) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  test("skips too-short turns", async () => {
    let called = 0;
    __setAutoThoughtHook(async () => {
      called += 1;
      return { keep: false };
    });

    const a = ingest({
      kind: "conversation/turn/user",
      content: "ok",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_d",
      origin: { tool: "test", actor: "user" },
      schema_version: 1,
    });

    const result = await runAutoThoughtExtraction({
      org_id: ORG,
      artifact_hash: a.hash,
    });
    expect(result.skipped_reason).toBe("too_short");
    expect(called).toBe(0); // never reached the LLM
  });

  test("backfill walks unprocessed turns and extracts", async () => {
    __setAutoThoughtHook(async (text) => {
      // Only "lift" turns that mention the word "principle" so we can verify
      // the keep/skip filtering through the backfill batch.
      if (text.toLowerCase().includes("principle")) {
        return {
          keep: true,
          type: "insight",
          content: "design principle captured",
        };
      }
      return { keep: false };
    });

    const ORG_BF = "org_autothought_bf";
    activeDbFor(ORG_BF);

    ingest({
      kind: "conversation/turn/assistant",
      content:
        "Core principle: lift agent reasoning into thoughts, never user-typed.",
      content_type: "text/plain",
      org_id: ORG_BF,
      project_id: PROJ,
      session_id: "sess_e",
      origin: { tool: "test", actor: "assistant" },
      schema_version: 1,
    });
    ingest({
      kind: "conversation/turn/assistant",
      content:
        "Edited file path packages/server/src/x.ts. Tests still pass. Moving on.",
      content_type: "text/plain",
      org_id: ORG_BF,
      project_id: PROJ,
      session_id: "sess_e",
      origin: { tool: "test", actor: "assistant" },
      schema_version: 1,
    });

    const result = await runAutoThoughtBackfill({ org_id: ORG_BF });
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.extracted).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Re-running picks up nothing new (idempotent at the SQL filter level)
    const second = await runAutoThoughtBackfill({ org_id: ORG_BF });
    expect(second.extracted).toBe(0);
  });
});
