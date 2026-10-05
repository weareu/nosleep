/**
 * Phase 9 — session/thought export endpoint tests. Spins up a Fastify
 * instance, registers brain export routes, and asserts JSON / Markdown /
 * JSONL responses.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify, { type FastifyInstance } from "fastify";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-export-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { captureThoughtAsync } from "../thoughts/capture.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { registerBrainExportRoutes } from "../routes/export.js";

const ORG = "org_export_test";
const PROJ = "proj_export";
const SESSION = "sess_export_1";

let fastify: FastifyInstance;
let artifactHash1: string;
let artifactHash2: string;
let thoughtId: string;

beforeAll(async () => {
  activeDbFor(ORG);

  artifactHash1 = ingest({
    kind: "conversation/turn/user",
    content: "hello brain — first turn",
    content_type: "text/plain",
    org_id: ORG,
    project_id: PROJ,
    session_id: SESSION,
    turn_ord: 1,
    origin: { tool: "test", actor: "user" },
    schema_version: 1,
  }).hash;

  artifactHash2 = ingest({
    kind: "conversation/turn/assistant",
    content: "hi back — second turn",
    content_type: "text/plain",
    org_id: ORG,
    project_id: PROJ,
    session_id: SESSION,
    turn_ord: 2,
    origin: { tool: "test", actor: "assistant" },
    schema_version: 1,
  }).hash;

  const t = await captureThoughtAsync({
    content: "key insight: user values brevity",
    org_id: ORG,
    project_id: PROJ,
    source_kind: "mcp_capture",
    thought_type_hint: "insight",
    source_refs: [{ hash: artifactHash1, relation: "supports" }],
  });
  thoughtId = t.id;

  fastify = Fastify({ logger: false });
  registerBrainExportRoutes(fastify);
  await fastify.ready();
});

afterAll(async () => {
  await fastify.close();
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 9 — session export", () => {
  test("JSON export includes all artifacts in turn order", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/sessions/${SESSION}/export?org_id=${ORG}&format=json`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      session_id: string;
      artifact_count: number;
      artifacts: Array<{ hash: string; kind: string; content: string | null }>;
    };
    expect(body.session_id).toBe(SESSION);
    expect(body.artifact_count).toBe(2);
    const hashes = body.artifacts.map((a) => a.hash);
    expect(hashes).toContain(artifactHash1);
    expect(hashes).toContain(artifactHash2);
    const allContent = body.artifacts.map((a) => a.content).join(" ");
    expect(allContent).toContain("first turn");
    expect(allContent).toContain("second turn");
  });

  test("Markdown export renders headings + content blocks", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/sessions/${SESSION}/export?org_id=${ORG}&format=md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.headers["content-disposition"]).toMatch(/attachment.*\.md/);
    expect(res.body).toContain(`# Session ${SESSION}`);
    expect(res.body).toContain("conversation/turn/user");
    expect(res.body).toContain("first turn");
    expect(res.body).toContain("second turn");
  });

  test("JSONL export emits one valid JSON line per artifact", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/sessions/${SESSION}/export?org_id=${ORG}&format=jsonl`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/x-ndjson/);
    const lines = res.body.trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.hash).toBe("string");
      expect(typeof parsed.kind).toBe("string");
    }
  });

  test("missing org_id is a 400", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/sessions/${SESSION}/export`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("phase 9 — thought export", () => {
  test("JSON export returns the thought + refs", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/thoughts/${thoughtId}/export?org_id=${ORG}&format=json`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      thought: {
        id: string;
        content: string;
        archive_refs?: Array<{ archive_hash: string }>;
      };
    };
    expect(body.thought.id).toBe(thoughtId);
    expect(body.thought.content).toContain("brevity");
    expect(body.thought.archive_refs?.[0]?.archive_hash).toBe(artifactHash1);
  });

  test("Markdown export includes linked archive section", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/thoughts/${thoughtId}/export?org_id=${ORG}&format=md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("# insight:");
    expect(res.body).toContain("brevity");
    expect(res.body).toContain("Linked archive artifacts");
    expect(res.body).toContain(artifactHash1);
  });

  test("404 for unknown thought id", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: `/api/brain/thoughts/does_not_exist/export?org_id=${ORG}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
