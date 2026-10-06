import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

describe("dispatch", () => {
  let db: Database.Database;
  let actions: Action[];

  beforeEach(() => {
    db = createTestDb();
    seedGatewayData(db);
    actions = buildActions({
      db,
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });
  });

  afterEach(() => {
    db.close();
  });

  it('action="" returns help with all action names', async () => {
    const result = await dispatch(actions, "");
    expect(result.text).toContain("# NoSleep Actions");
    expect(result.text).toContain("project_list");
    expect(result.text).toContain("memory_store");
    expect(result.text).toContain("alert_list");
    expect(result.text).toContain("strategy_tree");
  });

  it('action="help" returns help', async () => {
    const result = await dispatch(actions, "help");
    expect(result.text).toContain("# NoSleep Actions");
    expect(result.text).toContain("org_list");
  });

  it('action="search" with query="strategy" finds strategy actions', async () => {
    const result = await dispatch(actions, "search", "strategy");
    expect(result.text).toContain("strategy_tree");
    expect(result.text).toContain("strategy_node");
    expect(result.text).toContain("strategy_update");
    expect(result.text).toContain("strategy_progress");
    expect(result.text).toContain("strategy_add");
    expect(result.text).toContain("strategy_next");
  });

  it('action="search" with no query returns prompt', async () => {
    const result = await dispatch(actions, "search");
    expect(result.text).toBe("Pass query to search.");
  });

  it("unknown action returns fuzzy suggestions when partial match exists", async () => {
    const result = await dispatch(actions, "project");
    expect(result.text).toContain("not found");
    expect(result.text).toContain("Did you mean");
    expect(result.text).toContain("project_list");
  });

  it("completely unknown action returns generic error", async () => {
    const result = await dispatch(actions, "xyzzy_nonexistent");
    expect(result.text).toContain('Unknown action "xyzzy_nonexistent"');
    expect(result.text).toContain("help");
  });

  it("partial name match works for search", async () => {
    const result = await dispatch(actions, "search", "memory");
    expect(result.text).toContain("memory_store");
    expect(result.text).toContain("memory_search");
    expect(result.text).toContain("memory_list");
    expect(result.text).toContain("memory_delete");
  });

  it('action="list" is treated as help', async () => {
    const result = await dispatch(actions, "list");
    expect(result.text).toContain("# NoSleep Actions");
  });

  it('action="find" works as alias for search', async () => {
    const result = await dispatch(actions, "find", "alert");
    expect(result.text).toContain("alert_list");
    expect(result.text).toContain("alert_ack");
  });

  it("action name is case-insensitive", async () => {
    const result = await dispatch(actions, "HELP");
    expect(result.text).toContain("# NoSleep Actions");
  });

  it("action name is trimmed", async () => {
    const result = await dispatch(actions, "  help  ");
    expect(result.text).toContain("# NoSleep Actions");
  });
});
