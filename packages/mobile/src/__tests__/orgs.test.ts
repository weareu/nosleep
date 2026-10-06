import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  getServerConfig: vi.fn(() =>
    Promise.resolve({ apiUrl: "http://localhost:3777", wsUrl: "ws://localhost:3777/ws", apiKey: "" }),
  ),
}));
vi.mock("../services/clientLog", () => ({ report: vi.fn() }));

import {
  setOrgs,
  getOrgs,
  subscribeOrgs,
  orgColor,
  orgName,
  loadOrgs,
  UNKNOWN_ORG_COLOR,
} from "../services/orgs";
import { listOrgs } from "../services/api";

const WORK = { id: "org_work", name: "Work", slug: "work", color: "#f59e0b" };
const SIDE = { id: "org_side", name: "Side", slug: "side", color: "#10b981" };

describe("org registry", () => {
  beforeEach(() => setOrgs([]));
  afterEach(() => vi.unstubAllGlobals());

  it("resolves name and colour for known orgs", () => {
    setOrgs([WORK, SIDE]);
    expect(orgColor("org_work")).toBe("#f59e0b");
    expect(orgName("org_side")).toBe("Side");
  });

  it("falls back to a neutral colour and the raw id for unknown orgs", () => {
    setOrgs([WORK]);
    expect(orgColor("org_ghost")).toBe(UNKNOWN_ORG_COLOR);
    expect(orgName("org_ghost")).toBe("org_ghost");
    expect(orgColor(undefined)).toBe(UNKNOWN_ORG_COLOR);
    expect(orgName(null)).toBe("");
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const seen: string[][] = [];
    const unsubscribe = subscribeOrgs((orgs) => seen.push(orgs.map((o) => o.id)));
    setOrgs([WORK]);
    setOrgs([WORK, SIDE]);
    unsubscribe();
    setOrgs([]);
    expect(seen).toEqual([["org_work"], ["org_work", "org_side"]]);
  });

  it("loadOrgs publishes the fetched list; a failed fetch keeps the previous one", async () => {
    await loadOrgs(async () => [SIDE]);
    expect(getOrgs().map((o) => o.id)).toEqual(["org_side"]);
    await expect(loadOrgs(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(getOrgs().map((o) => o.id)).toEqual(["org_side"]);
  });

  it("api listOrgs feeds the registry from GET /api/orgs (renames show up)", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: [{ ...WORK, name: "Day Job", activeSessions: 0, projectCount: 0, unackedAlerts: 0, todayTokens: 0 }] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await listOrgs();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/orgs");
    expect(orgName("org_work")).toBe("Day Job");
    expect(orgColor("org_work")).toBe("#f59e0b");
  });
});
