import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock AsyncStorage
const mockStorage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      mockStorage.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      mockStorage.delete(key);
      return Promise.resolve();
    }),
  },
}));

// Mock expo-network
vi.mock("expo-network", () => ({
  getIpAddressAsync: vi.fn(() => Promise.resolve("192.168.1.42")),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// We need AbortController in node env
global.AbortController = AbortController;

import {
  checkHealth,
  toWsUrl,
  buildConfigFromManualUrl,
  discoverServer,
  saveManualServerUrl,
  getManualServerUrl,
  saveApiKey,
  getApiKey,
  clearCachedServer,
  normalizeServerUrl,
} from "../services/discovery";

beforeEach(() => {
  mockStorage.clear();
  mockFetch.mockReset();
  vi.clearAllTimers();
});

describe("toWsUrl", () => {
  it("converts http to ws and appends /ws", () => {
    expect(toWsUrl("http://192.168.1.1:3777", "")).toBe("ws://192.168.1.1:3777/ws");
  });

  it("converts https to wss", () => {
    expect(toWsUrl("https://example.com:3777", "")).toBe("wss://example.com:3777/ws");
  });

  it("appends api key as query param when provided", () => {
    expect(toWsUrl("http://10.0.0.1:3777", "mykey123")).toBe(
      "ws://10.0.0.1:3777/ws?token=mykey123",
    );
  });

  it("does not append token param when key is empty", () => {
    const url = toWsUrl("http://10.0.0.1:3777", "");
    expect(url).not.toContain("token");
  });
});

describe("checkHealth", () => {
  it("returns true when server responds ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await checkHealth("http://localhost:3777", 2000);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3777/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false when server responds non-ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await checkHealth("http://localhost:3777", 2000);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const result = await checkHealth("http://localhost:3777", 2000);
    expect(result).toBe(false);
  });
});

describe("saveManualServerUrl / getManualServerUrl", () => {
  it("stores and retrieves a URL", async () => {
    await saveManualServerUrl("http://100.1.2.3:3777");
    const url = await getManualServerUrl();
    expect(url).toBe("http://100.1.2.3:3777");
  });

  it("strips trailing slashes", async () => {
    await saveManualServerUrl("http://100.1.2.3:3777///");
    const url = await getManualServerUrl();
    expect(url).toBe("http://100.1.2.3:3777");
  });

  it("strips whitespace", async () => {
    await saveManualServerUrl("  http://100.1.2.3:3777  ");
    const url = await getManualServerUrl();
    expect(url).toBe("http://100.1.2.3:3777");
  });

  it("clears URL when set to empty string", async () => {
    await saveManualServerUrl("http://100.1.2.3:3777");
    await saveManualServerUrl("");
    const url = await getManualServerUrl();
    expect(url).toBeNull();
  });

  it("returns null when no URL set", async () => {
    const url = await getManualServerUrl();
    expect(url).toBeNull();
  });

  it("clears cached server config when saving", async () => {
    // Pre-populate cache
    mockStorage.set("nosleep_server_config", JSON.stringify({ apiUrl: "old" }));
    await saveManualServerUrl("http://new:3777");
    expect(mockStorage.has("nosleep_server_config")).toBe(false);
  });
});

describe("saveApiKey / getApiKey", () => {
  it("stores and retrieves a key", async () => {
    await saveApiKey("abc123");
    const key = await getApiKey();
    expect(key).toBe("abc123");
  });

  it("returns empty string when no key set", async () => {
    const key = await getApiKey();
    expect(key).toBe("");
  });

  it("clears cached server config when saving", async () => {
    mockStorage.set("nosleep_server_config", JSON.stringify({ apiUrl: "old" }));
    await saveApiKey("newkey");
    expect(mockStorage.has("nosleep_server_config")).toBe(false);
  });
});

describe("buildConfigFromManualUrl", () => {
  it("builds config with url and stored api key", async () => {
    await saveApiKey("mykey");
    const config = await buildConfigFromManualUrl("http://100.1.2.3:3777");
    expect(config.apiUrl).toBe("http://100.1.2.3:3777");
    expect(config.wsUrl).toBe("ws://100.1.2.3:3777/ws?token=mykey");
    expect(config.apiKey).toBe("mykey");
  });

  it("builds config without token when no api key", async () => {
    const config = await buildConfigFromManualUrl("http://100.1.2.3:3777");
    expect(config.apiUrl).toBe("http://100.1.2.3:3777");
    expect(config.wsUrl).toBe("ws://100.1.2.3:3777/ws");
    expect(config.apiKey).toBe("");
  });

  it("caches the config to AsyncStorage", async () => {
    await buildConfigFromManualUrl("http://100.1.2.3:3777");
    const cached = mockStorage.get("nosleep_server_config");
    expect(cached).toBeTruthy();
    const parsed = JSON.parse(cached!);
    expect(parsed.apiUrl).toBe("http://100.1.2.3:3777");
  });
});

describe("discoverServer", () => {
  it("returns manual URL config immediately without health check when manual URL is set", async () => {
    await saveManualServerUrl("http://100.5.6.7:3777");
    await saveApiKey("key123");

    // fetch should NOT be called — manual URL is trusted
    const config = await discoverServer();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(config).not.toBeNull();
    expect(config!.apiUrl).toBe("http://100.5.6.7:3777");
    expect(config!.wsUrl).toBe("ws://100.5.6.7:3777/ws?token=key123");
    expect(config!.apiKey).toBe("key123");
  });

  it("tries cached config when no manual URL", async () => {
    const cached = {
      apiUrl: "http://192.168.1.10:3777",
      wsUrl: "ws://192.168.1.10:3777/ws",
      apiKey: "",
    };
    mockStorage.set("nosleep_server_config", JSON.stringify(cached));
    mockFetch.mockResolvedValueOnce({ ok: true }); // cache health check

    const config = await discoverServer();
    expect(config).toEqual(cached);
    // First call should be the cached URL health check
    expect(mockFetch.mock.calls[0][0]).toBe("http://192.168.1.10:3777/health");
  });

  it("finds server via the configured EXPO_PUBLIC_NOSLEEP_URL when cache misses", async () => {
    process.env.EXPO_PUBLIC_NOSLEEP_URL = "100.64.0.7";
    try {
      mockFetch.mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("100.64.0.7")) {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false });
      });

      const config = await discoverServer();
      expect(config).not.toBeNull();
      expect(config!.apiUrl).toBe("http://100.64.0.7:3777");
    } finally {
      delete process.env.EXPO_PUBLIC_NOSLEEP_URL;
    }
  });

  it("finds server on local subnet quick probe", async () => {
    // expo-network returns 192.168.1.42, server is at .200
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("192.168.1.200:3777")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false });
    });

    const config = await discoverServer();
    expect(config).not.toBeNull();
    expect(config!.apiUrl).toBe("http://192.168.1.200:3777");
  });

  it("returns null when nothing is found", async () => {
    // All health checks fail
    mockFetch.mockResolvedValue({ ok: false });

    const config = await discoverServer();
    expect(config).toBeNull();
  });
});

describe("normalizeServerUrl", () => {
  it("adds http:// and port to bare IP", () => {
    expect(normalizeServerUrl("100.64.0.7")).toBe("http://100.64.0.7:3777");
  });

  it("adds port to IP with protocol", () => {
    expect(normalizeServerUrl("http://100.64.0.7")).toBe("http://100.64.0.7:3777");
  });

  it("keeps existing port", () => {
    expect(normalizeServerUrl("100.64.0.7:4000")).toBe("http://100.64.0.7:4000");
  });

  it("keeps full URL unchanged", () => {
    expect(normalizeServerUrl("http://100.64.0.7:3777")).toBe("http://100.64.0.7:3777");
  });

  it("strips trailing slashes", () => {
    expect(normalizeServerUrl("http://100.64.0.7:3777///")).toBe("http://100.64.0.7:3777");
  });

  it("strips whitespace", () => {
    expect(normalizeServerUrl("  100.64.0.7  ")).toBe("http://100.64.0.7:3777");
  });

  it("returns empty for empty input", () => {
    expect(normalizeServerUrl("")).toBe("");
    expect(normalizeServerUrl("   ")).toBe("");
  });

  it("handles hostname", () => {
    expect(normalizeServerUrl("myserver.local")).toBe("http://myserver.local:3777");
  });

  it("handles https", () => {
    expect(normalizeServerUrl("https://myserver.com")).toBe("https://myserver.com:3777");
  });

  it("handles explicit non-default port", () => {
    expect(normalizeServerUrl("https://myserver.com:8443")).toBe("https://myserver.com:8443");
  });
});

describe("saveManualServerUrl normalizes input", () => {
  it("stores normalized URL when given bare IP", async () => {
    await saveManualServerUrl("100.64.0.7");
    const url = await getManualServerUrl();
    expect(url).toBe("http://100.64.0.7:3777");
  });

  it("stores normalized URL when given IP with protocol only", async () => {
    await saveManualServerUrl("http://192.168.1.1");
    const url = await getManualServerUrl();
    expect(url).toBe("http://192.168.1.1:3777");
  });
});

describe("clearCachedServer", () => {
  it("removes cached config", async () => {
    mockStorage.set("nosleep_server_config", "something");
    await clearCachedServer();
    expect(mockStorage.has("nosleep_server_config")).toBe(false);
  });
});
