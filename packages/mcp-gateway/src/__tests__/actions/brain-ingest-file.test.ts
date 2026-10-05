/**
 * brain_ingest_file end to end: gateway action → the REAL
 * POST /api/brain/ingest/file route (same path as web upload) → searchable
 * via the gateway's brain_search. Also pins the apiCall fix: brain routes
 * reply with bare objects (no { success, data } envelope), which every
 * brain_* action used to read as `undefined`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-gw-ingest-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";
process.env.NOSLEEP_BRAIN_EMBED_INLINE = "0";

import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";
import { registerBrainIngestRoutes } from "../../../../server/src/brain/routes/ingest.js";
import { registerBrainSearchRoutes } from "../../../../server/src/brain/routes/search.js";
import { closeAllBrainDbs } from "../../../../server/src/brain/storage/active-db.js";

let app: FastifyInstance;
let db: Database.Database;
let actions: Action[];
let projectDir: string;
let outsideDir: string;

beforeAll(async () => {
  app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  registerBrainIngestRoutes(app);
  registerBrainSearchRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-gw-proj-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-gw-outside-"));
  fs.mkdirSync(path.join(projectDir, "docs"));
  fs.writeFileSync(path.join(projectDir, "docs", "plan.md"), "# Plan\n\nThe wombatgateway rollout happens in three waves.\n");
  fs.writeFileSync(path.join(projectDir, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(outsideDir, "secret.md"), "not yours\n");

  db = createTestDb();
  seedGatewayData(db);
  db.prepare(`UPDATE projects SET path = ? WHERE id = 'proj_personal_1'`).run(projectDir);
  actions = buildActions({ db, serverUrl: `http://127.0.0.1:${port}`, apiKey: "test-key" });
});

afterAll(async () => {
  await app.close();
  db.close();
  closeAllBrainDbs();
  for (const d of [tmpDataDir, projectDir, outsideDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe("brain_ingest_file", () => {
  it("uploads a project file through the real route and it becomes searchable", async () => {
    const r = await dispatch(actions, "brain_ingest_file", undefined, {
      projectId: "proj_personal_1",
      path: "docs/plan.md",
    });
    expect(r.text).toMatch(/^Ingested: plan\.md → document\/markdown/);
    expect(r.text).toMatch(/hash: [0-9a-f]{64}/);

    const again = await dispatch(actions, "brain_ingest_file", undefined, {
      projectId: "proj_personal_1",
      path: path.join(projectDir, "docs", "plan.md"),
    });
    expect(again.text).toContain("Already in the brain");

    const found = await dispatch(actions, "brain_search", undefined, {
      projectId: "proj_personal_1",
      query: "wombatgateway",
    });
    expect(found.text).toContain("wombatgateway rollout");
  });

  it("accepts inline base64 + filename", async () => {
    const r = await dispatch(actions, "brain_ingest_file", undefined, {
      projectId: "proj_personal_1",
      contentBase64: Buffer.from("inline note about kiwiharbor").toString("base64"),
      filename: "note.txt",
    });
    expect(r.text).toMatch(/^Ingested: note\.txt/);
  });

  it("refuses paths outside the project directory, dotfiles and traversal", async () => {
    for (const bad of [path.join(outsideDir, "secret.md"), "../" + path.basename(outsideDir) + "/secret.md", ".env"]) {
      const r = await dispatch(actions, "brain_ingest_file", undefined, { projectId: "proj_personal_1", path: bad });
      expect(r.text).toMatch(/^Ingest refused:/);
    }
  });

  it("enforces the 10 MB cap before sending", async () => {
    const big = path.join(projectDir, "big.txt");
    fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    const r = await dispatch(actions, "brain_ingest_file", undefined, { projectId: "proj_personal_1", path: "big.txt" });
    expect(r.text).toMatch(/^Ingest refused: .*10 MB/);
  });

  it("surfaces the route's structured error message (unsupported type)", async () => {
    const r = await dispatch(actions, "brain_ingest_file", undefined, {
      projectId: "proj_personal_1",
      contentBase64: Buffer.from("MZ").toString("base64"),
      filename: "tool.exe",
    });
    expect(r.text).toMatch(/^Ingest failed: .+/);
    expect(r.text).not.toContain("[object Object]");
  });
});
