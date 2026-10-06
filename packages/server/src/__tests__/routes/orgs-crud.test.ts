import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabase } from "../../db/schema.js";
import { registerOrgRoutes } from "../../routes/orgs.js";
import { registerAuth } from "../../auth.js";

const ADMIN_KEY = "admin-key-0123456789abcdef";
const ENV_KEYS = ["NOSLEEP_API_KEY_PERSONAL", "NOSLEEP_API_KEY_CLIENT_X"] as const;

interface OrgJson {
  id: string;
  name: string;
  slug: string;
  color: string;
  apiKeyEnv: string;
}

describe("org CRUD routes", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let dataDir: string;
  const prevDataDir = process.env.NOSLEEP_DATA_DIR;

  async function build(withAuth: boolean): Promise<void> {
    app = Fastify({ logger: false });
    if (withAuth) {
      registerAuth(app, ADMIN_KEY, () => db.prepare(`SELECT id, slug FROM organizations`).all() as Array<{ id: string; slug: string }>);
    }
    registerOrgRoutes(app, db);
    await app.ready();
  }

  function req(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, key = ADMIN_KEY) {
    return app.inject({ method, url, payload: payload as object, headers: { "x-api-key": key }, remoteAddress: "10.0.0.5" });
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-orgs-crud-"));
    process.env.NOSLEEP_DATA_DIR = dataDir;
    db = initializeDatabase(":memory:");
  });

  afterEach(async () => {
    await app?.close();
    db.close();
    for (const k of ENV_KEYS) delete process.env[k];
    if (prevDataDir === undefined) delete process.env.NOSLEEP_DATA_DIR;
    else process.env.NOSLEEP_DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates an org with a slug derived from the name and a palette colour", async () => {
    await build(false);
    const res = await req("POST", "/api/orgs", { name: "Client X" });
    expect(res.statusCode).toBe(201);
    const org = res.json().data as OrgJson;
    expect(org).toMatchObject({ id: "org_client-x", name: "Client X", slug: "client-x", apiKeyEnv: "NOSLEEP_API_KEY_CLIENT_X" });
    expect(org.color).toMatch(/^#[0-9a-f]{6}$/);

    const list = (await req("GET", "/api/orgs")).json().data as OrgJson[];
    expect(list.map((o) => o.id)).toEqual(["org_personal", "org_client-x"]);
  });

  it("rejects invalid input and duplicate slugs", async () => {
    await build(false);
    expect((await req("POST", "/api/orgs", { name: "" })).statusCode).toBe(400);
    expect((await req("POST", "/api/orgs", { name: "Bad", slug: "Bad Slug!" })).statusCode).toBe(400);
    expect((await req("POST", "/api/orgs", { name: "Bad", color: "red" })).statusCode).toBe(400);
    const dup = await req("POST", "/api/orgs", { name: "Another Personal", slug: "personal" });
    expect(dup.statusCode).toBe(409);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM organizations`).get()).toEqual({ n: 1 });
  });

  it("renames and recolours without changing id or slug", async () => {
    await build(false);
    await req("POST", "/api/orgs", { name: "Side", slug: "side" });
    const res = await req("PATCH", "/api/orgs/org_side", { name: "Side Hustle", color: "#123ABC" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: "org_side", slug: "side", name: "Side Hustle", color: "#123abc" });
    expect((await req("PATCH", "/api/orgs/org_nope", { name: "X" })).statusCode).toBe(404);
    expect((await req("PATCH", "/api/orgs/org_side", {})).statusCode).toBe(400);
  });

  it("deletes an empty org but refuses one with data (409) and the default org", async () => {
    await build(false);
    await req("POST", "/api/orgs", { name: "Empty", slug: "empty" });
    await req("POST", "/api/orgs", { name: "Busy", slug: "busy" });
    db.prepare(`INSERT INTO accounts (id, org_id, name, type) VALUES ('acc_busy', 'org_busy', 'a', 'max')`).run();
    db.prepare(`INSERT INTO alerts (org_id, type, message) VALUES ('org_busy', 'info', 'm')`).run();

    const busy = await req("DELETE", "/api/orgs/org_busy");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/accounts: 1/);
    expect(busy.json().error).toMatch(/alerts: 1/);
    expect((await req("DELETE", "/api/orgs/org_personal")).statusCode).toBe(409);
    expect((await req("DELETE", "/api/orgs/org_ghost")).statusCode).toBe(404);

    const ok = await req("DELETE", "/api/orgs/org_empty");
    expect(ok.statusCode).toBe(200);
    const ids = (db.prepare(`SELECT id FROM organizations ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["org_busy", "org_personal"]);
  });

  it("refuses to delete an org that still has brain data", async () => {
    await build(false);
    await req("POST", "/api/orgs", { name: "Brainy", slug: "brainy" });
    const { activeDbFor, closeAllBrainDbs } = await import("../../brain/storage/active-db.js");
    const bdb = activeDbFor("org_brainy");
    const cols = (bdb.prepare(`PRAGMA table_info(thoughts)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
    const required = cols.filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name);
    bdb.prepare(`INSERT INTO thoughts (${required.join(", ")}) VALUES (${required.map(() => "?").join(", ")})`)
      .run(...required.map((c) => (c === "id" ? "t1" : c.endsWith("_at") ? "2026-01-01T00:00:00Z" : "x")));
    closeAllBrainDbs();

    const res = await req("DELETE", "/api/orgs/org_brainy");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/brain data/);
  });

  it("honours NOSLEEP_API_KEY_<SLUG> for an org created after boot", async () => {
    const clientKey = "client-x-key-0123456789";
    process.env.NOSLEEP_API_KEY_CLIENT_X = clientKey;
    await build(true);

    // Before the org exists the key means nothing.
    expect((await req("GET", "/api/orgs", undefined, clientKey)).statusCode).toBe(401);

    expect((await req("POST", "/api/orgs", { name: "Client X" })).statusCode).toBe(201);

    // Now it authenticates and is bound to the new org.
    expect((await req("GET", "/api/orgs", undefined, clientKey)).statusCode).toBe(200);
    // Bound keys can edit their own org but cannot create or delete orgs, or edit others.
    expect((await req("PATCH", "/api/orgs/org_client-x", { name: "Client X Ltd" }, clientKey)).statusCode).toBe(200);
    expect((await req("PATCH", "/api/orgs/org_personal", { name: "Mine" }, clientKey)).statusCode).toBe(403);
    expect((await req("POST", "/api/orgs", { name: "Sneaky" }, clientKey)).statusCode).toBe(403);
    expect((await req("DELETE", "/api/orgs/org_client-x", undefined, clientKey)).statusCode).toBe(403);
    // Unknown keys are still refused.
    expect((await req("GET", "/api/orgs", undefined, "wrong-key-0123456789")).statusCode).toBe(401);
  });
});
