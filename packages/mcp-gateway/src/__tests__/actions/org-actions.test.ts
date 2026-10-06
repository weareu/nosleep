import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb } from "../helpers/db.js";

describe("org actions", () => {
  let db: Database.Database;
  let actions: Action[];

  beforeEach(() => {
    db = createTestDb();
    actions = buildActions({ db, serverUrl: "http://localhost:3777", apiKey: "test-key" });
  });

  afterEach(() => {
    db.close();
  });

  it("org_list shows every org with its API key env name", async () => {
    const { text } = await dispatch(actions, "org_list");
    expect(text).toContain("id:org_personal");
    expect(text).toContain("id:org_work");
    expect(text).toContain("id:org_side");
    expect(text).toContain("NOSLEEP_API_KEY_WORK");
  });

  it("org_create adds an org that other actions resolve immediately", async () => {
    const created = await dispatch(actions, "org_create", undefined, { name: "Client X", color: "#112233" });
    expect(created.text).toContain('Created org "Client X" (id: org_client-x, slug: client-x, color: #112233)');
    expect(created.text).toContain("NOSLEEP_API_KEY_CLIENT_X");

    // Same action set (built before the org existed) resolves it by id and slug.
    expect((await dispatch(actions, "project_list", undefined, { orgId: "org_client-x" })).text).toBe("No projects in Client X.");
    expect((await dispatch(actions, "project_list", undefined, { orgId: "client-x" })).text).toBe("No projects in Client X.");
  });

  it("org_create rejects invalid and duplicate input", async () => {
    expect((await dispatch(actions, "org_create", undefined, { name: "" })).text).toMatch(/^Failed: name/);
    expect((await dispatch(actions, "org_create", undefined, { name: "W", slug: "work" })).text).toMatch(/already exists/);
    expect((await dispatch(actions, "org_create", undefined, { name: "Bad", slug: "-bad-" })).text).toMatch(/^Failed: slug/);
  });

  it("a session bound to an org cannot create orgs", async () => {
    const bound = buildActions({ db, envOrgId: "org_work", serverUrl: "http://localhost:3777", apiKey: "k" });
    const { text } = await dispatch(bound, "org_create", undefined, { name: "Sneaky" });
    expect(text).toMatch(/^Refused/);
    expect(db.prepare(`SELECT 1 FROM organizations WHERE slug = 'sneaky'`).get()).toBeUndefined();
  });
});
