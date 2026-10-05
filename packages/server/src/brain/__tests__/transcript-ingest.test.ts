/**
 * Phase 12 — transcript ingester tests. Fixes the Layer 1 blind spot
 * where only conversation/tool_call was being captured.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-transcript-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
// Transcript reads are contained to the transcript root (security: the
// hook-ingest endpoint must not be an arbitrary-file-read). Point the root
// at the temp dir so the fixtures below are inside it.
process.env.NOSLEEP_TRANSCRIPT_ROOT = tmpDataDir;

import { ingestTranscript } from "../hooks/transcript-ingest.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_transcript_test";
const PROJ = "proj_transcript";
const SESSION = "sess_transcript_1";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

function writeTranscript(lines: object[]): string {
  const p = path.join(tmpDataDir, `transcript-${Date.now()}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

describe("phase 12 — transcript ingest", () => {
  test("ingests user + assistant turns from a JSONL transcript", () => {
    const transcript = writeTranscript([
      {
        type: "user",
        message: { role: "user", content: "build the auto-thought extractor" },
        uuid: "u-1",
        timestamp: "2026-04-25T20:00:00.000Z",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll add the extractor + a backfill route. Starting with the schema.",
            },
            { type: "tool_use", name: "Edit", input: { file: "x.ts" } },
          ],
        },
        uuid: "a-1",
        timestamp: "2026-04-25T20:00:30.000Z",
      },
      // tool_use-only assistant block — should be skipped (no text)
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
        uuid: "a-2",
      },
    ]);

    const result = ingestTranscript({
      org_id: ORG,
      project_id: PROJ,
      session_id: SESSION,
      transcript_path: transcript,
    });

    expect(result.scanned).toBe(3);
    expect(result.ingested).toBe(2);
    expect(result.errors).toHaveLength(0);

    const db = activeDbFor(ORG);
    const userRow = db
      .prepare(
        `SELECT kind, content FROM artifacts
          WHERE session_id = ? AND kind = 'conversation/turn/user_message'`,
      )
      .get(SESSION) as { kind: string; content: Buffer } | undefined;
    expect(userRow).toBeDefined();
    expect(userRow!.content.toString("utf8")).toContain("auto-thought");

    const asstRow = db
      .prepare(
        `SELECT kind, content FROM artifacts
          WHERE session_id = ? AND kind = 'conversation/turn/assistant_message'`,
      )
      .get(SESSION) as { kind: string; content: Buffer } | undefined;
    expect(asstRow).toBeDefined();
    expect(asstRow!.content.toString("utf8")).toContain("backfill route");
  });

  test("idempotent: re-running on the same transcript dedupes", () => {
    const transcript = writeTranscript([
      {
        type: "user",
        message: { role: "user", content: "redo this thing" },
        uuid: "u-2",
      },
    ]);

    const first = ingestTranscript({
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_idem",
      transcript_path: transcript,
    });
    expect(first.ingested).toBe(1);

    const second = ingestTranscript({
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_idem",
      transcript_path: transcript,
    });
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  test("missing transcript file returns an error, not a crash", () => {
    const result = ingestTranscript({
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_missing",
      transcript_path: "/tmp/does-not-exist-12345.jsonl",
    });
    expect(result.scanned).toBe(0);
    expect(result.errors[0]).toMatch(/transcript not found/);
  });

  test("rejects non-absolute paths (path-traversal guard)", () => {
    const result = ingestTranscript({
      org_id: ORG,
      project_id: PROJ,
      session_id: "sess_rel",
      transcript_path: "../../../etc/passwd",
    });
    expect(result.errors[0]).toMatch(/must be absolute/);
  });

  test("rejects absolute paths OUTSIDE the transcript root (arbitrary-file-read guard)", () => {
    // A real, readable file that is not a transcript — must be refused.
    const outside = path.join(os.tmpdir(), `nosleep-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "secret contents");
    try {
      const result = ingestTranscript({
        org_id: ORG,
        project_id: PROJ,
        session_id: "sess_outside",
        transcript_path: outside,
      });
      expect(result.scanned).toBe(0);
      expect(result.ingested).toBe(0);
      expect(result.errors[0]).toMatch(/transcript root|could not be resolved/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
