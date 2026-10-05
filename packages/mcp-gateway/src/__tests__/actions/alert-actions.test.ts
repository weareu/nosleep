import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

describe("alert actions", () => {
  let db: Database.Database;
  let actions: Action[];
  let seed: ReturnType<typeof seedGatewayData>;

  beforeEach(() => {
    db = createTestDb();
    seed = seedGatewayData(db);
    actions = buildActions({
      db,
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("alert_list", () => {
    it("returns unacknowledged alerts for org", async () => {
      const result = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_personal",
      });
      expect(result.text).toContain("# Alerts [Personal]");
      expect(result.text).toContain("Session drifted from goal");
      expect(result.text).toContain("Token budget exceeded 90%");
    });

    it("does not show alerts from other orgs", async () => {
      const result = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_personal",
      });
      expect(result.text).not.toContain("Build failed in work project");
    });

    it("shows wyobi alerts only for wyobi org", async () => {
      const result = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_wyobi",
      });
      expect(result.text).toContain("Build failed in work project");
      expect(result.text).not.toContain("Session drifted");
    });

    it("returns empty message when no alerts", async () => {
      const result = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_apply",
      });
      expect(result.text).toBe("No alerts.");
    });

    it("requires orgId", async () => {
      const result = await dispatch(actions, "alert_list", undefined, {});
      expect(result.text).toContain("Pass orgId");
    });

    it("respects limit parameter", async () => {
      const result = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_personal",
        limit: 1,
      });
      // Should contain exactly one alert entry (the most recent one)
      expect(result.text).toContain("# Alerts [Personal]");
      // Count the "!" markers for unacked alerts
      const alertLines = result.text.split("\n").filter(l => l.startsWith("!"));
      expect(alertLines.length).toBe(1);
    });
  });

  describe("alert_ack", () => {
    it("acknowledges a single alert by id", async () => {
      const result = await dispatch(actions, "alert_ack", undefined, {
        orgId: "org_personal",
        alertId: seed.alertId1,
      });
      expect(result.text).toContain(`Alert ${seed.alertId1} acknowledged`);

      // Verify in DB
      const row = db.prepare(`SELECT acknowledged FROM alerts WHERE id = ?`).get(seed.alertId1) as { acknowledged: number };
      expect(row.acknowledged).toBe(1);

      // Other alert should still be unacked
      const other = db.prepare(`SELECT acknowledged FROM alerts WHERE id = ?`).get(seed.alertId2) as { acknowledged: number };
      expect(other.acknowledged).toBe(0);
    });

    it("acks all alerts when alertId is omitted", async () => {
      const result = await dispatch(actions, "alert_ack", undefined, {
        orgId: "org_personal",
      });
      expect(result.text).toContain("2 alerts acknowledged");

      // Verify all personal alerts are acked
      const unacked = db.prepare(`SELECT COUNT(*) as cnt FROM alerts WHERE org_id = 'org_personal' AND acknowledged = 0`).get() as { cnt: number };
      expect(unacked.cnt).toBe(0);
    });

    it("ack all does not affect other orgs", async () => {
      await dispatch(actions, "alert_ack", undefined, {
        orgId: "org_personal",
      });

      // Wyobi alert should still be unacked
      const wyobiUnacked = db.prepare(`SELECT COUNT(*) as cnt FROM alerts WHERE org_id = 'org_wyobi' AND acknowledged = 0`).get() as { cnt: number };
      expect(wyobiUnacked.cnt).toBe(1);
    });

    it("requires orgId", async () => {
      const result = await dispatch(actions, "alert_ack", undefined, {});
      expect(result.text).toContain("Pass orgId");
    });

    it("ack all returns 0 when no unacked alerts exist", async () => {
      // First ack all
      await dispatch(actions, "alert_ack", undefined, { orgId: "org_personal" });

      // Try again
      const result = await dispatch(actions, "alert_ack", undefined, { orgId: "org_personal" });
      expect(result.text).toContain("0 alerts acknowledged");
    });

    it("includeAcked shows acknowledged alerts in list", async () => {
      // Ack one alert
      await dispatch(actions, "alert_ack", undefined, {
        orgId: "org_personal",
        alertId: seed.alertId1,
      });

      // List without includeAcked - should show only 1
      const withoutAcked = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_personal",
      });
      const unackedLines = withoutAcked.text.split("\n").filter(l => l.startsWith("!"));
      expect(unackedLines.length).toBe(1);

      // List with includeAcked - should show both
      const withAcked = await dispatch(actions, "alert_list", undefined, {
        orgId: "org_personal",
        includeAcked: true,
      });
      // Should have both acked and unacked
      expect(withAcked.text).toContain("Session drifted from goal");
      expect(withAcked.text).toContain("Token budget exceeded 90%");
    });
  });
});
