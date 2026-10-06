/**
 * mcp-brain `ingest_file` client path end to end against the REAL server
 * routes: project lookup (GET /api/projects/:id) for the path sandbox, then
 * POST /api/brain/ingest/file (same route as web upload), then the document
 * is found by POST /api/brain/search.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-mcpbrain-ingest-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";
process.env.NOSLEEP_BRAIN_EMBED_INLINE = "0";

import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { initializeDatabase } from "../../../server/src/db/schema.js";
import { seedTestOrgs } from "../../../server/src/__tests__/helpers/db.js";
import { registerProjectRoutes } from "../../../server/src/routes/projects.js";
import { registerBrainIngestRoutes } from "../../../server/src/brain/routes/ingest.js";
import { registerBrainSearchRoutes } from "../../../server/src/brain/routes/search.js";
import { closeAllBrainDbs } from "../../../server/src/brain/storage/active-db.js";

type Client = typeof import("../client.js");

let app: FastifyInstance;
let db: Database.Database;
let client: Client;
let projectDir: string;

beforeAll(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-mcpbrain-proj-"));
  fs.writeFileSync(path.join(projectDir, "notes.md"), "Decision log: the emuharbor migration is frozen until Q3.\n");

  db = initializeDatabase(":memory:");
  seedTestOrgs(db);
  db.prepare(`INSERT INTO accounts (id, org_id, name, type, daily_token_limit) VALUES ('acc_p', 'org_personal', 'P', 'pro', 1)`).run();
  db.prepare(`INSERT INTO projects (id, org_id, name, path, account_id, token_budget) VALUES ('proj_p', 'org_personal', 'P', ?, 'acc_p', 1)`).run(projectDir);
  db.prepare(`INSERT INTO accounts (id, org_id, name, type, daily_token_limit) VALUES ('acc_w', 'org_work', 'W', 'pro', 1)`).run();
  db.prepare(`INSERT INTO projects (id, org_id, name, path, account_id, token_budget) VALUES ('proj_w', 'org_work', 'W', ?, 'acc_w', 1)`).run(projectDir);

  app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  registerProjectRoutes(app, db);
  registerBrainIngestRoutes(app);
  registerBrainSearchRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  process.env.NOSLEEP_SERVER_URL = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  client = await import("../client.js");
});

afterAll(async () => {
  await app.close();
  db.close();
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("mcp-brain ingest_file", () => {
  it("ingests a project-relative path and the document is searchable", async () => {
    const res = await client.ingestFileApi({ org_id: "org_personal", project_id: "proj_p", path: "notes.md" });
    expect(res.duplicate).toBe(false);
    expect(res.filename).toBe("notes.md");
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);

    const found = await client.searchArchive({
      org_id: "org_personal",
      project_id: "proj_p",
      layers: ["archive"],
      text: { query: "emuharbor", mode: "lexical" },
    });
    expect(found.results.map((r) => r.hash)).toContain(res.hash);
  });

  it("rejects a path outside the project and a project from another org", async () => {
    await expect(
      client.ingestFileApi({ org_id: "org_personal", project_id: "proj_p", path: "/etc/hosts" }),
    ).rejects.toThrow(/outside the project directory/);
    await expect(
      client.ingestFileApi({ org_id: "org_personal", project_id: "proj_w", path: "notes.md" }),
    ).rejects.toThrow(/not in org/);
  });

  it("rejects inline content over 10 MB before uploading", async () => {
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 3, 1).toString("base64");
    await expect(
      client.ingestFileApi({ org_id: "org_personal", project_id: "proj_p", content_base64: tooBig, filename: "x.txt" }),
    ).rejects.toThrow(/10 MB/);
  });
});
