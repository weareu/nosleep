import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

/**
 * Org-isolation enforcement. When the gateway is bound to a TRUSTED org
 * (envOrgId, derived by the HTTP MCP endpoint from the authenticated
 * session/project header), a caller-supplied orgId MUST NOT be able to read,
 * write, or delete another org's memory — even if it names a different org.
 */
describe("memory org-isolation (trusted env org is authoritative)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedGatewayData(db);
  });

  afterEach(() => db.close());

  it("a work-bound session storing with orgId=org_personal writes to WORK, not personal", async () => {
    const actions: Action[] = buildActions({
      db,
      envOrgId: "org_work", // trusted binding
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    await dispatch(actions, "memory_store", undefined, {
      orgId: "org_personal", // spoof attempt
      category: "fact",
      key: "spoofed",
      value: "should land in work",
    });

    const inWork = db.prepare(`SELECT value FROM memory WHERE key='spoofed' AND org_id='org_work'`).get() as { value: string } | undefined;
    const inPersonal = db.prepare(`SELECT value FROM memory WHERE key='spoofed' AND org_id='org_personal'`).get();

    expect(inWork?.value).toBe("should land in work");
    expect(inPersonal).toBeUndefined(); // the spoofed org was ignored
  });

  it("a work-bound session searching with orgId=org_personal sees only WORK memory", async () => {
    const actions: Action[] = buildActions({
      db,
      envOrgId: "org_work",
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    // seed has personal mem 'use-sqlite' and work mem 'deploy-target'.
    const result = await dispatch(actions, "memory_search", undefined, {
      orgId: "org_personal", // spoof — must be ignored
      query: "",
    });

    expect(result.text).toContain("deploy-target"); // work's
    expect(result.text).not.toContain("use-sqlite"); // personal's — must NOT leak
  });

  it("a work-bound session cannot delete a personal memory by id", async () => {
    const personalMem = db.prepare(`SELECT id FROM memory WHERE org_id='org_personal' LIMIT 1`).get() as { id: number };
    const actions: Action[] = buildActions({
      db,
      envOrgId: "org_work",
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    await dispatch(actions, "memory_delete", undefined, {
      orgId: "org_personal", // spoof
      id: personalMem.id,
    });

    const stillThere = db.prepare(`SELECT 1 FROM memory WHERE id=?`).get(personalMem.id);
    expect(stillThere).toBeDefined(); // delete was scoped to work, personal row survives
  });

  it("without a trusted binding, caller orgId is still honored (backward compatible)", async () => {
    const actions: Action[] = buildActions({
      db, // no envOrgId
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    await dispatch(actions, "memory_store", undefined, {
      orgId: "org_personal",
      category: "fact",
      key: "unbound",
      value: "v",
    });

    const row = db.prepare(`SELECT org_id FROM memory WHERE key='unbound'`).get() as { org_id: string };
    expect(row.org_id).toBe("org_personal");
  });
});
