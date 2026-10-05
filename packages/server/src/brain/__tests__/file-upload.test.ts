/**
 * Document upload end to end through the real routes:
 * POST /api/brain/ingest/file → artifacts → POST /api/brain/search.
 * Also: session-hook document Reads, URL capture (HTML + PDF), the mobile
 * photo payload on /api/brain/ingest, and cross-org rejection.
 *
 * No LLM is reachable here: the Agent SDK is mocked and triage disabled,
 * so the upload path is exercised without spending anything.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

const sdkQuery = vi.fn(() => {
  throw new Error("LLM must not be called in file-upload tests");
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdkQuery }));

// The first pdf-parse (pdf.js) import is a cold multi-second module load
// when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-upload-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";
process.env.NOSLEEP_BRAIN_EMBED_INLINE = "0";
process.env.NOSLEEP_URL_FETCH_ALLOW_HOSTS = "127.0.0.1";
// Per-org keys → request.orgId binding (cross-org tests).
const KEY_PERSONAL = "personal-key-0123456789";
const KEY_WYOBI = "wyobi-key-0123456789abc";
process.env.NOSLEEP_API_KEY_PERSONAL = KEY_PERSONAL;
process.env.NOSLEEP_API_KEY_WYOBI = KEY_WYOBI;

import { registerAuth } from "../../auth.js";
import { registerBrainIngestRoutes } from "../routes/ingest.js";
import { registerBrainSearchRoutes } from "../routes/search.js";
import { registerBrainHookIngestRoutes } from "../routes/hook-ingest.js";
import { registerBrainCaptureUrlRoutes } from "../routes/capture-url.js";
import { registerBrainArtifactRoutes } from "../routes/artifacts.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { waitForExtractorQueue } from "../extractors/worker.js";
import { buildTestPdf } from "./helpers/build-pdf.js";

const ORG = "org_personal";
const PROJ = "proj_upload";

let app: FastifyInstance;
let fixtureServer: http.Server;
let fixtureBase: string;

function auth(key = KEY_PERSONAL): Record<string, string> {
  return { "x-api-key": key };
}

async function upload(body: Record<string, unknown>, key = KEY_PERSONAL) {
  return app.inject({
    method: "POST",
    url: "/api/brain/ingest/file",
    headers: auth(key),
    payload: { org_id: ORG, project_id: PROJ, ...body },
  });
}

async function searchText(query: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/brain/search",
    headers: auth(),
    payload: {
      org_id: ORG,
      project_id: PROJ,
      layers: ["archive"],
      text: { query, mode: "lexical" },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { results: Array<{ hash: string; kind: string }> };
}

function artifactRow(hash: string) {
  return activeDbFor(ORG)
    .prepare("SELECT hash, kind, content_type, kind_specific_meta, org_id, project_id, session_id FROM artifacts WHERE hash = ?")
    .get(hash) as
    | { hash: string; kind: string; content_type: string; kind_specific_meta: string; org_id: string; project_id: string; session_id: string | null }
    | undefined;
}

async function until<T>(fn: () => T | undefined | null, ms = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const PDF = buildTestPdf(["Quarterly zebrafish migration report", "Appendix on quokka habitats"], "Field Notes");

beforeAll(async () => {
  activeDbFor(ORG);
  app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  registerAuth(app, undefined);
  registerBrainIngestRoutes(app);
  registerBrainSearchRoutes(app);
  registerBrainHookIngestRoutes(app);
  registerBrainCaptureUrlRoutes(app);
  registerBrainArtifactRoutes(app);
  await app.ready();

  fixtureServer = http.createServer((req, res) => {
    if (req.url === "/article") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>Pangolin Field Guide</title></head><body><article>" +
          "<p>The pangolin is the only mammal covered in keratin scales. This guide covers diet, range and conservation status in detail.</p>" +
          "</article></body></html>",
      );
      return;
    }
    if (req.url === "/papers/axolotl.pdf") {
      const pdf = buildTestPdf(["Axolotl regeneration study page one", "Axolotl limb results page two"], "Axolotl");
      res.writeHead(200, { "content-type": "application/pdf", "content-length": String(pdf.length) });
      res.end(pdf);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fixtureServer.listen(0, "127.0.0.1", () => r()));
  fixtureBase = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await waitForExtractorQueue(5_000);
  await app.close();
  await new Promise<void>((r) => fixtureServer.close(() => r()));
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("POST /api/brain/ingest/file — PDF", () => {
  test("stores the PDF + one searchable artifact per page, linked to the source", async () => {
    const res = await upload({
      filename: "field-notes.pdf",
      content_type: "application/pdf",
      content_base64: PDF.toString("base64"),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.kind).toBe("document/pdf");
    expect(body.page_count).toBe(2);
    expect(body.pages).toHaveLength(2);
    expect(body.warnings).toEqual([]);

    const source = artifactRow(body.hash);
    expect(source?.content_type).toBe("application/pdf");
    expect(JSON.parse(source!.kind_specific_meta)).toMatchObject({
      filename: "field-notes.pdf",
      page_count: 2,
      pdf_title: "Field Notes",
    });

    const page2 = artifactRow(body.pages[1].hash);
    expect(page2?.kind).toBe("document/pdf_excerpt");
    expect(JSON.parse(page2!.kind_specific_meta)).toMatchObject({ page_number: 2, total_pages: 2 });

    const edges = activeDbFor(ORG)
      .prepare("SELECT from_hash FROM artifact_edges WHERE to_hash = ? AND relation = 'page_of_document'")
      .all(body.hash) as Array<{ from_hash: string }>;
    expect(edges.map((e) => e.from_hash).sort()).toEqual(body.pages.map((p: { hash: string }) => p.hash).sort());

    const hits = await searchText("quokka");
    expect(hits.results.map((r) => r.hash)).toContain(body.pages[1].hash);
    // The raw PDF bytes are not FTS-indexed (binary).
    expect(hits.results.map((r) => r.hash)).not.toContain(body.hash);
  });

  test("the artifact read path returns the stored PDF as base64", async () => {
    const up = (await upload({ filename: "again.pdf", content_base64: PDF.toString("base64") })).json();
    expect(up.duplicate).toBe(true);
    const res = await app.inject({
      method: "GET",
      url: `/api/brain/artifacts/${up.hash}?org_id=${ORG}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const art = res.json();
    expect(art.content_encoding).toBe("base64");
    expect(Buffer.from(art.content, "base64").equals(PDF)).toBe(true);
  });

  test("a corrupt PDF is 422 and writes nothing", async () => {
    const before = activeDbFor(ORG).prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    const res = await upload({
      filename: "broken.pdf",
      content_base64: Buffer.from("%PDF-1.4\nthis is not a real pdf").toString("base64"),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("UNREADABLE_FILE");
    const after = activeDbFor(ORG).prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("POST /api/brain/ingest/file — text, code, images", () => {
  test("markdown upload becomes a searchable document/markdown artifact", async () => {
    const md = "# Release plan\n\nShip the narwhal importer before the quarterly review.";
    const res = await upload({
      filename: "plan.md",
      content_type: "text/markdown",
      content_base64: Buffer.from(md).toString("base64"),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.kind).toBe("document/markdown");
    const hits = await searchText("narwhal");
    expect(hits.results.map((r) => r.hash)).toContain(body.hash);
  });

  test("source code resolves by extension even when the browser mislabels it", async () => {
    // Browsers report .ts as video/mp2t.
    const res = await upload({
      filename: "util.ts",
      content_type: "video/mp2t",
      content_base64: Buffer.from("export const wombatCount = 3;\n").toString("base64"),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().kind).toBe("code/blob/ts");
  });

  test("image upload lands as media/image/photo with an extractor run recorded", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const res = await upload({ filename: "dot.png", content_type: "image/png", content_base64: png.toString("base64") });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.kind).toBe("media/image/photo");
    await waitForExtractorQueue(5_000);
    const run = await until(
      () =>
        activeDbFor(ORG)
          .prepare("SELECT result, error FROM extractor_runs WHERE extractor = 'image_extractors' AND artifact_hash = ?")
          .get(body.hash) as { result: string; error: string } | undefined,
    );
    expect(run.error).toMatch(/vision=/);
  });

  test("the mobile photo payload on /api/brain/ingest stores an image artifact", async () => {
    const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("mobile-photo-bytes")]);
    const res = await app.inject({
      method: "POST",
      url: "/api/brain/ingest",
      headers: auth(),
      payload: {
        kind: "media/image/photo",
        content: jpegish.toString("base64"),
        content_type: "image/jpeg",
        org_id: ORG,
        project_id: PROJ,
        origin: { tool: "nosleep-mobile", actor: "user" },
        kind_specific_meta: { width: 10, height: 10 },
        schema_version: 1,
      },
    });
    expect(res.statusCode).toBe(202);
    const row = artifactRow(res.json().hash);
    expect(row?.kind).toBe("media/image/photo");
    expect(row?.content_type).toBe("image/jpeg");
  });
});

describe("POST /api/brain/ingest/file — rejections", () => {
  test("unsupported type is 415 and lists the supported types", async () => {
    const res = await upload({
      filename: "setup.exe",
      content_type: "application/x-msdownload",
      content_base64: Buffer.from("MZ").toString("base64"),
    });
    expect(res.statusCode).toBe(415);
    const err = res.json().error;
    expect(err.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(err.details.supported.pdf.join(" ")).toContain(".pdf");
    expect(err.details.supported.image.join(" ")).toContain(".png");
  });

  test("a file over the 10 MB cap is 413", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const res = await upload({ filename: "big.txt", content_base64: big.toString("base64") });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("SIZE_LIMIT");
  });

  test("invalid base64 and non-UTF-8 text are 422", async () => {
    const badB64 = await upload({ filename: "x.md", content_base64: "not*base64!" });
    expect(badB64.statusCode).toBe(422);
    const binaryAsText = await upload({
      filename: "x.txt",
      content_base64: Buffer.from([0xc3, 0x28, 0xa0, 0xa1]).toString("base64"),
    });
    expect(binaryAsText.statusCode).toBe(422);
  });

  test("a key bound to one org cannot upload into another (403)", async () => {
    const res = await upload(
      { filename: "x.md", content_base64: Buffer.from("cross org attempt text").toString("base64") },
      KEY_WYOBI,
    );
    expect(res.statusCode).toBe(403);
  });

  test("missing API key is 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/brain/ingest/file",
      payload: { org_id: ORG, project_id: PROJ, filename: "x.md", content_base64: "" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("session hooks — document Reads", () => {
  test("Read of a PDF / markdown file ingests the document from disk", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDataDir, "docs-"));
    const pdfPath = path.join(dir, "spec.pdf");
    fs.writeFileSync(pdfPath, buildTestPdf(["Hook read capybara specification"], "Spec"));
    const mdPath = path.join(dir, "NOTES.md");
    fs.writeFileSync(mdPath, "# Notes\n\nThe okapi rollout is blocked on review.");

    for (const file of [pdfPath, mdPath]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/brain/hook-ingest/post-tool",
        remoteAddress: "127.0.0.1",
        payload: {
          orgId: ORG,
          projectId: PROJ,
          sessionId: "sess_hook_docs",
          toolName: "Read",
          toolInput: { file_path: file },
          toolResult: JSON.stringify({ type: "text", file: { filePath: file, content: "truncated" } }),
        },
      });
      expect(res.statusCode).toBe(200);
    }

    const pdfHit = await until(() => findKind("document/pdf_excerpt", "capybara"));
    expect(pdfHit.session_id).toBe("sess_hook_docs");
    const mdHit = await until(() => findKind("document/markdown", "okapi"));
    expect(JSON.parse(mdHit.kind_specific_meta).filename).toBe(mdPath);
    // No JSON-wrapped code/file_snapshot for documents.
    const snapshots = activeDbFor(ORG)
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'code/file_snapshot' AND session_id = 'sess_hook_docs'")
      .get() as { n: number };
    expect(snapshots.n).toBe(0);
  });

  test("Read of source code stores the file text, not the tool_response JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/brain/hook-ingest/post-tool",
      remoteAddress: "127.0.0.1",
      payload: {
        orgId: ORG,
        projectId: PROJ,
        sessionId: "sess_hook_code",
        toolName: "Read",
        toolInput: { file_path: "/repo/src/tapir.ts" },
        toolResult: JSON.stringify({ type: "text", file: { filePath: "/repo/src/tapir.ts", content: "export const tapir = 1;" } }),
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await until(
      () =>
        activeDbFor(ORG)
          .prepare("SELECT content FROM artifacts WHERE kind = 'code/file_snapshot' AND session_id = 'sess_hook_code'")
          .get() as { content: Buffer } | undefined,
    );
    expect(row.content.toString("utf8")).toBe("export const tapir = 1;");
  });
});

function findKind(kind: string, needle: string) {
  return activeDbFor(ORG)
    .prepare(
      `SELECT a.hash, a.session_id, a.kind_specific_meta FROM artifacts a
         JOIN artifacts_fts_src f ON f.hash = a.hash
        WHERE a.kind = ? AND f.text LIKE ?`,
    )
    .get(kind, `%${needle}%`) as { hash: string; session_id: string | null; kind_specific_meta: string } | undefined;
}

describe("POST /api/brain/capture-url", () => {
  test("full mode stores a searchable document/web_fetch linked to the reference", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/brain/capture-url",
      headers: auth(),
      payload: { url: `${fixtureBase}/article`, org_id: ORG, project_id: PROJ, mode: "full" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.fetch_error).toBeNull();
    expect(artifactRow(body.fetch_hash)?.kind).toBe("document/web_fetch");
    expect((await searchText("pangolin")).results.map((r) => r.hash)).toContain(body.fetch_hash);
    const edge = activeDbFor(ORG)
      .prepare("SELECT relation FROM artifact_edges WHERE from_hash = ? AND to_hash = ?")
      .get(body.fetch_hash, body.link_hash) as { relation: string } | undefined;
    expect(edge?.relation).toBe("link_resolved_to_fetch");
  });

  test("a PDF URL goes through the PDF path: source + searchable pages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/brain/capture-url",
      headers: auth(),
      payload: { url: `${fixtureBase}/papers/axolotl.pdf`, org_id: ORG, project_id: PROJ, mode: "full" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.fetch_error).toBeNull();
    expect(body.pages).toHaveLength(2);
    const source = artifactRow(body.fetch_hash);
    expect(source?.kind).toBe("document/pdf");
    expect(JSON.parse(source!.kind_specific_meta)).toMatchObject({
      filename: "axolotl.pdf",
      source: "url_capture",
    });
    expect((await searchText("regeneration")).results.map((r) => r.hash)).toContain(body.pages[0].hash);
  });

  test("a key bound to another org cannot capture into this one (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/brain/capture-url",
      headers: auth(KEY_WYOBI),
      payload: { url: `${fixtureBase}/article`, org_id: ORG, project_id: PROJ, mode: "ref" },
    });
    expect(res.statusCode).toBe(403);
  });
});
