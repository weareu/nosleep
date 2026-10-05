/**
 * AI processing of uploaded documents and images on BOTH LLM routes, through
 * the existing headlessQuery(purpose) / vision-provider seams:
 *   - claude route: Agent SDK `query` (documents) and the `claude` CLI
 *     spawn (vision) are stubbed — proves the call is made, spends nothing.
 *   - openai route: a fake OpenAI-compatible server on node:http.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

// ── Claude stubs ────────────────────────────────────────────────────────────
const sdkPrompts: string[] = [];
/** Distillation prompts only — a new thought also gets the existing
 *  metadata-classification call, which is not under test here. */
const distillPrompts = () => sdkPrompts.filter((p) => p.startsWith("You distil a document"));
let sdkReply = "";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string }) => {
    sdkPrompts.push(args.prompt);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: sdkReply };
    })();
  },
}));

const cliCalls: string[][] = [];
let cliStdout = "";
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: (cmd: string, args: string[]) => {
      if (cmd !== "claude") return orig.spawn(cmd, args);
      cliCalls.push(args);
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => undefined;
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from(cliStdout));
        proc.emit("close", 0);
      });
      return proc;
    },
  };
});

// The first pdf-parse (pdf.js) import is a cold multi-second module load
// when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-distill-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
process.env.NOSLEEP_BRAIN_EMBED_INLINE = "0";
delete process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE;

import { registerBrainIngestRoutes } from "../routes/ingest.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { waitForExtractorQueue, __setMetadataExtractionHook } from "../extractors/worker.js";
import { setImageProviders } from "../extractors/image-providers.js";
import { createClaudeVisionProviders } from "../extractors/claude-vision-provider.js";
import { __resetHeadlessCircuit } from "../../lib/headless-claude.js";
import { buildTestPdf } from "./helpers/build-pdf.js";

const ORG = "org_distill";
const PROJ = "proj_distill";
const LLM_ENV_KEYS = [
  "NOSLEEP_LLM_PROVIDER",
  "NOSLEEP_LLM_PROVIDER_BRAIN",
  "NOSLEEP_LLM_BASE_URL_BRAIN",
  "NOSLEEP_LLM_MODEL_BRAIN",
  "NOSLEEP_LLM_PROVIDER_VISION",
  "NOSLEEP_LLM_BASE_URL_VISION",
  "NOSLEEP_LLM_MODEL_VISION",
];

let app: FastifyInstance;
let llmServer: http.Server;
let llmBase: string;
const llmRequests: Array<{ model: string; content: unknown }> = [];
let llmReply = "";

async function upload(filename: string, bytes: Buffer, content_type = "") {
  const res = await app.inject({
    method: "POST",
    url: "/api/brain/ingest/file",
    payload: { org_id: ORG, project_id: PROJ, filename, content_type, content_base64: bytes.toString("base64") },
  });
  expect(res.statusCode).toBe(202);
  return res.json() as { hash: string; kind: string; pages?: Array<{ hash: string }> };
}

function thoughtFor(hash: string) {
  return activeDbFor(ORG)
    .prepare(
      `SELECT t.content, t.thought_type FROM thoughts t
         JOIN thought_archive_refs r ON r.thought_id = t.id
        WHERE r.archive_hash = ? AND t.source_kind = 'auto_from_artifact'`,
    )
    .get(hash) as { content: string; thought_type: string } | undefined;
}

function autoThoughtRun(hash: string) {
  return activeDbFor(ORG)
    .prepare("SELECT result, model, error FROM extractor_runs WHERE extractor = 'auto_thought' AND artifact_hash = ?")
    .get(hash) as { result: string; model: string; error: string | null } | undefined;
}

beforeAll(async () => {
  activeDbFor(ORG);
  // Metadata enrichment of the new thought is a separate extractor with its
  // own tests; keep it out of the call counts here.
  __setMetadataExtractionHook(async () => true);
  app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  registerBrainIngestRoutes(app);
  await app.ready();

  llmServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; messages: Array<{ content: unknown }> };
      llmRequests.push({ model: body.model, content: body.messages[0].content });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: llmReply } }] }));
    });
  });
  await new Promise<void>((r) => llmServer.listen(0, "127.0.0.1", () => r()));
  llmBase = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}/v1`;
});

beforeEach(() => {
  for (const k of LLM_ENV_KEYS) delete process.env[k];
  sdkPrompts.length = 0;
  cliCalls.length = 0;
  llmRequests.length = 0;
  __resetHeadlessCircuit();
  setImageProviders({ phash: null, clip: null, ocr: null, scene: null, caption: null, exif: null });
});

afterAll(async () => {
  await waitForExtractorQueue(5_000);
  await app.close();
  await new Promise<void>((r) => llmServer.close(() => r()));
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("document distillation — claude route (default)", () => {
  test("an uploaded markdown document becomes a linked thought via the Agent SDK", async () => {
    sdkReply = '{"keep": true, "type": "decision", "content": "Ship the heron importer before the Q3 review."}';
    const doc = "# Heron importer\n\nWe decided to ship the heron importer before the Q3 review because the backlog is blocking two teams.";
    const up = await upload("heron.md", Buffer.from(doc));
    await waitForExtractorQueue(10_000);
    expect(distillPrompts()).toHaveLength(1);
    expect(distillPrompts()[0]).toContain("heron importer");
    expect(thoughtFor(up.hash)).toEqual({
      content: "Ship the heron importer before the Q3 review.",
      thought_type: "decision",
    });
    expect(autoThoughtRun(up.hash)).toMatchObject({ result: "success", model: "claude-haiku-4-5" });
  });

  test("a PDF is distilled once, from its page texts in order", async () => {
    sdkReply = '{"keep": true, "type": "insight", "content": "Ibis nesting moved north."}';
    const pdf = buildTestPdf(
      ["Ibis survey page one: nesting colonies counted along the delta in spring.", "Page two: colonies moved north by 40 km."],
      "Ibis",
    );
    const up = await upload("ibis.pdf", pdf);
    await waitForExtractorQueue(10_000);

    expect(distillPrompts()).toHaveLength(1);
    const prompt = distillPrompts()[0];
    expect(prompt.indexOf("Ibis survey page one")).toBeGreaterThan(-1);
    expect(prompt.indexOf("moved north")).toBeGreaterThan(prompt.indexOf("Ibis survey page one"));
    expect(thoughtFor(up.hash)?.content).toBe("Ibis nesting moved north.");
    // Pages are not distilled individually.
    for (const p of up.pages ?? []) expect(thoughtFor(p.hash)).toBeUndefined();
  });

  test("a not-worth-keeping verdict is recorded, not silent", async () => {
    sdkReply = '{"keep": false}';
    const up = await upload("boiler.txt", Buffer.from("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor."));
    await waitForExtractorQueue(10_000);
    expect(thoughtFor(up.hash)).toBeUndefined();
    expect(autoThoughtRun(up.hash)).toMatchObject({ result: "skipped", error: "not_thought_worthy" });
  });

  test("the budget kill switch skips the LLM and records it", async () => {
    process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";
    try {
      const up = await upload("budget.md", Buffer.from("A long enough note about the kestrel migration schedule for this test to pass."));
      await waitForExtractorQueue(10_000);
      expect(sdkPrompts).toHaveLength(0);
      expect(autoThoughtRun(up.hash)).toMatchObject({ result: "failed", error: "llm_failed" });
    } finally {
      delete process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE;
    }
  });

  test("image caption/OCR runs through the claude CLI vision path", async () => {
    cliStdout = '{"ocr_text": "EXIT 12", "caption": "A road sign reading EXIT 12.", "scene_class": "photo"}';
    setImageProviders(createClaudeVisionProviders());
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("claude-route-image")]);
    const up = await upload("sign.jpg", img, "image/jpeg");
    await waitForExtractorQueue(10_000);

    expect(cliCalls.length).toBeGreaterThan(0);
    expect(cliCalls[0]).toContain("--image");
    const row = activeDbFor(ORG)
      .prepare("SELECT caption, ocr_text FROM image_features WHERE hash = ?")
      .get(up.hash) as { caption: string; ocr_text: string };
    expect(row).toEqual({ caption: "A road sign reading EXIT 12.", ocr_text: "EXIT 12" });
  });
});

describe("document distillation — openai-compatible route", () => {
  test("an uploaded text document is distilled by the configured local model", async () => {
    process.env.NOSLEEP_LLM_PROVIDER_BRAIN = "openai";
    process.env.NOSLEEP_LLM_BASE_URL_BRAIN = llmBase;
    process.env.NOSLEEP_LLM_MODEL_BRAIN = "fake-local-model";
    llmReply = '{"keep": true, "type": "task", "content": "Order replacement egret tags by Friday."}';
    const up = await upload("todo.txt", Buffer.from("Reminder: the egret tags are failing in the field, order replacements by Friday."));
    await waitForExtractorQueue(10_000);

    expect(sdkPrompts).toHaveLength(0);
    const distill = llmRequests.filter((r) => String(r.content).startsWith("You distil a document"));
    expect(distill).toHaveLength(1);
    expect(distill[0].model).toBe("fake-local-model");
    expect(String(distill[0].content)).toContain("egret tags");
    expect(thoughtFor(up.hash)?.content).toBe("Order replacement egret tags by Friday.");
    expect(autoThoughtRun(up.hash)).toMatchObject({ result: "success", model: "openai:fake-local-model" });
  });

  test("image vision goes to the configured openai vision model", async () => {
    process.env.NOSLEEP_LLM_PROVIDER_VISION = "openai";
    process.env.NOSLEEP_LLM_BASE_URL_VISION = llmBase;
    process.env.NOSLEEP_LLM_MODEL_VISION = "fake-vision-model";
    llmReply = '{"ocr_text": "", "caption": "A small blue square.", "scene_class": "diagram"}';
    setImageProviders(createClaudeVisionProviders());
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from("openai-route-image")]);
    const up = await upload("square.jpg", img, "image/jpeg");
    await waitForExtractorQueue(10_000);

    expect(cliCalls).toHaveLength(0);
    expect(llmRequests.length).toBeGreaterThan(0);
    expect(llmRequests[0].model).toBe("fake-vision-model");
    const parts = llmRequests[0].content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toContain("image_url");
    const row = activeDbFor(ORG)
      .prepare("SELECT caption FROM image_features WHERE hash = ?")
      .get(up.hash) as { caption: string };
    expect(row.caption).toBe("A small blue square.");
  });

  test("vision OFF (openai without a vision model) skips cleanly and says why", async () => {
    process.env.NOSLEEP_LLM_PROVIDER_VISION = "openai";
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe2]), Buffer.from("vision-off-image")]);
    const up = await upload("off.jpg", img, "image/jpeg");
    await waitForExtractorQueue(10_000);

    expect(llmRequests).toHaveLength(0);
    expect(cliCalls).toHaveLength(0);
    const run = activeDbFor(ORG)
      .prepare("SELECT result, error FROM extractor_runs WHERE extractor = 'image_extractors' AND artifact_hash = ?")
      .get(up.hash) as { result: string; error: string };
    expect(run.result).toBe("skipped");
    expect(run.error).toContain("vision=off (provider openai but NOSLEEP_LLM_MODEL_VISION unset)");
  });
});
