/**
 * POST /api/brain/search must return distilled THOUGHTS alongside archive
 * artifacts — merged into one ranking, typed by layer, honouring thought
 * visibility and org/project isolation. Regression: the orchestrator was
 * archive-only, so the web/mobile Search screens never showed thoughts and
 * semantic thought hits were silently dropped ("0 of 25 candidates").
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-unified-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1"; // never spawn the real model

import Fastify, { type FastifyInstance } from "fastify";
import { ingest } from "../ingest/pipeline.js";
import { captureThought } from "../thoughts/capture.js";
import { registerBrainSearchRoutes } from "../routes/search.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { isVecLoaded } from "../storage/vec-loader.js";
import { setEmbedProvider, EMBED_DIM, type EmbedProvider } from "../extractors/embed-provider.js";
import { waitForExtractorQueue } from "../extractors/worker.js";
import { ingestFile } from "../ingest/file-ingest.js";

const ORG = "org_unified_test";
const OTHER_ORG = "org_unified_other";
const PROJ = "proj_u1";
const PROJ2 = "proj_u2";

class FakeEmbedProvider implements EmbedProvider {
  readonly name = "fake-test";
  readonly dim = EMBED_DIM;
  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(EMBED_DIM);
    for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      const h = createHash("sha256").update(tok).digest();
      for (let i = 0; i < h.length; i++) out[(i * 13) % EMBED_DIM] += (h[i] - 128) / 128;
    }
    let norm = 0;
    for (let i = 0; i < EMBED_DIM; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBED_DIM; i++) out[i] /= norm;
    return out;
  }
}

let app: FastifyInstance;

interface Hit {
  hash: string;
  layer: "archive" | "thoughts";
  kind: string;
  snippet: string;
  thought?: { id: string; thought_type: string | null; visibility: string };
}
interface Resp {
  results: Hit[];
  total_candidates: number;
  layers_returned: { archive: number; thoughts: number };
}

async function post(body: Record<string, unknown>): Promise<Resp> {
  const res = await app.inject({ method: "POST", url: "/api/brain/search", payload: body });
  expect(res.statusCode).toBe(200);
  return res.json() as Resp;
}

function seedArtifact(content: string, org = ORG, project = PROJ) {
  return ingest({
    kind: "knowledge/note",
    content,
    content_type: "text/plain",
    org_id: org,
    project_id: project,
    session_id: "sess_u",
    turn_ord: 1,
    origin: { tool: "claude-code", actor: "test" },
    schema_version: 1,
  });
}

let activeThoughtId = "";
let archivedThoughtId = "";

beforeAll(async () => {
  setEmbedProvider(new FakeEmbedProvider());
  activeDbFor(ORG);
  activeDbFor(OTHER_ORG);
  seedArtifact("zebracrossing artifact note about the zebracrossing rollout");
  activeThoughtId = captureThought({
    content: "Decided the zebracrossing rollout ships behind a flag",
    org_id: ORG,
    project_id: PROJ,
    source_kind: "mcp_capture",
    thought_type_hint: "decision",
  }).id;
  archivedThoughtId = captureThought({
    content: "Old zebracrossing idea that was soft-archived",
    org_id: ORG,
    project_id: PROJ,
    source_kind: "mcp_capture",
  }).id;
  activeDbFor(ORG)
    .prepare(`UPDATE thoughts SET visibility = 'archived' WHERE id = ?`)
    .run(archivedThoughtId);
  // Same term in another project and another org — must never leak.
  captureThought({ content: "zebracrossing in project two", org_id: ORG, project_id: PROJ2, source_kind: "mcp_capture" });
  captureThought({ content: "zebracrossing secret other org", org_id: OTHER_ORG, project_id: PROJ, source_kind: "mcp_capture" });
  await waitForExtractorQueue();

  app = Fastify();
  registerBrainSearchRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("unified brain search (archive + thoughts)", () => {
  test("hybrid text search returns both layers, typed", async () => {
    const r = await post({ org_id: ORG, project_id: PROJ, text: { query: "zebracrossing", mode: "lexical" } });
    const thoughts = r.results.filter((h) => h.layer === "thoughts");
    const archive = r.results.filter((h) => h.layer === "archive");
    expect(archive.length).toBe(1);
    expect(thoughts.map((t) => t.hash)).toEqual([activeThoughtId]);
    expect(thoughts[0].thought?.id).toBe(activeThoughtId);
    expect(thoughts[0].thought?.thought_type).toBe("decision");
    expect(thoughts[0].kind).toBe("thought/decision");
    expect(thoughts[0].snippet).toContain("behind a flag");
    expect(r.layers_returned).toEqual({ archive: 1, thoughts: 1 });
  });

  test("archived thoughts only with include_archived", async () => {
    const r = await post({
      org_id: ORG, project_id: PROJ, include_archived: true,
      text: { query: "zebracrossing", mode: "lexical" },
    });
    const ids = r.results.filter((h) => h.layer === "thoughts").map((h) => h.hash).sort();
    expect(ids).toEqual([activeThoughtId, archivedThoughtId].sort());
  });

  test("never leaks other projects or other orgs", async () => {
    const r = await post({ org_id: ORG, project_id: PROJ, text: { query: "zebracrossing", mode: "lexical" } });
    expect(r.results.some((h) => h.snippet.includes("project two"))).toBe(false);
    expect(r.results.some((h) => h.snippet.includes("other org"))).toBe(false);
    const org = await post({ org_id: ORG, project_id: PROJ, scope: "org", text: { query: "zebracrossing", mode: "lexical" } });
    expect(org.results.some((h) => h.snippet.includes("project two"))).toBe(true);
    expect(org.results.some((h) => h.snippet.includes("other org"))).toBe(false);
  });

  test("layers=['archive'] and archive-only facets exclude thoughts", async () => {
    const a = await post({ org_id: ORG, project_id: PROJ, layers: ["archive"], text: { query: "zebracrossing", mode: "lexical" } });
    expect(a.results.every((h) => h.layer === "archive")).toBe(true);
    const f = await post({
      org_id: ORG, project_id: PROJ, facets: { kind_prefix: ["knowledge/"] },
      text: { query: "zebracrossing", mode: "lexical" },
    });
    expect(f.results.every((h) => h.layer === "archive")).toBe(true);
    const t = await post({ org_id: ORG, project_id: PROJ, layers: ["thoughts"], text: { query: "zebracrossing", mode: "lexical" } });
    expect(t.results.map((h) => h.layer)).toEqual(["thoughts"]);
  });

  test.skipIf(!isVecLoaded(activeDbFor(ORG)))(
    "semantic thought hits hydrate instead of vanishing",
    async () => {
      const r = await post({
        org_id: ORG, project_id: PROJ, layers: ["thoughts"],
        text: { query: "zebracrossing rollout flag", mode: "semantic" },
      });
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results.every((h) => h.layer === "thoughts")).toBe(true);
      // Every candidate the retrievers produced that is in scope is shown;
      // archived/merged thoughts never appear.
      expect(r.results.some((h) => h.hash === archivedThoughtId)).toBe(false);
    },
  );
});

describe("cross-project dedup: identical content is findable from every ingesting project", () => {
  test("second project's upload is a dedup hit, yet its search finds it (one blob)", async () => {
    const bytes = Buffer.from("quokkaharbour runbook: restart the pump twice before noon");
    const first = await ingestFile({
      filename: "runbook.md", bytes, org_id: ORG, project_id: PROJ,
      origin: { tool: "web-upload", actor: "test" }, distill: false,
    });
    const second = await ingestFile({
      filename: "runbook.md", bytes, org_id: ORG, project_id: PROJ2,
      origin: { tool: "web-upload", actor: "test" }, distill: false,
    });
    expect(second.duplicate).toBe(true);
    expect(second.hash).toBe(first.hash);
    const blobs = activeDbFor(ORG).prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE hash = ?`).get(first.hash) as { n: number };
    expect(blobs.n).toBe(1);

    for (const project of [PROJ, PROJ2]) {
      const r = await post({ org_id: ORG, project_id: project, layers: ["archive"], text: { query: "quokkaharbour", mode: "lexical" } });
      expect(r.results.map((h) => h.hash)).toEqual([first.hash]);
      expect((r.results[0] as Hit & { project_id: string }).project_id).toBe(project);
      // Pure-filter listing (Archive / Timeline pages) too.
      const list = await post({ org_id: ORG, project_id: project, layers: ["archive"], limit: 200 });
      expect(list.results.some((h) => h.hash === first.hash)).toBe(true);
    }

    // A project that never ingested it still can't see it.
    const other = await post({ org_id: ORG, project_id: "proj_never", layers: ["archive"], text: { query: "quokkaharbour", mode: "lexical" } });
    expect(other.results).toEqual([]);
  });
});
