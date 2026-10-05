import { describe, it, expect, vi, beforeEach } from "vitest";

const discoverServer = vi.fn();
vi.mock("../services/discovery", () => ({
  discoverServer: () => discoverServer(),
  clearCachedServer: vi.fn(async () => {}),
  buildConfigFromManualUrl: vi.fn(),
  getManualServerUrl: vi.fn(),
}));

import { getServerConfig, resetServerConfig } from "../config";

describe("getServerConfig — discovery failure handling (H3)", () => {
  beforeEach(async () => {
    discoverServer.mockReset();
    await resetServerConfig();
  });

  it("returns an empty apiUrl on failure (so the UI shows 'not connected', not a fake localhost)", async () => {
    discoverServer.mockResolvedValueOnce(null);
    const cfg = await getServerConfig();
    expect(cfg.apiUrl).toBe("");
  });

  it("does NOT cache a failure — a later call retries discovery and can succeed", async () => {
    discoverServer.mockResolvedValueOnce(null); // first: fail
    const first = await getServerConfig();
    expect(first.apiUrl).toBe("");

    discoverServer.mockResolvedValueOnce({
      apiUrl: "http://10.0.0.5:3777",
      wsUrl: "ws://10.0.0.5:3777/ws",
      apiKey: "k",
    });
    const second = await getServerConfig(); // retries because failure wasn't cached
    expect(second.apiUrl).toBe("http://10.0.0.5:3777");
    expect(discoverServer).toHaveBeenCalledTimes(2);
  });

  it("caches a successful discovery (only runs discovery once)", async () => {
    discoverServer.mockResolvedValue({
      apiUrl: "http://10.0.0.5:3777",
      wsUrl: "ws://10.0.0.5:3777/ws",
      apiKey: "k",
    });
    await getServerConfig();
    await getServerConfig();
    expect(discoverServer).toHaveBeenCalledTimes(1);
  });
});
