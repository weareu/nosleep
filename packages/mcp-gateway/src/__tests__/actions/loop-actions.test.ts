import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

describe("loop control actions (AI drives its own loop)", () => {
  let db: Database.Database;
  let actions: Action[];
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    const seed = seedGatewayData(db);
    projectId = seed.projectPersonalId;
    actions = buildActions({ db, serverUrl: "http://localhost:3777", apiKey: "k" });
  });
  afterEach(() => db.close());

  it("loop_set configures content mode and loop_status reflects it", async () => {
    const set = await dispatch(actions, "loop_set", undefined, {
      projectId, enabled: true, mode: "content", content: "Drive the next task.", intervalMinutes: 15,
    });
    expect(set.text).toMatch(/ENABLED.*content.*interval=15m/);

    const status = await dispatch(actions, "loop_status", undefined, { projectId });
    expect(status.text).toMatch(/VERDICT:/);
    expect(status.text).toMatch(/mode=content/);
    expect(status.text).toMatch(/Drive the next task/);
  });

  it("loop_set branch mode requires a valid nodeId", async () => {
    const noNode = await dispatch(actions, "loop_set", undefined, { projectId, mode: "branch" });
    expect(noNode.text).toMatch(/needs nodeId/i);

    const badNode = await dispatch(actions, "loop_set", undefined, { projectId, mode: "branch", nodeId: "does-not-exist" });
    expect(badNode.text).toMatch(/No strategy node/i);
  });

  it("loop_stop disables the loop", async () => {
    await dispatch(actions, "loop_set", undefined, { projectId, enabled: true, mode: "continue" });
    const stop = await dispatch(actions, "loop_stop", undefined, { projectId });
    expect(stop.text).toMatch(/disabled/i);
    const status = await dispatch(actions, "loop_status", undefined, { projectId });
    expect(status.text).toMatch(/disabled/);
  });

  it("rejects an invalid mode", async () => {
    const r = await dispatch(actions, "loop_set", undefined, { projectId, mode: "bogus" });
    expect(r.text).toMatch(/mode must be one of/i);
  });
});
