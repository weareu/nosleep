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

  it("a wyobi-bound session storing with orgId=org_personal writes to WYOBI, not personal", async () => {
    const actions: Action[] = buildActions({
      db,
      envOrgId: "org_wyobi", // trusted binding
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    await dispatch(actions, "memory_store", undefined, {
      orgId: "org_personal", // spoof attempt
      category: "fact",
      key: "spoofed",
      value: "should land in wyobi",
    });

    const inWyobi = db.prepare(`SELECT value FROM memory WHERE key='spoofed' AND org_id='org_wyobi'`).get() as { value: string } | undefined;
    const inPersonal = db.prepare(`SELECT value FROM memory WHERE key='spoofed' AND org_id='org_personal'`).get();

    expect(inWyobi?.value).toBe("should land in wyobi");
    expect(inPersonal).toBeUndefined(); // the spoofed org was ignored
  });

  it("a wyobi-bound session searching with orgId=org_personal sees only WYOBI memory", async () => {
    const actions: Action[] = buildActions({
      db,
      envOrgId: "org_wyobi",
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    // seed has personal mem 'use-sqlite' and wyobi mem 'deploy-target'.
    const result = await dispatch(actions, "memory_search", undefined, {
      orgId: "org_personal", // spoof — must be ignored
      query: "",
    });

    expect(result.text).toContain("deploy-target"); // wyobi's
    expect(result.text).not.toContain("use-sqlite"); // personal's — must NOT leak
  });

  it("a wyobi-bound session cannot delete a personal memory by id", async () => {
    const personalMem = db.prepare(`SELECT id FROM memory WHERE org_id='org_personal' LIMIT 1`).get() as { id: number };
    const actions: Action[] = buildActions({
      db,
      envOrgId: "org_wyobi",
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });

    await dispatch(actions, "memory_delete", undefined, {
      orgId: "org_personal", // spoof
      id: personalMem.id,
    });

    const stillThere = db.prepare(`SELECT 1 FROM memory WHERE id=?`).get(personalMem.id);
    expect(stillThere).toBeDefined(); // delete was scoped to wyobi, personal row survives
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
